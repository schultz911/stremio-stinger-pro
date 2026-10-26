const net = require('net');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseCommand(buffer) {
    const end = buffer.indexOf('\r\n');
    if (end < 0) return null;
    const count = Number(buffer.subarray(1, end));
    let offset = end + 2;
    const args = [];
    for (let i = 0; i < count; i++) {
        const lineEnd = buffer.indexOf('\r\n', offset);
        if (lineEnd < 0) return null;
        const length = Number(buffer.subarray(offset + 1, lineEnd));
        offset = lineEnd + 2;
        if (buffer.length < offset + length + 2) return null;
        args.push(buffer.subarray(offset, offset + length).toString());
        offset += length + 2;
    }
    return { args, bytes: offset };
}

it('bounds real client pending work, closes a stalled socket, and reconnects after cooldown', async () => {
    const sockets = new Set();
    let stalled = false;
    let unanswered = 0;
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', (err) => {
            // Resetting a stalled client intentionally closes pending server writes.
            if (err.code !== 'ECONNRESET') throw err;
        });
        let buffer = Buffer.alloc(0);
        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            for (;;) {
                const command = parseCommand(buffer);
                if (!command) break;
                buffer = buffer.subarray(command.bytes);
                if (stalled) { unanswered++; continue; }
                const name = command.args[0];
                if (name === 'GET') socket.write('$15\r\n{"cached":true}\r\n');
                else if (name === 'SCRIPT') socket.write('$3\r\nsha\r\n');
                else if (name === 'EVALSHA' || name === 'EVAL') socket.write('*2\r\n:3\r\n:58000\r\n');
                else socket.write('+OK\r\n');
            }
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const previous = { NODE_ENV: process.env.NODE_ENV, REDIS_URL: process.env.REDIS_URL, ENABLE_LOGGING: process.env.ENABLE_LOGGING };
    process.env.NODE_ENV = 'production';
    process.env.ENABLE_LOGGING = 'false';
    process.env.REDIS_URL = `redis://127.0.0.1:${server.address().port}`;
    jest.resetModules();
    const redis = require('../src/cache/redis');
    try {
        for (let i = 0; i < 150 && !redis.isRedisEnabled(); i++) await delay(20);
        expect(redis.isRedisEnabled()).toBe(true);
        await delay(30);
        await expect(redis.getCache('healthy')).resolves.toEqual({ cached: true });
        await expect(redis.incrementRateLimit('ip', 60)).resolves.toEqual({ count: 3, pttl: 58000 });

        stalled = true;
        const results = await Promise.all(Array.from({ length: 300 }, (_, i) => redis.getCache(`stall_${i}`)));
        expect(results.every((result) => result === null)).toBe(true);
        expect(unanswered).toBeGreaterThan(0);
        expect(unanswered).toBeLessThanOrEqual(128);
        expect(redis.isRedisEnabled()).toBe(false);
        const count = unanswered;
        await Promise.all(Array.from({ length: 100 }, () => redis.getCache('cooldown')));
        expect(unanswered).toBe(count);
        for (let i = 0; i < 50 && sockets.size; i++) await delay(10);
        expect(sockets.size).toBe(0);

        stalled = false;
        for (let i = 0; i < 325 && !redis.isRedisEnabled(); i++) await delay(20);
        expect(redis.isRedisEnabled()).toBe(true);
        await expect(redis.getCache('recovered')).resolves.toEqual({ cached: true });
    } finally {
        await redis.quitRedis();
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}, 15000);
