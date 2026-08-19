import { loadConfig, saveConfig, FALLBACK_ICON, isImageIcon } from './config.js?v=20260820h';
import * as state from './state.js?v=20260820h';
import { computeStats, computeDenomStats, filterMissions, resolveItemValues } from './stats.js?v=20260820h';
import { pingServer, submitMission, fetchMissions, deleteMissionRemote, submitDenomCount, fetchDenominations } from './api.js?v=20260820h';

let config = loadConfig();
let clientId = state.getClientId();
let serverUrl = state.getServerUrl();
let currentMission = state.getCurrentMission(config);
let globalMissions = null; // lazily fetched
let globalDenomTally = null; // lazily fetched, pooled across all divers: { itemId: { denom: count } }
let statsFilters = { squadMode: 'all', difficulty: 'all', faction: 'all', planet: 'all' };
// In-memory only (not persisted): a LIFO stack of denominations picked per
// poi+item on the Tally page, so repeated "−" presses undo picks in the exact
// reverse order they were made (pick +3 then +2, and "−" "−" correctly rolls
// back the 2 first, then the 3) instead of only remembering the single most
// recent pick. Resets on reload, which is fine — that's a fresh-session edge
// case, not the common misclick.
let denomPickStacks = {};

const el = (id) => document.getElementById(id);

// Wires a listener without throwing if the element is missing — a stale cached
// index.html paired with a freshly fetched main.js (or any future HTML/JS
// mismatch) would otherwise throw on the very first missing element and abort
// the rest of the script, silently preventing init() from ever running.
function on(id, event, handler, opts) {
  const elm = el(id);
  if (!elm) {
    console.warn(`Stat Gatherer: #${id} not found in the DOM (stale cached page?) — "${event}" handler skipped.`);
    return;
  }
  elm.addEventListener(event, handler, opts);
}

// Isolates one init step so a missing/mismatched element only degrades that
// piece of the UI instead of aborting every step that would have run after it.
function safe(fn, label) {
  try {
    fn();
  } catch (err) {
    console.error(`Stat Gatherer: ${label} failed — page may be showing a stale cached version, try a hard refresh.`, err);
  }
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function iconBlock(icon) {
  return isImageIcon(icon)
    ? `<img class="item-icon" src="${esc(icon)}" alt="" />`
    : `<span class="item-icon">${esc(icon || FALLBACK_ICON)}</span>`;
}

function iconInline(icon) {
  return isImageIcon(icon)
    ? `<img class="icon-inline" src="${esc(icon)}" alt="" />`
    : esc(icon || FALLBACK_ICON);
}

function toast(message, type = '') {
  const t = el('toast');
  t.textContent = message;
  t.className = `toast ${type}`;
  t.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), 3000);
}

/* ---------------- Client ID / sync status ---------------- */

function renderClientBadge() {
  el('client-id-display').textContent = clientId.slice(0, 8);
  el('client-id-input').value = clientId;
  el('server-url-input').value = serverUrl;
}

function setSyncStatus(text, cls = '') {
  const s = el('sync-status');
  s.textContent = text;
  s.className = `sync-status ${cls}`;
}

/* ---------------- Squad mode ---------------- */

function renderSquadModeSelect() {
  const mode = state.SQUAD_MODES.includes(currentMission.squadMode) ? currentMission.squadMode : state.DEFAULT_SQUAD_MODE;
  el('squad-mode-select').value = mode;
}

on('squad-mode-select', 'change', (e) => {
  currentMission.squadMode = e.target.value;
  state.setLastSquadMode(e.target.value);
  persistCurrentMission();
});

/* ---------------- Meta selects (Difficulty / Faction / Planet) ---------------- */

// Populates a <select>'s options from a config list, optionally with an
// "all"/"skip" leading option and an "unknown" trailing one, preserving the
// current selection if it's still a valid option after re-render.
function populateSelectOptions(selectEl, entries, opts = {}) {
  if (!selectEl) return;
  const prevValue = selectEl.value;
  const parts = [];
  if (opts.allLabel) parts.push(`<option value="all">${esc(opts.allLabel)}</option>`);
  if (opts.skipLabel) parts.push(`<option value="">${esc(opts.skipLabel)}</option>`);
  entries.forEach((entry) => parts.push(`<option value="${esc(entry.id)}">${esc(entry.name)}</option>`));
  if (opts.unknownLabel) parts.push(`<option value="unknown">${esc(opts.unknownLabel)}</option>`);
  selectEl.innerHTML = parts.join('');
  if ([...selectEl.options].some((o) => o.value === prevValue)) {
    selectEl.value = prevValue;
  }
}

