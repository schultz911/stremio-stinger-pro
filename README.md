# Stremio Stinger Pro

## Version 3.1.0

![logo](public/icon.png)

Stremio Stinger Pro is a high-speed, high-fidelity Stremio addon that detects mid-credits scenes, post-credits scenes, audio cues, outtakes, bloopers, sequel setups, and extended franchise metadata (prequels, sequels, and source material). It integrates directly into your stream list with customizable configurations.

---

## Table of Contents

- [⚙️ Key Features](#️-key-features)
- [📡 Data Sources](#-data-sources)
- [⛏️ Core Scraping & Parallel Architecture](#%EF%B8%8F-core-scraping--parallel-architecture)
- [💾 Cache & Scalability Infrastructure](#-cache--scalability-infrastructure)
- [🌍 Configuration and Installation](#-configuration-and-installation)
- [🚀 Development & Validation](#-development--validation)
- [📋 Release History](#-release-history)

---

## ⚙️ Key Features

- **Narrative & Blooper Alerts:** Detects and distinguishes between narrative stingers (mid/post-credits scenes) and outtakes/blooper reels.
- **Extended Franchise Metadata:** Resolves prequels, sequels, and source material (e.g. books, comics, plays) to provide a rich context of the movie.
- **Sequel Setup Detection:** Flags if a film contains scenes specifically setting up a future installment (powered by AfterCredits).
- **Flexible Display Styles:**
  - **Colorful:** High-vibrancy, emoji-rich labels for maximum visibility.
  - **Monochrome:** A minimalist, black-and-white icon style.
  - **Simple:** Clean, text-only outputs.
- **Dynamic Web Configurator:** Served at `/configure`, featuring a glassmorphic dashboard, custom TMDB API key input validation, and a live Stremio client emulator preview.
- **Attribute & Source Toggles:** Configure the addon to include or omit source attribution (e.g., "Source: TMDB") or outtakes in the stream output.

---

## 📡 Data Sources

The addon queries multiple databases concurrently to determine stinger info and related movies:

1. **AfterCredits.com:** Main source for narrative stingers, blooper classifications, and sequel setup details.
2. **The Movie Database (TMDB):** Used for movie search, keyword-based stinger tags, collections, and franchise discoveries (prequels/sequels).
3. **Wikipedia:** Uses list page crawling to pre-compile a local index of post-credits films.
4. **basedon.media:** Concurrent query endpoint to resolve accurate literary or comic source material.

> [!NOTE]
>
> - TMDB uses a fallback community key, but users can input their own v3 key for dedicated rate limits.
> - Wikipedia classifications lack detailed timing markers and will output as **"Unclassified Scene"** if other scrapers don't provide details.

---

## ⛏️ Core Scraping & Parallel Architecture

To deliver ultra-low tail latency, Stremio Stinger Pro executes scrapers concurrently. The resolver utilizes a **Fast-Path Racing** mechanism:

- If a high-priority scraper (AfterCredits or TMDB) returns a **definitive** result, the addon resolves the stream payload instantly.
- In the background, a non-blocking worker merges late-resolving scraper results, compiles the final metadata, and enriches both memory and Redis cache layers for subsequent hits.
- Network requests are protected by safe timeout layers (10s global scraper timeout, 5s Cinemeta timeout) and include built-in exponential backoff retries for transient status codes (502, 503, 504) or network drops.

---

## 💾 Cache & Scalability Infrastructure

Stremio Stinger Pro is designed to handle high concurrency with enterprise-grade guards:

1. **Multi-Tier Caching:** Implements an in-memory LRU cache (`lru-cache`) backed by a Redis distributed cache (`redis`). Memory cache is prioritized, falling back to Redis, and finally to source scrapers.
2. **Request Coalescing (Singleflight):** Prevents cache stampedes by joining parallel concurrent requests for the same movie ID into a single shared execution promise, eliminating redundant origin fetches.
3. **Negative Cache:** Unresolved metadata lookups or invalid movie IDs are cached with a short TTL (`60 seconds`) to protect downstream APIs from hammering.
4. **Log & Input Sanitization:** Personal API keys are stripped and sanitized from both database keys, input fields, and server console logs. SSRF is prevented by strictly validating HTTP protocols and hostnames before requests.
5. **Rate Limiting:** A Redis Lua script-based rate limiter controls IP traffic with a local LRU rate limit fallback.

---

## 🌍 Configuration and Installation

1. Navigate to `/configure` on your hosted instance.
2. Select your preferred display style (**Colorful**, **Monochrome**, or **Simple**).
3. Select configuration preferences (Bloopers, Sequel Setups, and Extended Metadata).
4. (Optional) Provide your TMDB v3 API Key.
5. Click **Install to Stremio** to automatically launch your Stremio client, or copy the manifest URL and paste it into Stremio's addon search bar.

---

## 🚀 Development & Validation

### Tech Stack

- **Runtime:** Node.js (CommonJS)
- **Framework:** Express.js (v5)
- **Scraping & Parsing:** Cheerio & Axios
- **Formatting & Linting:** ESLint & Prettier
- **Testing:** Jest & Supertest

### Setup Environment

Use the built-in PowerShell or Bash scripts to verify the Node environment, copy `.env.example` to `.env`, install dependencies, and run validation checks:

```bash
# On Linux/macOS
./setup.sh

# On Windows (PowerShell)
.\setup.ps1
```

### Local Dev Workflows

```bash
# Start the Express server locally
npm start

# Run unit and integration tests
npm test

# Lint source files
npm run lint

# Format public assets and source files
npm run format
```

---

## 📋 Release History

### Release: v3.1.0 (Latest)

- **Optimization:** Added distributed caching layers via Redis client integration.
- **Optimization:** Implemented Redis Lua-based and local memory-based rate limiters.
- **Optimization:** Added request coalescing (singleflight) to prevent cache stampedes.
- **UI:** Overhauled configuration UI to support glassmorphism, responsive sidebar toggle, and live preview simulation.
- **Security:** Added strict SSRF validation and log/API key sanitization.

### Release: v3.0.0

- **Feature:** Introduced Extended Metadata (`-related`) containing prequels, sequels, and source material.
- **Feature:** Added a "Monochrome" display style with minimalist black-and-white icon badges.
- **Performance:** Integrated `compression` middleware and `keepAlive` agents for Axios.
- **Maintenance:** Cleaned codebase of dead imports and stale MediaStinger references.

### Release: v2.1.0

- **Feature:** Removed MediaStinger scraper completely due to site closure.
- **Performance:** Reduced global timeout thresholds to keep response times under 15s.

### Release: v2.0.0

- **Feature:** Added sequel setup detection option for AfterCredits.

### Release: v1.6.0

- **Feature:** Added Wikipedia "List of films with post-credits scenes" fallback indexer.
- **Feature:** Decoupled bloopers and outtakes from narrative stingers.
- **Fix:** Fixed leading/trailing article matches on obscure titles.
