## 2026-05-14 - Restricted CORS Policy
 **Vulnerability:** Overly permissive CORS policy in `server.js` allowed all origins (`*`) by default, potentially exposing the Stremio addon to unauthorized cross-origin requests.
 **Learning:** Default configurations in popular libraries like `cors` can lead to insecure deployments if not explicitly restricted to necessary origins. Enforcing HTTPS and whitelisting specific trusted domains is critical for security.
 **Prevention:** Implement a whitelist for CORS origins, enforce the HTTPS protocol, and validate the `Origin` header in a custom function to allow only trusted domains and non-browser clients.
## 2024-05-24 - Missing Server Errors Logging Sanitzation
 **Vulnerability:** console.error was directly logging e.message from external HTTP requests, which is vulnerable to log injection and sensitive API credential leakage (especially for TMDB api_key).
 **Learning:** When passing exception messages directly to a logger, we can easily expose api credentials or allow attackers to craft malicious multi-line log entries.
 **Prevention:** Implement a sanitizeError helper that strips newlines, carriage returns, and api credentials from the error messages, before sending them to the console.
## 2026-05-17 - Missing Security Headers
 **Vulnerability:** The application was missing essential security headers (e.g., Content-Security-Policy, X-Frame-Options), leaving the frontend configuration portal vulnerable to common web attacks like clickjacking and XSS.
 **Learning:** Even simple configuration portals need defense-in-depth mechanisms. Security headers provide a crucial layer of protection without requiring architectural changes.
 **Prevention:** Implement security headers globally using native Express middleware or libraries like Helmet. Configure CSP to explicitly allow only trusted sources for scripts, styles, and images.
## 2024-05-27 - SSRF and DoS Amplification in Aggregator APIs
 **Vulnerability:** The application lacks rate limiting on its endpoints. Because the service aggregates data from multiple external APIs concurrently (e.g., AfterCredits, TMDB, MediaStinger, Wikipedia), a single incoming request can trigger 4+ outbound network requests, allowing for Denial of Service and Server-Side Request Forgery amplification attacks.
 **Learning:** Aggregator services can multiply the impact of requests, meaning a lack of rate-limiting is disproportionately dangerous compared to a standard REST API.
 **Prevention:** Implement IP-based rate limiting on all public-facing endpoints (using tools like `express-rate-limit` or an in-memory Map) to restrict the number of requests a single client can make within a specific time window.
## 2024-05-24 - [Add explicit payload size limits]
**Vulnerability:** Express applications are vulnerable to Denial of Service (DoS) attacks if payload limits are not explicitly set for `express.json` and `express.urlencoded` middleware, as attackers can send extremely large request bodies that exhaust server memory.
**Learning:** Default configurations in Express middleware often do not have strict size limits. Explicit limits based on the application's expected request sizes (e.g., 10kb for simple configuration payloads) must be defined.
**Prevention:** Always configure `limit` options when using `express.json()` and `express.urlencoded()` to restrict the maximum allowed request body size.
## 2024-05-21 - SSRF Protocol Bypass
**Vulnerability:** The `validateUrl` function validated hostnames but did not explicitly allowlist URL protocols (like `http:` and `https:`).
**Learning:** URL objects can parse unexpected protocols (e.g., `file://`, `javascript://`) while still evaluating the hostname as "valid" against expected domains, potentially allowing SSRF bypass.
**Prevention:** Always explicitly allowlist permitted protocols (e.g., `http:` and `https:`) when validating user-supplied or dynamically parsed URLs to prevent alternative URI scheme exploitation.
