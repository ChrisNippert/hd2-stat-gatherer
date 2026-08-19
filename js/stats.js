export function computeStats(missions, config) {
  const poi = {};
  const items = {};
  const dropChance = {};

  config.poiTypes.forEach((p) => {
    poi[p.id] = { count: 0, pctOfPois: 0, perMission: 0 };
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
      perHour: 0,
      perMinute: 0,
      perSecond: 0,
      avgValue: i.value != null ? i.value : 1,
      totalValue: 0,
      valuePerMission: 0,
      valuePerHour: 0,
      valuePerMinute: 0,
      valuePerSecond: 0,
    };
  });

  let totalDurationMs = 0;
  let totalPois = 0;
  let totalItemDrops = 0;

  missions.forEach((m) => {
    const dur = m.durationMs != null ? m.durationMs : (m.endedAt ? m.endedAt - m.startedAt : 0);
    totalDurationMs += dur;
    config.poiTypes.forEach((p) => {
      const c = (m.poiCounts && m.poiCounts[p.id]) || 0;
      poi[p.id].count += c;
      totalPois += c;
      config.itemTypes.forEach((i) => {
        const d = (m.itemDrops && m.itemDrops[p.id] && m.itemDrops[p.id][i.id]) || 0;
        dropChance[p.id][i.id].count += d;
        items[i.id].total += d;
        totalItemDrops += d;
      });
    });
  });

  const totalMissions = missions.length;

  config.poiTypes.forEach((p) => {
    poi[p.id].pctOfPois = totalPois > 0 ? poi[p.id].count / totalPois : 0;
    poi[p.id].perMission = totalMissions > 0 ? poi[p.id].count / totalMissions : 0;
    const totalSlots = poi[p.id].count * p.slots;
    config.itemTypes.forEach((i) => {
      dropChance[p.id][i.id].totalSlots = totalSlots;
      dropChance[p.id][i.id].chance = totalSlots > 0 ? dropChance[p.id][i.id].count / totalSlots : 0;
    });
  });

  const hours = totalDurationMs / 3_600_000;
  config.itemTypes.forEach((i) => {
    const it = items[i.id];
    it.pctOfDrops = totalItemDrops > 0 ? it.total / totalItemDrops : 0;
    it.perMission = totalMissions > 0 ? it.total / totalMissions : 0;
    it.perHour = hours > 0 ? it.total / hours : 0;
    it.perMinute = it.perHour / 60;
    it.perSecond = it.perMinute / 60;

    it.totalValue = it.total * it.avgValue;
    it.valuePerMission = totalMissions > 0 ? it.totalValue / totalMissions : 0;
    it.valuePerHour = hours > 0 ? it.totalValue / hours : 0;
    it.valuePerMinute = it.valuePerHour / 60;
    it.valuePerSecond = it.valuePerMinute / 60;
  });

  return {
    totalMissions,
    totalDurationMs,
    totalPois,
    totalItemDrops,
    avgPoisPerMission: totalMissions > 0 ? totalPois / totalMissions : 0,
    avgItemDropsPerMission: totalMissions > 0 ? totalItemDrops / totalMissions : 0,
    poi,
    items,
    dropChance,
  };
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

export function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}
