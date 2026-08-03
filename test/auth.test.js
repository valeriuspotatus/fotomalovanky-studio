import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewServer } from '../src/ui/server.js';
import { hashPassword, ROLE_ENV_VARS } from '../src/auth/credentials.js';
import { AUTH_MODES, AuthConfigError, isLoopbackHost, resolveAuthMode } from '../src/auth/sessions.js';

// The request gate, and above all the guard on its fail-open path.
//
// The old `checkAuth` returned true when no credentials were set. That is right for the desktop
// workflow and catastrophic on a public URL, and the three configurations below are the three ways
// that decision can be reached — every one of them is asserted here rather than reasoned about:
//
//   no hashes  + loopback bind     -> serve the board ungated (the laptop; AE1)
//   no hashes  + non-loopback bind -> refuse to start at all (the forgotten Render env)
//   one hash   + one missing       -> refuse every request but /healthz (the typo)
//
// Credentials are injected as an `authEnv` object rather than mutated onto process.env wherever
// possible, so two servers in one file cannot see each other's environment. The one test that does
// use process.env saves and restores it, and proves the default really is process.env.

const CONFIG_BASE = {
  generator: { baseUrl: 'https://example.test/tok', mode: 'api', variant: '2509_1.5', diffusionSteps: 8 },
  builder: { baseUrl: 'https://example.test/builder' },
};

/** A real scrypt hash at a deliberately cheap cost. The stored string is self-describing, so a
 *  logN=14 hash verifies through exactly the production code path — credentials.test.js is where the
 *  production parameters are exercised, and paying a second per sign-in here would buy nothing. */
const cheapHash = (password) => hashPassword(password, { logN: 14, r: 8, p: 1 });

let root, config, hash, servers;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'fma-auth-'));
  mkdirSync(join(root, 'inbox'), { recursive: true });
  mkdirSync(join(root, 'outbox'), { recursive: true });
  config = { ...CONFIG_BASE, paths: { inbox: join(root, 'inbox'), outbox: join(root, 'outbox') }, accounts: { dataDir: join(root, 'accounts') } };
  hash = await cheapHash('correct horse battery staple');
  servers = [];
});

after(() => {
  for (const s of servers) s.close();
  rmSync(root, { recursive: true, force: true });
});

