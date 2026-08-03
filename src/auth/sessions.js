// Who is signed in right now — and the one decision about whether anybody has to be.
//
// Two halves live here because they are the same invariant seen from two sides:
//
//   1. SESSIONS. An opaque random token in an in-process Map against {role, expiresAt} (KTD3). A
//      signed stateless cookie would survive redeploys, but honest sign-out still needs a
//      server-side revocation list — which is the state it was trying to avoid. The Map makes
//      sign-out true: delete the entry and the cookie in the attacker's hand is a dead string.
//      Redeploys ending every session is the accepted price, documented rather than engineered
//      around.
//
//   2. THE MODE. Whether the studio is gated at all. `checkAuth` used to answer "no credentials
//      configured → let everyone in", which is right on a laptop and catastrophic on a public URL.
//      `resolveAuthMode` below refuses to give that answer loosely: ungated applies ONLY when NOT
//      ONE role hash is configured, a half-configured environment refuses every request instead of
//      falling through, and `assertLocalModeIsSafe` will not let the ungated answer be given on a
//      bind address the internet can reach. The disk under this app holds photographs of
//      customers' children; "fail open" here is not a degraded mode, it is a disclosure.
//
// The token is `crypto.randomBytes(32)` and nothing else. Never Math.random, never anything derived
// from a timestamp or a counter: both are guessable from outside, and a guessed token is a session.

import { randomBytes } from 'node:crypto';
import { ROLES, ROLE_ENV_VARS, hashForRole } from './credentials.js';

/** 32 random bytes, base64url. 256 bits of entropy — brute force is not a threat model, so the token
 *  never needs to be hashed at rest the way a password does. */
const TOKEN_BYTES = 32;

/** The cookie name. The `__Host-` prefix is not decoration: the browser REFUSES to store a cookie
 *  under this name unless it is Secure, Path=/ and carries NO Domain attribute. That turns "we
 *  promise not to widen this cookie to sibling subdomains" from a comment somebody can delete into
 *  something the browser enforces on every response we will ever send. */
export const SESSION_COOKIE = '__Host-fm_session';

/** Eight hours: one working day at the studio. Long enough that Jirka is not signing in between
 *  print batches, short enough that a session left open on a shared machine dies the same day. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** The identity the studio resolves when nobody signed in because nobody CAN sign in (KTD11). Role
 *  checks need a defined answer in local mode or they throw, or — worse — deny unpredictably. */
export const IMPLICIT_OPERATOR = Object.freeze({ role: 'operator', implicit: true });

/** A session-seam failure. Carries `seam` like the credential/account/generator errors do. */
export class SessionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionError';
    this.seam = 'sessions';
  }
}

/** A refusal to run at all: the environment describes a studio that cannot be safely served. Thrown
 *  at startup, never per request — a misconfiguration this shape must stop the deploy, not degrade. */
export class AuthConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthConfigError';
    this.seam = 'auth-config';
  }
}

export const AUTH_MODES = Object.freeze({
  /** Every role has a hash: the sign-in page is real and the gate is closed. */
  GATED: 'gated',
  /** NOT ONE role has a hash: the desktop workflow, implicit operator, no sign-in page. */
  UNGATED: 'ungated',
  /** Some but not all: refuse everything but /healthz. Never, ever fall through to ungated. */
  MISCONFIGURED: 'misconfigured',
});

/**
 * Is the studio gated, ungated, or broken? The single answer the request gate is allowed to consult.
 *
 * The middle case is the whole reason this function exists. Setting one role's hash and misspelling
 * the other's env var is the likeliest configuration mistake there is, and under the old
 * "credentials configured?" boolean it read as *partially* gated — which in practice means whichever
 * side the boolean fell on. If it fell open, one typo publishes the studio. So a partial
 * configuration is its own mode and its answer is "no", loudly.
 */
