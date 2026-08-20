import { loadConfig, saveConfig, FALLBACK_ICON, isImageIcon } from './config.js?v=20260823r';
import * as state from './state.js?v=20260823r';
import { computeStats, computeDenomStats, filterMissions, resolveItemValues, totalPois } from './stats.js?v=20260823r';
import { pingServer, submitMission, fetchMissions, deleteMissionRemote, submitDenomCount, fetchDenominations } from './api.js?v=20260823r';

let config = loadConfig();
let clientId = state.getClientId();
let serverUrl = state.getServerUrl();
let currentMission = state.getCurrentMission(config);
let globalMissions = null; // lazily fetched
let globalDenomTally = null; // lazily fetched, pooled across all divers: { itemId: { denom: count } }
let statsFilters = { squadMode: 'all', difficulty: 'all', faction: 'all', planet: 'all' };
// minPois: 0 means "any" (unfiltered) — matches how squadMode/difficulty/etc
// use 'all' as their unfiltered sentinel, just numeric since POI count isn't
// a fixed taxonomy id.
let globalLogFilters = { squadMode: 'all', difficulty: 'all', faction: 'all', planet: 'all', minPois: 0 };
// In-memory only (not persisted): a LIFO stack of denominations picked per
// poi+item on the Tally page, so repeated "−" presses undo picks in the exact
// reverse order they were made (pick +3 then +2, and "−" "−" correctly rolls
// back the 2 first, then the 3) instead of only remembering the single most
// recent pick. Resets on reload, which is fine — that's a fresh-session edge
// case, not the common misclick.
let denomPickStacks = {};
// In-memory only (not persisted): which POI cards have their item-tile grid
// manually expanded, on a short viewport where it's collapsed by default —
// see the .is-expanded / max-height:740px handling in style.css. Only
// relevant to Simplified View's tile grid; classic mode's inline rows are
// the only way to tally there (guided flow never fires with Simplified off),
// so they're never collapsed regardless of this set's contents.
let expandedPoiCards = new Set();

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

// Real fade/slide/scale transitions for popups & panels instead of an
// instant display:none toggle — display:none can't itself be transitioned
// (the browser can't interpolate across it), so this removes .hidden, waits
// two animation frames, then adds .is-open, which is what each element's CSS
// actually transitions toward. Double RAF (not one) because a single frame
// can get coalesced with the same paint in some browsers, silently skipping
// the "just appeared, still at rest" frame the transition needs to start
// from. Closing reverses it, waiting for the transition to finish (bounded
// by a fallback timeout — an already-hidden element, or prefers-reduced-
// motion's near-zero duration, might not fire transitionend cleanly) before
// restoring display:none.
function showAnimated(elm) {
  if (!elm) return;
  elm.classList.remove('hidden');
  requestAnimationFrame(() => requestAnimationFrame(() => elm.classList.add('is-open')));
}
function hideAnimated(elm) {
  if (!elm) return;
  elm.classList.remove('is-open');
  const finish = () => elm.classList.add('hidden');
  elm.addEventListener('transitionend', finish, { once: true });
  setTimeout(finish, 250);
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
  // Two separate timers (auto-dismiss, then the delayed re-hide after the
  // fade-out finishes) both need clearing on every call — a toast firing
  // again while a previous one is mid-fade-out would otherwise have its
  // pending re-hide land on the NEW toast and yank it away early.
  clearTimeout(toast._timer);
  clearTimeout(toast._hideTimer);
  t.textContent = message;
  t.className = `toast ${type}`;
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('is-open')));
  toast._timer = setTimeout(() => {
    t.classList.remove('is-open');
    toast._hideTimer = setTimeout(() => t.classList.add('hidden'), 220);
  }, 3000);
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

// Simplified View bundles two things that used to be separate controls
// (an auto-detected mobile/desktop layout switch, and a Settings-page-only
// guided-flow toggle) into one user-facing switch, visible right on the
// Tally page instead of buried in Settings or silently inferred from window
// width. ON: items are tap-to-open tiles, and "+1 FOUND" walks through the
// pick-item/pick-amount loop. OFF: items are classic always-visible inline
// rows, and "+1 FOUND" just marks it found — no popup, tally manually.
// Defaults to a width-based guess on a fresh install (no saved preference
// yet) but — deliberately, per explicit request — does NOT keep following
// window size after that; once it's a visible on-page toggle, resizing out
// from under the user's choice would undermine the point of giving them
// direct control.
const MOBILE_BREAKPOINT_PX = 640;
let simplifiedView = state.getSimplifiedView();
if (simplifiedView === null) simplifiedView = window.innerWidth <= MOBILE_BREAKPOINT_PX;

