const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const http = require('http');
const https = require('https');

const app = express();

// 🛡️ Sentinel: Restrict CORS to known Stremio origins to prevent unauthorized cross-origin requests
const allowedOrigins = [
    'https://web.stremio.com',
    'https://app.stremio.com',
    'https://stremio-addons.net',
    'https://strem.io'
];

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps, desktop app, or curl)
        if (!origin) return callback(null, true);

        // Enforce HTTPS and restrict to trusted Stremio domains
        const isAllowed = allowedOrigins.includes(origin) ||
            (origin.startsWith('https://') && origin.endsWith('.strem.io'));

        if (isAllowed) {
            callback(null, true);
        } else {
            console.warn(`[Security] Blocked CORS request from origin: ${origin}`);
            callback(new Error('Not allowed by CORS'));
        }
    },
    optionsSuccessStatus: 200
}));

// ==========================================
// 1. CONFIGURATION & STATE
// ==========================================

// 🛡️ Sentinel: Sanitize error messages to prevent log injection and credential leaks
function sanitizeError(msg) {
    if (!msg) return '';
    let sanitized = String(msg).replace(/[\r\n]/g, ' ');
    return sanitized.replace(/api_key=[^&\s]+/gi, 'api_key=***');
}

// ==========================================

// ⚡ Bolt: Use Keep-Alive agents to reuse TCP connections across requests,
// significantly reducing latency when making multiple API calls concurrently.
const config = {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
    timeout: 8000,
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true })
};
const DEFAULT_TMDB_KEY = process.env.TMDB_API_KEY;

// ⚡ Bolt: Pre-compile regexes used in loops or frequently to avoid redundant instantiation/compilation.
const BLOOPER_REGEX = /\b(bloopers?|outtakes?|gags?|gag reel)\b/;
const NEGATIVE_REGEX = /(no extra|no stinger|nothing|are no|no scene)/;
const STINGER_EXCEPTION_REGEX = /(extra shot|audio|voice|laugh|but|however)/;
const SAFE_SUFFIXES_REGEX = /^(blooper|bloopers|outtake|outtakes|extra|extras|and|or|with|scene|scenes|credit|credits|stinger|stingers|review|reviews|post|mid|after|end|during|the|is|a|an|there|are|movie|film|\s)+$/;

const MAX_CACHE_SIZE = 5000;
const streamCache = {
    _cache: new Map(),
    has(key) { return this._cache.has(key); },
    get(key) { return this._cache.get(key); },
    delete(key) { return this._cache.delete(key); },
    set(key, value) {
        if (this._cache.size >= MAX_CACHE_SIZE) {
            const firstKey = this._cache.keys().next().value;
            this._cache.delete(firstKey);
        }
        this._cache.set(key, value);
    }
};

const CACHE_TTL_SUCCESS = 30 * 60 * 1000;
const CACHE_TTL_ERROR = 60 * 1000;

let wikiCache = new Map();
let wikiLastFetched = 0;
let wikiFetchPromise = null;
const WIKI_TTL = 24 * 60 * 60 * 1000;

// ==========================================
// 2. STRING UTILITIES & FORMATTERS
// ==========================================

/**
 * Security: Prevent SSRF by validating the URL before fetching
 * @param {string} targetUrl - The URL to validate
 * @param {string} baseUrl - The base URL to use for relative URLs
 * @param {string} expectedHostname - The hostname that is allowed
 * @returns {string|null} - The validated URL or null if blocked
 */
function validateUrl(targetUrl, baseUrl, expectedHostname) {
    try {
        const parsedUrl = new URL(targetUrl, baseUrl);
        if (parsedUrl.hostname !== expectedHostname && parsedUrl.hostname !== `www.${expectedHostname}`) {
            console.warn(`[Security] Blocked untrusted URL: ${targetUrl}`);
            return null;
        }
        return parsedUrl.href;
    } catch (e) {
        console.warn(`[Security] Invalid URL format: ${targetUrl}`);
        return null;
    }
}


