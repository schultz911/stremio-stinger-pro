const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
app.use(cors());

// ==========================================
// 1. CONFIGURATION & STATE
// ==========================================

const config = {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
    timeout: 8000 
};
const DEFAULT_TMDB_KEY = process.env.TMDB_API_KEY;

const streamCache = new Map();
const CACHE_TTL_SUCCESS = 30 * 60 * 1000; 
const CACHE_TTL_ERROR = 60 * 1000;        

let wikiCache = new Map();
let wikiLastFetched = 0;
const WIKI_TTL = 24 * 60 * 60 * 1000; 

// ==========================================
// 2. STRING UTILITIES & FORMATTERS
// ==========================================

const isTitleMatch = (linkText, targetTitle) => {
    let tLink = linkText.toLowerCase().replace(/\(\d{4}\)/g, '').trim();
    let tTarget = targetTitle.toLowerCase().trim();

    const clean = (str) => {
        let s = str.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
        return s.replace(/^(the|a|an)\s+/i, '').replace(/\s+(the|a|an)$/i, '').trim(); 
    };

    tLink = clean(tLink);
    tTarget = clean(tTarget);

    if (tLink === tTarget) return true;

    const safeSuffixes = /^(blooper|bloopers|outtake|outtakes|extra|extras|and|or|with|scene|scenes|credit|credits|stinger|stingers|review|reviews|post|mid|after|end|during|the|is|a|an|there|are|movie|film|\s)+$/;
    
    if (tTarget.length > 0 && tLink.startsWith(tTarget)) {
        const remainder = tLink.substring(tTarget.length).trim();
        if (safeSuffixes.test(remainder)) return true;
    }
    
    if (tLink.length > 0 && tTarget.startsWith(tLink)) {
         const remainder = tTarget.substring(tLink.length).trim();
         if (safeSuffixes.test(remainder)) return true;
    }

    return false;
};

const wikiNormalize = (title) => {
    return title.toLowerCase()
        .replace(/^(the|a|an)\s+/i, '')
        .replace(/,\s*(the|a|an)$/i, '')
        .replace(/\s*\(.*?\)\s*/g, '')
        .replace(/[^a-z0-9]/g, '')
        .trim();
};

const getResultObj = (mid, post, no, url, source, bloopers = false, definitive = false) => {
    return { mid, post, no, url, source, bloopers, definitive };
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

    return output.join('\n');
};

// ==========================================
// 3. CORE SCRAPERS
// ==========================================

async function buildWikiIndex(reqConfig = config) {
    if (Date.now() - wikiLastFetched < WIKI_TTL && wikiCache.size > 0) return;
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
            let hasBloopers = !!rowText.match(/\b(bloopers?|outtakes?|gags?|gag reel)\b/);
            
            newCache.set(cleanTitle, { mid: hasMid, post: hasPost, bloopers: hasBloopers });
        });
        
        wikiCache = newCache;
        wikiLastFetched = Date.now();
        console.log(`[Wiki] Built ${wikiCache.size} entries.`);
    } catch (e) {
        if (e.name !== 'CanceledError' && e.message !== 'canceled') {
            console.error(`[Wiki Error] ${e.message}`);
        }
    }
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

