// Pre-compiled regexes
const RE_HTML_TAGS = /<[^>]*>?/gm;

const RE_YEAR = /\(\d{4}\)/g;
const RE_ARTICLE_START = /^(the|a|an)\s+/i;
const RE_WIKI_ARTICLE_END = /,\s*(the|a|an)$/i;
const RE_WIKI_PARENS = /\s*\([^)]*\)\s*/g;
const RE_WIKI_NON_ALNUM = /[^a-z0-9]/g;
const RE_FOUR_DIGITS = /^\d{4}$/;
const RE_WIKI_BRACKETS = /\s*\[[^\]]*\]\s*/g;

const BLOOPER_REGEX = /\b(bloopers?|outtakes?|gags?|gag reel|behind-the-scenes)\b/;
const NEGATIVE_REGEX = /(no extra|no stinger|nothing|are no|no scene)/;
const STINGER_EXCEPTION_REGEX = /(extra shot|audio|voice|laugh|but|however)/;
const AC_BLOOPER_TAGS = new Set(['outtake', 'musical', 'blooper', 'humorous credit']);
const AUDIO_ONLY_REGEX =
    /\b(audio-only|audio stinger|audio cue|audio clip|voice-over only|voice only|dialogue only|only audio|only hear|sound of|clanging sound)\b/;

const safeTokens = new Set([
    'blooper',
    'bloopers',
    'outtake',
    'outtakes',
    'extra',
    'extras',
    'and',
    'or',
    'with',
    'scene',
    'scenes',
    'credit',
    'credits',
    'stinger',
    'stingers',
    'review',
    'reviews',
    'post',
    'mid',
    'after',
    'end',
    'during',
    'the',
    'is',
    'a',
    'an',
    'there',
    'are',
    'movie',
    'film',
]);

const normalizeDiacritics = (str) => {
    if (!str) return '';
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
};

const cleanTitle = (str) => {
    if (!str) return '';
    const normalized = normalizeDiacritics(str);
    let i = 0;
    let len = normalized.length;
    let wordStart = -1;
    let words = [];

    for (; i < len; i++) {
        let code = normalized.charCodeAt(i);
        if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95) {
            if (wordStart === -1) wordStart = i;
        } else {
            if (wordStart !== -1) {
                words.push(normalized.substring(wordStart, i));
                wordStart = -1;
            }
        }
    }
    if (wordStart !== -1) {
        words.push(normalized.substring(wordStart, len));
    }

    if (words.length === 0) return '';

    let start = 0;
    let end = words.length - 1;

    if (words.length > 1) {
        let first = words[0].toLowerCase();
        if (first === 'the' || first === 'a' || first === 'an') {
            start = 1;
        }
    }

    if (end > start) {
        let last = words[end].toLowerCase();
        if (last === 'the' || last === 'a' || last === 'an') {
            end--;
        }
    }

    return words.slice(start, end + 1).join(' ');
};

const isSafeSuffix = (str) => {
    if (!str) return false;

    const trimmed = str.trim();
    if (!trimmed) return true;

    const words = trimmed.split(/\s+/);
    for (const word of words) {
        if (!safeTokens.has(word) && !RE_FOUR_DIGITS.test(word)) {
            return false;
        }
    }
    return true;
};

const isTitleMatch = (linkText, cleanedTargetTitle) => {
    let rawNoYear = linkText.toLowerCase().replace(RE_YEAR, '').trim();
    let tLink = cleanTitle(rawNoYear);

    if (tLink === cleanedTargetTitle) return true;

    if (cleanedTargetTitle.length > 0 && tLink.startsWith(cleanedTargetTitle)) {
        const remainder = tLink.substring(cleanedTargetTitle.length).trim();
        if (isSafeSuffix(remainder)) return true;

        let originalStripped = rawNoYear.replace(RE_ARTICLE_START, '').trim();
        if (
            originalStripped.startsWith(cleanedTargetTitle + ':') ||
            originalStripped.startsWith(cleanedTargetTitle + ' :')
        ) {
            return true;
        }
    }

    if (tLink.length > 0 && cleanedTargetTitle.startsWith(tLink)) {
        const remainder = cleanedTargetTitle.substring(tLink.length).trim();
        if (isSafeSuffix(remainder)) return true;
    }

    return false;
};

const wikiNormalize = (title) => {
    return title
        .toLowerCase()
        .replace(RE_WIKI_BRACKETS, '')
        .replace(RE_ARTICLE_START, '')
        .replace(RE_WIKI_ARTICLE_END, '')
        .replace(RE_WIKI_PARENS, '')
        .replace(RE_WIKI_NON_ALNUM, '')
        .trim();
};

const HTML_ENTITIES = {
    amp: '&',
    quot: '"',
    lt: '<',
    gt: '>',
    nbsp: ' ',
};

const RE_ENTITY = /&(#(?:x[0-9a-fA-F]+|[0-9]+)|[a-zA-Z]+);/g;

const decodeHtmlString = (html) => {
    if (!html) return '';
    let text = html.replace(RE_HTML_TAGS, '');
    if (text.indexOf('&') === -1) return text;

    return text.replace(RE_ENTITY, (match, entity) => {
        if (entity[0] === '#') {
            const isHex = entity[1] === 'x' || entity[1] === 'X';
            const numStr = entity.substring(isHex ? 2 : 1);
            const num = parseInt(numStr, isHex ? 16 : 10);
            return isNaN(num) ? match : String.fromCharCode(num);
        }
        return HTML_ENTITIES[entity] || match;
    });
};

module.exports = {
    decodeHtmlString,
    cleanTitle,
    isTitleMatch,
    wikiNormalize,
    BLOOPER_REGEX,
    NEGATIVE_REGEX,
    STINGER_EXCEPTION_REGEX,
    AC_BLOOPER_TAGS,
    AUDIO_ONLY_REGEX,
};