function renderSimplifiedViewToggle() {
  const t = el('simplified-view-toggle');
  if (t) t.checked = simplifiedView;
}

on('simplified-view-toggle', 'change', (e) => {
  simplifiedView = e.target.checked;
  state.setSimplifiedView(simplifiedView);
  closeItemPopup();
  renderPoiGrid();
  renderQuickAddBar();
});

function slotsFilled(poiId) {
  return config.itemTypes.reduce((sum, i) => sum + (currentMission.itemDrops[poiId]?.[i.id] || 0), 0);
}

function itemRowControlsHtml(poiId, itemId) {
  const i = config.itemTypes.find((x) => x.id === itemId);
  const hasDenoms = i.denominations && i.denominations.length > 0;
  const count = currentMission.itemDrops[poiId]?.[itemId] || 0;
  const stack = hasDenoms ? (denomPickStacks[`${poiId}:${itemId}`] || []) : null;
  const lastPick = stack && stack.length ? stack[stack.length - 1] : null;
  return `
    <button class="btn btn-count minus${lastPick ? ' minus-labeled' : ''}" data-action="item-dec"${lastPick ? ` title="Undo the last pickup you tallied here (${lastPick})"` : ''}>${lastPick ? `−${lastPick}` : '−'}</button>
    <span class="item-count item-popup-count">${count}</span>
    ${hasDenoms ? `
      <div class="denom-pick-group" title="Tally the exact amount you picked up — this feeds Drop Sizes too, no need to double-enter it there">
        ${i.denominations.map((d) => `<button class="btn btn-denom-pick" data-action="item-inc-denom" data-denom="${d}">+${d}</button>`).join('')}
      </div>
    ` : '<button class="btn btn-count plus" data-action="item-inc">+</button>'}
  `;
}