// Planet has 260+ options, so it's a searchable text input backed by a
// <datalist> instead of a plain <select> — see planet-input's change handler
// for how typed text resolves to (or creates) a planet entry.
function renderPlanetDatalist() {
  const list = el('planet-datalist');
  if (!list) return;
  list.innerHTML = config.planets.map((p) => `<option value="${esc(p.name)}"></option>`).join('');
}

function findPlanetById(id) {
  return config.planets.find((p) => p.id === id);
}

function findPlanetByName(name) {
  const normalized = name.trim().toLowerCase();
  return config.planets.find((p) => p.name.toLowerCase() === normalized);
}

function renderMissionMetaSelects() {
  populateSelectOptions(el('difficulty-select'), config.difficulties);
  populateSelectOptions(el('faction-select'), config.factions);
  renderPlanetDatalist();
  if (el('difficulty-select')) el('difficulty-select').value = currentMission.difficulty || '';
  if (el('faction-select')) el('faction-select').value = currentMission.faction || '';
  if (el('planet-input')) el('planet-input').value = findPlanetById(currentMission.planet)?.name || '';
}

function renderStatsFilterSelects() {
  populateSelectOptions(el('stats-difficulty-filter'), config.difficulties, { allLabel: 'All Difficulties', unknownLabel: 'Unlabeled' });
  populateSelectOptions(el('stats-faction-filter'), config.factions, { allLabel: 'All Factions', unknownLabel: 'Unlabeled' });
  populateSelectOptions(el('stats-planet-filter'), config.planets, { allLabel: 'All Planets', unknownLabel: 'Unlabeled' });
}

function renderBackfillSelects() {
  populateSelectOptions(el('backfill-difficulty'), config.difficulties, { skipLabel: '— Skip Difficulty —' });
  populateSelectOptions(el('backfill-faction'), config.factions, { skipLabel: '— Skip Faction —' });
  populateSelectOptions(el('backfill-planet'), config.planets, { skipLabel: '— Skip Planet —' });
}

on('difficulty-select', 'change', (e) => {
  currentMission.difficulty = e.target.value;
  state.setLastDifficulty(e.target.value);
  persistCurrentMission();
});
on('faction-select', 'change', (e) => {
  currentMission.faction = e.target.value;
  state.setLastFaction(e.target.value);
  persistCurrentMission();
});
on('planet-input', 'change', (e) => {
  const typed = e.target.value.trim();
  if (!typed) {
    currentMission.planet = '';
    state.setLastPlanet('');
    persistCurrentMission();
    return;
  }
  const planet = findPlanetByName(typed);
  if (!planet) {
    e.target.value = findPlanetById(currentMission.planet)?.name || '';
    toast(`"${typed}" isn't a recognized planet — pick one from the list.`, 'error');
    return;
  }
  e.target.value = planet.name;
  currentMission.planet = planet.id;
  state.setLastPlanet(planet.id);
  persistCurrentMission();
});

/* ---------------- POI grid ---------------- */

function slotsFilled(poiId) {
  return config.itemTypes.reduce((sum, i) => sum + (currentMission.itemDrops[poiId]?.[i.id] || 0), 0);
}

function renderPoiGrid() {
  const grid = el('poi-grid');
  if (config.poiTypes.length === 0) {
    grid.innerHTML = '<p class="empty-note">No POI types configured. Try Settings → Reset All Local Data to restore the defaults.</p>';
    return;
  }
  grid.innerHTML = config.poiTypes.map((p) => {
    const count = currentMission.poiCounts[p.id] || 0;
    const filled = slotsFilled(p.id);
    const totalSlots = count * p.slots;
    const pct = totalSlots > 0 ? Math.min(100, (filled / totalSlots) * 100) : 0;
    return `
      <div class="poi-card" data-poi="${p.id}">
        <div class="poi-card-header">
          <span class="poi-name">${esc(p.name)}</span>
          <span class="poi-slots">${p.slots} SLOT${p.slots === 1 ? '' : 'S'}</span>
        </div>
        <div class="poi-count-row">
          <button class="btn btn-count minus" data-action="poi-dec">−</button>
          <span class="poi-count">${count}</span>
          <button class="btn btn-count plus" data-action="poi-inc">+1 FOUND</button>
        </div>
        <div class="poi-items">
          ${config.itemTypes.map((i) => {
            const hasDenoms = i.denominations && i.denominations.length > 0;
            const stack = hasDenoms ? (denomPickStacks[`${p.id}:${i.id}`] || []) : null;
            const lastPick = stack && stack.length ? stack[stack.length - 1] : null;
            return `
            <div class="item-row" data-item="${i.id}">
              ${iconBlock(i.icon)}
              <span class="item-name">${esc(i.name)}</span>
              <div class="item-controls">
                <button class="btn btn-count minus${lastPick ? ' minus-labeled' : ''}" data-action="item-dec"${lastPick ? ` title="Undo the last pickup you tallied here (${lastPick})"` : ''}>${lastPick ? `−${lastPick}` : '−'}</button>
                <span class="item-count">${currentMission.itemDrops[p.id]?.[i.id] || 0}</span>
                ${hasDenoms ? `
                  <div class="denom-pick-group" title="Tally the exact amount you picked up — this feeds Drop Sizes too, no need to double-enter it there">
                    ${i.denominations.map((d) => `<button class="btn btn-denom-pick" data-action="item-inc-denom" data-denom="${d}">+${d}</button>`).join('')}
                  </div>
                ` : '<button class="btn btn-count plus" data-action="item-inc">+</button>'}
              </div>
            </div>
          `;
          }).join('')}
        </div>
        <div class="poi-progress"><div class="poi-progress-bar" style="width:${pct}%"></div></div>
        <div class="poi-progress-label">SLOTS TALLIED: ${filled} / ${totalSlots}</div>
      </div>
    `;
  }).join('');
}

