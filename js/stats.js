export function computeStats(missions, config) {
  const poi = {};
  const items = {};
  const dropChance = {};
  const dropChancePoiCounts = {};
  const poiScopedMissions = missions.filter((m) => m.allMinorPlacesCollected);

  config.poiTypes.forEach((p) => {
    poi[p.id] = { count: 0, pctOfPois: 0, perMission: 0 };
    dropChancePoiCounts[p.id] = 0;
    dropChance[p.id] = {};
    config.itemTypes.forEach((i) => {
      dropChance[p.id][i.id] = { count: 0, totalSlots: 0, chance: 0 };
    });
  });
  config.itemTypes.forEach((i) => {
    items[i.id] = {
      total: 0,
      pctOfDrops: 0,
      perMission: 0,
      avgValue: i.value != null ? i.value : 1,
      totalValue: 0,
      valuePerMission: 0,
    };
  });

  let totalPois = 0;
  let totalItemDrops = 0;

  poiScopedMissions.forEach((m) => {
    config.poiTypes.forEach((p) => {
      const c = (m.poiCounts && m.poiCounts[p.id]) || 0;
      poi[p.id].count += c;
      totalPois += c;
    });
  });

  missions.forEach((m) => {
    config.poiTypes.forEach((p) => {
      dropChancePoiCounts[p.id] += (m.poiCounts && m.poiCounts[p.id]) || 0;
      config.itemTypes.forEach((i) => {
        const d = (m.itemDrops && m.itemDrops[p.id] && m.itemDrops[p.id][i.id]) || 0;
        dropChance[p.id][i.id].count += d;
        items[i.id].total += d;
        totalItemDrops += d;
      });
    });
  });

  const totalMissions = missions.length;
  const poiMissionCount = poiScopedMissions.length;

  config.poiTypes.forEach((p) => {
    poi[p.id].pctOfPois = totalPois > 0 ? poi[p.id].count / totalPois : 0;
    poi[p.id].perMission = poiMissionCount > 0 ? poi[p.id].count / poiMissionCount : 0;
    const totalSlots = dropChancePoiCounts[p.id] * p.slots;
    config.itemTypes.forEach((i) => {
      dropChance[p.id][i.id].totalSlots = totalSlots;
      dropChance[p.id][i.id].chance = totalSlots > 0 ? dropChance[p.id][i.id].count / totalSlots : 0;
    });
  });

  config.itemTypes.forEach((i) => {
    const it = items[i.id];
    it.pctOfDrops = totalItemDrops > 0 ? it.total / totalItemDrops : 0;
    it.perMission = totalMissions > 0 ? it.total / totalMissions : 0;
    it.totalValue = it.total * it.avgValue;
    it.valuePerMission = totalMissions > 0 ? it.totalValue / totalMissions : 0;
  });

  return {
    totalMissions,
    poiMissionCount,
    totalPois,
    totalItemDrops,
    avgPoisPerMission: poiMissionCount > 0 ? totalPois / poiMissionCount : 0,
    avgItemDropsPerMission: totalMissions > 0 ? totalItemDrops / totalMissions : 0,
    poi,
    items,
    dropChance,
  };
}

// filters: { squadMode, difficulty, missionType, planet, faction, cityType }
// — each 'all' (or omitted) means no filter on that dimension. Missing
// mission fields are treated as the 'unknown' bucket so old data can still
// be filtered/found.
// Total POIs found on a mission — every POI type's count summed together,
// regardless of type. Shared by the minPois filter below and the Global
// Missions list (main.js), so "how many POIs" always means the same thing
// in both places.
export function totalPois(mission) {
  return Object.values(mission.poiCounts || {}).reduce((sum, n) => sum + (n || 0), 0);
}

export function filterMissions(missions, filters = {}) {
  return missions.filter((m) => {
    if (filters.squadMode && filters.squadMode !== 'all' && (m.squadMode || 'unknown') !== filters.squadMode) return false;
    if (filters.difficulty && filters.difficulty !== 'all' && (m.difficulty || 'unknown') !== filters.difficulty) return false;
    if (filters.missionType && filters.missionType !== 'all' && (m.missionType || 'unknown') !== filters.missionType) return false;
    if (filters.planet && filters.planet !== 'all' && (m.planet || 'unknown') !== filters.planet) return false;
    if (filters.faction && filters.faction !== 'all' && (m.faction || 'unknown') !== filters.faction) return false;
    if (filters.cityType && filters.cityType !== 'all' && (m.cityType || 'unknown') !== filters.cityType) return false;
    if (filters.minPois && totalPois(m) < filters.minPois) return false;
    return true;
  });
}

export function computeDenomStats(tally, itemId) {
  const counts = (tally && tally[itemId]) || {};
  let totalObservations = 0;
  let totalAmount = 0;
  Object.entries(counts).forEach(([denom, count]) => {
    totalObservations += count;
    totalAmount += Number(denom) * count;
  });
  return {
    totalObservations,
    average: totalObservations > 0 ? totalAmount / totalObservations : null,
  };
}

export function buildDenomTallyFromMissions(missions) {
  const tally = {};
  missions.forEach((mission) => {
    const missionCounts = mission?.denomCounts || {};
    Object.values(missionCounts).forEach((poiCounts) => {
      Object.entries(poiCounts || {}).forEach(([itemId, denomCounts]) => {
        if (!tally[itemId]) tally[itemId] = {};
        Object.entries(denomCounts || {}).forEach(([denom, count]) => {
          tally[itemId][denom] = (tally[itemId][denom] || 0) + (Number(count) || 0);
        });
      });
    });
  });
  return tally;
}

// Resource Value's "value per pickup" is no longer a manually-set number —
// it's calibrated from real Drop Size Tracker observations, preferring the
// larger/more-robust global (crowd-pooled) sample over the local one, and
// falling back to the item's seeded default only when nobody has any data
// for it yet. Returns a new itemTypes array; other fields pass through.
export function resolveItemValues(itemTypes, localTally, globalTally) {
  return itemTypes.map((item) => {
    const globalStats = computeDenomStats(globalTally, item.id);
    if (globalStats.totalObservations > 0) {
      return { ...item, value: globalStats.average };
    }
    const localStats = computeDenomStats(localTally, item.id);
    if (localStats.totalObservations > 0) {
      return { ...item, value: localStats.average };
    }
    return item;
  });
}

export function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}
