// The curated keyword map: the queries we have decided to go after, written down by hand. This
// replaces "ask Gemini for some keywords" — a model inventing search terms has no volume data, so
// it produced plausible Czech phrases nobody types. A short list we actually maintain beats a long
// list we invented.
//
// PRIORITY IS NOT A GUESS. Every seed lands on 2 (the neutral middle). Move an entry to 1 or 3 only
// from Search Console: impressions and average position for that exact query. If nobody has looked
// at the data, the entry stays on 2 — a priority pulled out of the air is worse than no priority,
// because it looks like evidence.
//
// `cluster` is the internal-linking group: articles in the same cluster link to each other, so the
// cluster is a topic ("printables you can print at home"), not an article type. `articleType` picks
// the draft template (see draft.js): "printable" is a lead-magnet page built around a print-at-home
// set, "gift" sells the book as a present, "trust" explains how the thing is actually made.
//
// Pure data, no IO.

/**
 * @typedef {object} KeywordEntry
 * @property {string} keyword     the exact Czech query we target
 * @property {string} cluster     internal-linking group (siblings link to each other)
 * @property {'printable'|'gift'|'trust'} articleType  which draft template to use
 * @property {1|2|3} priority     1 = write first. Corrected from Search Console, never guessed.
 * @property {{m:number,d:number}|null} season  the date the query peaks around, if it is seasonal
 * @property {string} notes       why people search this — becomes the draft's intent line
 */

/** @type {readonly KeywordEntry[]} */
export const KEYWORD_MAP = Object.freeze(
  [
    // ---- tisknutelné sady (lead magnet) -------------------------------------------------------
    {
      keyword: 'omalovánky zvířata k vytisknutí',
      cluster: 'omalovanky-k-vytisknuti',
      articleType: 'printable',
      priority: 2,
      season: null,
      notes: 'Rodič hledá omalovánky, které si může hned vytisknout doma — potřebuje je teď, ne za týden.',
    },
    {
      keyword: 'omalovánky auta k vytisknutí',
      cluster: 'omalovanky-k-vytisknuti',
      articleType: 'printable',
      priority: 2,
      season: null,
      notes: 'Nejčastěji rodič kluka, který si právě prochází obdobím aut a bagrů.',
    },
    {
      keyword: 'omalovánky dinosauři',
      cluster: 'omalovanky-k-vytisknuti',
      articleType: 'printable',
      priority: 2,
      season: null,
      notes: 'Stálice mezi dětskými tématy, hledá se celoročně bez ohledu na sezónu.',
    },
    {
      keyword: 'podzimní omalovánky k vytisknutí',
      cluster: 'omalovanky-k-vytisknuti',
      articleType: 'printable',
      priority: 2,
      season: { m: 9, d: 20 },
      notes: 'Deštivé odpoledne a školky hledající podzimní tvoření — listy, houby, ježci.',
    },
    {
      keyword: 'vánoční omalovánky k vytisknutí',
      cluster: 'omalovanky-k-vytisknuti',
      articleType: 'printable',
      priority: 2,
      season: { m: 11, d: 15 },
      notes: 'Adventní tvoření doma i ve školce; hledanost roste od poloviny listopadu.',
    },

    // ---- dárek z fotky ------------------------------------------------------------------------
    {
      keyword: 'originální dárek pro babičku',
      cluster: 'darek-z-fotky',
      articleType: 'gift',
      priority: 2,
      season: null,
      notes: 'Vnoučata i dospělé děti hledají dárek pro někoho, kdo „už všechno má“.',
    },
    {
      keyword: 'dárek z fotky',
      cluster: 'darek-z-fotky',
      articleType: 'gift',
      priority: 2,
      season: null,
      notes: 'Obecný dotaz na personalizovaný dárek — člověk má fotku a hledá, co z ní udělat.',
    },
    {
      keyword: 'osobní dárek pro děti',
      cluster: 'darek-z-fotky',
      articleType: 'gift',
      priority: 2,
      season: null,
      notes: 'Rodič nebo kmotra hledá dárek, který dítě nezahodí do týdne mezi ostatní hračky.',
    },
    {
      keyword: 'dárek k Vánocům pro prarodiče',
      cluster: 'darek-z-fotky',
      articleType: 'gift',
      priority: 2,
      season: { m: 11, d: 20 },
      notes: 'Klasické vánoční dilema: babička a děda nic nepotřebují, ale fotku vnoučat ocení.',
    },

    // ---- důvěra / jak to funguje --------------------------------------------------------------
    {
      keyword: 'jak vybrat fotky na omalovánky',
      cluster: 'jak-to-funguje',
      articleType: 'trust',
      priority: 2,
      season: null,
      notes: 'Člověk už objednávku zvažuje a bojí se, že vybere špatné fotky a výsledek ho zklame.',
    },
    {
      keyword: 'jak vzniká omalovánka z fotky',
      cluster: 'jak-to-funguje',
      articleType: 'trust',
      priority: 2,
      season: null,
      notes: 'Zvědavost i nedůvěra — zákazník chce vidět, že za tím stojí ruční práce a péče.',
    },
  ].map(Object.freeze),
);

/** The article types the draft generator knows how to write. */
export const ARTICLE_TYPES = Object.freeze(['printable', 'gift', 'trust']);