export function resolveAuthMode(env = process.env) {
  const configured = ROLES.filter((role) => hashForRole(role, env) !== null);
  const missing = ROLES.filter((role) => !configured.includes(role));

  if (missing.length === 0) return { mode: AUTH_MODES.GATED, configured, missing, message: null };
  if (configured.length === 0) return { mode: AUTH_MODES.UNGATED, configured, missing, message: null };

  const names = missing.map((role) => ROLE_ENV_VARS[role]).join(' and ');
  return {
    mode: AUTH_MODES.MISCONFIGURED,
    configured,
    missing,
    message:
      `Přihlášení není správně nastavené — chybí ${names}. ` +
      `Sign-in is half-configured: ${configured.join(', ')} has a password hash but ${missing.join(', ')} does not. ` +
      `Set ${names} in the environment (node src/auth/credentials.js <password> prints the value), or unset every ` +
      `${ROLES.map((r) => ROLE_ENV_VARS[r]).join('/')} to run the studio locally with no sign-in at all.`,
  };
}

/** Addresses that only this machine can reach. `undefined`/empty counts: the app's own default bind
 *  is 127.0.0.1 and an unset HOST means exactly that. `0.0.0.0` and `::` are the opposite — they are
 *  "every interface", which on Render means the public internet. */
export function isLoopbackHost(host) {
  if (host === undefined || host === null || host === '') return true;
  const h = String(host).trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Refuse to start an ungated studio on an address the internet can reach.
 *
 * This is the second half of the fail-open guard, and it exists because the first half is not
 * enough on its own: "no credentials configured" is a perfectly good reason to skip the gate on a
 * laptop and a perfectly terrible one on Render, and nothing in the environment distinguishes the
 * two except where the socket is bound. The Dockerfile sets HOST=0.0.0.0; a deploy that forgets the
 * password hashes therefore hits exactly this case, and it must stop rather than serve the whole
 * studio — orders, customer photographs, the mail panel — to anyone who finds the URL.
 */
export function assertLocalModeIsSafe({ env = process.env, bindHost = env.HOST } = {}) {
  const { mode } = resolveAuthMode(env);
  if (mode !== AUTH_MODES.UNGATED) return; // gated is safe anywhere; misconfigured refuses per request
  if (isLoopbackHost(bindHost)) return;
  throw new AuthConfigError(
    `Refusing to start: no password hashes are configured, but the server would bind ${bindHost} — ` +
      `every interface, not just this machine. That would serve the whole studio, including customer ` +
      `photographs, to anyone who reaches the address. Set ${ROLES.map((r) => ROLE_ENV_VARS[r]).join(' and ')} ` +
      `(node src/auth/credentials.js <password> prints the values), or bind 127.0.0.1 to run locally.`,
  );
}

/**
 * The session table: opaque token -> { role, expiresAt }.
 *
 * In-process on purpose (KTD3). `now` is injectable so a test can age a session out without
 * sleeping through eight hours of it.
 */
export function createSessionStore({ ttlMs = SESSION_TTL_MS, now = Date.now } = {}) {
  const sessions = new Map();

  /** Mint a session for a role. ALWAYS a fresh token — this function is the only way a token enters
   *  the Map, so there is no path by which a client-supplied value can become a live session. That
   *  is session fixation closed by construction rather than by a check somebody could forget. */
  const create = (role) => {
    if (!ROLES.includes(role)) throw new SessionError(`cannot open a session for unknown role ${JSON.stringify(role)}.`);
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    sessions.set(token, { role, expiresAt: now() + ttlMs });
    return token;
  };

  /** The live session for a token, or null. An expired entry is deleted on the way out rather than
   *  left to accumulate — nothing else sweeps this Map. */
  const get = (token) => {
    if (typeof token !== 'string' || !token) return null;
    const entry = sessions.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      sessions.delete(token);
      return null;
    }
    return { role: entry.role, expiresAt: entry.expiresAt, implicit: false };
  };

  /** Sign out. Deletes the SERVER-side entry, which is the only thing that makes sign-out real: a
   *  cleared cookie is a request the client can decline to honour, and a copied cookie value would
   *  still work. Returns whether there was anything to delete. */
  const destroy = (token) => (typeof token === 'string' ? sessions.delete(token) : false);

  return {
    create,
    get,
    destroy,
    /** Drop every session (a redeploy does this for free; tests do it deliberately). */
    clear: () => sessions.clear(),
    get size() {
      return sessions.size;
    },
  };
}

