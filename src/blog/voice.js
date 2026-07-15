// The Fotomalovánky blog voice + the brand's forbidden vocabulary, shared by the topic engine, the
// draft generator and the QC pass. Same guardrail as the ad copy: we sell the EMOTION (a kept memory,
// a personal gift), never the technology or a discount — so the words that cheapen the brand or expose
// the machinery are banned. Pure data + one matcher; no IO.

/** Injected into every blog prompt so the model writes on-brand Czech and avoids the banned words. */
export const BLOG_VOICE = [
  'Fotomalovánky.cz proměňují osobní fotky zákazníků na omalovánky a tištěné omalovánkové knihy na míru.',
  'Píšeme česky, vřele a osobně, vykáním, jako rada od někoho, kdo tomu rozumí — ne jako reklama.',
  'Prodáváme emoci a vzpomínku, ne technologii ani slevu. NIKDY nezmiňuj umělou inteligenci, algoritmy,',
  '„generování“ ani „renderování“ — pro čtenáře je to ruční, osobní výrobek. Nevymýšlej recenze, slevy,',
  'akce, výprodeje ani konkrétní ceny a termíny. Žádné klišé, žádné křičení velkými písmeny.',
].join(' ');

/** Distinctive banned substrings (lowercased, diacritics-insensitive) — curated to avoid false hits on
 *  innocent words. A match is a soft QC WARNING, never a hard block. */
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
