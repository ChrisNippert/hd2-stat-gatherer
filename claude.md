# Stat Gatherer — project context

## Original brief

Track Helldivers 2 drop-rate stats while playing (super credits vs. requisition vs. medals vs. weapons), per mission, across Points of Interest (2-man bunkers = 3 slots, explodable bunkers = 2 slots, loot pods = 1 slot). Fast tally UI (+1 buttons) usable live during gameplay, "New Mission" saves and resets, per-hour/min/sec accumulation rates, Helldivers-2-styled UI. See README.md for the full current feature set — this file is oriented toward a future Claude session picking the project back up, not toward end users.

## Stack decisions and why

- **Vanilla HTML/CSS/JS, ES modules, no build step, no framework.** User wanted something GitHub-Pages-hostable and simple. Deliberately kept this way even as features grew — resist the urge to introduce a bundler/framework unless the user asks.
- **`node:sqlite` (Node's built-in module) instead of `better-sqlite3`.** `better-sqlite3` failed to install in this dev environment (no prebuilt binary for the Node version in use, and native compilation wasn't available). `node:sqlite` needs Node ≥ 22.5 but avoids native deps entirely — a better fit for "my own server" self-hosting anyway. If reintroducing a native dependency ever comes up, remember this failure mode.
- **No server-side canonical config.** The server (`server/server.js`) is a dumb mission store — it just persists whatever `poiCounts`/`itemDrops`/`squadMode` a client sends, keyed by mission ID (upsert). Aggregation across divers for Global Stats works because POI/item *IDs* (e.g. `loot_pod`, `medals`) are assumed consistent across clients, not because the server enforces a shared taxonomy. Custom item/POI types a user adds locally are effectively private to their own stats unless another diver happens to add the identical ID.
- **No authentication.** Diver ID is a random client-generated UUID, no password. This was an explicit user choice ("no private data, security isn't super important"). Don't add auth/accounts unprompted — if asked to hardn the server, the agreed-upon cheap mitigation (not yet implemented) was a shared-secret header check on the POST endpoint, plus recommending Cloudflare Tunnel over direct port-forwarding for exposure safety.

## Things that look like bugs but aren't

- `assets/icons/*.webp` files have a `.webp` extension and *are* WebP despite originally being fetched from URLs ending in `.png` — Fandom's CDN serves WebP regardless of the URL's apparent extension. Already renamed correctly; don't re-fetch and re-save as literal PNG.
- Icon images are cropped tight to their non-transparent content (see git history around the "requisition icon looks weirdly offset" fix) — the source wiki images had huge transparent padding that broke consistent sizing. If replacing an icon asset, crop it the same way (Pillow `.getbbox()` + crop) or sizing will look inconsistent again.
- `js/main.js` wires nearly all DOM event listeners through an `on(id, event, handler)` helper (and init steps through `safe(fn, label)`) instead of raw `el(id).addEventListener(...)`. This is deliberate, not incidental — a stale cached `index.html` paired with a freshly-fetched `main.js` (normal during a rollout) previously caused a single missing element to throw and silently abort the entire script before `init()` ran, blanking the whole page. Keep new top-level listener wiring going through `on()`/`safe()`.
- Mission `durationMs` is the pause-adjusted active time, not `endedAt - startedAt`. Stats math (`stats.js`) prefers `durationMs` and only falls back to the raw timestamp delta for missions recorded before pause support existed.
- `squadMode` on a mission can be `'solo' | 'solo_warp' | 'multiplayer' | 'unknown'` — `'unknown'` specifically means "recorded before squad-mode tracking existed," not "guessed solo." Don't default missing squadMode to `'solo'`; that was a deliberate choice so old data doesn't get silently mislabeled. The user later used the Settings → Re-tag Missions tool to manually bulk-relabel their own unlabeled history once they confirmed it was actually all solo.
- Item `value` (used for Resource Value stats) is a user-editable average, not a game constant — it can come from a manual guess or from the Drop Size Tracker's empirical average ("Use X.XX as Resource Value" button). Don't hardcode or "correct" these numbers based on assumed game knowledge; they're calibrated by the user's own observed data.

## Testing approach used so far

No test framework is set up. Verification during development has been: `node --check` for syntax, and ad hoc jsdom-based smoke scripts (see conversation history / recreate as needed — none are checked into the repo) that load `index.html` + `main.js` into a JSDOM instance with a real local `server.js` running against a temp SQLite file, then simulate clicks and assert on rendered HTML. `chromium-cli`/Playwright were not available in the dev sandbox this was built in; if they're available in a future session, prefer real browser automation over the jsdom approach.

## Known non-goals / explicitly deferred

- Server-side auth/rate-limiting: discussed, not implemented (user's threat model doesn't currently call for it; Cloudflare Tunnel was the agreed mitigation for exposure instead of app-level auth).
- Drop Size Tracker denomination tallies are **not** synced to the server, unlike missions — local-only for now. Would follow the same upload pattern as missions if requested.
- No automated test suite exists; see "Testing approach" above before assuming one can just be run.
