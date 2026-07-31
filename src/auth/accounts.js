// Who the two people are — and deliberately nothing about how they prove it.
//
// A password hash cannot live here. This file sits on the persistent disk mounted at /data, the
// same disk that holds photographs of customers' children; it is what a backup, a support session
// or a mis-scoped `ls` reaches first. The hashes stay in the Render environment, keyed by role
// (KTD1). So one record per role holds exactly three things: the role, the display username the
// person chose, and a reference to their avatar. `sanitize` below is what keeps it that way — it
// rebuilds each record field by field, so a `password` or `passwordHash` smuggled in by a caller
// (or hand-added to the file) is dropped rather than persisted.
//
// Reading is total: it never throws. A missing file is an older install that simply has no
// preferences yet, and a half-written or hand-edited one is no better evidence than none — both
// fall back to the default usernames. Refusing to start because a preferences file is malformed
// would lock both people out of a working studio over a cosmetic setting.
//
// Writing is strict, and it sets `mode: 0o600` explicitly. Nothing else in this codebase does, and
// on a shared mount the default (0o644) means anything running as another user can read who uses
// this box. The names are not secret, but they are not everyone's business either.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLES } from './credentials.js';

export const ACCOUNTS_FILE = 'accounts.json';

/** The account file inside the accounts data dir (config.accounts.dataDir — absolute, outside the repo). */
export const accountsPath = (dataDir) => join(dataDir, ACCOUNTS_FILE);

/** What each role is called before anyone renames themselves. A1 is David, A2 is Jirka. */
export const DEFAULT_USERNAMES = Object.freeze({ operator: 'David', printer: 'Jirka' });

/** Only these three fields are ever persisted. Anything else — most of all anything credential-shaped
 *  — is dropped on the way in AND on the way out. */
const PERSISTED_FIELDS = Object.freeze(['role', 'username', 'avatar']);

const MAX_USERNAME = 40;

/** An accounts-seam failure, phrased for the operator. Carries `seam` like the other drivers. */
export class AccountError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AccountError';
    this.seam = 'accounts';
  }
}

/** The two records an install starts life with: default names, no avatar. */
export function defaultAccounts() {
  return ROLES.map((role) => ({ role, username: DEFAULT_USERNAMES[role], avatar: null }));
}

/** A username trimmed and length-capped, or null when it is not usable. Kept permissive about the
 *  characters — Czech names carry accents and this is a display name, not an identifier. Control
 *  characters are out, because they belong to no name and confuse every log line downstream. */
export function normalizeUsername(raw) {
  if (typeof raw !== 'string') return null;
  // Strip control characters (they belong to no name and wreck every log line downstream), then trim.
  const trimmed = [...raw].filter((ch) => ch.codePointAt(0) >= 0x20 && ch.codePointAt(0) !== 0x7f).join('').trim();
  if (!trimmed || trimmed.length > MAX_USERNAME) return null;
  return trimmed;
}

/** An avatar reference is a server-generated file name, never a path the caller chose. Anything with
 *  a separator or a parent segment in it is a traversal attempt and is refused. */
function normalizeAvatar(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) return null;
  return trimmed;
}

/** One record rebuilt from scratch: role, username, avatar, and nothing whatsoever else. */
function sanitize(role, raw) {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    role,
    username: normalizeUsername(record.username) ?? DEFAULT_USERNAMES[role],
    avatar: normalizeAvatar(record.avatar),
  };
}

/** Both accounts, always — the two roles in a fixed order, whatever the disk says.
 *
 *  Never throws. A missing file, an unparseable one, a file holding the wrong shape, or one whose
 *  two usernames collide all yield the defaults: a preferences file is not worth an outage, and two
 *  people who cannot be told apart is not a state this returns. */
export function readAccounts(dataDir) {
  if (!dataDir) return defaultAccounts();
  const path = accountsPath(dataDir);
  if (!existsSync(path)) return defaultAccounts();

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return defaultAccounts(); // a truncated write, or a file someone opened and saved from Notepad
  }
  const list = Array.isArray(parsed?.accounts) ? parsed.accounts : null;
  if (!list) return defaultAccounts();

  const accounts = ROLES.map((role) => sanitize(role, list.find((a) => a && a.role === role)));
  if (collides(accounts)) return defaultAccounts();
  return accounts;
}

/** Do any two records answer to the same name? Compared case-insensitively: "jirka" and "Jirka" are
 *  the same person to everyone reading a marker, so they must not be two accounts. */
function collides(accounts) {
  const seen = new Set();
  for (const { username } of accounts) {
    const key = username.toLocaleLowerCase('cs');
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/** The record for one role, from disk. Always returns a record — an unknown role is the caller's bug
 *  and says so, rather than returning an account-shaped nothing. */
export function readAccount(dataDir, role) {
  if (!ROLES.includes(role)) throw new AccountError(`unknown role ${JSON.stringify(role)} — expected one of ${ROLES.join(', ')}.`);
  return readAccounts(dataDir).find((a) => a.role === role);
}

/** Persist both records. Sanitized field by field, so nothing credential-shaped can reach the disk
 *  even if a caller hands one in. Written 0o600: this is a shared mount. */
export function writeAccounts(dataDir, accounts) {
  if (!dataDir) throw new AccountError('an accounts data directory is required (config.accounts.dataDir).');
  const clean = ROLES.map((role) => sanitize(role, accounts?.find?.((a) => a && a.role === role)));
  if (collides(clean)) {
    throw new AccountError('both accounts would answer to the same username — pick a different one.');
  }
  mkdirSync(dataDir, { recursive: true });
  const body = JSON.stringify({ version: 1, accounts: clean.map(pick) }, null, 2);
  writeFileSync(accountsPath(dataDir), body + '\n', { encoding: 'utf8', mode: 0o600 });
  return clean;
}

/** The persisted projection of a record — the allowlist, applied one last time at the write. */
const pick = (record) => Object.fromEntries(PERSISTED_FIELDS.map((f) => [f, record[f] ?? null]));

/** Change one person's username and/or avatar, refusing a name the other person already answers to.
 *  Returns the updated record. Fields left undefined are kept as they are; `avatar: null` clears it. */
export function updateAccount(dataDir, role, { username, avatar } = {}) {
  if (!ROLES.includes(role)) throw new AccountError(`unknown role ${JSON.stringify(role)} — expected one of ${ROLES.join(', ')}.`);
  const accounts = readAccounts(dataDir);
  const current = accounts.find((a) => a.role === role);

  if (username !== undefined) {
    const name = normalizeUsername(username);
    if (!name) {
      throw new AccountError(`a username is required — 1 to ${MAX_USERNAME} characters, and not only spaces.`);
    }
    const taken = accounts.some((a) => a.role !== role && a.username.toLocaleLowerCase('cs') === name.toLocaleLowerCase('cs'));
    if (taken) throw new AccountError(`the username ${JSON.stringify(name)} is already the other account's — pick a different one.`);
    current.username = name;
  }
  if (avatar !== undefined) current.avatar = normalizeAvatar(avatar);

  writeAccounts(dataDir, accounts);
  return current;
}
