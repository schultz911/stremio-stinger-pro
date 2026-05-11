## 2026-05-11 - [Hardcoded TMDB API Key]
**Vulnerability:** Found a hardcoded TMDB API key (`DEFAULT_TMDB_KEY`) in `server.js`.
**Learning:** Hardcoded credentials can be leaked easily through version control and expose the application to abuse.
**Prevention:** Store credentials in environment variables (e.g., `process.env.TMDB_API_KEY`) and load them securely.
