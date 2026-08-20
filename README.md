# Stat Gatherer

A field data terminal for tracking Helldivers 2 loot drop rates while you play, and pooling that data with other divers to get real crowd-sourced numbers.

- **Frontend**: plain HTML/CSS/JS (ES modules), no build step, no framework. Works fully offline via `localStorage`.
- **Backend** (optional): a small self-hosted Node.js + SQLite server for cross-device sync and global stats shared across "divers."

## Features

- **Mission tally**: a sticky quick-add bar (`+ Bunker` / `+ Container` / `+ Loot Pod`) stays pinned to the top of the screen so logging a find never means scrolling to the right POI's card — tap it, or tap **+1 FOUND** on the card itself, to log that you found one. A **Simplified View** toggle right next to "POINTS OF INTEREST" controls how tallying works: **on**, items are tap-to-open tiles and finding a container walks you straight through picking what was in each of its slots — the item, then (for Medals, Requisition, and Super Credits) the exact amount, repeating until it's full; **off**, every item's controls are already visible inline on the card and "+1 FOUND" just marks it found, no popup, tally it yourself. Flip it any time, on any screen size — it's not tied to mobile vs. desktop, just your preference. This is the only place drop sizes are entered, and it feeds Drop Sizes and Resource Value on the Stats page automatically. Tally going sideways? **🗑 Clear (Don't Save)** next to "New Mission" discards the in-progress mission with no trace, instead of saving garbage. Also tag Squad Mode, Difficulty, Faction, and a searchable Planet field (266 planets from the current galactic war map) — this taxonomy is fixed, not user-editable, see below.
- **Squad mode tagging** (Solo / Solo + Warp Pack / Multiplayer), because Two-Man Bunkers can't be looted solo without a Warp Pack — tagging keeps that from silently skewing your drop-chance stats. A **Re-tag Missions** tool and a **Backfill Existing Missions** tool in Settings let you bulk-relabel already-recorded data.
- **Stats page**: bar charts and tables alongside the numbers — POI frequency, resource yield (totals, % of drops, per mission), resource value, drop probability per POI type (as a heatmap), and Drop Sizes (how much Medals/Requisition/Super Credits give per pickup — Medals: 1/2/3, Super Credits: 10/100, Requisition: 100/1000 — as counts and % of pickups). Everything here is read-only reporting; Drop Sizes specifically isn't affected by the filters below, since pickup size isn't tied to squad mode/difficulty/faction/planet. Filter the rest by squad mode, difficulty, faction, and planet, all at once. "My Stats" (local) and "Global Stats" (everyone synced to your server) are separate tabs, and **Resource Value is calculated automatically** from Drop Sizes data (the crowd-pooled average when a server is set, your own otherwise, falling back to a seed default if nobody has any data yet) — there's no manual "value" number to set anywhere.
- **Mission Log page**: every saved mission, editable or deletable. Edits and deletes sync to the server too (ownership-checked — you can only touch missions your own Diver ID submitted).
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

The app already ships pointed at a shared public instance (`https://hd2stats.chrisnippert.com`) by default, so cross-device sync and Global Stats work out of the box with zero setup. Running your own server is only needed if you want a private instance instead — change it (or clear it to go fully offline) in Settings → Server. Requires **Node.js ≥ 22.5** (uses the built-in `node:sqlite` module — no native compilation, no extra install steps beyond `npm install`).

```bash
cd stat-gatherer/server
npm install
PORT=4000 node server.js
```

Creates `server/data.db` next to it. In the app: Settings → Server → enter `http://<host>:4000` → Save. Your Diver ID (a random UUID, shown top-right) is your only "login" — no passwords. Paste an existing Diver ID into Settings on another device to pull that diver's synced history.

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
  state.js            localStorage-backed mission/history/denom-tally state
  stats.js            pure stat-computation functions (incl. value resolution)
  config.js            fixed POI/item/difficulty/faction/planet definitions
  api.js               fetch wrappers for the sync server
assets/icons/         item icons (Helldivers wiki assets + one hand-traced SVG)
server/
  server.js           Express + node:sqlite sync/global-stats API
  package.json
```

## Data model notes

- Everything is stored client-side in `localStorage`; the server holds two tables — `missions` and `denominations` — both keyed so a diver can only write their own rows. It doesn't hold any canonical taxonomy; global aggregation works because every client ships with the same fixed POI/item/difficulty/faction/planet IDs.
- A mission's `squadMode`/`difficulty`/`faction`/`planet` are blank (not guessed) on missions recorded before that field existed, distinguishable from an explicit answer — use Backfill or Re-tag in Settings to fill them in once you know the real value.
