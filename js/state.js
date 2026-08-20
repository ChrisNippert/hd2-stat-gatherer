const CLIENT_ID_KEY = 'sg_client_id';
const CURRENT_MISSION_KEY = 'sg_current_mission';
const HISTORY_KEY = 'sg_mission_history';
const SERVER_URL_KEY = 'sg_server_url';
const SQUAD_MODE_KEY = 'sg_last_squad_mode';
const DENOM_TALLY_KEY = 'sg_denom_tally';
const LAST_DIFFICULTY_KEY = 'sg_last_difficulty';
const LAST_PLANET_KEY = 'sg_last_planet';
const LAST_FACTION_KEY = 'sg_last_faction';
const SIMPLIFIED_VIEW_KEY = 'sg_simplified_view';
const QUICK_GUIDE_SEEN_KEY = 'sg_quick_guide_seen';

// crypto.randomUUID() only exists in "secure contexts" — HTTPS, or the
// `localhost` origin specifically. Testing from a second device by hitting
// the host machine's LAN IP over plain HTTP (e.g. http://192.168.1.20:8080)
// is NOT a secure context even though the host's own `localhost` access is,
// so crypto.randomUUID is simply undefined there — "crypto.randomUUID is
// not a function" on any device other than the one running the dev server.
// This id doesn't need to be cryptographically unpredictable (no private
// data, same trust model as the rest of the app), so a Math.random()-based
// v4-shaped fallback is fine.
function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Whether the Tally page shows tap-to-open tiles + the guided pick-item/
// pick-amount popup loop on "+1 FOUND" (on), or classic always-visible
// inline rows with a plain "+1 FOUND" and manual tallying (off) — one
// switch for both, visible right on the Tally page (not tucked into
// Settings). Returns `null` when nothing's been saved yet, distinct from an
// explicit `false` — main.js treats that as "default to Simplified ON" until
// the user explicitly flips the toggle themselves. No auto-following window
// size after that (deliberate — a visible on-page toggle that silently gets
// overridden by a resize would undermine the point of giving direct control).
export function getSimplifiedView() {
  const raw = localStorage.getItem(SIMPLIFIED_VIEW_KEY);
  return raw === null ? null : raw === 'true';
}
export function setSimplifiedView(enabled) {
  localStorage.setItem(SIMPLIFIED_VIEW_KEY, enabled ? 'true' : 'false');
}

export function hasSeenQuickGuide() {
  return localStorage.getItem(QUICK_GUIDE_SEEN_KEY) === 'true';
}

export function setQuickGuideSeen(seen) {
  localStorage.setItem(QUICK_GUIDE_SEEN_KEY, seen ? 'true' : 'false');
}

export function getLastDifficulty() {
  return localStorage.getItem(LAST_DIFFICULTY_KEY) || '';
}
export function setLastDifficulty(id) {
  localStorage.setItem(LAST_DIFFICULTY_KEY, id || '');
}

export function getLastPlanet() {
  return localStorage.getItem(LAST_PLANET_KEY) || '';
}
export function setLastPlanet(id) {
  localStorage.setItem(LAST_PLANET_KEY, id || '');
}

export function getLastFaction() {
  return localStorage.getItem(LAST_FACTION_KEY) || '';
}
export function setLastFaction(id) {
  localStorage.setItem(LAST_FACTION_KEY, id || '');
}

// Lifetime (not per-mission) tally of observed drop amounts per item type:
// { [itemId]: { [denomination]: observationCount } }
export function getDenomTally() {
  const raw = localStorage.getItem(DENOM_TALLY_KEY);
  return raw ? JSON.parse(raw) : {};
}

export function saveDenomTally(tally) {
  localStorage.setItem(DENOM_TALLY_KEY, JSON.stringify(tally));
}

export function incrementDenomCount(itemId, denom, delta) {
  const tally = getDenomTally();
  if (!tally[itemId]) tally[itemId] = {};
  tally[itemId][denom] = Math.max(0, (tally[itemId][denom] || 0) + delta);
  saveDenomTally(tally);
  return tally;
}

export const SQUAD_MODES = ['solo', 'solo_warp', 'multiplayer'];
export const DEFAULT_SQUAD_MODE = 'solo';

export function getLastSquadMode() {
  const mode = localStorage.getItem(SQUAD_MODE_KEY);
  return SQUAD_MODES.includes(mode) ? mode : DEFAULT_SQUAD_MODE;
}

export function setLastSquadMode(mode) {
  localStorage.setItem(SQUAD_MODE_KEY, mode);
}

