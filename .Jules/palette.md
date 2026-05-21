
## 2024-05-19 - Replace tooltips with inline text for touch accessibility
**Learning:** `title` attributes on DOM elements fail to provide reliable accessibility on mobile and touch devices because there is no way to simulate a 'hover' to trigger them. This means critical field dependency warnings (e.g. "Not applicable when Wiki is selected") become invisible to touch users.
**Action:** When communicating critical field states or form validation rules, always use explicitly visible inline subtext elements (e.g. `<span class="optional-text">`) combined with dynamic display logic rather than relying on `title` tooltips.
## 2025-01-28 - Avoid Fake Loading States for Protocol Redirects
**Learning:** Adding visual loading states with arbitrary timeouts (like `setTimeout`) is an anti-pattern when the underlying action is a synchronous protocol redirect (e.g., setting `window.location.href = 'stremio://...'`), as it misleadingly locks the UI without being tied to actual asynchronous work.
**Action:** Use CSS-based micro-interactions, like an `:active` scale transform, to provide immediate tactile feedback on buttons without requiring complex JavaScript state management.