function renderPoiGrid() {
  const grid = el('poi-grid');
  // Classic/desktop item-row-desktop rows need more per-card width than
  // Simplified's compact 2-column tiles do (a fixed name column + a
  // denom-pick-group like "+100 +1000" doesn't fit in the same ~260px a
  // tile grid is happy with — cards that narrow made item names overlap
  // their own controls) — see .poi-grid-desktop in style.css.
  grid.classList.toggle('poi-grid-desktop', !simplifiedView);
  if (config.poiTypes.length === 0) {
    grid.innerHTML = '<p class="empty-note">No POI types configured. Try Settings → Reset All Local Data to restore the defaults.</p>';
    return;
  }
  grid.innerHTML = config.poiTypes.map((p) => {
    const count = currentMission.poiCounts[p.id] || 0;
    const filled = slotsFilled(p.id);
    const totalSlots = count * p.slots;
    const pct = totalSlots > 0 ? Math.min(100, (filled / totalSlots) * 100) : 0;
    const expanded = expandedPoiCards.has(p.id);
    return `
      <div class="poi-card${expanded ? ' is-expanded' : ''}" data-poi="${p.id}">
        <div class="poi-card-header">
          <span class="poi-name">${esc(p.name)}</span>
          <span class="poi-header-right">
            <span class="poi-slots">${p.slots} SLOT${p.slots === 1 ? '' : 'S'}</span>
            ${simplifiedView ? `<button class="poi-expand-toggle" type="button" data-action="poi-toggle-expand" aria-label="${expanded ? 'Hide' : 'Show'} items">${expanded ? '▴' : '▾'}</button>` : ''}
          </span>
        </div>
        <div class="poi-count-row">
          <button class="btn btn-count minus" data-action="poi-dec">−</button>
          <span class="poi-count">${count}</span>
          <button class="btn btn-count plus" data-action="poi-inc">+1 FOUND</button>
        </div>
        ${simplifiedView ? `
          <div class="poi-collapsed-summary">
            ${config.itemTypes.map((i) => {
              const tileCount = currentMission.itemDrops[p.id]?.[i.id] || 0;
              return `
                <span class="poi-collapsed-chip" data-item="${i.id}">
                  ${iconBlock(i.icon)}
                  <span class="poi-collapsed-chip-count">${tileCount}</span>
                </span>
              `;
            }).join('')}
          </div>
        ` : ''}
        <div class="poi-items${simplifiedView ? '' : ' poi-items-desktop'}">
          ${config.itemTypes.map((i) => {
            if (simplifiedView) {
              const tileCount = currentMission.itemDrops[p.id]?.[i.id] || 0;
              return `
                <button class="item-tile" type="button" data-action="item-tile-open" data-item="${i.id}">
                  ${iconBlock(i.icon)}
                  <span class="item-tile-name">${esc(i.name)}</span>
                  ${tileCount > 0 ? `<span class="item-tile-count">${tileCount}</span>` : ''}
                </button>
              `;
            }
            return `
              <div class="item-row-desktop" data-item="${i.id}">
                ${iconBlock(i.icon)}
                <span class="item-name">${esc(i.name)}</span>
                <div class="item-controls">${itemRowControlsHtml(p.id, i.id)}</div>
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

// Shared by both the desktop inline rows (poi-grid's own click handler,
// below) and the mobile item popup (next section) — same mutation, same
// undo-stack bookkeeping, just triggered from two different bits of DOM.
function tallyItemInc(poiId, itemId) {
  currentMission.itemDrops[poiId][itemId] = (currentMission.itemDrops[poiId][itemId] || 0) + 1;
  persistCurrentMission();
  renderPoiGrid();
  renderItemPopupIfOpen();
  renderStats();
}

function tallyItemDec(poiId, itemId) {
  const key = `${poiId}:${itemId}`;
  if ((currentMission.itemDrops[poiId][itemId] || 0) > 0) {
    const stack = denomPickStacks[key];
    if (stack && stack.length > 0) {
      const undoneDenom = stack.pop();
      state.incrementDenomCount(itemId, undoneDenom, -1);
      if (serverUrl) submitDenomCount(serverUrl, clientId, itemId, undoneDenom, state.getDenomTally()[itemId][undoneDenom]).catch(() => {});
    }
    currentMission.itemDrops[poiId][itemId] = Math.max(0, (currentMission.itemDrops[poiId][itemId] || 0) - 1);
  }
  persistCurrentMission();
  renderPoiGrid();
  renderItemPopupIfOpen();
  renderStats();
}

function tallyItemIncDenom(poiId, itemId, denom) {
  const key = `${poiId}:${itemId}`;
  currentMission.itemDrops[poiId][itemId] = (currentMission.itemDrops[poiId][itemId] || 0) + 1;
  state.incrementDenomCount(itemId, denom, 1);
  (denomPickStacks[key] || (denomPickStacks[key] = [])).push(denom);
  if (serverUrl) submitDenomCount(serverUrl, clientId, itemId, denom, state.getDenomTally()[itemId][denom]).catch(() => {});
  persistCurrentMission();
  renderPoiGrid();
  renderItemPopupIfOpen();
  renderStats();
}

// Shared by the quick-add bar and each card's own "+1 FOUND" button — same
// effect either way, just two different places to trigger it from so
// logging a find never requires scrolling to the specific POI's card.
function foundPoi(poiId) {
  currentMission.poiCounts[poiId] = (currentMission.poiCounts[poiId] || 0) + 1;
  persistCurrentMission();
  renderPoiGrid();
  renderStats();
  // Finding a container starts the guided flow: pick what dropped, pick
  // how much, repeat until this POI's slots (across however many of it
  // you've found) are filled — see the "Item popup" section below. The
  // Simplified View toggle (right on the Tally page) turns this off in
  // favor of just marking it found and tallying items manually.
  if (simplifiedView) startGuidedFlow(poiId);
}

// Only shown in Simplified View — that's specifically where scrolling to a
// POI card's own "+1 FOUND" is the annoyance this bar solves (tap-to-open
// tiles are compact, so a card can be scrolled well out of view). In the
// non-simplified inline-row layout every card's full controls are already
// visible on the page, so the bar is just a redundant sticky strip eating
// vertical space — removing it there is what keeps that view fitting the
// screen without scrolling.
function renderQuickAddBar() {
  const bar = el('quick-add-bar');
  if (!bar) return;
  bar.classList.toggle('hidden', !simplifiedView);
  if (!simplifiedView) return;
  bar.innerHTML = `<button class="quick-add-btn" type="button" data-action="quick-add-open">+ ADD POINT OF INTEREST</button>`;
}

on('quick-add-bar', 'click', (e) => {
  const btn = e.target.closest('button[data-action="quick-add-open"]');
  if (!btn) return;
  startPoiPick();
});

on('poi-grid', 'click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const card = e.target.closest('.poi-card');
  const poiId = card.dataset.poi;
  const action = btn.dataset.action;

  if (action === 'poi-toggle-expand') {
    if (expandedPoiCards.has(poiId)) expandedPoiCards.delete(poiId);
    else expandedPoiCards.add(poiId);
    renderPoiGrid();
    return;
  } else if (action === 'poi-inc') {
    foundPoi(poiId);
    return;
  } else if (action === 'poi-dec') {
    currentMission.poiCounts[poiId] = Math.max(0, (currentMission.poiCounts[poiId] || 0) - 1);
  } else if (action === 'item-tile-open') {
    showItemPopup(poiId, btn.dataset.item);
    return;
  } else if (action === 'item-inc' || action === 'item-dec' || action === 'item-inc-denom') {
    // Only reachable with Simplified View off — .item-row-desktop isn't
    // rendered at all when it's on, tiles/popup handle it there instead.
    const itemId = e.target.closest('.item-row-desktop').dataset.item;
    if (action === 'item-inc') tallyItemInc(poiId, itemId);
    else if (action === 'item-dec') tallyItemDec(poiId, itemId);
    else tallyItemIncDenom(poiId, itemId, btn.dataset.denom);
    return;
  } else {
    return;
  }
  persistCurrentMission();
  renderPoiGrid();
  renderStats();
});

/* ---------------- Item popup ----------------
   Two modes, one popup:
   - "single" — tap an item tile (mobile) to tally just that item. Opens
     straight to that item's controls (the −/count/denom-pick-or-plus row).
   - "guided" — tap "+1 FOUND" on a POI. Walks through pick-item, then (for
     denominated items) pick-amount, then loops back to pick-item for the
     next slot, until this POI's total slots are filled. Mirrors physically
     looting a bunker one slot at a time instead of tallying items in
     whatever order/quantity you feel like afterward. */

// { mode: 'single', poiId, itemId } | { mode: 'guided', poiId, itemId: string|null } | null
// Guided mode's itemId is null while on the "pick an item" step, and set
// once an item's been picked, while waiting on "pick an amount".
let openItemPopup = null;

function itemPopupHtml() {
  const { mode, poiId, itemId } = openItemPopup;
  const p = config.poiTypes.find((x) => x.id === poiId);

  if (mode === 'poi-pick') {
    return `
      <div class="item-popup-header">
        <div class="item-popup-heading">
          <div class="item-popup-name">Add Point of Interest</div>
          <div class="item-popup-poi">What did you find?</div>
        </div>
        <button class="btn btn-icon close-btn" data-action="item-popup-close" aria-label="Close">✕</button>
      </div>
      <div class="poi-items">
        ${config.poiTypes.map((x) => `
          <button class="item-tile" type="button" data-action="poi-pick-select" data-poi="${x.id}">
            <span class="item-tile-name">${esc(x.name)}</span>
            <span class="item-tile-sub">${x.slots} SLOT${x.slots === 1 ? '' : 'S'}</span>
          </button>
        `).join('')}
      </div>
    `;
  }

  if (mode === 'guided') {
    const foundCount = currentMission.poiCounts[poiId] || 0;
    const totalSlots = foundCount * p.slots;
    const filled = slotsFilled(poiId);
    // The target grows every time "+1 FOUND" is tapped (totalSlots scales
    // with how many of this POI you've found, not just its own slot count,
    // shown on the card as a fixed "N SLOTS" that doesn't reflect that) — a
    // double-tap or a mistaken extra tap inflates the target with no visual
    // cue why, so the flow just keeps asking for more. Surface it and let it
    // be undone right here instead of forcing a close-and-hunt-for-the-minus-
    // button detour.
    const foundFixHtml = foundCount > 1 ? `
      <p class="hint slot-found-hint">${foundCount} found so far — tapped +1 FOUND more times than intended? <button class="btn-link" type="button" data-action="slot-fix-found">Undo one</button>.</p>
    ` : '';
    if (!itemId) {
      return `
        <div class="item-popup-header">
          <div class="item-popup-heading">
            <div class="item-popup-name">${esc(p.name)}</div>
            <div class="item-popup-poi">Slot ${filled + 1} of ${totalSlots} — what dropped?</div>
          </div>
          <button class="btn btn-icon close-btn" data-action="item-popup-close" aria-label="Close">✕</button>
        </div>
        ${foundFixHtml}
        <div class="poi-items">
          ${config.itemTypes.map((i) => `
            <button class="item-tile" type="button" data-action="slot-pick-item" data-item="${i.id}">
              ${iconBlock(i.icon)}
              <span class="item-tile-name">${esc(i.name)}</span>
            </button>
          `).join('')}
        </div>
      `;
    }
    const i = config.itemTypes.find((x) => x.id === itemId);
    return `
      <div class="item-popup-header">
        ${iconBlock(i.icon)}
        <div class="item-popup-heading">
          <div class="item-popup-name">${esc(i.name)}</div>
          <div class="item-popup-poi">Slot ${filled + 1} of ${totalSlots} — how much?</div>
        </div>
        <button class="btn btn-icon close-btn" data-action="item-popup-close" aria-label="Close">✕</button>
      </div>
      ${foundFixHtml}
      <div class="item-popup-controls">
        <div class="denom-pick-group" title="Tally the exact amount you picked up — this feeds Drop Sizes too, no need to double-enter it there">
          ${i.denominations.map((d) => `<button class="btn btn-denom-pick" data-action="slot-pick-amount" data-denom="${d}">+${d}</button>`).join('')}
        </div>
      </div>
    `;
  }

  const i = config.itemTypes.find((x) => x.id === itemId);
  return `
    <div class="item-popup-header">
      ${iconBlock(i.icon)}
      <div class="item-popup-heading">
        <div class="item-popup-name">${esc(i.name)}</div>
        <div class="item-popup-poi">${esc(p.name)}</div>
      </div>
      <button class="btn btn-icon close-btn" data-action="item-popup-close" aria-label="Close">✕</button>
    </div>
    <div class="item-popup-controls">${itemRowControlsHtml(poiId, itemId)}</div>
  `;
}

function renderItemPopupIfOpen() {
  if (!openItemPopup) return;
  el('item-popup').innerHTML = itemPopupHtml();
}

function openPopup(state) {
  openItemPopup = state;
  renderItemPopupIfOpen();
  showAnimated(el('item-popup'));
  showAnimated(el('item-popup-overlay'));
}

function showItemPopup(poiId, itemId) {
  openPopup({ mode: 'single', poiId, itemId });
}

function startGuidedFlow(poiId) {
  openPopup({ mode: 'guided', poiId, itemId: null });
}

function startPoiPick() {
  openPopup({ mode: 'poi-pick' });
}

function closeItemPopup() {
  openItemPopup = null;
  hideAnimated(el('item-popup'));
  hideAnimated(el('item-popup-overlay'));
}

// After tallying one slot's pick (item, or item+amount), either loop back to
// "pick an item" for the next slot or close once the POI's slots are full.
function guidedAdvanceOrClose() {
  if (!openItemPopup || openItemPopup.mode !== 'guided') return;
  const { poiId } = openItemPopup;
  const p = config.poiTypes.find((x) => x.id === poiId);
  const totalSlots = (currentMission.poiCounts[poiId] || 0) * p.slots;
  if (slotsFilled(poiId) >= totalSlots) {
    closeItemPopup();
  } else {
    openItemPopup.itemId = null;
    renderItemPopupIfOpen();
  }
}

function guidedPickItem(itemId) {
  if (!openItemPopup || openItemPopup.mode !== 'guided') return;
  const { poiId } = openItemPopup;
  const item = config.itemTypes.find((x) => x.id === itemId);
  if (item.denominations && item.denominations.length > 0) {
    openItemPopup.itemId = itemId;
    renderItemPopupIfOpen();
  } else {
    tallyItemInc(poiId, itemId);
    guidedAdvanceOrClose();
  }
}

function guidedPickAmount(denom) {
  if (!openItemPopup || openItemPopup.mode !== 'guided') return;
  const { poiId, itemId } = openItemPopup;
  tallyItemIncDenom(poiId, itemId, denom);
  guidedAdvanceOrClose();
}

// Undoes one "+1 FOUND" tap from inside the guided popup itself — the fix
// for accidentally inflating the target slot count (see the comment in
// itemPopupHtml's guided branch). Shrinks totalSlots and re-checks whether
// that's now enough to close, same as finishing a slot normally would.
function guidedDecrementFound() {
  if (!openItemPopup || openItemPopup.mode !== 'guided') return;
  const { poiId } = openItemPopup;
  currentMission.poiCounts[poiId] = Math.max(0, (currentMission.poiCounts[poiId] || 0) - 1);
  persistCurrentMission();
  renderPoiGrid();
  guidedAdvanceOrClose();
}

on('item-popup-overlay', 'click', closeItemPopup);

on('item-popup', 'click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'item-popup-close') {
    closeItemPopup();
    return;
  }
  if (!openItemPopup) return;

  if (openItemPopup.mode === 'poi-pick') {
    if (action === 'poi-pick-select') foundPoi(btn.dataset.poi);
    return;
  }

  if (openItemPopup.mode === 'guided') {
    if (action === 'slot-pick-item') guidedPickItem(btn.dataset.item);
    else if (action === 'slot-pick-amount') guidedPickAmount(btn.dataset.denom);
    else if (action === 'slot-fix-found') guidedDecrementFound();
    return;
  }

  const { poiId, itemId } = openItemPopup;
  if (action === 'item-inc') tallyItemInc(poiId, itemId);
  else if (action === 'item-dec') tallyItemDec(poiId, itemId);
  else if (action === 'item-inc-denom') tallyItemIncDenom(poiId, itemId, btn.dataset.denom);
});