/** A listening server on loopback plus its origin. Every test gets its own, with its own auth env. */
async function serve(authEnv) {
  const { server } = createReviewServer({
    config,
    inboxRoot: config.paths.inbox,
    outboxRoot: config.paths.outbox,
    memoryRoot: join(root, 'memory'),
    driver: { generate: async () => {} },
    authEnv,
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

const bothRoles = () => ({ [ROLE_ENV_VARS.operator]: hash, [ROLE_ENV_VARS.printer]: hash });

test('resolveAuthMode: no hash is ungated, every hash is gated, and a half-set environment is neither', () => {
  assert.equal(resolveAuthMode({}).mode, AUTH_MODES.UNGATED, 'nothing configured is the local desktop mode');
  assert.equal(resolveAuthMode(bothRoles()).mode, AUTH_MODES.GATED, 'both roles configured closes the gate');

  // The typo case: the operator's hash is set and the printer's env var is misspelled, so from here
  // it is simply absent. This must be its own mode — never a fall-through to ungated.
  const partial = resolveAuthMode({ [ROLE_ENV_VARS.operator]: hash, STUDIO_PRINTER_PASS_HSAH: hash });
  assert.equal(partial.mode, AUTH_MODES.MISCONFIGURED, 'one role configured is not "configured"');
  assert.deepEqual(partial.missing, ['printer'], 'the mode names the role that is missing');
  assert.match(partial.message, /STUDIO_PRINTER_PASS_HASH/, 'the error names the env var to set');
});

test('isLoopbackHost: only this machine counts, and an unset HOST means the 127.0.0.1 default', () => {
  for (const host of [undefined, '', '127.0.0.1', '127.0.0.9', 'localhost', '::1', '[::1]']) {
    assert.equal(isLoopbackHost(host), true, `${JSON.stringify(host)} is loopback`);
  }
  for (const host of ['0.0.0.0', '::', '10.0.0.4', 'fotomalovanky.onrender.com']) {
    assert.equal(isLoopbackHost(host), false, `${JSON.stringify(host)} is reachable from elsewhere`);
  }
});

test('AE1 — no credentials on a loopback bind: the board is served with no sign-in page', async () => {
  const origin = await serve({});
  const res = await fetch(`${origin}/`);
  const body = await res.text();
  assert.equal(res.status, 200, 'the dashboard is served');
  assert.match(body, /Fotomalovánky · Studio/, 'and it is the dashboard, not the sign-in page');
  assert.doesNotMatch(body, /id="password"/, 'no sign-in form is shown in local mode');

  // The implicit operator identity exists so role checks have a defined answer (KTD11).
  const api = await fetch(`${origin}/api/state`);
  assert.equal(api.status, 200, 'the API answers ungated too');
});

test('no credentials + a non-loopback bind: refuses to start rather than publishing the studio', async () => {
  // The Dockerfile sets HOST=0.0.0.0 for Render. A deploy that forgets the password hashes lands
  // exactly here, and the whole studio — orders, customer photographs, the mail panel — would
  // otherwise be served to anyone who found the URL.
  assert.throws(
    () => createReviewServer({ config, inboxRoot: config.paths.inbox, outboxRoot: config.paths.outbox, authEnv: { HOST: '0.0.0.0' } }),
    (err) => err instanceof AuthConfigError && /Refusing to start/.test(err.message) && /0\.0\.0\.0/.test(err.message),
    'an ungated studio on every interface must not be constructible',
  );

  // The same environment WITH credentials is fine: gated is safe anywhere.
  const gated = createReviewServer({ config, inboxRoot: config.paths.inbox, outboxRoot: config.paths.outbox, authEnv: { ...bothRoles(), HOST: '0.0.0.0' } });
  assert.ok(gated.server, 'a gated studio may bind every interface');
  gated.server.close();
});

test('one role configured and the other missing does NOT serve the board', async () => {
  const origin = await serve({ [ROLE_ENV_VARS.operator]: hash });

  const board = await fetch(`${origin}/`);
  assert.equal(board.status, 503, 'a half-configured studio refuses the board');
  const body = await board.json();
  assert.equal(body.code, 'auth-misconfigured');
  assert.match(body.error, /STUDIO_PRINTER_PASS_HASH/, 'and says exactly what to set');

  const api = await fetch(`${origin}/api/studio`);
  assert.equal(api.status, 503, 'the API is refused too');

  // AE3's sibling: the host's health check must still pass, or Render kills the instance and the
  // operator never sees the configuration error at all.
  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.status, 200, '/healthz answers even when sign-in is broken');
  assert.equal((await health.json()).ok, true);
});

test('AE2/AE3 — gated: a page request gets the sign-in page, /healthz answers, the API is refused not redirected', async () => {
  const origin = await serve(bothRoles());

  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200, 'an anonymous page request is answered');
  const html = await page.text();
  assert.match(html, /id="password"/, 'with the sign-in form');
  assert.doesNotMatch(html, /data-view="orders"/, 'and not with the dashboard shell');

  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.status, 200, '/healthz answers with no session');

  const api = await fetch(`${origin}/api/studio`, { redirect: 'manual' });
  assert.equal(api.status, 401, 'an anonymous API call is refused where it stands');
  assert.equal((await api.json()).code, 'signed-out', 'with a code the page can act on');
  assert.equal(api.headers.get('location'), null, 'and never redirected into an HTML page');
});

test('the pre-gate allowlist is a closed set: no dashboard shell, CSS or JS without a session', async () => {
  const origin = await serve(bothRoles());

  // A broad exemption (all of /static, or all GETs) would hand these to anonymous visitors. The
  // sign-in page is self-contained precisely so this list can stay this short.
  for (const path of ['/dashboard.html', '/index.html', '/css/tokens.css', '/css/components.css', '/login.html', '/review']) {
    const res = await fetch(`${origin}${path}`);
    if (path === '/review') {
      // A page view: the sign-in form, never the generator grid.
      assert.equal(res.status, 200, `${path} answers`);
      assert.doesNotMatch(await res.text(), /data-view|id="themeBtn"/, `${path} must not serve the app shell`);
    } else {
      assert.equal(res.status, 401, `${path} must not be served without a session`);
    }
  }

  // The two named assets the sign-in page needs, and nothing else.
  for (const path of ['/favicon.png', '/creatives/logo.svg']) {
    const res = await fetch(`${origin}${path}`);
    assert.equal(res.status, 200, `${path} is on the named allowlist`);
  }
});

test('the mode defaults to process.env when no authEnv is injected', async () => {
  const saved = { ...process.env };
  process.env[ROLE_ENV_VARS.operator] = hash;
  delete process.env[ROLE_ENV_VARS.printer];
  try {
    const { server } = createReviewServer({ config, inboxRoot: config.paths.inbox, outboxRoot: config.paths.outbox, memoryRoot: join(root, 'memory') });
    servers.push(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(res.status, 503, 'a half-configured process.env refuses the board');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
