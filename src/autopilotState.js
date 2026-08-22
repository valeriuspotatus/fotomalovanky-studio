// The autopilot's persisted memory: which orders it has already carried all the way to a built book,
// and how far the poll cursor has advanced. Lives in the outside-repo data dir (config.shopify.dataDir)
// so a 15-minute poll never re-pulls a finished order and no cursor/PII is ever committable (KTD4).
//
// Only TERMINAL orders (their PDF is built — status `ready`) land in the handled set. Held and failed
// orders are deliberately left OUT so the next poll re-pulls them: that is what lets a customer's
// re-upload lift an intake hold overnight, unattended (KTD8). Missing state starts clean, but corrupt
// durable state fails closed: forgetting a handled order could replay completed work.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const STATE_FILE = 'autopilot-state.json';

/** The single fixed state path under the data dir. */
export const statePath = (dataDir) => join(dataDir, STATE_FILE);

const empty = () => ({ handled: {}, cursor: null, lastRunAt: null });

/** Read persisted state. Missing is a legitimate first run; malformed durable truth is not. */
export function loadState(dataDir) {
  const path = statePath(dataDir);
  if (!existsSync(path)) return empty();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || (parsed.handled !== undefined && (typeof parsed.handled !== 'object' || parsed.handled === null || Array.isArray(parsed.handled)))
      || Object.values(parsed.handled ?? {}).some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))
      || (parsed.cursor != null && typeof parsed.cursor !== 'string')
      || (parsed.lastRunAt != null && typeof parsed.lastRunAt !== 'string')) {
      throw new Error('invalid structure');
    }
    return {
      handled: parsed.handled ?? {},
      cursor: parsed.cursor ?? null,
      lastRunAt: parsed.lastRunAt ?? null,
    };
  } catch (error) {
    throw new Error(`Autopilot state at ${path} is corrupt; reconcile it before restarting`, { cause: error });
  }
}

/** Persist the state, creating the (outside-repo) data dir if needed. */
export function saveState(dataDir, state) {
  mkdirSync(dataDir, { recursive: true });
  const path = statePath(dataDir);
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(state, null, 2));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

/** True once an order has been carried to a built book and should never re-run. Held/failed orders
 *  are never recorded here, so this is false for them and they stay re-pollable (KTD8). */
export function isHandled(state, orderId) {
  return Boolean(state.handled?.[orderId]);
}

/** Record an order that reached its terminal state (PDF built). Advances the cursor to the latest
 *  `updatedAt` fully handled — a lower bound and an observability signal, not the poll's only filter
 *  (the sliding window + this handled set together do the dedup). Mutates and returns `state`. */
export function markHandled(state, orderId, { status = 'ready', updatedAt = null, at = null } = {}) {
  state.handled[orderId] = { status, at };
  if (updatedAt && (!state.cursor || updatedAt > state.cursor)) state.cursor = updatedAt;
  return state;
}
