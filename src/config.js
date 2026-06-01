const http = require('http');
const https = require('https');

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 60; // 60 requests per minute

const DEFAULT_TMDB_KEY = process.env.TMDB_API_KEY || '';
const WIKI_TTL = 24 * 60 * 60 * 1000;
const CACHE_TTL_SUCCESS = 30 * 60 * 1000;
const CACHE_TTL_ERROR = 60 * 1000;
const MAX_CACHE_SIZE = 5000;

const CINEMETA_TIMEOUT = 2000; // 2 seconds
const SCRAPER_TIMEOUT = 20000; // 20 seconds
const ENABLE_LOGGING = process.env.ENABLE_LOGGING !== 'false';

// Centralized Axios config with Keep-Alive for low latency
const axiosConfig = {
    headers: {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    timeout: 10000,
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true }),
};

module.exports = {
    RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_MAX_REQUESTS,
    DEFAULT_TMDB_KEY,
    WIKI_TTL,
    CACHE_TTL_SUCCESS,
    CACHE_TTL_ERROR,
    MAX_CACHE_SIZE,
    axiosConfig,
    CINEMETA_TIMEOUT,
    SCRAPER_TIMEOUT,
    ENABLE_LOGGING,
};