async function checkAfterCredits(title, year, reqConfig) {
    console.log(`\n--- [AfterCredits] Execution Start: "${title}" ---`);
    try {
        const searchUrl = `https://aftercredits.com/?s=${encodeURIComponent(year ? `${title} ${year}` : title).replace(/%20/g, '+')}`;
        const searchRes = await axios.get(searchUrl, reqConfig);
        const $ = cheerio.load(searchRes.data);
        let potentialMatches = [];

        $("h2 a, h3 a, .entry-title a, .title a, .post-title a").each((i, el) => {
            const rawLinkText = $(el).text().toLowerCase().trim();
            if (!rawLinkText) return;

            if (isTitleMatch(rawLinkText, title)) {
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

        const bestMatch = potentialMatches[0];
        console.log(`[AfterCredits] Fetching -> ${bestMatch.url} (Text: "${bestMatch.rawText}")`);
        
        const movieRes = await axios.get(bestMatch.url, reqConfig);
        const $$ = cheerio.load(movieRes.data);
        let hasMid = false, hasPost = false, bloopers = false;

        let categoryTags = [];
        $$('ul.td-category li.entry-category a').each((i, el) => {
            categoryTags.push($$(el).text().trim().toLowerCase());
        });
        console.log(`[AfterCredits] Categories Found: [${categoryTags.join(', ')}]`);

        if (categoryTags.includes('non-stingers')) {
            console.log(`[AfterCredits] 'non-stingers' category detected. Forcing definitive negative state.`);
            return getResultObj(false, false, true, bestMatch.url, 'AfterCredits', false, true);
        }

        if (categoryTags.length > 0) {
            if (categoryTags.includes('both during & after credits')) { hasMid = true; hasPost = true; }
            if (categoryTags.includes('during credits')) { hasMid = true; }
            if (categoryTags.includes('after credits')) { hasPost = true; }
            if (categoryTags.some(t => ['outtake', 'musical', 'blooper', 'humorous credit'].includes(t))) { bloopers = true; }
        }

        console.log(`[AfterCredits] Parsing body containers...`);
        $$(".spoiler-wrap").each((i, el) => {
            const headText = $$(el).find(".spoiler-head").text().trim().toLowerCase();
            const blockText = $$(el).text().toLowerCase(); 
            
            const isBlooper = blockText.match(/\b(bloopers?|outtakes?|gags?|gag reel)\b/);
            const isNegative = blockText.match(/(no extra|no stinger|nothing|are no|no scene)/) && !blockText.match(/(extra shot|audio|voice|laugh|but|however)/);

            if (headText.includes("during") || headText.includes("mid")) {
                if (isBlooper) {
                    bloopers = true;
                    console.log(`[AfterCredits] Blooper found in MID container.`);
                } else if (!isNegative) {
                    hasMid = true;
                } else if (isNegative) {
                    hasMid = false; 
                }
            }

            if (headText.includes("after") || headText.includes("post")) {
                if (isBlooper) {
                    bloopers = true;
                    console.log(`[AfterCredits] Blooper found in POST container.`);
                } else if (!isNegative) {
                    hasPost = true;
                } else if (isNegative) {
                    hasPost = false; 
                }
            }
        });

        let isDefinitive = false;
        if (hasMid || hasPost || bloopers) {
            isDefinitive = true;
        }

        const isNegative = (!hasMid && !hasPost && !bloopers);
        
        console.log(`[AfterCredits] Result -> Mid: ${hasMid}, Post: ${hasPost}, Negative: ${isNegative}, Bloopers: ${bloopers}, Definitive: ${isDefinitive}`);
        return getResultObj(hasMid, hasPost, isNegative, bestMatch.url, 'AfterCredits', bloopers, isDefinitive);
    } catch (e) { 
        if (e.name !== 'CanceledError' && e.message !== 'canceled') {
            console.error(`[AfterCredits Error] ${e.message}`);
        }
        return null; 
    }
}

async function checkMediaStinger(title, year, reqConfig) {
    console.log(`\n--- [MediaStinger] Execution Start: "${title}" ---`);
    try {
        const cleanSearchTitle = title.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
        const searchUrl = `http://www.mediastinger.com/?s=${encodeURIComponent(cleanSearchTitle).replace(/%20/g, '+')}`;
        const searchRes = await axios.get(searchUrl, reqConfig);
        const $ = cheerio.load(searchRes.data);
        let potentialMatches = [];

        $("h2 a, h3 a, .entry-title a, .title a, .post-title a, ul.highlights li a").each((i, el) => {
            const rawLinkText = $(el).text().toLowerCase().trim();
            if (!rawLinkText) return;

            if (isTitleMatch(rawLinkText, title)) {
                potentialMatches.push({
                    url: $(el).attr('href'),
                    rawText: rawLinkText
                });
            }
        });

        if (potentialMatches.length === 0) {
            console.log(`[MediaStinger] Aborting: No match found.`);
            return null;
        }

        const bestMatch = potentialMatches[0];
        console.log(`[MediaStinger] Fetching -> ${bestMatch.url} (Text: "${bestMatch.rawText}")`);
        
        let hasMid = false, hasPost = false, noStinger = false, bloopers = false;

        if (bestMatch.url) {
            const movieRes = await axios.get(bestMatch.url, reqConfig);
            const $$ = cheerio.load(movieRes.data);
            
            let seoMid = false, seoPost = false, seoBloopers = false, seoNo = false;
            const seoText = $$('.groupingforseo').text().toLowerCase();
            
            if (seoText) {
                console.log(`[MediaStinger] SEO Header Found: "${seoText}"`);
                
                if (seoText.match(/\b(no|zero)\b/)) {
                    console.log(`[MediaStinger] SEO Header negation detected.`);
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

            const contentNode = $$('.post_secwrapper, main, article, .article, .post, #content, .entry-content').first();
            const rawHtml = contentNode.html() || '';
            const fullText = cheerio.load(rawHtml.replace(/</g, ' <')).text().toLowerCase().replace(/\s+/g, ' ');

            let bodyMid = false, bodyPost = false, bodyBloopers = false;

            if (fullText.match(/\b(bloopers?|outtakes?|gags?|gag reel)\b/)) bodyBloopers = true;

            const midYes = /during (the )?credits\W{1,30}(yes|\d+|extra|scene|\bshots?\b)/.test(fullText);
            const midNo = /during (the )?credits\W{1,30}no\b/.test(fullText);
            const postYes = /after (the )?credits\W{1,30}(yes|\d+|extra|scene|\bshots?\b)/.test(fullText);
            const postNo = /after (the )?credits\W{1,30}no\b/.test(fullText);

            if (midYes) bodyMid = true;
            if (postYes) bodyPost = true;

            const legacyMidNo = /(no|zero) (extra|scene|stinger|animation|extras).{0,40}during the credits/.test(fullText);
            const legacyPostNo = /(no|zero) (extra|scene|stinger|extras).{0,40}after the credits/.test(fullText);

            if (/(extra scene|stinger|animation|extra shot|shot).{0,60}during the credits/.test(fullText) && !legacyMidNo) bodyMid = true;
            if (/(extra scene|stinger|extra shot|shot).{0,60}after the credits/.test(fullText) && !legacyPostNo) bodyPost = true;

            const validateContext = (keyword) => {
                const idx = fullText.indexOf(keyword);
                if (idx === -1) return false;
                const context = fullText.substring(Math.max(0, idx - 80), Math.min(fullText.length, idx + 120));
                return /\b(audio|voice|hear|heard|message|tribute|dedication|honored)\b/.test(context) && !/\b(scene|scenes|shot|shots|animation|animations|video|footage|shows|we see|visual)\b/.test(context);
            };

            const midIsAudio = validateContext('during the credits') || validateContext('during credits');
            const postIsAudio = validateContext('after the credits') || validateContext('after credits');

            if ((seoMid === true || bodyMid) && !midNo && !legacyMidNo && !midIsAudio && seoMid !== 'false') hasMid = true;
            if ((seoPost === true || bodyPost) && !postNo && !legacyPostNo && !postIsAudio && seoPost !== 'false') hasPost = true;
            if (seoBloopers || bodyBloopers) bloopers = true;

            if (midNo && postNo) noStinger = true;
            if (legacyMidNo && legacyPostNo) noStinger = true;
            if (!hasMid && !hasPost && (fullText.includes('no extra scenes') || fullText.includes('are no extras') || fullText.includes('nothing extra'))) noStinger = true;
            if (seoNo && !hasMid && !hasPost && !bloopers) noStinger = true;

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
            console.error(`[MediaStinger Error] ${e.message}`);
        }
        return null; 
    }
}

async function checkTmdb(imdbId, apiKey, reqConfig) {
    console.log(`\n--- [TMDB] Execution Start: ID ${imdbId} ---`);
    const key = apiKey || DEFAULT_TMDB_KEY;
    try {
        const findRes = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&api_key=${key}`, reqConfig);
        const movieMatch = findRes.data.movie_results?.[0];
        if (!movieMatch) {
            console.log(`[TMDB] No match found.`);
            return null;
        }
        
        const tmdbId = Number(movieMatch.id);
        const kwRes = await axios.get(`https://api.themoviedb.org/3/movie/${tmdbId}/keywords?api_key=${key}`, reqConfig);
        const keywords = kwRes.data.keywords || [];
        
        let hasMid = keywords.some(k => k.name.includes('duringcreditsstinger'));
        let hasPost = keywords.some(k => k.name.includes('aftercreditsstinger'));
        let bloopers = keywords.some(k => k.name.includes('blooper') || k.name.includes('outtake'));
        
        if (!hasMid && !hasPost && !bloopers) {
            console.log(`[TMDB] No stinger keywords found.`);
            return null;
        }

        let isDefinitive = true; // Finding scene keywords on TMDB is definitive
        console.log(`[TMDB] Match -> Mid: ${hasMid}, Post: ${hasPost}, Bloopers: ${bloopers}, Definitive: ${isDefinitive}`);
        return getResultObj(hasMid, hasPost, false, `https://www.themoviedb.org/movie/${tmdbId}`, 'TMDB', bloopers, isDefinitive);
    } catch (e) { 
        if (e.name !== 'CanceledError' && e.message !== 'canceled') {
            console.error(`[TMDB Error] ${e.message}`);
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
        version: '1.6.5',
        name: 'Stremio Stinger Pro',
        description: 'Blazing fast mid/post-credit scene detection.',
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

    console.log(`\n========== NEW REQUEST ==========`);
    console.log(`[Stream] Request Type: ${type} | ID: ${id}`);

    let rawStyle = req.params.style || req.params.p1 || 'colorful';
    let apiKey = req.params.apiKey || (req.params.p1 && !req.params.p1.includes('simple') && !req.params.p1.includes('colorful') ? req.params.p1 : null);

    const styleConfig = {
        style: rawStyle.replace(/-nosource|-bloopers/g, ''),
        showSource: !rawStyle.includes('-nosource'),
        showBloopers: rawStyle.includes('-bloopers')
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

            // 1. Tier 1: AfterCredits
            console.log(`[Stream] Firing Tier 1: AfterCredits`);
            let acResult = await checkAfterCredits(title, year, reqConfig);
            
            if (acResult && acResult.definitive) {
                finalResult = acResult;
                console.log(`[Stream] Definitive state found by AfterCredits. Skipping remaining scrapers.`);
            } else {
                updateFallback(acResult);
                
                // 2. Tier 2: MediaStinger
                console.log(`[Stream] Firing Tier 2: MediaStinger`);
                let msResult = await checkMediaStinger(title, year, reqConfig);
                if (msResult && msResult.definitive) {
                    finalResult = msResult;
                    console.log(`[Stream] Definitive state found by MediaStinger. Skipping remaining scrapers.`);
                } else {
                    updateFallback(msResult);

                    // 3. Tier 3: TMDB
                    console.log(`[Stream] Firing Tier 3: TMDB`);
                    let tmdbResult = await checkTmdb(id, apiKey, reqConfig);
                    if (tmdbResult && tmdbResult.definitive) {
                        finalResult = tmdbResult;
                        console.log(`[Stream] Definitive state found by TMDB. Skipping Wikipedia.`);
                    } else {
                        updateFallback(tmdbResult);

                        // 4. Tier 4: Wikipedia
                        console.log(`[Stream] Firing Tier 4: Wikipedia`);
                        let wikiResult = await checkWikipedia(title, reqConfig);
                        if (wikiResult && wikiResult.definitive) {
                            finalResult = wikiResult;
                            console.log(`[Stream] Definitive state found by Wikipedia.`);
                        } else {
                            updateFallback(wikiResult);
                        }
                    }
                }
            }

            const isAggregatedError = !finalResult && !bestFallback;
            const resolvedResult = finalResult || bestFallback || { mid: false, post: false, no: false, bloopers: false, url: `https://aftercredits.com/?s=${encodeURIComponent(year ? `${title} ${year}` : title).replace(/%20/g, '+')}`, source: 'Aggregated' };

            console.log(`[Stream] Final Resolution -> Source Used: ${resolvedResult.source}`);

            const stream = {
                name: 'After-Credits Scenes',
                title: `${formatMessage(styleConfig, resolvedResult)}${styleConfig.showSource ? `\nSource: ${resolvedResult.source}` : ''}`,
                externalUrl: resolvedResult.url || `https://aftercredits.com/?s=${encodeURIComponent(year ? `${title} ${year}` : title).replace(/%20/g, '+')}`
            };

            const cacheDuration = isAggregatedError ? CACHE_TTL_ERROR : CACHE_TTL_SUCCESS;
            streamCache.set(cacheKey, { expiresAt: Date.now() + cacheDuration, stream });
            
            console.log(`[Stream] Payload generated and cached. Sequence complete.`);
            console.log(`=================================\n`);
            return res.json({ streams: [stream] });
        }
    } catch (e) { 
        if (e.name !== 'CanceledError' && e.message !== 'canceled') {
            console.error(`[Stream Error] Main Handler Failed: ${e.message}`); 
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