// ⚡ Bolt: Pre-compiled regexes for hot string utilities
const RE_YEAR = /\(\d{4}\)/g;
const RE_NON_WORD = /[^\w\s]/g;
const RE_MULTI_SPACE = /\s+/g;
const RE_ARTICLE_START = /^(the|a|an)\s+/i;
const RE_ARTICLE_END = /\s+(the|a|an)$/i;

const cleanTitle = (str) => {
    let s = str.replace(RE_NON_WORD, ' ').replace(RE_MULTI_SPACE, ' ').trim();
    return s.replace(RE_ARTICLE_START, '').replace(RE_ARTICLE_END, '').trim();
};

// Security: Replace regex with Set to prevent ReDoS
// ⚡ Bolt: Extracted safeTokens Set and isSafeSuffix to outer scope to avoid redundant instantiations
const safeTokens = new Set([
    'blooper', 'bloopers', 'outtake', 'outtakes', 'extra', 'extras', 'and', 'or', 'with',
    'scene', 'scenes', 'credit', 'credits', 'stinger', 'stingers', 'review', 'reviews',
    'post', 'mid', 'after', 'end', 'during', 'the', 'is', 'a', 'an', 'there', 'are', 'movie', 'film'
]);

const isSafeSuffix = (str) => {
    if (!str) return false;
    return str.split(/\s+/).every(word => word === '' || safeTokens.has(word));
};

const isTitleMatch = (linkText, cleanedTargetTitle) => {
    let tLink = linkText.toLowerCase().replace(RE_YEAR, '').trim();
    tLink = cleanTitle(tLink);

    if (tLink === cleanedTargetTitle) return true;

    if (cleanedTargetTitle.length > 0 && tLink.startsWith(cleanedTargetTitle)) {
        const remainder = tLink.substring(cleanedTargetTitle.length).trim();
        if (isSafeSuffix(remainder)) return true;
    }

    if (tLink.length > 0 && cleanedTargetTitle.startsWith(tLink)) {
        const remainder = cleanedTargetTitle.substring(tLink.length).trim();
        if (isSafeSuffix(remainder)) return true;
    }

    return false;
};

const RE_WIKI_ARTICLE_START = /^(the|a|an)\s+/i;
const RE_WIKI_ARTICLE_END = /,\s*(the|a|an)$/i;
const RE_WIKI_PARENS = /\s*\(.*?\)\s*/g;
const RE_WIKI_NON_ALNUM = /[^a-z0-9]/g;

const wikiNormalize = (title) => {
    return title.toLowerCase()
        .replace(RE_WIKI_ARTICLE_START, '')
        .replace(RE_WIKI_ARTICLE_END, '')
        .replace(RE_WIKI_PARENS, '')
        .replace(RE_WIKI_NON_ALNUM, '')
        .trim();
};

const getResultObj = (mid, post, no, url, source, bloopers = false, definitive = false, sequel = false) => {
    return { mid, post, no, url, source, bloopers, definitive, sequel };
};

const formatMessage = (styleConfig, data) => {
    let output = [];
    const isSimple = styleConfig.style === 'simple';
    const showBloopers = styleConfig.showBloopers;

    if (data.source === 'Wikipedia' && !data.mid && !data.post && !data.bloopers) {
        return isSimple ? "Unclassified Scene" : "❓ Unclassified Scene";
    }

    if (isSimple) {
        if (data.mid && data.post) output.push("Mid-Credits Scene\nPost-Credits Scene");
        else if (data.mid) output.push("Mid-Credits Scene");
        else if (data.post) output.push("Post-Credits Scene");
        else if (!data.bloopers || !showBloopers) {
            output.push((data.no || (data.bloopers && !showBloopers)) ? "No Bonus Scenes" : "No Stingers Found");
        }
    } else {
        if (data.mid && data.post) output.push("🍿 Mid & Post-Credits Scenes");
        else if (data.mid) output.push("⏳ Mid-Credits Scene");
        else if (data.post) output.push("🎬 Post-Credits Scene");
        else if (!data.bloopers || !showBloopers) {
            output.push((data.no || (data.bloopers && !showBloopers)) ? "🏃‍♂️ Nothing But Credits" : "🕵️‍♂️ Couldn't Find Stingers");
        }
    }

    if (showBloopers && data.bloopers) {
        output.push(isSimple ? "Outtakes" : "🎭 Outtakes");
    }

    if (styleConfig.showSequel && data.sequel && data.source === 'AfterCredits') {
        output.push(isSimple ? "Sequel Setup" : "🔮 Sets Up For A Sequel");
    }

    return output.join('\n');
};

