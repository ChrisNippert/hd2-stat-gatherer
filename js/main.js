import { loadConfig, saveConfig, FALLBACK_ICON, isImageIcon } from './config.js?v=20260820ar';
import * as state from './state.js?v=20260820ar';
import { computeStats, computeDenomStats, filterMissions, resolveItemValues, totalPois, buildDenomTallyFromMissions } from './stats.js?v=20260820ar';
import { pingServer, submitMission, fetchMissions, deleteMissionRemote } from './api.js?v=20260820ar';

let config = loadConfig();
let clientId = state.getClientId();
let serverUrl = state.getServerUrl();
let currentMission = state.getCurrentMission(config);
let globalMissions = null; // lazily fetched
let statsFilters = { squadMode: 'all', difficulty: 'all', faction: 'all', planet: 'all' };
// minPois: 0 means "any" (unfiltered) — matches how squadMode/difficulty/etc
// use 'all' as their unfiltered sentinel, just numeric since POI count isn't
// a fixed taxonomy id.
let globalLogFilters = { squadMode: 'all', difficulty: 'all', faction: 'all', planet: 'all', minPois: 0 };
// In-memory only (not persisted): which POI cards have their item-tile grid
// manually expanded, on a short viewport where it's collapsed by default —
// see the .is-expanded / max-height:740px handling in style.css. Only
// relevant to Simplified View's tile grid; classic mode's inline rows are
// the only way to tally there (guided flow never fires with Simplified off),
// so they're never collapsed regardless of this set's contents.
let expandedPoiCards = new Set();
let quickGuide = null;
let quickGuideTrackTimer = null;

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
  clearTimeout(elm._hideAnimatedTimer);
  if (elm._hideAnimatedFinish) {
    elm.removeEventListener('transitionend', elm._hideAnimatedFinish);
    elm._hideAnimatedFinish = null;
  }
  elm.classList.remove('hidden');
  requestAnimationFrame(() => requestAnimationFrame(() => elm.classList.add('is-open')));
}
function hideAnimated(elm) {
  if (!elm) return;
  clearTimeout(elm._hideAnimatedTimer);
  if (elm._hideAnimatedFinish) elm.removeEventListener('transitionend', elm._hideAnimatedFinish);
  elm.classList.remove('is-open');
  const finish = () => {
    if (elm._hideAnimatedFinish !== finish) return;
    elm.classList.add('hidden');
    elm._hideAnimatedFinish = null;
    clearTimeout(elm._hideAnimatedTimer);
  };
  elm._hideAnimatedFinish = finish;
  elm.addEventListener('transitionend', finish, { once: true });
  elm._hideAnimatedTimer = setTimeout(finish, 250);
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

function isVisible(elm) {
  if (!elm) return false;
  if (elm.classList?.contains('hidden')) return false;
  const style = getComputedStyle(elm);
  return style.display !== 'none' && style.visibility !== 'hidden' && elm.getClientRects().length > 0;
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

/* ---------------- Quick guide ---------------- */

function currentGuideMissionControlTarget() {
  return isVisible(el('poi-new-mission-btn')) ? el('poi-new-mission-btn') : el('new-mission-btn');
}

function currentGuideAddTarget() {
  const quickAdd = el('quick-add-bar')?.querySelector('button[data-action="quick-add-open"]');
  if (isVisible(quickAdd)) return quickAdd;
  return document.querySelector('#poi-grid button[data-action="poi-inc"]');
}

function guidePoiTarget(poiId) {
  return document.querySelector(`#poi-grid .poi-card[data-poi="${poiId}"]`);
}

function poiPreviewImage(poiId) {
  const previews = {
    two_man_bunker: {
      src: 'assets/guide/bunker-ref-2.png',
      alt: 'Bunker exterior example',
    },
    explodable_bunker: {
      src: 'assets/guide/container-ref-2.png',
      alt: 'Container exterior example',
    },
    loot_pod: {
      src: 'assets/guide/loot-pod-ref-2.png',
      alt: 'Loot pod exterior example',
    },
  };
  return previews[poiId] || null;
}

const GUIDE_PRELOAD_SOURCES = [
  'assets/guide/bunker-ref-1.png',
  'assets/guide/bunker-ref-2.png',
  'assets/guide/bunker-ref-3.png',
  'assets/guide/container-ref-1.png',
  'assets/guide/container-ref-2.png',
  'assets/guide/container-ref-3.png',
  'assets/guide/loot-pod-ref-1.png',
  'assets/guide/loot-pod-ref-2.png',
  'assets/guide/loot-pod-ref-3.png',
  'assets/guide/for-democracy-hero.png',
];

function preloadImages(srcs) {
  if (!Array.isArray(srcs) || !srcs.length) return;
  preloadImages._seen ||= new Set();
  srcs.forEach((src) => {
    if (!src || preloadImages._seen.has(src)) return;
    preloadImages._seen.add(src);
    const img = new Image();
    img.decoding = 'async';
    img.loading = 'eager';
    img.src = src;
  });
}

function buildQuickGuideSteps() {
  return [
    {
      target: () => el('client-badge'),
      title: 'Diver Identity',
      body: 'This Diver ID is the profile your missions and synced stats belong to. Open Settings here if you ever want to switch to another diver.',
      highlightPad: { top: 10, right: 10, bottom: 10, left: 6 },
    },
    {
      target: () => window.innerWidth < 1300 ? el('mission-config-btn') : document.querySelector('#mission-panel .mission-meta-grid'),
      title: 'Mission Setup',
      body: window.innerWidth < 1300
        ? 'Use this drawer for squad mode, difficulty, faction, and planet before or during a run.'
        : 'Your squad mode, difficulty, faction, and planet live here for the current run.',
    },
    {
      target: currentGuideMissionControlTarget,
      title: 'Mission Actions',
      body: 'Save & Reset finishes the current mission and starts a fresh one. Clear throws away a bad in-progress tally without saving it.',
    },
    {
      target: currentGuideAddTarget,
      title: simplifiedView ? 'Log a Minor Place Fast' : 'Mark a Minor Place Found',
      body: simplifiedView
        ? 'Use Add Minor Place for the fastest phone flow, or tap +1 FOUND on a specific card if you already know which one you found.'
        : 'Tap +1 FOUND on the matching Minor Place card each time you find one, then tally what dropped on that card.',
    },
    {
      target: () => document.querySelector('#poi-grid .poi-card'),
      title: 'Tally the Drops',
      body: 'Each Minor Place has a slot count. These POIs can spawn in slightly different formations, but they still fall under one of the three tracked types here. Log the special bunker/container/pod rewards from those slots — not loose samples around the area — so the stats stay tied to the right container type.',
    },
    {
      target: () => guidePoiTarget('two_man_bunker'),
      title: 'Bunker Example',
      body: 'Bunkers can vary visually, and some lookalikes are not actually openable. Use this as a recognition aid for the kind of special loot POI the app means.',
      gallery: [
        {
          src: 'assets/guide/bunker-ref-1.png',
          alt: 'Bunker minimap example',
          caption: 'Minimap',
        },
        {
          src: 'assets/guide/bunker-ref-2.png',
          alt: 'Bunker exterior example',
          caption: 'What it can look like',
        },
        {
          src: 'assets/guide/bunker-ref-3.png',
          alt: 'Bunker interior loot example',
          caption: 'Loot inside',
        },
      ],
    },
    {
      target: () => guidePoiTarget('explodable_bunker'),
      title: 'Container Example',
      body: 'Containers can show up as blue utility-building style structures, in ground ditches, or tucked around similar utility buildings. You have to blow them open to reach the loot. Count the special loot in the container itself, not loose samples around it.',
      gallery: [
        {
          src: 'assets/guide/container-ref-1.png',
          alt: 'Container minimap example',
          caption: 'Map icon',
        },
        {
          src: 'assets/guide/container-ref-2.png',
          alt: 'Container exterior example',
          caption: 'One outside example',
        },
        {
          src: 'assets/guide/container-ref-3.png',
          alt: 'Container interior loot example',
          caption: 'Loot inside',
        },
      ],
    },
    {
      target: () => guidePoiTarget('loot_pod'),
      title: 'Loot Pod Example',
      body: 'Loot pods can vary around the edges too, but they still count as the same tracked Loot Pod type when the special reward pod is what you found.',
      gallery: [
        {
          src: 'assets/guide/loot-pod-ref-1.png',
          alt: 'Loot pod minimap example',
          caption: 'Minimap',
        },
        {
          src: 'assets/guide/loot-pod-ref-2.png',
          alt: 'Loot pod exterior example',
          caption: 'Pod outside',
        },
        {
          src: 'assets/guide/loot-pod-ref-3.png',
          alt: 'Loot pod opened example',
          caption: 'Pod inside',
        },
      ],
    },
    {
      target: () => el('simplified-view-toggle')?.closest('.toggle-row'),
      title: 'Simplified View',
      body: 'Simplified ON gives you the guided phone-friendly flow. OFF shows every item row inline for faster manual tallying.',
    },
    {
      target: () => document.querySelector('button[data-page="stats"]'),
      title: 'Stats',
      body: 'Stats rolls your saved missions into drop-rate numbers, charts, and pooled frequency data.',
      suppressTargetOutline: true,
    },
    {
      target: () => document.querySelector('button[data-page="log"]'),
      title: 'Mission Log',
      body: 'Missions lets you edit or delete old runs later, including whether a run really cleared every Minor Place.',
      suppressTargetOutline: true,
    },
    {
      target: currentGuideMissionControlTarget,
      title: 'Final Submission Prompt',
      body: 'When you save a mission, we ask one last question about whether you think you picked up everything on the map. That keeps Minor Place frequency stats from being skewed by incomplete clears.',
    },
    {
      target: () => document.querySelector('.brand'),
      title: 'Ministry of Statistics',
      body: 'Every properly tallied drop strengthens the war effort. Identify the correct POI, record its strategic yield with pride, and deliver your findings to the Ministry of Statistics for the continued prosperity of Managed Democracy.',
      imageSrc: 'assets/guide/for-democracy-hero.png',
      imageAlt: 'Helldiver standing before Super Earth High Command',
      imageCaption: 'FOR DEMOCRACY. FOR SUPER EARTH. FOR STATISTICS.',
      imageClass: 'guide-media-hero',
      centered: true,
      suppressHighlight: true,
    },
  ].filter((step) => isVisible(step.target()));
}

function clearQuickGuideTarget() {
  document.querySelector('.guide-focus-target')?.classList.remove('guide-focus-target');
}

function finishQuickGuide(markSeen = true) {
  clearInterval(quickGuideTrackTimer);
  quickGuideTrackTimer = null;
  clearQuickGuideTarget();
  quickGuide = null;
  el('guide-overlay')?.style.removeProperty('clip-path');
  el('guide-overlay')?.style.removeProperty('-webkit-clip-path');
  el('guide-highlight')?.classList.add('hidden');
  hideAnimated(el('guide-callout'));
  hideAnimated(el('guide-overlay'));
  if (markSeen) state.setQuickGuideSeen(true);
}

function trackQuickGuidePosition(durationMs = 1400) {
  clearInterval(quickGuideTrackTimer);
  if (!quickGuide) return;
  const started = Date.now();
  const tick = () => {
    if (!quickGuide) {
      clearInterval(quickGuideTrackTimer);
      quickGuideTrackTimer = null;
      return;
    }
    positionQuickGuide();
    if (Date.now() - started >= durationMs) {
      clearInterval(quickGuideTrackTimer);
      quickGuideTrackTimer = null;
    }
  };
  tick();
  quickGuideTrackTimer = setInterval(tick, 80);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(n, max));
}

function rectOverlapArea(a, b) {
  const overlapWidth = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const overlapHeight = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return overlapWidth * overlapHeight;
}

function placeGuideCallout(rect, box, margin, sideFirst) {
  const verticalPref = rect.top < window.innerHeight * 0.45 ? 'below' : 'above';
  const horizontalPref = rect.left + (rect.width / 2) < window.innerWidth / 2 ? 'right' : 'left';
  const orders = sideFirst
    ? [horizontalPref, horizontalPref === 'right' ? 'left' : 'right', verticalPref, verticalPref === 'below' ? 'above' : 'below']
    : [verticalPref, verticalPref === 'below' ? 'above' : 'below', horizontalPref, horizontalPref === 'right' ? 'left' : 'right'];
  const highlightRect = {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
  };
  const candidates = {
    right: {
      top: rect.top + ((rect.height - box.height) / 2),
      left: rect.right + margin,
    },
    left: {
      top: rect.top + ((rect.height - box.height) / 2),
      left: rect.left - box.width - margin,
    },
    below: {
      top: rect.bottom + margin,
      left: rect.left + ((rect.width - box.width) / 2),
    },
    above: {
      top: rect.top - box.height - margin,
      left: rect.left + ((rect.width - box.width) / 2),
    },
  };

  return orders
    .map((side, index) => {
      const raw = candidates[side];
      const top = clamp(raw.top, margin, window.innerHeight - box.height - margin);
      const left = clamp(raw.left, margin, window.innerWidth - box.width - margin);
      const calloutRect = { left, top, right: left + box.width, bottom: top + box.height };
      const overlap = rectOverlapArea(calloutRect, highlightRect);
      const overflowPenalty = Math.abs(raw.top - top) + Math.abs(raw.left - left);
      return { top, left, overlap, overflowPenalty, priority: index };
    })
    .sort((a, b) => (
      (a.overlap - b.overlap)
      || (a.overflowPenalty - b.overflowPenalty)
      || (a.priority - b.priority)
    ))[0];
}

function positionQuickGuide() {
  if (!quickGuide) return;
  const step = quickGuide.steps[quickGuide.index];
  const target = quickGuide.target;
  if (!step?.centered && !isVisible(target)) return;
  const callout = el('guide-callout');
  const overlay = el('guide-overlay');
  const highlight = el('guide-highlight');
  const margin = 12;
  if (step?.centered) {
    highlight.classList.add('hidden');
    overlay.style.removeProperty('clip-path');
    overlay.style.removeProperty('-webkit-clip-path');
    const box = callout.getBoundingClientRect();
    callout.style.top = `${Math.round(Math.max(margin, (window.innerHeight - box.height) / 2))}px`;
    callout.style.left = `${Math.round(Math.max(margin, (window.innerWidth - box.width) / 2))}px`;
    return;
  }
  const rect = target.getBoundingClientRect();
  const pad = step?.highlightPad ?? 16;
  const highlightPad = typeof pad === 'number'
    ? { top: pad, right: pad, bottom: pad, left: pad }
    : { top: 16, right: 16, bottom: 16, left: 16, ...pad };
  const cutoutLeft = Math.max(6, Math.round(rect.left - highlightPad.left));
  const cutoutTop = Math.max(6, Math.round(rect.top - highlightPad.top));
  const cutoutRight = Math.min(window.innerWidth - 6, Math.round(rect.right + highlightPad.right));
  const cutoutBottom = Math.min(window.innerHeight - 6, Math.round(rect.bottom + highlightPad.bottom));
  highlight.classList.remove('hidden');
  highlight.style.left = `${cutoutLeft}px`;
  highlight.style.top = `${cutoutTop}px`;
  highlight.style.width = `${Math.max(0, cutoutRight - cutoutLeft)}px`;
  highlight.style.height = `${Math.max(0, cutoutBottom - cutoutTop)}px`;
  const cutoutClip = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${cutoutLeft}px ${cutoutTop}px, ${cutoutLeft}px ${cutoutBottom}px, ${cutoutRight}px ${cutoutBottom}px, ${cutoutRight}px ${cutoutTop}px, ${cutoutLeft}px ${cutoutTop}px)`;
  overlay.style.clipPath = cutoutClip;
  overlay.style.webkitClipPath = cutoutClip;
  const box = callout.getBoundingClientRect();
  const placement = placeGuideCallout(
    {
      left: cutoutLeft,
      top: cutoutTop,
      right: cutoutRight,
      bottom: cutoutBottom,
      width: Math.max(0, cutoutRight - cutoutLeft),
      height: Math.max(0, cutoutBottom - cutoutTop),
    },
    box,
    margin,
    Boolean(step?.gallery?.length || step?.imageSrc),
  );
  callout.style.top = `${Math.round(placement.top)}px`;
  callout.style.left = `${Math.round(placement.left)}px`;
}

function renderQuickGuide() {
  if (!quickGuide) return;
  const step = quickGuide.steps[quickGuide.index];
  const target = step?.target?.();
  if (!isVisible(target)) {
    finishQuickGuide(true);
    return;
  }
  quickGuide.target = target;
  clearQuickGuideTarget();
  if (!step.suppressHighlight && !step.suppressTargetOutline) {
    target.classList.add('guide-focus-target');
  }
  if (!step.suppressHighlight) {
    target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
  }
  const callout = el('guide-callout');
  callout.style.visibility = 'hidden';
  callout.innerHTML = `
    <div class="guide-kicker">FIELD ORIENTATION ${quickGuide.index + 1} / ${quickGuide.steps.length}</div>
    <h3>${esc(step.title)}</h3>
    <p>${esc(step.body)}</p>
    ${step.gallery?.length ? `
      <div class="guide-gallery">
        ${step.gallery.map((item) => `
          <figure class="guide-media">
            <img src="${esc(item.src)}" alt="${esc(item.alt || '')}" loading="eager" decoding="async" />
            ${item.caption ? `<figcaption>${esc(item.caption)}</figcaption>` : ''}
          </figure>
        `).join('')}
      </div>
    ` : step.imageSrc ? `
      <figure class="guide-media ${esc(step.imageClass || '')}">
        <img src="${esc(step.imageSrc)}" alt="${esc(step.imageAlt || '')}" loading="eager" decoding="async" />
        ${step.imageCaption ? `<figcaption>${esc(step.imageCaption)}</figcaption>` : ''}
      </figure>
    ` : ''}
    <div class="guide-actions">
      <button class="btn" type="button" data-action="guide-skip">Skip</button>
      ${quickGuide.index > 0 ? '<button class="btn" type="button" data-action="guide-prev">Back</button>' : ''}
      <button class="btn btn-primary" type="button" data-action="guide-next">${quickGuide.index === quickGuide.steps.length - 1 ? 'Done' : 'Next'}</button>
    </div>
  `;
  showAnimated(el('guide-overlay'));
  showAnimated(callout);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    positionQuickGuide();
    callout.style.visibility = '';
    trackQuickGuidePosition();
  }));
}

function startQuickGuide(force = false) {
  if (quickGuide) return;
  if (!force && state.hasSeenQuickGuide()) return;
  showPage('tally');
  preloadImages(GUIDE_PRELOAD_SOURCES);
  const steps = buildQuickGuideSteps();
  if (!steps.length) return;
  quickGuide = { index: 0, steps, target: null };
  renderQuickGuide();
}

function refreshQuickGuideIfOpen() {
  if (!quickGuide) return;
  renderQuickGuide();
}

on('guide-callout', 'click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn || !quickGuide) return;
  const action = btn.dataset.action;
  if (action === 'guide-skip') {
    finishQuickGuide(true);
    return;
  }
  if (action === 'guide-prev') {
    quickGuide.index = Math.max(0, quickGuide.index - 1);
    renderQuickGuide();
    return;
  }
  if (action === 'guide-next') {
    if (quickGuide.index >= quickGuide.steps.length - 1) {
      finishQuickGuide(true);
    } else {
      quickGuide.index += 1;
      renderQuickGuide();
    }
  }
});

on('replay-guide-btn', 'click', () => {
  closeSettings();
  finishQuickGuide(false);
  startQuickGuide(true);
});

window.addEventListener('resize', positionQuickGuide);
window.addEventListener('scroll', positionQuickGuide, true);

/* ---------------- Client ID / sync status ---------------- */

function renderClientBadge() {
  el('client-id-display').textContent = clientId.slice(0, 8);
  el('client-id-input').value = clientId;
}

function setSyncStatus(text, cls = '') {
  const s = el('terminal-badge');
  if (!s) return;
  s.textContent = `MINISTRY TERMINAL // ${text}`;
  s.className = `terminal-badge ${cls}`.trim();
  refreshQuickGuideIfOpen();
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
// Defaults ON on a fresh install (no saved preference yet), but — per
// explicit request — does NOT keep following window size after that; once
// it's a visible on-page toggle, resizing out from under the user's choice
// would undermine the point of giving them direct control.
let simplifiedView = state.getSimplifiedView();
if (simplifiedView === null) simplifiedView = true;

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
  const stack = hasDenoms ? denomStackForCurrentMission(poiId, itemId) : null;
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
    grid.innerHTML = '<p class="empty-note">No minor place types configured. Try Settings → Reset All Local Data to restore the defaults.</p>';
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
  refreshQuickGuideIfOpen();
}

