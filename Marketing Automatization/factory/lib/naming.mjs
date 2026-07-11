export const MARKETS = ['CZ', 'DE']

/**
 * Closed vocabulary. Derived from the "Podpůrná sdělení podle hodnoty" table in
 * brand/brand-guide.md § 6, plus RELAX (the antistres persona, § 5) and FUN (the
 * SEE-phase provocation register).
 *
 * Defining an angle is cheap. Running one is not - see LIVE_ANGLE_GUIDANCE.
 */
export const ANGLES = ['EMO', 'GIFT', 'PROOF', 'SIMPLE', 'SCREEN', 'TOGETHER', 'RELAX', 'FUN']

/**
 * Who or what is depicted. NONE covers text-only "ugly ad" creatives (E18, VID4);
 * MIX covers grids and collages that deliberately show breadth (E21, VID5).
 */
export const SUBJECTS = ['KIDS', 'PET', 'COUPLE', 'GRAND', 'FAM', 'SELF', 'MIX', 'NONE']

export const FORMATS = ['SPLIT', 'REAL', 'HYBRID', 'SCRAP', 'REVIEW', 'GRID', 'CAROUSEL', 'REEL', 'UGC']

export const OBJECTIVES = ['SALES', 'TRAFFIC', 'AWARE', 'REMARKET']
export const SEASONS = ['EVERGREEN', 'BTS', 'BF', 'XMAS', 'MIK', 'CONTEST', 'CHARITY', 'VAL', 'MDM', 'MDD']

export const LEGACY = 'LEGACY'

/**
 * The real constraint is conversions per cell, not vocabulary size. At ~180 orders/month
 * and a 25-conversion minimum, roughly 7 angles can carry a verdict at once. analyze.mjs
 * warns when more angles are live than the conversion volume can resolve.
 */
export const LIVE_ANGLE_GUIDANCE =
  'Cap concurrently live angles at floor(monthly conversions / FM_MIN_CONVERSIONS).'

const group = values => `(${values.join('|')})`

export const AD_NAME_RE = new RegExp(
  `^FM_${group(MARKETS)}_${group(ANGLES)}_${group(SUBJECTS)}_${group(FORMATS)}_v(\\d{2})$`
)

export const CAMPAIGN_NAME_RE = new RegExp(
  `^FM_${group(MARKETS)}_${group(OBJECTIVES)}_${group(SEASONS)}$`
)

/** Angles only make sense against some subjects. See brand/angles.md § 3. */
export const COHERENT_SUBJECTS = {
  EMO: ['KIDS', 'PET', 'COUPLE', 'GRAND', 'FAM', 'MIX'],
  GIFT: ['KIDS', 'PET', 'COUPLE', 'GRAND', 'FAM', 'MIX', 'NONE'],
  PROOF: ['KIDS', 'PET', 'COUPLE', 'GRAND', 'FAM', 'MIX', 'NONE'],
  SIMPLE: ['KIDS', 'PET', 'COUPLE', 'GRAND', 'FAM', 'MIX', 'NONE'],
  SCREEN: ['KIDS', 'FAM', 'NONE'],
  TOGETHER: ['KIDS', 'FAM', 'GRAND', 'COUPLE'],
  RELAX: ['SELF', 'COUPLE'],
  FUN: ['KIDS', 'PET', 'COUPLE', 'SELF', 'FAM', 'NONE'],
}

export const isCoherent = (angle, subject) =>
  COHERENT_SUBJECTS[angle]?.includes(subject) ?? false

/**
 * Existing creatives, mapped onto the taxonomy. Their codes stay authoritative for
 * production; this is how their performance becomes attributable.
 *
 * Naming note: their docs use "V1"-"V3" for split-screen visual variants inside E2, and
 * "V1"-"V9" for video concepts in a different file. Same symbols, different meanings.
 * We write VID## and SV## so a reference is never ambiguous.
 */
/**
 * The full roster from MARKETING PLAN v2 § 3 (E1-E22, R1-R2, S1-S5). Nine of the E-codes
 * also have full layouts in CREATIVE PRODUCTION – Evergreen Ads.md.
 *
 * `priority` mirrors their deployment table: 1 = 🔴 Hned, 2 = 🟡 Brzy, 3 = 🟢 Sezónně.
 */
