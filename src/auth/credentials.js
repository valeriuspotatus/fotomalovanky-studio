// The password half of a sign-in. Nothing else in the app is allowed to know what a password is.
//
// Two people share this studio and the disk under it holds photographs of customers' children, so
// the credential rules are deliberately narrow:
//
//   - The hash lives in the Render environment, NEVER in the account file on the mounted disk
//     (KTD1). The disk is the one thing a backup, a support session or a stray `ls` can expose.
//   - The env is keyed by ROLE, not by username. Jirka renaming himself must not lock Jirka out,
//     and a password changed in Render must take effect on the very next attempt rather than being
//     shadowed by a username that no longer matches.
//   - `crypto.scrypt` at the OWASP cost — N=2^17, r=8, p=1 (KTD2). Node caps scrypt's memory at
//     32 MiB by default and these parameters need ~128 MiB, so the call THROWS unless `maxmem` is
//     raised explicitly. That failure would only ever appear in production, on the one login that
//     matters, so `MAXMEM` below is not a tuning knob — it is the reason this module has a test.
//   - The stored string carries its own cost parameters, so raising the cost later re-verifies old
//     hashes without a format migration.
//   - Verifying a role nobody configured still performs a full scrypt derivation against a dummy
//     hash before failing. An early return would make "no such role" measurably faster than "wrong
//     password" and hand an attacker a free oracle.
//
// Nothing here logs, throws or returns a plaintext password or a stored hash — an error message
// that quotes the credential is the leak this module exists to prevent.

import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** The two roles the studio knows. The account file (src/auth/accounts.js) keys off the same list. */
export const ROLES = Object.freeze(['operator', 'printer']);

/** Role -> the Render environment variable holding its scrypt hash. Role-keyed, never username-keyed. */
export const ROLE_ENV_VARS = Object.freeze({
  operator: 'STUDIO_OPERATOR_PASS_HASH',
  printer: 'STUDIO_PRINTER_PASS_HASH',
});

/** OWASP's current scrypt parameters (KTD2). `logN` is stored rather than N so the string stays short. */
export const SCRYPT_PARAMS = Object.freeze({ logN: 17, r: 8, p: 1 });
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** ~256 MiB. N=2^17 with r=8 needs roughly 128 MiB; Node's default ceiling is 32 MiB and the call
 *  throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS without this. Headroom so raising the cost one notch
 *  (logN 18) does not reintroduce the same failure. */
const MAXMEM = 256 * 1024 * 1024;

/** A real hash of a throwaway secret nobody holds, used so an unknown or unconfigured role spends
 *  the same scrypt work as a wrong password. Hard-coded rather than derived on demand: deriving it
 *  would double the work on that path and give the timing away from the other direction. */
const DUMMY_HASH = 'scrypt$17$8$1$PRvtJBwh0IV4R5w55nv33g==$zraKfAGzzztiSjDeNL/LmtNWEzJfi5Tj7K2T0AR/gB4=';

/** A credential-seam failure. Carries `seam` like the generator/builder/editor errors do, so a caller
 *  can name where it broke. Never carries the password or the hash. */
export class CredentialError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CredentialError';
    this.seam = 'credentials';
  }
}

/** Constant-time compare (length-guarded — timingSafeEqual throws on a length mismatch).
 *  Mirrors `safeEqual` in src/ui/server.js rather than inventing a second idiom. */
