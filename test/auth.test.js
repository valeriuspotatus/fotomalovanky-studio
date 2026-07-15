import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAuth } from '../src/ui/server.js';

const basic = (u, p) => ({ headers: { authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') } });
const withGate = (fn) => {
  const { STUDIO_USER, STUDIO_PASS } = process.env;
  process.env.STUDIO_USER = 'david';
  process.env.STUDIO_PASS = 's3cret';
  try {
    fn();
  } finally {
    if (STUDIO_USER === undefined) delete process.env.STUDIO_USER;
    else process.env.STUDIO_USER = STUDIO_USER;
    if (STUDIO_PASS === undefined) delete process.env.STUDIO_PASS;
    else process.env.STUDIO_PASS = STUDIO_PASS;
  }
};

test('no gate configured → every request passes (local runs unchanged)', () => {
  const { STUDIO_USER, STUDIO_PASS } = process.env;
  delete process.env.STUDIO_USER;
  delete process.env.STUDIO_PASS;
  try {
    assert.equal(checkAuth({ headers: {} }), true);
  } finally {
    if (STUDIO_USER !== undefined) process.env.STUDIO_USER = STUDIO_USER;
    if (STUDIO_PASS !== undefined) process.env.STUDIO_PASS = STUDIO_PASS;
  }
});

test('gate on: correct credentials pass, everything else is rejected', () => {
  withGate(() => {
    assert.equal(checkAuth(basic('david', 's3cret')), true);
    assert.equal(checkAuth({ headers: {} }), false, 'no header');
    assert.equal(checkAuth(basic('david', 'wrong')), false, 'wrong password');
    assert.equal(checkAuth(basic('mallory', 's3cret')), false, 'wrong user');
    assert.equal(checkAuth({ headers: { authorization: 'Bearer x' } }), false, 'wrong scheme');
    assert.equal(checkAuth({ headers: { authorization: 'Basic !!notbase64' } }), false, 'garbage');
  });
});
