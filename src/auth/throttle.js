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

/** How many attempts may WAIT for a slot before the rest are refused. A queue is memory and held
 *  connections, so it is bounded — but bounded in TIME as well (maxWaitMs below), which is what lets
 *  the depth be generous.
 *
 *  It was 4, and 4 was a denial of service. Two derivations run at a time and each takes the better
 *  part of a second, so a handful of concurrent requests keeps a four-deep queue permanently full and
 *  every subsequent attempt is refused on arrival — including David's and Jirka's. That is exactly
 *  the hard lockout KTD5 refused to build, handed to anyone outside who can open a few sockets.
 *  Deeper, plus a deadline, means a burst is ABSORBED and answered in turn instead of turning the
 *  two real people away.
 *
 *  Sized against the deadline rather than pulled out of the air: sixteen waiters, two at a time,
 *  drain in about eight seconds of scrypt — inside MAX_WAIT_MS, so a queue this deep is a queue that
 *  is actually served rather than a longer wait for the same 429. */
export const MAX_QUEUE = 16;

/** How long an attempt may wait for a derivation slot before it is refused. The queue's second
 *  bound, and the one that keeps the first one honest: without it, depth alone would just hold more
 *  sockets open for longer. Refusal after the wait is a 429 with Retry-After — "come back", not
 *  "you are locked out". */
export const MAX_WAIT_MS = 10_000;

/** How many usernames the backoff map may hold, and how long an entry survives its last failure.
 *
 *  The map is keyed on ATTACKER-SUPPLIED text and only ever cleared on a successful sign-in for that
 *  exact key, so a rotating-username attack grew it without bound — a slow memory leak on a 2 GB box
 *  driven from outside, in the module whose whole subject is bounding what an attacker can spend.
 *
 *  The TTL is far longer than BACKOFF_MAX_MS on purpose: forgetting a username can never shorten a
 *  delay that had not already elapsed, because anyone who waits fifteen minutes has already served
 *  the longest backoff this module can impose. */
export const MAX_TRACKED_USERNAMES = 512;
export const FAILURE_TTL_MS = 15 * 60_000;

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
  maxWaitMs = MAX_WAIT_MS,
  failuresBeforeBackoff = FAILURES_BEFORE_BACKOFF,
  backoffBaseMs = BACKOFF_BASE_MS,
  backoffMaxMs = BACKOFF_MAX_MS,
  maxTrackedUsernames = MAX_TRACKED_USERNAMES,
  failureTtlMs = FAILURE_TTL_MS,
  sleep = (ms) => sleepMs(ms),
  now = Date.now,
} = {}) {
  /** username-key -> { count, at }. Cleared on success (KTD5), and BOUNDED — see below. `at` is the
   *  last failure, which is what makes an entry expirable rather than immortal. */
  const failures = new Map();

  let inFlight = 0;
  let peakInFlight = 0;
  let refused = 0;
  /** Resolvers of attempts waiting for a slot, oldest first. Bounded by maxQueue and by maxWaitMs. */
  const waiting = [];

  /** The live failure record for a username, or null when there is none or it has aged out.
   *  Expiry is read-through as well as swept, so a stale entry can never impose a delay even in the
   *  moment before the sweep runs. */
  const liveFailure = (key) => {
    const entry = failures.get(key);
    if (!entry) return null;
    if (now() - entry.at > failureTtlMs) {
      failures.delete(key);
      return null;
    }
    return entry;
  };

  /** Keep the map bounded: drop everything whose backoff has expired, and if that was not enough,
   *  evict oldest-first until it fits. Insertion order is Map's own, and a re-failure does not
   *  reorder a key, so "oldest" is "least recently first seen" — good enough, because the only
   *  entries that can reach the cap are an attacker's rotating throwaways. Evicting one costs the
   *  attacker their own backoff and costs a real person nothing. */
  const boundFailures = () => {
    for (const [key, entry] of failures) {
      if (now() - entry.at > failureTtlMs) failures.delete(key);
    }
    while (failures.size > maxTrackedUsernames) {
      const oldest = failures.keys().next();
      if (oldest.done) break;
      failures.delete(oldest.value);
    }
  };

  /** How long this username must wait before its next attempt reaches scrypt. Doubles per failure
   *  past the free allowance, capped — never infinite, never a lock. */
  const delayFor = (username) => {
    const count = liveFailure(keyFor(username))?.count ?? 0;
    if (count < failuresBeforeBackoff) return 0;
    const steps = count - failuresBeforeBackoff;
    return Math.min(backoffMaxMs, backoffBaseMs * 2 ** steps);
  };

  /** Take a slot, queue for one, or refuse. Resolves true when the caller holds a slot. New arrivals
   *  queue behind existing waiters even when a slot is free, or a steady stream of new attempts
   *  would starve the ones already waiting.
   *
   *  Two bounds, and they answer different failures. `maxQueue` bounds the MEMORY (waiters are held
   *  sockets). `maxWaitMs` bounds the TIME any one of them can be parked, so a queue can be deep
   *  enough to absorb a burst — a legitimate attempt arriving during one waits its turn and is
   *  served, instead of being refused on arrival because a handful of concurrent requests happened
   *  to be in front of it. */
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
    const ticket = { resolve: null, done: false };
    const got = await new Promise((resolve) => {
      ticket.resolve = resolve;
      waiting.push(ticket);
      // The deadline. A real timer rather than the injected `sleep`, because this one must be
      // CANCELLABLE (the common case is being served long before it fires) and must never be the
      // reason a process stays alive — so: cleared on wake, unref'd meanwhile. `release` skips a
      // ticket that has already timed out, so a waiter that gave up never consumes a slot.
      const timer = setTimeout(() => {
        if (ticket.done) return;
        ticket.done = true;
        const at = waiting.indexOf(ticket);
        if (at >= 0) waiting.splice(at, 1);
        resolve(false);
      }, maxWaitMs);
      timer.unref?.();
      ticket.cancelTimer = () => clearTimeout(timer);
    });
    ticket.cancelTimer?.();
    if (!got) {
      refused += 1;
      return false;
    }
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    return true;
  };

  const release = () => {
    inFlight -= 1;
    // Hand the slot to the oldest waiter that is still there. Tickets that hit their deadline are
    // skipped rather than woken — waking one would leak a slot nobody is holding.
    while (waiting.length) {
      const next = waiting.shift();
      if (next.done) continue;
      next.done = true;
      next.resolve(true);
      return;
    }
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
    if (ok) {
      failures.delete(key);
    } else {
      const previous = liveFailure(key);
      failures.set(key, { count: (previous?.count ?? 0) + 1, at: now() });
      boundFailures(); // the only place the map grows, so the only place it has to be bounded
    }

    await settle();
    return ok;
  };

  return {
    run,
    delayFor,
    /** Consecutive failures recorded for a username — for tests and for the log line. */
    failureCount: (username) => liveFailure(keyFor(username))?.count ?? 0,
    stats: () => ({ inFlight, peakInFlight, waiting: waiting.length, refused, tracked: failures.size }),
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
