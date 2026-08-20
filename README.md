# Stat Gatherer

A field data terminal for tracking Helldivers 2 loot drop rates while you play, and pooling that data with other divers to get real crowd-sourced numbers.

- **Frontend**: plain HTML/CSS/JS (ES modules), no build step, no framework. Works fully offline via `localStorage`.
- **Backend** (optional): a small self-hosted Node.js + SQLite server for cross-device sync and global stats shared across "divers."

## Features

- **Mission tally**: a sticky **+ Add Minor Place of Interest** button stays pinned to the top of the screen so logging a find never means scrolling to the right Minor Place card — tap it (or tap **+1 FOUND** on a card itself) to say what you found, then walk straight through picking what was in each of its slots — the item, then (for Medals, Requisition, and Super Credits) the exact amount, repeating until it's full. A **Simplified** toggle in the header (next to the sync status, so it stays put no matter what page or layout you're on) switches this on or off: **on** is the tap-to-open-tiles-and-guided-flow behavior above; **off** shows every item's controls inline on the card already, and "+1 FOUND" just marks it found — no popup, tally it yourself. Flip it any time, on any screen size — it's not tied to mobile vs. desktop, just your preference. This is the only place drop sizes are entered, and it feeds Drop Sizes and Resource Value on the Stats page automatically. When you submit a mission, a quick popup asks whether you think you collected **all** Minor Places on the map for that run. Tally going sideways? **🗑 Clear (Don't Save)** next to "New Mission" discards the in-progress mission with no trace, instead of saving garbage. On first launch, a Helldivers-styled quick guide walks through the major controls.
- **Responsive layout**: above ~1300px wide, mission setup (Squad Mode, Difficulty, Faction, Planet, New Mission/Clear) sits in a sidebar next to the Minor Place cards. Below that — including a browser window snapped to half of a 1920px monitor — it tucks away behind a ☰ button instead of eating space above the cards, giving the live tally area the full width to lay out side by side; tap it to open, tap the ✕ or tap outside to close. In Simplified View, that's usually enough to see all 3 Minor Place cards on one screen with no scrolling at all; classic view's inline rows need more room per card, so it may still take a short scroll to reach the last one. On short phone screens specifically (roughly under ~740px tall), everything — header, nav, the toolbar, the cards — also tightens up (smaller padding/text, the panel hint text hidden), and in Simplified View each card collapses to just its name/count/**+1 FOUND** row plus a compact one-row strip of all 6 item icons with their counts (non-clickable, just a glance at what's in it so far — zeros included), so you don't lose track of what's been found without expanding (tap the ▾ to expand one and see its items directly, which also hides that strip) — the guided popup you get from **+1 FOUND** already walks through picking items one at a time, so the card's own item grid isn't needed to fit everything on one screen with zero scrolling. On a narrow phone specifically, the 3 collapsed cards also stretch to fill the rest of the screen instead of leaving empty space below them.
- **Squad mode tagging** (Solo / Solo + Warp Pack / Multiplayer), because Two-Man Bunkers can't be looted solo without a Warp Pack — tagging keeps that from silently skewing your drop-chance stats. Also tag a searchable Planet field (266 planets from the current galactic war map) — this taxonomy is fixed, not user-editable, see below.
- **Stats page**: bar charts and tables alongside the numbers — Minor Place frequency, resource yield (totals, % of drops, per mission), resource value, drop probability per Minor Place type (as a heatmap), and Drop Sizes (how much Medals/Requisition/Super Credits give per pickup — Medals: 1/2/3, Super Credits: 10/100, Requisition: 100/1000 — as counts and % of pickups). Minor Place frequency intentionally uses only missions marked as having collected **all** Minor Places on the map, so incomplete clears don't drag the map-spawn stats down. Everything else here is read-only reporting; Drop Sizes specifically isn't affected by the filters below, since pickup size isn't tied to squad mode/difficulty/faction/planet. Filter the rest by squad mode, difficulty, faction, and planet, all at once. "My Stats" (local) and "Global Stats" (everyone synced to your server) are separate tabs, and **Resource Value is calculated automatically** from Drop Sizes data (the crowd-pooled average when a server is set, your own otherwise, falling back to a seed default if nobody has any data yet) — there's no manual "value" number to set anywhere.
- **Mission Log page**: two tabs. **My Missions** — every mission you've saved, editable or deletable (edits/deletes sync to the server too, ownership-checked — you can only touch missions your own Diver ID submitted). **Global Missions** — every mission any diver has synced to the server, read-only, filterable by squad mode, difficulty, faction, planet, and how many Minor Places were found (Any/1+/3+/5+/10+) — open one to see exactly what it dropped, Minor Place by Minor Place, item by item.
- **JSON export/import** for backups, and a full local data reset if you want to start clean.
- **Local-first**: everything works with no server configured. A server only adds cross-device sync and global (multi-diver) stats — if it's down or unset, your own tallying and stats are unaffected.

## Fixed taxonomy

POI types, item types, difficulties, factions, planets, and Drop Size denominations are all **fixed and not user-editable** — nothing in the app's taxonomy can be added, renamed, or removed from the UI. This is deliberate: since everyone's data uses the same set of IDs and pickup-size buckets, Global Stats aggregation is always apples-to-apples, and the crowd-sourced Drop Size / Resource Value numbers stay meaningful.

## Running the frontend

It's static files — any local web server works (browsers block ES modules from `file://`):

```bash
cd stat-gatherer
python3 -m http.server 8080
```

Open `http://localhost:8080`. **Don't use this for real hosting** — it's a local-dev convenience only (no security hardening, and it'll serve everything in the directory tree, not just the app).

If you test from a second device by hitting this machine's LAN IP instead of `localhost` (e.g. `http://192.168.1.20:8080`), that's fine — the app has a fallback for browser APIs (like random ID generation) that only work in a "secure context" (HTTPS or `localhost` specifically), which a plain-HTTP LAN address isn't.

### Deploying

Push this repo and point any static host at the repo root — no build step needed:

- **GitHub Pages**: enable Pages on the branch, root directory.
- **Cloudflare Pages**: framework preset "None", build command empty, output directory `/`.

## Running the server (optional)

The app already ships pointed at a built-in shared public instance, so cross-device sync and Global Stats work out of the box with zero setup. Running your own server is only needed if you want a private instance instead — repoint `DEFAULT_SERVER_URL` in `js/state.js` if you want the client to talk somewhere else. Requires **Node.js ≥ 22.5** (uses the built-in `node:sqlite` module — no native compilation, no extra install steps beyond `npm install`).

```bash
cd stat-gatherer/server
npm install
PORT=4000 node server.js
```

Creates `server/data.db` next to it. If you repoint the client in code, use your server URL there. Your Diver ID (a random UUID, shown top-right) is your only "login" — no passwords. Paste an existing Diver ID into Settings on another device to pull that diver's synced history.

Keep it running persistently with `pm2` or a systemd unit rather than a foreground shell.

### Exposing it safely

The server has no password-based authentication — anyone with the URL can read all synced data and submit missions (an intentional tradeoff, no private data involved). It does check that edits/deletes to a mission come from the same Diver ID that created it, so one diver can't tamper with another's data, but there's no rate limiting, so it shouldn't be handed a wide-open port on the public internet if avoidable.

**Recommended: Cloudflare Tunnel.** Run `cloudflared` on the same box as the server; it makes an outbound-only connection to Cloudflare, so nothing needs to be port-forwarded and the server's IP/port are never directly reachable. You also get free HTTPS on a real subdomain this way. Plain Cloudflare DNS-proxying (orange-cloud pointing at your server's public IP) is weaker — the origin IP and port are still directly reachable if found, bypassing Cloudflare entirely.

If your frontend is served over HTTPS (GitHub Pages, Cloudflare Pages) but your server is plain HTTP, browsers will block the sync requests as mixed content — this is another reason to put the server behind Cloudflare (or another TLS-terminating proxy).

## Project structure

```
index.html          entry point (TALLY / STATS / MISSIONS pages — Drop Sizes is a read-only section within STATS)
css/style.css        Helldivers-styled UI (dark/yellow, angular panels, charts)
js/
  main.js            DOM rendering + event wiring
  state.js            localStorage-backed mission/history state
  stats.js            pure stat-computation functions (incl. value resolution)
  config.js            fixed POI/item/difficulty/faction/planet definitions
  api.js               fetch wrappers for the sync server
assets/icons/         item icons (Helldivers wiki assets + one hand-traced SVG)
server/
  server.js           Express + node:sqlite sync/global-stats API
  package.json
```

## Data model notes

- Everything is stored client-side in `localStorage`; the server's canonical dataset is the `missions` table, with each mission also carrying its own denomination breakdown for Drop Sizes / Resource Value. It doesn't hold any canonical taxonomy; global aggregation works because every client ships with the same fixed POI/item/difficulty/faction/planet IDs.
- A mission's `squadMode`/`difficulty`/`faction`/`planet` are blank (not guessed) on missions recorded before that field existed, distinguishable from an explicit answer. If old data ever needs bulk cleanup again, do it deliberately against the JSON data rather than with a permanent in-app backfill/re-tag surface.
