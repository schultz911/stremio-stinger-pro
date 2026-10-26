const ROOT = 'List_of_films_with_post-credits_scenes';
const table = (title, text) =>
    `<table class="wikitable"><tr><th>Year</th><th>Title</th><th>Description</th></tr><tr><td>2020</td><td><i>${title}</i></td><td>${text}</td></tr></table>`;
const parsed = (html) => ({ data: { parse: { text: { '*': html } } } });
const directory = (suffixes) => suffixes.map((suffix) => `<a href="/wiki/${ROOT}_(${suffix})">Films</a>`).join('');

function harness({ cached = null, redisEnabled = false } = {}) {
    jest.resetModules();
    const get = jest.fn().mockResolvedValue(parsed(table('The Matrix', 'During the credits.')));
    const redis = {
        isRedisEnabled: jest.fn(() => redisEnabled),
        getCache: jest.fn().mockResolvedValue(cached),
        setCache: jest.fn().mockResolvedValue(undefined),
    };
    const logger = { log: jest.fn(), error: jest.fn() };
    jest.doMock('../src/utils/network', () => ({
        axiosInstance: { get },
        isCancel: (e) => !!e.__CANCEL__,
        sanitizeError: String,
    }));
    jest.doMock('../src/cache/redis', () => redis);
    jest.doMock('../src/utils/logger', () => logger);
    return { wiki: require('../src/scrapers/wikipedia'), get, redis, logger };
}

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-26T00:00:00Z'));
});
afterEach(() => {
    jest.useRealTimers();
    jest.resetModules();
});

it('follows the split decade lists and preserves classification and result shape', async () => {
    const { wiki, get, redis } = harness({ redisEnabled: true });
    const pages = {
        [ROOT]: directory(['before_2000', '2000s', '2010s', '2020s']),
        [`${ROOT}_(before_2000)`]: table('The Matrix', 'During the credits.'),
        [`${ROOT}_(2000s)`]: table('Iron Man', 'After the credits.'),
        [`${ROOT}_(2010s)`]: table('The Avengers', 'During and after the credits.'),
        [`${ROOT}_(2020s)`]: table('Audio Movie', 'After the credits, an audio cue is heard.'),
    };
    get.mockImplementation(async (url) => parsed(pages[new URL(url).searchParams.get('page')]));
    await wiki.buildWikiIndex();
    expect(get).toHaveBeenCalledTimes(5);
    await expect(wiki.checkWikipedia('The Matrix')).resolves.toMatchObject({
        mid: true,
        post: false,
        source: 'Wikipedia',
        definitive: true,
    });
    await expect(wiki.checkWikipedia('Iron Man')).resolves.toMatchObject({ mid: false, post: true });
    await expect(wiki.checkWikipedia('The Avengers')).resolves.toMatchObject({ mid: true, post: true });
    await expect(wiki.checkWikipedia('Audio Movie')).resolves.toMatchObject({ post: true, audioOnly: true });
    expect(get).toHaveBeenCalledTimes(5);
    expect(redis.setCache).toHaveBeenCalledWith(
        'wiki_index_cache',
        expect.objectContaining({ matrix: expect.any(Object), avengers: expect.any(Object) }),
        86400
    );
});

it('still supports legacy tables and reuses the in-memory index', async () => {
    const { wiki, get } = harness();
    await wiki.buildWikiIndex();
    await expect(wiki.checkWikipedia('The Matrix')).resolves.toEqual({
        mid: true,
        post: false,
        no: false,
        url: 'https://en.wikipedia.org/wiki/List_of_films_with_post-credits_scenes',
        source: 'Wikipedia',
        bloopers: false,
        definitive: true,
        sequel: false,
        audioOnly: false,
    });
    expect(get).toHaveBeenCalledTimes(1);
});

it('accepts parsed HTML string responses as well as legacy text objects', async () => {
    const { wiki, get } = harness();
    get.mockResolvedValue({ data: { parse: { text: table('The Matrix', 'After credits, outtakes play.') } } });
    await expect(wiki.checkWikipedia('The Matrix')).resolves.toMatchObject({ post: true, bloopers: true });
});

