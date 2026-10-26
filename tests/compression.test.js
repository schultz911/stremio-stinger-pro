const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const express = require('express');
const compression = require('compression');

it('releases native gzip resources after aborted responses and preserves successful content', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(zlib, 'createGzip');
    const streams = [];
    Object.defineProperty(zlib, 'createGzip', {
        ...descriptor,
        value: (...args) => {
            const stream = descriptor.value(...args);
            streams.push(stream);
            return stream;
        },
    });
    const payload = crypto.randomBytes(128 * 1024);
    let closed = 0;
    const app = express();
    app.use(compression());
    app.get('/abort', (req, res) => {
        res.type('text/plain');
        const interval = setInterval(() => res.write(payload), 5);
        res.once('close', () => { clearInterval(interval); closed++; });
    });
    app.get('/success', (req, res) => res.type('text/plain').send(payload));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const options = { hostname: '127.0.0.1', port: server.address().port, headers: { 'Accept-Encoding': 'gzip' } };
    try {
        for (let i = 0; i < 10; i++) {
            await new Promise((resolve, reject) => {
                const request = http.get({ ...options, path: '/abort' }, (res) => {
                    res.once('data', () => { request.destroy(); resolve(); });
                    res.on('error', () => {});
                });
                request.on('error', reject);
            });
        }
        for (let i = 0; i < 100 && closed < 10; i++) await new Promise((resolve) => setTimeout(resolve, 10));
        expect(closed).toBe(10);
        expect(streams).toHaveLength(10);
        expect(streams.every((stream) => stream.destroyed && !stream._handle)).toBe(true);

        const compressed = await new Promise((resolve, reject) => {
            http.get({ ...options, path: '/success' }, (res) => {
                expect(res.headers['content-encoding']).toBe('gzip');
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            }).on('error', reject);
        });
        expect(zlib.gunzipSync(compressed).equals(payload)).toBe(true);
    } finally {
        for (const stream of streams) stream.destroy();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        Object.defineProperty(zlib, 'createGzip', descriptor);
    }
});