function persistCurrentMission() {
  state.saveCurrentMission(currentMission);
}

on('poi-grid', 'click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const card = e.target.closest('.poi-card');
  const poiId = card.dataset.poi;
  const action = btn.dataset.action;

  if (action === 'poi-inc') {
    currentMission.poiCounts[poiId] = (currentMission.poiCounts[poiId] || 0) + 1;
  } else if (action === 'poi-dec') {
    currentMission.poiCounts[poiId] = Math.max(0, (currentMission.poiCounts[poiId] || 0) - 1);
  } else if (action === 'item-inc' || action === 'item-dec') {
    const itemRow = e.target.closest('.item-row');
    const itemId = itemRow.dataset.item;
    const delta = action === 'item-inc' ? 1 : -1;
    if (action === 'item-dec' && (currentMission.itemDrops[poiId][itemId] || 0) > 0) {
      const key = `${poiId}:${itemId}`;
      const stack = denomPickStacks[key];
      if (stack && stack.length > 0) {
        const undoneDenom = stack.pop();
        state.incrementDenomCount(itemId, undoneDenom, -1);
        if (serverUrl) submitDenomCount(serverUrl, clientId, itemId, undoneDenom, state.getDenomTally()[itemId][undoneDenom]).catch(() => {});
      }
    }
    currentMission.itemDrops[poiId][itemId] = Math.max(0, (currentMission.itemDrops[poiId][itemId] || 0) + delta);
  } else if (action === 'item-inc-denom') {
    const itemRow = e.target.closest('.item-row');
    const itemId = itemRow.dataset.item;
    const denom = btn.dataset.denom;
    const key = `${poiId}:${itemId}`;
    currentMission.itemDrops[poiId][itemId] = (currentMission.itemDrops[poiId][itemId] || 0) + 1;
    state.incrementDenomCount(itemId, denom, 1);
    (denomPickStacks[key] || (denomPickStacks[key] = [])).push(denom);
    if (serverUrl) submitDenomCount(serverUrl, clientId, itemId, denom, state.getDenomTally()[itemId][denom]).catch(() => {});
  } else {
    return;
  }
  persistCurrentMission();
  renderPoiGrid();
  renderStats();
});

/* ---------------- New Mission ---------------- */

on('new-mission-btn', 'click', async () => {
  const { completed, fresh } = state.completeMission(config);
  currentMission = fresh;
  renderPoiGrid();
  renderStats();
  renderSquadModeSelect();
  renderMissionMetaSelects();
  toast('Mission saved. New mission started.', 'success');
  await trySyncMission(completed);
});

async function trySyncMission(mission) {
  if (!serverUrl) return;
  try {
    await submitMission(serverUrl, clientId, mission);
    state.markSynced(mission.id);
    setSyncStatus('ONLINE', 'online');
  } catch {
    setSyncStatus('SYNC PENDING', 'error');
  }
}

async function syncPendingMissions() {
  if (!serverUrl) {
    setSyncStatus('OFFLINE');
    return;
  }
  const ok = await pingServer(serverUrl);
  if (!ok) {
    setSyncStatus('SERVER UNREACHABLE', 'error');
    return;
  }
  setSyncStatus('ONLINE', 'online');
  const pending = state.getHistory().filter((m) => !m.synced);
  for (const m of pending) {
    try {
      await submitMission(serverUrl, clientId, m);
      state.markSynced(m.id);
    } catch {
      /* leave for next attempt */
    }
  }
  await syncDenomTally();
  await refreshGlobalDenoms();
}

// Denomination counts are small in volume (a handful of item x amount
// buckets, not one row per mission) so it's simplest to just re-push every
// current local count on each sync pass rather than track per-bucket dirty
// flags — the server upsert is idempotent either way.
async function syncDenomTally() {
  if (!serverUrl) return;
  const tally = state.getDenomTally();
  for (const itemId of Object.keys(tally)) {
    for (const denom of Object.keys(tally[itemId])) {
      try {
        await submitDenomCount(serverUrl, clientId, itemId, denom, tally[itemId][denom]);
      } catch {
        /* leave for next sync pass */
      }
    }
  }
}

