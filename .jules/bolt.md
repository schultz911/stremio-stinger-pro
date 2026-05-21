## 2026-05-16 - Fix Cache Stampede in Wikipedia Scraper
 **Learning:** I learned that async operations like Wikipedia scraping in a multi-tiered aggregator can suffer from cache stampedes if they are not guarded correctly. When a single cached entry expires, multiple concurrent requests for the same piece of information could trigger a thundering herd problem.
 **Action:** By tracking the `Promise` of an inflight data fetch operation and immediately returning that Promise to concurrent callers, we prevent cache stampedes effectively.
## 2024-05-16 - Cheerio loop early break
 **Learning:** In Cheerio's `.each()` loop, iterating over all matches when only the first one is needed causes unnecessary execution time, particularly in scraping loops where performance is critical. Returning `false` short-circuits the loop.
 **Action:** Always review Cheerio and jQuery-style `.each()` iterations to verify whether all elements must be traversed. Apply `return false;` when subsequent matches are irrelevant to improve throughput and save CPU cycles.
## 2024-05-16 - Optimized isSafeSuffix string traversal
 **Learning:** Using `String.prototype.split` with a regular expression (like `/\s+/`) creates unnecessary array allocations and involves regex engine overhead, especially inside loops. Manual character iteration and `String.prototype.substring` avoids allocations, which speeds up checks in critical paths by nearly 50%.
 **Action:** For performance-critical string operations, prefer manual character traversal with `charCodeAt` and `substring` to avoid array allocations and regex overhead.
## 2026-05-16 - O(1) Lookups in Cheerio parsing
**Learning:** Using inline arrays with `.includes()` inside loops (like `Cheerio.each` or `Array.some()`) inside a request-handler path causes redundant memory allocations per-element and `O(N)` lookup times. Extracting those static arrays to globally instantiated `Set` objects prevents garbage-collection pressure and improves matching speeds to `O(1)`.
**Action:** Extract static arrays used for inclusion-checks within frequently-called loops to global Sets.
## 2024-05-18 - Map-Based Cache Iteration Order
**Learning:** In JavaScript, the `Map` object remembers the original insertion order of the keys. When implementing a bounded cache using `Map` (like `streamCache` in `server.js`), deleting the first key (e.g., `this._cache.keys().next().value`) effectively creates a FIFO (First-In-First-Out) cache, NOT an LRU (Least Recently Used) cache, because reading a value with `get()` doesn't update its position in the iteration order.
**Action:** When implementing basic caches using `Map`, ensure that accesses (`get()`) actually delete and re-insert the key to push it to the end of the iteration order, converting it to a true LRU cache and improving the cache hit rate for frequently accessed items.
## 2024-05-18 - Defer expensive DOM extraction in Cheerio loops
 **Learning:** In Cheerio's `.each()` loop, performing expensive DOM operations like `$$(el).text()` and subsequent regex evaluations on *every* element unconditionally is a common performance bottleneck, especially if the loop iterations only care about a subset of elements.
 **Action:** Always defer heavy DOM text extractions and string parsing/regex matching by first querying or checking cheaper, structural indicators (e.g., classes, IDs, or short header texts) and conditionally branching inside the loop to skip irrelevant containers.
## 2024-05-19 - Cache Cheerio Wrappers in Loops
 **Learning:** In Cheerio's `.each()` loops, calling `$(el)` multiple times within the same loop iteration creates redundant objects and adds parsing overhead, unnecessarily slowing down tight scraping loops.
 **Action:** Always assign the wrapper to a constant at the start of the loop (e.g., `const $el = $(el);`) to minimize object instantiation and garbage collection when the wrapper is needed multiple times.
## 2024-05-19 - Replacing cheerio.load() with lightweight regex for simple HTML strings
 **Learning:** Using `cheerio.load()` to parse and extract text from simple HTML strings (like short WordPress titles) inside loops introduces significant synchronous blocking overhead due to DOM tree construction, slowing down loop execution significantly.
 **Action:** When only simple entity decoding and HTML tag stripping are needed, use lightweight regex-based string replacements (e.g., `str.replace(/<[^>]*>?/gm, '').replace(/&#(\\d+);/g, ...)`) instead of `cheerio.load()`.
