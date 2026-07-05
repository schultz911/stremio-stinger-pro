# STRICTIONS, GUARDRAILS & CORE CONSTRAINTS

- Pure-Functionality Preservation: Do not alter core business logic, API signatures, edge-case handling, or database schemas. Every optimization must maintain identical functionality.
- No Refactoring for "Cleanliness": Avoid aesthetic refactoring (e.g., changing variable names, reorganizing folder structures) unless it directly yields measurable performance dividends.
- Deterministic Outcomes: The output code must pass identical unit, integration, and regression tests.
- Firebase Protections: Under no circumstances suggest the removal, alteration, or optimization of code blocks, configuration files, or variables explicitly marked or structured for use by Firebase Functions.
- No "Any" Stripping: Do not recommend or force the removal or refactoring of TypeScript any types simply for strict compliance unless it directly resolves a critical, reproducible memory or runtime leak.

## Discovered Optimizations

- **Third Sweep Results (2026-07-05)**: Swept the codebase for security hardening and loop bottlenecks. Identified Open Redirect vulnerabilities in custom routing redirects (`src/app.js`), rate-limiting vulnerability due to hardcoded `trust proxy`, and a string concatenation optimization opportunity in `src/utils/strings.js`. Other suggestions were evaluated and rejected due to functional constraints or aesthetic/regression risks.
- **Second Sweep Results (2026-06-15)**: Swept the codebase for redundancies and resource leaks. Discovered redundant TMDB API `/find` network requests when resolving TMDB ID from IMDb ID in concurrent scraper runs, and redundant loop/lower-case operations during collections checks. Also investigated linter warnings for console.error usage, HTML decoding string creation, nesting levels, and function lengths.
- **Initial Sweep Results (2026-06-10)**: Conducted a thorough sweep of the codebase for Vector A (Sanitization) and Vector B (Runtime & Resource Optimization). No significant inefficiencies, dead code, unused packages, or CPU/Memory bottlenecks were discovered. The codebase is remarkably clean and functions as an enterprise-grade MVP.
- **Potential Edge Cases**: Minor telemetry and connection resilience opportunities were identified (GCP Error Reporting, Redis exponential backoff).

## Previously Suggested

- **[2026-07-05] Phase 3: Configurable trust proxy**: Suggested reading `trust proxy` configuration from environment variables.
- **[2026-07-05] Phase 3: Route Redirect Input Sanitization**: Suggested validating `:p1` and `:style` parameters with alphanumeric regex to prevent Open Redirect.
- **[2026-07-05] Phase 3: Title Cleaning String Concat Optimization**: Suggested using `slice().join(' ')` instead of loop concatenation.
- **[2026-06-15] Phase 2: TMDB Collections Lookup Optimization**: Suggested mapping `MEGA_COLLECTIONS` to Map lookup tables to optimize nested iteration loops from `O(N * M)` to `O(1)`/`O(K)`.
- **[2026-06-15] Phase 2: Split parseAfterCreditsPage Function**: Suggested splitting the function in `src/scrapers/aftercredits.js:57` to reduce size.
- **[2026-06-15] Phase 2: Split buildWikiIndex Function**: Suggested splitting the function in `src/scrapers/wikipedia.js:36` to reduce size.
- **[2026-06-15] Phase 2: TMDB ID Resolution Caching**: Suggested adding an in-memory `LRUCache` wrapper for `resolveTmdbIdFromImdb` to prevent duplicate concurrent network queries to the TMDB API.
- **[2026-06-15] Phase 2: Centralized Logger in Config**: Suggested replacing console.error with logger in `src/config.js:26`.
- **[2026-06-15] Phase 2: AfterCredits HTML Decoding Optimization**: Suggested deferring/optimizing `decodeHtmlString` inside WordPress taxonomy loops.
- **[2026-06-15] Phase 2: Nested Code Blocks Flattening**: Suggested restructuring deeply nested logic (5+ levels) in `redis.js`, `wikipedia.js`, `tmdb.js`, `stream.js`, and `aftercredits.js`.
- **[2026-06-10] Phase 1: Google Cloud Error Reporting Integration**: Suggested integrating `@google-cloud/error-reporting` in `src/utils/logger.js` and `src/app.js` to proactively track crashes without manual log digging.
- **[2026-06-10] Phase 1: Redis Connection Resilience**: Suggested implementing exponential backoff for Redis reconnections in `src/cache/redis.js` to prevent database hammering during outages.