/** Cookies as a plain object. Tolerant of the junk a real browser sends — an unparseable pair is
 *  skipped rather than throwing a request away. */
export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name) continue;
    out[name] = part.slice(i + 1).trim();
  }
  return out;
}

/** The session token this request carries, or null. */
export function tokenFromRequest(req) {
  return parseCookies(req?.headers?.cookie)[SESSION_COOKIE] ?? null;
}

/** The Set-Cookie value for a new session.
 *
 *  Every attribute here is load-bearing, and the `__Host-` prefix makes the browser check three of
 *  them for us: HttpOnly keeps the token out of reach of any script (so an XSS cannot read it),
 *  Secure keeps it off plaintext HTTP, SameSite=Lax is the CSRF posture (KTD4), Path=/ scopes it to
 *  the app, and the ABSENCE of Domain is what stops the cookie leaking to a sibling subdomain of
 *  onrender.com. Do not add Domain — the browser would reject the whole cookie, and rightly so. */
export function sessionCookie(token, { ttlMs = SESSION_TTL_MS } = {}) {
  const maxAge = Math.max(0, Math.floor(ttlMs / 1000));
  return `${SESSION_COOKIE}=${token}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

/** The Set-Cookie value that clears the session cookie. Same attributes minus the value: a browser
 *  only overwrites a cookie when the name, path and prefix rules match. */
export function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

/** GET /login — the branded sign-in page. */
export const LOGIN_PAGE_PATH = '/login';
/** POST — the only endpoint that verifies a password. */
export const SIGN_IN_PATH = '/api/login';
/** POST — sign-out. Deliberately NOT pre-gate: destroying a session requires holding one. */
export const SIGN_OUT_PATH = '/api/logout';

/** The page paths that show the sign-in form to an anonymous visitor instead of refusing them.
 *  Serving login.html here is not serving the app — the dashboard shell itself stays behind the
 *  gate (see PRE_GATE_ASSETS). */
const SIGN_IN_PAGE_VIEWS = Object.freeze(['/', '/review', LOGIN_PAGE_PATH]);

/**
 * The ONLY static files an anonymous visitor may fetch — named one by one, closed set.
 *
 * The temptation is to exempt `/static` wholesale, or every GET. Either would hand out
 * dashboard.html, index.html and the dashboard's CSS and JS — the whole application shell, its
 * route list and its API surface — to anybody who asks. login.html is therefore written
 * self-contained (its CSS is inline) so this list can stay at two decorative files that give away
 * nothing but the brand.
 */
export const PRE_GATE_ASSETS = Object.freeze(['/favicon.png', '/creatives/logo.svg']);

/** May this request reach the server with no session at all? `/healthz` answers earlier still. */
export function isPreGate(method, pathname) {
  if (method === 'POST' && pathname === SIGN_IN_PATH) return true;
  if (method !== 'GET') return false;
  return PRE_GATE_ASSETS.includes(pathname);
}

/** Is this an anonymous request for a PAGE (so: show the sign-in form) rather than for the API (so:
 *  refuse it outright)? The plan is explicit that an unauthenticated API call is refused and never
 *  redirected — a fetch() that follows a redirect to an HTML page reports a baffling parse error
 *  instead of "you are signed out". */
export function wantsSignInPage(method, pathname) {
  return method === 'GET' && SIGN_IN_PAGE_VIEWS.includes(pathname);
}
