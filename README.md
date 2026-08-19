# Stat Gatherer

A field data terminal for tracking Helldivers 2 loot drop rates while you play. Tally Points of Interest and what they drop, and watch probabilities, resource yield, and per-hour rates build up in real time.

- **Frontend**: plain HTML/CSS/JS (ES modules), no build step, no framework. Works fully offline via `localStorage`.
- **Backend** (optional): a small self-hosted Node.js + SQLite server for cross-device sync and global stats shared across "divers."

## Features

- **Mission tally**: click to log each POI you find (Two-Man Bunker, Explodable Bunker, Loot Pod — slot counts and types are all configurable) and what dropped from it (Medals, Requisition Slips, Super Credits, Weapons — also configurable, with icons and a value multiplier each).
- **Mission timer** with pause/resume — paused time doesn't count toward duration or per-hour rates.
- **Squad mode tagging** (Solo / Solo + Warp Pack / Multiplayer) per mission, because Two-Man Bunkers can't be looted solo without a Warp Pack — tagging keeps that from silently skewing your drop-chance stats. A **Re-tag Missions** tool in Settings lets you bulk-relabel already-recorded data.
- **Stats**: POI frequency, resource yield (totals, % of drops, per mission, per hour/min/sec), resource value (using each item's configured value multiplier), and drop probability per POI type. A squad-mode filter applies to all of it. "My Stats" (local) and "Global Stats" (everyone synced to your server) are separate tabs.
- **Drop Size Tracker** (separate page): some items give a variable amount per pickup (e.g. Medals: 1-3, Requisition: sometimes a rare 1000). Tally the exact amount observed each time to compute a real empirical average, then push it into the Resource Value calculation with one click.
- **JSON export/import** for backups, and a full local data reset if you want to start clean.
- **Local-first**: everything works with no server configured. A server only adds cross-device sync and global (multi-diver) stats — if it's down or unset, your own tallying and stats are unaffected.

## Running the frontend

It's static files — any local web server works (browsers block ES modules from `file://`):

```bash
cd stat-gatherer
python3 -m http.server 8080
```

Open `http://localhost:8080`.

### Deploying

Push this repo and point any static host at the repo root — no build step needed:

- **GitHub Pages**: enable Pages on the branch, root directory.
- **Cloudflare Pages**: framework preset "None", build command empty, output directory `/`.

## Running the server (optional)

Needed only for cross-device sync and Global Stats. Requires **Node.js ≥ 22.5** (uses the built-in `node:sqlite` module — no native compilation, no extra install steps beyond `npm install`).

```bash
cd stat-gatherer/server
npm install
PORT=4000 node server.js
```

Creates `server/data.db` next to it. In the app: Settings → Server → enter `http://<host>:4000` → Save. Your Diver ID (a random UUID, shown top-right) is your only "login" — no passwords. Paste an existing Diver ID into Settings on another device to pull that diver's synced history.

Keep it running persistently with `pm2` or a systemd unit rather than a foreground shell.

### Exposing it safely

The server itself has no authentication — anyone with the URL can read all synced data and submit missions. That's an intentional tradeoff (no private data involved), but it does mean the server shouldn't be handed a wide-open port on the public internet if you can avoid it.

**Recommended: Cloudflare Tunnel.** Run `cloudflared` on the same box as the server; it makes an outbound-only connection to Cloudflare, so nothing needs to be port-forwarded and the server's IP/port are never directly reachable. You also get free HTTPS on a real subdomain this way. Plain Cloudflare DNS-proxying (orange-cloud pointing at your server's public IP) is weaker — the origin IP and port are still directly reachable if found, bypassing Cloudflare entirely.

If your frontend is served over HTTPS (GitHub Pages, Cloudflare Pages) but your server is plain HTTP, browsers will block the sync requests as mixed content — this is another reason to put the server behind Cloudflare (or another TLS-terminating proxy).

## Project structure

```
index.html          entry point
css/style.css        Helldivers-styled UI (dark/yellow, angular panels)
js/
  main.js            DOM rendering + event wiring
  state.js            localStorage-backed mission/history/config state
  stats.js            pure stat-computation functions
  config.js            POI/item type defaults, config load/save
  api.js               fetch wrappers for the sync server
assets/icons/         item icons (Helldivers wiki assets + one hand-traced SVG)
server/
  server.js           Express + node:sqlite sync/global-stats API
  package.json
```

## Data model notes

- Everything is stored client-side in `localStorage`; the server is a dumb mission store (it doesn't hold any canonical config) — POI/item type *IDs* are what get aggregated across divers for Global Stats, so custom types you add locally won't show up in other divers' data unless they add the same ones.
- A mission's `squadMode` and `durationMs` (pause-adjusted) are what stats/global-stats math actually use; missions recorded before those features existed are treated as "unlabeled" rather than guessed.
