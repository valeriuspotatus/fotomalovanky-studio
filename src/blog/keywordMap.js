// The curated keyword map: the queries we have decided to go after, written down by hand. This
// replaces "ask Gemini for some keywords" — a model inventing search terms has no volume data, so
// it produced plausible Czech phrases nobody types. A short list we actually maintain beats a long
// list we invented.
//
// PRIORITY IS NOT A GUESS. An entry sits on 2 (the neutral middle) until Search Console says
// otherwise; only impressions and average position for that exact query may move it to 1 or 3, and
// the numbers go in `notes` so the reason outlives whoever read the dashboard. A priority pulled out
// of the air is worse than no priority, because it looks like evidence.
//
// Updated 2026-08-04 from 12 months of real GSC data. The generic printable queries earned priority 1
// on a specific finding: the site already ranks page 1-2 for them with no page written for them at
// all. Everything still on 2 is there because GSC has nothing to say about it — the site has never
// surfaced for those terms, which is an absence of evidence, not evidence of absence.
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
    // ---- generické tisknutelné dotazy: PRIORITA 1, doložená Search Console ---------------------
    // These three are the only printable keywords with real data behind them (12 months of GSC).
    // The site already surfaces for them on page 1-2 *without a single page written for them*, which
    // is as close to a free win as this list gets: the ranking exists, the content does not.
    {
      keyword: 'omalovánky k vytisknutí pdf',
      cluster: 'omalovanky-k-vytisknuti',
      articleType: 'printable',
      priority: 1,
      season: null,
      notes:
        'GSC 12 měsíců: 203 imprese, průměrná pozice 9, a přitom pro to nemáme ani jednu stránku. ' +
        'Lidé hledají rovnou PDF ke stažení, takže slovo „PDF" musí být v titulku, v meta popisu i u formuláře.',
    },
    {
      keyword: 'omalovánky k tisku',
      cluster: 'omalovanky-k-vytisknuti',
      articleType: 'printable',
      priority: 1,
      season: null,
      notes:
        'GSC 12 měsíců: 201 impresí, průměrná pozice 11. Varianta „k tisku" místo „k vytisknutí" — ' +
        'stejný záměr, jiná formulace. Zaslouží si vlastní stránku, ne přesměrování na jinou frázi.',
    },
    {
      keyword: 'dětské omalovánky k tisku',
      cluster: 'omalovanky-k-vytisknuti',
      articleType: 'printable',
      priority: 2,
      season: null,
      notes: 'GSC 12 měsíců: průměrná pozice 10. Nižší objem než dvě fráze výše, proto priorita 2, ne 1.',
    },

    // ---- tematické sady: PRIORITA 2, zatím bez dat --------------------------------------------
    // NOTE: none of the themed seeds below carry Search Console numbers, and that is not the same as
    // "low volume" — the site has never surfaced for them at all, so GSC has nothing to report. They
    // stay on the neutral 2 until a published page gives them a chance to appear in the data. Do not
    // demote them for missing impressions they were never in a position to earn.
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
    {
      keyword: 'jak udělat z fotky omalovánku',
      cluster: 'jak-to-funguje',
      articleType: 'trust',
      priority: 1,
      season: null,
      notes:
        'GSC 12 měsíců: 152 impresí, průměrná pozice ~7. Pozor, je to DIY záměr: člověk se ptá, jak si to ' +
        'udělat SÁM, ne kde si to koupit. Článek proto musí poctivě popsat, jak na to doma (filtry, aplikace, ' +
        'obkreslení) a teprve pak vysvětlit, v čem je náš rozdíl: ruční doladění, tisk a kniha s věnováním. ' +
        'Kdo přijde s DIY otázkou a dostane jen reklamu, odejde a pozici 7 nám to nezachrání.',
    },
  ].map(Object.freeze),
);

/** The article types the draft generator knows how to write. */
export const ARTICLE_TYPES = Object.freeze(['printable', 'gift', 'trust']);
