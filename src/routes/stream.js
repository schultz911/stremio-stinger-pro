const { axiosInstance, isCancel, sanitizeError } = require('../utils/network');
const {
    CACHE_TTL_SUCCESS,
    CACHE_TTL_ERROR,
    METADATA_TTL,
    CINEMETA_TIMEOUT,
    SCRAPER_TIMEOUT,
    DEFAULT_TMDB_KEY,
} = require('../config');
const { streamCache, cinemetaCache, rawScraperCache } = require('../cache/memory');
const redisCache = require('../cache/redis');
const scrapers = require('../scrapers');
const { formatMessage, formatRelatedMessage } = require('../utils/formatter');
const { log, warn, error } = require('../utils/logger');

const { LRUCache } = require('lru-cache');

const activeRequests = new LRUCache({
    max: 1000,
    ttl: 30000, // Safety net TTL for requests hanging
});

const previewSearchCache = new LRUCache({
    max: 2000,
    ttl: 24 * 60 * 60 * 1000, // 24 hours
});
const setCacheError = (cacheKey) => {
    streamCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_ERROR, stream: null });
    if (redisCache.isRedisEnabled()) {
        redisCache
            .setCache(cacheKey, { isCachedWrapper: true, stream: null }, Math.floor(CACHE_TTL_ERROR / 1000))
            .catch((err) => error(`Redis Cache Error: ${err.message}`));
    }
};

const parseRequestConfig = (req) => {
    let rawStyle = req.params.style || req.params.p1 || 'colorful';
    let apiKey =
        req.params.apiKey ||
        (req.params.p1 &&
        !req.params.p1.includes('simple') &&
        !req.params.p1.includes('colorful') &&
        !req.params.p1.includes('monochrome')
            ? req.params.p1
            : null);

    if (rawStyle.length > 50) rawStyle = 'colorful';
    if (apiKey && (apiKey.length > 100 || !/^[a-f0-9]{32}$/i.test(apiKey))) apiKey = null;

    const styleConfig = {
        style: rawStyle.replace(/-nosource|-bloopers|-sequel|-related/g, ''),
        showSource: !rawStyle.includes('-nosource'),
        showBloopers: rawStyle.includes('-bloopers'),
        showSequel: rawStyle.includes('-sequel'),
        showRelated: rawStyle.includes('-related'),
    };

    return { rawStyle, apiKey, styleConfig };
};

const getCachedStream = async (cacheKey) => {
    // Check Memory Cache
    const memCached = streamCache.get(cacheKey);
    if (memCached && Date.now() < memCached.expiresAt) {
        log(`[Stream] Cache HIT (Memory). Resolving from memory.`);
        return { hit: true, stream: memCached.stream };
    } else if (memCached) {
        streamCache.delete(cacheKey);
    }

    // Check Redis Cache
    if (redisCache.isRedisEnabled()) {
        const redisData = await redisCache.getCache(cacheKey);
        if (redisData !== null) {
            log(`[Stream] Cache HIT (Redis). Resolving from Redis.`);

            let stream = redisData;
            if (redisData.isCachedWrapper) {
                stream = redisData.stream;
            }

            const ttl = stream === null ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS;
            streamCache.set(cacheKey, { expiresAt: Date.now() + ttl, stream });

            return { hit: true, stream };
        }
    }

    return { hit: false };
};

const fetchCinemetaNetwork = async (id, signal) => {
    const config = { timeout: CINEMETA_TIMEOUT, signal };
    try {
        const metaRes = await axiosInstance.get(`https://v3-cinemeta.strem.io/meta/movie/${id}.json`, config);
        const title = metaRes.data?.meta?.name;
        const year = metaRes.data?.meta?.year;
        const moviedbId = metaRes.data?.meta?.moviedb_id;

        if (title) {
            return { title, year, moviedbId };
        }
    } catch (e) {
        if (!isCancel(e)) {
            error(`[Stream Error] Cinemeta Lookup Failed: ${sanitizeError(e.message)}`);
        }
    }
    return null;
};