async function refreshGlobalDenoms() {
  if (!serverUrl) {
    globalDenomTally = null;
    return;
  }
  try {
    const rows = await fetchDenominations(serverUrl);
    const pooled = {};
    rows.forEach((r) => {
      if (!pooled[r.itemId]) pooled[r.itemId] = {};
      pooled[r.itemId][r.denom] = (pooled[r.itemId][r.denom] || 0) + r.count;
    });
    globalDenomTally = pooled;
    renderStats();
  } catch {
    /* keep whatever global data we already had */
  }
}

/* ---------------- Charts ---------------- */

// Plain HTML/CSS bars (not SVG) so the 4px rounded data-end is just a
// border-radius and the hover detail is a native title attribute — no chart
// library, no custom tooltip layer, consistent with the rest of the app.
function barChartHtml(rows) {
  if (!rows.length) return '<p class="empty-note">No data yet.</p>';
  const maxValue = Math.max(...rows.map((r) => r.value), 0.0001);
  return `<div class="chart">
    ${rows.map((r) => {
      const pct = Math.max(2, (r.value / maxValue) * 100);
      return `
        <div class="chart-row" title="${esc(r.title)}">
          <span class="chart-row-icon">${r.iconHtml || ''}</span>
          <span class="chart-row-label">${esc(r.label)}</span>
          <div class="chart-track"><div class="chart-bar" style="width:${pct}%"></div></div>
          <span class="chart-row-value">${esc(r.displayValue)}</span>
        </div>
      `;
    }).join('')}
  </div>`;
}

// Sequential-shaded grid (POI type x item type), magnitude = drop chance per
// slot. One hue, light->dark via color-mix() against the panel surface.
function dropProbabilityHeatmapHtml(stats) {
  if (!config.poiTypes.length || !config.itemTypes.length) return '<p class="empty-note">No data yet.</p>';
  const allChances = config.poiTypes.flatMap((p) => config.itemTypes.map((i) => stats.dropChance[p.id][i.id].chance));
  const maxChance = Math.max(...allChances, 0.0001);
  const cells = [`<div class="heatmap-cell-label heatmap-corner"></div>`];
  config.itemTypes.forEach((i) => {
    cells.push(`<div class="heatmap-cell-label heatmap-col-label">${iconInline(i.icon)} ${esc(i.name)}</div>`);
  });
  config.poiTypes.forEach((p) => {
    cells.push(`<div class="heatmap-cell-label heatmap-row-label">${esc(p.name)}</div>`);
    config.itemTypes.forEach((i) => {
      const chance = stats.dropChance[p.id][i.id].chance;
      const pct = Math.round(Math.min(1, chance / maxChance) * 100);
      const bg = `color-mix(in srgb, var(--bg-input) ${100 - pct}%, var(--chart-seq) ${pct}%)`;
      cells.push(`<div class="heatmap-value-cell" style="background:${bg}" title="${esc(p.name)} × ${esc(i.name)}: ${(chance * 100).toFixed(1)}%">${(chance * 100).toFixed(0)}%</div>`);
    });
  });
  return `<div class="heatmap" style="grid-template-columns: 130px repeat(${config.itemTypes.length}, minmax(60px, 1fr));">${cells.join('')}</div>`;
}

/* ---------------- Stats ---------------- */

