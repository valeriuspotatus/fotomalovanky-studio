import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState, isHandled, markHandled, statePath } from '../src/autopilotState.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'fma-state-'));

test('a data dir with no state file loads a clean slate, not an error', () => {
  const dir = tmp();
  try {
    const s = loadState(dir);
    assert.deepEqual(s, { handled: {}, cursor: null, lastRunAt: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveState then loadState round-trips the handled set, cursor and lastRunAt', () => {
  const dir = tmp();
  try {
    const s = { handled: { 1524: { status: 'ready', at: 'x' } }, cursor: '2026-07-12T01:00:00Z', lastRunAt: '2026-07-12T06:00:00Z' };
    saveState(dir, s);
    assert.deepEqual(loadState(dir), s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markHandled records a terminal order and advances the cursor to the latest updatedAt', () => {
  const s = loadState(tmp()); // clean slate on a throwaway dir
  markHandled(s, '1524', { status: 'ready', updatedAt: '2026-07-12T01:00:00Z', at: 'now' });
  markHandled(s, '1526', { status: 'ready', updatedAt: '2026-07-12T03:00:00Z', at: 'now' });
  markHandled(s, '1525', { status: 'ready', updatedAt: '2026-07-12T02:00:00Z', at: 'now' });
  assert.ok(isHandled(s, '1524') && isHandled(s, '1525') && isHandled(s, '1526'));
  assert.equal(s.cursor, '2026-07-12T03:00:00Z', 'cursor holds the newest updatedAt, not the last written');
  assert.equal(isHandled(s, '9999'), false, 'an unseen order is not handled');
});

test('a corrupt state file fails closed instead of replaying handled orders', () => {
  const dir = tmp();
  try {
    writeFileSync(statePath(dir), '{ this is not json');
    assert.throws(() => loadState(dir), /autopilot state/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid handled state fails closed and successful saves leave no temporary file', () => {
  const dir = tmp();
  try {
    writeFileSync(statePath(dir), JSON.stringify({ handled: [], cursor: null, lastRunAt: null }));
    assert.throws(() => loadState(dir), /autopilot state/i);
    saveState(dir, { handled: { 1524: { status: 'ready' } }, cursor: null, lastRunAt: null });
    assert.equal(isHandled(loadState(dir), '1524'), true);
    assert.deepEqual(readdirSync(dir), ['autopilot-state.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid handled entries fail closed instead of replaying that order', () => {
  const dir = tmp();
  try {
    for (const entry of [null, false, []]) {
      writeFileSync(statePath(dir), JSON.stringify({ handled: { 1524: entry }, cursor: null, lastRunAt: null }));
      assert.throws(() => loadState(dir), /autopilot state/i);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale temporary artifact cannot replace the last valid canonical state', () => {
  const dir = tmp();
  try {
    const valid = { handled: { 1524: { status: 'ready' } }, cursor: null, lastRunAt: null };
    saveState(dir, valid);
    writeFileSync(`${statePath(dir)}.tmp-crashed-writer`, '{ partial');
    assert.deepEqual(loadState(dir), valid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only what is passed to markHandled is handled — held/failed are never recorded by the store', () => {
  // The store is a dumb ledger; keeping held/failed re-pollable (KTD8) is the runner's job, which
  // simply never calls markHandled for them. Prove the store adds nothing on its own.
  const s = loadState(tmp());
  markHandled(s, '1600', { status: 'ready', at: 'now' });
  assert.deepEqual(Object.keys(s.handled), ['1600']);
});
