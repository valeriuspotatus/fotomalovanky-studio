import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { acquireOrderLock, OrderLockedError } from '../src/orderLock.js';

test('the same order cannot be mutated by two processes at once', () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-lock-'));
  const release = acquireOrderLock({ inboxRoot: root, orderId: '9001' });
  try {
    assert.throws(() => acquireOrderLock({ inboxRoot: root, orderId: '9001' }), OrderLockedError);
  } finally {
    release();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the order lock is atomic across separate Node processes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-lock-process-'));
  const moduleUrl = new URL('../src/orderLock.js', import.meta.url).href;
  const script = `import { acquireOrderLock } from ${JSON.stringify(moduleUrl)}; const release=acquireOrderLock({inboxRoot:process.argv[1],orderId:'9001'}); process.stdout.write('ready\\n'); process.stdin.once('data',()=>{release();process.exit(0)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, root], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    assert.throws(() => acquireOrderLock({ inboxRoot: root, orderId: '9001' }), OrderLockedError);
  } finally {
    child.stdin.write('release');
    await new Promise((resolve) => child.once('exit', resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('unsafe ids cannot choose a lock path', () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-lock-'));
  try {
    assert.throws(() => acquireOrderLock({ inboxRoot: root, orderId: '../escape' }), /safe order id/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a lock left by a crashed local process is recovered', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-lock-crash-'));
  const moduleUrl = new URL('../src/orderLock.js', import.meta.url).href;
  const script = `import { acquireOrderLock } from ${JSON.stringify(moduleUrl)}; acquireOrderLock({inboxRoot:process.argv[1],orderId:'9001'}); process.stdout.write('ready\\n'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, root], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    const release = acquireOrderLock({ inboxRoot: root, orderId: '9001' });
    release();
  } finally { child.kill(); rmSync(root, { recursive: true, force: true }); }
});