export const CREATIVE_MAP = {
  E1: { angle: 'EMO', subject: 'FAM', format: 'HYBRID', priority: 1, season: 'EVERGREEN', title: 'Vzpomínky k vybarvení' },
  E2: { angle: 'GIFT', subject: 'KIDS', format: 'SPLIT', priority: 1, season: 'EVERGREEN', title: 'Nejlepší dárek' },
  E3: { angle: 'EMO', subject: 'PET', format: 'SPLIT', priority: 1, season: 'EVERGREEN', title: 'Mazlíčci' },
  E4: { angle: 'EMO', subject: 'GRAND', format: 'REAL', priority: 1, season: 'EVERGREEN', title: 'Prarodiče' },
  E5: { angle: 'RELAX', subject: 'SELF', format: 'REAL', priority: 2, season: 'EVERGREEN', title: 'Relax pro dospělé' },
  E6: { angle: 'SIMPLE', subject: 'NONE', format: 'CAROUSEL', priority: 2, season: 'EVERGREEN', title: 'Jak to funguje' },
  E7: { angle: 'GIFT', subject: 'COUPLE', format: 'SPLIT', priority: 1, season: 'EVERGREEN', title: 'Couple Goals' },
  E8: { angle: 'FUN', subject: 'FAM', format: 'SPLIT', priority: 2, season: 'EVERGREEN', title: 'Táta to dá' },
  E9: { angle: 'EMO', subject: 'KIDS', format: 'SPLIT', priority: 3, season: 'EVERGREEN', title: 'Halloween / kostýmy' },
  E10: { angle: 'EMO', subject: 'KIDS', format: 'SPLIT', priority: 3, season: 'EVERGREEN', title: 'Dovolená u bazénu' },
  E11: { angle: 'EMO', subject: 'KIDS', format: 'SPLIT', priority: 2, season: 'EVERGREEN', title: 'Malý pekař' },
  E12: { angle: 'GIFT', subject: 'GRAND', format: 'REAL', priority: 1, season: 'EVERGREEN', title: 'Dědeček & vnoučata' },
  E13: { angle: 'EMO', subject: 'KIDS', format: 'SPLIT', priority: 3, season: 'EVERGREEN', title: 'Bruslení / sport' },
  E14: { angle: 'EMO', subject: 'KIDS', format: 'SPLIT', priority: 2, season: 'EVERGREEN', title: 'Miminko' },
  E15: { angle: 'EMO', subject: 'KIDS', format: 'SPLIT', priority: 3, season: 'EVERGREEN', title: 'Dýně / podzim' },
  E16: { angle: 'EMO', subject: 'KIDS', format: 'SPLIT', priority: 2, season: 'EVERGREEN', title: 'Lavička / obyčejný den' },
  E17: { angle: 'FUN', subject: 'KIDS', format: 'SPLIT', priority: 2, season: 'EVERGREEN', title: 'Sourozenci' },
  E18: { angle: 'FUN', subject: 'NONE', format: 'SCRAP', priority: 1, season: 'EVERGREEN', title: '4 726 fotek (negativní hook)' },
  E19: { angle: 'SCREEN', subject: 'KIDS', format: 'REAL', priority: 1, season: 'EVERGREEN', title: 'Screen time (negativní hook)' },
  E20: { angle: 'EMO', subject: 'FAM', format: 'SPLIT', priority: 2, season: 'EVERGREEN', title: 'Otázka do komentářů' },
  E21: { angle: 'PROOF', subject: 'MIX', format: 'GRID', priority: 1, season: 'EVERGREEN', title: 'Social proof – čísla' },
  E22: { angle: 'GIFT', subject: 'NONE', format: 'SCRAP', priority: 3, season: 'XMAS', title: 'Dárkový poukaz' },
  // Net-new, briefed in creatives/TOGETHER-brief.md to fill the one angle with no creative.
  // status:'brief' = concept written, not yet shot.
  E23: { angle: 'TOGETHER', subject: 'FAM', format: 'REAL', priority: 1, season: 'EVERGREEN', title: 'Nedělní stůl', status: 'brief' },
  E24: { angle: 'TOGETHER', subject: 'GRAND', format: 'REAL', priority: 1, season: 'EVERGREEN', title: 'Jedna stránka, dvě generace', status: 'brief' },
}