const fetchTmdbMetadataNetwork = async (imdbId, apiKey, signal) => {
    const config = { timeout: CINEMETA_TIMEOUT, signal };
    try {
        log(`[Stream] Attempting TMDB metadata fallback for ID: ${imdbId}`);
        const findRes = await axiosInstance.get(
            `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?external_source=imdb_id&api_key=${encodeURIComponent(apiKey)}`,
            config
        );
        const movieMatch = findRes.data.movie_results?.[0];
        if (movieMatch) {
            const title = movieMatch.title || movieMatch.original_title;
            const year = movieMatch.release_date ? new Date(movieMatch.release_date).getFullYear() : null;
            const moviedbId = Number(movieMatch.id);
            return { title, year, moviedbId };
        }
    } catch (e) {
        if (!isCancel(e)) {
            error(`[Stream Error] TMDB Metadata Fallback Failed: ${sanitizeError(e.message)}`);
        }
    }
    return null;
};

const raceMetadataSources = (id, apiKey) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CINEMETA_TIMEOUT);

    const pCinemeta = fetchCinemetaNetwork(id, controller.signal);
    const pTmdb = fetchTmdbMetadataNetwork(id, apiKey, controller.signal);

    return new Promise((resolve) => {
        let completed = 0;
        let resolved = false;

        const handleResult = (val) => {
            if (resolved) return;
            if (val && val.title) {
                resolved = true;
                clearTimeout(timeoutId);
                controller.abort(); // Cancel the other request
                resolve(val);
            } else {
                completed++;
                if (completed === 2) {
                    clearTimeout(timeoutId);
                    controller.abort();
                    resolve(null);
                }
            }
        };

        pCinemeta.then(handleResult).catch(() => handleResult(null));
        pTmdb.then(handleResult).catch(() => handleResult(null));
    });
};

const fetchMetadata = async (id, apiKey) => {
    const cachedCinemeta = cinemetaCache.get(id);
    if (cachedCinemeta && Date.now() < cachedCinemeta.expiresAt) {
        log(`[Stream] Cinemeta Cache HIT (Memory) for ID: ${id}`);
        return { title: cachedCinemeta.title, year: cachedCinemeta.year, moviedbId: cachedCinemeta.moviedbId };
    }

    if (redisCache.isRedisEnabled()) {
        const redisCinemeta = await redisCache.getCache(`cinemeta_${id}`);
        if (redisCinemeta !== null) {
            log(`[Stream] Cinemeta Cache HIT (Redis) for ID: ${id}`);
            const ttl = redisCinemeta.title ? METADATA_TTL : CACHE_TTL_ERROR;
            cinemetaCache.set(id, {
                title: redisCinemeta.title,
                year: redisCinemeta.year,
                moviedbId: redisCinemeta.moviedbId,
                expiresAt: Date.now() + ttl,
            });
            return { title: redisCinemeta.title, year: redisCinemeta.year, moviedbId: redisCinemeta.moviedbId };
        }
    }

    const key = apiKey || DEFAULT_TMDB_KEY;
    let result;

    if (key) {
        log(`[Stream] Cache MISS. Racing Cinemeta and TMDB fallback for ID: ${id}`);
        result = await raceMetadataSources(id, key);
    } else {
        log(`[Stream] Cache MISS. Fetching Cinemeta for ID: ${id}`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CINEMETA_TIMEOUT);
        result = await fetchCinemetaNetwork(id, controller.signal);
        clearTimeout(timeoutId);
    }

    const hasTitle = !!(result && result.title);
    const ttl = hasTitle ? METADATA_TTL : CACHE_TTL_ERROR;
    const cacheVal = hasTitle
        ? { title: result.title, year: result.year, moviedbId: result.moviedbId }
        : { title: null, year: null, moviedbId: null };

    cinemetaCache.set(id, {
        title: cacheVal.title,
        year: cacheVal.year,
        moviedbId: cacheVal.moviedbId,
        expiresAt: Date.now() + ttl,
    });

    if (redisCache.isRedisEnabled()) {
        redisCache
            .setCache(`cinemeta_${id}`, cacheVal, Math.floor(ttl / 1000))
            .catch((err) => error(`Redis Cache Error: ${err.message}`));
    }

    return cacheVal;
};