function safeEqualBytes(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Derive the scrypt key for a password + salt at the given cost. The one place `maxmem` is set —
 *  every caller goes through here so no future path can rediscover the 32 MiB ceiling the hard way. */
export function deriveKey(password, salt, { logN, r, p } = SCRYPT_PARAMS) {
  const fail = (err) => new CredentialError(`scrypt failed at N=2^${logN}, r=${r}, p=${p}: ${err.message}`);
  return new Promise((resolve, reject) => {
    try {
      // Parameter validation (including the maxmem ceiling) throws synchronously rather than
      // reaching the callback, so both paths have to be caught or the raw error escapes.
      scrypt(Buffer.from(String(password), 'utf8'), salt, KEY_BYTES, { N: 2 ** logN, r, p, maxmem: MAXMEM }, (err, key) => {
        if (err) reject(fail(err));
        else resolve(key);
      });
    } catch (err) {
      reject(fail(err));
    }
  });
}

/** Hash a plaintext password into the self-describing stored form:
 *  `scrypt$<logN>$<r>$<p>$<saltBase64>$<hashBase64>`. The parameters travel with the hash so the
 *  cost can be raised later and old hashes still verify. */
export async function hashPassword(password, params = SCRYPT_PARAMS) {
  if (typeof password !== 'string' || !password) {
    throw new CredentialError('a password is required (a non-empty string) to hash.');
  }
  const { logN, r, p } = params;
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(password, salt, { logN, r, p });
  return `scrypt$${logN}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Split a stored hash into its parts, or null when it is anything this module did not write.
 *  Null rather than a throw: a truncated env var must fail the sign-in, not crash the request. */
function parseStored(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.trim().split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, logNRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const logN = Number(logNRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (![logN, r, p].every((n) => Number.isInteger(n) && n > 0)) return null;
  // A hostile env var must not be able to ask for a derivation that exhausts the box.
  if (logN > 20 || r > 32 || p > 16) return null;
  let salt;
  let expected;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return null;
  }
  if (!salt.length || expected.length !== KEY_BYTES) return null;
  // Base64 silently ignores junk, so round-trip the encoding to reject a mangled string.
  if (salt.toString('base64') !== saltB64 || expected.toString('base64') !== hashB64) return null;
  return { logN, r, p, salt, expected };
}

/** Does `password` match `stored`? False for a malformed, truncated or missing stored hash — and
 *  false only after the same scrypt work a real comparison would have cost, so the two are not
 *  distinguishable by how long the answer took. */
export async function verifyPassword(password, stored, { derive = deriveKey } = {}) {
  const real = parseStored(stored);
  const parsed = real ?? parseStored(DUMMY_HASH);
  const key = await derive(typeof password === 'string' ? password : '', parsed.salt, parsed);
  const matched = safeEqualBytes(key, parsed.expected);
  return real !== null && matched;
}

/** The stored hash configured for a role, or null when the role is unknown or its env var is unset.
 *  Returned only so `verifyRolePassword` can consume it — never log this. */
export function hashForRole(role, env = process.env) {
  const name = ROLE_ENV_VARS[role];
  if (!name) return null;
  const raw = env[name];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** True when `password` is the password configured for `role`.
 *
 *  An unknown role, or a role with no hash in the environment, still runs a full derivation against
 *  the dummy hash before returning false (anti-enumeration): "no such account" and "wrong password"
 *  must cost the same. `derive` is injectable so a test can count derivations without replacing the
 *  production parameters. */
export async function verifyRolePassword(role, password, { env = process.env, derive = deriveKey } = {}) {
  const stored = hashForRole(role, env);
  return verifyPassword(password, stored ?? '', { derive });
}

/** True when at least one role has a password configured. The server uses this to decide whether the
 *  sign-in gate exists at all — an unconfigured local install opens straight in (R5). */
export function credentialsConfigured(env = process.env) {
  return ROLES.some((role) => hashForRole(role, env) !== null);
}

// CLI: node src/auth/credentials.js <password> — prints the value to paste into the Render env.
// The operator sets both passwords outside the app (R12); this is how they produce the hashes.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const password = process.argv[2];
  if (!password) {
    console.error('Usage: node src/auth/credentials.js <password>');
    console.error(`Paste the printed value into ${ROLE_ENV_VARS.operator} or ${ROLE_ENV_VARS.printer} in Render.`);
    process.exit(2);
  }
  hashPassword(password)
    .then((hash) => {
      console.log(hash);
    })
    .catch((err) => {
      // err.message never carries the password — see CredentialError.
      console.error(`Credentials seam failed: ${err.message}`);
      process.exit(1);
    });
}