/** Review creatives. Both depend on real reviews we have not yet located. See brand-guide.md § 14. */
export const REVIEW_CREATIVES = {
  R1: { angle: 'PROOF', subject: 'NONE', format: 'REVIEW', season: 'EVERGREEN', title: 'Ivana z Loun (screenshot styl)', needsVerifiedReview: true },
  R2: { angle: 'PROOF', subject: 'MIX', format: 'CAROUSEL', season: 'EVERGREEN', title: 'Mashup recenzí', needsVerifiedReview: true },
}

/** Seasonal creatives. S1-S3 are H1 events; only S4 and S5 land in H2 2026. */
export const SEASONAL_CREATIVES = {
  S1: { angle: 'GIFT', subject: 'FAM', format: 'SPLIT', season: 'MDM', title: 'Den matek' },
  S2: { angle: 'GIFT', subject: 'KIDS', format: 'SPLIT', season: 'MDD', title: 'Den dětí' },
  S3: { angle: 'GIFT', subject: 'COUPLE', format: 'SPLIT', season: 'EVERGREEN', title: 'Svatební sezóna' },
  S4: { angle: 'EMO', subject: 'KIDS', format: 'SPLIT', season: 'EVERGREEN', title: 'Prázdniny / cestování' },
  S5: { angle: 'GIFT', subject: 'KIDS', format: 'SPLIT', season: 'BTS', title: 'Zpátky do školy', containsPrice: true, supersededBy: 'BTS1', note: 'Original copy had an illegal price in the description; replaced by the BTS set.' },
}

/** Back-to-school, briefed in creatives/BACKTOSCHOOL-brief.md. Fixes the broken S5. Testable this year. */
export const BTS_CREATIVES = {
  BTS1: { angle: 'EMO', subject: 'KIDS', format: 'HYBRID', season: 'BTS', title: 'Kus léta, který zůstane', status: 'brief' },
  BTS2: { angle: 'SCREEN', subject: 'FAM', format: 'REAL', season: 'BTS', title: 'Podvečer bez obrazovky', status: 'brief' },
}

/**
 * Christmas set, briefed in creatives/CHRISTMAS-brief.md across the four phases from the
 * calendar. X4 reuses E22's taxonomy cell (GIFT/NONE/SCRAP) as v02. status:'brief' = not shot.
 * X3 and X4 also carry an unresolved dependency: the shipping cutoff and whether a voucher exists.
 */
export const XMAS_CREATIVES = {
  X1: { angle: 'GIFT', subject: 'FAM', format: 'SPLIT', season: 'XMAS', phase: 'awareness', title: 'Z léta pod stromeček', status: 'brief' },
  X2: { angle: 'SIMPLE', subject: 'FAM', format: 'CAROUSEL', season: 'XMAS', phase: 'consideration', title: 'Ještě není pozdě', status: 'brief' },
  X3: { angle: 'GIFT', subject: 'NONE', format: 'REAL', season: 'XMAS', phase: 'urgency', title: 'Balíčky se balí', status: 'brief', needsShippingCutoff: true },
  X4: { angle: 'GIFT', subject: 'NONE', format: 'SCRAP', season: 'XMAS', phase: 'voucher', title: 'Poslední chvíle (poukaz)', status: 'brief', needsVoucherProduct: true },
}

/**
 * Black Friday, briefed in creatives/BLACKFRIDAY-brief.md. Bundle, not discount — the copy
 * carries no discount vocabulary by design. BF1 and BF2 reuse existing taxonomy cells as v02.
 * needsBundleDecision: the bundle mechanic (threshold vs paid add-on vs free) is David's call,
 * because a free bundle is a hidden discount and does not lift AOV.
 */
export const BF_CREATIVES = {
  BF1: { angle: 'GIFT', subject: 'NONE', format: 'REAL', season: 'BF', title: 'Celý dárek v jedné krabici', status: 'brief', needsBundleDecision: true },
  BF2: { angle: 'TOGETHER', subject: 'GRAND', format: 'REAL', season: 'BF', title: 'Druhá kopie pro babičku', status: 'brief', needsBundleDecision: true },
}