function persistCurrentMission() {
  state.saveCurrentMission(currentMission);
}

function denomStackForCurrentMission(poiId, itemId) {
  if (!currentMission.denomPickHistory) currentMission.denomPickHistory = {};
  if (!currentMission.denomPickHistory[poiId]) currentMission.denomPickHistory[poiId] = {};
  if (!Array.isArray(currentMission.denomPickHistory[poiId][itemId])) currentMission.denomPickHistory[poiId][itemId] = [];
  return currentMission.denomPickHistory[poiId][itemId];
}

function poiLootHistoryForCurrentMission(poiId) {
  if (!currentMission.poiLootHistory) currentMission.poiLootHistory = {};
  if (!Array.isArray(currentMission.poiLootHistory[poiId])) currentMission.poiLootHistory[poiId] = [];
  return currentMission.poiLootHistory[poiId];
}

function createPoiLootInstance(poiId) {
  const history = poiLootHistoryForCurrentMission(poiId);
  history.push([]);
  return history.length - 1;
}

function assignablePoiLootInstanceIndex(poiId, preferNewest = false) {
  const history = poiLootHistoryForCurrentMission(poiId);
  const slots = config.poiTypes.find((x) => x.id === poiId)?.slots || 0;
  if (!history.length || slots <= 0) return -1;
  const start = preferNewest ? history.length - 1 : 0;
  const end = preferNewest ? -1 : history.length;
  const step = preferNewest ? -1 : 1;
  for (let i = start; i !== end; i += step) {
    if (history[i].length < slots) return i;
  }
  return history.length - 1;
}

