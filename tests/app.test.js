const request = require('supertest');
const app = require('../src/app');
const { quitRedis } = require('../src/cache/redis');

describe('Stremio Stinger Pro E2E', () => {
    afterAll(async () => {
        await quitRedis();
    });
    it('should return manifest.json', async () => {
        const res = await request(app).get('/manifest.json');
        expect(res.statusCode).toEqual(200);
        expect(res.body.id).toEqual('org.stinger.pro');
        expect(res.body.resources).toContain('stream');
    });

    it('should serve configure page for different route styles', async () => {
        const res1 = await request(app).get('/configure');
        expect(res1.statusCode).toEqual(200);
        expect(res1.headers['content-type']).toContain('html');

        const res2 = await request(app).get('/colorful/configure');
        expect(res2.statusCode).toEqual(200);
        expect(res2.headers['content-type']).toContain('html');

        const res3 = await request(app).get('/colorful/0287deb172a88d5d62c2ed82e863f4ee/configure');
        expect(res3.statusCode).toEqual(200);
        expect(res3.headers['content-type']).toContain('html');
    });

    it('should redirect apple-touch-icons and favicon to GitHub CDN', async () => {
        const res1 = await request(app).get('/apple-touch-icon.png');
        expect(res1.statusCode).toEqual(301);
        expect(res1.headers['location']).toEqual('https://raw.githubusercontent.com/schultz911/stremio-stinger-pro/main/public/icon.png');

        const res2 = await request(app).get('/apple-touch-icon-precomposed.png');
        expect(res2.statusCode).toEqual(301);
        expect(res2.headers['location']).toEqual('https://raw.githubusercontent.com/schultz911/stremio-stinger-pro/main/public/icon.png');

        const res3 = await request(app).get('/apple-touch-icon-120x120.png');
        expect(res3.statusCode).toEqual(301);
        expect(res3.headers['location']).toEqual('https://raw.githubusercontent.com/schultz911/stremio-stinger-pro/main/public/icon.png');

        const res4 = await request(app).get('/apple-touch-icon-120x120-precomposed.png');
        expect(res4.statusCode).toEqual(301);
        expect(res4.headers['location']).toEqual('https://raw.githubusercontent.com/schultz911/stremio-stinger-pro/main/public/icon.png');
    });

    it('should redirect base configuration routes to their configure endpoints', async () => {
        const res1 = await request(app).get('/colorful');
        expect(res1.statusCode).toEqual(302);
        expect(res1.headers['location']).toEqual('/colorful/configure');

        const res2 = await request(app).get('/colorful/0287deb172a88d5d62c2ed82e863f4ee');
        expect(res2.statusCode).toEqual(302);
        expect(res2.headers['location']).toEqual('/colorful/0287deb172a88d5d62c2ed82e863f4ee/configure');
    });

    it('should serve robots.txt', async () => {
        const res1 = await request(app).get('/robots.txt');
        expect(res1.statusCode).toEqual(200);
        expect(res1.text).toContain('User-agent: *');
    });

    it('should return empty streams for non-movie type', async () => {
        const res = await request(app).get('/stream/series/tt0848228.json');
        expect(res.statusCode).toEqual(200);
        expect(res.body.streams).toEqual([]);
    });

    it('should return empty streams for invalid id', async () => {
        const res = await request(app).get('/stream/movie/invalid.json');
        expect(res.statusCode).toEqual(200);
        expect(res.body.streams).toEqual([]);
    });

    it('should cache negative metadata lookup for non-existent IMDb ID', async () => {
        const start1 = Date.now();
        const res1 = await request(app).get('/stream/movie/tt0000000.json');
        const duration1 = Date.now() - start1;
        expect(res1.statusCode).toEqual(200);
        expect(res1.body.streams).toEqual([]);

        const start2 = Date.now();
        const res2 = await request(app).get('/stream/movie/tt0000000.json');
        const duration2 = Date.now() - start2;
        expect(res2.statusCode).toEqual(200);
        expect(res2.body.streams).toEqual([]);

        // The second request should be significantly faster (under 150ms) due to negative caching.
        expect(duration2).toBeLessThan(150);
    });

    // Mocks for external APIs should ideally be added here.
    // For this e2e test, we're simply verifying that the endpoint works without crashing.
    it('should return stream data for a valid movie (The Avengers)', async () => {
        // Warning: This hits external APIs. In a true CI/CD pipeline, we would mock axios or nock these requests.
        const res = await request(app).get('/stream/movie/tt0848228.json');
        expect(res.statusCode).toEqual(200);
        expect(res.body).toHaveProperty('streams');
        expect(Array.isArray(res.body.streams)).toBe(true);
        if (res.body.streams.length > 0) {
            expect(res.body.streams[0]).toHaveProperty('name', 'After-Credits Scenes');
            expect(res.body.streams[0]).toHaveProperty('title');
        }
    }, 30000);

    it('should handle concurrent requests for the same movie (request coalescing / singleflight)', async () => {
        const [res1, res2] = await Promise.all([
            request(app).get('/stream/movie/tt0120737.json'), // Lord of the Rings: Fellowship of the Ring
            request(app).get('/stream/movie/tt0120737.json'),
        ]);

        expect(res1.statusCode).toEqual(200);
        expect(res2.statusCode).toEqual(200);
        expect(res1.body).toHaveProperty('streams');
        expect(res2.body).toHaveProperty('streams');
        expect(res1.body.streams).toEqual(res2.body.streams);
    }, 30000);

    it('should return preview data for a movie name lookup (The Avengers)', async () => {
        const res = await request(app).get('/preview/The%20Avengers');
        expect(res.statusCode).toEqual(200);
        expect(res.body).toHaveProperty('title');
        expect(res.body.title.toLowerCase()).toContain('avengers');
        expect(res.body).toHaveProperty('mid');
        expect(res.body).toHaveProperty('post');
    }, 30000);

    describe('Security and Optimization Improvements', () => {
        it('should prevent open redirects on unsafe /:p1 route', async () => {
            const res = await request(app).get('/%2f%2fevil.com');
            expect(res.statusCode).not.toEqual(302);
            if (res.statusCode === 302) {
                expect(res.headers.location).not.toContain('evil.com');
            }
        });

        it('should prevent open redirects on unsafe /:style/:apiKey route', async () => {
            const res = await request(app).get('/%2f%2fevil.com/0287deb172a88d5d62c2ed82e863f4ee');
            expect(res.statusCode).not.toEqual(302);
            if (res.statusCode === 302) {
                expect(res.headers.location).not.toContain('evil.com');
            }
        });

        it('should correctly format cleanTitle using optimized join', () => {
            const { cleanTitle } = require('../src/utils/strings');
            expect(cleanTitle('The Avengers (2012)')).toEqual('Avengers 2012');
            expect(cleanTitle('Iron Man 3')).toEqual('Iron Man 3');
            expect(cleanTitle('A Quiet Place')).toEqual('Quiet Place');
        });
    });
});
