## 2024-05-22 - Extract Uncached HTML Parsing Regex
 **Learning:** In JavaScript, extracting regular expressions with the global flag (`/g`) to module-level constants avoids redundant parsing and instantiation overhead when used inside frequently called functions or loops, as `String.prototype.replace()` safely resets the `lastIndex` on each call.
 **Action:** Always look for inline regex literals inside loops or frequently executed functions and extract them to module-scope constants.

## 2024-05-22 - Extract Regex Literals in String Utilities
**Learning:** In Node.js, extracting regular expressions with the global flag (`/g`) to module-level constants is safe for concurrent requests when used with `String.prototype.replace()`, as the method ignores and resets `lastIndex` for each operation, preventing state/race conditions.
**Action:** Extract uncached regex literals to the file scope to prevent unnecessary `RegExp` object allocations on every function call for performance gains.