/** Mikuláš, briefed in creatives/MIKULAS-brief.md. Short window; a seasonal activation of GIFT and FUN. */
export const MIK_CREATIVES = {
  M1: { angle: 'GIFT', subject: 'KIDS', format: 'REAL', season: 'MIK', title: 'Malý dárek od Mikuláše', status: 'brief', needsShippingCutoff: true },
  M2: { angle: 'FUN', subject: 'KIDS', format: 'SPLIT', season: 'MIK', title: 'Byl jsi hodný? (čert/uhlí)', status: 'brief', needsShippingCutoff: true },
}

export const VIDEO_MAP = {
  VID1: { angle: 'SIMPLE', format: 'REEL', title: 'The Transformation', priority: 3 },
  VID2: { angle: 'RELAX', format: 'REEL', title: 'Time-lapse vybarvování', priority: 7 },
  VID3: { angle: 'EMO', format: 'REEL', title: 'Unboxing Reaction', priority: 6 },
  VID4: { angle: 'FUN', format: 'REEL', title: 'iMessage konverzace', priority: 1 },
  VID5: { angle: 'PROOF', format: 'REEL', title: 'Slide Show Reels', priority: 2 },
  VID6: { angle: 'FUN', format: 'REEL', title: 'POV – Scrolluješ mobilem', priority: 4 },
  VID7: { angle: 'RELAX', format: 'REEL', title: 'Satisfying Process', priority: 9 },
  VID8: { angle: 'FUN', format: 'REEL', title: 'Expectation vs. Reality', priority: 5 },
  VID9: { angle: 'PROOF', format: 'REEL', title: 'Founder / Talking Head', priority: 8 },
}

/** Their split-screen visual variants (E2), renamed to avoid the V-code collision. */
export const SPLIT_VARIANTS = {
  SV1: { format: 'SPLIT', title: 'Clean digital' },
  SV2: { format: 'SCRAP', title: '"Přilepené" / scrapbook styl' },
  SV3: { format: 'HYBRID', title: 'Mobil + papír' },
}

/** All creative-concept maps, for coverage and cross-file checks. Declared last so every map exists. */
export const ALL_CREATIVE_MAPS = {
  CREATIVE_MAP, VIDEO_MAP, REVIEW_CREATIVES, SEASONAL_CREATIVES,
  XMAS_CREATIVES, BF_CREATIVES, MIK_CREATIVES, BTS_CREATIVES,
}

export function parseAdName(name) {
  const m = AD_NAME_RE.exec(name ?? '')
  if (!m) return null
  const [, market, angle, subject, format, variant] = m
  return { market, angle, subject, format, variant: Number(variant) }
}

export function parseCampaignName(name) {
  const m = CAMPAIGN_NAME_RE.exec(name ?? '')
  if (!m) return null
  const [, market, objective, season] = m
  return { market, objective, season }
}

/**
 * An ad name that starts with FM_ but fails the regex is a typo, not legacy.
 * Worth surfacing loudly - a misnamed ad silently loses its angle attribution.
 */
export const looksMisnamed = name =>
  typeof name === 'string' && name.startsWith('FM_') && !AD_NAME_RE.test(name)

export function formatAdName({ market, angle, subject, format, variant }) {
  if (!MARKETS.includes(market)) throw new Error(`Unknown market: ${market}`)
  if (!ANGLES.includes(angle)) throw new Error(`Unknown angle: ${angle}`)
  if (!SUBJECTS.includes(subject)) throw new Error(`Unknown subject: ${subject}`)
  if (!FORMATS.includes(format)) throw new Error(`Unknown format: ${format}`)
  if (!isCoherent(angle, subject)) throw new Error(`Incoherent pairing: ${angle} x ${subject}`)
  const v = String(variant).padStart(2, '0')
  return `FM_${market}_${angle}_${subject}_${format}_v${v}`
}

/** Angles with no existing creative anywhere. They cannot be tested until one is produced. */
export function anglesWithoutCreatives() {
  const covered = new Set(
    Object.values(ALL_CREATIVE_MAPS)
      .flatMap(map => Object.values(map))
      .map(c => c.angle)
  )
  return ANGLES.filter(a => !covered.has(a))
}