function recordPoiLootPickup(poiId, itemId, { denom = null, instanceIndex = null, preferNewest = false } = {}) {
  const history = poiLootHistoryForCurrentMission(poiId);
  const idx = Number.isInteger(instanceIndex) && history[instanceIndex]
    ? instanceIndex
    : assignablePoiLootInstanceIndex(poiId, preferNewest);
  if (idx < 0 || !history[idx]) return;
  history[idx].push(denom === null ? { itemId } : { itemId, denom });
}

function removeRecordedPoiLootPickup(poiId, itemId, denom = null) {
  const history = poiLootHistoryForCurrentMission(poiId);
  for (let instanceIndex = history.length - 1; instanceIndex >= 0; instanceIndex -= 1) {
    const instance = history[instanceIndex];
    for (let pickupIndex = instance.length - 1; pickupIndex >= 0; pickupIndex -= 1) {
      const pickup = instance[pickupIndex];
      if (pickup.itemId !== itemId) continue;
      if (denom === null && pickup.denom !== undefined) continue;
      if (denom !== null && String(pickup.denom) !== String(denom)) continue;
      instance.splice(pickupIndex, 1);
      return true;
    }
  }
  return false;
}

function removePoiLootInstance(poiId) {
  const history = poiLootHistoryForCurrentMission(poiId);
  const removed = history.pop();
  if (!Array.isArray(removed)) return false;
  for (let i = removed.length - 1; i >= 0; i -= 1) {
    const pickup = removed[i];
    currentMission.itemDrops[poiId][pickup.itemId] = Math.max(0, (currentMission.itemDrops[poiId][pickup.itemId] || 0) - 1);
    if (pickup.denom !== undefined) {
      currentMission.denomCounts[poiId][pickup.itemId][pickup.denom] = Math.max(0, (currentMission.denomCounts[poiId][pickup.itemId][pickup.denom] || 0) - 1);
      const stack = denomStackForCurrentMission(poiId, pickup.itemId);
      let stackIndex = -1;
      for (let j = stack.length - 1; j >= 0; j -= 1) {
        if (String(stack[j]) === String(pickup.denom)) {
          stackIndex = j;
          break;
        }
      }
      if (stackIndex >= 0) stack.splice(stackIndex, 1);
    }
  }
  return true;
}

