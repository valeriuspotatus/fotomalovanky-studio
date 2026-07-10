// What the operator taught the tool about spelling.
//
// The shop strips diacritics from the file name before we ever see it: "Pro Jiříčka" arrives as
// "pro_jiricka". Nothing in the file says whether that is Jiříčka, Jiřička or Jiricka, so the
// tool cannot guess — not on a page that gets printed and posted to the customer.
//
// So it learns instead. The operator corrects the title once; the correction is filed under the
// slug, and the next order for the same name is spelled right without anyone retyping it.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Beside config.json, in the tool's own folder.
 *
 *  Not in the outbox. The outbox is where finished books pile up until they are dragged to the
 *  archive, and the day it is emptied every spelling the operator ever taught would go with it —
 *  silently, and only noticed months later by a customer whose name is printed wrong. */
export const MEMORY_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** A plain, visible file: the operator can open it and fix a spelling by hand. */
export const dedicationsPath = (root = MEMORY_DIR) => join(root, 'dedications.json');

/** Where it used to live, so an existing memory is carried across rather than abandoned. */
const legacyPath = (outboxRoot) => join(outboxRoot, '.dedications.json');

/** Every remembered spelling, as `{ slug: text }`. A missing or corrupt file is not an error —
 *  it only means nothing has been taught yet, and the operator types the name as they always did. */
export function readDedications(root = MEMORY_DIR) {
  const file = dedicationsPath(root);
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
export function recallDedication(root, slug) {
  if (!slug) return '';
  return readDedications(root)[slug] ?? '';
}

/** Remember what the operator typed for this slug. Teaching the same spelling twice is a no-op;
 *  teaching a new one overwrites, because the newest correction is the one they meant.
 *
 *  An empty text is a deliberate "this book has no title", which is about *this order*, not about
 *  how the name is spelled — so it forgets the slug rather than remembering an empty title for
 *  every future customer with that name. */
export function learnDedication(root, slug, text) {
  if (!slug) return readDedications(root);

  const all = readDedications(root);
  const value = String(text ?? '').trim();
  if (value) {
    if (all[slug] === value) return all;
    all[slug] = value;
  } else {
    if (!(slug in all)) return all;
    delete all[slug];
  }

  writeDedications(root, all);
  return all;
}

function writeDedications(root = MEMORY_DIR, all) {
  const file = dedicationsPath(root);
  mkdirSync(dirname(file), { recursive: true });
  // Write beside it and rename: a crash mid-write would otherwise leave a truncated file, and
  // every spelling the operator ever taught would be gone.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Carry an older memory out of the outbox, where it used to be kept, into the tool's own folder.
 *  Returns the slugs moved, or [] when there was nothing to move.
 *
 *  Anything already taught in the new place wins: it is the newer answer. */
export function migrateDedications(outboxRoot, root = MEMORY_DIR) {
  const old = legacyPath(outboxRoot);
  if (!existsSync(old)) return [];

  let legacy = {};
  try {
    const parsed = JSON.parse(readFileSync(old, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      legacy = Object.fromEntries(
        Object.entries(parsed).filter(([slug, text]) => typeof slug === 'string' && typeof text === 'string'),
      );
    }
  } catch {
    legacy = {}; // an unreadable old file is not worth refusing to start over
  }

  const current = readDedications(root);
  const moved = Object.keys(legacy).filter((slug) => !(slug in current));
  if (moved.length) writeDedications(root, { ...legacy, ...current });

  rmSync(old, { force: true }); // one home, so the next correction cannot land in the wrong one
  return moved;
}