export function getClientId() {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = generateId();
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

export function setClientId(id) {
  localStorage.setItem(CLIENT_ID_KEY, id);
}

// Ships pointed at the public shared instance by default so a fresh install
// is already contributing to/reading from crowd stats with no setup. A saved
// value (including an explicitly-cleared empty string, to go offline) always
// wins over this — distinguished by localStorage having the key at all.
export const DEFAULT_SERVER_URL = 'https://hd2stats.chrisnippert.com';

export function getServerUrl() {
  const saved = localStorage.getItem(SERVER_URL_KEY);
  return saved === null ? DEFAULT_SERVER_URL : saved;
}

export function setServerUrl(url) {
  localStorage.setItem(SERVER_URL_KEY, url.trim().replace(/\/+$/, ''));
}

function blankMission(config) {
  const poiCounts = {};
  const itemDrops = {};
  config.poiTypes.forEach((p) => {
    poiCounts[p.id] = 0;
    itemDrops[p.id] = {};
    config.itemTypes.forEach((i) => {
      itemDrops[p.id][i.id] = 0;
    });
  });
  return {
    id: generateId(),
    startedAt: Date.now(),
    endedAt: null,
    allMinorPlacesCollected: false,
    squadMode: getLastSquadMode(),
    difficulty: getLastDifficulty(),
    planet: getLastPlanet(),
    faction: getLastFaction(),
    poiCounts,
    itemDrops,
  };
}

function reconcileWithConfig(mission, config) {
  if (mission.squadMode === undefined) {
    // Backfill missions saved before squad-mode tagging existed: unknown, not assumed solo.
    mission.squadMode = 'unknown';
  }
  if (mission.allMinorPlacesCollected === undefined) mission.allMinorPlacesCollected = false;
  if (mission.difficulty === undefined) mission.difficulty = '';
  if (mission.planet === undefined) mission.planet = '';
  if (mission.faction === undefined) mission.faction = '';
  config.poiTypes.forEach((p) => {
    if (!(p.id in mission.poiCounts)) mission.poiCounts[p.id] = 0;
    if (!mission.itemDrops[p.id]) mission.itemDrops[p.id] = {};
    config.itemTypes.forEach((i) => {
      if (!(i.id in mission.itemDrops[p.id])) mission.itemDrops[p.id][i.id] = 0;
    });
  });
  return mission;
}

export function getCurrentMission(config) {
  const raw = localStorage.getItem(CURRENT_MISSION_KEY);
  if (!raw) {
    const m = blankMission(config);
    saveCurrentMission(m);
    return m;
  }
  return reconcileWithConfig(JSON.parse(raw), config);
}

export function saveCurrentMission(mission) {
  localStorage.setItem(CURRENT_MISSION_KEY, JSON.stringify(mission));
}

export function getHistory() {
  const raw = localStorage.getItem(HISTORY_KEY);
  return raw ? JSON.parse(raw) : [];
}

export function saveHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

export function completeMission(config) {
  const mission = getCurrentMission(config);
  mission.endedAt = Date.now();
  const history = getHistory();
  const completed = { ...mission, synced: false };
  history.push(completed);
  saveHistory(history);
  const fresh = blankMission(config);
  saveCurrentMission(fresh);
  return { completed, fresh };
}

// Throws away the in-progress mission instead of saving it to history —
// for a tally that's garbage (misclicks, wrong mission entirely) where the
// user would rather start clean than have it counted. Unlike
// completeMission(), nothing gets pushed to history/synced to the server.
export function discardCurrentMission(config) {
  const fresh = blankMission(config);
  saveCurrentMission(fresh);
  return fresh;
}

export function markSynced(missionId) {
  const history = getHistory();
  const idx = history.findIndex((m) => m.id === missionId);
  if (idx >= 0) {
    history[idx].synced = true;
    saveHistory(history);
  }
}

// Bulk-relabels already-recorded missions, e.g. to retroactively tag
// pre-squad-mode-tracking history as 'unknown' -> 'solo'. Marks touched
// missions unsynced so the next sync push carries the new tag to the server.
export function retagMissions(fromMode, toMode) {
  const history = getHistory();
  let count = 0;
  history.forEach((m) => {
    const current = m.squadMode || 'unknown';
    if (fromMode === 'all' || current === fromMode) {
      m.squadMode = toMode;
      m.synced = false;
      count += 1;
    }
  });
  saveHistory(history);
  return count;
}

// Bulk-fills difficulty/planet/faction on missions that don't have them set
// yet — e.g. backfilling old data recorded before these fields existed.
// Only touches missions currently missing a given field, so it's safe to
// run repeatedly without overwriting anything already labeled.
export function backfillMissionMetadata({ difficulty, planet, faction } = {}) {
  const history = getHistory();
  let count = 0;
  history.forEach((m) => {
    let changed = false;
    if (difficulty && !m.difficulty) { m.difficulty = difficulty; changed = true; }
    if (planet && !m.planet) { m.planet = planet; changed = true; }
    if (faction && !m.faction) { m.faction = faction; changed = true; }
    if (changed) {
      m.synced = false;
      count += 1;
    }
  });
  if (count > 0) saveHistory(history);
  return count;
}

export function replaceHistory(missions) {
  saveHistory(missions);
}

// Edits an already-saved mission (POI/item counts, squad mode, difficulty,
// faction, planet). Marks it unsynced so the correction gets pushed to the
// server on the next sync, overwriting the old copy there (same id).
export function updateMission(missionId, patch) {
  const history = getHistory();
  const idx = history.findIndex((m) => m.id === missionId);
  if (idx < 0) return false;
  history[idx] = { ...history[idx], ...patch, synced: false };
  saveHistory(history);
  return true;
}

export function deleteMission(missionId) {
  const history = getHistory();
  const next = history.filter((m) => m.id !== missionId);
  const removed = next.length !== history.length;
  if (removed) saveHistory(next);
  return removed;
}

export function resetAllData() {
  localStorage.removeItem(CURRENT_MISSION_KEY);
  localStorage.removeItem(HISTORY_KEY);
  localStorage.removeItem(DENOM_TALLY_KEY);
  localStorage.removeItem(QUICK_GUIDE_SEEN_KEY);
}
