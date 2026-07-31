import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewServer } from '../src/ui/server.js';
import { hashPassword, ROLE_ENV_VARS } from '../src/auth/credentials.js';
import { DEFAULT_USERNAMES } from '../src/auth/accounts.js';
import { SESSION_COOKIE, parseCookies } from '../src/auth/sessions.js';
import { SignInBusyError, createSignInThrottle, isSameOrigin } from '../src/auth/throttle.js';

// Sign-in hardening: what guessing costs, and what a flood of guesses costs the box.
//
// The concurrency cap is the one to read first. Each scrypt call at the production cost allocates
// ~128 MiB on a box with ~2 GB shared with headless Chromium, and Node runs scrypt on the libuv
// threadpool, so unbounded concurrent attempts exhaust memory AND starve every filesystem operation
// in the studio. A per-username throttle does not bound that at all — the attacker rotates the
// username and never accumulates a counter — which is why the tests below attack with a fresh
// username every time.

const PASSWORD = 'correct horse battery staple';
const cheapHash = (password) => hashPassword(password, { logN: 14, r: 8, p: 1 });

let root, config, hash, servers;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'fma-thr-'));
  mkdirSync(join(root, 'inbox'), { recursive: true });
  mkdirSync(join(root, 'outbox'), { recursive: true });
  config = {
    generator: { baseUrl: 'https://example.test/tok', mode: 'api', variant: '2509_1.5', diffusionSteps: 8 },
    builder: { baseUrl: 'https://example.test/builder' },
    paths: { inbox: join(root, 'inbox'), outbox: join(root, 'outbox') },
    accounts: { dataDir: join(root, 'accounts') },
  };
  hash = await cheapHash(PASSWORD);
  servers = [];
});

after(() => {
  for (const s of servers) s.close();
  rmSync(root, { recursive: true, force: true });
});

