// Prewritten reply templates for the dashboard composer, mined from the real Sent folder (the
// messages David sends most) and approved by him. Pure data + a tiny fill helper — no I/O — so the
// composer and its tests share one source of truth. Signed "David — Fotomalovánky.cz".
//
// `[…]` bracket tokens are placeholders the operator fills before sending (order number, link, count).
// They are deliberately left in the body so a half-filled template can't be sent by accident.

const SIGN = '\n\nS pozdravem,\nDavid\nFotomalovánky.cz';

/** The approved templates, most-used first. `subject` may be empty (a reply keeps the thread's). */
export const MAIL_TEMPLATES = Object.freeze([
  {
    id: 'hotovo-odkaz',
    label: 'Hotové Fotomalovánky — odkaz',
    subject: 'Vaše Fotomalovánky #[ČÍSLO]',
    body:
      'Dobrý den,\n\npřipravili jsme vaše Fotomalovánky, můžete si je stáhnout a vytisknout zde: [ODKAZ]\n\n' +
      'Doporučujeme tisknout na 100 % velikosti bez okrajů. Budeme moc rádi za jakoukoliv zpětnou vazbu.' +
      SIGN,
  },
  {
    id: 'hotovo-priloha',
    label: 'Hotové Fotomalovánky — v příloze',
    subject: 'Vaše Fotomalovánky #[ČÍSLO]',
    body:
      'Dobrý den,\n\npřipravili jsme vaše Fotomalovánky, posíláme je v příloze. ' +
      'Doporučujeme tisknout na 100 % velikosti bez okrajů. Budeme moc rádi za jakoukoliv zpětnou vazbu.' +
      SIGN,
  },
  {
    id: 'omluva-zdrzeni',
    label: 'Omluva za delší dobu vyřízení',
    subject: 'Vaše objednávka Fotomalovánky',
    body:
      'Dobrý den,\n\nchtěli bychom se vám omluvit za delší dobu vyřízení vaší objednávky. Upřímně jsme ' +
      'nečekali tak obrovský zájem o naše produkty a momentálně pracujeme naplno, abychom vše co nejdříve ' +
      'zpracovali a odeslali. Vaší objednávce se věnujeme a brzy ji odešleme.\n\nDěkujeme za trpělivost.' +
      SIGN,
  },
  {
    id: 'chybi-fotka',
    label: 'Chybí nám fotografie',
    subject: 'Chybí nám fotografie k vaší objednávce',
    body:
      'Dobrý den,\n\nk vaší objednávce nám bohužel chybí [POČET] fotografie. Mohli byste nám ji prosím ' +
      'zaslat v odpovědi na tento e-mail? Jakmile ji budeme mít, hned se do vašich Fotomalovánek pustíme.' +
      SIGN,
  },
  {
    id: 'storno',
    label: 'Potvrzení storna',
    subject: 'Storno objednávky #[ČÍSLO]',
    body: 'Dobrý den,\n\npotvrzuji storno vaší objednávky.' + SIGN,
  },
  {
    id: 'doba-vyroby',
    label: 'Doba výroby a expedice',
    subject: 'Vaše objednávka Fotomalovánky',
    body:
      'Dobrý den,\n\naktuálně je doba výroby a odeslání cca do 2 dnů. V případě jakýchkoliv dotazů nám napište.' +
      SIGN,
  },
]);

/** The unfilled `[TOKEN]` placeholders left in some text — bracketed all-uppercase words like
 *  `[ČÍSLO]`, `[ODKAZ]`, `[POČET]`. The composer uses this to refuse sending a half-filled template
 *  (a placeholder is a sign the operator hasn't finished), while leaving ordinary text untouched. */
export function unfilledPlaceholders(...texts) {
  const found = texts.join('\n').match(/\[[\p{Lu}0-9 ]{2,}\]/gu) ?? [];
  return [...new Set(found)];
}

/** One template by id, or null. */
export function templateById(id) {
  return MAIL_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** The compact list the composer's picker renders (no bodies until one is chosen client-side, but
 *  small enough to ship whole). */
export function templateList() {
  return MAIL_TEMPLATES.map(({ id, label, subject, body }) => ({ id, label, subject, body }));
}