## Approved and Implemented

- **[2026-07-05] Phase 3: Configurable trust proxy**: Implemented environment variable `TRUST_PROXY` check in `src/app.js`.
- **[2026-07-05] Phase 3: Route Redirect Input Sanitization**: Added regex checks `/^[a-z0-9-_]+$/i` to parameters in redirect routes in `src/app.js`.
- **[2026-07-05] Phase 3: Title Cleaning String Concat Optimization**: Optimized title rebuilding loop using `slice().join(' ')` in `src/utils/strings.js`.
- **[2026-06-15] Phase 2: TMDB Collections Lookup Optimization**: Pre-mapped collections/keywords IDs and names into static lookup tables at module load to optimize franchise checks in `src/scrapers/tmdb.js:269`.
- **[2026-06-15] Phase 2: TMDB ID Resolution Caching**: Implemented a 24-hour LRU cache for TMDB ID queries in `src/scrapers/tmdb.js`, coalescing concurrent requests and caching resolved IDs to prevent redundant requests.
*(None in this sweep)*

## Denied or Not Implemented

- **[2026-07-05] Phase 3: UUID Truncation slice**: Denied as purely aesthetic with identical runtime performance.
- **[2026-07-05] Phase 3: Stream Merging reduce/some**: Denied as `for...of` loop is more performance-efficient in V8.
- **[2026-07-05] Phase 3: streamHandler Repetitive Try/Catch**: Denied as aesthetic refactoring violating cleanliness guardrail.
- **[2026-07-05] Phase 3: Collection Parts Unsorted Indexing**: Denied as sorting/filtering is functionally required to find correct chronological prequels/sequels.
- **[2026-07-05] Phase 3: flatMap MEGA_COLLECTIONS at Startup**: Denied as the loop runs only once at module load time.
- **[2026-07-05] Phase 3: Wikipedia Synchronous indexOf**: Denied as index rebuilds are run in background infrequently, and `indexOf` is extremely fast.
- **[2026-07-05] Phase 3: Split getRelatedMovies Function**: Denied as aesthetic refactoring violating cleanliness guardrail.
- **[2026-07-05] Phase 3: Parallelize TMDB Related Requests**: Denied as requests have strict sequential data dependencies.
- **[2026-07-05] Phase 3: Redis get Stream Parsing**: Denied as cached payloads are tiny and synchronous parsing takes under 1ms without library overhead.
- **[2026-06-15] Phase 2: Split parseAfterCreditsPage Function**: Denied due to purely aesthetic refactoring containing regression risk without performance benefits.
- **[2026-06-15] Phase 2: Split buildWikiIndex Function**: Denied due to purely aesthetic refactoring containing regression risk without performance benefits.
- **[2026-06-15] Phase 2: Centralized Logger in Config**: Denied due to high risk of circular dependency and startup failures.
- **[2026-06-15] Phase 2: AfterCredits HTML Decoding Optimization**: Denied due to micro-optimization with zero measurable performance gains on small tag arrays.
- **[2026-06-15] Phase 2: Nested Code Blocks Flattening**: Denied due to purely aesthetic refactoring containing regression risk without performance benefits.
- **[2026-06-10] Phase 1: Google Cloud Error Reporting Integration**: Skipped by user feedback.
- **[2026-06-10] Phase 1: Redis Connection Resilience**: Skipped by user feedback.
