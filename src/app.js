const express = require('express');
const compression = require('compression');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { LRUCache } = require('lru-cache');
const { RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS } = require('./config');
const { sanitizeError } = require('./utils/network');
const { incrementRateLimit, isRedisEnabled } = require('./cache/redis');
const { manifestHandler } = require('./routes/manifest');
const { streamHandler, previewHandler } = require('./routes/stream');
const { serveConfig } = require('./routes/ui');
const { warn, error, asyncLocalStorage } = require('./utils/logger');

const app = express();

app.use(compression());
app.use(cors());

// Security Headers Middleware (Selective and Iframe-compatible for Stremio)
app.use((req, res, next) => {
    // Basic protection headers for all responses
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const isHtmlRoute = req.path === '/' || req.path === '/configure' || req.path.endsWith('/configure');

    if (isHtmlRoute) {
        res.setHeader('X-XSS-Protection', '1; mode=block');
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        // Allow the configuration UI to be loaded in an iframe by Stremio clients (frame-ancestors *)
        res.setHeader(
            'Content-Security-Policy',
            "default-src 'self'; img-src 'self' https://github.com https://raw.githubusercontent.com https://aftercredits.com https://www.themoviedb.org https://upload.wikimedia.org data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src 'self' https://fonts.gstatic.com; script-src 'self'; frame-ancestors *;"
        );
    }
    next();
});

const trustProxyVal = process.env.TRUST_PROXY || '1';
app.set(
    'trust proxy',
    trustProxyVal === 'true'
        ? true
        : trustProxyVal === 'false'
          ? false
          : isNaN(trustProxyVal)
            ? trustProxyVal
            : Number(trustProxyVal)
);

// Request Tracing Middleware
app.use((req, res, next) => {
    const reqId = crypto.randomUUID().substring(0, 8);
    asyncLocalStorage.run(reqId, () => {
        next();
    });
});

// Rate Limiting
const rateLimitMap = new LRUCache({
    max: 5000,
    ttl: RATE_LIMIT_WINDOW_MS,
    updateAgeOnGet: false, // We handle TTL manually for rate limiting windows
});

const applyLocalRateLimit = (ip, now) => {
    let clientData = rateLimitMap.get(ip);

    if (!clientData || now - clientData.startTime > RATE_LIMIT_WINDOW_MS) {
        clientData = { count: 1, startTime: now };
    } else {
        clientData.count++;
    }

    rateLimitMap.set(ip, clientData, { ttl: Math.max(1, clientData.startTime + RATE_LIMIT_WINDOW_MS - now) });

    return {
        currentCount: clientData.count,
        resetTimeRemainingMs: Math.max(0, clientData.startTime + RATE_LIMIT_WINDOW_MS - now),
    };
};

const rateLimiter = async (req, res, next) => {
    try {
        const ip = req.ip;
        if (!ip) return next();

        const now = Date.now();
        let currentCount = 0;
        let resetTimeRemainingMs = 0;

        if (isRedisEnabled()) {
            const redisKey = `ratelimit_${ip}`;
            const windowSeconds = Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);

            const result = await incrementRateLimit(redisKey, windowSeconds);
            if (result !== null) {
                currentCount = result.count;
                resetTimeRemainingMs = result.pttl;
            } else {
                const localRes = applyLocalRateLimit(ip, now);
                currentCount = localRes.currentCount;
                resetTimeRemainingMs = localRes.resetTimeRemainingMs;
            }
        } else {
            const localRes = applyLocalRateLimit(ip, now);
            currentCount = localRes.currentCount;
            resetTimeRemainingMs = localRes.resetTimeRemainingMs;
        }

        const remaining = Math.max(0, RATE_LIMIT_MAX_REQUESTS - currentCount);
        const resetTimeSec = Math.ceil((now + resetTimeRemainingMs) / 1000);

        res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX_REQUESTS);
        res.setHeader('X-RateLimit-Remaining', remaining);
        res.setHeader('X-RateLimit-Reset', resetTimeSec);

        if (currentCount > RATE_LIMIT_MAX_REQUESTS) {
            warn(`[Security] Rate limit exceeded for IP: ${sanitizeError(ip)}`);
            const retryAfterSec = Math.ceil(resetTimeRemainingMs / 1000);
            res.setHeader('Retry-After', retryAfterSec > 0 ? retryAfterSec : Math.ceil(RATE_LIMIT_WINDOW_MS / 1000));
            return res.status(429).json({ error: 'Too many requests, please try again later.' });
        }

        next();
    } catch (e) {
        error('Rate limiter error', sanitizeError(e.message || e));
        next();
    }
};

