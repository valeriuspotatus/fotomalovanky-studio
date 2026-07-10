// What the operator taught the tool about spelling.
//
// The shop strips diacritics from the file name before we ever see it: "Pro Jiříčka" arrives as
// "pro_jiricka". Nothing in the file says whether that is Jiříčka, Jiřička or Jiricka, so the
// tool cannot guess — not on a page that gets printed and posted to the customer.
//
// So it learns instead. The operator corrects the title once; the correction is filed under the
// slug, and the next order for the same name is spelled right without anyone retyping it.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Beside the orders, not inside one: an order folder is handed to the builder, and it is also
 *  the thing the operator drags to the archive when a book is posted. */
export const dedicationsPath = (outboxRoot) => join(outboxRoot, '.dedications.json');

/** Every remembered spelling, as `{ slug: text }`. A missing or corrupt file is not an error —
 *  it only means nothing has been taught yet, and the operator types the name as they always did. */
export function readDedications(outboxRoot) {
  const file = dedicationsPath(outboxRoot);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([slug, text]) => typeof slug === 'string' && typeof text === 'string'),
    );
  } catch {
    return {}; // a half-written file must not stop the operator from printing a book
  }
}

/** The spelling remembered for this slug, or '' when it is new. */
export function recallDedication(outboxRoot, slug) {
  if (!slug) return '';
  return readDedications(outboxRoot)[slug] ?? '';
}

/** Remember what the operator typed for this slug. Teaching the same spelling twice is a no-op;
 *  teaching a new one overwrites, because the newest correction is the one they meant.
 *
 *  An empty text is a deliberate "this book has no title", which is about *this order*, not about
 *  how the name is spelled — so it forgets the slug rather than remembering an empty title for
 *  every future customer with that name. */
export function learnDedication(outboxRoot, slug, text) {
  if (!slug) return readDedications(outboxRoot);

  const all = readDedications(outboxRoot);
  const value = String(text ?? '').trim();
  if (value) {
    if (all[slug] === value) return all;
    all[slug] = value;
  } else {
    if (!(slug in all)) return all;
    delete all[slug];
  }

  const file = dedicationsPath(outboxRoot);
  mkdirSync(dirname(file), { recursive: true });
  // Write beside it and rename: a crash mid-write would otherwise leave a truncated file, and
  // every spelling the operator ever taught would be gone.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
  renameSync(tmp, file);
  return all;
}
