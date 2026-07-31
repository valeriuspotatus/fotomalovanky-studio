// What it costs to guess a password here — and, more urgently, what it costs the BOX when someone
// tries.
//
// Three separate problems, deliberately solved in one place because they all sit on the same call:
//
//   1. GUESSING. Per-username progressive backoff, never a hard lock (KTD5). A hard lock on a
//      two-account app with no self-service recovery is a denial of service an attacker triggers on
//      purpose, by guessing wrong: lock David out and the studio stops. So failures buy delay, not
//      a closed door, and a correct password clears the debt with no intervention.
//
//   2. TIMING. A floor on every attempt's total duration, whatever the outcome. "No such user" and
//      "wrong password" already cost the same scrypt work (see credentials.js); the floor covers
//      everything around it, and caps raw throughput at four attempts a second per connection.
//
//   3. MEMORY — and this is the one that takes the studio down. Each scrypt call at the OWASP cost
//      allocates ~128 MiB. The box has ~2 GB shared with the PDF builder's headless Chromium, and
//      Node runs scrypt on the libuv threadpool (4 threads by default), so concurrent sign-in
//      attempts do not merely queue: they allocate half a gigabyte at once and starve every
//      filesystem operation in the app of a thread while they do it. A per-username throttle does
//      NOT bound this, and it is important to be clear about why — an attacker rotates the
//      username on every request and never accumulates a counter to be slowed by. The bound has to
//      be global, on the derivations themselves, and it is `maxConcurrent` below.
//
// The cap is applied AFTER the duration floor. Refusing instantly when the queue is full would make
// "the box is busy" measurably faster than "wrong password", which is a free signal about load and
// about which requests reached the expensive path.

import { setTimeout as sleepMs } from 'node:timers/promises';

/** Every attempt takes at least this long, successful or not. */
export const FLOOR_MS = 250;

/** In-flight scrypt derivations allowed process-wide. Two, not four: two costs ~256 MiB and leaves
 *  half the libuv threadpool for the filesystem work the rest of the studio is doing. */
export const MAX_CONCURRENT_VERIFICATIONS = 2;

/** How many attempts may WAIT for a slot before the rest are refused. Short on purpose: a queue is
 *  memory and held connections, and an unbounded one converts the memory cap into a slower version
 *  of the same outage. */
export const MAX_QUEUE = 4;

/** Free attempts before a username starts buying delay. Three covers a real typo run. */
export const FAILURES_BEFORE_BACKOFF = 3;

/** Backoff doubles from here, capped so a locked-out person is never locked out for good (KTD5). */
export const BACKOFF_BASE_MS = 250;
export const BACKOFF_MAX_MS = 30_000;

/** The methods that can change something, and so must prove they came from this origin. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/** A throttle-seam failure. Carries `seam` like the other drivers. */
export class ThrottleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ThrottleError';
    this.seam = 'throttle';
  }
}

/** Too many verifications in flight: this attempt never reached scrypt at all. Distinct from a
 *  wrong password so the route can answer 429 rather than 401 — and so the operator, if they ever
 *  see it, is told to wait rather than told their password is wrong. */