// ==========================================
// 3. CORE SCRAPERS
// ==========================================

const RE_MS_MID_YES = /during (the )?credits\W{1,15}(yes|\d+|extra|scene|\bshots?\b)/;
const RE_MS_MID_NO = /during (the )?credits\W{1,15}no\b/;
const RE_MS_POST_YES = /after (the )?credits\W{1,15}(yes|\d+|extra|scene|\bshots?\b)/;
const RE_MS_POST_NO = /after (the )?credits\W{1,15}no\b/;
const RE_MS_LEGACY_MID_NO = /(no|zero) (extra|scene|stinger|animation|extras).{0,40}during the credits/;
const RE_MS_LEGACY_POST_NO = /(no|zero) (extra|scene|stinger|extras).{0,40}after the credits/;
const RE_MS_MID_FALLBACK = /(extra scene|stinger|animation|extra shot|shot).{0,60}during the credits/;
const RE_MS_POST_FALLBACK = /(extra scene|stinger|extra shot|shot).{0,60}after the credits/;
const RE_MS_SEO_NO = /\b(no|zero)\b/;
const RE_MS_AUDIO_1 = /\b(audio|voice|hear|heard|message|tribute|dedication|honored)\b/;
const RE_MS_AUDIO_2 = /\b(scene|scenes|shot|shots|animation|animations|video|footage|shows|we see|visual)\b/;


async function buildWikiIndex(reqConfig = config) {
    if (Date.now() - wikiLastFetched < WIKI_TTL && wikiCache.size > 0) return;
    if (wikiFetchPromise) return wikiFetchPromise;

    wikiFetchPromise = (async () => {
        try {
            console.log(`[Wiki] Building index...`);
            const res = await axios.get('https://en.wikipedia.org/wiki/List_of_films_with_post-credits_scenes', reqConfig);
            const $ = cheerio.load(res.data);
            const newCache = new Map();

            $("table.wikitable tr").each((i, el) => {
                let titleText = $(el).find("i").first().text();
                if (!titleText) titleText = $(el).find("td").eq(1).text();
                if (!titleText) return;

                const cleanTitle = wikiNormalize(titleText);
                const rowText = $(el).text().toLowerCase();

                let hasMid = rowText.includes('mid-') || rowText.includes('during');
                let hasPost = rowText.includes('post-') || rowText.includes('after');
                let hasBloopers = BLOOPER_REGEX.test(rowText);

                newCache.set(cleanTitle, { mid: hasMid, post: hasPost, bloopers: hasBloopers });
            });

            wikiCache = newCache;
            wikiLastFetched = Date.now();
            console.log(`[Wiki] Built ${wikiCache.size} entries.`);
        } catch (e) {
            if (e.name !== 'CanceledError' && e.message !== 'canceled') {
                console.error(`[Wiki Error] ${e.message}`);
            }
        } finally {
            wikiFetchPromise = null;
        }
    })();

    return wikiFetchPromise;
}

async function checkWikipedia(title, reqConfig) {
    console.log(`\n--- [Wikipedia] Execution Start: "${title}" ---`);
    await buildWikiIndex(reqConfig);
    const cleanQuery = wikiNormalize(title);
    if (wikiCache.has(cleanQuery)) {
        const data = wikiCache.get(cleanQuery);
        let isDefinitive = true; // Any match in the Wikipedia list is considered a definitive state
        console.log(`[Wikipedia] Match -> Mid: ${data.mid}, Post: ${data.post}, Bloopers: ${data.bloopers}, Definitive: ${isDefinitive}`);
        return getResultObj(data.mid, data.post, false, 'https://en.wikipedia.org/wiki/List_of_films_with_post-credits_scenes', 'Wikipedia', data.bloopers, isDefinitive);
    }
    console.log(`[Wikipedia] No match found.`);
    return null;
}