const processScrapingSequence = async (id, apiKey, cacheKey, styleConfig) => {
    let finalResult;
    let bestFallback;
    let relatedData;
    let title;
    let year;
    let moviedbId;

    const cachedScraperData = rawScraperCache.get(id);
    if (cachedScraperData && Date.now() < cachedScraperData.expiresAt) {
        log(`[Stream] Raw Scraper Cache HIT (Memory). Bypassing duplicate network requests.`);
        finalResult = cachedScraperData.finalResult;
        bestFallback = cachedScraperData.bestFallback;
        title = cachedScraperData.title;
        year = cachedScraperData.year;
        relatedData = cachedScraperData.relatedData;
        moviedbId = cachedScraperData.moviedbId;
    } else {
        if (redisCache.isRedisEnabled()) {
            const redisScraperData = await redisCache.getCache(`rawScraper_${id}`);
            if (redisScraperData !== null) {
                log(`[Stream] Raw Scraper Cache HIT (Redis). Bypassing duplicate network requests.`);
                finalResult = redisScraperData.finalResult;
                bestFallback = redisScraperData.bestFallback;
                relatedData = redisScraperData.relatedData;
                title = redisScraperData.title;
                year = redisScraperData.year;
                moviedbId = redisScraperData.moviedbId;

                rawScraperCache.set(id, {
                    finalResult,
                    bestFallback,
                    relatedData,
                    title,
                    year,
                    moviedbId,
                    expiresAt: Date.now() + METADATA_TTL,
                });
            }
        }
    }

    if (!title) {
        const metaData = await fetchMetadata(id, apiKey);
        title = metaData.title;
        year = metaData.year;
        moviedbId = metaData.moviedbId;

        if (!title) {
            log(`[Stream] Cinemeta & TMDB fallback lookup failed or timed out. Returning empty streams.`);
            log(`=================================\n`);
            setCacheError(cacheKey);
            return null;
        }

        log(`[Stream] Target: "${title}" (${year})`);

        // Trigger related data fetch concurrently if enabled
        let pRelated = Promise.resolve(undefined);
        if (moviedbId && styleConfig.showRelated) {
            const relatedController = new AbortController();
            const relatedTimeoutId = setTimeout(() => relatedController.abort(), SCRAPER_TIMEOUT);
            pRelated = scrapers
                .getRelatedMovies(moviedbId, apiKey, { timeout: SCRAPER_TIMEOUT, signal: relatedController.signal }, id)
                .finally(() => clearTimeout(relatedTimeoutId));
        }

        // Fire all scrapers concurrently
        log(`[Stream] Firing all scrapers (AfterCredits, TMDB, Wikipedia) concurrently...`);
        const pAc = scrapers.checkAfterCredits(title, year, { timeout: SCRAPER_TIMEOUT }).catch(() => null);
        const pTmdb = scrapers.checkTmdb(id, moviedbId, apiKey, { timeout: SCRAPER_TIMEOUT }).catch(() => null);
        const pWiki = scrapers.checkWikipedia(title).catch(() => null);

        // Fast-path racing logic
        let resolvedFastPath = false;
        let fastPathResolve;
        const fastPathPromise = new Promise((resolve) => {
            fastPathResolve = resolve;
        });

        const handleScraperResolution = (res, sourceName) => {
            if (res && res.definitive) {
                if (!resolvedFastPath) {
                    resolvedFastPath = true;
                    fastPathResolve({ result: res, source: sourceName });
                }
            }
        };

        pAc.then((res) => handleScraperResolution(res, 'AfterCredits'));
        pTmdb.then((res) => handleScraperResolution(res, 'TMDB'));
        pWiki.then((res) => handleScraperResolution(res, 'Wikipedia'));

        // Handle fallback case if no scraper returns a definitive result
        Promise.all([pAc, pTmdb, pWiki]).then((allResults) => {
            if (!resolvedFastPath) {
                resolvedFastPath = true;
                const best = allResults.find((r) => r && !r.no) || allResults.find((r) => r) || null;
                fastPathResolve({ result: best, source: 'Aggregated' });
            }
        });

        const fastResultObj = await fastPathPromise;
        const fastResult = fastResultObj.result || {
            mid: false,
            post: false,
            no: false,
            bloopers: false,
            sequel: false,
            audioOnly: false,
            url: `https://aftercredits.com/?s=${encodeURIComponent(year ? `${title} ${year}` : title).replace(/%20/g, '+')}`,
            source: 'Aggregated',
        };

        log(`[Stream] Fast-path Resolution -> Source: ${fastResultObj.source || 'Aggregated'}`);

        // Await related data (if triggered)
        relatedData = await pRelated.catch(() => null);

        // Save initial fast path result to cache immediately to keep request latency low
        rawScraperCache.set(id, {
            finalResult: fastResult,
            bestFallback: null,
            relatedData,
            title,
            year,
            moviedbId,
            expiresAt: Date.now() + METADATA_TTL,
        });

        // Launch background merging and cache enrichment worker (non-blocking)
        Promise.all([pAc, pTmdb, pWiki])
            .then(async (allResults) => {
                log(`[Stream Background] All scrapers completed. Processing merged results for ID: ${id}...`);
                const merged = {
                    mid: false,
                    post: false,
                    bloopers: false,
                    sequel: false,
                    audioOnly: false,
                    no: false,
                    definitive: false,
                    url: '',
                    sources: [],
                };

                for (const r of allResults) {
                    if (!r) continue;
                    if (r.mid) merged.mid = true;
                    if (r.post) merged.post = true;
                    if (r.bloopers) merged.bloopers = true;
                    if (r.sequel) merged.sequel = true;
                    if (r.audioOnly) merged.audioOnly = true;
                    if (r.definitive) merged.definitive = true;
                    if (r.url && !merged.url) merged.url = r.url;
                    if (r.source && !merged.sources.includes(r.source)) {
                        merged.sources.push(r.source);
                    }
                }

                merged.no = !merged.mid && !merged.post && !merged.bloopers;
                merged.source = merged.sources.length > 0 ? merged.sources.join(' & ') : 'Aggregated';
                delete merged.sources;

                if (!merged.url) {
                    merged.url = `https://aftercredits.com/?s=${encodeURIComponent(year ? `${title} ${year}` : title).replace(/%20/g, '+')}`;
                }

                log(
                    `[Stream Background] Merged Result -> Mid: ${merged.mid}, Post: ${merged.post}, Bloopers: ${merged.bloopers}, AudioOnly: ${merged.audioOnly}, Source: ${merged.source}`
                );

                // Overwrite caches with fully merged results
                const finalScraperData = {
                    finalResult: merged,
                    bestFallback: null,
                    relatedData,
                    title,
                    year,
                    moviedbId,
                    expiresAt: Date.now() + METADATA_TTL,
                };
                rawScraperCache.set(id, finalScraperData);

                if (redisCache.isRedisEnabled()) {
                    await redisCache
                        .setCache(
                            `rawScraper_${id}`,
                            {
                                finalResult: merged,
                                bestFallback: null,
                                relatedData,
                                title,
                                year,
                                moviedbId,
                            },
                            Math.floor(METADATA_TTL / 1000)
                        )
                        .catch((e) => error(`Redis Cache Error: ${e.message}`));
                }

                // Enrich style-specific cache
                const enrichedStream = {
                    name: 'After-Credits Scenes',
                    title: formatMessage(styleConfig, merged),
                    url: merged.url,
                };
                let enrichedStreams = [enrichedStream];
                if (styleConfig.showRelated && relatedData) {
                    enrichedStreams.push({
                        name: relatedData.collectionName
                            ? `Part of ${relatedData.collectionName}`
                            : 'Not Part of a Collection',
                        title: formatRelatedMessage(styleConfig, relatedData),
                        url: relatedData.collectionUrl,
                    });
                }
                streamCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_SUCCESS, stream: enrichedStreams });
                if (redisCache.isRedisEnabled()) {
                    await redisCache
                        .setCache(
                            cacheKey,
                            { isCachedWrapper: true, stream: enrichedStreams },
                            Math.floor(CACHE_TTL_SUCCESS / 1000)
                        )
                        .catch(() => {});
                }
                log(`[Stream Background] Cache enriched for key: ${cacheKey}`);
            })
            .catch((e) => {
                error(`[Stream Background Error] Failed to enrich cache: ${e.message}`);
            });

        // Set local finalResult to fastResult to return to client immediately
        finalResult = fastResult;
    }

    if (styleConfig.showRelated && relatedData === undefined) {
        log(`[Stream] Cache hit but relatedData is undefined. Fetching related data on-demand.`);
        let moviedbIdForRelated = moviedbId;
        if (!moviedbIdForRelated) {
            const metaData = await fetchMetadata(id, apiKey);
            moviedbIdForRelated = metaData?.moviedbId;
        }
        if (moviedbIdForRelated) {
            const scraperController = new AbortController();
            const scraperTimeoutId = setTimeout(() => scraperController.abort(), SCRAPER_TIMEOUT);
            try {
                relatedData = await scrapers.getRelatedMovies(
                    moviedbIdForRelated,
                    apiKey,
                    { timeout: SCRAPER_TIMEOUT, signal: scraperController.signal },
                    id
                );
                rawScraperCache.set(id, {
                    finalResult,
                    bestFallback,
                    relatedData,
                    title,
                    year,
                    moviedbId: moviedbIdForRelated,
                    expiresAt: Date.now() + METADATA_TTL,
                });
                if (redisCache.isRedisEnabled()) {
                    redisCache
                        .setCache(
                            `rawScraper_${id}`,
                            { finalResult, bestFallback, relatedData, title, year, moviedbId: moviedbIdForRelated },
                            Math.floor(METADATA_TTL / 1000)
                        )
                        .catch((err) => error(`Redis Cache Error: ${err.message}`));
                }
            } catch {
                relatedData = null;
            } finally {
                clearTimeout(scraperTimeoutId);
                scraperController.abort();
            }
        } else {
            relatedData = null;
        }
    }

    const resolvedResult = finalResult ||
        bestFallback || {
            mid: false,
            post: false,
            no: false,
            bloopers: false,
            sequel: false,
            audioOnly: false,
            url: `https://aftercredits.com/?s=${encodeURIComponent(year ? `${title} ${year}` : title).replace(/%20/g, '+')}`,
            source: 'Aggregated',
        };

    log(`[Stream] Final Resolution -> Source Used: ${resolvedResult.source}`);

    const streamObj = {
        name: 'After-Credits Scenes',
        title: formatMessage(styleConfig, resolvedResult),
        url:
            resolvedResult.url ||
            `https://aftercredits.com/?s=${encodeURIComponent(year ? `${title} ${year}` : title).replace(/%20/g, '+')}`,
    };

    let streamsToReturn = [streamObj];

    if (styleConfig.showRelated && relatedData) {
        streamsToReturn.push({
            name: relatedData.collectionName ? `Part of ${relatedData.collectionName}` : 'Not Part of a Collection',
            title: formatRelatedMessage(styleConfig, relatedData),
            url: relatedData.collectionUrl,
        });
    }

    const cacheDuration = CACHE_TTL_SUCCESS;
    streamCache.set(cacheKey, { expiresAt: Date.now() + cacheDuration, stream: streamsToReturn });
    if (redisCache.isRedisEnabled()) {
        redisCache
            .setCache(
                cacheKey,
                { isCachedWrapper: true, stream: streamsToReturn },
                Math.floor(CACHE_TTL_SUCCESS / 1000)
            )
            .catch((err) => error(`Redis Cache Error: ${err.message}`));
    }

    log(`[Stream] Payload generated and cached. Sequence complete.`);
    log(`=================================\n`);
    return streamsToReturn;
};