// Helper to check if a request is running locally
const isLocalRequest = (req) => {
    if (process.env.NODE_ENV === 'test') {
        return false;
    }
    const host = req.get('host') || '';
    return host.includes('localhost') || host.includes('127.0.0.1');
};

// Redirect icon/favicon to GitHub CDN with aggressive caching to eliminate egress (except during local development)
app.get(['/icon.png', '/favicon.ico', /^\/apple-touch-icon(?:-\d+x\d+)?(?:-precomposed)?\.png$/], (req, res, next) => {
    if (isLocalRequest(req)) {
        return next();
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.redirect(301, 'https://raw.githubusercontent.com/schultz911/stremio-stinger-pro/main/public/icon.png');
});

// Redirect AfterCredits logo to GitHub CDN in production
app.get('/ac.png', (req, res, next) => {
    if (isLocalRequest(req)) {
        return next();
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.redirect(301, 'https://raw.githubusercontent.com/schultz911/stremio-stinger-pro/main/public/ac.png');
});

// Redirect style.css to jsDelivr CDN in production to bypass MIME sniff issues with RawGitHub
app.get('/css/style.css', (req, res, next) => {
    if (isLocalRequest(req)) {
        return next();
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.redirect(301, 'https://cdn.jsdelivr.net/gh/schultz911/stremio-stinger-pro@main/public/css/style.css');
});

// Static files
app.use(express.static(path.join(__dirname, '../public'), { maxAge: '1d', etag: true, lastModified: true }));

// Routes
app.get('/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
        status: 'ok',
        uptime: process.uptime(),
        redisConnected: isRedisEnabled(),
    });
});
app.get('/', serveConfig);
app.get('/configure', serveConfig);
app.get('/:p1/configure', serveConfig);
app.get('/:style/:apiKey/configure', serveConfig);

app.get('/manifest.json', manifestHandler);
app.get('/:p1/manifest.json', manifestHandler);
app.get('/:style/:apiKey/manifest.json', manifestHandler);

app.get('/stream/:type/:id.json', rateLimiter, streamHandler);
app.get('/:p1/stream/:type/:id.json', rateLimiter, streamHandler);
app.get('/:style/:apiKey/stream/:type/:id.json', rateLimiter, streamHandler);
app.get('/preview/:id', rateLimiter, previewHandler);

// Redirect truncated configuration paths to configure page instead of 404
app.get('/:p1', (req, res, next) => {
    const p1 = req.params.p1;
    if (p1.includes('.') || ['health', 'configure'].includes(p1)) {
        return next();
    }
    // Validate that p1 contains only alphanumeric characters, hyphens, and underscores to prevent Open Redirect
    if (!/^[a-z0-9-_]+$/i.test(p1)) {
        return next();
    }
    res.redirect(`/${p1}/configure`);
});

app.get('/:style/:apiKey', (req, res, next) => {
    const { style, apiKey } = req.params;
    if (apiKey && /^[a-f0-9]{32}$/i.test(apiKey)) {
        // Validate that style contains only alphanumeric characters, hyphens, and underscores to prevent Open Redirect
        if (/^[a-z0-9-_]+$/i.test(style)) {
            return res.redirect(`/${style}/${apiKey}/configure`);
        }
    }
    next();
});

// Global Error Boundary
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    error(`[System Error] ${sanitizeError(err.message)}`, err.stack ? `\nStack: ${sanitizeError(err.stack)}` : '');

    // Add Retry-After for upstream timeouts or rate limits bubbling up
    if (err.message && (err.message.includes('timeout') || err.message.includes('ETIMEDOUT'))) {
        res.setHeader('Retry-After', 30);
        return res.status(504).json({ error: 'Gateway Timeout', message: 'Upstream request timed out.' });
    }

    res.status(500).json({ error: 'Internal Server Error', message: 'An unexpected error occurred.' });
});

module.exports = app;
