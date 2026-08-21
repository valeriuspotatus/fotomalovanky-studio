import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState, isHandled, markHandled, statePath, handledDisposition } from '../src/autopilotState.js';

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

test('a corrupt state file degrades to a clean slate rather than throwing', () => {
  const dir = tmp();
  try {
    writeFileSync(statePath(dir), '{ this is not json');
    assert.deepEqual(loadState(dir), { handled: {}, cursor: null, lastRunAt: null });
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

test('handled revisions distinguish same, meaningful, harmless metadata, and legacy state', () => {
  const state = { handled: {}, cursor: null, lastRunAt: null };
  markHandled(state, '1600', { status: 'ready', updatedAt: 'old', fingerprint: 'sha256:aaa', at: 'now' });
  assert.equal(handledDisposition(state, '1600', 'sha256:aaa'), 'same');
  assert.equal(handledDisposition(state, '1600', 'sha256:bbb'), 'changed');
  assert.equal(handledDisposition(state, '1600', null), 'same');
  state.handled['1599'] = { status: 'ready', at: 'before-revisions' };
  assert.equal(handledDisposition(state, '1599', 'sha256:new'), 'legacy');
  assert.equal(isHandled(state, '1599'), true);
  assert.equal(state.handled['1600'].updatedAt, 'old');
});