const sendJson = (res, streams, isError) => {
    if (isError) {
        res.setHeader('Cache-Control', 'public, max-age=60');
    } else {
        res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=3600');
    }
    res.json({ streams: streams || [] });
};

const streamHandler = async (req, res) => {
    const { type, id } = req.params;
    if (type !== 'movie') {
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.json({ streams: [] });
    }
    if (!id || !/^tt\d+$/.test(id)) {
        warn(`[Stream] Invalid ID format: ${sanitizeError(id)}`);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.json({ streams: [] });
    }

    log(`
========== NEW REQUEST ==========`);
    log(`[Stream] Request Type: ${type} | ID: ${id}`);

    const { rawStyle, apiKey, styleConfig } = parseRequestConfig(req);
    const cacheKey = `${id}_${rawStyle}`;

    const cachedResult = await getCachedStream(cacheKey);
    if (cachedResult.hit) {
        const isError = !cachedResult.stream;
        const streams = cachedResult.stream
            ? Array.isArray(cachedResult.stream)
                ? cachedResult.stream
                : [cachedResult.stream]
            : [];
        sendJson(res, streams, isError);
        return;
    }

    if (activeRequests.has(cacheKey)) {
        log(`[Stream] Cache MISS. Concurrent request detected for key: ${cacheKey}. Coalescing...`);
        const p = activeRequests.get(cacheKey);
        try {
            const stream = await p;
            const isError = !stream;
            const streams = stream ? (Array.isArray(stream) ? stream : [stream]) : [];
            sendJson(res, streams, isError);
            return;
        } catch {
            sendJson(res, [], true);
            return;
        }
    }

    const scrapePromise = processScrapingSequence(id, apiKey, cacheKey, styleConfig);
    activeRequests.set(cacheKey, scrapePromise);

    try {
        const stream = await scrapePromise;
        const isError = !stream;
        const streams = stream ? (Array.isArray(stream) ? stream : [stream]) : [];
        sendJson(res, streams, isError);
    } catch {
        sendJson(res, [], true);
    } finally {
        if (activeRequests.get(cacheKey) === scrapePromise) {
            activeRequests.delete(cacheKey);
        }
    }
};

