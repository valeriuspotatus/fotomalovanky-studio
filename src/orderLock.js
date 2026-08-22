import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const SAFE_ORDER_ID = /^\d+(?:-\d+)*$/;

export class OrderLockedError extends Error {
  constructor(orderId, lockPath) {
    super(`Order ${orderId} is already being changed by another process. Retry after that work finishes.`);
    this.name = 'OrderLockedError';
    this.code = 'ORDER_LOCKED';
    this.orderId = orderId;
    this.lockPath = lockPath;
  }
}

export function assertSafeOrderId(orderId) {
  if (!SAFE_ORDER_ID.test(String(orderId ?? ''))) throw new Error(`A safe order id is required: ${JSON.stringify(orderId)}`);
  return String(orderId);
}

export function isOrderLockHeld({ inboxRoot, orderId }) {
  const path = join(resolve(inboxRoot, '.fotomalovanky-order-locks'), assertSafeOrderId(orderId));
  try {
    const pid = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')).pid;
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try { process.kill(pid, 0); return true; }
    catch (err) { return err?.code !== 'ESRCH'; }
  } catch { return existsSync(path); }
}

export function acquireOrderLock({ inboxRoot, orderId, operation = 'order mutation' }) {
  const safeId = assertSafeOrderId(orderId);
  const root = resolve(inboxRoot, '.fotomalovanky-order-locks');
  const lockPath = resolve(root, safeId);
  const token = randomUUID();
  const rel = relative(root, lockPath);
  if (!rel || rel.startsWith('..') || rel.includes(':')) throw new Error('Order lock must stay inside the lock root');
  mkdirSync(root, { recursive: true });
  try { mkdirSync(lockPath); }
  catch (err) {
    if (err?.code === 'EEXIST') {
      let stale = false;
      try {
        const pid = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')).pid;
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (probe) { stale = probe?.code === 'ESRCH'; }
        }
      } catch {}
      // ponytail: PID liveness is for this single-host operator install; use a distributed lease if the inbox becomes multi-host.
      if (stale) {
        const tombstone = `${lockPath}.stale-${token}`;
        try { renameSync(lockPath, tombstone); }
        catch { throw new OrderLockedError(safeId, lockPath); }
        try { mkdirSync(lockPath); }
        catch { rmSync(tombstone, { recursive: true, force: true }); throw new OrderLockedError(safeId, lockPath); }
        rmSync(tombstone, { recursive: true, force: true });
      } else throw new OrderLockedError(safeId, lockPath);
    } else throw err;
  }
  try {
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, token, operation, acquiredAt: new Date().toISOString() }, null, 2));
  } catch (err) {
    rmSync(lockPath, { recursive: true, force: true });
    throw err;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')).token === token) rmSync(lockPath, { recursive: true, force: true });
    } catch {}
  };
}
