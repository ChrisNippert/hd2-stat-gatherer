import { loadConfig, saveConfig, slugify, uniqueId, FALLBACK_ICON, isImageIcon } from './config.js?v=20260819';
import * as state from './state.js?v=20260819';
import { computeStats, computeDenomStats, filterMissions } from './stats.js?v=20260819';
import { pingServer, submitMission, fetchMissions, deleteMissionRemote } from './api.js?v=20260819';

let config = loadConfig();
let clientId = state.getClientId();
let serverUrl = state.getServerUrl();
let currentMission = state.getCurrentMission(config);
let globalMissions = null; // lazily fetched
let statsFilters = { squadMode: 'all', difficulty: 'all', faction: 'all', planet: 'all' };

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

function renderMissionMetaSelects() {
  populateSelectOptions(el('difficulty-select'), config.difficulties);
  populateSelectOptions(el('faction-select'), config.factions);
  populateSelectOptions(el('planet-select'), config.planets);
  if (el('difficulty-select')) el('difficulty-select').value = currentMission.difficulty || '';
  if (el('faction-select')) el('faction-select').value = currentMission.faction || '';
  if (el('planet-select')) el('planet-select').value = currentMission.planet || '';
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
on('planet-select', 'change', (e) => {
  currentMission.planet = e.target.value;
  state.setLastPlanet(e.target.value);
  persistCurrentMission();
});

/* ---------------- POI grid ---------------- */

function slotsFilled(poiId) {
  return config.itemTypes.reduce((sum, i) => sum + (currentMission.itemDrops[poiId]?.[i.id] || 0), 0);
}

function renderPoiGrid() {
  const grid = el('poi-grid');
  if (config.poiTypes.length === 0) {
    grid.innerHTML = '<p class="empty-note">No POI types configured. Add some in Settings.</p>';
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
          ${config.itemTypes.map((i) => `
            <div class="item-row" data-item="${i.id}">
              ${iconBlock(i.icon)}
              <span class="item-name">${esc(i.name)}</span>
              <button class="btn btn-count minus" data-action="item-dec">−</button>
              <span class="item-count">${currentMission.itemDrops[p.id]?.[i.id] || 0}</span>
              <button class="btn btn-count plus" data-action="item-inc">+</button>
            </div>
          `).join('')}
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
    currentMission.itemDrops[poiId][itemId] = Math.max(0, (currentMission.itemDrops[poiId][itemId] || 0) + delta);
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

function renderStats() {
  const history = filterMissions(state.getHistory(), statsFilters);
  el('stats-mine').innerHTML = statsHtml(computeStats(history, config));
  if (globalMissions) {
    el('stats-global').innerHTML = statsHtml(computeStats(filterMissions(globalMissions, statsFilters), config));
  } else {
    el('stats-global').innerHTML = serverUrl
      ? '<p class="empty-note">Loading global stats…</p>'
      : '<p class="empty-note">Set a server URL in Settings to see global stats from all divers.</p>';
  }
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
    el('denom-page')?.classList.toggle('hidden', page !== 'denom');
    el('stats-page')?.classList.toggle('hidden', page !== 'stats');
    el('log-page')?.classList.toggle('hidden', page !== 'log');
    if (page === 'denom') renderDenomPage();
    if (page === 'log') renderLogPage();
  });
});

/* ---------------- Drop size tracker ---------------- */

function renderDenomPage() {
  const tally = state.getDenomTally();
  el('denom-grid').innerHTML = config.itemTypes.map((i) => {
    const denoms = (i.denominations || []).slice().sort((a, b) => a - b);
    const denomStats = computeDenomStats(tally, i.id);
    return `
      <div class="poi-card denom-card" data-item="${i.id}">
        <div class="denom-card-header">
          ${iconBlock(i.icon)}
          <span class="poi-name">${esc(i.name)}</span>
        </div>
        <div class="denom-avg">
          ${denomStats.totalObservations > 0
            ? `Observed avg: <strong>${denomStats.average.toFixed(2)}</strong> over ${denomStats.totalObservations} pickup${denomStats.totalObservations === 1 ? '' : 's'}`
            : 'No observations yet — tally a pickup below.'}
        </div>
        <div class="denom-rows">
          ${denoms.length ? denoms.map((d) => `
            <div class="denom-row" data-denom="${d}">
              <span class="denom-label">${d}</span>
              <button class="btn btn-count minus" data-action="denom-dec">−</button>
              <span class="denom-count">${(tally[i.id] && tally[i.id][d]) || 0}</span>
              <button class="btn btn-count plus" data-action="denom-inc">+</button>
              <button class="remove-btn" data-action="denom-remove" title="Remove this denomination">✕</button>
            </div>
          `).join('') : '<p class="empty-note">No denominations configured yet — add one below.</p>'}
        </div>
        <div class="row">
          <input type="number" class="value-input denom-new-input" placeholder="e.g. 1000" step="1" />
          <button class="btn" data-action="denom-add">Add Denomination</button>
        </div>
        ${denomStats.totalObservations > 0 ? `
          <button class="btn btn-primary denom-apply-btn" data-action="denom-apply-value" data-avg="${denomStats.average}">
            Use ${denomStats.average.toFixed(2)} as Resource Value
          </button>
        ` : ''}
      </div>
    `;
  }).join('') || '<p class="empty-note">No item types configured.</p>';
}