// Shared by both the desktop inline rows (poi-grid's own click handler,
// below) and the mobile item popup (next section) — same mutation, same
// undo-stack bookkeeping, just triggered from two different bits of DOM.
function tallyItemInc(poiId, itemId, options = {}) {
  currentMission.itemDrops[poiId][itemId] = (currentMission.itemDrops[poiId][itemId] || 0) + 1;
  recordPoiLootPickup(poiId, itemId, options);
  persistCurrentMission();
  renderPoiGrid();
  renderItemPopupIfOpen();
  renderStats();
}

function tallyItemDec(poiId, itemId) {
  if ((currentMission.itemDrops[poiId][itemId] || 0) > 0) {
    const stack = denomStackForCurrentMission(poiId, itemId);
    if (stack && stack.length > 0) {
      const undoneDenom = stack.pop();
      currentMission.denomCounts[poiId][itemId][undoneDenom] = Math.max(0, (currentMission.denomCounts[poiId][itemId][undoneDenom] || 0) - 1);
      removeRecordedPoiLootPickup(poiId, itemId, undoneDenom);
    } else {
      removeRecordedPoiLootPickup(poiId, itemId);
    }
    currentMission.itemDrops[poiId][itemId] = Math.max(0, (currentMission.itemDrops[poiId][itemId] || 0) - 1);
  }
  persistCurrentMission();
  renderPoiGrid();
  renderItemPopupIfOpen();
  renderStats();
}

