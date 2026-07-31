import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  verifyRolePassword,
  hashForRole,
  credentialsConfigured,
  deriveKey,
  ROLES,
  ROLE_ENV_VARS,
  SCRYPT_PARAMS,
  CredentialError,
} from '../src/auth/credentials.js';

// Everything below runs at the REAL production cost (N=2^17, r=8, p=1). That is the point of this
// file: at those parameters scrypt needs ~128 MiB and Node's default `maxmem` is 32 MiB, so the
// call throws unless the limit is raised. A test at toy parameters passes happily and leaves the
// failure for production, on the one login that matters. Each derivation costs the best part of a
// second, so the fixtures below are computed once and shared.

const PASSWORD = 'a passphrase Jirka can actually remember';

let productionHashPromise = null;
/** One production-parameter hash of PASSWORD, computed lazily and reused across tests. */
const productionHash = () => (productionHashPromise ??= hashPassword(PASSWORD));

/** An env holding only the roles named, so a test never inherits the developer's real shell. */
const envWith = (roles = {}) => {
  const env = {};
  for (const [role, hash] of Object.entries(roles)) env[ROLE_ENV_VARS[role]] = hash;
  return env;
};

/** Wraps the real derivation so a test can count how many times it actually ran. Wrapping rather
 *  than stubbing keeps the production parameters in play. */
const countingDerive = () => {
  const calls = { count: 0 };
  const derive = (password, salt, params) => {
    calls.count += 1;
    return deriveKey(password, salt, params);
  };
  return { calls, derive };
};

test('a password hashed at the production parameters verifies against itself without hitting the scrypt memory ceiling', async () => {
  const stored = await productionHash();
  assert.match(stored, /^scrypt\$17\$8\$1\$/, 'the stored form must carry the production cost parameters');
  assert.equal(SCRYPT_PARAMS.logN, 17, 'the module must be configured at OWASP N=2^17, not a reduced cost');
  assert.equal(await verifyPassword(PASSWORD, stored), true, 'the password that produced the hash must verify against it');
});

test('the same parameters without a raised maxmem throw, which is the whole reason the module sets one', async () => {
  // Pins the ceiling this unit exists to clear. If a future Node raises the default past 128 MiB
  // this test starts failing — at which point the `maxmem` argument is merely belt-and-braces rather
  // than load-bearing, and someone should read this comment before deleting it.
  const { scrypt } = await import('node:crypto');
  const N = 2 ** SCRYPT_PARAMS.logN;
  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        try {
          scrypt('pw', Buffer.alloc(16), 32, { N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p }, (err, key) => (err ? reject(err) : resolve(key)));
        } catch (err) {
          reject(err);
        }
      }),
    (err) => err.code === 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS',
    `scrypt at N=2^${SCRYPT_PARAMS.logN}, r=${SCRYPT_PARAMS.r} must exceed Node's default 32 MiB ceiling`,
  );
  // And the module's own path, which raises it, does not.
  assert.equal(await verifyPassword(PASSWORD, await productionHash()), true, 'the raised ceiling makes the same parameters work');
});

test('two hashes of the same password differ, because each carries its own random salt', async () => {
  const a = await productionHash();
  const b = await hashPassword(PASSWORD);
  assert.notEqual(a, b, 'a per-hash random salt must make identical passwords hash differently');
  assert.equal(await verifyPassword(PASSWORD, b), true, 'the second hash must still verify the same password');
});

test('a wrong password fails to verify', async () => {
  const stored = await productionHash();
  assert.equal(await verifyPassword('not the passphrase', stored), false, 'a wrong password must not verify');
  assert.equal(await verifyPassword('', stored), false, 'an empty password must not verify');
  assert.equal(await verifyPassword(undefined, stored), false, 'a missing password must not verify');
});

test('a hash carrying different cost parameters still verifies, proving the stored form is self-describing', async () => {
  // A cheap cost stands in for "hashed before the cost was raised". Verification must read the
  // parameters out of the string rather than assume today's constants.
  const cheap = await hashPassword(PASSWORD, { logN: 14, r: 8, p: 1 });
  assert.match(cheap, /^scrypt\$14\$8\$1\$/, 'the altered cost must be recorded in the stored string');
  assert.equal(await verifyPassword(PASSWORD, cheap), true, 'a hash made at an older cost must still verify');
  assert.equal(await verifyPassword('wrong', cheap), false, 'and a wrong password must still fail at that cost');

  const stored = await productionHash();
  assert.equal(await verifyPassword(PASSWORD, stored), true, 'the production-cost hash is unaffected by the cheap one');
});

