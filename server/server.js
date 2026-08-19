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
    poi_counts TEXT NOT NULL,
    item_drops TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_missions_client ON missions(client_id);
`);

for (const stmt of [
  'ALTER TABLE missions ADD COLUMN duration_ms INTEGER',
  'ALTER TABLE missions ADD COLUMN squad_mode TEXT',
]) {
  try {
    db.exec(stmt);
  } catch {
    // column already exists on databases created before this field was added
  }
}

const upsertMission = db.prepare(`
  INSERT INTO missions (id, client_id, started_at, ended_at, duration_ms, squad_mode, poi_counts, item_drops, created_at)
  VALUES ($id, $clientId, $startedAt, $endedAt, $durationMs, $squadMode, $poiCounts, $itemDrops, $createdAt)
  ON CONFLICT(id) DO UPDATE SET
    ended_at = excluded.ended_at,
    duration_ms = excluded.duration_ms,
    squad_mode = excluded.squad_mode,
    poi_counts = excluded.poi_counts,
    item_drops = excluded.item_drops
`);

function rowToMission(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    squadMode: row.squad_mode,
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
  upsertMission.run({
    $id: mission.id,
    $clientId: clientId,
    $startedAt: mission.startedAt,
    $endedAt: mission.endedAt ?? null,
    $durationMs: mission.durationMs ?? null,
    $squadMode: mission.squadMode ?? null,
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

app.listen(PORT, () => {
  console.log(`Stat Gatherer server listening on port ${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
