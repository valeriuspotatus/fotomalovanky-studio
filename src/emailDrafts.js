// Copy-paste customer emails for the cases that make intake hold an order: missing photos, an
// unreadable file, an exact-duplicate upload, or a photo too poor to use. Drafts only — the tool
// never sends them (SOP hard rule). Deterministic templates so the text is stable and obeys the
// style rules: polite, human, no em dashes, restrained exclamation, formal address, signed
// David / Fotomalovánky.cz, and always asking the customer to reply with the photo attached.
//
// The Czech is provisional. The operator is the native speaker and brand voice; the final wording
// (gender agreement, tone) is their pass — plan M3.

/** Czech count agreement for "fotka": 1 fotka, 2-4 fotky, otherwise fotek. */
export function czPhotos(n) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (n === 1) return 'fotka';
  if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return 'fotky';
  return 'fotek';
}

const withCount = (n) => `${n} ${czPhotos(n)}`;

/** Which hold reason drives the email. Missing beats the rest: if photos are absent, that is the
 *  ask; the other cases are about the photos that did arrive. Returns null when nothing holds
 *  (a warn/ok order is generated, not emailed). */
export function pickEmailCase(findings) {
  const holds = (findings ?? []).filter((f) => f.verdict === 'hold');
  if (holds.some((f) => f.reason === 'missing-photos')) return 'missing';
  if (holds.some((f) => f.reason === 'unreadable')) return 'unreadable';
  if (holds.some((f) => f.reason === 'duplicate-identical')) return 'duplicate';
  if (holds.length) return 'quality'; // low-resolution, or any other hold on a supplied photo
  return null;
}

function greeting(surname) {
  return surname ? `Dobrý den, paní/pane ${surname},` : 'Dobrý den,';
}

const SIGNOFF = 'Děkuji a přeji hezký den,\nDavid\nFotomalovánky.cz';
const REPLY = 'odpovědí na tento e-mail s fotkou v příloze';

const BODIES = {
  missing: (c, g) =>
`${g}

děkujeme za Vaši objednávku ${c.order}. Vybraný produkt obsahuje ${withCount(c.expected)}, zatím se nám jich ale sešlo ${c.uploaded}. Prosíme o doplnění ${c.missing} chybějících ${REPLY}, abychom mohli knihu připravit.

${SIGNOFF}`,

  unreadable: (c, g) =>
`${g}

děkujeme za Vaši objednávku ${c.order}. Bohužel se nám nepodařilo otevřít ${c.photos ? `soubor ${c.photos}` : 'jednu z nahraných fotek'}. Mohli byste nám ji prosím poslat znovu ${REPLY}?

${SIGNOFF}`,

  duplicate: (c, g) =>
`${g}

děkujeme za Vaši objednávku ${c.order}. Zdá se, že se ${c.photos ? `fotka ${c.photos}` : 'jedna z fotek'} v objednávce opakuje. Chtěli byste ji nahradit jinou fotkou, nebo je to takto v pořádku? Případnou náhradu nám můžete poslat ${REPLY}.

${SIGNOFF}`,

  quality: (c, g) =>
`${g}

děkujeme za Vaši objednávku ${c.order}. ${c.photos ? `Fotka ${c.photos} je bohužel` : 'Jedna z fotek je bohužel'} v nižší kvalitě, než abychom z ní mohli udělat pěknou omalovánku. Mohli byste nám prosím poslat ostřejší nebo kvalitnější verzi ${REPLY}?

${SIGNOFF}`,
};

/** Build { subject, body, to } for a held order, or null if the case has no template.
 *  `ctx` = { order, surname, email, expected, uploaded, missing, photos } — `photos` is a short
 *  human label for the problem file(s), used where the case points at a specific photo. */
export function renderEmail(caseName, ctx = {}) {
  const body = BODIES[caseName]?.(ctx, greeting(ctx.surname));
  if (!body) return null;
  return {
    subject: `Fotomalovánky.cz – objednávka ${ctx.order ?? ''}`.trim(),
    body,
    to: ctx.email ?? '',
  };
}