async function searchAfterCreditsMatch(title, year, reqConfig) {
    const cleanedTitle = cleanTitle(title.toLowerCase().trim());
    const searchUrl = `https://aftercredits.com/?s=${encodeURIComponent(year ? `${title} ${year}` : title).replace(/%20/g, '+')}`;
    const searchRes = await axios.get(searchUrl, reqConfig);
    const $ = cheerio.load(searchRes.data);
    let potentialMatches = [];

    $("h2 a, h3 a, .entry-title a, .title a, .post-title a").each((i, el) => {
        const rawLinkText = $(el).text().toLowerCase().trim();
        if (!rawLinkText) return;

        if (isTitleMatch(rawLinkText, cleanedTitle)) {
            potentialMatches.push({
                url: $(el).attr('href'),
                isReview: rawLinkText.includes('review'),
                rawText: rawLinkText
            });
        }
    });

    if (potentialMatches.length === 0) {
        console.log(`[AfterCredits] Aborting: No match found.`);
        return null;
    }

    potentialMatches.sort((a, b) => {
        if (a.isReview !== b.isReview) return a.isReview ? 1 : -1;
        return 0;
    });

    return potentialMatches[0];
}

async function parseAfterCreditsPage(bestMatchUrl, reqConfig) {
    const movieRes = await axios.get(bestMatchUrl, reqConfig);
    const $$ = cheerio.load(movieRes.data);
    let hasMid = false, hasPost = false, bloopers = false, sequel = false;

    let categoryTags = [];
    $$('ul.td-category li.entry-category a').each((i, el) => {
        categoryTags.push($$(el).text().trim().toLowerCase());
    });
    console.log(`[AfterCredits] Categories Found: [${categoryTags.join(', ')}]`);

    if (categoryTags.includes('non-stingers')) {
        console.log(`[AfterCredits] 'non-stingers' category detected. Forcing definitive negative state.`);
        return getResultObj(false, false, true, bestMatchUrl, 'AfterCredits', false, true);
    }

    if (categoryTags.length > 0) {
        if (categoryTags.includes('both during & after credits')) { hasMid = true; hasPost = true; }
        if (categoryTags.includes('during credits')) { hasMid = true; }
        if (categoryTags.includes('after credits')) { hasPost = true; }
        if (categoryTags.some(t => ['outtake', 'musical', 'blooper', 'humorous credit'].includes(t))) { bloopers = true; }
        if (categoryTags.includes('sequel setup')) { sequel = true; }
    }

    console.log(`[AfterCredits] Parsing body containers...`);

    const updateStingerState = (isBlooper, isNegative, currentState, type) => {
        if (isBlooper) {
            bloopers = true;
            console.log(`[AfterCredits] Blooper found in ${type} container.`);
            return currentState;
        }
        return !isNegative;
    };

    $$(".spoiler-wrap").each((i, el) => {
        const headText = $$(el).find(".spoiler-head").text().trim().toLowerCase();
        const blockText = $$(el).text().toLowerCase();

        const isBlooper = BLOOPER_REGEX.test(blockText);
        const isNegative = NEGATIVE_REGEX.test(blockText) && !STINGER_EXCEPTION_REGEX.test(blockText);

        if (headText.includes("during") || headText.includes("mid")) {
            hasMid = updateStingerState(isBlooper, isNegative, hasMid, 'MID');
        }

        if (headText.includes("after") || headText.includes("post")) {
            hasPost = updateStingerState(isBlooper, isNegative, hasPost, 'POST');
        }
    });

    let isDefinitive = false;
    if (hasMid || hasPost || bloopers || sequel) {
        isDefinitive = true;
    }

    const isNegative = (!hasMid && !hasPost && !bloopers);

    console.log(`[AfterCredits] Result -> Mid: ${hasMid}, Post: ${hasPost}, Negative: ${isNegative}, Bloopers: ${bloopers}, Definitive: ${isDefinitive}, Sequel: ${sequel}`);
    return getResultObj(hasMid, hasPost, isNegative, bestMatchUrl, 'AfterCredits', bloopers, isDefinitive, sequel);
}