it('deduplicates decade links and never fetches external or unrelated pages', async () => {
    const { wiki, get } = harness();
    const root =
        directory(['2020s', '2020s']) +
        `<a href="https://evil.example/wiki/${ROOT}_(2010s)">External</a><a href="/wiki/Unrelated">Other</a><a href="/wiki/%ZZ">Malformed</a>`;
    get.mockResolvedValueOnce(parsed(root));
    await wiki.buildWikiIndex();
    expect(get).toHaveBeenCalledTimes(2);
    expect(new URL(get.mock.calls[1][0]).searchParams.get('page')).toBe(`${ROOT}_(2020s)`);
});

it('bounds child-page concurrency to two and coalesces simultaneous rebuilds', async () => {
    const { wiki, get } = harness();
    let active = 0;
    let maximum = 0;
    const releases = [];
    get.mockImplementation(async (url) => {
        const page = new URL(url).searchParams.get('page');
        if (page === ROOT) return parsed(directory(['before_2000', '2000s', '2010s', '2020s']));
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => releases.push(resolve));
        active--;
        return parsed(table(page, 'After the credits.'));
    });
    const builds = Array.from({ length: 12 }, () => wiki.buildWikiIndex());
    for (let i = 0; i < 4; i++) {
        await jest.advanceTimersByTimeAsync(0);
        for (const release of releases.splice(0)) release();
    }
    await Promise.all(builds);
    expect(maximum).toBe(2);
    expect(get).toHaveBeenCalledTimes(5);
    expect(jest.getTimerCount()).toBe(0);
});

it.each([{}, [], { broken: { mid: 'yes', post: false, bloopers: false } }])(
    'ignores empty or malformed Redis data: %j',
    async (cached) => {
        const { wiki, get } = harness({ redisEnabled: true, cached });
        await expect(wiki.checkWikipedia('The Matrix')).resolves.toMatchObject({ mid: true });
        expect(get).toHaveBeenCalledTimes(1);
    }
);

it('loads valid nonempty Redis data without network work', async () => {
    const { wiki, get } = harness({
        redisEnabled: true,
        cached: { matrix: { mid: true, post: false, bloopers: false } },
    });
    await expect(wiki.checkWikipedia('The Matrix')).resolves.toMatchObject({ mid: true, audioOnly: false });
    expect(get).not.toHaveBeenCalled();
});

it.each([
    { data: { error: { code: 'missingtitle' } } },
    { data: { parse: { text: { '*': '' } } } },
    parsed('<p>No film tables.</p>'),
])('rejects invalid successful responses, avoids empty writes, and delays retries: %j', async (upstream) => {
    const { wiki, get, redis, logger } = harness({ redisEnabled: true });
    get.mockResolvedValue(upstream);
    await expect(wiki.checkWikipedia('The Matrix')).resolves.toBeNull();
    await expect(wiki.checkWikipedia('The Matrix')).resolves.toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
    expect(redis.setCache).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(60000);
    get.mockResolvedValue(parsed(table('The Matrix', 'During the credits.')));
    await expect(wiki.checkWikipedia('The Matrix')).resolves.toMatchObject({ mid: true });
    expect(get).toHaveBeenCalledTimes(2);
});

it('retains a known-good index when any child page fails or has no film rows', async () => {
    const { wiki, get, redis } = harness({ redisEnabled: true });
    await wiki.buildWikiIndex();
    await jest.advanceTimersByTimeAsync(86400001);
    get.mockResolvedValueOnce(parsed(directory(['2010s', '2020s'])))
        .mockResolvedValueOnce(parsed(table('New Film', 'After credits.')))
        .mockResolvedValueOnce(parsed('<p>Temporarily unavailable</p>'));
    await wiki.buildWikiIndex();
    await expect(wiki.checkWikipedia('The Matrix')).resolves.toMatchObject({ mid: true });
    await expect(wiki.checkWikipedia('New Film')).resolves.toBeNull();
    expect(redis.setCache).toHaveBeenCalledTimes(1);
});

it('aborts all page work at the shared deadline without leaving timers or retrying immediately', async () => {
    const { wiki, get } = harness();
    let signal;
    get.mockImplementation((url, options) => {
        signal = options.signal;
        return new Promise((resolve, reject) =>
            signal.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { __CANCEL__: true })), {
                once: true,
            })
        );
    });
    const build = wiki.buildWikiIndex({ timeout: 100 });
    await jest.advanceTimersByTimeAsync(100);
    await build;
    expect(signal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    await wiki.buildWikiIndex();
    expect(get).toHaveBeenCalledTimes(1);
});
