// The title-page text is already in the customer's file names. The shop names every photo
// "<order>_img<NNNN>_-_<what the customer typed>", so "1523_img0001_-_hofbauerovi_18.7.2026"
// carries "Hofbauerovi 18.7.2026". Recovering it spares the operator retyping a stranger's
// name — and retyping is exactly where a misspelled name reaches a printed book.
//
// Spelling is copied verbatim. Only the case and the underscores are ours to change: a
// customer who wrote "maxinnku" gets "Maxinnku", not a guess at what they meant.

const SEPARATOR = '_-_';

// The shop's file names turn every space into "_" and drop the "+" between names outright, so
// "Julka + Agnes" arrives as "julka__agnes". A doubled underscore is therefore a "+", not an
// empty word — dropping it would silently reword the customer's dedication.
const PLUS = '+';

// Czech prepositions and conjunctions stay lowercase inside a title. The first word never does,
// which is why "pro" appears here and still yields "Pro Maxinnku a Estellku".
const LOWERCASE_WITHIN = new Set([
  'a', 'i', 'k', 'ke', 'o', 'od', 'po', 'pro', 's', 'se', 'u', 'v', 've', 'z', 'ze',
  'do', 'na', 'za', 'při', 'nad', 'pod', 'bez', 'aneb', 'nebo',
]);

/** Upper-case the first character, leave the rest exactly as the customer typed it.
 *  A word starting with a digit ("18.7.2026") is returned unchanged. */
const capitalize = (word) => word.charAt(0).toUpperCase() + word.slice(1);

/** The title-page text hidden in one photo's base name, or '' when the name carries none.
 *  A customer who wrote nothing leaves no "_-_" segment, and that is a real answer: their title
 *  page prints without a text line, and the book is otherwise identical. */
export function dedicationFromBase(base) {
  const at = String(base ?? '').indexOf(SEPARATOR);
  if (at < 0) return '';

  const words = base
    .slice(at + SEPARATOR.length)
    .replace(/^_+|_+$/g, '') // trim first, or a trailing run would leave a dangling "+"
    .replace(/_{2,}/g, ` ${PLUS} `)
    .replaceAll('_', ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  let seenWord = false;
  return words
    .map((word) => {
      if (word === PLUS) return word;
      const isFirst = !seenWord;
      seenWord = true;
      return !isFirst && LOWERCASE_WITHIN.has(word.toLowerCase()) ? word.toLowerCase() : capitalize(word);
    })
    .join(' ');
}

/** The order's title-page text, from the names of the photos in it.
 *
 *  Every photo of an order repeats the same suffix, so they should all agree. When they do not
 *  — a stray file, a customer who renamed one photo — the majority wins rather than whichever
 *  file the filesystem happened to list first. */
export function deriveDedication(bases = []) {
  const votes = new Map();
  for (const base of bases) {
    const text = dedicationFromBase(base);
    if (text) votes.set(text, (votes.get(text) ?? 0) + 1);
  }
  let best = '';
  let most = 0;
  for (const [text, count] of votes) {
    if (count > most) {
      best = text;
      most = count;
    }
  }
  return best;
}
