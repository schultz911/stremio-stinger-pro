const { createHash } = require('crypto');
const { LRUCache } = require('lru-cache');

const pending = new LRUCache({ max: 1000 });

const credentialScope = (key) => createHash('sha256').update(String(key || '')).digest('hex');

const singleflight = (key, task) => {
    const existing = pending.get(key);
    if (existing) return existing;

    const promise = Promise.resolve().then(task);
    pending.set(key, promise);
    const cleanup = () => {
        if (pending.get(key) === promise) pending.delete(key);
    };
    promise.then(cleanup, cleanup);
    return promise;
};

module.exports = { singleflight, credentialScope };
