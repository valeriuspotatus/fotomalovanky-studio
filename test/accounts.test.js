import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import {
  readAccounts,
  readAccount,
  writeAccounts,
  updateAccount,
  defaultAccounts,
  accountsPath,
  normalizeUsername,
  DEFAULT_USERNAMES,
  AccountError,
} from '../src/auth/accounts.js';
import { validateConfig, defaultAccountsDir, ConfigError } from '../src/config.js';

/** A real directory on disk, cleaned up in a finally — nothing here touches the repo tree. */
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'fma-accounts-'));
  return { dir: join(root, 'accounts'), root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

/** Write raw bytes where the account file belongs, for the "someone hand-edited it" cases. */
const putRaw = (dir, body) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(accountsPath(dir), body);
};

const byRole = (accounts, role) => accounts.find((a) => a.role === role);

const goodConfig = {
  generator: { baseUrl: 'https://gen.example/token' },
  builder: { baseUrl: 'https://build.example/' },
};

test('a written account reads back with its username and its avatar reference', () => {
  const f = fixture();
  try {
    writeAccounts(f.dir, [
      { role: 'operator', username: 'Davídek', avatar: 'operator-a1b2c3.webp' },
      { role: 'printer', username: 'Jirka', avatar: null },
    ]);
    const accounts = readAccounts(f.dir);
    assert.equal(accounts.length, 2, 'both roles are always present');
    assert.deepEqual(byRole(accounts, 'operator'), { role: 'operator', username: 'Davídek', avatar: 'operator-a1b2c3.webp' }, 'the operator round-trips with its accented name and avatar');
    assert.deepEqual(byRole(accounts, 'printer'), { role: 'printer', username: 'Jirka', avatar: null }, 'the printer round-trips with no avatar');
    assert.equal(readAccount(f.dir, 'printer').username, 'Jirka', 'a single role reads back on its own');
  } finally {
    f.cleanup();
  }
});

test('a missing account file yields the default usernames rather than throwing, the way an older install behaves', () => {
  const f = fixture();
  try {
    assert.equal(existsSync(f.dir), false, 'the fixture starts with no data directory at all');
    assert.deepEqual(readAccounts(f.dir), defaultAccounts(), 'no file means the defaults');
    assert.equal(readAccount(f.dir, 'operator').username, DEFAULT_USERNAMES.operator, 'the operator falls back to David');
    assert.equal(readAccount(f.dir, 'printer').username, DEFAULT_USERNAMES.printer, 'the printer falls back to Jirka');
  } finally {
    f.cleanup();
  }
});

test('a malformed account file yields the defaults rather than throwing', () => {
  for (const body of ['', '{', 'not json at all', '[]', '{"accounts":"nope"}', '{"accounts":[null,7,"x"]}', '{"version":1}']) {
    const f = fixture();
    try {
      putRaw(f.dir, body);
      assert.deepEqual(readAccounts(f.dir), defaultAccounts(), `a file holding ${JSON.stringify(body)} must fall back to the defaults`);
    } finally {
      f.cleanup();
    }
  }
});

test('a file whose two accounts answer to the same name is not trusted, and yields the defaults', () => {
  const f = fixture();
  try {
    putRaw(f.dir, JSON.stringify({ version: 1, accounts: [{ role: 'operator', username: 'Jirka' }, { role: 'printer', username: 'jirka' }] }));
    assert.deepEqual(readAccounts(f.dir), defaultAccounts(), 'two people who cannot be told apart is not a state this returns');
  } finally {
    f.cleanup();
  }
});

test('a username colliding with the other role’s is rejected', () => {
  const f = fixture();
  try {
    writeAccounts(f.dir, defaultAccounts());
    assert.throws(
      () => updateAccount(f.dir, 'operator', { username: 'Jirka' }),
      (err) => err instanceof AccountError && err.seam === 'accounts' && /already/.test(err.message),
      'taking the printer’s name must be refused',
    );
    assert.throws(
      () => updateAccount(f.dir, 'operator', { username: '  jIrKa ' }),
      (err) => err instanceof AccountError,
      'a differently-cased, space-padded collision is still a collision',
    );
    assert.equal(readAccount(f.dir, 'operator').username, DEFAULT_USERNAMES.operator, 'the refused rename left the file untouched');

    // Renaming to something free still works, and keeping your own name is not a collision with yourself.
    assert.equal(updateAccount(f.dir, 'operator', { username: 'David N.' }).username, 'David N.', 'a free name is accepted');
    assert.equal(updateAccount(f.dir, 'printer', { username: 'Jirka' }).username, 'Jirka', 'keeping your own name is not a collision');
    assert.throws(() => writeAccounts(f.dir, [{ role: 'operator', username: 'Same' }, { role: 'printer', username: 'Same' }]), AccountError, 'a colliding pair cannot be written directly either');
  } finally {
    f.cleanup();
  }
});

