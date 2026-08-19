const CLIENT_ID_KEY = 'sg_client_id';
const CURRENT_MISSION_KEY = 'sg_current_mission';
const HISTORY_KEY = 'sg_mission_history';
const SERVER_URL_KEY = 'sg_server_url';
const SQUAD_MODE_KEY = 'sg_last_squad_mode';
const DENOM_TALLY_KEY = 'sg_denom_tally';
const LAST_DIFFICULTY_KEY = 'sg_last_difficulty';
const LAST_PLANET_KEY = 'sg_last_planet';
const LAST_FACTION_KEY = 'sg_last_faction';

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

export function removeDenomCount(itemId, denom) {
  const tally = getDenomTally();
  if (tally[itemId]) {
    delete tally[itemId][denom];
    saveDenomTally(tally);
  }
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
    id = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

export function setClientId(id) {
  localStorage.setItem(CLIENT_ID_KEY, id);
}

export function getServerUrl() {
  return localStorage.getItem(SERVER_URL_KEY) || '';
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
    id: crypto.randomUUID(),
    startedAt: Date.now(),
    endedAt: null,
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
}
