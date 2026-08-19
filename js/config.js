const CONFIG_KEY = 'sg_config';

export const FALLBACK_ICON = '⭐';
export const FALLBACK_VALUE = 1;

// Average resource value per single pickup, used to convert raw item counts
// into estimated resource totals/rates. Super Credits average 10.9 (10 base,
// 1% chance of a 100 bonus drop); medals vary 1-3 per pickup, averaged to 2.
const DEFAULT_ITEM_VALUES = {
  medals: 2,
  requisition: 100,
  super_credits: 11,
  guns: 1,
};

// Starter denomination buckets for the Drop Size tracker — the discrete
// amounts a single pickup can actually give, for items where that varies.
// Fully user-editable from the Drop Sizes page; these are just seeds.
const DEFAULT_DENOMINATIONS = {
  medals: [1, 2, 3],
  requisition: [100, 1000],
  super_credits: [10, 100],
  guns: [],
};

// Difficulty tiers as of this writing — Arrowhead has renamed/added tiers
// before, so this is a starter seed, not a guaranteed-current list. Fully
// editable from Settings.
const DEFAULT_DIFFICULTIES = [
  { id: 'trivial', name: 'Trivial (1)' },
  { id: 'easy', name: 'Easy (2)' },
  { id: 'medium', name: 'Medium (3)' },
  { id: 'challenging', name: 'Challenging (4)' },
  { id: 'hard', name: 'Hard (5)' },
  { id: 'extreme', name: 'Extreme (6)' },
  { id: 'suicide_mission', name: 'Suicide Mission (7)' },
  { id: 'impossible', name: 'Impossible (8)' },
  { id: 'helldive', name: 'Helldive (9)' },
];

const DEFAULT_FACTIONS = [
  { id: 'terminids', name: 'Terminids' },
  { id: 'automatons', name: 'Automatons' },
  { id: 'illuminate', name: 'Illuminate' },
];

// Planets rotate through the galactic war, so no attempt at a full list —
// just seeded with what's actually been played so far.
const DEFAULT_PLANETS = [
  { id: 'phact_bay', name: 'Phact Bay' },
];

export const DEFAULT_CONFIG = {
  poiTypes: [
    { id: 'two_man_bunker', name: 'Two-Man Bunker', slots: 3 },
    { id: 'explodable_bunker', name: 'Explodable Bunker', slots: 2 },
    { id: 'loot_pod', name: 'Loot Pod', slots: 1 },
  ],
  itemTypes: [
    { id: 'medals', name: 'Medals', icon: 'assets/icons/medals.webp', value: DEFAULT_ITEM_VALUES.medals, denominations: DEFAULT_DENOMINATIONS.medals },
    { id: 'requisition', name: 'Requisition Slips', icon: 'assets/icons/requisition.webp', value: DEFAULT_ITEM_VALUES.requisition, denominations: DEFAULT_DENOMINATIONS.requisition },
    { id: 'super_credits', name: 'Super Credits', icon: 'assets/icons/super_credits.webp', value: DEFAULT_ITEM_VALUES.super_credits, denominations: DEFAULT_DENOMINATIONS.super_credits },
    { id: 'guns', name: 'Weapons', icon: 'assets/icons/weapons.svg', value: DEFAULT_ITEM_VALUES.guns, denominations: DEFAULT_DENOMINATIONS.guns },
  ],
  difficulties: DEFAULT_DIFFICULTIES,
  factions: DEFAULT_FACTIONS,
  planets: DEFAULT_PLANETS,
};

export function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return structuredClone(DEFAULT_CONFIG);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.poiTypes) || !Array.isArray(parsed.itemTypes)) {
      return structuredClone(DEFAULT_CONFIG);
    }
    parsed.itemTypes.forEach((i) => {
      if (!i.icon) i.icon = FALLBACK_ICON;
      if (i.value == null) i.value = DEFAULT_ITEM_VALUES[i.id] ?? FALLBACK_VALUE;
      if (!Array.isArray(i.denominations)) i.denominations = DEFAULT_DENOMINATIONS[i.id] || [];
    });
    if (!Array.isArray(parsed.difficulties)) parsed.difficulties = structuredClone(DEFAULT_DIFFICULTIES);
    if (!Array.isArray(parsed.factions)) parsed.factions = structuredClone(DEFAULT_FACTIONS);
    if (!Array.isArray(parsed.planets)) parsed.planets = structuredClone(DEFAULT_PLANETS);
    return parsed;
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(config) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export function slugify(name) {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return base || `id_${Date.now()}`;
}

export function isImageIcon(icon) {
  return /\.(png|jpe?g|svg|webp|gif)$/i.test(icon || '');
}

export function uniqueId(existingIds, desired) {
  let id = desired;
  let n = 2;
  while (existingIds.includes(id)) {
    id = `${desired}_${n}`;
    n += 1;
  }
  return id;
}