function statsHtml(stats) {
  if (stats.totalMissions === 0) {
    return '<p class="empty-note">No completed missions yet. Tally some POIs and hit "New Mission" to save your first one.</p>';
  }

  const poiChartRows = config.poiTypes.map((p) => ({
    label: p.name,
    value: stats.poi[p.id].count,
    displayValue: String(stats.poi[p.id].count),
    title: `${p.name}: ${stats.poi[p.id].count} (${(stats.poi[p.id].pctOfPois * 100).toFixed(1)}% of POIs)`,
  }));

  const yieldChartRows = config.itemTypes.map((i) => ({
    iconHtml: iconBlock(i.icon),
    label: i.name,
    value: stats.items[i.id].total,
    displayValue: String(stats.items[i.id].total),
    title: `${i.name}: ${stats.items[i.id].total} (${(stats.items[i.id].pctOfDrops * 100).toFixed(1)}% of drops)`,
  }));

  const valueChartRows = config.itemTypes.map((i) => ({
    iconHtml: iconBlock(i.icon),
    label: i.name,
    value: stats.items[i.id].totalValue,
    displayValue: stats.items[i.id].totalValue.toFixed(0),
    title: `${i.name}: ${stats.items[i.id].totalValue.toFixed(0)} total value`,
  }));

  return `
    <div class="stats-summary">
      <div class="stat-tile"><span class="stat-value">${stats.totalMissions}</span><span class="stat-label">MISSIONS</span></div>
      <div class="stat-tile"><span class="stat-value">${stats.totalPois}</span><span class="stat-label">POIs FOUND</span></div>
      <div class="stat-tile"><span class="stat-value">${stats.avgPoisPerMission.toFixed(1)}</span><span class="stat-label">AVG POIs / MISSION</span></div>
      <div class="stat-tile"><span class="stat-value">${stats.totalItemDrops}</span><span class="stat-label">RESOURCES FOUND</span></div>
      <div class="stat-tile"><span class="stat-value">${stats.avgItemDropsPerMission.toFixed(1)}</span><span class="stat-label">AVG RESOURCES / MISSION</span></div>
    </div>

    <h3>POI Frequency</h3>
    ${barChartHtml(poiChartRows)}
    <table class="stats-table">
      <thead><tr><th>POI Type</th><th>Count</th><th>% of POIs</th><th>Avg / Mission</th></tr></thead>
      <tbody>
        ${config.poiTypes.map((p) => `
          <tr>
            <td>${esc(p.name)}</td>
            <td>${stats.poi[p.id].count}</td>
            <td>${(stats.poi[p.id].pctOfPois * 100).toFixed(1)}%</td>
            <td>${stats.poi[p.id].perMission.toFixed(2)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <h3>Resource Yield</h3>
    ${barChartHtml(yieldChartRows)}
    <table class="stats-table">
      <thead><tr><th>Item</th><th>Total</th><th>% of Drops</th><th>Avg / Mission</th></tr></thead>
      <tbody>
        ${config.itemTypes.map((i) => `
          <tr>
            <td>${iconInline(i.icon)} ${esc(i.name)}</td>
            <td>${stats.items[i.id].total}</td>
            <td>${(stats.items[i.id].pctOfDrops * 100).toFixed(1)}%</td>
            <td>${stats.items[i.id].perMission.toFixed(2)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <h3>Resource Value</h3>
    ${barChartHtml(valueChartRows)}
    <table class="stats-table">
      <thead><tr><th>Item</th><th>Value Each</th><th>Total Value</th><th>Value / Mission</th></tr></thead>
      <tbody>
        ${config.itemTypes.map((i) => `
          <tr>
            <td>${iconInline(i.icon)} ${esc(i.name)}</td>
            <td>${stats.items[i.id].avgValue}</td>
            <td>${stats.items[i.id].totalValue.toFixed(0)}</td>
            <td>${stats.items[i.id].valuePerMission.toFixed(1)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <h3>Drop Probability by POI</h3>
    ${dropProbabilityHeatmapHtml(stats)}
    ${config.poiTypes.map((p) => `
      <div class="drop-table-wrap">
        <h4>${esc(p.name)}</h4>
        <table class="stats-table">
          <thead><tr><th>Item</th><th>Count</th><th>Chance / Slot</th></tr></thead>
          <tbody>
            ${config.itemTypes.map((i) => {
              const d = stats.dropChance[p.id][i.id];
              return `<tr><td>${iconInline(i.icon)} ${esc(i.name)}</td><td>${d.count}</td><td>${(d.chance * 100).toFixed(1)}%</td></tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `).join('')}
  `;
}

// Read-only — Drop Sizes are now only tallied from the Tally page (the same
// interface as missions), so Stats just reports the resulting distribution
// like any other stat: counts and percentages, no +/- controls here. Not
// filtered by statsFilters — pickup size isn't tied to squad mode,
// difficulty, faction, or planet — so this uses the raw tally, not `stats`.
function dropSizeStatsHtml(tally) {
  const trackedItems = config.itemTypes.filter((i) => (i.denominations || []).length > 0);
  if (!trackedItems.length) return '';
  return `
    <h3>Drop Sizes</h3>
    ${trackedItems.map((i) => {
      const denoms = i.denominations.slice().sort((a, b) => a - b);
      const denomStats = computeDenomStats(tally, i.id);
      if (denomStats.totalObservations === 0) {
        return `<h4>${iconInline(i.icon)} ${esc(i.name)}</h4><p class="empty-note">No observations yet — tally a pickup on the Tally page.</p>`;
      }
      const rows = denoms.map((d) => {
        const count = (tally[i.id] && tally[i.id][d]) || 0;
        const pct = (count / denomStats.totalObservations) * 100;
        return {
          label: String(d),
          value: count,
          displayValue: `${pct.toFixed(0)}%`,
          title: `${d}: ${count} pickup${count === 1 ? '' : 's'} (${pct.toFixed(1)}%)`,
        };
      });
      return `
        <h4>${iconInline(i.icon)} ${esc(i.name)} — avg ${denomStats.average.toFixed(2)} over ${denomStats.totalObservations} pickup${denomStats.totalObservations === 1 ? '' : 's'}</h4>
        ${barChartHtml(rows)}
        <table class="stats-table">
          <thead><tr><th>Size</th><th>Count</th><th>% of Pickups</th></tr></thead>
          <tbody>
            ${denoms.map((d) => {
              const count = (tally[i.id] && tally[i.id][d]) || 0;
              const pct = (count / denomStats.totalObservations) * 100;
              return `<tr><td>${d}</td><td>${count}</td><td>${pct.toFixed(1)}%</td></tr>`;
            }).join('')}
          </tbody>
        </table>
      `;
    }).join('')}
  `;
}

function renderStats() {
  const resolvedItemTypes = resolveItemValues(config.itemTypes, state.getDenomTally(), globalDenomTally || {});
  const resolvedConfig = { ...config, itemTypes: resolvedItemTypes };
  const history = filterMissions(state.getHistory(), statsFilters);
  el('stats-mine').innerHTML = statsHtml(computeStats(history, resolvedConfig)) + dropSizeStatsHtml(state.getDenomTally());
  const globalStatsHtml = globalMissions
    ? statsHtml(computeStats(filterMissions(globalMissions, statsFilters), resolvedConfig))
    : (serverUrl
      ? '<p class="empty-note">Loading global stats…</p>'
      : '<p class="empty-note">Set a server URL in Settings to see global stats from all divers.</p>');
  el('stats-global').innerHTML = globalStatsHtml + dropSizeStatsHtml(globalDenomTally || {});
}

on('stats-squad-filter', 'change', (e) => {
  statsFilters.squadMode = e.target.value;
  renderStats();
});
on('stats-difficulty-filter', 'change', (e) => {
  statsFilters.difficulty = e.target.value;
  renderStats();
});
on('stats-faction-filter', 'change', (e) => {
  statsFilters.faction = e.target.value;
  renderStats();
});
on('stats-planet-filter', 'change', (e) => {
  statsFilters.planet = e.target.value;
  renderStats();
});

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    el('stats-mine').classList.toggle('hidden', tab !== 'mine');
    el('stats-global').classList.toggle('hidden', tab !== 'global');
    if (tab === 'global' && serverUrl) {
      await refreshGlobalStats();
    }
  });
});

async function refreshGlobalStats() {
  if (!serverUrl) return;
  try {
    globalMissions = await fetchMissions(serverUrl);
    renderStats();
  } catch {
    el('stats-global').innerHTML = '<p class="empty-note">Could not reach server for global stats.</p>';
  }
}

/* ---------------- Page nav ---------------- */

document.querySelectorAll('.page-nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.page-nav-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const page = btn.dataset.page;
    el('tally-page')?.classList.toggle('hidden', page !== 'tally');
    el('stats-page')?.classList.toggle('hidden', page !== 'stats');
    el('log-page')?.classList.toggle('hidden', page !== 'log');
    if (page === 'log') renderLogPage();
  });
});

