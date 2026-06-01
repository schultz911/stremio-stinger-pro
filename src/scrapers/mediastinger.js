const axios = require('axios');
const cheerio = require('cheerio');
const { cleanTitle, isTitleMatch, BLOOPER_REGEX } = require('../utils/strings');
const { getResultObj } = require('../utils/formatter');
const { validateUrl, sanitizeError } = require('../utils/network');
const { ENABLE_LOGGING } = require('../config');

const log = (...args) => {
    if (ENABLE_LOGGING) {
        console.log(...args);
    }
};

const RE_MS_MID_YES = /during (the )?credits\W{1,15}(yes|\d+|extra|scene|\bshots?\b)/;
const RE_MS_MID_NO = /during (the )?credits\W{1,15}no\b/;
const RE_MS_POST_YES = /after (the )?credits\W{1,15}(yes|\d+|extra|scene|\bshots?\b)/;
const RE_MS_POST_NO = /after (the )?credits\W{1,15}no\b/;
const RE_MS_LEGACY_MID_NO = /(no|zero) (extra|scene|stinger|animation|extras)[^.]{0,40}during the credits/;
const RE_MS_LEGACY_POST_NO = /(no|zero) (extra|scene|stinger|extras)[^.]{0,40}after the credits/;
const RE_MS_MID_FALLBACK = /(extra scene|stinger|animation|extra shot|shot).{0,60}during the credits/;
const RE_MS_POST_FALLBACK = /(extra scene|stinger|extra shot|shot).{0,60}after the credits/;
const RE_MS_SEO_NO = /\b(no|zero)\b/;
const RE_MS_AUDIO_1 = /\b(audio|voice|hear|heard|message|tribute|dedication|honored)\b/;
const RE_MS_AUDIO_2 = /\b(scene|scenes|shot|shots|animation|animations|video|footage|shows|we see|visual)\b/;

function parseMediaStingerSeoText(seoText) {
    let seoMid = false,
        seoPost = false,
        seoBloopers = false,
        seoNo = false,
        noStinger = false;
    if (seoText) {
        if (RE_MS_SEO_NO.test(seoText)) {
            seoNo = true;
            if (seoText.includes('during') || seoText.includes('mid')) seoMid = 'false';
            if (seoText.includes('after') || seoText.includes('post')) seoPost = 'false';
            if (
                !seoText.includes('during') &&
                !seoText.includes('mid') &&
                !seoText.includes('after') &&
                !seoText.includes('post')
            ) {
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
    let bodyMid = false,
        bodyPost = false,
        bodyBloopers = false;

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
    const cleanSearchTitle = title
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const searchUrl = `http://www.mediastinger.com/?s=${encodeURIComponent(cleanSearchTitle).replace(/%20/g, '+')}`;
    const searchRes = await axios.get(searchUrl, reqConfig);
    const $ = cheerio.load(searchRes.data);
    let potentialMatches = [];

    $('h2 a, h3 a, .entry-title a, .title a, .post-title a, ul.highlights li a').each((i, el) => {
        const $el = $(el);
        const rawLinkText = $el.text().toLowerCase().trim();
        if (!rawLinkText) return;

        if (isTitleMatch(rawLinkText, cleanedTitle)) {
            potentialMatches.push({
                url: $el.attr('href'),
                rawText: rawLinkText,
            });
            return false;
        }
    });

    if (potentialMatches.length === 0) return null;
    return potentialMatches[0];
}

async function checkMediaStinger(title, year, reqConfig) {
    log(`\n--- [MediaStinger] Execution Start: "${title}" ---`);
    try {
        const bestMatch = await searchMediaStinger(title, reqConfig);
        if (!bestMatch) {
            log(`[MediaStinger] Aborting: No match found.`);
            return null;
        }

        log(`[MediaStinger] Fetching -> ${bestMatch.url} (Text: "${bestMatch.rawText}")`);

        let hasMid = false,
            hasPost = false,
            noStinger = false,
            bloopers = false;

        if (bestMatch.url) {
            const safeUrl = validateUrl(bestMatch.url, 'http://www.mediastinger.com', 'mediastinger.com');
            if (!safeUrl) return null;
            bestMatch.url = safeUrl;

            const movieRes = await axios.get(bestMatch.url, reqConfig);
            const $$ = cheerio.load(movieRes.data);

            const seoText = $$('.groupingforseo').text().toLowerCase();
            if (seoText) {
                log(`[MediaStinger] SEO Header Found: "${seoText}"`);
            }
            const seo = parseMediaStingerSeoText(seoText);

            const contentNode = $$('.post_secwrapper').first();
            const rawHtml = contentNode.html() || '';
            const fullText = rawHtml
                .replace(/<[^>]*>/g, ' ')
                .toLowerCase()
                .replace(/\s+/g, ' ');
            const body = parseMediaStingerBodyText(fullText);

            if (
                (seo.seoMid === true || body.bodyMid) &&
                !body.midNo &&
                !body.legacyMidNo &&
                !body.midIsAudio &&
                seo.seoMid !== 'false'
            )
                hasMid = true;
            if (
                (seo.seoPost === true || body.bodyPost) &&
                !body.postNo &&
                !body.legacyPostNo &&
                !body.postIsAudio &&
                seo.seoPost !== 'false'
            )
                hasPost = true;
            if (seo.seoBloopers || body.bodyBloopers) bloopers = true;

            if (body.midNo && body.postNo) noStinger = true;
            if (body.legacyMidNo && body.legacyPostNo) noStinger = true;
            if (
                !hasMid &&
                !hasPost &&
                (fullText.includes('no extra scenes') ||
                    fullText.includes('are no extras') ||
                    fullText.includes('nothing extra'))
            )
                noStinger = true;
            if (seo.seoNo && !hasMid && !hasPost && !bloopers) noStinger = true;

            if (hasMid || hasPost || bloopers) noStinger = false;
            if (!hasMid && !hasPost && !bloopers && seoText === '') noStinger = true;
        }

        let isDefinitive = false;
        if (hasMid || hasPost || bloopers || noStinger) {
            isDefinitive = true;
        }

        log(
            `[MediaStinger] Result -> Mid: ${hasMid}, Post: ${hasPost}, Negative: ${noStinger}, Bloopers: ${bloopers}, Definitive: ${isDefinitive}`
        );
        return getResultObj(hasMid, hasPost, noStinger, bestMatch.url, 'MediaStinger', bloopers, isDefinitive);
    } catch (e) {
        if (e.name !== 'CanceledError' && e.message !== 'canceled') {
            console.error(`[MediaStinger Error] ${sanitizeError(e.message)}`);
        }
        return null;
    }
}

module.exports = {
    checkMediaStinger,
    parseMediaStingerSeoText,
};
