// The title-page text is already in the customer's file names. The shop names every photo
// "<order>_img<NNNN>_-_<what the customer typed>", so "1523_img0001_-_hofbauerovi_18.7.2026"
// carries "Hofbauerovi 18.7.2026". Recovering it spares the operator retyping a stranger's
// name — and retyping is exactly where a misspelled name reaches a printed book.
//
// Spelling is copied verbatim. Only the case and the underscores are ours to change: a
// customer who wrote "maxinnku" gets "Maxinnku", not a guess at what they meant.

// Two extension versions, two ways of writing the same thing. The older one underscored every
// space ("1523_img0001_-_hofbauerovi"); the newer one leaves them ("1523_img0001 - hofbauerovi").
// Both mean: what follows is the dedication.
const SEPARATORS = ['_-_', ' - '];

/** The dedication's offset and length inside a base name, or null when it carries none. */
function separatorAt(base) {
  for (const separator of SEPARATORS) {
    const at = base.indexOf(separator);
    if (at >= 0) return { at, length: separator.length };
  }
  return null;
}

/** Everything after the separator: the customer's words, still in file-name form. */
function suffixOf(base) {
  const found = separatorAt(String(base ?? ''));
  return found ? base.slice(found.at + found.length) : null;
}

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

// When the customer writes no title, the shop still puts a generic label after the separator
// ("1527_img0001_-_foto") — "foto"/"photo"/"img" is "no dedication", not a title, and printing it
// as the cover text is wrong. These are the placeholders the extension/shop emit for a blank field,
// accents and case folded; a real dedication that merely contains such a word (e.g. "Foto Novákové")
// keeps its other words and is untouched.
const GENERIC_LABELS = new Set([
  'foto', 'fota', 'fotka', 'fotky', 'fotku', 'fotografie', 'fotografia', 'fotografy',
  'photo', 'photos', 'picture', 'pictures', 'pic', 'pics',
  'image', 'images', 'img', 'obrazek', 'obrazky', 'obrazku', 'snimek', 'snimky', 'snimku',
]);

/** True when the recovered dedication is nothing but generic photo-label words — i.e. the customer
 *  left the title blank and the shop filled in a placeholder. Accents/case/numbers folded first, so
 *  "Foto", "foto_2" and "FOTOGRAFIE" all count. Pure digits/punctuation (e.g. a bare date) are NOT
 *  treated as generic — that could be a real answer — so this only fires on the label words. */
function isGenericLabel(dedication) {
  const norm = String(dedication ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // fold the combining accents
    .toLowerCase()
    .replace(/[0-9]+/g, ' ') // a name may sit beside a date; strip digits for the label test
    .replace(/[^a-z ]+/g, ' ')
    .trim();
  if (!norm) return false; // nothing but digits/punctuation — leave it, might be intentional
  return norm.split(/\s+/).every((word) => GENERIC_LABELS.has(word));
}

/** The title-page text hidden in one photo's base name, or '' when the name carries none.
 *  A customer who wrote nothing leaves no "_-_" segment, and that is a real answer: their title
 *  page prints without a text line, and the book is otherwise identical. */
export function dedicationFromBase(base) {
  const suffix = suffixOf(base);
  if (suffix === null) return '';

  const words = suffix
    .replace(/^_+|_+$/g, '') // trim first, or a trailing run would leave a dangling "+"
    .replace(/_{2,}/g, ` ${PLUS} `)
    .replaceAll('_', ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  let seenWord = false;
  const dedication = words
    .map((word) => {
      if (word === PLUS) return word;
      const isFirst = !seenWord;
      seenWord = true;
      return !isFirst && LOWERCASE_WITHIN.has(word.toLowerCase()) ? word.toLowerCase() : capitalize(word);
    })
    .join(' ');

  // A placeholder label ("foto", "photo", …) means the customer wrote nothing — same as no separator.
  return isGenericLabel(dedication) ? '' : dedication;
}

/** The key a remembered spelling is filed under: "1366_img0001_-_pro_jiricka" -> "pro_jiricka".
 *
 *  Older photo names fold away every diacritic, so "Pro Jiříčka" arrives as "pro_jiricka" and no
 *  rule can put the accents back — "jiricka" is Jiříčka, Jiřička or Jiricka and the file cannot
 *  say which. The slug is what the operator's correction is remembered against: spell it once, and
 *  every later order for the same name is spelled right.
 *
 *  It is deliberately blunt — accents folded, punctuation flattened — so that the two ways the
 *  extension has named the same dedication ("julka__agnes" and "julka + agnes") ask the memory the
 *  same question. Ambiguity is the point: "pro_jiricka" is exactly what we cannot tell apart, and
 *  it is what the operator answered once. */
export function slugFromBase(base) {
  const suffix = suffixOf(base);
  if (suffix === null) return '';
  return suffix
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // the combining accents, now separated from their letters
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Majority vote over the photos of one order. Every photo repeats the same suffix, so they should
 *  agree; when they do not — a stray file, a renamed photo — the majority wins rather than
 *  whichever file the filesystem happened to list first. */
const majority = (values) => {
  const votes = new Map();
  for (const v of values) if (v) votes.set(v, (votes.get(v) ?? 0) + 1);
  let best = '';
  let most = 0;
  for (const [v, count] of votes) {
    if (count > most) {
      best = v;
      most = count;
    }
  }
  return best;
};

/** The order's title-page text, from the names of the photos in it. */
export function deriveDedication(bases = []) {
  return majority(bases.map(dedicationFromBase));
}

/** The order's slug — the key its remembered spelling is filed under. */
export function deriveSlug(bases = []) {
  return majority(bases.map(slugFromBase));
}
