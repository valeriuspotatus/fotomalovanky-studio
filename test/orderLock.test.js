import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { acquireOrderLock, OrderLockedError } from '../src/orderLock.js';

test('the order lock is atomic across separate Node processes', async () => {
  const base = mkdtempSync(join(tmpdir(), 'fma-lock-process-'));
  const inbox = join(base, 'inbox');
  const moduleUrl = new URL('../src/orderLock.js', import.meta.url).href;
  const script = `import { acquireOrderLock } from ${JSON.stringify(moduleUrl)}; const release=acquireOrderLock({inboxRoot:process.argv[1],orderId:'9001',operation:'child'}); process.stdout.write('ready\\n'); process.stdin.once('data',()=>{release();process.exit(0)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, inbox], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
      child.once('exit', (code) => { if (code) reject(new Error(`lock child exited ${code}`)); });
    });
    assert.throws(
      () => acquireOrderLock({ inboxRoot: inbox, orderId: '9001', operation: 'parent' }),
      (err) => err instanceof OrderLockedError && !err.message.includes(base) && err.lockPath.includes(base),
    );
    const release = acquireOrderLock({ inboxRoot: inbox, orderId: '9002', operation: 'parent' });
    release();
  } finally {
    child.stdin.write('release');
    await new Promise((resolve) => child.once('exit', resolve));
    rmSync(base, { recursive: true, force: true });
  }
});