test('a malformed or truncated stored hash fails closed rather than throwing', async () => {
  const stored = await productionHash();
  const malformed = [
    '',
    'not-a-hash',
    'scrypt$17$8$1$onlyfourfields',
    stored.slice(0, stored.length - 10), // truncated hash segment
    stored.replace('scrypt$', 'argon2$'), // an algorithm this module never wrote
    'scrypt$abc$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    'scrypt$99$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', // absurd cost
    null,
    undefined,
    { hash: stored },
  ];
  for (const bad of malformed) {
    assert.equal(await verifyPassword(PASSWORD, bad), false, `a malformed stored hash (${JSON.stringify(bad)}) must fail closed`);
  }
});

test('hashing refuses an empty password rather than producing a hash nobody can use', async () => {
  await assert.rejects(() => hashPassword(''), (err) => err instanceof CredentialError && err.seam === 'credentials', 'an empty password must be refused');
});

test('a password verifies against the hash configured for its role in the environment', async () => {
  const stored = await productionHash();
  const env = envWith({ operator: stored });
  assert.equal(await verifyRolePassword('operator', PASSWORD, { env }), true, "the operator's own password must verify");
  assert.equal(await verifyRolePassword('operator', 'wrong', { env }), false, 'a wrong password for a configured role must fail');
  assert.equal(hashForRole('operator', env), stored, 'the role must resolve to the hash in its own env var');
  assert.equal(hashForRole('printer', env), null, 'an unconfigured role must resolve to no hash');
});

test('missing environment configuration for a role fails closed', async () => {
  const empty = envWith({});
  for (const role of ROLES) {
    assert.equal(await verifyRolePassword(role, PASSWORD, { env: empty }), false, `${role} with no hash in the env must not sign in`);
    assert.equal(await verifyRolePassword(role, '', { env: empty }), false, `${role} with no hash must reject an empty password too`);
  }
  assert.equal(credentialsConfigured(empty), false, 'no configured role means the gate is not configured at all');
  assert.equal(credentialsConfigured(envWith({ printer: 'anything' })), true, 'one configured role is enough to turn the gate on');
});

test('an unknown or unconfigured role performs the full hashing work rather than returning early', async () => {
  // Covers AE4. The anti-enumeration property: "no such account" must not be measurably cheaper
  // than "wrong password", or the response time answers a question the app never should.
  const stored = await productionHash();
  const env = envWith({ operator: stored });

  const wrong = countingDerive();
  const wrongStart = process.hrtime.bigint();
  assert.equal(await verifyRolePassword('operator', 'wrong password', { env, derive: wrong.derive }), false);
  const wrongMs = Number(process.hrtime.bigint() - wrongStart) / 1e6;

  const unknown = countingDerive();
  const unknownStart = process.hrtime.bigint();
  assert.equal(await verifyRolePassword('nobody', PASSWORD, { env, derive: unknown.derive }), false);
  const unknownMs = Number(process.hrtime.bigint() - unknownStart) / 1e6;

  const unconfigured = countingDerive();
  assert.equal(await verifyRolePassword('printer', PASSWORD, { env, derive: unconfigured.derive }), false);

  assert.equal(wrong.calls.count, 1, 'a wrong password derives exactly once');
  assert.equal(unknown.calls.count, 1, 'an unknown role must derive once against the dummy hash, not return early');
  assert.equal(unconfigured.calls.count, 1, 'a role with no hash in the env must derive once too');
  // The counts are the real assertion; the timing floor is corroboration, kept generous so a loaded
  // CI box cannot make it flaky. An early return would be ~0ms against a ~500ms derivation.
  assert.ok(unknownMs > wrongMs * 0.25, `the unknown-role path took ${unknownMs.toFixed(0)}ms against ${wrongMs.toFixed(0)}ms for a wrong password — too fast to have hashed`);
});

test('neither the plaintext nor the stored hash leaks through an error message', async () => {
  const secret = 'sup3r-secret-passphrase';
  // A cost far past even the raised maxmem, so scrypt itself rejects — the same shape of failure the
  // unraised 32 MiB ceiling produces, and the one place an implementation might echo its inputs.
  await assert.rejects(
    () => hashPassword(secret, { logN: 20, r: 32, p: 1 }),
    (err) => {
      assert.ok(err instanceof CredentialError, 'a scrypt failure surfaces as a CredentialError');
      assert.equal(err.seam, 'credentials', 'the failure names its seam like the other drivers do');
      assert.ok(!String(err.message).includes(secret), 'the password must never appear in an error message');
      return true;
    },
    'a cost past the memory ceiling must fail without leaking the password',
  );
});
