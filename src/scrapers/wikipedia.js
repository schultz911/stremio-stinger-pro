const { axiosInstance, isCancel } = require('../utils/network');
const cheerio = require('cheerio');
const { WIKI_TTL, CACHE_TTL_ERROR } = require('../config');
const { wikiNormalize, BLOOPER_REGEX, AUDIO_ONLY_REGEX } = require('../utils/strings');
const { sanitizeError } = require('../utils/network');

const WIKI_MID_REGEX =
    /mid-|during|throughout|overlay|alongside|while the credits|accompany.*credits|as.*credits roll|before.*credits roll|during.*titles|throughout.*titles|credits crawl|credits scroll/;
const WIKI_POST_REGEX =
    /post-|after|following|follows|at the end|very end|once the credits|final scene|last scene|after the final|after the end titles|ends with|concludes with/;
const redisCache = require('../cache/redis');
const { log, error } = require('../utils/logger');
const { getResultObj } = require('../utils/formatter');

let wikiCache = new Map();
let wikiLastFetched = 0;
let wikiNextRetryAt = 0;
const WIKI_PAGE = 'List_of_films_with_post-credits_scenes';

async function loadWikiCacheFromRedis() {
    if (!redisCache.isRedisEnabled()) return false;

    const cachedData = await redisCache.getCache('wiki_index_cache');
    const entries =
        cachedData && typeof cachedData === 'object' && !Array.isArray(cachedData) ? Object.entries(cachedData) : [];
    if (
        entries.length > 0 &&
        entries.every(
            ([title, value]) =>
                title &&
                value &&
                ['mid', 'post', 'bloopers'].every((flag) => typeof value[flag] === 'boolean') &&
                (value.audioOnly === undefined || typeof value.audioOnly === 'boolean')
        )
    ) {
        wikiCache = new Map(entries);
        wikiLastFetched = Date.now();
        log(`[Wiki] Loaded ${wikiCache.size} entries from Redis cache.`);
        return true;
    }
    return false;
}

let wikiFetchPromise = null;

