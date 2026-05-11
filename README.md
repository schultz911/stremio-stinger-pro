![logo](/icon.png)

# Stremio Stinger Pro
**Version 1.6.5**

Stremio Stinger Pro is a high-speed Stremio addon that detects mid-credit scenes, post-credit scenes, and blooper reels before you finish watching a movie. It integrates directly into your stream list with customizable display configurations.

`https://stremio-addons.net/addons/stremio-stinger-pro`

## Upcoming Features
- [ ] Add option to see sequel setup stingers.

---

## Table of Contents
* [⚙️ What It Does](#️-what-it-does)
* [📡 Data Sources](#-data-sources)
* [🌍 Configuration and Installation](#-configuration-and-installation)
* [🚀 Deployment Details](#-deployment-details)

[Latest Release: v1.6.5](#release-v165)

---

## ⚙️ What It Does
* **Positive-First Race Logic:** Simultaneously queries multiple data sources and resolves instantly the millisecond a stinger is confirmed, bypassing slower network requests for maximum speed.
* **Strict Blooper Isolation:** Automatically distinguishes between narrative stingers and outtake reels. Bloopers are clearly flagged and will no longer trigger false-positive "Mid-Credit" alerts.
* **Tier 3 Wikipedia Fallback:** Utilizes an auto-updating, O(1) in-memory index of Wikipedia's post-credit database to instantly catch obscure films if primary scrapers fail.
* **Dual Display Modes:** Choose between "Colorful" (emoji-based visual flags) or "Simple" (clean text output).
* **Interactive Configuration:** A web-based `/configure` portal allows users to toggle blooper tracking, hide/show data sources, input custom TMDB API keys, and view a live preview of the stream output.
* **Configuration-Aware Caching:** Stream results are cached efficiently based on your exact URL parameters, preventing conflicting data across different user preferences.

## 📡 Data Sources
The addon queries the following databases simultaneously. Results are prioritized based on the fidelity of the data provided:

1. **AfterCredits.com:** Provides explicit confirmation of mid/post-credit scenes via direct web scraping.
2. **MediaStinger.com:** Provides binary yes/no confirmations.
3. **The Movie Database (TMDB):** Scans movie metadata for specific stinger keywords (`duringcreditsstinger`, `aftercreditsstinger`). The addon utilizes a community API key by default, but users can provide a personal v3 API key for dedicated rate limits.
4. **Wikipedia:** Ultimate fallback. Built a lightning-fast, auto-updating Wikipedia index. If the primary scrapers can't find info on an obscure movie, the Wikipedia fallback kicks in instantly as a final safety net. 

**⚠️ Note:** Wikipedia doesn't classify after-credit scenes as mid- or post-credits scenes and hence results from Wikipedia will be called out exclusively as *unknown*.

## 🌍 Configuration and Installation
**🚨 Note for existing users:** Because v1.6.0 introduces new configuration parameters in the installation URL, you must uninstall any previous versions of Stremio Stinger Pro from your Stremio client before upgrading.

### Environment Variables
You must set the `TMDB_API_KEY` environment variable with your personal TMDB API key before starting the server.
```bash
export TMDB_API_KEY="your_api_key_here"
```

1.  Navigate to `https://stremio-stinger-pro.onrender.com/configure`
2.  Select your preferred display style (Colorful or Simple).
3.  Toggle the checkboxes to include/exclude source attribution and bloopers.
4.  (Optional) Enter your personal TMDB API key to prevent rate-limiting.
5.  Click **Install** to open Stremio and add the configuration, or copy the generated Manifest URL to add it manually.

## 🚀 Development
### Tech Stack
* **Node.js / Express:** Core server framework.
* **Axios:** HTTP client for API and HTML fetching.
* **Cheerio:** High-speed DOM parsing for web scraping.
### Deployment
* **Hosting:** Deployed via a continuous Node.js container on Render (Free Tier).
* **Keep-Alive:** The server is maintained in an active state via scheduled Cronjobs to prevent cold-start delays.

---

## Release: v1.6.5
* **Feature:** Added more preview options.
* **Fix:** Redefined core scraping and fallback logic.

---

## Release: v1.6.0
* **Feature:** Added configuration checkboxes to toggle the detection of Bloopers/Outtakes (-bloopers).
* **Feature:** Added Wikipedia's "List of films with post-credits scenes" as a new data source. It uses a blazing-fast O(1) in-memory indexer that pre-compiles every 24 hours, acting as a highly efficient fallback for post-credit detection without slowing down the server.
* **Feature:** Updated the high-speed "Positive-First" promise racing architecture to resolve instantly upon finding a true stinger, but safely holds Blooper/Outtake data as a fallback while waiting for slower sources to finish.
* **Feature:** The internal streamCache now generates composite keys based on the user's specific URL suffix (e.g., tt0120812_colorful-bloopers). This prevents users with different settings from polluting each other's cache.
* **Feature:** Added strict Cache-Control HTTP headers (max-age=0, no-cache) to the /stream/ endpoints. This forces the Stremio client to pull fresh data immediately when users update their configuration URL, bypassing Stremio's aggressive local caching.
* **Fix:** Decoupled bloopers from mid-credit scenes. If a blooper reel or outtake is detected by any scraper, the "Mid-Credits" flag is forcefully stripped to prevent outtakes from masquerading as narrative stingers.
* **Fix:** Upgraded the MediaStinger scraper to navigate to the actual movie payload page (Tier 2) rather than relying on the search page. This stops MediaStinger from blindly flagging blooper reels as "During Credits" scenes.
* **Fix:** Fixed lexical matching bugs that caused false negatives for movies with leading/trailing articles or punctuation (e.g., The Cannonball Run vs Cannonball Run, The).
* **Fix:** Fixed a logical fallacy where the addon assumed a lack of TMDB keywords meant a movie definitely had no stinger. TMDB is now correctly treated as a positive-tag-only database.

---

## Release: v1.5.0
* **Feature:** Added a dropdown to the /configure portal allowing users to select their preferred stream display style:
* **Feature:** Added a dynamic preview container to the /configure portal that instantly updates to show exactly how the stream will look in Stremio based on selected settings.
* **Feature:** Added a checkbox option allowing users to hide or show the data source attribution (e.g., "Source: TMDB") in the Stremio UI.
* **Fix:** Implemented a backward-compatible URL "style suffix" architecture (-nosource) to pass boolean toggle states to the server without breaking existing client API integrations or routing layers.
* **Fix:** Removed hardcoded UI strings from the scraping functions. Scrapers now return strict, raw boolean states (mid, post, no).
* **Fix:** The streamHandler now interpolates the final output string at runtime based on the user's requested display style.
* **Fix:** Updated the in-memory streamCache to store the raw boolean objects rather than pre-compiled strings, preventing cross-configuration memory leakage between "simple" and "colorful" users.
* **Fix:** Expanded Express routes to dynamically handle compound parameters (/:style/:apiKey/manifest.json) alongside legacy URL structures.

---

## Release: v1.4.0
* **Feature:** Implemented parallel source racing logic to bypass slow target servers.
* **Feature:** Added a fallback community TMDB API key.
* **Feature:** Added an in-memory caching layer (Max: 1000 items, TTL: 6 hours) to prevent OOM crashes and optimize speed.
* **Fix:** Relaxed strict title matching to resolve false negatives on AfterCredits.
* **Fix:** Updated UI stream titles to standard nomenclature for better UX.