on('denom-grid', 'click', (e) => {
  const card = e.target.closest('.denom-card');
  if (!card) return;
  const itemId = card.dataset.item;
  const itemType = config.itemTypes.find((i) => i.id === itemId);
  if (!itemType) return;
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === 'denom-inc' || action === 'denom-dec') {
    const denom = e.target.closest('.denom-row').dataset.denom;
    state.incrementDenomCount(itemId, denom, action === 'denom-inc' ? 1 : -1);
    renderDenomPage();
  } else if (action === 'denom-remove') {
    const denom = e.target.closest('.denom-row').dataset.denom;
    const tally = state.getDenomTally();
    const count = (tally[itemId] && tally[itemId][denom]) || 0;
    const message = count > 0
      ? `Remove denomination "${denom}"? This deletes ${count} tallied observation${count === 1 ? '' : 's'} for it — can't be undone.`
      : `Remove denomination "${denom}"?`;
    if (!confirm(message)) return;
    itemType.denominations = (itemType.denominations || []).filter((d) => String(d) !== denom);
    saveConfig(config);
    state.removeDenomCount(itemId, denom);
    renderDenomPage();
  } else if (action === 'denom-add') {
    const input = card.querySelector('.denom-new-input');
    const value = parseFloat(input.value);
    if (!Number.isFinite(value)) return;
    if (!itemType.denominations) itemType.denominations = [];
    if (!itemType.denominations.includes(value)) {
      itemType.denominations.push(value);
      itemType.denominations.sort((a, b) => a - b);
      saveConfig(config);
    }
    renderDenomPage();
  } else if (action === 'denom-apply-value') {
    const avg = Math.round(parseFloat(btn.dataset.avg) * 100) / 100;
    itemType.value = avg;
    saveConfig(config);
    renderDenomPage();
    renderStats();
    toast(`${itemType.name} value updated to ${avg.toFixed(2)}.`, 'success');
  }
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
        await deleteMissionRemote(serverUrl, missionId);
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
  renderConfigLists();
}
function closeSettings() {
  el('settings-panel').classList.add('hidden');
  el('settings-overlay').classList.add('hidden');
}
on('settings-btn', 'click', openSettings);
on('client-badge', 'click', openSettings);
on('close-settings', 'click', closeSettings);
on('settings-overlay', 'click', closeSettings);

function renderNameOnlyConfigList(containerId, entries, kind) {
  const container = el(containerId);
  if (!container) return;
  container.innerHTML = entries.map((entry) => `
    <div class="config-item" data-id="${entry.id}" data-kind="${kind}">
      <span class="name">${esc(entry.name)}</span>
      <button class="remove-btn" data-remove="${kind}" data-id="${entry.id}">✕</button>
    </div>
  `).join('') || '<p class="empty-note">None configured.</p>';
}

function renderConfigLists() {
  el('poi-config-list').innerHTML = config.poiTypes.map((p) => `
    <div class="config-item" data-id="${p.id}" data-kind="poi">
      <span class="name">${esc(p.name)}</span>
      <span class="meta">${p.slots} slot${p.slots === 1 ? '' : 's'}</span>
      <button class="remove-btn" data-remove="poi" data-id="${p.id}">✕</button>
    </div>
  `).join('') || '<p class="empty-note">None configured.</p>';

  el('item-config-list').innerHTML = config.itemTypes.map((i) => `
    <div class="config-item" data-id="${i.id}" data-kind="item">
      ${iconBlock(i.icon)}
      <span class="name">${esc(i.name)}</span>
      <input type="number" class="value-input" data-value-for="${i.id}" value="${Math.round((i.value ?? 1) * 100) / 100}" step="0.1" min="0" title="Average value per drop" />
      <button class="remove-btn" data-remove="item" data-id="${i.id}">✕</button>
    </div>
  `).join('') || '<p class="empty-note">None configured.</p>';

  renderNameOnlyConfigList('difficulty-config-list', config.difficulties, 'difficulty');
  renderNameOnlyConfigList('faction-config-list', config.factions, 'faction');
  renderNameOnlyConfigList('planet-config-list', config.planets, 'planet');
}