export class SignInBusyError extends ThrottleError {
  constructor(retryAfterSeconds = 1) {
    super('Přihlášení je právě zaneprázdněné, zkuste to za chvíli. (Too many sign-in attempts in flight.)');
    this.name = 'SignInBusyError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The counter key for a username. Case- and whitespace-insensitive, because "Jirka" and " jirka "
 *  are one person to everyone else in this codebase and must be one person to the backoff too. */
const keyFor = (username) => String(username ?? '').trim().toLocaleLowerCase('cs');

/**
 * A sign-in throttle: per-username backoff, a global duration floor, and a global cap on concurrent
 * password verifications.
 *
 * Everything is injectable (`sleep`, `now`) so a test can assert the delays grow without living
 * through them, and so the concurrency cap can be observed against a verifier that parks.
 */
export function createSignInThrottle({
  floorMs = FLOOR_MS,
  maxConcurrent = MAX_CONCURRENT_VERIFICATIONS,
  maxQueue = MAX_QUEUE,
  failuresBeforeBackoff = FAILURES_BEFORE_BACKOFF,
  backoffBaseMs = BACKOFF_BASE_MS,
  backoffMaxMs = BACKOFF_MAX_MS,
  sleep = (ms) => sleepMs(ms),
  now = Date.now,
} = {}) {
  /** username-key -> consecutive failures. Cleared on success (KTD5). */
  const failures = new Map();

  let inFlight = 0;
  let peakInFlight = 0;
  let refused = 0;
  /** Resolvers of attempts waiting for a slot, oldest first. Bounded by maxQueue. */
  const waiting = [];

  /** How long this username must wait before its next attempt reaches scrypt. Doubles per failure
   *  past the free allowance, capped — never infinite, never a lock. */
  const delayFor = (username) => {
    const count = failures.get(keyFor(username)) ?? 0;
    if (count < failuresBeforeBackoff) return 0;
    const steps = count - failuresBeforeBackoff;
    return Math.min(backoffMaxMs, backoffBaseMs * 2 ** steps);
  };

  /** Take a slot, queue for one, or refuse. Resolves true when the caller holds a slot. New arrivals
   *  queue behind existing waiters even when a slot is free, or a steady stream of new attempts
   *  would starve the ones already waiting. */
  const acquire = async () => {
    if (inFlight < maxConcurrent && waiting.length === 0) {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      return true;
    }
    if (waiting.length >= maxQueue) {
      refused += 1;
      return false;
    }
    await new Promise((resolve) => waiting.push(resolve));
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    return true;
  };

  const release = () => {
    inFlight -= 1;
    waiting.shift()?.();
  };

  /**
   * Run one sign-in attempt. `verify` must resolve truthy for a correct password and falsy for a
   * wrong one; it is the only thing here allowed to touch a password, and this module never sees
   * one. Throws SignInBusyError when the global cap turned the attempt away.
   */
  const run = async (username, verify) => {
    const startedAt = now();
    /** Hold the attempt open until the floor is met — from the START of the attempt, so backoff and
     *  scrypt both count toward it and a slow attempt is not slowed twice. */
    const settle = async () => {
      const remaining = floorMs - (now() - startedAt);
      if (remaining > 0) await sleep(remaining);
    };

    // Backoff first, and OUTSIDE the concurrency slot: a punished username must not hold a scarce
    // derivation slot while it sits out its delay.
    const wait = delayFor(username);
    if (wait > 0) await sleep(wait);

    if (!(await acquire())) {
      await settle(); // the cap must not be observable as a fast answer
      throw new SignInBusyError(Math.max(1, Math.ceil(floorMs / 1000)));
    }

    let ok;
    try {
      ok = await verify();
    } finally {
      release();
    }

    const key = keyFor(username);
    if (ok) failures.delete(key);
    else failures.set(key, (failures.get(key) ?? 0) + 1);

    await settle();
    return ok;
  };

  return {
    run,
    delayFor,
    /** Consecutive failures recorded for a username — for tests and for the log line. */
    failureCount: (username) => failures.get(keyFor(username)) ?? 0,
    stats: () => ({ inFlight, peakInFlight, waiting: waiting.length, refused }),
    reset: () => {
      failures.clear();
      peakInFlight = 0;
      refused = 0;
    },
  };
}

/** The process-wide throttle. The memory cap is a property of the BOX, not of a server instance, so
 *  it has to be shared: two servers in one process must not be able to run four derivations. */
let shared = null;
export function sharedSignInThrottle() {
  return (shared ??= createSignInThrottle());
}

/**
 * Did this mutating request come from our own origin?
 *
 * This is the CSRF posture instead of a token scheme (KTD4). SameSite=Lax on the session cookie
 * already blocks the cross-site vector outright; this closes the documented residual gap for free
 * and with no dependency, where a token scheme would need per-form plumbing and would not fix the
 * one thing Lax misses anyway (same-origin XSS).
 *
 * A request carrying NEITHER header is allowed. That is not an oversight: browsers always attach
 * Origin to a cross-site POST, so "neither header" is never the forged case — it is curl, the
 * launcher script, or the studio's own test suite, and refusing those would break every local tool
 * to defend against nothing. GETs are unaffected.
 */
export function isSameOrigin(req) {
  const method = String(req?.method ?? '').toUpperCase();
  if (!MUTATING_METHODS.has(method)) return true;

  const headers = req?.headers ?? {};
  const claimed = headers.origin || headers.referer;
  if (!claimed) return true;
  if (claimed === 'null') return false; // an opaque origin: a sandboxed frame or a data: document

  let parsed;
  try {
    parsed = new URL(claimed);
  } catch {
    return false; // a header we cannot parse is not a match we can assert
  }
  const host = headers.host;
  return Boolean(host) && parsed.host === host;
}
