const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const styles = ['colorful', 'simple', 'monochrome'].flatMap((style) =>
    [style, `${style}-bloopers`, `${style}-sequel`, `${style}-bloopers-sequel`]
);
const response = () => ({ setHeader() {}, status() { return this; }, json(body) { this.body = body; return this; } });

function harness({ relatedGate, lateAfterCredits = false, failRelated = false, failSources = false } = {}) {
    jest.resetModules();
    jest.doMock('../src/config', () => ({ ...jest.requireActual('../src/config'), DEFAULT_TMDB_KEY: 'a'.repeat(32) }));
    jest.doMock('../src/utils/logger', () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const get = jest.fn(async (url, options = {}) => {
        const u = new URL(url);
        await delay(5);
        if (failSources && (u.hostname === 'aftercredits.com' || u.hostname === 'en.wikipedia.org' || u.pathname.endsWith('/keywords'))) throw new Error('upstream failed');
        if (options.signal?.aborted) throw Object.assign(new Error('canceled'), { __CANCEL__: true });
        if (u.pathname.includes('/meta/movie/')) return { data: { meta: { name: 'Audit Movie', year: 2020, moviedb_id: 123 } } };
        if (u.pathname.includes('/find/')) return { data: { movie_results: [{ title: 'Audit Movie', release_date: '2020-01-01', id: 123 }] } };
        if (u.pathname === '/wp-json/wp/v2/posts') return { data: [{ id: 1, title: { rendered: 'Audit Movie (2020)' }, link: 'https://aftercredits.com/audit' }] };
        if (u.pathname === '/wp-json/wp/v2/posts/1') {
            if (lateAfterCredits) await delay(30);
            return { data: { content: { rendered: '<div></div>' }, _embedded: { 'wp:term': [[{ name: lateAfterCredits ? 'Both During & After Credits' : 'After Credits' }]] } } };
        }
        if (u.pathname.endsWith('/keywords')) return { data: { keywords: [{ name: 'aftercreditsstinger', id: 1 }] } };
        if (u.hostname === 'en.wikipedia.org') return { data: { parse: { text: { '*': '<table class="wikitable"><tr><td><i>Audit Movie</i></td><td>after the credits</td></tr></table>' } } } };
        if (u.hostname === 'basedon.media') {
            if (relatedGate) await relatedGate;
            if (failRelated) throw new Error('related source failed');
            return { data: { streams: [{ title: 'Based on novel:\nAudit Book' }] } };
        }
        if (u.pathname === '/3/movie/123') return { data: { id: 123, keywords: { keywords: [] } } };
        if (u.pathname === '/3/search/movie') return { data: { results: [{ id: 123 }] } };
        if (u.pathname === '/3/movie/123/external_ids') return { data: { imdb_id: 'tt9900001' } };
        throw new Error(`Unmapped fixture ${u.pathname}`);
    });
    jest.doMock('../src/utils/network', () => ({ ...jest.requireActual('../src/utils/network'), axiosInstance: { get } }));
    const routes = require('../src/routes/stream');
    const caches = require('../src/cache/memory');
    const stream = async (style, apiKey, id = 'tt9900001') => {
        const res = response();
        await routes.streamHandler({ params: { type: 'movie', id, style, apiKey } }, res);
        return res.body;
    };
    const preview = async (id = 'tt9900001') => {
        const res = response();
        await routes.previewHandler({ params: { id }, query: {} }, res);
        return res.body;
    };
    return { get, stream, preview, caches };
}

afterEach(async () => { await delay(80); });

it('shares cold acquisition across 12 display styles while formatting each payload separately', async () => {
    const { get, stream } = harness();
    const results = await Promise.all(styles.map((style) => stream(style)));
    await delay(30);
    expect(get).toHaveBeenCalledTimes(6); // Five movie calls plus one cold Wikipedia index.
    expect(results[0].streams[0].title).toBe('🎬 Post-Credits Scene');
    expect(results[4].streams[0].title).toBe('Post Only');
    expect(results[8].streams[0].title).toBe('⤵︎ Post-Credits Scene');
    const count = get.mock.calls.length;
    await stream('simple-nosource');
    expect(get).toHaveBeenCalledTimes(count);
});

it('shares preview acquisition and optional related data across concurrent previews', async () => {
    const { get, preview } = harness();
    const results = await Promise.all(Array.from({ length: 12 }, () => preview()));
    await delay(30);
    expect(get).toHaveBeenCalledTimes(8); // Seven movie calls plus one index fetch.
    expect(results.every((result) => result.title === 'Audit Movie')).toBe(true);
    expect(results.every((result) => result.relatedData.sourceMaterial === 'Audit Book (Novel)')).toBe(true);
});

it('shares movie-name preview searches too', async () => {
    const { get, preview } = harness();
    await Promise.all(Array.from({ length: 12 }, () => preview('Audit Movie')));
    expect(get.mock.calls.filter(([url]) => url.includes('/search/movie'))).toHaveLength(1);
    expect(get.mock.calls.filter(([url]) => url.includes('/external_ids'))).toHaveLength(1);
});

it('does not make basic requests wait for optional related data or lose late cache enrichment', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { stream, caches } = harness({ relatedGate: gate, lateAfterCredits: true });
    const related = stream('simple-related');
    try {
        const basic = await stream('colorful');
        expect(basic.streams).toHaveLength(1);
        await delay(60);
        release();
        expect((await related).streams).toHaveLength(2);
        await delay(30);
        const raw = caches.rawScraperCache.get('tt9900001');
        expect(raw.finalResult.mid).toBe(true);
        expect(raw.relatedData.sourceMaterial).toBe('Audit Book (Novel)');
    } finally { release(); await related; }
});

it('keeps pending credential-dependent requests separate for different API keys', async () => {
    const { get, stream } = harness();
    await Promise.all([stream('simple', 'b'.repeat(32)), stream('simple', 'c'.repeat(32))]);
    const keywordCalls = get.mock.calls.filter(([url]) => url.includes('/keywords'));
    expect(keywordCalls).toHaveLength(2);
    expect(new Set(keywordCalls.map(([url]) => new URL(url).searchParams.get('api_key'))).size).toBe(2);
});

it('returns the existing fallback shape when all stinger sources fail', async () => {
    const { stream } = harness({ failSources: true });
    const results = await Promise.all(styles.map((style) => stream(style)));
    expect(results.every((result) => result.streams.length === 1)).toBe(true);
    expect(results[0].streams[0]).toEqual({
        name: 'After-Credits Scenes',
        title: "🕵️‍♂️ Couldn't Find Stingers",
        url: 'https://aftercredits.com/?s=Audit+Movie+2020',
    });
});

it('keeps stingers when optional related sources fail', async () => {
    const { stream } = harness({ failRelated: true });
    const result = await stream('colorful-related');
    expect(result.streams).toHaveLength(1);
    expect(result.streams[0].title).toBe('🎬 Post-Credits Scene');
});

it('releases failed flights so later calls can retry without an unhandled rejection', async () => {
    jest.resetModules();
    const { singleflight, credentialScope } = require('../src/utils/singleflight');
    const failure = jest.fn(() => Promise.reject(new Error('upstream failed')));
    const first = singleflight('failure', failure);
    const second = singleflight('failure', failure);
    expect(first).toBe(second);
    await expect(first).rejects.toThrow('upstream failed');
    await expect(second).rejects.toThrow('upstream failed');
    await expect(singleflight('failure', () => Promise.resolve('recovered'))).resolves.toBe('recovered');
    expect(failure).toHaveBeenCalledTimes(1);
    expect(credentialScope('secret')).not.toContain('secret');
});
