const { createClient } = require('redis');
const { sanitizeError } = require('../utils/network');
const { log, warn, error } = require('../utils/logger');

const COMMAND_TIMEOUT_MS = 500;
const FAILURE_COOLDOWN_MS = 5000;
const COMMAND_QUEUE_LIMIT = 128;
let redisClient;
let useRedis = false;
let recoveryTimer;
let stopping = false;

const luaScript = `
    local current = redis.call('INCR', KEYS[1])
    local pttl = redis.call('PTTL', KEYS[1])
    if pttl < 0 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
        pttl = tonumber(ARGV[1]) * 1000
    end
    return {current, pttl}
`;
let rateLimitSha = null;

const isRedisEnabled = () => !stopping && useRedis && !!redisClient?.isReady;

const withTimeout = async (promise, timeoutMs = COMMAND_TIMEOUT_MS) => {
    let timeoutId;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('Redis operation timed out')), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timeoutId);
    }
};

const suspendClient = (client) => {
    if (stopping || client !== redisClient || recoveryTimer) return;
    useRedis = false;
    rateLimitSha = null;
    // Reset the whole connection: timed-out commands may have been written, so
    // dropping individual replies would break RESP ordering and retain work.
    if (client.isOpen) client.destroy();
    recoveryTimer = setTimeout(() => {
        recoveryTimer = undefined;
        if (!stopping) connectRedis();
    }, FAILURE_COOLDOWN_MS);
    recoveryTimer.unref();
};

const runCommand = async (operation) => {
    if (!isRedisEnabled()) return null;
    const client = redisClient;
    try {
        return await withTimeout(operation(client));
    } catch (e) {
        // Redis command errors (including NOSCRIPT, ACL errors and a full queue)
        // do not imply a dead connection. Reset only transport failures/timeouts.
        if (
            e.message === 'Redis operation timed out' ||
            !client.isReady ||
            ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'].includes(e.code)
        ) suspendClient(client);
        throw e;
    }
};

function connectRedis() {
    const client = createClient({
        url: process.env.REDIS_URL,
        disableOfflineQueue: true,
        commandsQueueMaxLength: COMMAND_QUEUE_LIMIT,
        socket: {
            connectTimeout: 5000,
            reconnectStrategy: (retries) => {
                if (retries > 10) {
                    warn('[System] Redis reconnect limits reached. Falling back to memory cache entirely.');
                    useRedis = false;
                    return new Error('Redis reconnect limits reached');
                }
                return Math.min(retries * 50, 2000);
            },
        },
    });
    redisClient = client;
    client.on('error', (err) => {
        if (client.isOpen) error('Redis Client Error', sanitizeError(err.message || err));
    });
    client.on('ready', () => {
        if (stopping || client !== redisClient) return;
        useRedis = true;
        rateLimitSha = null;
        log('[System] Redis distributed cache connected.');
        runCommand((activeClient) => activeClient.sendCommand(['SCRIPT', 'LOAD', luaScript]))
            .then((sha) => {
                if (client === redisClient && isRedisEnabled()) rateLimitSha = sha;
            })
            .catch((e) => warn('[System] Failed to load Redis rate limit script', sanitizeError(e.message || e)));
    });
    client.connect().catch((err) => error('Failed to connect to Redis', sanitizeError(err.message || err)));
}

const getCache = async (key) => {
    try {
        const data = await runCommand((client) => client.get(key));
        return data ? JSON.parse(data) : null;
    } catch (e) {
        error('Redis get error', sanitizeError(e.message || e));
        return null;
    }
};

const setCache = async (key, value, ttlSeconds) => {
    if (!isRedisEnabled()) return;
    try {
        await runCommand((client) => client.setEx(key, ttlSeconds, JSON.stringify(value)));
    } catch (e) {
        error('Redis set error', sanitizeError(e.message || e));
    }
};

const quitRedis = async () => {
    stopping = true;
    clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
    useRedis = false;
    if (redisClient?.isOpen) redisClient.destroy();
    log('[System] Redis client disconnected.');
};

const incrementRateLimit = async (key, ttlSeconds) => {
    try {
        const results = await runCommand((client) =>
            rateLimitSha
                ? client.sendCommand(['EVALSHA', rateLimitSha, '1', key, String(ttlSeconds)])
                : client.eval(luaScript, { keys: [key], arguments: [String(ttlSeconds)] })
        );
        return results === null ? null : { count: results[0], pttl: results[1] };
    } catch (e) {
        if (e.message?.includes('NOSCRIPT')) {
            rateLimitSha = null;
            warn('Redis NOSCRIPT error, clearing SHA cache to reload next time');
        } else {
            error('Redis incr error', sanitizeError(e.message || e));
        }
        return null;
    }
};

if (process.env.REDIS_URL && process.env.NODE_ENV !== 'test') connectRedis();

module.exports = { getCache, setCache, isRedisEnabled, quitRedis, incrementRateLimit };