async function checkAfterCredits(title, year, reqConfig) {
    console.log(`\n--- [AfterCredits] Execution Start: "${title}" ---`);
    try {
        const bestMatch = await searchAfterCreditsMatch(title, year, reqConfig);

        if (!bestMatch) {
            return null;
        }

        console.log(`[AfterCredits] Fetching -> ${bestMatch.url} (Text: "${bestMatch.rawText}")`);

        // Security: Prevent SSRF by validating the URL before fetching
        const safeUrl = validateUrl(bestMatch.url, 'https://aftercredits.com', 'aftercredits.com');
        if (!safeUrl) return null;

        return await parseAfterCreditsPage(safeUrl, reqConfig);
    } catch (e) {
        if (e.name !== 'CanceledError' && e.message !== 'canceled') {
            console.error(`[AfterCredits Error] ${sanitizeError(e.message)}`);
        }
        return null;
    }
}

function parseMediaStingerSeoText(seoText) {
    let seoMid = false, seoPost = false, seoBloopers = false, seoNo = false, noStinger = false;
    if (seoText) {
        if (RE_MS_SEO_NO.test(seoText)) {
            seoNo = true;
            if (seoText.includes('during') || seoText.includes('mid')) seoMid = 'false';
            if (seoText.includes('after') || seoText.includes('post')) seoPost = 'false';
            if (!seoText.includes('during') && !seoText.includes('mid') && !seoText.includes('after') && !seoText.includes('post')) {
                noStinger = true;
            }
        } else {
            if (seoText.includes('during') || seoText.includes('mid')) seoMid = true;
            if (seoText.includes('after') || seoText.includes('post')) seoPost = true;
            if (seoText.includes('blooper') || seoText.includes('outtake')) seoBloopers = true;
        }
    }
    return { seoMid, seoPost, seoBloopers, seoNo, noStinger };
}

function parseMediaStingerBodyText(fullText) {
    let bodyMid = false, bodyPost = false, bodyBloopers = false;

    if (BLOOPER_REGEX.test(fullText)) bodyBloopers = true;

    const midYes = RE_MS_MID_YES.test(fullText);
    const midNo = RE_MS_MID_NO.test(fullText);
    const postYes = RE_MS_POST_YES.test(fullText);
    const postNo = RE_MS_POST_NO.test(fullText);

    if (midYes) bodyMid = true;
    if (postYes) bodyPost = true;

    const legacyMidNo = RE_MS_LEGACY_MID_NO.test(fullText);
    const legacyPostNo = RE_MS_LEGACY_POST_NO.test(fullText);

    if (RE_MS_MID_FALLBACK.test(fullText) && !legacyMidNo) bodyMid = true;
    if (RE_MS_POST_FALLBACK.test(fullText) && !legacyPostNo) bodyPost = true;

    const validateContext = (keyword) => {
        const idx = fullText.indexOf(keyword);
        if (idx === -1) return false;
        const context = fullText.substring(Math.max(0, idx - 80), Math.min(fullText.length, idx + 120));
        return RE_MS_AUDIO_1.test(context) && !RE_MS_AUDIO_2.test(context);
    };

    const midIsAudio = validateContext('during the credits') || validateContext('during credits');
    const postIsAudio = validateContext('after the credits') || validateContext('after credits');

    return { bodyMid, bodyPost, bodyBloopers, midNo, postNo, legacyMidNo, legacyPostNo, midIsAudio, postIsAudio };
}

async function searchMediaStinger(title, reqConfig) {
    const cleanedTitle = cleanTitle(title.toLowerCase().trim());
    const cleanSearchTitle = title.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    const searchUrl = `http://www.mediastinger.com/?s=${encodeURIComponent(cleanSearchTitle).replace(/%20/g, '+')}`;
    const searchRes = await axios.get(searchUrl, reqConfig);
    const $ = cheerio.load(searchRes.data);
    let potentialMatches = [];

    $("h2 a, h3 a, .entry-title a, .title a, .post-title a, ul.highlights li a").each((i, el) => {
        const rawLinkText = $(el).text().toLowerCase().trim();
        if (!rawLinkText) return;

        if (isTitleMatch(rawLinkText, cleanedTitle)) {
            potentialMatches.push({
                url: $(el).attr('href'),
                rawText: rawLinkText
            });
            return false;
        }
    });

    if (potentialMatches.length === 0) return null;
    return potentialMatches[0];
}