on('item-config-list', 'change', (e) => {
  const input = e.target.closest('.value-input[data-value-for]');
  if (!input) return;
  const itemType = config.itemTypes.find((i) => i.id === input.dataset.valueFor);
  if (!itemType) return;
  const value = parseFloat(input.value);
  itemType.value = Number.isFinite(value) ? value : 1;
  saveConfig(config);
  renderStats();
});

function persistConfigChange() {
  saveConfig(config);
  currentMission = state.getCurrentMission(config);
  renderPoiGrid();
  renderConfigLists();
  renderStats();
  renderMissionMetaSelects();
  renderStatsFilterSelects();
  renderBackfillSelects();
}

on('add-poi-type', 'click', () => {
  const nameInput = el('new-poi-name');
  const slotsInput = el('new-poi-slots');
  const name = nameInput.value.trim();
  const slots = Math.max(1, parseInt(slotsInput.value, 10) || 1);
  if (!name) return;
  const id = uniqueId(config.poiTypes.map((p) => p.id), slugify(name));
  config.poiTypes.push({ id, name, slots });
  nameInput.value = '';
  slotsInput.value = '1';
  persistConfigChange();
});

on('add-item-type', 'click', () => {
  const nameInput = el('new-item-name');
  const iconInput = el('new-item-icon');
  const valueInput = el('new-item-value');
  const name = nameInput.value.trim();
  const icon = iconInput.value.trim() || FALLBACK_ICON;
  const parsedValue = parseFloat(valueInput.value);
  const value = Number.isFinite(parsedValue) ? parsedValue : 1;
  if (!name) return;
  const id = uniqueId(config.itemTypes.map((i) => i.id), slugify(name));
  config.itemTypes.push({ id, name, icon, value });
  nameInput.value = '';
  iconInput.value = '';
  valueInput.value = '1';
  persistConfigChange();
});

function attachRemoveHandler(containerId) {
  on(containerId, 'click', (e) => {
    const btn = e.target.closest('button[data-remove]');
    if (!btn) return;
    const kind = btn.dataset.remove;
    const id = btn.dataset.id;
    if (!confirm('Remove this type? Historical stats already recorded for it will no longer display.')) return;
    if (kind === 'poi') {
      config.poiTypes = config.poiTypes.filter((p) => p.id !== id);
    } else if (kind === 'item') {
      config.itemTypes = config.itemTypes.filter((i) => i.id !== id);
    } else if (kind === 'difficulty') {
      config.difficulties = config.difficulties.filter((d) => d.id !== id);
    } else if (kind === 'faction') {
      config.factions = config.factions.filter((f) => f.id !== id);
    } else if (kind === 'planet') {
      config.planets = config.planets.filter((pl) => pl.id !== id);
    }
    persistConfigChange();
  });
}
attachRemoveHandler('poi-config-list');
attachRemoveHandler('item-config-list');
attachRemoveHandler('difficulty-config-list');
attachRemoveHandler('faction-config-list');
attachRemoveHandler('planet-config-list');

function addNameOnlyEntry(inputId, listKey) {
  const nameInput = el(inputId);
  const name = nameInput.value.trim();
  if (!name) return;
  const id = uniqueId(config[listKey].map((entry) => entry.id), slugify(name));
  config[listKey].push({ id, name });
  nameInput.value = '';
  persistConfigChange();
}

on('add-difficulty', 'click', () => addNameOnlyEntry('new-difficulty-name', 'difficulties'));
on('add-faction', 'click', () => addNameOnlyEntry('new-faction-name', 'factions'));
on('add-planet', 'click', () => addNameOnlyEntry('new-planet-name', 'planets'));

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
    renderConfigLists();
    renderStats();
    renderSquadModeSelect();
    renderMissionMetaSelects();
    renderStatsFilterSelects();
    renderBackfillSelects();
    if (!el('denom-page')?.classList.contains('hidden')) renderDenomPage();
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
  if (!el('denom-page')?.classList.contains('hidden')) renderDenomPage();
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
