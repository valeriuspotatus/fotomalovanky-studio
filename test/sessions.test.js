import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewServer } from '../src/ui/server.js';
import { hashPassword, ROLE_ENV_VARS } from '../src/auth/credentials.js';
import { DEFAULT_USERNAMES } from '../src/auth/accounts.js';
import {
  SESSION_COOKIE,
  SessionError,
  clearedSessionCookie,
  createSessionStore,
  parseCookies,
  sessionCookie,
} from '../src/auth/sessions.js';

// Sessions, over real HTTP where it matters.
//
// The three properties worth more than the rest of this file put together:
//   - a token is 32 random bytes minted by the SERVER, never adopted from the request;
//   - sign-out deletes the server-side entry, so replaying the cookie afterwards is dead;
//   - the cookie is `__Host-`-prefixed, which makes the browser enforce Secure + Path=/ + no Domain
//     rather than leaving them as attributes a future edit could quietly drop.

const PASSWORD = 'correct horse battery staple';

/** A real scrypt hash at a cheap cost — the stored string carries its own parameters, so this runs
 *  the production verification path in milliseconds. credentials.test.js owns the real cost. */
const cheapHash = (password) => hashPassword(password, { logN: 14, r: 8, p: 1 });

let root, config, hash, servers;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'fma-sess-'));
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

const gatedEnv = () => ({ [ROLE_ENV_VARS.operator]: hash, [ROLE_ENV_VARS.printer]: hash });

async function serve({ sessions } = {}) {
  const { server } = createReviewServer({
    config,
    inboxRoot: config.paths.inbox,
    outboxRoot: config.paths.outbox,
    memoryRoot: join(root, 'memory'),
    driver: { generate: async () => {} },
    authEnv: gatedEnv(),
    ...(sessions ? { sessions } : {}),
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

/** Sign in over HTTP and hand back the raw response plus the token the Set-Cookie carried. */
async function signIn(origin, username, password) {
  const res = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username, password }),
  });
  const setCookie = res.headers.get('set-cookie');
  const token = setCookie ? parseCookies(setCookie.split(';')[0])[SESSION_COOKIE] : null;
  return { res, setCookie, token };
}

const withSession = (token) => ({ Cookie: `${SESSION_COOKIE}=${token}` });

// --- the store itself -----------------------------------------------------------------------------

test('the store mints a fresh opaque token per session and resolves it to a role', () => {
  const store = createSessionStore();
  const a = store.create('operator');
  const b = store.create('operator');

  assert.notEqual(a, b, 'two sessions never share a token');
  assert.match(a, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url — not a counter or a timestamp');
  assert.equal(store.get(a).role, 'operator');
  assert.equal(store.get(b).role, 'operator');
  assert.equal(store.get('a token the client made up'), null, 'a fabricated token is nobody');
  assert.equal(store.get(undefined), null, 'and neither is no token at all');
  assert.throws(() => store.create('admin'), SessionError, 'an unknown role cannot hold a session');
});

test('destroy removes the server-side entry, which is what makes sign-out real', () => {
  const store = createSessionStore();
  const token = store.create('printer');
  assert.equal(store.size, 1);
  assert.equal(store.destroy(token), true);
  assert.equal(store.get(token), null, 'the token is dead even though the client still holds it');
  assert.equal(store.size, 0, 'and the entry is gone, not just marked');
});

test('an expired session is refused and swept', () => {
  let clock = 1_000;
  const store = createSessionStore({ ttlMs: 100, now: () => clock });
  const token = store.create('operator');
  clock += 99;
  assert.ok(store.get(token), 'still live inside the TTL');
  clock += 2;
  assert.equal(store.get(token), null, 'refused past the TTL');
  assert.equal(store.size, 0, 'and dropped from the map on the way out');
});

test('the cookie carries HttpOnly, Secure, SameSite and Path — and no Domain', () => {
  const cookie = sessionCookie('tok');
  assert.match(cookie, /^__Host-/, 'the __Host- prefix makes the browser enforce the rest');
  assert.match(cookie, /; HttpOnly/, 'no script may read the token');
  assert.match(cookie, /; Secure/, 'never sent over plaintext HTTP');
  assert.match(cookie, /; SameSite=Lax/, 'the CSRF posture (KTD4)');
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /; Max-Age=\d+/);
  assert.doesNotMatch(cookie, /Domain=/i, 'a Domain attribute would widen this to sibling subdomains');
  assert.match(clearedSessionCookie(), /Max-Age=0/, 'sign-out clears it as well as revoking it');
});

// --- over HTTP ------------------------------------------------------------------------------------