async function serve({ authEnv, signInThrottle, log } = {}) {
  const { server } = createReviewServer({
    config,
    inboxRoot: config.paths.inbox,
    outboxRoot: config.paths.outbox,
    memoryRoot: join(root, 'memory'),
    driver: { generate: async () => {} },
    authEnv: authEnv ?? { [ROLE_ENV_VARS.operator]: hash, [ROLE_ENV_VARS.printer]: hash },
    ...(signInThrottle ? { signInThrottle } : {}),
    ...(log ? { log } : {}),
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

const postLogin = (origin, body, headers = {}) =>
  fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
    body: JSON.stringify(body),
  });

// --- per-username backoff (KTD5) -------------------------------------------------------------------

test('AE11 — consecutive failures for one username buy growing delays, and a lock is never taken', async () => {
  const slept = [];
  const throttle = createSignInThrottle({ floorMs: 0, failuresBeforeBackoff: 3, backoffBaseMs: 250, sleep: async (ms) => void slept.push(ms) });

  for (let i = 0; i < 6; i++) await throttle.run('David', async () => false);
  assert.deepEqual(slept, [250, 500, 1000], 'three free attempts, then the delay doubles per failure');

  // And the correct password still works, with no intervention and no unlocking step — a hard lock
  // on a two-account app with no self-service recovery is a denial of service an attacker triggers
  // on purpose by guessing wrong.
  assert.equal(await throttle.run('David', async () => true), true, 'the right password still gets in');
  assert.equal(throttle.failureCount('David'), 0, 'and success clears the counter');
  assert.equal(throttle.delayFor('David'), 0, 'so the next attempt is not delayed at all');
});

test('the backoff is capped, so nobody is ever locked out for good', () => {
  const throttle = createSignInThrottle({ backoffMaxMs: 30_000, backoffBaseMs: 250, failuresBeforeBackoff: 3 });
  const many = createSignInThrottle({ backoffMaxMs: 30_000 });
  assert.equal(throttle.delayFor('nobody'), 0);
  assert.equal(many.delayFor('nobody'), 0, 'an unknown username starts clean');

  const t = createSignInThrottle({ floorMs: 0, sleep: async () => {}, failuresBeforeBackoff: 3, backoffBaseMs: 250, backoffMaxMs: 2000 });
  return (async () => {
    for (let i = 0; i < 20; i++) await t.run('David', async () => false);
    assert.equal(t.delayFor('David'), 2000, 'the delay stops growing at the cap');
  })();
});

test("failures against one username do not delay the other person's sign-in", async () => {
  const throttle = createSignInThrottle({ floorMs: 0, sleep: async () => {} });
  for (let i = 0; i < 5; i++) await throttle.run('David', async () => false);
  assert.ok(throttle.delayFor('David') > 0, 'David is being slowed');
  assert.equal(throttle.delayFor('Jirka'), 0, 'Jirka is not — the counter is per username');
  assert.equal(throttle.delayFor(' david '), throttle.delayFor('David'), 'and the same person however they type it');
});

// --- the duration floor ----------------------------------------------------------------------------

test('every attempt takes at least the floor, whatever the outcome', async () => {
  const throttle = createSignInThrottle({ floorMs: 120 });

  const t0 = Date.now();
  await throttle.run('David', async () => true);
  assert.ok(Date.now() - t0 >= 110, `a successful attempt is not fast (${Date.now() - t0}ms)`);

  const t1 = Date.now();
  await throttle.run('Mallory', async () => false);
  assert.ok(Date.now() - t1 >= 110, `and neither is a failed one (${Date.now() - t1}ms)`);
});

// --- THE CONCURRENCY CAP ---------------------------------------------------------------------------

test('the global cap bounds in-flight derivations, and the excess is refused rather than queued', async () => {
  const throttle = createSignInThrottle({ floorMs: 0, maxConcurrent: 2, maxQueue: 3 });

  let release;
  const parked = new Promise((r) => (release = r));
  let concurrent = 0;
  let observedPeak = 0;
  const verify = async () => {
    concurrent += 1;
    observedPeak = Math.max(observedPeak, concurrent);
    await parked;
    concurrent -= 1;
    return false;
  };

  // Ten attempts, ten different usernames — exactly the shape a per-username throttle cannot see.
  const attempts = Array.from({ length: 10 }, (_, i) =>
    throttle.run(`guess-${i}`, verify).then(
      () => 'answered',
      (err) => (err instanceof SignInBusyError ? 'refused' : `error:${err.message}`),
    ),
  );

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(throttle.stats().inFlight, 2, 'only two derivations are in flight');
  assert.equal(observedPeak, 2, 'and only two ever ran at once');
  assert.equal(throttle.stats().waiting, 3, 'three wait in the bounded queue');

  release();
  const results = await Promise.all(attempts);
  assert.equal(results.filter((r) => r === 'refused').length, 5, 'the five past cap+queue are refused, not queued');
  assert.equal(results.filter((r) => r === 'answered').length, 5, 'the five within it are answered');
  assert.equal(observedPeak, 2, 'the cap held for the whole run');
  assert.equal(throttle.stats().peakInFlight, 2, 'as the throttle itself observed');
});

test('a capped-out refusal is not faster than a real attempt, so the cap is not observable', async () => {
  const throttle = createSignInThrottle({ floorMs: 120, maxConcurrent: 1, maxQueue: 0 });
  let release;
  const parked = new Promise((r) => (release = r));
  const held = throttle.run('holder', async () => {
    await parked;
    return false;
  });

  await new Promise((r) => setTimeout(r, 5));
  const t0 = Date.now();
  await assert.rejects(throttle.run('someone-else', async () => true), SignInBusyError, 'the attempt never reached scrypt');
  assert.ok(Date.now() - t0 >= 110, `and still cost the floor (${Date.now() - t0}ms)`);

  release();
  await held;
});

test('N concurrent sign-in POSTs: the excess is refused with 429, and none of them hang', async () => {
  const throttle = createSignInThrottle({ floorMs: 5, maxConcurrent: 1, maxQueue: 1 });
  const origin = await serve({ signInThrottle: throttle });

  // Eight at once, each with a username nobody has — the per-username counter never accumulates.
  const responses = await Promise.all(
    Array.from({ length: 8 }, (_, i) => postLogin(origin, { username: `guess-${i}`, password: 'nope' })),
  );
  const codes = responses.map((r) => r.status);
  const refused = codes.filter((c) => c === 429).length;
  const reached = codes.filter((c) => c === 401).length;

  assert.equal(refused + reached, 8, `every request got an answer (${codes.join(',')})`);
  assert.ok(refused >= 1, `the excess is refused rather than queued unbounded (${codes.join(',')})`);
  assert.ok(reached <= 2, `at most cap+queue reached the derivation (${reached})`);
  assert.equal(responses.find((r) => r.status === 429).headers.get('retry-after'), '1', 'and is told to come back');
});

// --- same-origin on mutating requests (KTD4) --------------------------------------------------------

test('isSameOrigin: mismatches are refused, GETs are untouched, and a header-less client is left alone', () => {
  const req = (method, headers) => ({ method, headers });
  assert.equal(isSameOrigin(req('POST', { host: 'studio.test', origin: 'https://studio.test' })), true, 'own origin');
  assert.equal(isSameOrigin(req('POST', { host: 'studio.test', origin: 'https://evil.test' })), false, 'foreign origin');
  assert.equal(isSameOrigin(req('POST', { host: 'studio.test', referer: 'https://studio.test/review' })), true, 'Referer fallback');
  assert.equal(isSameOrigin(req('POST', { host: 'studio.test', referer: 'https://evil.test/x' })), false, 'foreign Referer');
  assert.equal(isSameOrigin(req('POST', { host: 'studio.test', origin: 'null' })), false, 'an opaque origin proves nothing');
  assert.equal(isSameOrigin(req('POST', { host: 'studio.test', origin: 'not a url' })), false, 'an unparseable header proves nothing');
  assert.equal(isSameOrigin(req('DELETE', { host: 'studio.test', origin: 'https://evil.test' })), false, 'DELETE is mutating');
  assert.equal(isSameOrigin(req('PUT', { host: 'studio.test', origin: 'https://evil.test' })), false, 'so is PUT');
  assert.equal(isSameOrigin(req('GET', { host: 'studio.test', origin: 'https://evil.test' })), true, 'a GET is unaffected');

  // No Origin and no Referer is curl, the launcher, or this test suite — never the forged case, as a
  // browser always attaches Origin to a cross-site POST.
  assert.equal(isSameOrigin(req('POST', { host: 'studio.test' })), true, 'a header-less client still works');
});

test('over HTTP: a foreign Origin is refused before anything else happens; our own is not', async () => {
  // Run this one ungated so the check is observed on its own, with no scrypt in the way. The sign-in
  // POST is mutating AND pre-gate, which is exactly why the origin check sits ahead of the gate.
  const origin = await serve({ authEnv: {} });

  const foreign = await postLogin(origin, { username: 'David', password: 'x' }, { Origin: 'https://evil.test' });
  assert.equal(foreign.status, 403, 'a cross-site POST is refused');

  const ours = await postLogin(origin, { username: 'David', password: 'x' });
  assert.notEqual(ours.status, 403, 'the same request from our own origin passes the check');

  const viaReferer = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: `${origin}/login` },
    body: JSON.stringify({ username: 'David', password: 'x' }),
  });
  assert.notEqual(viaReferer.status, 403, 'no Origin but a same-host Referer is accepted');

  const get = await fetch(`${origin}/api/state`, { headers: { Origin: 'https://evil.test' } });
  assert.equal(get.status, 200, 'a GET is unaffected by the origin check');
});