function tallyItemIncDenom(poiId, itemId, denom, options = {}) {
  currentMission.itemDrops[poiId][itemId] = (currentMission.itemDrops[poiId][itemId] || 0) + 1;
  if (!currentMission.denomCounts[poiId]) currentMission.denomCounts[poiId] = {};
  if (!currentMission.denomCounts[poiId][itemId]) currentMission.denomCounts[poiId][itemId] = {};
  currentMission.denomCounts[poiId][itemId][denom] = (currentMission.denomCounts[poiId][itemId][denom] || 0) + 1;
  denomStackForCurrentMission(poiId, itemId).push(denom);
  recordPoiLootPickup(poiId, itemId, { ...options, denom });
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
  const instanceIndex = createPoiLootInstance(poiId);
  persistCurrentMission();
  renderPoiGrid();
  renderStats();
  // Finding a container starts the guided flow: pick what dropped, pick
  // how much, repeat until this POI's slots (across however many of it
  // you've found) are filled — see the "Item popup" section below. The
  // Simplified View toggle (right on the Tally page) turns this off in
  // favor of just marking it found and tallying items manually.
  if (simplifiedView) startGuidedFlow(poiId, instanceIndex);
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
  if (!simplifiedView) {
    refreshQuickGuideIfOpen();
    return;
  }
  bar.innerHTML = `<button class="quick-add-btn" type="button" data-action="quick-add-open">+ ADD MINOR PLACE OF INTEREST</button>`;
  refreshQuickGuideIfOpen();
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
    removePoiLootInstance(poiId);
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

// { mode: 'single', poiId, itemId } | { mode: 'guided', poiId, itemId: string|null, instanceIndex: number|null } | null
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
          <div class="item-popup-name">Add Minor Place of Interest</div>
          <div class="item-popup-poi">What did you find?</div>
        </div>
        <button class="btn btn-icon close-btn" data-action="item-popup-close" aria-label="Close">✕</button>
      </div>
      <div class="poi-items poi-pick-grid">
        ${config.poiTypes.map((x) => {
          const preview = poiPreviewImage(x.id);
          return `
          <button class="item-tile" type="button" data-action="poi-pick-select" data-poi="${x.id}">
            ${preview ? `<img class="poi-pick-preview" src="${esc(preview.src)}" alt="${esc(preview.alt)}" loading="eager" decoding="async" />` : ''}
            <span class="item-tile-name">${esc(x.name)}</span>
            <span class="item-tile-sub">${x.slots} SLOT${x.slots === 1 ? '' : 'S'}</span>
          </button>
        `;
        }).join('')}
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
  const popup = el('item-popup');
  popup.classList.toggle('item-popup-poi-pick', openItemPopup.mode === 'poi-pick');
  popup.innerHTML = itemPopupHtml();
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

function startGuidedFlow(poiId, instanceIndex = null) {
  openPopup({ mode: 'guided', poiId, itemId: null, instanceIndex });
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
  const { poiId, instanceIndex } = openItemPopup;
  const item = config.itemTypes.find((x) => x.id === itemId);
  if (item.denominations && item.denominations.length > 0) {
    openItemPopup.itemId = itemId;
    renderItemPopupIfOpen();
  } else {
    tallyItemInc(poiId, itemId, { instanceIndex, preferNewest: true });
    guidedAdvanceOrClose();
  }
}

function guidedPickAmount(denom) {
  if (!openItemPopup || openItemPopup.mode !== 'guided') return;
  const { poiId, itemId, instanceIndex } = openItemPopup;
  tallyItemIncDenom(poiId, itemId, denom, { instanceIndex, preferNewest: true });
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

function submitPromptHtml() {
  return `
    <div class="item-popup-header">
      <div class="item-popup-heading">
        <div class="item-popup-name">All Minor Place Loot Collected?</div>
        <div class="item-popup-poi">This means the special bunker/container/pod loot, not loose samples nearby.</div>
      </div>
      <button class="btn btn-icon close-btn" data-action="submit-cancel" aria-label="Close">✕</button>
    </div>
    <p>If you think this run cleared every Minor Place's special loot on the map, mark it here. Ignore loose samples around the POI — this question is only about the actual bunker/container/pod drops.</p>
    <div class="submit-popup-actions">
      <button class="btn btn-primary" type="button" data-action="submit-finish" data-collected="yes">Yes — I think we got all MPOI loot</button>
      <button class="btn" type="button" data-action="submit-finish" data-collected="no">No / Not Sure</button>
    </div>
    <div class="submit-popup-cancel">
      <button class="btn-link" type="button" data-action="submit-cancel">Cancel</button>
    </div>
  `;
}

function openSubmitPopup() {
  el('submit-popup').innerHTML = submitPromptHtml();
  showAnimated(el('submit-popup-overlay'));
  showAnimated(el('submit-popup'));
}

function closeSubmitPopup() {
  hideAnimated(el('submit-popup'));
  hideAnimated(el('submit-popup-overlay'));
}

function clearPromptHtml() {
  return `
    <div class="item-popup-header">
      <div class="item-popup-heading">
        <div class="item-popup-name">Discard Current Mission?</div>
        <div class="item-popup-poi">This wipes the in-progress tally only.</div>
      </div>
      <button class="btn btn-icon close-btn" data-action="clear-cancel" aria-label="Close">✕</button>
    </div>
    <p>If this run is garbage, clear it here and start fresh. Nothing from the current mission will be saved or synced.</p>
    <div class="submit-popup-actions">
      <button class="btn btn-danger" type="button" data-action="clear-confirm">Yes — discard this mission</button>
      <button class="btn" type="button" data-action="clear-cancel">Keep working on it</button>
    </div>
  `;
}

function openClearPopup() {
  el('clear-popup').innerHTML = clearPromptHtml();
  showAnimated(el('clear-popup-overlay'));
  showAnimated(el('clear-popup'));
}

function closeClearPopup() {
  hideAnimated(el('clear-popup'));
  hideAnimated(el('clear-popup-overlay'));
}

async function finalizeMissionSubmission(allMinorPlacesCollected) {
  currentMission.allMinorPlacesCollected = !!allMinorPlacesCollected;
  persistCurrentMission();
  const { completed, fresh } = state.completeMission(config);
  currentMission = fresh;
  closeSubmitPopup();
  closeItemPopup();
  closeMissionPanel();
  renderPoiGrid();
  renderStats();
  renderSquadModeSelect();
  renderMissionMetaSelects();
  toast('Mission saved. New mission started.', 'success');
  await trySyncMission(completed);
}

on('new-mission-btn', 'click', openSubmitPopup);
on('poi-new-mission-btn', 'click', openSubmitPopup);
on('submit-popup-overlay', 'click', closeSubmitPopup);
on('submit-popup', 'click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'submit-cancel') {
    closeSubmitPopup();
    return;
  }
  if (btn.dataset.action === 'submit-finish') {
    await finalizeMissionSubmission(btn.dataset.collected === 'yes');
  }
});