test('AE2 — a correct sign-in reaches the board; the token is minted, not adopted', async () => {
  const origin = await serve();

  const anonymous = await fetch(`${origin}/api/studio`);
  assert.equal(anonymous.status, 401, 'the board is closed before signing in');

  // A client-supplied cookie must never become a session (fixation).
  const forged = await fetch(`${origin}/api/studio`, { headers: withSession('a-token-i-chose-myself') });
  assert.equal(forged.status, 401, 'a cookie value the client invented is not a session');

  const { res, token } = await signIn(origin, DEFAULT_USERNAMES.operator, PASSWORD);
  assert.equal(res.status, 200, 'the correct password signs in');
  assert.equal((await res.json()).role, 'operator');
  assert.ok(token, 'and sets a session cookie');
  assert.notEqual(token, 'a-token-i-chose-myself', 'the server minted its own token');

  const board = await fetch(`${origin}/api/studio`, { headers: withSession(token) });
  assert.equal(board.status, 200, 'the session reaches the board');

  const page = await fetch(`${origin}/`, { headers: withSession(token) });
  assert.match(await page.text(), /Fotomalovánky · Studio/, 'and the dashboard, not the sign-in page');
});

test('the printer signs in as the printer — the hash is keyed by role, the username is not', async () => {
  const origin = await serve();
  const { res } = await signIn(origin, DEFAULT_USERNAMES.printer, PASSWORD);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).role, 'printer', 'Jirka gets the printer role');
});

test('a wrong password, and an unknown username, set no session cookie and read alike', async () => {
  const origin = await serve();

  const wrong = await signIn(origin, DEFAULT_USERNAMES.operator, 'not the password');
  assert.equal(wrong.res.status, 401, 'a wrong password is refused');
  assert.equal(wrong.setCookie, null, 'and sets no session cookie');

  const unknown = await signIn(origin, 'Mallory', PASSWORD);
  assert.equal(unknown.res.status, 401, 'an unknown username is refused');
  assert.equal(unknown.setCookie, null);
  assert.equal(
    (await unknown.res.json()).error,
    (await wrong.res.json()).error,
    'the two answers are identical — the response cannot enumerate who has an account',
  );
});

test('signing out invalidates the token server-side: replaying the old cookie is refused', async () => {
  const origin = await serve();
  const { token } = await signIn(origin, DEFAULT_USERNAMES.operator, PASSWORD);
  assert.equal((await fetch(`${origin}/api/studio`, { headers: withSession(token) })).status, 200);

  const out = await fetch(`${origin}/api/logout`, { method: 'POST', headers: { ...withSession(token), Origin: origin } });
  assert.equal(out.status, 200, 'sign-out succeeds');
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/, 'and clears the cookie in the browser');

  // The point: the attacker who copied the cookie value gets nothing.
  const replayed = await fetch(`${origin}/api/studio`, { headers: withSession(token) });
  assert.equal(replayed.status, 401, 'the token is dead on the server, not merely cleared on the client');
});

test('a new sign-in issues a different token than the previous session held', async () => {
  const origin = await serve();
  const first = await signIn(origin, DEFAULT_USERNAMES.operator, PASSWORD);
  const second = await signIn(origin, DEFAULT_USERNAMES.operator, PASSWORD);
  assert.ok(first.token && second.token);
  assert.notEqual(first.token, second.token, 'every sign-in mints a new token');
});

test('an expired session is refused over HTTP, and the page comes back', async () => {
  const origin = await serve({ sessions: createSessionStore({ ttlMs: 25 }) });
  const { token } = await signIn(origin, DEFAULT_USERNAMES.operator, PASSWORD);
  assert.equal((await fetch(`${origin}/api/studio`, { headers: withSession(token) })).status, 200);

  await new Promise((r) => setTimeout(r, 40));
  const stale = await fetch(`${origin}/api/studio`, { headers: withSession(token) });
  assert.equal(stale.status, 401, 'the expired session is refused');

  const page = await fetch(`${origin}/`, { headers: withSession(token) });
  assert.match(await page.text(), /id="password"/, 'and a page request shows the sign-in form again');
});

test('/login redirects a signed-in visitor to the studio instead of showing the form again', async () => {
  const origin = await serve();
  const { token } = await signIn(origin, DEFAULT_USERNAMES.operator, PASSWORD);
  const res = await fetch(`${origin}/login`, { headers: withSession(token), redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
});

test('parseCookies survives the junk a real browser sends', () => {
  const jar = parseCookies(`theme=dark; ${SESSION_COOKIE}=abc123; broken; =nameless; trailing=`);
  assert.equal(jar[SESSION_COOKIE], 'abc123');
  assert.equal(jar.theme, 'dark');
  assert.equal(jar.trailing, '');
  assert.equal(parseCookies(undefined)[SESSION_COOKIE], undefined, 'no cookie header is no session');
});