async function buildWikiIndex(options = {}) {
    if (Date.now() - wikiLastFetched < WIKI_TTL && wikiCache.size > 0) return;
    if (Date.now() < wikiNextRetryAt) return;
    if (wikiFetchPromise) return wikiFetchPromise;

    wikiFetchPromise = (async () => {
        const controller = new AbortController();
        let timeoutId;
        try {
            log(`[Wiki] Building index...`);

            if (await loadWikiCacheFromRedis()) {
                return;
            }

            // axiosInstance already carries the base headers and agents from axiosConfig.
            // Only pass per-request overrides: timeout, any extra headers from caller, and signal.
            const timeoutMs = options.timeout || 20000;
            timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            const mergedConfig = {
                timeout: timeoutMs,
                headers: options.headers || {},
                signal: controller.signal,
            };
            const fetchPage = async (page) => {
                const res = await axiosInstance.get(
                    `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=text&format=json&utf8=1`,
                    mergedConfig
                );
                if (res.data?.error) {
                    throw new Error(`Wikipedia API error for ${page}: ${res.data.error.code || 'unknown'}`);
                }
                const text = res.data?.parse?.text;
                const html = typeof text === 'string' ? text : text?.['*'];
                if (typeof html !== 'string' || !html.trim()) {
                    throw new Error(`Wikipedia returned no parsed HTML for ${page}`);
                }
                return html;
            };

            let rootHtml = await fetchPage(WIKI_PAGE);
            const $root = cheerio.load(rootHtml);
            const pages = new Set([WIKI_PAGE]);
            $root('a[href]').each((i, el) => {
                try {
                    const url = new URL($root(el).attr('href'), 'https://en.wikipedia.org');
                    if (url.origin !== 'https://en.wikipedia.org' || !url.pathname.startsWith('/wiki/')) return;
                    const page = decodeURIComponent(url.pathname.slice('/wiki/'.length)).replace(/ /g, '_');
                    if (/^List_of_films_with_post-credits_scenes_\((?:before_\d{4}|\d{4}s)\)$/.test(page)) {
                        pages.add(page);
                    }
                } catch {
                    /* Ignore malformed or unrelated navigation links. */
                }
            });
            if (pages.size > 32) throw new Error('Wikipedia film list exceeded the bounded page limit');

            const newCache = new Map();
            const pageTitles = [...pages];
            // The original list is now a directory of decade pages. Fetch at most
            // two pages at a time under one deadline and commit only a complete index.
            for (let offset = 0; offset < pageTitles.length; ) {
                const batch = pageTitles.slice(offset, offset + (offset === 0 ? 1 : 2));
                offset += batch.length;
                const htmlPages = await Promise.all(
                    batch.map(async (page) => ({
                        page,
                        html: page === WIKI_PAGE ? rootHtml : await fetchPage(page),
                    }))
                );
                rootHtml = '';
                for (const { page, html } of htmlPages) {
                    let htmlContent = html;
                    let parsedEntries = 0;

                    // Optimize CPU and memory by parsing DOM iteratively inside the chunk extraction loop.
                    let currentIndex = 0;
                    while (true) {
                        const tableStart = htmlContent.indexOf('<table', currentIndex);
                        if (tableStart === -1) break;

                        const tableEnd = htmlContent.indexOf('</table>', tableStart);
                        if (tableEnd === -1) break;

                        const tableChunk = htmlContent.substring(tableStart, tableEnd + 8);
                        if (tableChunk.includes('wikitable')) {
                            // Tight scope for Cheerio to ensure immediate garbage collection per chunk
                            const $ = cheerio.load(tableChunk);
                            $('tr').each((i, el) => {
                                const $el = $(el);
                                let titleText = '';

                                const $iNode = $el.find('i').first();
                                if ($iNode.length > 0) {
                                    titleText = $iNode.text();
                                } else {
                                    const $tds = $el.find('td');
                                    if ($tds.length > 1) {
                                        titleText = $tds.eq(1).text();
                                    }
                                }

                                if (!titleText) return;

                                const cleanTitle = wikiNormalize(titleText);
                                if (!cleanTitle) return;
                                parsedEntries++;
                                const rowText = $el.text().toLowerCase();

                                let hasMid = WIKI_MID_REGEX.test(rowText);
                                let hasPost = WIKI_POST_REGEX.test(rowText);
                                let hasBloopers = BLOOPER_REGEX.test(rowText);
                                let hasAudioOnly = AUDIO_ONLY_REGEX.test(rowText);

                                newCache.set(cleanTitle, {
                                    mid: hasMid,
                                    post: hasPost,
                                    bloopers: hasBloopers,
                                    audioOnly: hasAudioOnly,
                                });
                            });
                        }

                        currentIndex = tableEnd + 8;
                    }

                    // Explicitly clear original huge payload before continuing
                    htmlContent = '';
                    if (page !== WIKI_PAGE && parsedEntries === 0) {
                        throw new Error(`Wikipedia returned no film entries for ${page}`);
                    }
                }
            }

            if (newCache.size === 0) throw new Error('Wikipedia returned no film entries; keeping the previous index');

            wikiCache = newCache;
            wikiLastFetched = Date.now();
            wikiNextRetryAt = 0;
            log(`[Wiki] Built ${wikiCache.size} entries from Wikipedia (${pages.size} pages).`);

            if (redisCache.isRedisEnabled() && wikiCache.size > 0) {
                const flatData = Object.fromEntries(wikiCache.entries());
                redisCache.setCache('wiki_index_cache', flatData, Math.floor(WIKI_TTL / 1000));
                log(`[Wiki] Saved pre-compiled index to Redis cache.`);
            }
        } catch (e) {
            wikiNextRetryAt = Date.now() + CACHE_TTL_ERROR;
            if (!isCancel(e)) {
                error(`[Wiki Error] ${sanitizeError(e.message)}`);
            }
        } finally {
            clearTimeout(timeoutId);
            controller.abort();
            wikiFetchPromise = null;
        }
    })();

    return wikiFetchPromise;
}

async function checkWikipedia(title) {
    log(`\n--- [Wikipedia] Execution Start: "${title}" ---`);
    await buildWikiIndex();
    const cleanQuery = wikiNormalize(title);
    if (wikiCache.has(cleanQuery)) {
        const data = wikiCache.get(cleanQuery);
        let isDefinitive = true;
        log(
            `[Wikipedia] Match -> Mid: ${data.mid}, Post: ${data.post}, Bloopers: ${data.bloopers}, Definitive: ${isDefinitive}, AudioOnly: ${data.audioOnly || false}`
        );
        return getResultObj(
            data.mid,
            data.post,
            false,
            'https://en.wikipedia.org/wiki/List_of_films_with_post-credits_scenes',
            'Wikipedia',
            data.bloopers,
            isDefinitive,
            false,
            data.audioOnly || false
        );
    }
    log(`[Wikipedia] No match found.`);
    return null;
}

module.exports = {
    buildWikiIndex,
    checkWikipedia,
};
