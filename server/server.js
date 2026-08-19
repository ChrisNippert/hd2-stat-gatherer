const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 4000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    duration_ms INTEGER,
    squad_mode TEXT,
    difficulty TEXT,
    faction TEXT,
    planet TEXT,
    poi_counts TEXT NOT NULL,
    item_drops TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_missions_client ON missions(client_id);
`);

for (const stmt of [
  'ALTER TABLE missions ADD COLUMN duration_ms INTEGER',
  'ALTER TABLE missions ADD COLUMN squad_mode TEXT',
  'ALTER TABLE missions ADD COLUMN difficulty TEXT',
  'ALTER TABLE missions ADD COLUMN faction TEXT',
  'ALTER TABLE missions ADD COLUMN planet TEXT',
]) {
  try {
    db.exec(stmt);
  } catch {
    // column already exists on databases created before this field was added
  }
}

const upsertMission = db.prepare(`
  INSERT INTO missions (id, client_id, started_at, ended_at, duration_ms, squad_mode, difficulty, faction, planet, poi_counts, item_drops, created_at)
  VALUES ($id, $clientId, $startedAt, $endedAt, $durationMs, $squadMode, $difficulty, $faction, $planet, $poiCounts, $itemDrops, $createdAt)
  ON CONFLICT(id) DO UPDATE SET
    ended_at = excluded.ended_at,
    duration_ms = excluded.duration_ms,
    squad_mode = excluded.squad_mode,
    difficulty = excluded.difficulty,
    faction = excluded.faction,
    planet = excluded.planet,
    poi_counts = excluded.poi_counts,
    item_drops = excluded.item_drops
`);

const getMissionById = db.prepare('SELECT id, client_id FROM missions WHERE id = ?');

function rowToMission(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    squadMode: row.squad_mode,
    difficulty: row.difficulty,
    faction: row.faction,
    planet: row.planet,
    poiCounts: JSON.parse(row.poi_counts),
    itemDrops: JSON.parse(row.item_drops),
  };
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/missions', (req, res) => {
  const { clientId, mission } = req.body || {};
  if (!clientId || typeof clientId !== 'string') {
    return res.status(400).json({ error: 'clientId is required' });
  }
  if (!mission || !mission.id || !mission.startedAt) {
    return res.status(400).json({ error: 'mission with id and startedAt is required' });
  }
  const existing = getMissionById.get(mission.id);
  if (existing && existing.client_id !== clientId) {
    return res.status(403).json({ error: 'mission belongs to a different diver' });
  }
  upsertMission.run({
    $id: mission.id,
    $clientId: clientId,
    $startedAt: mission.startedAt,
    $endedAt: mission.endedAt ?? null,
    $durationMs: mission.durationMs ?? null,
    $squadMode: mission.squadMode ?? null,
    $difficulty: mission.difficulty ?? null,
    $faction: mission.faction ?? null,
    $planet: mission.planet ?? null,
    $poiCounts: JSON.stringify(mission.poiCounts || {}),
    $itemDrops: JSON.stringify(mission.itemDrops || {}),
    $createdAt: Date.now(),
  });
  res.json({ ok: true });
});

app.get('/api/missions', (req, res) => {
  const { clientId } = req.query;
  const rows = clientId
    ? db.prepare('SELECT * FROM missions WHERE client_id = ? ORDER BY started_at ASC').all(clientId)
    : db.prepare('SELECT * FROM missions ORDER BY started_at ASC').all();
  res.json({ missions: rows.map(rowToMission) });
});

app.delete('/api/missions/:id', (req, res) => {
  const { clientId } = req.query;
  if (!clientId || typeof clientId !== 'string') {
    return res.status(400).json({ error: 'clientId is required' });
  }
  const existing = getMissionById.get(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'mission not found' });
  }
  if (existing.client_id !== clientId) {
    return res.status(403).json({ error: 'mission belongs to a different diver' });
  }
  db.prepare('DELETE FROM missions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Drop-size denomination tallies — how much a single pickup of an item
// actually gave (e.g. Medals: 1, 2, or 3). Each row is one diver's observed
// count for one (item, denomination) pair; ownership is the primary key
// itself (client_id), so a client can only ever touch its own rows.
db.exec(`
  CREATE TABLE IF NOT EXISTS denominations (
    client_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    denom TEXT NOT NULL,
    count INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (client_id, item_id, denom)
  );
`);

const upsertDenom = db.prepare(`
  INSERT INTO denominations (client_id, item_id, denom, count, updated_at)
  VALUES ($clientId, $itemId, $denom, $count, $updatedAt)
  ON CONFLICT(client_id, item_id, denom) DO UPDATE SET
    count = excluded.count,
    updated_at = excluded.updated_at
`);

app.post('/api/denominations', (req, res) => {
  const { clientId, itemId, denom, count } = req.body || {};
  if (!clientId || typeof clientId !== 'string') {
    return res.status(400).json({ error: 'clientId is required' });
  }
  if (!itemId || denom === undefined || denom === null || !Number.isFinite(count)) {
    return res.status(400).json({ error: 'itemId, denom, and a numeric count are required' });
  }
  upsertDenom.run({
    $clientId: clientId,
    $itemId: String(itemId),
    $denom: String(denom),
    $count: count,
    $updatedAt: Date.now(),
  });
  res.json({ ok: true });
});

app.get('/api/denominations', (req, res) => {
  const { clientId } = req.query;
  const rows = clientId
    ? db.prepare('SELECT * FROM denominations WHERE client_id = ?').all(clientId)
    : db.prepare('SELECT * FROM denominations').all();
  res.json({
    denominations: rows.map((r) => ({
      clientId: r.client_id,
      itemId: r.item_id,
      denom: r.denom,
      count: r.count,
    })),
  });
});

app.delete('/api/denominations', (req, res) => {
  const { clientId, itemId, denom } = req.query;
  if (!clientId || !itemId || denom === undefined) {
    return res.status(400).json({ error: 'clientId, itemId, and denom are required' });
  }
  db.prepare('DELETE FROM denominations WHERE client_id = ? AND item_id = ? AND denom = ?').run(clientId, itemId, String(denom));
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Stat Gatherer server listening on port ${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