async function checkMediaStinger(title, year, reqConfig) {
    console.log(`\n--- [MediaStinger] Execution Start: "${title}" ---`);
    try {
        const bestMatch = await searchMediaStinger(title, reqConfig);
        if (!bestMatch) {
            console.log(`[MediaStinger] Aborting: No match found.`);
            return null;
        }

        console.log(`[MediaStinger] Fetching -> ${bestMatch.url} (Text: "${bestMatch.rawText}")`);

        let hasMid = false, hasPost = false, noStinger = false, bloopers = false;

        if (bestMatch.url) {
            const safeUrl = validateUrl(bestMatch.url, 'http://www.mediastinger.com', 'mediastinger.com');
            if (!safeUrl) return null;
            bestMatch.url = safeUrl;

            const movieRes = await axios.get(bestMatch.url, reqConfig);
            const $$ = cheerio.load(movieRes.data);

            const seoText = $$('.groupingforseo').text().toLowerCase();
            if (seoText) {
                console.log(`[MediaStinger] SEO Header Found: "${seoText}"`);
            }
            const seo = parseMediaStingerSeoText(seoText);

            const contentNode = $$('.post_secwrapper').first();
            const rawHtml = contentNode.html() || '';
            const fullText = rawHtml.replace(/<[^>]*>/g, ' ').toLowerCase().replace(/\s+/g, ' ');
            const body = parseMediaStingerBodyText(fullText);

            if ((seo.seoMid === true || body.bodyMid) && !body.midNo && !body.legacyMidNo && !body.midIsAudio && seo.seoMid !== 'false') hasMid = true;
            if ((seo.seoPost === true || body.bodyPost) && !body.postNo && !body.legacyPostNo && !body.postIsAudio && seo.seoPost !== 'false') hasPost = true;
            if (seo.seoBloopers || body.bodyBloopers) bloopers = true;

            if (body.midNo && body.postNo) noStinger = true;
            if (body.legacyMidNo && body.legacyPostNo) noStinger = true;
            if (!hasMid && !hasPost && (fullText.includes('no extra scenes') || fullText.includes('are no extras') || fullText.includes('nothing extra'))) noStinger = true;
            if (seo.seoNo && !hasMid && !hasPost && !bloopers) noStinger = true;

            if (hasMid || hasPost || bloopers) noStinger = false;
            if (!hasMid && !hasPost && !bloopers && seoText === '') noStinger = true;
        }

        let isDefinitive = false;
        if (hasMid || hasPost || bloopers || noStinger) {
            isDefinitive = true;
        }

        console.log(`[MediaStinger] Result -> Mid: ${hasMid}, Post: ${hasPost}, Negative: ${noStinger}, Bloopers: ${bloopers}, Definitive: ${isDefinitive}`);
        return getResultObj(hasMid, hasPost, noStinger, bestMatch.url, 'MediaStinger', bloopers, isDefinitive);
    } catch (e) {
        if (e.name !== 'CanceledError' && e.message !== 'canceled') {
            console.error(`[MediaStinger Error] ${sanitizeError(e.message)}`);
        }
        return null;
    }
}


