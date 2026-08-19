import { loadConfig, saveConfig, slugify, uniqueId, FALLBACK_ICON, isImageIcon } from './config.js';
import * as state from './state.js';
import { computeStats, computeDenomStats, formatDuration } from './stats.js';
import { pingServer, submitMission, fetchMissions } from './api.js';

let config = loadConfig();
let clientId = state.getClientId();
let serverUrl = state.getServerUrl();
let currentMission = state.getCurrentMission(config);
let globalMissions = null; // lazily fetched
let statsSquadFilter = 'all';

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

/* ---------------- Timer ---------------- */

function tickTimer() {
  el('timer-display').textContent = formatDuration(state.elapsedMs(currentMission));
}
setInterval(tickTimer, 1000);

function isPaused() {
  return currentMission.runningSince == null;
}

function updatePauseUI() {
  const paused = isPaused();
  el('pause-mission-btn').textContent = paused ? '▶ RESUME' : '⏸ PAUSE';
  el('pause-indicator').classList.toggle('hidden', !paused);
  el('timer-display').classList.toggle('paused', paused);
}

on('pause-mission-btn', 'click', () => {
  currentMission = isPaused() ? state.resumeMission(currentMission) : state.pauseMission(currentMission);
  updatePauseUI();
  tickTimer();
});

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
  updatePauseUI();
  renderSquadModeSelect();
  tickTimer();
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

/* ---------------- Stats ---------------- */

function statsHtml(stats) {
  if (stats.totalMissions === 0) {
    return '<p class="empty-note">No completed missions yet. Tally some POIs and hit "New Mission" to save your first one.</p>';
  }
  return `
    <div class="stats-summary">
      <div class="stat-tile"><span class="stat-value">${stats.totalMissions}</span><span class="stat-label">MISSIONS</span></div>
      <div class="stat-tile"><span class="stat-value">${formatDuration(stats.totalDurationMs)}</span><span class="stat-label">TOTAL TIME</span></div>
      <div class="stat-tile"><span class="stat-value">${stats.totalPois}</span><span class="stat-label">POIs FOUND</span></div>
      <div class="stat-tile"><span class="stat-value">${stats.avgPoisPerMission.toFixed(1)}</span><span class="stat-label">AVG POIs / MISSION</span></div>
      <div class="stat-tile"><span class="stat-value">${stats.totalItemDrops}</span><span class="stat-label">RESOURCES FOUND</span></div>
      <div class="stat-tile"><span class="stat-value">${stats.avgItemDropsPerMission.toFixed(1)}</span><span class="stat-label">AVG RESOURCES / MISSION</span></div>
    </div>

    <h3>POI Frequency</h3>
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
    <table class="stats-table">
      <thead><tr><th>Item</th><th>Total</th><th>% of Drops</th><th>Avg / Mission</th><th>/ Hour</th><th>/ Min</th><th>/ Sec</th></tr></thead>
      <tbody>
        ${config.itemTypes.map((i) => `
          <tr>
            <td>${iconInline(i.icon)} ${esc(i.name)}</td>
            <td>${stats.items[i.id].total}</td>
            <td>${(stats.items[i.id].pctOfDrops * 100).toFixed(1)}%</td>
            <td>${stats.items[i.id].perMission.toFixed(2)}</td>
            <td>${stats.items[i.id].perHour.toFixed(2)}</td>
            <td>${stats.items[i.id].perMinute.toFixed(3)}</td>
            <td>${stats.items[i.id].perSecond.toFixed(4)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <h3>Resource Value</h3>
    <table class="stats-table">
      <thead><tr><th>Item</th><th>Value Each</th><th>Total Value</th><th>Value / Mission</th><th>Value / Hour</th><th>Value / Min</th><th>Value / Sec</th></tr></thead>
      <tbody>
        ${config.itemTypes.map((i) => `
          <tr>
            <td>${iconInline(i.icon)} ${esc(i.name)}</td>
            <td>${stats.items[i.id].avgValue}</td>
            <td>${stats.items[i.id].totalValue.toFixed(0)}</td>
            <td>${stats.items[i.id].valuePerMission.toFixed(1)}</td>
            <td>${stats.items[i.id].valuePerHour.toFixed(1)}</td>
            <td>${stats.items[i.id].valuePerMinute.toFixed(2)}</td>
            <td>${stats.items[i.id].valuePerSecond.toFixed(3)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <h3>Drop Probability by POI</h3>
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

function filterBySquadMode(missions) {
  if (statsSquadFilter === 'all') return missions;
  return missions.filter((m) => (m.squadMode || 'unknown') === statsSquadFilter);
}

function renderStats() {
  const history = filterBySquadMode(state.getHistory());
  el('stats-mine').innerHTML = statsHtml(computeStats(history, config));
  if (globalMissions) {
    el('stats-global').innerHTML = statsHtml(computeStats(filterBySquadMode(globalMissions), config));
  } else {
    el('stats-global').innerHTML = serverUrl
      ? '<p class="empty-note">Loading global stats…</p>'
      : '<p class="empty-note">Set a server URL in Settings to see global stats from all divers.</p>';
  }
}

on('stats-squad-filter', 'change', (e) => {
  statsSquadFilter = e.target.value;
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
    if (page === 'denom') renderDenomPage();
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
    } else {
      config.itemTypes = config.itemTypes.filter((i) => i.id !== id);
    }
    persistConfigChange();
  });
}
attachRemoveHandler('poi-config-list');
attachRemoveHandler('item-config-list');

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
    updatePauseUI();
    renderSquadModeSelect();
    if (!el('denom-page')?.classList.contains('hidden')) renderDenomPage();
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
  updatePauseUI();
  renderSquadModeSelect();
  if (!el('denom-page')?.classList.contains('hidden')) renderDenomPage();
  toast('Local data reset.', 'success');
});

/* ---------------- Init ---------------- */

function init() {
  safe(renderClientBadge, 'renderClientBadge');
  safe(renderPoiGrid, 'renderPoiGrid');
  safe(renderStats, 'renderStats');
  safe(updatePauseUI, 'updatePauseUI');
  safe(renderSquadModeSelect, 'renderSquadModeSelect');
  safe(tickTimer, 'tickTimer');
  syncPendingMissions().then(() => {
    if (!el('stats-global')?.classList.contains('hidden')) refreshGlobalStats();
  }).catch((err) => console.error('Stat Gatherer: initial sync failed', err));
  setInterval(syncPendingMissions, 30000);
}

safe(init, 'init');