const searchMovieIdByName = async (query, apiKey) => {
    const key = apiKey || DEFAULT_TMDB_KEY;
    const cacheKey = `${query}_${key}`;

    if (previewSearchCache.has(cacheKey)) {
        log(`[Preview Search] Cache HIT for: "${query}"`);
        return previewSearchCache.get(cacheKey);
    }

    const config = { timeout: CINEMETA_TIMEOUT };

    if (key) {
        try {
            log(`[Preview Search] Searching TMDB for: "${query}"`);
            const searchRes = await axiosInstance.get(
                `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(query)}&api_key=${encodeURIComponent(key)}`,
                config
            );
            const tmdbMovie = searchRes.data?.results?.[0];
            if (tmdbMovie && tmdbMovie.id) {
                const tmdbId = tmdbMovie.id;
                log(
                    `[Preview Search] Found TMDB Movie: "${tmdbMovie.title}" (ID: ${tmdbId}). Fetching external IDs...`
                );
                const extRes = await axiosInstance.get(
                    `https://api.themoviedb.org/3/movie/${encodeURIComponent(tmdbId)}/external_ids?api_key=${encodeURIComponent(key)}`,
                    config
                );
                const imdbId = extRes.data?.imdb_id;
                if (imdbId && /^tt\d+$/.test(imdbId)) {
                    log(`[Preview Search] Resolved IMDb ID from TMDB: ${imdbId}`);
                    previewSearchCache.set(cacheKey, imdbId);
                    return imdbId;
                }
            }
        } catch (e) {
            error(`[Preview Search Error] TMDB search failed: ${sanitizeError(e.message)}`);
        }
    }

    // Fallback to Cinemeta Search
    try {
        log(`[Preview Search] Falling back/searching Cinemeta for: "${query}"`);
        const cinemetaSearchUrl = `https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(query)}.json`;
        const searchRes = await axiosInstance.get(cinemetaSearchUrl, config);
        const metas = searchRes.data?.metas || [];
        const match = metas.find((m) => m.id && /^tt\d+$/.test(m.id));
        if (match) {
            log(`[Preview Search] Found Cinemeta Movie: "${match.name}" (IMDb: ${match.id})`);
            previewSearchCache.set(cacheKey, match.id);
            return match.id;
        }
    } catch (e) {
        error(`[Preview Search Error] Cinemeta search failed: ${sanitizeError(e.message)}`);
    }

    previewSearchCache.set(cacheKey, null, { ttl: 60 * 60 * 1000 }); // Cache misses for 1 hour
    return null;
};