async function checkTmdb(imdbId, tmdbIdRaw, apiKey, reqConfig) {
    console.log(`\n--- [TMDB] Execution Start: ID ${imdbId} (TMDB: ${tmdbIdRaw}) ---`);
    const key = apiKey || DEFAULT_TMDB_KEY;
    try {
        let tmdbId = tmdbIdRaw;

        // ⚡ Bolt: Use moviedb_id from cinemeta to skip redundant /3/find network roundtrip
        // Expected impact: Removes ~100ms latency from TMDB scraper's critical path
        // Fallback to searching if we don't have the tmdbId from cinemeta
        if (!tmdbId) {
            const findRes = await axios.get(`https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?external_source=imdb_id&api_key=${encodeURIComponent(key)}`, reqConfig);
            const movieMatch = findRes.data.movie_results?.[0];
            if (!movieMatch) {
                console.log(`[TMDB] No match found.`);
                return null;
            }
            tmdbId = Number(movieMatch.id);
        }
        const kwRes = await axios.get(`https://api.themoviedb.org/3/movie/${encodeURIComponent(tmdbId)}/keywords?api_key=${encodeURIComponent(key)}`, reqConfig);
        const keywords = kwRes.data.keywords || [];

        let hasMid = false, hasPost = false, bloopers = false;
        for (const k of keywords) {
            const name = k.name;
            if (!hasMid && name.includes('duringcreditsstinger')) hasMid = true;
            if (!hasPost && name.includes('aftercreditsstinger')) hasPost = true;
            if (!bloopers && (name.includes('blooper') || name.includes('outtake'))) bloopers = true;
            if (hasMid && hasPost && bloopers) break;
        }

        if (!hasMid && !hasPost && !bloopers) {
            console.log(`[TMDB] No stinger keywords found.`);
            return null;
        }

        let isDefinitive = true; // Finding scene keywords on TMDB is definitive
        console.log(`[TMDB] Match -> Mid: ${hasMid}, Post: ${hasPost}, Bloopers: ${bloopers}, Definitive: ${isDefinitive}`);
        return getResultObj(hasMid, hasPost, false, `https://www.themoviedb.org/movie/${tmdbId}`, 'TMDB', bloopers, isDefinitive);
    } catch (e) {
        if (e.name !== 'CanceledError' && e.message !== 'canceled') {
            console.error(`[TMDB Error] ${sanitizeError(e.message)}`);
        }
        return null;
    }
}

// ==========================================
// 4. EXPRESS APP & API ROUTES
// ==========================================

const serveConfig = (req, res) => res.sendFile(path.join(__dirname, 'index.html'));
app.get('/', serveConfig);
app.get('/configure', serveConfig);

const manifestHandler = (req, res) => {
    res.json({
        id: 'org.stinger.pro',
        version: '2.0.2',
        name: 'Stremio Stinger Pro',
        description: 'Detects mid/post-credit scenes and optionally bloopers/outtakes and sequel setups. Powered by a multi-tiered scraping system including AfterCredits, MediaStinger, TMDB, and Wikipedia.',
        logo: 'https://github.com/schultz911/stremio-stinger-pro/blob/main/icon.png?raw=true',
        types: ['movie'],
        catalogs: [],
        resources: ['stream'],
        idPrefixes: ['tt'],
        behaviorHints: { configurable: true, configurationRequired: false }
    });
};

app.get('/manifest.json', manifestHandler);
app.get('/:p1/manifest.json', manifestHandler);
app.get('/:style/:apiKey/manifest.json', manifestHandler);