function clearCurrentMission() {
  currentMission = state.discardCurrentMission(config);
  closeClearPopup();
  closeSubmitPopup();
  closeItemPopup();
  closeMissionPanel();
  renderPoiGrid();
  renderSquadModeSelect();
  renderMissionMetaSelects();
  toast('Mission cleared — nothing was saved.', 'success');
}

on('clear-mission-btn', 'click', openClearPopup);
on('poi-clear-mission-btn', 'click', openClearPopup);
on('clear-popup-overlay', 'click', closeClearPopup);
on('clear-popup', 'click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'clear-confirm') clearCurrentMission();
  if (btn.dataset.action === 'clear-cancel') closeClearPopup();
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

function sortMissionsChronologically(missions) {
  return missions.slice().sort((a, b) => (
    Number(a.endedAt || a.startedAt || 0) - Number(b.endedAt || b.startedAt || 0)
  ));
}

function mergeRemoteHistory(remoteHistory) {
  const mergedById = new Map(
    remoteHistory.map((m) => [m.id, { ...m, synced: true }]),
  );
  state.getHistory()
    .filter((m) => !m.synced)
    .forEach((m) => mergedById.set(m.id, m));
  const merged = sortMissionsChronologically([...mergedById.values()]);
  state.replaceHistory(merged);
  renderLogPage();
  renderStats();
}

async function pullDiverHistoryFromServer() {
  const remoteHistory = await fetchMissions(serverUrl, clientId);
  mergeRemoteHistory(remoteHistory);
  return remoteHistory;
}

async function syncPendingMissions() {
  if (!serverUrl) {
    setSyncStatus('OFFLINE', 'error');
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
  try {
    await pullDiverHistoryFromServer();
  } catch (err) {
    console.error('Stat Gatherer: diver history pull failed', err);
  }
  // Global Stats' mission list (globalMissions) previously only refreshed
  // when the GLOBAL STATS tab button was clicked — a delete/edit by another
  // diver (or even your own, if the tab was already active before you left
  // the page) would sit stale indefinitely. Refreshing it on every sync pass
  // means it self-heals instead of requiring a manual tab re-click.
  await refreshGlobalStats();
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
      const pct = r.value <= 0 ? 0 : Math.max(2, (r.value / maxValue) * 100);
      return `
        <div class="chart-row" title="${esc(r.title)}">
          <span class="chart-row-icon">${r.iconHtml || ''}</span>
          <span class="chart-row-label">${esc(r.label)}</span>
          <div class="chart-track"><div class="chart-bar${r.value <= 0 ? ' is-zero' : ''}" style="width:${pct}%"></div></div>
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
    return '<p class="empty-note">No completed missions yet. Tally some minor places and hit "New Mission" to save your first one.</p>';
  }

  const poiChartRows = config.poiTypes.map((p) => ({
    label: p.name,
    value: stats.poi[p.id].count,
    displayValue: String(stats.poi[p.id].count),
    title: `${p.name}: ${stats.poi[p.id].count} (${(stats.poi[p.id].pctOfPois * 100).toFixed(1)}% of minor places)`,
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
  const poiScopeNote = stats.poiMissionCount === 0
    ? '<p class="hint">Minor Place frequency uses only missions marked as having collected all special bunker/container/pod loot on the map. Loose samples around POIs do not matter for this flag. None of the currently-filtered missions are marked that way yet.</p>'
    : `<p class="hint">Minor Place frequency is using ${stats.poiMissionCount} mission${stats.poiMissionCount === 1 ? '' : 's'} marked as having collected all special bunker/container/pod loot on the map. Loose samples around POIs do not matter for this flag.</p>`;

  return `
    <div class="stats-summary">
      <div class="stat-tile"><span class="stat-value">${stats.totalMissions}</span><span class="stat-label">MISSIONS</span></div>
      <div class="stat-tile"><span class="stat-value">${stats.totalPois}</span><span class="stat-label">MINOR PLACES FOUND</span></div>
      <div class="stat-tile"><span class="stat-value">${stats.avgPoisPerMission.toFixed(1)}</span><span class="stat-label">AVG MPOIs / MISSION</span></div>
      <div class="stat-tile"><span class="stat-value">${stats.totalItemDrops}</span><span class="stat-label">RESOURCES FOUND</span></div>
      <div class="stat-tile"><span class="stat-value">${stats.avgItemDropsPerMission.toFixed(1)}</span><span class="stat-label">AVG RESOURCES / MISSION</span></div>
    </div>

    ${poiScopeNote}
    <h3>Minor Place Frequency</h3>
    ${barChartHtml(poiChartRows)}
    <table class="stats-table">
      <thead><tr><th>Minor Place Type</th><th>Count</th><th>% of Minor Places</th><th>Avg / Mission</th></tr></thead>
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

    <h3>Drop Probability by Minor Place</h3>
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
  const localMissionsForDenoms = [...state.getHistory(), currentMission];
  const localDenomTally = buildDenomTallyFromMissions(localMissionsForDenoms);
  const globalDenomTally = buildDenomTallyFromMissions(globalMissions || []);
  const resolvedItemTypes = resolveItemValues(config.itemTypes, localDenomTally, globalDenomTally);
  const resolvedConfig = { ...config, itemTypes: resolvedItemTypes };
  const history = filterMissions(state.getHistory(), statsFilters);
  el('stats-mine').innerHTML = statsHtml(computeStats(history, resolvedConfig)) + dropSizeStatsHtml(localDenomTally);
  const globalStatsHtml = globalMissions
    ? statsHtml(computeStats(filterMissions(globalMissions, statsFilters), resolvedConfig))
    : (serverUrl
      ? '<p class="empty-note">Loading global stats…</p>'
      : '<p class="empty-note">Server sync is off, so Global Stats is unavailable.</p>');
  el('stats-global').innerHTML = globalStatsHtml + dropSizeStatsHtml(globalDenomTally);
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

function showPage(page) {
  document.querySelectorAll('.page-nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  el('tally-page')?.classList.toggle('hidden', page !== 'tally');
  el('stats-page')?.classList.toggle('hidden', page !== 'stats');
  el('log-page')?.classList.toggle('hidden', page !== 'log');
  if (page === 'log') renderLogPage();
  refreshQuickGuideIfOpen();
}

document.querySelectorAll('.page-nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
});

/* ---------------- Mission log (edit / delete saved missions) ---------------- */

function missionLabel(mission, listKey, field) {
  const entry = config[listKey].find((e) => e.id === mission[field]);
  return entry ? entry.name : 'Unlabeled';
}

const SQUAD_MODE_LABELS = { solo: 'Solo', solo_warp: 'Solo+Warp', multiplayer: 'Multiplayer', unknown: 'Unlabeled' };

function denomCountForMission(mission, poiId, itemId, denom) {
  return (mission.denomCounts && mission.denomCounts[poiId] && mission.denomCounts[poiId][itemId] && mission.denomCounts[poiId][itemId][denom]) || 0;
}

function missionDenomSummary(mission, poiId, item) {
  const denoms = (item.denominations || [])
    .map((denom) => ({ denom, count: denomCountForMission(mission, poiId, item.id, denom) }))
    .filter((entry) => entry.count > 0);
  if (!denoms.length) return '';
  return denoms.map((entry) => `${entry.count}x ${entry.denom}`).join(', ');
}

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
      <label class="mission-check">
        <input type="checkbox" class="log-edit-checkbox" data-field="allMinorPlacesCollected"${mission.allMinorPlacesCollected ? ' checked' : ''} />
        <span>I think this mission collected all special loot from its Minor Places (not loose nearby samples)</span>
      </label>
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
                ${i.denominations && i.denominations.length > 0 ? `
                  <div class="log-edit-denoms">
                    ${i.denominations.map((d) => `
                      <label class="log-edit-denom">
                        <span>${d}</span>
                        <input type="number" class="value-input log-edit-denom-count" data-poi="${p.id}" data-item="${i.id}" data-denom="${d}" min="0" value="${denomCountForMission(mission, p.id, i.id, d)}" />
                      </label>
                    `).join('')}
                  </div>
                ` : `<input type="number" class="value-input log-edit-item-count" data-poi="${p.id}" data-item="${i.id}" min="0" value="${mission.itemDrops?.[p.id]?.[i.id] || 0}" />`}
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
      .join(', ') || 'No minor places tallied';
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
            ${m.allMinorPlacesCollected ? '<span class="log-tag">ALL MPOIs</span>' : ''}
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
    patch.allMinorPlacesCollected = !!form.querySelector('.log-edit-checkbox[data-field="allMinorPlacesCollected"]')?.checked;
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
    const denomCounts = {};
    form.querySelectorAll('.log-edit-denom-count').forEach((input) => {
      const poiId = input.dataset.poi;
      const itemId = input.dataset.item;
      const denom = input.dataset.denom;
      const count = Math.max(0, parseInt(input.value, 10) || 0);
      if (!denomCounts[poiId]) denomCounts[poiId] = {};
      if (!denomCounts[poiId][itemId]) denomCounts[poiId][itemId] = {};
      denomCounts[poiId][itemId][denom] = count;
      itemDrops[poiId][itemId] += count;
    });
    patch.poiCounts = poiCounts;
    patch.itemDrops = itemDrops;
    patch.denomCounts = denomCounts;
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
      <div class="row">
        <span class="denom-label">All Minor Place Loot Collected</span>
        <span class="log-view-value">${m.allMinorPlacesCollected ? 'Yes' : 'No'}</span>
      </div>
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
                ${missionDenomSummary(m, p.id, i) ? `<span class="log-view-subvalue">${esc(missionDenomSummary(m, p.id, i))}</span>` : ''}
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
    .join(', ') || 'No minor places tallied';
  return `
    <div class="log-card" data-id="${esc(m.id)}">
      <div class="log-card-header">
        <span class="log-card-date">${esc(new Date(m.startedAt).toLocaleString())} — Diver ${esc(diverShort)}</span>
        <div class="log-card-tags">
          <span class="log-tag">${esc(SQUAD_MODE_LABELS[m.squadMode || 'unknown'] || m.squadMode)}</span>
          <span class="log-tag">${esc(missionLabel(m, 'difficulties', 'difficulty'))}</span>
          <span class="log-tag">${esc(missionLabel(m, 'factions', 'faction'))}</span>
          <span class="log-tag">${esc(missionLabel(m, 'planets', 'planet'))}</span>
          ${m.allMinorPlacesCollected ? '<span class="log-tag">ALL MPOIs</span>' : ''}
          <span class="log-tag">${totalPois(m)} MPOI${totalPois(m) === 1 ? '' : 'S'}</span>
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
    container.innerHTML = '<p class="empty-note">Server sync is off, so Global Missions is unavailable.</p>';
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

on('apply-client-id', 'click', async () => {
  const newId = el('client-id-input').value.trim();
  if (!newId || newId === clientId) return;
  clientId = newId;
  state.setClientId(clientId);
  renderClientBadge();
  if (serverUrl) {
    try {
      const remoteHistory = await pullDiverHistoryFromServer();
      toast(`Logged in as ${clientId.slice(0, 8)} — pulled ${remoteHistory.length} mission(s) from server.`, 'success');
    } catch {
      toast('Diver ID set, but could not reach server to pull history.', 'error');
    }
  } else {
    toast(`Diver ID set to ${clientId.slice(0, 8)}.`, 'success');
  }
  renderStats();
});

/* ---------------- Import / Export ---------------- */

on('export-json', 'click', () => {
  const payload = {
    exportedAt: new Date().toISOString(),
    clientId,
    config,
    currentMission,
    history: state.getHistory(),
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
    currentMission = state.getCurrentMission(config);
    closeItemPopup();
    renderQuickAddBar();
    renderPoiGrid();
    renderStats();
    renderSquadModeSelect();
    renderMissionMetaSelects();
    renderStatsFilterSelects();
    renderGlobalLogFilterSelects();
    if (!el('log-page')?.classList.contains('hidden')) renderLogPage();
    toast('Import complete.', 'success');
  } catch {
    toast('Import failed — invalid JSON file.', 'error');
  } finally {
    e.target.value = '';
  }
});

on('reset-data', 'click', () => {
  if (!confirm('This will erase all local missions and the in-progress mission. Continue?')) return;
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
  safe(() => preloadImages(GUIDE_PRELOAD_SOURCES), 'preloadGuideImages');
  safe(renderClientBadge, 'renderClientBadge');
  safe(renderSimplifiedViewToggle, 'renderSimplifiedViewToggle');
  safe(renderQuickAddBar, 'renderQuickAddBar');
  safe(renderPoiGrid, 'renderPoiGrid');
  safe(renderMissionMetaSelects, 'renderMissionMetaSelects');
  safe(renderStatsFilterSelects, 'renderStatsFilterSelects');
  safe(renderGlobalLogFilterSelects, 'renderGlobalLogFilterSelects');
  safe(renderStats, 'renderStats');
  safe(renderSquadModeSelect, 'renderSquadModeSelect');
  safe(() => startQuickGuide(false), 'startQuickGuide');
  const finishBoot = () => {
    document.body.classList.remove('booting');
    refreshQuickGuideIfOpen();
  };
  if (document.fonts?.ready) {
    document.fonts.ready.then(finishBoot, finishBoot);
    setTimeout(finishBoot, 1200);
  } else {
    requestAnimationFrame(finishBoot);
  }
  syncPendingMissions().then(() => {
    if (!el('stats-global')?.classList.contains('hidden')) refreshGlobalStats();
  }).catch((err) => console.error('Stat Gatherer: initial sync failed', err));
  setInterval(syncPendingMissions, 30000);
}

safe(init, 'init');