// --- the log line ------------------------------------------------------------------------------------

test('every sign-in attempt is logged — outcome, username, timestamp, and no credential material', async () => {
  const lines = [];
  const origin = await serve({ log: (m) => lines.push(m) });

  const bad = await postLogin(origin, { username: DEFAULT_USERNAMES.operator, password: 'wrong password' });
  assert.equal(bad.status, 401);
  const good = await postLogin(origin, { username: DEFAULT_USERNAMES.operator, password: PASSWORD });
  assert.equal(good.status, 200);
  const token = parseCookies(good.headers.get('set-cookie').split(';')[0])[SESSION_COOKIE];

  const signIn = lines.filter((l) => l.startsWith('sign-in '));
  assert.equal(signIn.length, 2, 'both attempts were logged');
  assert.match(signIn[0], /^sign-in failed for "David" at \d{4}-\d{2}-\d{2}T[\d:.]+Z$/, 'outcome, username, timestamp');
  assert.match(signIn[1], /^sign-in ok for "David" at \d{4}-\d{2}-\d{2}T[\d:.]+Z — role operator$/);

  // The whole point of the assertion: nothing credential-shaped is ever in the log.
  const all = lines.join('\n');
  assert.doesNotMatch(all, /wrong password/, 'the attempted password is never logged');
  assert.ok(!all.includes(PASSWORD), 'nor the real one');
  assert.ok(!all.includes(hash), 'nor the stored hash');
  assert.ok(!all.includes('scrypt$'), 'nor any part of it');
  assert.ok(token && !all.includes(token), 'nor the session token it just minted');
});
