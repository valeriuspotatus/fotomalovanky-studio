import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

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

function orderLockRoot(inboxRoot) {
  return join(resolve(inboxRoot), '.fotomalovanky-order-locks');
}

export function acquireOrderLock({ inboxRoot, orderId, operation = 'order mutation' }) {
  const safeId = assertSafeOrderId(orderId);
  const root = resolve(orderLockRoot(inboxRoot));
  const lockPath = resolve(root, safeId);
  const rel = relative(root, lockPath);
  if (!rel || rel.startsWith('..') || rel.includes(':')) throw new Error('Order lock must stay inside the lock root');
  mkdirSync(root, { recursive: true });
  try {
    mkdirSync(lockPath);
  } catch (err) {
    if (err?.code === 'EEXIST') throw new OrderLockedError(safeId, lockPath);
    throw err;
  }
  try {
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, operation, acquiredAt: new Date().toISOString() }, null, 2));
  } catch (err) {
    rmSync(lockPath, { recursive: true, force: true });
    throw err;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(lockPath, { recursive: true, force: true });
  };
}
