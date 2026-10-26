const { EventEmitter } = require('events');

const originalEnvironment = { NODE_ENV: process.env.NODE_ENV, REDIS_URL: process.env.REDIS_URL };

async function harness({ ready = true } = {}) {
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.REDIS_URL = 'redis://test.invalid';
    const clients = [];
    const createClient = jest.fn((options) => {
        const client = new EventEmitter();
        client.options = options;
        client.isOpen = false;
        client.isReady = false;
        client.get = jest.fn().mockResolvedValue('{"cached":true}');
        client.setEx = jest.fn().mockResolvedValue('OK');
        client.sendCommand = jest.fn().mockResolvedValue('sha');
        client.eval = jest.fn().mockResolvedValue([2, 59000]);
        client.connect = jest.fn(async () => {
            client.isOpen = true;
            client.isReady = ready;
            if (ready) client.emit('ready');
            return client;
        });
        client.destroy = jest.fn(() => { client.isOpen = false; client.isReady = false; });
        clients.push(client);
        return client;
    });
    jest.doMock('redis', () => ({ createClient }));
    jest.doMock('../src/utils/network', () => ({ sanitizeError: String }));
    jest.doMock('../src/utils/logger', () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const redis = require('../src/cache/redis');
    await jest.advanceTimersByTimeAsync(0);
    return { redis, clients, createClient };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
    jest.useRealTimers();
    for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

it('bounds queues, disables offline replay, and preserves healthy values, TTLs and counters', async () => {
    const { redis, clients } = await harness();
    const client = clients[0];
    expect(client.options.disableOfflineQueue).toBe(true);
    expect(client.options.commandsQueueMaxLength).toBe(128);
    await expect(redis.getCache('entry')).resolves.toEqual({ cached: true });
    await redis.setCache('entry', { cached: true }, 60);
    expect(client.setEx).toHaveBeenCalledWith('entry', 60, '{"cached":true}');
    client.sendCommand.mockResolvedValueOnce([3, 58000]);
    await expect(redis.incrementRateLimit('ip', 60)).resolves.toEqual({ count: 3, pttl: 58000 });
    expect(client.sendCommand).toHaveBeenLastCalledWith(['EVALSHA', 'sha', '1', 'ip', '60']);
    await redis.quitRedis();
    expect(jest.getTimerCount()).toBe(0);
});

it('fails immediately while connecting or reconnecting without enqueuing commands', async () => {
    const { redis, clients } = await harness({ ready: false });
    await expect(redis.getCache('entry')).resolves.toBeNull();
    await expect(redis.incrementRateLimit('ip', 60)).resolves.toBeNull();
    await redis.setCache('entry', {}, 60);
    expect(clients[0].get).not.toHaveBeenCalled();
    expect(clients[0].setEx).not.toHaveBeenCalled();
    expect(redis.isRedisEnabled()).toBe(false);
    await redis.quitRedis();
});

it('destroys a stalled socket, skips commands during cooldown, then recovers on a new client', async () => {
    const { redis, clients } = await harness();
    clients[0].get.mockImplementation(() => new Promise(() => {}));
    const pending = redis.getCache('stall');
    await jest.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBeNull();
    expect(clients[0].destroy).toHaveBeenCalledTimes(1);
    expect(redis.isRedisEnabled()).toBe(false);
    await expect(redis.getCache('cooldown')).resolves.toBeNull();
    await expect(redis.incrementRateLimit('cooldown', 60)).resolves.toBeNull();
    expect(clients[0].get).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5000);
    expect(clients).toHaveLength(2);
    expect(redis.isRedisEnabled()).toBe(true);
    await expect(redis.getCache('recovered')).resolves.toEqual({ cached: true });
    await redis.quitRedis();
    expect(jest.getTimerCount()).toBe(0);
});

it('preserves EVAL fallback after NOSCRIPT without resetting a healthy connection', async () => {
    const { redis, clients } = await harness();
    clients[0].sendCommand.mockRejectedValueOnce(new Error('NOSCRIPT No matching script'));
    await expect(redis.incrementRateLimit('ip', 60)).resolves.toBeNull();
    await expect(redis.incrementRateLimit('ip', 60)).resolves.toEqual({ count: 2, pttl: 59000 });
    expect(clients[0].eval).toHaveBeenCalledWith(expect.any(String), { keys: ['ip'], arguments: ['60'] });
    expect(clients[0].destroy).not.toHaveBeenCalled();
    await redis.quitRedis();
});

it('does not discard healthy in-flight work on queue saturation or invalid cached JSON', async () => {
    const { redis, clients } = await harness();
    clients[0].get.mockRejectedValueOnce(new Error('The queue is full')).mockResolvedValueOnce('invalid json');
    await expect(redis.getCache('full')).resolves.toBeNull();
    await expect(redis.getCache('malformed')).resolves.toBeNull();
    expect(redis.isRedisEnabled()).toBe(true);
    expect(clients[0].destroy).not.toHaveBeenCalled();
    await redis.quitRedis();
});

it('cancels recovery on shutdown and handles refused transports with local fallback', async () => {
    const { redis, clients } = await harness();
    clients[0].get.mockRejectedValueOnce(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    await expect(redis.getCache('refused')).resolves.toBeNull();
    await redis.quitRedis();
    await jest.advanceTimersByTimeAsync(10000);
    expect(clients).toHaveLength(1);
    expect(redis.isRedisEnabled()).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
});
