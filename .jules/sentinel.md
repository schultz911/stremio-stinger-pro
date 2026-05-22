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
## 2026-05-22 - SSRF Protocol Bypass
 **Vulnerability:** The `validateUrl` function lacked protocol validation, making it vulnerable to SSRF via arbitrary protocols like `javascript:` or `file:` that bypass simple hostname checks.
 **Learning:** Hostname validation is insufficient if the protocol is not explicitly restricted to HTTP/HTTPS, allowing attackers to exploit internal systems or trigger XSS using unexpected URI schemes.
 **Prevention:** Always validate the parsed URL's protocol explicitly against a whitelist (`http:` and `https:`) before executing network requests.
