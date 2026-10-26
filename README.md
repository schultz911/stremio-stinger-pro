# Stremio Stinger Pro

[![Release](https://img.shields.io/badge/release-v3.2.0-blue.svg)](https://github.com/schultz911/stremio-stinger-pro/releases)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/express-v5.2.1-lightgrey.svg)](https://expressjs.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-54%20passed-success.svg)](tests/)
[![Code Style: Prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://prettier.io)

![Stremio Stinger Pro Logo](public/icon.png)

Stremio Stinger Pro is a high-speed, high-fidelity Stremio addon that detects mid-credits scenes, post-credits scenes, audio cues, outtakes, bloopers, sequel setups, and extended franchise metadata (prequels, sequels, and source material). It integrates directly into your stream list with customizable configurations.

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Display Profiles](#display-profiles)
- [Data Sources](#data-sources)
- [Architecture & Performance](#architecture--performance)
- [Configuration & Installation](#configuration--installation)
- [HTTP Endpoints Reference](#http-endpoints-reference)
- [Environment Variables](#environment-variables)
- [Deployment & Self-Hosting](#deployment--self-hosting)
- [Development & Testing](#development--testing)
- [Security & Privacy](#security--privacy)
- [Release History](#release-history)
- [License & Acknowledgements](#license--acknowledgements)

---

## Overview

Have you ever sat through 10 minutes of rolling credits wondering if there is an extra scene at the end? Or closed a movie too early and missed a crucial cinematic universe setup?

**Stremio Stinger Pro** solves this directly inside the Stremio interface. Whenever you click on a movie in Stremio, the addon inspects the film across multiple data sources simultaneously and displays a clear badge right inside the stream results list. It informs you if there is a mid-credits scene, a post-credits stinger, an outtake reel, a teaser for an upcoming sequel, or where the movie fits into a larger franchise.

Built on Express v5 with a distributed multi-tier cache, singleflight request coalescing, and fast-path racing, Stremio Stinger Pro delivers sub-millisecond responses on cache hits while maintaining complete resilience against upstream provider timeouts.

---

## Key Features

- **Mid & Post-Credits Scene Alerts:** Accurately classifies whether scenes occur mid-credits, post-credits, or during the credits, including audio-only stingers.
- **Outtakes & Blooper Distinctions:** Clearly separates comedic outtakes or blooper reels from narrative story-driven scenes.
- **Sequel Setup Detection:** Highlights when a stinger sets up a future installment or cliffhanger (powered by AfterCredits).
- **Franchise & Universe Timelines:** Resolves chronological prequels, sequels, and overarching universe collections (e.g., Marvel Cinematic Universe, Star Wars, Pixar, James Bond, Wizarding World).
- **Source Material Origins:** Integrates with `basedon.media` to identify exact literary, graphic novel, or theatrical origins (such as original comic runs or novels).
- **Dynamic Web Configurator:** Features an interactive web dashboard at `/configure` with a real-time Stremio client emulator, movie search test bench, and custom TMDB API key validation.
- **Customizable Display Profiles:** Choose between vibrant color badges, minimalist black-and-white icons, or simple plain text.
- **Granular Feature Toggles:** Easily enable or disable outtakes, sequel setups, extended franchise metadata, or source provider attributions.

---

## Display Profiles

Stremio Stinger Pro supports three distinct styling modes to match your preference and client theme:

| Style | Description | Example Stream Preview |
| :--- | :--- | :--- |
| `colorful` | High-vibrancy badges with distinct emoji markers for quick visibility on TV and desktop screens. | `🎉 Mid & Post-Credits Scenes (AfterCredits)` |
| `monochrome` | Minimalist, elegant black-and-white icon badges designed for clean, high-contrast layouts. | `⤹⤷ Mid & Post-Credits Scenes (AfterCredits)` |
| `simple` | Lightweight, plain-text labels without emojis or icons. | `Mid & Post-Credits Scenes (AfterCredits)` |

When extended metadata is enabled, franchise and source details appear in a dedicated accompanying stream card:

- **Collection:** `Part of Marvel Cinematic Universe (MCU)`
- **Timeline:** `⏮️ Prequel: Captain America: The First Avenger | ⏭️ Sequel: Iron Man 3`
- **Origin:** `📖 Source: The Avengers (comic book) (1963)`

---

## Data Sources

The addon aggregates and cross-references data concurrently across multiple specialized providers:

1. **[AfterCredits.com](https://aftercredits.com):** The premier database for verified credit stingers, precise mid/post scene positions, bloopers, and sequel setup tagging.
2. **[The Movie Database (TMDB)](https://www.themoviedb.org):** Used for movie search resolution, keyword-based stinger tags (`duringcreditsstinger`, `aftercreditsstinger`), collection groupings, and chronological franchise sorting.
3. **[Wikipedia](https://en.wikipedia.org):** Comprehensive fallback indexer that crawls Wikipedia's lists of films with post-credits scenes, automatically traversing decade-specific list sub-pages.
4. **[basedon.media](https://basedon.media):** Resolves canonical book, comic, or theater source material for adaptive titles.
5. **[Cinemeta](https://v3-cinemeta.strem.io):** Stremio's default metadata provider, utilized for canonical title and release year resolution from IMDb IDs.

> [!NOTE]
> Stremio Stinger Pro includes a shared fallback community TMDB key. Users can supply their personal TMDB v3 API key in the configurator for dedicated rate limits.

---

## Architecture & Performance

Stremio Stinger Pro is engineered for high throughput and ultra-low latency:

```text
Stremio Client Request
         │
         ▼
┌─────────────────────────────────┐
│   Express v5 Server Pipeline    │
│  (Rate Limiting & Compression)  │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│    Multi-Tier Cache Layer       │
│  Tier 1: In-Memory LRU (0.1ms)  │
│  Tier 2: Redis Distributed Cache│
└────────────────┬────────────────┘
                 │ (Cache Miss)
                 ▼
┌─────────────────────────────────┐
│  Singleflight Deduplication     │
│  (Coalesces Concurrent Lookups) │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│    Fast-Path Racing Engine      │
│  AfterCredits ── TMDB ── Wiki   │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ Async Background Aggregation    │
│ (Enriches Cache & Related Data) │
└─────────────────────────────────┘
```

### 1. Fast-Path Racing

To deliver near-instant stream results, the resolver fires all scrapers concurrently. As soon as a high-priority scraper (AfterCredits or TMDB) returns a definitive positive or negative result, the response is delivered immediately. In the background, a non-blocking worker merges late-resolving scraper results, compiles full metadata, and enriches both cache tiers for subsequent requests.

### 2. Request Coalescing (Singleflight)

Under sudden traffic spikes (such as a popular new movie release), dozens of concurrent requests may target the same movie ID simultaneously. The singleflight coalescing engine shares the pending metadata lookup, source scraping, and related franchise calculations across all callers. Credential-dependent queries use SHA-256 hashed scopes, ensuring no duplicate network queries occur.

### 3. Multi-Tier Distributed Caching

- **Tier 1 (Memory):** In-memory LRU cache (`lru-cache`) holding up to 5,000 entries with a 30-minute success TTL for sub-millisecond local responses.
- **Tier 2 (Redis):** Distributed Redis cache with automated JSON serialization for shared multi-instance deployments.
- **Negative Caching:** Unresolved lookups or invalid movie IDs are cached for 60 seconds to protect downstream APIs from hammering.

### 4. Redis Failure Containment

If Redis encounters connection issues or latency spikes, the addon prevents service degradation:

- Command queue is capped at 128 commands.
- Offline command queuing is disabled to prevent memory leaks during outages.
- Stalled socket connections are automatically reset after 500 ms.
- A 5-second recovery cooldown protects against reconnection thrashing while smoothly falling back to local memory caching.

### 5. Resilient Wikipedia Indexing

- Crawls directory and decade-specific film lists with a concurrency cap of 2 parallel fetches and a shared timeout.
- Validates cached and incoming data integrity before replacing the active index.
- Retains the prior index when upstream network or parsing errors occur.
- Implements a 60-second backoff before retrying failed refreshes.

---

## Configuration & Installation

### Option 1: Web Configurator (Recommended)

1. Open the hosted configurator URL in your browser:

   ```text
   https://stinger.schultz.ovh/configure
   ```

2. Choose your preferred **Display Style** (`Colorful`, `Monochrome`, or `Simple`).
3. Toggle optional features:
   - **Include Outtakes & Bloopers**
   - **Show Sequel Setup**
   - **Show Extended Metadata (Prequels, Sequels & Source Material)**
4. *(Optional)* Enter your personal TMDB v3 API Key.
5. Click **Install to Stremio** to launch the Stremio application directly, or click **Copy Manifest URL** and paste it into the Stremio addon search bar.

### Option 2: Manual URL Construction

You can construct your addon manifest URL manually following this syntax:

```text
https://<domain>/[style][-bloopers][-sequel][-related][-nosource]/[apiKey]/manifest.json
```

#### Configuration Flags

| Parameter / Flag | Description |
| :--- | :--- |
| `colorful` | Default vibrant style with emojis. |
| `monochrome` | Minimalist black-and-white icon badges. |
| `simple` | Plain text output without icons or emojis. |
| `-bloopers` | Enables outtakes and blooper notifications. |
| `-sequel` | Shows sequel setup alerts when verified by AfterCredits. |
| `-related` | Appends franchise timeline (prequels/sequels) and source material cards. |
| `-nosource` | Hides the provider attribution (e.g. `(AfterCredits)`). |
| `[apiKey]` | *(Optional)* 32-character hexadecimal TMDB v3 API key. |

#### URL Examples

- Default Colorful: `https://stinger.schultz.ovh/manifest.json`
- Monochrome with Bloopers: `https://stinger.schultz.ovh/monochrome-bloopers/manifest.json`
- Full Features with Custom TMDB Key: `https://stinger.schultz.ovh/colorful-bloopers-sequel-related/YOUR_TMDB_API_KEY/manifest.json`

---

## HTTP Endpoints Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/` | Web Configurator & live emulator. |
| `GET` | `/configure` | Web Configurator & live emulator. |
| `GET` | `/:config/configure` | Pre-loaded configuration interface. |
| `GET` | `/manifest.json` | Stremio addon manifest (default configuration). |
| `GET` | `/:config/manifest.json` | Stremio addon manifest with customized configuration. |
| `GET` | `/stream/:type/:id.json` | Stream response endpoint (`type=movie`, `id=tt...`). |
| `GET` | `/:config/stream/:type/:id.json` | Stream response endpoint with custom parameters. |
| `GET` | `/preview/:id` | Test bench search & stinger diagnostic endpoint. |
| `GET` | `/health` | Server uptime and Redis connection health check. |

---

## Environment Variables

Copy `.env.example` to `.env` to customize your runtime environment:

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `PORT` | `number` | `7000` | Port on which the HTTP server listens. |
| `TMDB_API_KEY` | `string` | `""` | TMDB v3 API key for movie lookups and franchise resolution. |
| `REDIS_URL` | `string` | `""` | Redis connection URL (e.g., `redis://localhost:6379`). Falls back to memory cache if empty. |
| `ENABLE_LOGGING` | `boolean` | `true` | Enables console logging. Set to `false` in production for minimal log output. |
| `NODE_ENV` | `string` | `development` | Environment mode (`development`, `production`, `test`). When `production`, logs emit structured JSON. |
| `TRUST_PROXY` | `string` | `"1"` | Configures Express `trust proxy` setting behind reverse proxies (Nginx, Cloudflare, Traefik). |

---

## Deployment & Self-Hosting

### Direct Node.js / PM2

```bash
# Clone the repository
git clone https://github.com/schultz911/stremio-stinger-pro.git
cd stremio-stinger-pro

# Install dependencies exactly from lockfile
npm ci --include=dev

# Copy configuration template
cp .env.example .env

# Start with Node.js
npm start

# Or run in background via PM2
pm2 start server.js --name "stremio-stinger-pro"
```

### Docker & Docker Compose

Create a `docker-compose.yml` file:

```yaml
services:
  stremio-stinger-pro:
    image: node:20-alpine
    working_dir: /app
    volumes:
      - ./:/app
    command: sh -c "npm ci && npm start"
    ports:
      - "7000:7000"
    environment:
      - PORT=7000
      - NODE_ENV=production
      - TMDB_API_KEY=your_tmdb_key_here
      - REDIS_URL=redis://redis:6379
      - TRUST_PROXY=1
    depends_on:
      - redis
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis_data:/data

volumes:
  redis_data:
```

Launch with:

```bash
docker compose up -d
```

### Reverse Proxy Configuration (Nginx)

```nginx
server {
    listen 80;
    server_name stinger.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:7000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## Development & Testing

### Prerequisites

- Node.js `>= 18.0.0`
- npm `>= 9.0.0`
- *(Optional)* Redis server `v6+`

### Setup Environment

Run the automated setup script for your platform:

```bash
# Linux / macOS
./setup.sh

# Windows (PowerShell)
.\setup.ps1
```

### Available Scripts

| Script | Command | Purpose |
| :--- | :--- | :--- |
| `npm start` | `node server.js` | Starts the Express server. |
| `npm test` | `jest` | Executes the 54 unit and integration tests across 8 suites. |
| `npm run lint` | `eslint src/` | Checks JavaScript code against ESLint rules. |
| `npm run format` | `prettier --write src/ public/` | Formats source files and public assets with Prettier. |

---

## Security & Privacy

- **Zero Tracking:** Stremio Stinger Pro does not collect, track, or persist user viewing habits, client IP addresses, or watch histories.
- **SSRF Prevention:** All outbound network queries strictly validate HTTP/HTTPS protocols and allowlist authorized target hostnames.
- **Log Sanitization:** Personal API keys and sensitive query parameters are stripped from console outputs, error traces, and cache keys.
- **Multi-Tier Rate Limiting:** A Redis Lua atomic script enforces 60 requests/minute per IP, automatically falling back to an in-memory LRU window.
- **Content Security Policy:** Production responses include strict security headers (`X-Content-Type-Options`, `X-XSS-Protection`, `Strict-Transport-Security`, and a tailored CSP permitting Stremio iframe integration).

---

## Release History

### v3.2.0

- **Wikipedia Decade Crawling:** Added automated traversal of Wikipedia's decade-specific film lists with bounded concurrency and shared deadlines.
- **Index Retention & Fallback:** Retains the prior valid Wikipedia index during upstream network interruptions, avoiding empty index overwrites.
- **Acquisition Coalescing:** Extended singleflight request deduplication across display styles, previews, and related franchise calculations.
- **Redis Reliability:** Implemented queue capping (128 commands), socket timeout resets (500 ms), and a 5-second recovery cooldown during outages.
- **Resource Cleanup:** Upgraded `compression` to 1.8.2 and `proxy-addr` to 2.0.8; added aborted-response native resource cleanup verification.

### v3.1.0

- **Distributed Caching:** Added Redis cache integration with multi-tier in-memory LRU fallback.
- **Rate Limiting:** Implemented Redis Lua atomic rate limiter and local LRU fallback.
- **Request Coalescing:** Added singleflight deduplication to eliminate cache stampedes under heavy traffic.
- **Web UI Overhaul:** Rebuilt the `/configure` dashboard with glassmorphism, responsive sidebar toggle, and live Stremio client emulator.
- **Security Hardening:** Added SSRF validation and log/API key redaction.

### v3.0.0

- **Extended Franchise Metadata:** Introduced prequel, sequel, and source material resolution via TMDB and `basedon.media`.
- **Monochrome Display Style:** Added a minimalist black-and-white icon badge profile.
- **HTTP Optimizations:** Enabled HTTP keep-alive connection pooling and response compression.
- **Codebase Cleanup:** Removed obsolete scrapers and dead imports.

### v2.1.0

- **Scraper Consolidation:** Retired MediaStinger scraper following site closure.
- **Latency Improvements:** Tuned global timeouts to guarantee sub-10s worst-case resolution.

### v2.0.0

- **Sequel Setup Alerts:** Added support for AfterCredits sequel setup notifications.

### v1.6.0

- **Wikipedia Scraper:** Introduced Wikipedia post-credits list crawling.
- **Outtake Decoupling:** Separated bloopers and outtakes from narrative stingers.
- **Title Matching:** Enhanced title normalization and Levenshtein similarity scoring.

---

## License & Acknowledgements

This project is licensed under the [MIT License](LICENSE).

### Acknowledgements

- [Stremio](https://stremio.com) for the extensible media ecosystem.
- [AfterCredits](https://aftercredits.com) for comprehensive stinger reporting.
- [The Movie Database (TMDB)](https://www.themoviedb.org) for metadata, keywords, and collections.
- [Wikipedia](https://en.wikipedia.org) for public movie data records.
- [basedon.media](https://basedon.media) for literary and comic source references.