const streamHandler = async (req, res) => {
    res.setHeader('Cache-Control', 'max-age=0, no-cache, no-store, must-revalidate');


    const { type, id } = req.params;
    if (type !== 'movie') return res.json({ streams: [] });
    if (!id || !/^tt\d+$/.test(id)) {
        console.warn(`[Stream] Invalid ID format: ${id}`);
        return res.json({ streams: [] });
    }


    console.log(`\n========== NEW REQUEST ==========`);
    console.log(`[Stream] Request Type: ${type} | ID: ${id}`);


    let rawStyle = req.params.style || req.params.p1 || 'colorful';
    let apiKey = req.params.apiKey || (req.params.p1 && !req.params.p1.includes('simple') && !req.params.p1.includes('colorful') ? req.params.p1 : null);

    // Security: Input length limits
    if (rawStyle.length > 50) rawStyle = 'colorful';
    if (apiKey && apiKey.length > 100) apiKey = null;


    const styleConfig = {
        style: rawStyle.replace(/-nosource|-bloopers|-sequel/g, ''),
        showSource: !rawStyle.includes('-nosource'),
        showBloopers: rawStyle.includes('-bloopers'),
        showSequel: rawStyle.includes('-sequel')
    };

    const cacheKey = `${id}_${rawStyle}`;
    if (streamCache.has(cacheKey)) {
        const cached = streamCache.get(cacheKey);
        if (Date.now() < cached.expiresAt) {
            console.log(`[Stream] Cache HIT. Resolving from memory.`);
            return res.json({ streams: [cached.stream] });
        } else {
            streamCache.delete(cacheKey);
        }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);
    const reqConfig = { ...config, signal: controller.signal };

    try {
        const metaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/movie/${id}.json`, reqConfig);
        const title = metaRes.data?.meta?.name;
        const year = metaRes.data?.meta?.year;

        if (title) {
            console.log(`[Stream] Target: "${title}" (${year})`);

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

            console.log(`[Stream] Firing all scrapers concurrently for minimal latency...`);
            // Execute all scrapers concurrently to drastically reduce tail latency
            // If a higher priority scraper finds a definitive result, the AbortController
            // in the finally block will cancel the pending lower-priority requests.
            const pAc = checkAfterCredits(title, year, reqConfig);
            const pMs = checkMediaStinger(title, year, reqConfig);
            const pTmdb = checkTmdb(id, metaRes.data?.meta?.moviedb_id, apiKey, reqConfig);
            const pWiki = checkWikipedia(title, reqConfig);

            // Await them in priority order, so we can short-circuit
            const scrapers = [
                { name: 'AfterCredits', promise: pAc },
                { name: 'MediaStinger', promise: pMs },
                { name: 'TMDB', promise: pTmdb },
                { name: 'Wikipedia', promise: pWiki }
            ];

            for (const scraper of scrapers) {
                const result = await scraper.promise;
                if (result && result.definitive) {
                    finalResult = result;
                    console.log(`[Stream] Definitive state found by ${scraper.name}.${scraper.name !== 'Wikipedia' ? ' Aborting others...' : ''}`);
                    if (scraper.name !== 'Wikipedia') controller.abort();
                    break;
                } else {
                    updateFallback(result);
                }
            }

            const isAggregatedError = !finalResult && !bestFallback;
            const resolvedResult = finalResult || bestFallback || { mid: false, post: false, no: false, bloopers: false, sequel: false, url: `https://aftercredits.com/?s=${encodeURIComponent(year ? `${title} ${year}` : title).replace(/%20/g, '+')}`, source: 'Aggregated' };

            console.log(`[Stream] Final Resolution -> Source Used: ${resolvedResult.source}`);

            const stream = {
                name: 'After-Credits Scenes',
                title: `${formatMessage(styleConfig, resolvedResult)}${styleConfig.showSource ? `\nSource: ${resolvedResult.source}` : ''}`,
                url: resolvedResult.url || `https://aftercredits.com/?s=${encodeURIComponent(year ? `${title} ${year}` : title).replace(/%20/g, '+')}`
            };

            const cacheDuration = isAggregatedError ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS;
            streamCache.set(cacheKey, { expiresAt: Date.now() + cacheDuration, stream });

            console.log(`[Stream] Payload generated and cached. Sequence complete.`);
            console.log(`=================================\n`);
            return res.json({ streams: [stream] });
        }
    } catch (e) {
        if (e.name !== 'CanceledError' && e.message !== 'canceled') {
            console.error(`[Stream Error] Main Handler Failed: ${sanitizeError(e.message)}`);
        }
    } finally {
        clearTimeout(timeoutId);
        controller.abort();
    }

    console.log(`[Stream] Sequence aborted. Returning empty streams.`);
    console.log(`=================================\n`);
    res.json({ streams: [] });
};

app.get('/stream/:type/:id.json', streamHandler);
app.get('/:p1/stream/:type/:id.json', streamHandler);
app.get('/:style/:apiKey/stream/:type/:id.json', streamHandler);

app.listen(process.env.PORT || 7000, () => {
    buildWikiIndex();
    console.log('[System] Stremio Stinger Pro initialized.');
});
