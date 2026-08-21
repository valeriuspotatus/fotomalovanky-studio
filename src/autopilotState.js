// The autopilot's persisted memory: which orders it has already carried all the way to a built book,
// and how far the poll cursor has advanced. Lives in the outside-repo data dir (config.shopify.dataDir)
// so a 15-minute poll never re-pulls a finished order and no cursor/PII is ever committable (KTD4).
//
// Only TERMINAL orders (their PDF is built — status `ready`) land in the handled set. Held and failed
// orders are deliberately left OUT so the next poll re-pulls them: that is what lets a customer's
// re-upload lift an intake hold overnight, unattended (KTD8). A lost or corrupt state file degrades to
// "start clean" — the pipeline's own force:false caching means already-built PDFs are not re-generated,
// so the blast radius of a state loss is a re-download, never a re-spend.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE_FILE = 'autopilot-state.json';

/** The single fixed state path under the data dir. */
export const statePath = (dataDir) => join(dataDir, STATE_FILE);

const empty = () => ({ handled: {}, cursor: null, lastRunAt: null });

/** Read the persisted state, or a clean slate when there is none / it is unreadable. Never throws —
 *  a half-written file must not abort the night. */
export function loadState(dataDir) {
  const path = statePath(dataDir);
  if (!existsSync(path)) return empty();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty();
    return {
      handled: parsed.handled && typeof parsed.handled === 'object' && !Array.isArray(parsed.handled) ? parsed.handled : {},
      cursor: typeof parsed.cursor === 'string' ? parsed.cursor : null,
      lastRunAt: typeof parsed.lastRunAt === 'string' ? parsed.lastRunAt : null,
    };
  } catch {
    return empty();
  }
}

/** Persist the state, creating the (outside-repo) data dir if needed. */
export function saveState(dataDir, state) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(statePath(dataDir), JSON.stringify(state, null, 2));
}

/** True once an order has been carried to a built book and should never re-run. Held/failed orders
 *  are never recorded here, so this is false for them and they stay re-pollable (KTD8). */
export function isHandled(state, orderId) {
  return Boolean(state.handled?.[orderId]);
}

export function handledDisposition(state, orderId, fingerprint = null) {
  const entry = state.handled?.[orderId];
  if (!entry) return 'unhandled';
  if (!entry.fingerprint) return 'legacy';
  if (!fingerprint || entry.fingerprint === fingerprint) return 'same';
  return 'changed';
}

/** Record an order that reached its terminal state (PDF built). Advances the cursor to the latest
 *  `updatedAt` fully handled — a lower bound and an observability signal, not the poll's only filter
 *  (the sliding window + this handled set together do the dedup). Mutates and returns `state`. */
export function markHandled(state, orderId, { status = 'ready', updatedAt = null, fingerprint = null, at = null } = {}) {
  state.handled[orderId] = { status, at, ...(fingerprint ? { fingerprint } : {}), ...(updatedAt ? { updatedAt } : {}) };
  if (updatedAt && (!state.cursor || updatedAt > state.cursor)) state.cursor = updatedAt;
  return state;
}