const previewHandler = async (req, res) => {
    const { id } = req.params;
    if (!id || typeof id !== 'string' || id.length > 200) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.status(400).json({ error: 'Movie name or IMDb ID is required.' });
    }

    try {
        log(`[Preview] Request for query/ID: ${id}`);
        const apiKey = req.query.apiKey || null;

        const styleConfig = {
            style: 'colorful',
            showSource: true,
            showBloopers: true,
            showSequel: true,
            showRelated: true,
        };

        let imdbId;
        const previewReqKey = `preview_req_${id}_${apiKey || 'none'}`;

        if (activeRequests.has(previewReqKey)) {
            log(`[Preview] Concurrent request detected for ID: ${id}. Coalescing...`);
            imdbId = await activeRequests.get(previewReqKey);
        } else {
            const previewPromise = (async () => {
                let resolvedId = id;
                if (!/^tt\d+$/.test(resolvedId)) {
                    // Not a valid IMDb ID format, search by name
                    resolvedId = await searchMovieIdByName(id, apiKey);
                    if (!resolvedId) return null;
                }
                const dummyCacheKey = `${resolvedId}_preview_colorful`;
                await processScrapingSequence(resolvedId, apiKey, dummyCacheKey, styleConfig);
                return resolvedId;
            })();

            activeRequests.set(previewReqKey, previewPromise);
            try {
                imdbId = await previewPromise;
            } finally {
                if (activeRequests.get(previewReqKey) === previewPromise) {
                    activeRequests.delete(previewReqKey);
                }
            }
        }

        if (!imdbId) {
            res.setHeader('Cache-Control', 'public, max-age=60');
            return res.status(404).json({ error: `Movie "${id}" not found.` });
        }

        const cached = rawScraperCache.get(imdbId);
        if (cached) {
            return res.json({
                title: cached.title,
                year: cached.year,
                mid: cached.finalResult?.mid || false,
                post: cached.finalResult?.post || false,
                bloopers: cached.finalResult?.bloopers || false,
                sequel: cached.finalResult?.sequel || false,
                audioOnly: cached.finalResult?.audioOnly || false,
                source: cached.finalResult?.source || 'Aggregated',
                url: cached.finalResult?.url || '',
                relatedData: cached.relatedData || null,
            });
        }
        return res.status(404).json({ error: 'Failed to retrieve stinger data.' });
    } catch (e) {
        error(`[Preview Error] Failed for ID/Query ${id}: ${sanitizeError(e.message)}`);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};

module.exports = { streamHandler, previewHandler };
