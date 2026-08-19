const CLIENT_ID_KEY = 'sg_client_id';
const CURRENT_MISSION_KEY = 'sg_current_mission';
const HISTORY_KEY = 'sg_mission_history';
const SERVER_URL_KEY = 'sg_server_url';
const SQUAD_MODE_KEY = 'sg_last_squad_mode';
const DENOM_TALLY_KEY = 'sg_denom_tally';

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
    runningSince: Date.now(),
    accumulatedMs: 0,
    squadMode: getLastSquadMode(),
    poiCounts,
    itemDrops,
  };
}

function reconcileWithConfig(mission, config) {
  if (mission.runningSince === undefined) {
    // Backfill missions saved before pause support existed: assume never paused.
    mission.runningSince = mission.endedAt ? null : mission.startedAt;
    mission.accumulatedMs = mission.accumulatedMs ?? 0;
  }
  if (mission.squadMode === undefined) {
    // Backfill missions saved before squad-mode tagging existed: unknown, not assumed solo.
    mission.squadMode = 'unknown';
  }
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
  if (mission.runningSince != null) {
    mission.accumulatedMs += Date.now() - mission.runningSince;
    mission.runningSince = null;
  }
  mission.endedAt = Date.now();
  mission.durationMs = mission.accumulatedMs;
  const history = getHistory();
  const completed = { ...mission, synced: false };
  history.push(completed);
  saveHistory(history);
  const fresh = blankMission(config);
  saveCurrentMission(fresh);
  return { completed, fresh };
}

export function pauseMission(mission) {
  if (mission.runningSince == null) return mission;
  mission.accumulatedMs += Date.now() - mission.runningSince;
  mission.runningSince = null;
  saveCurrentMission(mission);
  return mission;
}

export function resumeMission(mission) {
  if (mission.runningSince != null) return mission;
  mission.runningSince = Date.now();
  saveCurrentMission(mission);
  return mission;
}

export function elapsedMs(mission) {
  return mission.accumulatedMs + (mission.runningSince != null ? Date.now() - mission.runningSince : 0);
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

export function replaceHistory(missions) {
  saveHistory(missions);
}

export function resetAllData() {
  localStorage.removeItem(CURRENT_MISSION_KEY);
  localStorage.removeItem(HISTORY_KEY);
  localStorage.removeItem(DENOM_TALLY_KEY);
}
