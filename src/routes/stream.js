const axios = require('axios');
const {
    CACHE_TTL_SUCCESS,
    CACHE_TTL_ERROR,
    axiosConfig,
    CINEMETA_TIMEOUT,
    SCRAPER_TIMEOUT,
    ENABLE_LOGGING,
} = require('../config');
const { streamCache } = require('../cache/memory');
const redisCache = require('../cache/redis');
const { sanitizeError } = require('../utils/network');
const scrapers = require('../scrapers');
const { formatMessage } = require('../utils/formatter');

const log = (...args) => {
    if (ENABLE_LOGGING) {
        console.log(...args);
    }
};

// Lightweight Telemetry
const telemetry = {
    cacheHits: 0,
    cacheMisses: 0,
    requestedIds: new Map(),
    getStats: () => ({
        cacheHits: telemetry.cacheHits,
        cacheMisses: telemetry.cacheMisses,
        topIds: [...telemetry.requestedIds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
    }),
};

const activeRequests = new Map();

const streamHandler = async (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=3600');

    const { type, id } = req.params;
    if (type !== 'movie') return res.json({ streams: [] });
    if (!id || !/^tt\d+$/.test(id)) {
        console.warn(`[Stream] Invalid ID format: ${sanitizeError(id)}`);
        return res.json({ streams: [] });
    }

    log(`\n========== NEW REQUEST ==========`);
    log(`[Stream] Request Type: ${type} | ID: ${id}`);

    // Telemetry tracking
    const count = telemetry.requestedIds.get(id) || 0;
    if (count > 0) telemetry.requestedIds.delete(id);
    telemetry.requestedIds.set(id, count + 1);
    if (telemetry.requestedIds.size > 1000) telemetry.requestedIds.delete(telemetry.requestedIds.keys().next().value);

    let rawStyle = req.params.style || req.params.p1 || 'colorful';
    let apiKey =
        req.params.apiKey ||
        (req.params.p1 && !req.params.p1.includes('simple') && !req.params.p1.includes('colorful')
            ? req.params.p1
            : null);

    if (rawStyle.length > 50) rawStyle = 'colorful';
    if (apiKey && apiKey.length > 100) apiKey = null;

    const styleConfig = {
        style: rawStyle.replace(/-nosource|-bloopers|-sequel/g, ''),
        showSource: !rawStyle.includes('-nosource'),
        showBloopers: rawStyle.includes('-bloopers'),
        showSequel: rawStyle.includes('-sequel'),
    };

    const cacheKey = `${id}_${rawStyle}`;

    // Check Memory Cache
    const memCached = streamCache.get(cacheKey);
    if (memCached && Date.now() < memCached.expiresAt) {
        log(`[Stream] Cache HIT (Memory). Resolving from memory.`);
        telemetry.cacheHits++;
        return res.json({ streams: [memCached.stream] });
    } else if (memCached) {
        streamCache.delete(cacheKey);
    }

    // Check Redis Cache
    if (redisCache.isRedisEnabled()) {
        const redisData = await redisCache.getCache(cacheKey);
        if (redisData) {
            log(`[Stream] Cache HIT (Redis). Resolving from Redis.`);
            telemetry.cacheHits++;
            streamCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_SUCCESS, stream: redisData }); // Warm memory cache
            return res.json({ streams: [redisData] });
        }
    }

    telemetry.cacheMisses++;

    if (activeRequests.has(cacheKey)) {
        log(`[Stream] Cache MISS. Concurrent request detected for key: ${cacheKey}. Coalescing...`);
        try {
            const stream = await activeRequests.get(cacheKey);
            return res.json({ streams: stream ? [stream] : [] });
        } catch {
            return res.json({ streams: [] });
        }
    }

    const scrapePromise = (async () => {
        const cinemetaController = new AbortController();
        const cinemetaTimeoutId = setTimeout(() => cinemetaController.abort(), CINEMETA_TIMEOUT);
        const cinemetaConfig = { ...axiosConfig, timeout: CINEMETA_TIMEOUT, signal: cinemetaController.signal };

        let title, year, moviedbId;

        try {
            const metaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/movie/${id}.json`, cinemetaConfig);
            title = metaRes.data?.meta?.name;
            year = metaRes.data?.meta?.year;
            moviedbId = metaRes.data?.meta?.moviedb_id;
        } catch (e) {
            if (e.name !== 'CanceledError' && e.message !== 'canceled') {
                console.error(`[Stream Error] Cinemeta Lookup Failed: ${sanitizeError(e.message)}`);
            }
        } finally {
            clearTimeout(cinemetaTimeoutId);
            cinemetaController.abort();
        }

        if (!title) {
            log(`[Stream] Cinemeta lookup failed or timed out. Returning empty streams.`);
            log(`=================================\n`);
            return null;
        }

        log(`[Stream] Target: "${title}" (${year})`);

        const scraperController = new AbortController();
        const scraperTimeoutId = setTimeout(() => scraperController.abort(), SCRAPER_TIMEOUT);
        const scraperConfig = { ...axiosConfig, timeout: SCRAPER_TIMEOUT, signal: scraperController.signal };

        try {
            let finalResult = null;
            let bestFallback = null;

            const updateFallback = (resObj) => {
                if (!resObj) return;
                if (resObj.no && (!bestFallback || !bestFallback.no)) {
                    bestFallback = resObj;
                } else if (!bestFallback) {
                    bestFallback = resObj;
                }
            };

            log(`[Stream] Firing all scrapers concurrently for minimal latency...`);
            const pAc = scrapers.checkAfterCredits(title, year, scraperConfig);
            const pMs = scrapers.checkMediaStinger(title, year, scraperConfig);
            const pTmdb = scrapers.checkTmdb(id, moviedbId, apiKey, scraperConfig);
            const pWiki = scrapers.checkWikipedia(title, scraperConfig);

            const scraperTasks = [
                { name: 'AfterCredits', promise: pAc },
                { name: 'MediaStinger', promise: pMs },
                { name: 'TMDB', promise: pTmdb },
                { name: 'Wikipedia', promise: pWiki },
            ];

            for (const scraper of scraperTasks) {
                const result = await scraper.promise;
                if (result && result.definitive) {
                    finalResult = result;
                    log(
                        `[Stream] Definitive state found by ${scraper.name}.${scraper.name !== 'Wikipedia' ? ' Aborting others...' : ''}`
                    );
                    if (scraper.name !== 'Wikipedia') scraperController.abort();
                    break;
                } else {
                    updateFallback(result);
                }
            }

            const isAggregatedError = !finalResult && !bestFallback;
            const resolvedResult = finalResult ||
                bestFallback || {
                    mid: false,
                    post: false,
                    no: false,
                    bloopers: false,
                    sequel: false,
                    url: `https://aftercredits.com/?s=${encodeURIComponent(year ? `${title} ${year}` : title).replace(/%20/g, '+')}`,
                    source: 'Aggregated',
                };

            log(`[Stream] Final Resolution -> Source Used: ${resolvedResult.source}`);

            const stream = {
                name: 'After-Credits Scenes',
                title: `${formatMessage(styleConfig, resolvedResult)}${styleConfig.showSource ? `\nSource: ${resolvedResult.source}` : ''}`,
                url:
                    resolvedResult.url ||
                    `https://aftercredits.com/?s=${encodeURIComponent(year ? `${title} ${year}` : title).replace(/%20/g, '+')}`,
            };

            const cacheDuration = isAggregatedError ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS;
            streamCache.set(cacheKey, { expiresAt: Date.now() + cacheDuration, stream });
            if (redisCache.isRedisEnabled() && !isAggregatedError) {
                redisCache.setCache(cacheKey, stream, Math.floor(CACHE_TTL_SUCCESS / 1000));
            }

            log(`[Stream] Payload generated and cached. Sequence complete.`);
            log(`=================================\n`);
            return stream;
        } catch (e) {
            if (e.name !== 'CanceledError' && e.message !== 'canceled') {
                console.error(`[Stream Error] Scrapers block failed: ${sanitizeError(e.message)}`);
            }
            return null;
        } finally {
            clearTimeout(scraperTimeoutId);
            scraperController.abort();
        }
    })();

    activeRequests.set(cacheKey, scrapePromise);

    try {
        const stream = await scrapePromise;
        return res.json({ streams: stream ? [stream] : [] });
    } catch {
        return res.json({ streams: [] });
    } finally {
        activeRequests.delete(cacheKey);
    }
};

module.exports = { streamHandler, telemetry };
