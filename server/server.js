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
    all_minor_places_collected INTEGER NOT NULL DEFAULT 0,
    squad_mode TEXT,
    difficulty TEXT,
    faction TEXT,
    planet TEXT,
    poi_counts TEXT NOT NULL,
    item_drops TEXT NOT NULL,
    denom_counts TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_missions_client ON missions(client_id);
`);

for (const stmt of [
  'ALTER TABLE missions ADD COLUMN duration_ms INTEGER',
  'ALTER TABLE missions ADD COLUMN all_minor_places_collected INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE missions ADD COLUMN squad_mode TEXT',
  'ALTER TABLE missions ADD COLUMN difficulty TEXT',
  'ALTER TABLE missions ADD COLUMN faction TEXT',
  'ALTER TABLE missions ADD COLUMN planet TEXT',
  'ALTER TABLE missions ADD COLUMN denom_counts TEXT NOT NULL DEFAULT \'{}\'',
]) {
  try {
    db.exec(stmt);
  } catch {
    // column already exists on databases created before this field was added
  }
}

const upsertMission = db.prepare(`
  INSERT INTO missions (id, client_id, started_at, ended_at, duration_ms, all_minor_places_collected, squad_mode, difficulty, faction, planet, poi_counts, item_drops, denom_counts, created_at)
  VALUES ($id, $clientId, $startedAt, $endedAt, $durationMs, $allMinorPlacesCollected, $squadMode, $difficulty, $faction, $planet, $poiCounts, $itemDrops, $denomCounts, $createdAt)
  ON CONFLICT(id) DO UPDATE SET
    ended_at = excluded.ended_at,
    duration_ms = excluded.duration_ms,
    all_minor_places_collected = excluded.all_minor_places_collected,
    squad_mode = excluded.squad_mode,
    difficulty = excluded.difficulty,
    faction = excluded.faction,
    planet = excluded.planet,
    poi_counts = excluded.poi_counts,
    item_drops = excluded.item_drops,
    denom_counts = excluded.denom_counts
`);

const getMissionById = db.prepare('SELECT id, client_id FROM missions WHERE id = ?');

function rowToMission(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    allMinorPlacesCollected: !!row.all_minor_places_collected,
    squadMode: row.squad_mode,
    difficulty: row.difficulty,
    faction: row.faction,
    planet: row.planet,
    poiCounts: JSON.parse(row.poi_counts),
    itemDrops: JSON.parse(row.item_drops),
    denomCounts: JSON.parse(row.denom_counts || '{}'),
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
    $allMinorPlacesCollected: mission.allMinorPlacesCollected ? 1 : 0,
    $squadMode: mission.squadMode ?? null,
    $difficulty: mission.difficulty ?? null,
    $faction: mission.faction ?? null,
    $planet: mission.planet ?? null,
    $poiCounts: JSON.stringify(mission.poiCounts || {}),
    $itemDrops: JSON.stringify(mission.itemDrops || {}),
    $denomCounts: JSON.stringify(mission.denomCounts || {}),
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

app.listen(PORT, () => {
  console.log(`Stat Gatherer server listening on port ${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