/* ---------------- New Mission ---------------- */

on('new-mission-btn', 'click', async () => {
  const { completed, fresh } = state.completeMission(config);
  currentMission = fresh;
  closeItemPopup();
  closeMissionPanel();
  renderPoiGrid();
  renderStats();
  renderSquadModeSelect();
  renderMissionMetaSelects();
  toast('Mission saved. New mission started.', 'success');
  await trySyncMission(completed);
});

on('clear-mission-btn', 'click', () => {
  if (!confirm('Discard the current in-progress mission without saving it? This cannot be undone.')) return;
  currentMission = state.discardCurrentMission(config);
  closeItemPopup();
  closeMissionPanel();
  renderPoiGrid();
  renderSquadModeSelect();
  renderMissionMetaSelects();
  toast('Mission cleared — nothing was saved.', 'success');
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
  // Global Stats' mission list (globalMissions) previously only refreshed
  // when the GLOBAL STATS tab button was clicked — a delete/edit by another
  // diver (or even your own, if the tab was already active before you left
  // the page) would sit stale indefinitely. Refreshing it on every sync pass
  // (same 30s interval already used for global denom data) means it self-
  // heals instead of requiring a manual tab re-click.
  await refreshGlobalStats();
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
    // Global Missions (the Missions page's other tab) reads the exact same
    // globalMissions array — refresh it here too whenever it's visible, same
    // reasoning as Global Stats: a mission deleted/added elsewhere shouldn't
    // sit stale until the tab happens to get re-clicked.
    if (!el('log-global')?.classList.contains('hidden')) renderGlobalLogPage();
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
    // refreshGlobalStats() re-fetches globalMissions and calls renderStats()
    // itself — without a server it wouldn't pick up the deletion, so fall
    // back to a plain renderStats() for the local-only view in that case.
    if (serverUrl) {
      await refreshGlobalStats();
    } else {
      renderStats();
    }
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

/* ---------------- Global Missions (read-only, all divers) ---------------- */
// Shares globalMissions with Global Stats (same fetch, same data) — this is
// just a per-mission list/detail view of the identical dataset Global Stats
// aggregates, filtered the same way (filterMissions, same filter shape plus
// minPois). No edit/delete here — ownership is per-clientId server-side, so
// another diver's mission genuinely can't be touched from here, only viewed.

function renderGlobalLogFilterSelects() {
  populateSelectOptions(el('global-log-difficulty-filter'), config.difficulties, { allLabel: 'All Difficulties', unknownLabel: 'Unlabeled' });
  populateSelectOptions(el('global-log-faction-filter'), config.factions, { allLabel: 'All Factions', unknownLabel: 'Unlabeled' });
  populateSelectOptions(el('global-log-planet-filter'), config.planets, { allLabel: 'All Planets', unknownLabel: 'Unlabeled' });
}

function globalMissionDetailHtml(m) {
  return `
    <div class="log-view-detail hidden">
      ${config.poiTypes.map((p) => `
        <div class="log-edit-poi">
          <div class="row">
            <span class="denom-label">${esc(p.name)}</span>
            <span class="log-view-value">${m.poiCounts?.[p.id] || 0}</span>
          </div>
          <div class="log-edit-items">
            ${config.itemTypes.map((i) => `
              <div class="item-row">
                ${iconBlock(i.icon)}
                <span class="item-name">${esc(i.name)}</span>
                <span class="log-view-value">${m.itemDrops?.[p.id]?.[i.id] || 0}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function globalMissionCardHtml(m) {
  const diverShort = (m.clientId || '').slice(0, 8) || 'unknown';
  const poiSummary = config.poiTypes
    .map((p) => ({ name: p.name, count: m.poiCounts?.[p.id] || 0 }))
    .filter((x) => x.count > 0)
    .map((x) => `${x.count}x ${x.name}`)
    .join(', ') || 'No POIs tallied';
  return `
    <div class="log-card" data-id="${esc(m.id)}">
      <div class="log-card-header">
        <span class="log-card-date">${esc(new Date(m.startedAt).toLocaleString())} — Diver ${esc(diverShort)}</span>
        <div class="log-card-tags">
          <span class="log-tag">${esc(SQUAD_MODE_LABELS[m.squadMode || 'unknown'] || m.squadMode)}</span>
          <span class="log-tag">${esc(missionLabel(m, 'difficulties', 'difficulty'))}</span>
          <span class="log-tag">${esc(missionLabel(m, 'factions', 'faction'))}</span>
          <span class="log-tag">${esc(missionLabel(m, 'planets', 'planet'))}</span>
          <span class="log-tag">${totalPois(m)} POI${totalPois(m) === 1 ? '' : 'S'}</span>
        </div>
      </div>
      <div class="log-card-summary">${esc(poiSummary)}</div>
      <div class="log-card-actions">
        <button class="btn" type="button" data-action="global-log-view">View Details</button>
      </div>
      ${globalMissionDetailHtml(m)}
    </div>
  `;
}

// Sorted newest-first (the server returns oldest-first) and capped — global
// mission history has no natural ceiling the way one diver's own history
// does, so a popular server could realistically accumulate thousands of
// rows over time. Capping the render (not the fetch/filter) keeps the DOM
// bounded without needing real pagination yet.
const GLOBAL_LOG_RENDER_CAP = 200;

function renderGlobalLogPage() {
  const container = el('global-log-list');
  if (!container) return;
  if (!serverUrl) {
    container.innerHTML = '<p class="empty-note">Set a server in Settings to see missions from every diver.</p>';
    return;
  }
  if (!globalMissions) {
    container.innerHTML = '<p class="empty-note">Loading…</p>';
    return;
  }
  const filtered = filterMissions(globalMissions, globalLogFilters).slice().sort((a, b) => b.startedAt - a.startedAt);
  if (filtered.length === 0) {
    container.innerHTML = '<p class="empty-note">No missions match these filters.</p>';
    return;
  }
  const shown = filtered.slice(0, GLOBAL_LOG_RENDER_CAP);
  const truncatedNote = filtered.length > GLOBAL_LOG_RENDER_CAP
    ? `<p class="hint">Showing the ${GLOBAL_LOG_RENDER_CAP} most recent of ${filtered.length} matching missions — narrow the filters to see more specific ones.</p>`
    : '';
  container.innerHTML = truncatedNote + shown.map(globalMissionCardHtml).join('');
}

on('global-log-list', 'click', (e) => {
  const btn = e.target.closest('button[data-action="global-log-view"]');
  if (!btn) return;
  const card = btn.closest('.log-card');
  const detail = card.querySelector('.log-view-detail');
  const isNowHidden = detail.classList.toggle('hidden');
  btn.textContent = isNowHidden ? 'View Details' : 'Hide Details';
});

on('global-log-squad-filter', 'change', (e) => { globalLogFilters.squadMode = e.target.value; renderGlobalLogPage(); });
on('global-log-difficulty-filter', 'change', (e) => { globalLogFilters.difficulty = e.target.value; renderGlobalLogPage(); });
on('global-log-faction-filter', 'change', (e) => { globalLogFilters.faction = e.target.value; renderGlobalLogPage(); });
on('global-log-planet-filter', 'change', (e) => { globalLogFilters.planet = e.target.value; renderGlobalLogPage(); });
on('global-log-poi-filter', 'change', (e) => { globalLogFilters.minPois = parseInt(e.target.value, 10) || 0; renderGlobalLogPage(); });

// Separate class/handler from the Stats page's .tab-btn (My Stats/Global
// Stats) — reusing that class and its document-wide querySelectorAll would
// have made this tab pair fight over the same "deactivate every .tab-btn on
// the page" sweep and the same mine/global element ids.
document.querySelectorAll('.log-tab-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.log-tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.logtab;
    el('log-mine').classList.toggle('hidden', tab !== 'mine');
    el('log-global').classList.toggle('hidden', tab !== 'global');
    if (tab === 'global') {
      renderGlobalLogFilterSelects();
      // refreshGlobalStats() already calls renderGlobalLogPage() itself once
      // #log-global is visible (see above) — only need the explicit call
      // here for the offline case, where it returns early without rendering.
      if (serverUrl) {
        await refreshGlobalStats();
      } else {
        renderGlobalLogPage();
      }
    }
  });
});

/* ---------------- Settings panel ---------------- */

function openSettings() {
  showAnimated(el('settings-panel'));
  showAnimated(el('settings-overlay'));
}
function closeSettings() {
  hideAnimated(el('settings-panel'));
  hideAnimated(el('settings-overlay'));
}
on('settings-btn', 'click', openSettings);
on('client-badge', 'click', openSettings);
on('close-settings', 'click', closeSettings);
on('settings-overlay', 'click', closeSettings);

/* ---------------- Mission setup drawer (narrow viewports) ---------------- */
// Below 1300px, mission setup (squad/difficulty/faction/planet + actions)
// moves off-canvas behind the hamburger instead of stacking above the POI
// cards — see the max-width:1299px block in style.css. At >=1300px this is
// a no-op: #mission-config-btn is CSS-hidden there and .mission-panel is
// laid out as the sidebar instead, unaffected by the is-open class.
// Unlike settings/item-popup, .mission-panel itself never gets the
// .hidden class — it has to stay a normal, always-visible sidebar column
// at >=1300px, so only its transform-driven .is-open class is toggled here;
// the hidden/showAnimated dance is reserved for the overlay, which really
// is narrow-viewport-only.
function openMissionPanel() {
  el('mission-panel').classList.add('is-open');
  showAnimated(el('mission-panel-overlay'));
}
function closeMissionPanel() {
  el('mission-panel').classList.remove('is-open');
  hideAnimated(el('mission-panel-overlay'));
}
on('mission-config-btn', 'click', openMissionPanel);
on('close-mission-panel', 'click', closeMissionPanel);
on('mission-panel-overlay', 'click', closeMissionPanel);

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
    closeItemPopup();
    renderQuickAddBar();
    renderPoiGrid();
    renderStats();
    renderSquadModeSelect();
    renderMissionMetaSelects();
    renderStatsFilterSelects();
    renderGlobalLogFilterSelects();
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
  closeItemPopup();
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
  safe(renderSimplifiedViewToggle, 'renderSimplifiedViewToggle');
  safe(renderQuickAddBar, 'renderQuickAddBar');
  safe(renderPoiGrid, 'renderPoiGrid');
  safe(renderMissionMetaSelects, 'renderMissionMetaSelects');
  safe(renderStatsFilterSelects, 'renderStatsFilterSelects');
  safe(renderGlobalLogFilterSelects, 'renderGlobalLogFilterSelects');
  safe(renderBackfillSelects, 'renderBackfillSelects');
  safe(renderStats, 'renderStats');
  safe(renderSquadModeSelect, 'renderSquadModeSelect');
  syncPendingMissions().then(() => {
    if (!el('stats-global')?.classList.contains('hidden')) refreshGlobalStats();
  }).catch((err) => console.error('Stat Gatherer: initial sync failed', err));
  setInterval(syncPendingMissions, 30000);
}

safe(init, 'init');