test('an empty or control-character-only username is refused rather than written', () => {
  const f = fixture();
  try {
    writeAccounts(f.dir, defaultAccounts());
    for (const bad of ['', '   ', '\u0000\u0001', 'x'.repeat(41), 42, null]) {
      assert.throws(() => updateAccount(f.dir, 'operator', { username: bad }), AccountError, `${JSON.stringify(bad)} is not a usable username`);
    }
    assert.equal(normalizeUsername('  Jiří  '), 'Jiří', 'a real name survives normalization with its accents');
  } finally {
    f.cleanup();
  }
});

test('nothing resembling a password or a hash is persisted, even when a caller hands one in', () => {
  const f = fixture();
  try {
    writeAccounts(f.dir, [
      { role: 'operator', username: 'David', avatar: 'op.webp', password: 'hunter2', passwordHash: 'scrypt$17$8$1$AAAA$BBBB', token: 'shpat_x' },
      { role: 'printer', username: 'Jirka', avatar: null, pass: 'let-me-in' },
    ]);
    const raw = readFileSync(accountsPath(f.dir), 'utf8');

    for (const leaked of ['hunter2', 'scrypt', 'let-me-in', 'shpat_x']) {
      assert.ok(!raw.includes(leaked), `the account file must not contain ${leaked} — credentials live only in the environment`);
    }
    for (const shape of [/password/i, /passwd/i, /\bhash\b/i, /secret/i, /token/i, /salt/i]) {
      assert.ok(!shape.test(raw), `the account file must hold no field matching ${shape} — see KTD1`);
    }
    const parsed = JSON.parse(raw);
    for (const record of parsed.accounts) {
      assert.deepEqual(Object.keys(record).sort(), ['avatar', 'role', 'username'], 'exactly three fields are persisted per record');
    }
  } finally {
    f.cleanup();
  }
});

test('the account file is written 0600, because the disk it lives on is shared', {
  skip: platform() === 'win32' ? 'Windows reports 666 for chmod 0600' : false,
}, () => {
  const f = fixture();
  try {
    writeAccounts(f.dir, defaultAccounts());
    const mode = statSync(accountsPath(f.dir)).mode & 0o777;
    assert.equal(mode.toString(8), '600', 'the account file must not be world-readable on the mounted disk');
  } finally {
    f.cleanup();
  }
});

test('an avatar reference that tries to escape its directory is dropped rather than stored', () => {
  const f = fixture();
  try {
    writeAccounts(f.dir, [
      { role: 'operator', username: 'David', avatar: '../../etc/passwd' },
      { role: 'printer', username: 'Jirka', avatar: 'sub/dir.webp' },
    ]);
    const accounts = readAccounts(f.dir);
    assert.equal(byRole(accounts, 'operator').avatar, null, 'a parent-segment avatar reference is refused');
    assert.equal(byRole(accounts, 'printer').avatar, null, 'a path-bearing avatar reference is refused');
  } finally {
    f.cleanup();
  }
});

test('an unknown role is the caller’s bug and says so', () => {
  const f = fixture();
  try {
    assert.throws(() => readAccount(f.dir, 'admin'), (err) => err instanceof AccountError && err.seam === 'accounts', 'there are exactly two roles');
    assert.throws(() => updateAccount(f.dir, 'admin', { username: 'x' }), AccountError, 'and no third one can be renamed into existence');
  } finally {
    f.cleanup();
  }
});

test('the resolved accounts.dataDir is an absolute path outside the repo tree', () => {
  const cfg = validateConfig(goodConfig);
  assert.ok(isAbsolute(cfg.accounts.dataDir), 'the accounts dir must be absolute');
  assert.ok(!cfg.accounts.dataDir.startsWith(process.cwd()), `accounts dir ${cfg.accounts.dataDir} is inside the repo`);
});

test('an accounts.dataDir INSIDE the repo tree is rejected by config validation (it holds people’s names and photos)', () => {
  for (const inside of ['./accounts', 'accounts', 'src/auth/data', '.']) {
    assert.throws(
      () => validateConfig({ ...goodConfig, accounts: { dataDir: inside } }),
      (err) => err instanceof ConfigError && /accounts\.dataDir/.test(err.message) && /inside the project tree/.test(err.message),
      `expected ${inside} to be rejected`,
    );
  }
});

test('defaultAccountsDir places the account file under an OS per-user data dir, never the cwd', () => {
  const norm = (p) => p.replace(/\\/g, '/');
  assert.match(norm(defaultAccountsDir({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'win32', 'C:\\Users\\x')), /AppData\/Local\/fotomalovanky\/accounts$/);
  assert.match(norm(defaultAccountsDir({ XDG_DATA_HOME: '/home/x/.local/share' }, 'linux', '/home/x')), /\.local\/share\/fotomalovanky\/accounts$/);
  assert.match(norm(defaultAccountsDir({}, 'darwin', '/Users/x')), /Library\/Application Support\/fotomalovanky\/accounts$/);
});
