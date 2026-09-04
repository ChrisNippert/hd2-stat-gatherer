const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const PARTY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PARTY_CODE_LENGTH = 6;

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    host_client_id TEXT,
    party_code TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    duration_ms INTEGER,
    all_minor_places_collected INTEGER NOT NULL DEFAULT 0,
    squad_mode TEXT,
    difficulty TEXT,
    mission_type TEXT,
    faction TEXT,
    planet TEXT,
    city_type TEXT,
    poi_counts TEXT NOT NULL,
    item_drops TEXT NOT NULL,
    denom_counts TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_missions_client ON missions(client_id);

  CREATE TABLE IF NOT EXISTS mission_participants (
    mission_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    PRIMARY KEY (mission_id, client_id)
  );
  CREATE INDEX IF NOT EXISTS idx_mission_participants_client ON mission_participants(client_id);

  CREATE TABLE IF NOT EXISTS party_sessions (
    code TEXT PRIMARY KEY,
    host_client_id TEXT NOT NULL,
    host_member_id TEXT NOT NULL,
    current_mission_id TEXT NOT NULL,
    current_started_at INTEGER NOT NULL,
    mission_meta TEXT NOT NULL DEFAULT '{}',
    last_finalized_mission_id TEXT,
    last_finalized_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS party_members (
    member_id TEXT PRIMARY KEY,
    party_code TEXT NOT NULL,
    member_token TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    is_host INTEGER NOT NULL DEFAULT 0,
    is_ready INTEGER NOT NULL DEFAULT 0,
    joined_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (party_code, client_id)
  );
  CREATE INDEX IF NOT EXISTS idx_party_members_code ON party_members(party_code);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_party_members_code_token ON party_members(party_code, member_token);

  CREATE TABLE IF NOT EXISTS party_submissions (
    party_code TEXT NOT NULL,
    member_id TEXT NOT NULL,
    mission_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (party_code, member_id)
  );
  CREATE INDEX IF NOT EXISTS idx_party_submissions_code ON party_submissions(party_code);
`);

for (const stmt of [
  'ALTER TABLE missions ADD COLUMN duration_ms INTEGER',
  'ALTER TABLE missions ADD COLUMN all_minor_places_collected INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE missions ADD COLUMN squad_mode TEXT',
  'ALTER TABLE missions ADD COLUMN difficulty TEXT',
  'ALTER TABLE missions ADD COLUMN mission_type TEXT',
  'ALTER TABLE missions ADD COLUMN faction TEXT',
  'ALTER TABLE missions ADD COLUMN planet TEXT',
  'ALTER TABLE missions ADD COLUMN city_type TEXT',
  'ALTER TABLE missions ADD COLUMN denom_counts TEXT NOT NULL DEFAULT \'{}\'',
  'ALTER TABLE missions ADD COLUMN host_client_id TEXT',
  'ALTER TABLE missions ADD COLUMN party_code TEXT',
]) {
  try {
    db.exec(stmt);
  } catch {
    // column already exists on databases created before this field was added
  }
}

db.exec('CREATE INDEX IF NOT EXISTS idx_missions_party_code ON missions(party_code)');

function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function generatePartyCode() {
  let code = '';
  for (let i = 0; i < PARTY_CODE_LENGTH; i += 1) {
    code += PARTY_CODE_ALPHABET[(Math.random() * PARTY_CODE_ALPHABET.length) | 0];
  }
  return code;
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

function defaultDisplayName(clientId) {
  const shortId = String(clientId || '').slice(0, 8) || 'unknown';
  return `Diver ${shortId}`;
}

function missionMetaFromPayload(mission) {
  return {
    squadMode: typeof mission?.squadMode === 'string' ? mission.squadMode : '',
    difficulty: typeof mission?.difficulty === 'string' ? mission.difficulty : '',
    missionType: typeof mission?.missionType === 'string' ? mission.missionType : '',
    faction: typeof mission?.faction === 'string' ? mission.faction : '',
    planet: typeof mission?.planet === 'string' ? mission.planet : '',
    cityType: typeof mission?.cityType === 'string' ? mission.cityType : '',
  };
}

function missionTalliesFromPayload(mission) {
  return {
    poiCounts: mission && typeof mission.poiCounts === 'object' ? mission.poiCounts : {},
    itemDrops: mission && typeof mission.itemDrops === 'object' ? mission.itemDrops : {},
    denomCounts: mission && typeof mission.denomCounts === 'object' ? mission.denomCounts : {},
  };
}

function rowToMission(row, viewerClientId = '') {
  return {
    id: row.id,
    clientId: row.client_id,
    hostClientId: row.host_client_id || row.client_id,
    partyCode: row.party_code || '',
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    allMinorPlacesCollected: !!row.all_minor_places_collected,
    squadMode: row.squad_mode,
    difficulty: row.difficulty,
    missionType: row.mission_type,
    faction: row.faction,
    planet: row.planet,
    cityType: row.city_type,
    poiCounts: JSON.parse(row.poi_counts),
    itemDrops: JSON.parse(row.item_drops),
    denomCounts: JSON.parse(row.denom_counts || '{}'),
    editable: !!viewerClientId && row.client_id === viewerClientId,
  };
}

function partyPublicMember(member) {
  return {
    memberId: member.member_id,
    displayName: member.display_name,
    clientIdShort: String(member.client_id || '').slice(0, 8),
    isHost: !!member.is_host,
    isReady: !!member.is_ready,
  };
}

function isPartyMemberEffectivelyReady(member) {
  return !!member.is_host || !!member.is_ready;
}

function partyToResponse(sessionRow, viewerRow) {
  const members = listPartyMembers.all(sessionRow.code);
  const readyCount = members.filter((member) => !member.is_host && !!member.is_ready).length;
  return {
    code: sessionRow.code,
    currentMissionId: sessionRow.current_mission_id,
    currentStartedAt: sessionRow.current_started_at,
    missionMeta: JSON.parse(sessionRow.mission_meta || '{}'),
    lastFinalizedMissionId: sessionRow.last_finalized_mission_id || '',
    lastFinalizedAt: sessionRow.last_finalized_at || null,
    readyCount,
    totalMembers: members.length,
    me: {
      memberId: viewerRow.member_id,
      displayName: viewerRow.display_name,
      clientId: viewerRow.client_id,
      isHost: !!viewerRow.is_host,
      isReady: !!viewerRow.is_ready,
    },
    members: members.map(partyPublicMember),
  };
}

function addCounts(target, source) {
  Object.entries(source || {}).forEach(([key, rawValue]) => {
    const value = Number(rawValue) || 0;
    target[key] = (Number(target[key]) || 0) + value;
  });
}

function addNestedCounts(target, source) {
  Object.entries(source || {}).forEach(([outerKey, innerValue]) => {
    if (!target[outerKey] || typeof target[outerKey] !== 'object') target[outerKey] = {};
    addCounts(target[outerKey], innerValue || {});
  });
}

function addTripleNestedCounts(target, source) {
  Object.entries(source || {}).forEach(([firstKey, secondMap]) => {
    if (!target[firstKey] || typeof target[firstKey] !== 'object') target[firstKey] = {};
    Object.entries(secondMap || {}).forEach(([secondKey, thirdMap]) => {
      if (!target[firstKey][secondKey] || typeof target[firstKey][secondKey] !== 'object') {
        target[firstKey][secondKey] = {};
      }
      addCounts(target[firstKey][secondKey], thirdMap || {});
    });
  });
}

function mergeSubmissionTallies(submissions) {
  const merged = { poiCounts: {}, itemDrops: {}, denomCounts: {} };
  submissions.forEach((submission) => {
    const tallies = missionTalliesFromPayload(JSON.parse(submission.mission_json));
    addCounts(merged.poiCounts, tallies.poiCounts);
    addNestedCounts(merged.itemDrops, tallies.itemDrops);
    addTripleNestedCounts(merged.denomCounts, tallies.denomCounts);
  });
  return merged;
}

function upsertMissionRow(clientId, mission, extras = {}) {
  upsertMission.run({
    $id: mission.id,
    $clientId: clientId,
    $hostClientId: extras.hostClientId ?? null,
    $partyCode: extras.partyCode ?? null,
    $startedAt: mission.startedAt,
    $endedAt: mission.endedAt ?? null,
    $durationMs: mission.durationMs ?? null,
    $allMinorPlacesCollected: mission.allMinorPlacesCollected ? 1 : 0,
    $squadMode: mission.squadMode ?? null,
    $difficulty: mission.difficulty ?? null,
    $missionType: mission.missionType ?? null,
    $faction: mission.faction ?? null,
    $planet: mission.planet ?? null,
    $cityType: mission.cityType ?? null,
    $poiCounts: JSON.stringify(mission.poiCounts || {}),
    $itemDrops: JSON.stringify(mission.itemDrops || {}),
    $denomCounts: JSON.stringify(mission.denomCounts || {}),
    $createdAt: Date.now(),
  });
}

function replaceMissionParticipants(missionId, clientIds) {
  deleteMissionParticipants.run(missionId);
  Array.from(new Set(clientIds.filter(Boolean))).forEach((participantClientId) => {
    insertMissionParticipant.run(missionId, participantClientId);
  });
}

function getPartyAccess(code, memberToken) {
  const normalizedCode = normalizeCode(code);
  const session = getPartySessionByCode.get(normalizedCode);
  if (!session) return { code: normalizedCode, status: 404 };
  const member = getPartyMemberByCodeAndToken.get(normalizedCode, String(memberToken || ''));
  if (!member) return { code: normalizedCode, session, status: 403 };
  return { code: normalizedCode, session, member, status: 200 };
}

const upsertMission = db.prepare(`
  INSERT INTO missions (
    id,
    client_id,
    host_client_id,
    party_code,
    started_at,
    ended_at,
    duration_ms,
    all_minor_places_collected,
    squad_mode,
    difficulty,
    mission_type,
    faction,
    planet,
    city_type,
    poi_counts,
    item_drops,
    denom_counts,
    created_at
  )
  VALUES (
    $id,
    $clientId,
    $hostClientId,
    $partyCode,
    $startedAt,
    $endedAt,
    $durationMs,
    $allMinorPlacesCollected,
    $squadMode,
    $difficulty,
    $missionType,
    $faction,
    $planet,
    $cityType,
    $poiCounts,
    $itemDrops,
    $denomCounts,
    $createdAt
  )
  ON CONFLICT(id) DO UPDATE SET
    ended_at = excluded.ended_at,
    duration_ms = excluded.duration_ms,
    all_minor_places_collected = excluded.all_minor_places_collected,
    squad_mode = excluded.squad_mode,
    difficulty = excluded.difficulty,
    mission_type = excluded.mission_type,
    faction = excluded.faction,
    planet = excluded.planet,
    city_type = excluded.city_type,
    poi_counts = excluded.poi_counts,
    item_drops = excluded.item_drops,
    denom_counts = excluded.denom_counts,
    host_client_id = excluded.host_client_id,
    party_code = excluded.party_code
`);

const getMissionById = db.prepare('SELECT id, client_id FROM missions WHERE id = ?');
const getMissionRowById = db.prepare('SELECT * FROM missions WHERE id = ?');
const getMissionRowsByClient = db.prepare(`
  SELECT DISTINCT m.*
  FROM missions m
  LEFT JOIN mission_participants mp ON mp.mission_id = m.id
  WHERE m.client_id = ? OR mp.client_id = ?
  ORDER BY m.started_at ASC
`);
const getAllMissionRows = db.prepare('SELECT * FROM missions ORDER BY started_at ASC');
const deleteMissionParticipants = db.prepare('DELETE FROM mission_participants WHERE mission_id = ?');
const insertMissionParticipant = db.prepare('INSERT OR IGNORE INTO mission_participants (mission_id, client_id) VALUES (?, ?)');
const listMissionParticipants = db.prepare('SELECT client_id FROM mission_participants WHERE mission_id = ?');

const insertPartySession = db.prepare(`
  INSERT INTO party_sessions (
    code,
    host_client_id,
    host_member_id,
    current_mission_id,
    current_started_at,
    mission_meta,
    last_finalized_mission_id,
    last_finalized_at,
    created_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
`);
const getPartySessionByCode = db.prepare('SELECT * FROM party_sessions WHERE code = ?');
const updatePartySessionMeta = db.prepare('UPDATE party_sessions SET mission_meta = ?, updated_at = ? WHERE code = ?');
const updatePartySessionAfterFinalize = db.prepare(`
  UPDATE party_sessions
  SET current_mission_id = ?, current_started_at = ?, last_finalized_mission_id = ?, last_finalized_at = ?, updated_at = ?
  WHERE code = ?
`);
const deletePartySessionByCode = db.prepare('DELETE FROM party_sessions WHERE code = ?');

const insertPartyMember = db.prepare(`
  INSERT INTO party_members (member_id, party_code, member_token, client_id, display_name, is_host, is_ready, joined_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
`);
const getPartyMemberByCodeAndToken = db.prepare('SELECT * FROM party_members WHERE party_code = ? AND member_token = ?');
const getPartyMemberByCodeAndClient = db.prepare('SELECT * FROM party_members WHERE party_code = ? AND client_id = ?');
const getPartyMemberByCodeAndId = db.prepare('SELECT * FROM party_members WHERE party_code = ? AND member_id = ?');
const listPartyMembers = db.prepare('SELECT * FROM party_members WHERE party_code = ? ORDER BY is_host DESC, joined_at ASC');
const updatePartyMemberRejoin = db.prepare(`
  UPDATE party_members
  SET member_token = ?, display_name = ?, updated_at = ?
  WHERE party_code = ? AND client_id = ?
`);
const updatePartyMemberReady = db.prepare('UPDATE party_members SET is_ready = ?, updated_at = ? WHERE party_code = ? AND member_id = ?');
const clearPartyMemberReadiness = db.prepare('UPDATE party_members SET is_ready = 0, updated_at = ? WHERE party_code = ?');
const deletePartyMemberById = db.prepare('DELETE FROM party_members WHERE party_code = ? AND member_id = ?');
const deletePartyMembersByCode = db.prepare('DELETE FROM party_members WHERE party_code = ?');

const upsertPartySubmission = db.prepare(`
  INSERT INTO party_submissions (party_code, member_id, mission_json, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(party_code, member_id) DO UPDATE SET
    mission_json = excluded.mission_json,
    updated_at = excluded.updated_at
`);
const deletePartySubmissionByMember = db.prepare('DELETE FROM party_submissions WHERE party_code = ? AND member_id = ?');
const deletePartySubmissionsByCode = db.prepare('DELETE FROM party_submissions WHERE party_code = ?');
const listPartySubmissions = db.prepare('SELECT * FROM party_submissions WHERE party_code = ?');

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
  const existingRow = existing ? getMissionRowById.get(mission.id) : null;
  upsertMissionRow(clientId, mission, {
    hostClientId: existingRow?.host_client_id || null,
    partyCode: existingRow?.party_code || null,
  });
  const participantIds = existingRow?.party_code
    ? listMissionParticipants.all(mission.id).map((row) => row.client_id)
    : [clientId];
  participantIds.push(clientId);
  replaceMissionParticipants(mission.id, participantIds);
  res.json({ ok: true });
});

app.get('/api/missions', (req, res) => {
  const { clientId } = req.query;
  const rows = clientId
    ? getMissionRowsByClient.all(clientId, clientId)
    : getAllMissionRows.all();
  res.json({ missions: rows.map((row) => rowToMission(row, typeof clientId === 'string' ? clientId : '')) });
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
  deleteMissionParticipants.run(req.params.id);
  db.prepare('DELETE FROM missions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/parties', (req, res) => {
  const { clientId, displayName, mission } = req.body || {};
  if (!clientId || typeof clientId !== 'string') {
    return res.status(400).json({ error: 'clientId is required' });
  }
  const now = Date.now();
  const memberId = generateId();
  const memberToken = generateId();
  const missionId = mission?.id || generateId();
  const missionStartedAt = mission?.startedAt || now;
  const meta = missionMetaFromPayload(mission);

  let code = '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    code = generatePartyCode();
    if (!getPartySessionByCode.get(code)) break;
    code = '';
  }
  if (!code) {
    return res.status(500).json({ error: 'could not allocate party code' });
  }

  insertPartySession.run(code, clientId, memberId, missionId, missionStartedAt, JSON.stringify(meta), now, now);
  insertPartyMember.run(memberId, code, memberToken, clientId, String(displayName || defaultDisplayName(clientId)), 1, now, now);
  const session = getPartySessionByCode.get(code);
  const member = getPartyMemberByCodeAndToken.get(code, memberToken);
  res.status(201).json({ ok: true, memberToken, party: partyToResponse(session, member) });
});

app.post('/api/parties/join', (req, res) => {
  const code = normalizeCode(req.body?.code);
  const clientId = req.body?.clientId;
  const displayName = String(req.body?.displayName || defaultDisplayName(clientId));
  if (!code) return res.status(400).json({ error: 'party code is required' });
  if (!clientId || typeof clientId !== 'string') {
    return res.status(400).json({ error: 'clientId is required' });
  }
  const session = getPartySessionByCode.get(code);
  if (!session) {
    return res.status(404).json({ error: 'party not found' });
  }
  const now = Date.now();
  const memberToken = generateId();
  let member = getPartyMemberByCodeAndClient.get(code, clientId);
  if (member) {
    updatePartyMemberRejoin.run(memberToken, displayName, now, code, clientId);
    member = getPartyMemberByCodeAndToken.get(code, memberToken);
  } else {
    const memberId = generateId();
    insertPartyMember.run(memberId, code, memberToken, clientId, displayName, 0, now, now);
    member = getPartyMemberByCodeAndToken.get(code, memberToken);
  }
  res.json({ ok: true, memberToken, party: partyToResponse(session, member) });
});

app.get('/api/parties/:code', (req, res) => {
  const access = getPartyAccess(req.params.code, req.query.memberToken);
  if (access.status === 404) return res.status(404).json({ error: 'party not found' });
  if (access.status === 403) return res.status(403).json({ error: 'party membership is invalid' });
  res.json({ ok: true, party: partyToResponse(access.session, access.member) });
});

app.post('/api/parties/:code/mission', (req, res) => {
  const access = getPartyAccess(req.params.code, req.body?.memberToken);
  if (access.status === 404) return res.status(404).json({ error: 'party not found' });
  if (access.status === 403) return res.status(403).json({ error: 'party membership is invalid' });
  if (!access.member.is_host) {
    return res.status(403).json({ error: 'only the host can update party mission labels' });
  }
  const meta = missionMetaFromPayload(req.body?.missionMeta || {});
  updatePartySessionMeta.run(JSON.stringify(meta), Date.now(), access.code);
  const session = getPartySessionByCode.get(access.code);
  res.json({ ok: true, party: partyToResponse(session, access.member) });
});

app.post('/api/parties/:code/ready', (req, res) => {
  const access = getPartyAccess(req.params.code, req.body?.memberToken);
  if (access.status === 404) return res.status(404).json({ error: 'party not found' });
  if (access.status === 403) return res.status(403).json({ error: 'party membership is invalid' });
  const ready = !!req.body?.ready;
  const now = Date.now();
  if (ready) {
    const mission = req.body?.mission;
    if (!mission || mission.id !== access.session.current_mission_id) {
      return res.status(409).json({ error: 'your tally belongs to an older mission round; refresh the party state first' });
    }
    upsertPartySubmission.run(access.code, access.member.member_id, JSON.stringify(mission), now);
    updatePartyMemberReady.run(1, now, access.code, access.member.member_id);
  } else {
    deletePartySubmissionByMember.run(access.code, access.member.member_id);
    updatePartyMemberReady.run(0, now, access.code, access.member.member_id);
  }
  const session = getPartySessionByCode.get(access.code);
  const member = getPartyMemberByCodeAndToken.get(access.code, String(req.body?.memberToken || ''));
  res.json({ ok: true, party: partyToResponse(session, member) });
});

app.post('/api/parties/:code/kick', (req, res) => {
  const access = getPartyAccess(req.params.code, req.body?.memberToken);
  if (access.status === 404) return res.status(404).json({ error: 'party not found' });
  if (access.status === 403) return res.status(403).json({ error: 'party membership is invalid' });
  if (!access.member.is_host) {
    return res.status(403).json({ error: 'only the host can remove party members' });
  }
  const targetMemberId = String(req.body?.targetMemberId || '');
  if (!targetMemberId) return res.status(400).json({ error: 'targetMemberId is required' });
  if (targetMemberId === access.member.member_id) {
    return res.status(400).json({ error: 'the host cannot remove themselves from here; end the party instead' });
  }
  const target = getPartyMemberByCodeAndId.get(access.code, targetMemberId);
  if (!target) return res.status(404).json({ error: 'party member not found' });
  deletePartySubmissionByMember.run(access.code, targetMemberId);
  deletePartyMemberById.run(access.code, targetMemberId);
  const session = getPartySessionByCode.get(access.code);
  res.json({ ok: true, party: partyToResponse(session, access.member) });
});

app.post('/api/parties/:code/leave', (req, res) => {
  const access = getPartyAccess(req.params.code, req.body?.memberToken);
  if (access.status === 404) return res.status(404).json({ error: 'party not found' });
  if (access.status === 403) return res.status(403).json({ error: 'party membership is invalid' });
  if (access.member.is_host) {
    deletePartySubmissionsByCode.run(access.code);
    deletePartyMembersByCode.run(access.code);
    deletePartySessionByCode.run(access.code);
    return res.json({ ok: true, ended: true });
  }
  deletePartySubmissionByMember.run(access.code, access.member.member_id);
  deletePartyMemberById.run(access.code, access.member.member_id);
  return res.json({ ok: true });
});

app.post('/api/parties/:code/finalize', (req, res) => {
  const access = getPartyAccess(req.params.code, req.body?.memberToken);
  if (access.status === 404) return res.status(404).json({ error: 'party not found' });
  if (access.status === 403) return res.status(403).json({ error: 'party membership is invalid' });
  if (!access.member.is_host) {
    return res.status(403).json({ error: 'only the host can finalize the party mission' });
  }
  const hostMission = req.body?.mission;
  if (!hostMission || hostMission.id !== access.session.current_mission_id) {
    return res.status(409).json({ error: 'your tally belongs to an older mission round; refresh the party state first' });
  }
  const finalizedAt = Date.now();
  upsertPartySubmission.run(access.code, access.member.member_id, JSON.stringify(hostMission), finalizedAt);
  const members = listPartyMembers.all(access.code);
  if (!members.length) {
    return res.status(400).json({ error: 'party has no members' });
  }
  if (members.some((member) => !isPartyMemberEffectivelyReady(member))) {
    return res.status(400).json({ error: 'every party member must be ready before finalizing' });
  }
  const submissions = listPartySubmissions.all(access.code);
  if (submissions.length !== members.length) {
    return res.status(400).json({ error: 'one or more ready submissions are missing; have everyone re-submit' });
  }
  const meta = JSON.parse(access.session.mission_meta || '{}');
  const tallies = mergeSubmissionTallies(submissions);
  const mission = {
    id: access.session.current_mission_id,
    startedAt: access.session.current_started_at,
    endedAt: finalizedAt,
    durationMs: null,
    allMinorPlacesCollected: !!req.body?.allMinorPlacesCollected,
    squadMode: meta.squadMode || '',
    difficulty: meta.difficulty || '',
    missionType: meta.missionType || '',
    faction: meta.faction || '',
    planet: meta.planet || '',
    cityType: meta.cityType || '',
    poiCounts: tallies.poiCounts,
    itemDrops: tallies.itemDrops,
    denomCounts: tallies.denomCounts,
  };
  upsertMissionRow(access.session.host_client_id, mission, {
    hostClientId: access.session.host_client_id,
    partyCode: access.code,
  });
  replaceMissionParticipants(mission.id, members.map((member) => member.client_id));

  const nextMissionId = generateId();
  const nextStartedAt = finalizedAt;
  deletePartySubmissionsByCode.run(access.code);
  clearPartyMemberReadiness.run(finalizedAt, access.code);
  updatePartySessionAfterFinalize.run(nextMissionId, nextStartedAt, mission.id, finalizedAt, finalizedAt, access.code);

  const session = getPartySessionByCode.get(access.code);
  const member = getPartyMemberByCodeAndToken.get(access.code, String(req.body?.memberToken || ''));
  res.json({
    ok: true,
    mission: rowToMission(db.prepare('SELECT * FROM missions WHERE id = ?').get(mission.id), access.session.host_client_id),
    party: partyToResponse(session, member),
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Stat Gatherer server listening on http://${HOST}:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
