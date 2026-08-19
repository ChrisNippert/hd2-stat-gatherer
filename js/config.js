const CONFIG_KEY = 'sg_config';

export const FALLBACK_ICON = '⭐';
export const FALLBACK_VALUE = 1;

// Average resource value per single pickup — only used as a bootstrap
// fallback before any Drop Size Tracker data exists; once observations come
// in (locally or pooled from the server), stats.resolveItemValues() computes
// the real average instead and this seed stops mattering. Super Credits
// average 10.9 (10 base, 1% chance of a 100 bonus drop); medals vary 1-3 per
// pickup, averaged to 2. Common/Rare Samples' true per-pickup amount isn't
// asserted here — 1 is just a neutral starting point pending real data.
const DEFAULT_ITEM_VALUES = {
  medals: 2,
  requisition: 100,
  super_credits: 11,
  guns: 1,
  common_samples: 1,
  rare_samples: 1,
};

// Starter denomination buckets for the Drop Size tracker — the discrete
// amounts a single pickup can actually give, for items where that varies.
// These are still user-addable from the Drop Sizes page (unlike the rest of
// the taxonomy) since discovering new ones is the point of that feature.
const DEFAULT_DENOMINATIONS = {
  medals: [1, 2, 3],
  requisition: [100, 1000],
  super_credits: [10, 100],
  guns: [],
  common_samples: [],
  rare_samples: [],
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

// Full planet list sourced from helldivers.fandom.com/wiki/Planets_and_Sectors
// (266 entries incl. Super Earth). The galactic war adds/changes planets over
// time, so this will drift — but the list is fixed (not user-editable); if it
// needs updating, re-scrape and replace this array rather than reintroducing
// per-user editability.
const DEFAULT_PLANETS = [
  { id: 'acamar_iv', name: 'Acamar IV' },
  { id: 'achernar_secundus', name: 'Achernar Secundus' },
  { id: 'achird_iii', name: 'Achird III' },
  { id: 'acrab_xi', name: 'Acrab XI' },
  { id: 'acrux_ix', name: 'Acrux IX' },
  { id: 'acubens_prime', name: 'Acubens Prime' },
  { id: 'adhara', name: 'Adhara' },
  { id: 'aesir_pass', name: 'Aesir Pass' },
  { id: 'afoyay_bay', name: 'Afoyay Bay' },
  { id: 'ain_5', name: 'Ain-5' },
  { id: 'alairt_iii', name: 'Alairt III' },
  { id: 'alamak_vii', name: 'Alamak VII' },
  { id: 'alaraph', name: 'Alaraph' },
  { id: 'alathfar_xi', name: 'Alathfar XI' },
  { id: 'alderidge_cove', name: 'Alderidge Cove' },
  { id: 'alta_v', name: 'Alta V' },
  { id: 'andar', name: 'Andar' },
  { id: 'angel_s_venture', name: 'Angel\'s Venture' },
  { id: 'arkturus', name: 'Arkturus' },
  { id: 'asperoth_prime', name: 'Asperoth Prime' },
  { id: 'atrama', name: 'Atrama' },
  { id: 'aurora_bay', name: 'Aurora Bay' },
  { id: 'azterra', name: 'Azterra' },
  { id: 'azur_secundus', name: 'Azur Secundus' },
  { id: 'baldrick_prime', name: 'Baldrick Prime' },
  { id: 'barabos', name: 'Barabos' },
  { id: 'bashyr', name: 'Bashyr' },
  { id: 'bekvam_iii', name: 'Bekvam III' },
  { id: 'bellatrix', name: 'Bellatrix' },
  { id: 'blistica', name: 'Blistica' },
  { id: 'bore_rock', name: 'Bore Rock' },
  { id: 'borea', name: 'Borea' },
  { id: 'botein', name: 'Botein' },
  { id: 'brink_2', name: 'Brink-2' },
  { id: 'bunda_secundus', name: 'Bunda Secundus' },
  { id: 'calypso', name: 'Calypso' },
  { id: 'canopus', name: 'Canopus' },
  { id: 'caph', name: 'Caph' },
  { id: 'caramoor', name: 'Caramoor' },
  { id: 'castor', name: 'Castor' },
  { id: 'cerberus_iiic', name: 'Cerberus IIIc' },
  { id: 'charbal_vii', name: 'Charbal-VII' },
  { id: 'charon_prime', name: 'Charon Prime' },
  { id: 'choepessa_iv', name: 'Choepessa IV' },
  { id: 'choohe', name: 'Choohe' },
  { id: 'chort_bay', name: 'Chort Bay' },
  { id: 'cirrus', name: 'Cirrus' },
  { id: 'claorell', name: 'Claorell' },
  { id: 'clasa', name: 'Clasa' },
  { id: 'crimsica', name: 'Crimsica' },
  { id: 'crucible', name: 'Crucible' },
  { id: 'curia', name: 'Curia' },
  { id: 'cyberstan', name: 'Cyberstan' },
  { id: 'darius_ii', name: 'Darius II' },
  { id: 'darrowsport', name: 'Darrowsport' },
  { id: 'demiurg', name: 'Demiurg' },
  { id: 'deneb_secundus', name: 'Deneb Secundus' },
  { id: 'diaspora_x', name: 'Diaspora X' },
  { id: 'diluvia', name: 'Diluvia' },
  { id: 'dolph', name: 'Dolph' },
  { id: 'draupnir', name: 'Draupnir' },
  { id: 'duma_tyr', name: 'Duma Tyr' },
  { id: 'durgen', name: 'Durgen' },
  { id: 'east_iridium_trading_bay', name: 'East Iridium Trading Bay' },
  { id: 'effluvia', name: 'Effluvia' },
  { id: 'electra_bay', name: 'Electra Bay' },
  { id: 'elysian_meadows', name: 'Elysian Meadows' },
  { id: 'emeria', name: 'Emeria' },
  { id: 'emorath', name: 'Emorath' },
  { id: 'enuliale', name: 'Enuliale' },
  { id: 'epsilon_phoencis_vi', name: 'Epsilon Phoencis VI' },
  { id: 'erata_prime', name: 'Erata Prime' },
  { id: 'erson_sands', name: 'Erson Sands' },
  { id: 'esker', name: 'Esker' },
  { id: 'estanu', name: 'Estanu' },
  { id: 'eukoria', name: 'Eukoria' },
  { id: 'euphoria_iii', name: 'Euphoria III' },
  { id: 'fenmire', name: 'Fenmire' },
  { id: 'fenrir_iii', name: 'Fenrir III' },
  { id: 'fori_prime', name: 'Fori Prime' },
  { id: 'fornskogur_ii', name: 'Fornskogur II' },
  { id: 'fort_justice', name: 'Fort Justice' },
  { id: 'fort_sanctuary', name: 'Fort Sanctuary' },
  { id: 'fort_union', name: 'Fort Union' },
  { id: 'freedom_peak', name: 'Freedom Peak' },
  { id: 'fury', name: 'Fury' },
  { id: 'gacrux', name: 'Gacrux' },
  { id: 'gaellivare', name: 'Gaellivare' },
  { id: 'gar_haren', name: 'Gar Haren' },
  { id: 'gatria', name: 'Gatria' },
  { id: 'gemma', name: 'Gemma' },
  { id: 'gemstone_bluffs', name: 'Gemstone Bluffs' },
  { id: 'genesis_prime', name: 'Genesis Prime' },
  { id: 'grafmere', name: 'Grafmere' },
  { id: 'grand_errant', name: 'Grand Errant' },
  { id: 'gunvald', name: 'Gunvald' },
  { id: 'hadar', name: 'Hadar' },
  { id: 'haka', name: 'Haka' },
  { id: 'haldus', name: 'Haldus' },
  { id: 'halies_port', name: 'Halies Port' },
  { id: 'heeth', name: 'Heeth' },
  { id: 'hellmire', name: 'Hellmire' },
  { id: 'herthon_secundus', name: 'Herthon Secundus' },
  { id: 'hesoe_prime', name: 'Hesoe Prime' },
  { id: 'heze_bay', name: 'Heze Bay' },
  { id: 'hort', name: 'Hort' },
  { id: 'hydrobius', name: 'Hydrobius' },
  { id: 'hydrofall_prime', name: 'Hydrofall Prime' },
  { id: 'igla', name: 'Igla' },
  { id: 'ilduna_prime', name: 'Ilduna Prime' },
  { id: 'imber', name: 'Imber' },
  { id: 'inari', name: 'Inari' },
  { id: 'ingmar', name: 'Ingmar' },
  { id: 'iridica', name: 'Iridica' },
  { id: 'iro', name: 'Iro' },
  { id: 'irulta', name: 'Irulta' },
  { id: 'ivis', name: 'Ivis' },
  { id: 'julheim', name: 'Julheim' },
  { id: 'k', name: 'K' },
  { id: 'karlia', name: 'Karlia' },
  { id: 'keid', name: 'Keid' },
  { id: 'kelvinor', name: 'Kelvinor' },
  { id: 'kerth_secundus', name: 'Kerth Secundus' },
  { id: 'khandark', name: 'Khandark' },
  { id: 'kharst', name: 'Kharst' },
  { id: 'kirrik', name: 'Kirrik' },
  { id: 'klaka_5', name: 'Klaka 5' },
  { id: 'klen_dahth_ii', name: 'Klen Dahth II' },
  { id: 'kneth_port', name: 'Kneth Port' },
  { id: 'krakabos', name: 'Krakabos' },
  { id: 'krakatwo', name: 'Krakatwo' },
  { id: 'kraz', name: 'Kraz' },
  { id: 'kuma', name: 'Kuma' },
  { id: 'kuper', name: 'Kuper' },
  { id: 'lastofe', name: 'Lastofe' },
  { id: 'leng_secundus', name: 'Leng Secundus' },
  { id: 'lesath', name: 'Lesath' },
  { id: 'liberty_ridge', name: 'Liberty Ridge' },
  { id: 'maia', name: 'Maia' },
  { id: 'malevelon_creek', name: 'Malevelon Creek' },
  { id: 'mantes', name: 'Mantes' },
  { id: 'marfark', name: 'Marfark' },
  { id: 'marre_iv', name: 'Marre IV' },
  { id: 'mars', name: 'Mars' },
  { id: 'martale', name: 'Martale' },
  { id: 'martyr_s_bay', name: 'Martyr\'s Bay' },
  { id: 'mastia', name: 'Mastia' },
  { id: 'matar_bay', name: 'Matar Bay' },
  { id: 'maw', name: 'Maw' },
  { id: 'meissa', name: 'Meissa' },
  { id: 'mekbuda', name: 'Mekbuda' },
  { id: 'menkent', name: 'Menkent' },
  { id: 'merak', name: 'Merak' },
  { id: 'merga_iv', name: 'Merga IV' },
  { id: 'meridia', name: 'Meridia' },
  { id: 'midasburg', name: 'Midasburg' },
  { id: 'minchir', name: 'Minchir' },
  { id: 'mintoria', name: 'Mintoria' },
  { id: 'mog', name: 'Mog' },
  { id: 'moradesh', name: 'Moradesh' },
  { id: 'mordia_9', name: 'Mordia 9' },
  { id: 'mort', name: 'Mort' },
  { id: 'mortax_prime', name: 'Mortax Prime' },
  { id: 'mox', name: 'Mox' },
  { id: 'myradesh', name: 'Myradesh' },
  { id: 'myrium', name: 'Myrium' },
  { id: 'nabatea_secundus', name: 'Nabatea Secundus' },
  { id: 'navi_vii', name: 'Navi VII' },
  { id: 'new_haven', name: 'New Haven' },
  { id: 'new_kiruna', name: 'New Kiruna' },
  { id: 'new_stockholm', name: 'New Stockholm' },
  { id: 'nivel_43', name: 'Nivel 43' },
  { id: 'nublaria_i', name: 'Nublaria I' },
  { id: 'oasis', name: 'Oasis' },
  { id: 'obari', name: 'Obari' },
  { id: 'okul_vi', name: 'Okul VI' },
  { id: 'omicron', name: 'Omicron' },
  { id: 'oshaune', name: 'Oshaune' },
  { id: 'oslo_station', name: 'Oslo Station' },
  { id: 'osupsam', name: 'Osupsam' },
  { id: 'outpost_32', name: 'Outpost 32' },
  { id: 'overgoe_prime', name: 'Overgoe Prime' },
  { id: 'pandion_xxiv', name: 'Pandion-XXIV' },
  { id: 'parsh', name: 'Parsh' },
  { id: 'partion', name: 'Partion' },
  { id: 'pathfinder_v', name: 'Pathfinder V' },
  { id: 'peacock', name: 'Peacock' },
  { id: 'penta', name: 'Penta' },
  { id: 'phact_bay', name: 'Phact Bay' },
  { id: 'pherkad_secundus', name: 'Pherkad Secundus' },
  { id: 'pilen_v', name: 'Pilen V' },
  { id: 'pioneer_ii', name: 'Pioneer II' },
  { id: 'polaris_prime', name: 'Polaris Prime' },
  { id: 'pollux_31', name: 'Pollux 31' },
  { id: 'prasa', name: 'Prasa' },
  { id: 'primordia', name: 'Primordia' },
  { id: 'propus', name: 'Propus' },
  { id: 'prosperity_falls', name: 'Prosperity Falls' },
  { id: 'providence', name: 'Providence' },
  { id: 'p_pli_ix', name: 'Pöpli IX' },
  { id: 'ras_algethi', name: 'Ras Algethi' },
  { id: 'rasp', name: 'Rasp' },
  { id: 'ratch', name: 'Ratch' },
  { id: 'rd_4', name: 'RD-4' },
  { id: 'reaf', name: 'Reaf' },
  { id: 'regnus', name: 'Regnus' },
  { id: 'rirga_bay', name: 'Rirga Bay' },
  { id: 'rogue_5', name: 'Rogue 5' },
  { id: 'seasse', name: 'Seasse' },
  { id: 'senge_23', name: 'Senge 23' },
  { id: 'setia', name: 'Setia' },
  { id: 'seyshel_beach', name: 'Seyshel Beach' },
  { id: 'shallus', name: 'Shallus' },
  { id: 'shelt', name: 'Shelt' },
  { id: 'shete', name: 'Shete' },
  { id: 'siemnot', name: 'Siemnot' },
  { id: 'sirius', name: 'Sirius' },
  { id: 'skaash', name: 'Skaash' },
  { id: 'skat_bay', name: 'Skat Bay' },
  { id: 'skitter', name: 'Skitter' },
  { id: 'slif', name: 'Slif' },
  { id: 'socorro_iii', name: 'Socorro III' },
  { id: 'solghast', name: 'Solghast' },
  { id: 'spherion', name: 'Spherion' },
  { id: 'stor_tha_prime', name: 'Stor Tha Prime' },
  { id: 'stout', name: 'Stout' },
  { id: 'sulfura', name: 'Sulfura' },
  { id: 'super_earth', name: 'Super Earth' },
  { id: 'tarsh', name: 'Tarsh' },
  { id: 'termadon', name: 'Termadon' },
  { id: 'terrek', name: 'Terrek' },
  { id: 'the_weir', name: 'The Weir' },
  { id: 'tibit', name: 'Tibit' },
  { id: 'tien_kwan', name: 'Tien Kwan' },
  { id: 'trandor', name: 'Trandor' },
  { id: 'troost', name: 'Troost' },
  { id: 'turing', name: 'Turing' },
  { id: 'ubanea', name: 'Ubanea' },
  { id: 'undisclosed_location', name: 'Undisclosed Location' },
  { id: 'ursica_xi', name: 'Ursica XI' },
  { id: 'ustotu', name: 'Ustotu' },
  { id: 'valgaard', name: 'Valgaard' },
  { id: 'valmox', name: 'Valmox' },
  { id: 'vandalon_iv', name: 'Vandalon IV' },
  { id: 'varylia_5', name: 'Varylia 5' },
  { id: 'vega_bay', name: 'Vega Bay' },
  { id: 'veil', name: 'Veil' },
  { id: 'veld', name: 'Veld' },
  { id: 'vernen_wells', name: 'Vernen Wells' },
  { id: 'vindemitarix_prime', name: 'Vindemitarix Prime' },
  { id: 'viridia_prime', name: 'Viridia Prime' },
  { id: 'vog_sojoth', name: 'Vog-Sojoth' },
  { id: 'volterra', name: 'Volterra' },
  { id: 'wasat', name: 'Wasat' },
  { id: 'wezen', name: 'Wezen' },
  { id: 'widow_s_harbor', name: 'Widow\'s Harbor' },
  { id: 'wilford_station', name: 'Wilford Station' },
  { id: 'wraith', name: 'Wraith' },
  { id: 'x_45', name: 'X-45' },
  { id: 'yed_prior', name: 'Yed Prior' },
  { id: 'zagon_prime', name: 'Zagon Prime' },
  { id: 'zea_rugosia', name: 'Zea Rugosia' },
  { id: 'zefia', name: 'Zefia' },
  { id: 'zegema_paradise', name: 'Zegema Paradise' },
  { id: 'zosma', name: 'Zosma' },
  { id: 'zzaniah_prime', name: 'Zzaniah Prime' },
];

export const DEFAULT_CONFIG = {
  poiTypes: [
    { id: 'two_man_bunker', name: 'Bunker', slots: 3 },
    { id: 'explodable_bunker', name: 'Container', slots: 2 },
    { id: 'loot_pod', name: 'Loot Pod', slots: 1 },
  ],
  itemTypes: [
    { id: 'medals', name: 'Medals', icon: 'assets/icons/medals.webp', value: DEFAULT_ITEM_VALUES.medals, denominations: DEFAULT_DENOMINATIONS.medals },
    { id: 'requisition', name: 'Requisition Slips', icon: 'assets/icons/requisition.webp', value: DEFAULT_ITEM_VALUES.requisition, denominations: DEFAULT_DENOMINATIONS.requisition },
    { id: 'super_credits', name: 'Super Credits', icon: 'assets/icons/super_credits.webp', value: DEFAULT_ITEM_VALUES.super_credits, denominations: DEFAULT_DENOMINATIONS.super_credits },
    { id: 'guns', name: 'Weapons', icon: 'assets/icons/weapons.svg', value: DEFAULT_ITEM_VALUES.guns, denominations: DEFAULT_DENOMINATIONS.guns },
    { id: 'common_samples', name: 'Common Samples', icon: 'assets/icons/common_samples.webp', value: DEFAULT_ITEM_VALUES.common_samples, denominations: DEFAULT_DENOMINATIONS.common_samples },
    { id: 'rare_samples', name: 'Rare Samples', icon: 'assets/icons/rare_samples.webp', value: DEFAULT_ITEM_VALUES.rare_samples, denominations: DEFAULT_DENOMINATIONS.rare_samples },
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
    // The taxonomy is fixed and shipped with the app, but a user's saved
    // config predates additions like this one — merge in any default entries
    // (by id) that aren't already present, across all five taxonomy lists,
    // so everyone converges on the same fixed set without needing a reset.
    ['poiTypes', 'itemTypes', 'difficulties', 'factions', 'planets'].forEach((key) => {
      const existingIds = new Set(parsed[key].map((entry) => entry.id));
      DEFAULT_CONFIG[key].forEach((entry) => {
        if (!existingIds.has(entry.id)) parsed[key].push(structuredClone(entry));
      });
    });
    // Display names are app-owned text, not user data (there's no rename UI) —
    // resync them from defaults so a stale cached config (e.g. from before a
    // POI got renamed "Two-Man Bunker" -> "Bunker") updates without a reset.
    ['poiTypes', 'itemTypes', 'difficulties', 'factions', 'planets'].forEach((key) => {
      const namesById = new Map(DEFAULT_CONFIG[key].map((entry) => [entry.id, entry.name]));
      parsed[key].forEach((entry) => {
        if (namesById.has(entry.id)) entry.name = namesById.get(entry.id);
      });
    });
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
