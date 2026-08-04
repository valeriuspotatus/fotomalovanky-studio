// The Fotomalovánky brand voice + the brand's forbidden vocabulary, shared by everything that writes
// customer-facing Czech: the ad calendar (creatives/adCopy.js) and the blog (topic engine, draft
// generator, QC pass). Transcribed from David's brand guide ("Brand Guide & AI Context" in
// docs/Fotomalovánky 2026.docx, §4 Tone of Voice + §5 Jak komunikujeme vs. NEkomunikujeme).
//
// The one rule everything hangs on: we sell the EMOTION (a kept memory, a personal gift), never the
// technology or a discount. The guide is explicit — "Nikdy neprodáváme AI algoritmus" — so the words
// that expose the machinery or cheapen the brand are banned in both media. Pure data + one matcher;
// no IO. Lives at src/ root because it belongs to neither blog/ nor creatives/ — both import it.

/** What both media agree on: who we are, what we sell, and the vocabulary that is off-limits. */
export const BRAND_CORE = [
  'Fotomalovánky.cz proměňují osobní fotky zákazníků na omalovánky a tištěné omalovánkové knihy na míru.',
  'Prodáváme emoci a vzpomínku, ne technologii ani slevu. NIKDY nezmiňuj umělou inteligenci, algoritmy,',
  '„generování“ ani „renderování“. Pro člověka na druhé straně je to ruční, osobní výrobek. Mluv o kouzlu,',
  'proměně a vytvoření; o vzpomínkách, radosti, společném čase a dárku. Nevymýšlej recenze, slevy, akce,',
  'výprodeje ani konkrétní ceny a termíny. Žádné klišé, žádné křičení velkými písmeny.',
].join(' ');

/** Blog tail: long-form advice, formal vykání — the guide's "Web/E-mailing" register. */
export const BLOG_VOICE = [
  BRAND_CORE,
  'Píšeme česky, vřele a osobně, vykáním, jako rada od někoho, kdo tomu rozumí, ne jako reklama.',
].join(' ');

/** Ad tail: short, warm, a little playful. Stays on vykání to match the templates' seed copy — the
 *  brand guide reserves hravé tykání for organic social, which this calendar does not write. */
export const AD_VOICE = [
  BRAND_CORE,
  'Tón: vřelý, osobní, česky, vykáním, s lehkou hravostí. Mluvíme k jednomu člověku, ne k davu.',
  'Žádné vykřičníky navíc. Nejsme chladní technokraté ani přehnaně sluníčkoví prodejci.',
].join(' ');

/** Distinctive banned substrings (lowercased, diacritics-insensitive) — curated to avoid false hits on
 *  innocent words. In the blog a match is a soft QC WARNING; in an ad the offending field falls back to
 *  the template's seed copy, because nobody reviews a calendar ad before it renders. */
export const BANNED_STEMS = Object.freeze([
  'umela inteligence',
  'umelou inteligenci',
  ' ai ',
  'algoritm',
  'neuronov',
  'neuronka',
  'vygenerov',
  'generovani',
  'renderov',
  'personalizovany produkt',
  'sleva',
  'slevu',
  'slevy',
  'zlevn',
  'nejlevnej',
  'levny vyrobek',
  'akcni',
  'vyprodej',
  'zabaveni ditete',
]);

/** Accent-fold + lowercase, so "Sleva"/"slevá" both match the ASCII stems above. */
export function fold(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** The banned stems that appear in `text` (deduped), for the QC pass. Empty array = clean. */
export function bannedHits(text) {
  const hay = ` ${fold(text)} `;
  const hits = [];
  for (const stem of BANNED_STEMS) if (hay.includes(stem) && !hits.includes(stem.trim())) hits.push(stem.trim());
  return hits;
}