/* ---------------- Mission log (edit / delete saved missions) ---------------- */

function missionLabel(mission, listKey, field) {
  const entry = config[listKey].find((e) => e.id === mission[field]);
  return entry ? entry.name : 'Unlabeled';
}

const SQUAD_MODE_LABELS = { solo: 'Solo', solo_warp: 'Solo+Warp', multiplayer: 'Multiplayer', unknown: 'Unlabeled' };

function missionEditFormHtml(mission) {
  const squadOptions = Object.entries(SQUAD_MODE_LABELS)
    .filter(([val]) => val !== 'unknown')
    .map(([val, label]) => `<option value="${val}"${mission.squadMode === val ? ' selected' : ''}>${esc(label)}</option>`)
    .join('');
  const optList = (entries, selectedId) => entries.map((e) => `<option value="${esc(e.id)}"${selectedId === e.id ? ' selected' : ''}>${esc(e.name)}</option>`).join('');

  return `
    <div class="log-edit-form hidden">
      <div class="row">
        <select class="squad-select log-edit-field" data-field="squadMode">${squadOptions}</select>
        <select class="squad-select log-edit-field" data-field="difficulty">${optList(config.difficulties, mission.difficulty)}</select>
        <select class="squad-select log-edit-field" data-field="faction">${optList(config.factions, mission.faction)}</select>
        <select class="squad-select log-edit-field" data-field="planet">${optList(config.planets, mission.planet)}</select>
      </div>
      ${config.poiTypes.map((p) => `
        <div class="log-edit-poi">
          <div class="row">
            <span class="denom-label">${esc(p.name)}</span>
            <input type="number" class="value-input log-edit-poi-count" data-poi="${p.id}" min="0" value="${mission.poiCounts?.[p.id] || 0}" />
          </div>
          <div class="log-edit-items">
            ${config.itemTypes.map((i) => `
              <div class="item-row">
                ${iconBlock(i.icon)}
                <span class="item-name">${esc(i.name)}</span>
                <input type="number" class="value-input log-edit-item-count" data-poi="${p.id}" data-item="${i.id}" min="0" value="${mission.itemDrops?.[p.id]?.[i.id] || 0}" />
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
      <div class="row">
        <button class="btn btn-primary" data-action="log-save">Save</button>
        <button class="btn" data-action="log-cancel">Cancel</button>
      </div>
    </div>
  `;
}

function renderLogPage() {
  const container = el('log-list');
  if (!container) return;
  const history = state.getHistory().slice().reverse();
  if (history.length === 0) {
    container.innerHTML = '<p class="empty-note">No saved missions yet.</p>';
    return;
  }
  container.innerHTML = history.map((m) => {
    const poiSummary = config.poiTypes
      .map((p) => ({ name: p.name, count: m.poiCounts?.[p.id] || 0 }))
      .filter((x) => x.count > 0)
      .map((x) => `${x.count}x ${x.name}`)
      .join(', ') || 'No POIs tallied';
    const itemSummary = config.itemTypes
      .map((i) => ({ name: i.name, total: config.poiTypes.reduce((sum, p) => sum + (m.itemDrops?.[p.id]?.[i.id] || 0), 0) }))
      .filter((x) => x.total > 0)
      .map((x) => `${x.total} ${x.name}`)
      .join(', ') || 'No items tallied';
    return `
      <div class="log-card" data-id="${esc(m.id)}">
        <div class="log-card-header">
          <span class="log-card-date">${esc(new Date(m.startedAt).toLocaleString())}</span>
          <div class="log-card-tags">
            <span class="log-tag">${esc(SQUAD_MODE_LABELS[m.squadMode || 'unknown'] || m.squadMode)}</span>
            <span class="log-tag">${esc(missionLabel(m, 'difficulties', 'difficulty'))}</span>
            <span class="log-tag">${esc(missionLabel(m, 'factions', 'faction'))}</span>
            <span class="log-tag">${esc(missionLabel(m, 'planets', 'planet'))}</span>
          </div>
        </div>
        <div class="log-card-summary">${esc(poiSummary)} — ${esc(itemSummary)}</div>
        <div class="log-card-actions">
          <button class="btn" data-action="log-edit">Edit</button>
          <button class="btn btn-danger" data-action="log-delete">Delete</button>
        </div>
        ${missionEditFormHtml(m)}
      </div>
    `;
  }).join('');
}

on('log-list', 'click', async (e) => {
  const card = e.target.closest('.log-card');
  if (!card) return;
  const missionId = card.dataset.id;
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === 'log-edit') {
    card.querySelector('.log-edit-form')?.classList.remove('hidden');
    card.querySelector('.log-card-actions')?.classList.add('hidden');
  } else if (action === 'log-cancel') {
    renderLogPage();
  } else if (action === 'log-delete') {
    if (!confirm('Delete this mission permanently? This cannot be undone.')) return;
    state.deleteMission(missionId);
    if (serverUrl) {
      try {
        await deleteMissionRemote(serverUrl, missionId, clientId);
      } catch {
        /* best effort — local delete already happened */
      }
    }
    renderLogPage();
    renderStats();
    toast('Mission deleted.', 'success');
  } else if (action === 'log-save') {
    const form = card.querySelector('.log-edit-form');
    const patch = {};
    form.querySelectorAll('.log-edit-field').forEach((sel) => { patch[sel.dataset.field] = sel.value; });
    const poiCounts = {};
    const itemDrops = {};
    config.poiTypes.forEach((p) => {
      poiCounts[p.id] = 0;
      itemDrops[p.id] = {};
      config.itemTypes.forEach((i) => { itemDrops[p.id][i.id] = 0; });
    });
    form.querySelectorAll('.log-edit-poi-count').forEach((input) => {
      poiCounts[input.dataset.poi] = Math.max(0, parseInt(input.value, 10) || 0);
    });
    form.querySelectorAll('.log-edit-item-count').forEach((input) => {
      itemDrops[input.dataset.poi][input.dataset.item] = Math.max(0, parseInt(input.value, 10) || 0);
    });
    patch.poiCounts = poiCounts;
    patch.itemDrops = itemDrops;
    state.updateMission(missionId, patch);
    renderLogPage();
    renderStats();
    toast('Mission updated.', 'success');
    await syncPendingMissions();
  }
});

/* ---------------- Settings panel ---------------- */

function openSettings() {
  el('settings-panel').classList.remove('hidden');
  el('settings-overlay').classList.remove('hidden');
}
function closeSettings() {
  el('settings-panel').classList.add('hidden');
  el('settings-overlay').classList.add('hidden');
}
on('settings-btn', 'click', openSettings);
on('client-badge', 'click', openSettings);
on('close-settings', 'click', closeSettings);
on('settings-overlay', 'click', closeSettings);

on('backfill-apply', 'click', async () => {
  const difficulty = el('backfill-difficulty').value;
  const faction = el('backfill-faction').value;
  const planet = el('backfill-planet').value;
  if (!difficulty && !faction && !planet) {
    toast('Pick at least one field to backfill.', '');
    return;
  }
  const count = state.backfillMissionMetadata({ difficulty, faction, planet });
  if (count === 0) {
    toast('No missions needed backfilling.', '');
    return;
  }
  renderStats();
  toast(`Backfilled ${count} mission(s).`, 'success');
  await syncPendingMissions();
});

on('apply-client-id', 'click', async () => {
  const newId = el('client-id-input').value.trim();
  if (!newId || newId === clientId) return;
  clientId = newId;
  state.setClientId(clientId);
  renderClientBadge();
  if (serverUrl) {
    try {
      const remoteHistory = await fetchMissions(serverUrl, clientId);
      state.replaceHistory(remoteHistory.map((m) => ({ ...m, synced: true })));
      toast(`Logged in as ${clientId.slice(0, 8)} — pulled ${remoteHistory.length} mission(s) from server.`, 'success');
    } catch {
      toast('Diver ID set, but could not reach server to pull history.', 'error');
    }
  } else {
    toast(`Diver ID set to ${clientId.slice(0, 8)}.`, 'success');
  }
  renderStats();
});

on('apply-server-url', 'click', async () => {
  serverUrl = el('server-url-input').value.trim().replace(/\/+$/, '');
  state.setServerUrl(serverUrl);
  globalMissions = null;
  await syncPendingMissions();
  renderStats();
  toast('Server URL saved.', 'success');
});

on('retag-apply', 'click', async () => {
  const fromMode = el('retag-from').value;
  const toMode = el('retag-to').value;
  const count = state.retagMissions(fromMode, toMode);
  if (count === 0) {
    toast('No matching missions to re-tag.', '');
    return;
  }
  renderStats();
  toast(`Re-tagged ${count} mission(s).`, 'success');
  await syncPendingMissions();
});

/* ---------------- Import / Export ---------------- */

on('export-json', 'click', () => {
  const payload = {
    exportedAt: new Date().toISOString(),
    clientId,
    config,
    currentMission,
    history: state.getHistory(),
    denomTally: state.getDenomTally(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `stat-gatherer-export-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

on('import-json-btn', 'click', () => el('import-json-input')?.click());

on('import-json-input', 'change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (data.config) {
      config = data.config;
      saveConfig(config);
    }
    if (Array.isArray(data.history)) {
      state.replaceHistory(data.history);
    }
    if (data.currentMission) {
      currentMission = data.currentMission;
      state.saveCurrentMission(currentMission);
    }
    if (data.denomTally) {
      state.saveDenomTally(data.denomTally);
    }
    currentMission = state.getCurrentMission(config);
    renderPoiGrid();
    renderStats();
    renderSquadModeSelect();
    renderMissionMetaSelects();
    renderStatsFilterSelects();
    renderBackfillSelects();
    if (!el('log-page')?.classList.contains('hidden')) renderLogPage();
    toast('Import complete.', 'success');
  } catch {
    toast('Import failed — invalid JSON file.', 'error');
  } finally {
    e.target.value = '';
  }
});

on('reset-data', 'click', () => {
  if (!confirm('This will erase all local missions, drop-size tallies, and the in-progress mission. Continue?')) return;
  state.resetAllData();
  currentMission = state.getCurrentMission(config);
  renderPoiGrid();
  renderStats();
  renderSquadModeSelect();
  renderMissionMetaSelects();
  if (!el('log-page')?.classList.contains('hidden')) renderLogPage();
  toast('Local data reset.', 'success');
});

/* ---------------- Init ---------------- */

function init() {
  safe(renderClientBadge, 'renderClientBadge');
  safe(renderPoiGrid, 'renderPoiGrid');
  safe(renderMissionMetaSelects, 'renderMissionMetaSelects');
  safe(renderStatsFilterSelects, 'renderStatsFilterSelects');
  safe(renderBackfillSelects, 'renderBackfillSelects');
  safe(renderStats, 'renderStats');
  safe(renderSquadModeSelect, 'renderSquadModeSelect');
  syncPendingMissions().then(() => {
    if (!el('stats-global')?.classList.contains('hidden')) refreshGlobalStats();
  }).catch((err) => console.error('Stat Gatherer: initial sync failed', err));
  setInterval(syncPendingMissions, 30000);
}

safe(init, 'init');
