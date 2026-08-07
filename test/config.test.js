import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { validateConfig, redactForLog, ConfigError, loadConfig, defaultAutopilotDir, assertPersistentDataDirs } from '../src/config.js';

const good = {
  generator: { baseUrl: 'https://fotomalovanky-app.onrender.com/abc123/', mode: 'api', variant: '1024' },
  builder: { baseUrl: 'https://fotomalovanky-service.onrender.com/' },
};

test('validateConfig accepts a well-formed config and applies defaults', () => {
  const cfg = validateConfig(good);
  assert.equal(cfg.generator.baseUrl, good.generator.baseUrl);
  assert.equal(cfg.generator.diffusionSteps, 4);
  assert.equal(cfg.retentionDays, 30);
  assert.equal(cfg.manualTouchThreshold, null);
});

test('validateConfig rejects a missing generator URL', () => {
  assert.throws(() => validateConfig({ builder: { baseUrl: 'https://x/' } }), ConfigError);
});

test('validateConfig rejects a placeholder generator URL', () => {
  assert.throws(
    () => validateConfig({ generator: { baseUrl: 'https://fotomalovanky-app.onrender.com/REPLACE_WITH_YOUR_TOKEN/' }, builder: { baseUrl: 'https://x/' } }),
    ConfigError,
  );
});

test('validateConfig rejects an invalid generator.mode', () => {
  assert.throws(() => validateConfig({ ...good, generator: { ...good.generator, mode: 'magic' } }), ConfigError);
});

test('validateConfig rejects a non-positive retentionDays', () => {
  assert.throws(() => validateConfig({ ...good, retentionDays: 0 }), ConfigError);
});

test('validateConfig defaults the AI image + describe models when ai is off', () => {
  const cfg = validateConfig(good);
  assert.equal(cfg.ai.enabled, false);
  assert.equal(cfg.ai.model, 'gemini-3-pro-image-preview');
  assert.equal(cfg.ai.describeModel, 'gemini-flash-lite-latest');
  assert.equal(cfg.ai.describeInstruction, null);
});

test('validateConfig keeps an overridden describeModel and describeInstruction', () => {
  const cfg = validateConfig({ ...good, ai: { enabled: true, apiKey: 'k', describeModel: 'gemini-2.5-pro', describeInstruction: 'be brief' } });
  assert.equal(cfg.ai.describeModel, 'gemini-2.5-pro');
  assert.equal(cfg.ai.describeInstruction, 'be brief');
});

test('redactForLog masks the token-scoped URL', () => {
  const redacted = redactForLog(validateConfig(good));
  assert.ok(!redacted.generator.baseUrl.includes('abc123'), 'token must not appear in redacted URL');
  assert.match(redacted.generator.baseUrl, /<redacted>/);
});

test('loadConfig throws a clear error when the file is missing', () => {
  assert.throws(() => loadConfig('/definitely/not/here/config.json'), ConfigError);
});

// ---- per-order delivery format (U9) -----------------------------------------

test('delivery.format defaults to gallery when no delivery or builder mode is set', () => {
  assert.equal(validateConfig(good).delivery.format, 'gallery');
});

test('delivery.format mirrors the existing builder.pdf.mode when delivery.format is absent', () => {
  const cfg = validateConfig({ ...good, builder: { ...good.builder, pdf: { mode: 'fullpage' } } });
  assert.equal(cfg.delivery.format, 'fullpage', 'turning delivery on must not change an order the map does not cover');
});

test('delivery.format rejects an unknown layout', () => {
  assert.throws(() => validateConfig({ ...good, delivery: { format: 'poster' } }), ConfigError);
});

test('delivery.formatMap passes valid variant->mode entries through and rejects a typoed mode', () => {
  const cfg = validateConfig({ ...good, delivery: { formatMap: { 'Fotomalovánky 4 fotky': 'gallery', celo: 'fullpage' } } });
  assert.deepEqual(cfg.delivery.formatMap, { 'Fotomalovánky 4 fotky': 'gallery', celo: 'fullpage' });
  assert.throws(() => validateConfig({ ...good, delivery: { formatMap: { x: 'galery' } } }), ConfigError);
});

test('maxDiffusionSteps defaults to 12 and must leave room above diffusionSteps', () => {
  assert.equal(validateConfig(good).generator.maxDiffusionSteps, 12);

  const withSteps = (diffusionSteps, maxDiffusionSteps) =>
    validateConfig({ ...good, generator: { ...good.generator, diffusionSteps, maxDiffusionSteps } });

  assert.equal(withSteps(8, 10).generator.maxDiffusionSteps, 10);
  assert.equal(withSteps(8, 8).generator.maxDiffusionSteps, 8, 'equal means "no re-rolls", which is legal');
  assert.throws(() => withSteps(8, 7), ConfigError, 'a ceiling below the floor is a typo, not a policy');
  assert.throws(() => withSteps(8, 9.5), ConfigError);
});

// ---- Overnight autopilot: the shopify block (U1) ----------------------------

// Every shopify test drives token resolution through config only — clear the env var first so a
// token in the developer's own shell can't mask a "missing token" assertion.
const noEnvToken = () => {
  delete process.env.FMA_SHOPIFY_TOKEN;
};

test('shopify is disabled by default and needs no store or token', () => {
  noEnvToken();
  const cfg = validateConfig(good);
  assert.equal(cfg.shopify.enabled, false);
  assert.equal(cfg.shopify.storeDomain, null);
  assert.equal(cfg.shopify.accessToken, null);
});

test('shopify.enabled=true without a storeDomain is a clear error naming the missing key', () => {
  noEnvToken();
  assert.throws(
    () => validateConfig({ ...good, shopify: { enabled: true, accessToken: 'shpat_x' } }),
    (err) => err instanceof ConfigError && /shopify\.storeDomain/.test(err.message),
  );
});

test('shopify.enabled=true without an accessToken (config or env) is a clear error naming the missing key', () => {
  noEnvToken();
  assert.throws(
    () => validateConfig({ ...good, shopify: { enabled: true, storeDomain: 'aqi8it-7n.myshopify.com' } }),
    (err) => err instanceof ConfigError && /shopify\.accessToken/.test(err.message),
  );
});

test('a placeholder accessToken counts as no token', () => {
  noEnvToken();
  assert.throws(
    () => validateConfig({ ...good, shopify: { enabled: true, storeDomain: 'x.myshopify.com', accessToken: 'REPLACE_WITH_READ_ORDERS_TOKEN' } }),
    (err) => err instanceof ConfigError && /shopify\.accessToken/.test(err.message),
  );
});

test('the accessToken resolves from the FMA_SHOPIFY_TOKEN env var when config omits it', () => {
  noEnvToken();
  process.env.FMA_SHOPIFY_TOKEN = 'shpat_from_env_123';
  try {
    const cfg = validateConfig({ ...good, shopify: { enabled: true, storeDomain: 'x.myshopify.com' } });
    assert.equal(cfg.shopify.accessToken, 'shpat_from_env_123');
  } finally {
    noEnvToken();
  }
});

test('shopify defaults are applied when omitted (api version, matchers, allowlist, spend)', () => {
  noEnvToken();
  const cfg = validateConfig({ ...good, shopify: { enabled: true, storeDomain: 'x.myshopify.com', accessToken: 'shpat_x' } });
  assert.equal(cfg.shopify.apiVersion, '2026-07');
  assert.equal(cfg.shopify.photoKeyMatch, 'fotka');
  assert.equal(cfg.shopify.dedicationKeyMatch, 'věnování');
  assert.equal(cfg.shopify.layoutKeyMatch, 'rozvržení');
  assert.deepEqual(cfg.shopify.photoHostAllowlist, ['cdn.tigren.com']);
  assert.equal(cfg.shopify.estSpendPerOrder, 0.3);
  assert.equal(cfg.shopify.autoFetchMinutes, 10); // auto-poll on by default
});

test('shopify.autoFetchMinutes: honored when set, 0 disables, invalid falls back to default', () => {
  noEnvToken();
  const base = { enabled: true, storeDomain: 'x.myshopify.com', accessToken: 'shpat_x' };
  assert.equal(validateConfig({ ...good, shopify: { ...base, autoFetchMinutes: 5 } }).shopify.autoFetchMinutes, 5);
  assert.equal(validateConfig({ ...good, shopify: { ...base, autoFetchMinutes: 0 } }).shopify.autoFetchMinutes, 0); // off
  assert.equal(validateConfig({ ...good, shopify: { ...base, autoFetchMinutes: -3 } }).shopify.autoFetchMinutes, 10); // invalid → default
  assert.equal(validateConfig({ ...good, shopify: { ...base, autoFetchMinutes: 'soon' } }).shopify.autoFetchMinutes, 10);
});

test('redactForLog drops the shopify access token entirely', () => {
  noEnvToken();
  const cfg = validateConfig({ ...good, shopify: { enabled: true, storeDomain: 'x.myshopify.com', accessToken: 'shpat_super_secret' } });
  const redacted = redactForLog(cfg);
  const json = JSON.stringify(redacted);
  assert.ok(!json.includes('shpat_super_secret'), 'the token must never appear in redacted output');
  assert.equal(redacted.shopify.accessToken, '<redacted>');
});

test('the resolved shopify.dataDir is an absolute path outside the repo tree', () => {
  noEnvToken();
  const cfg = validateConfig(good);
  assert.ok(isAbsolute(cfg.shopify.dataDir), 'data dir must be absolute');
  assert.ok(!cfg.shopify.dataDir.startsWith(process.cwd()), `data dir ${cfg.shopify.dataDir} is inside the repo`);
});

test('an explicit shopify.dataDir INSIDE the repo tree is rejected (holds customer PII)', () => {
  noEnvToken();
  for (const inside of ['./autopilot', 'autopilot', 'sub/state', '.']) {
    assert.throws(
      () => validateConfig({ ...good, shopify: { enabled: true, storeDomain: 'x.myshopify.com', accessToken: 'shpat_x', dataDir: inside } }),
      (err) => err instanceof ConfigError && /dataDir/.test(err.message) && /inside the project tree/.test(err.message),
      `expected ${inside} to be rejected`,
    );
  }
});

test('defaultAutopilotDir places state under an OS per-user data dir, never the cwd', () => {
  const norm = (p) => p.replace(/\\/g, '/');
  const win = defaultAutopilotDir({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'win32', 'C:\\Users\\x');
  assert.match(norm(win), /AppData\/Local\/fotomalovanky\/autopilot$/);
  const linux = defaultAutopilotDir({ XDG_DATA_HOME: '/home/x/.local/share' }, 'linux', '/home/x');
  assert.match(norm(linux), /\.local\/share\/fotomalovanky\/autopilot$/);
  const mac = defaultAutopilotDir({}, 'darwin', '/Users/x');
  assert.match(norm(mac), /Library\/Application Support\/fotomalovanky\/autopilot$/);
});

// ---- data that must survive a redeploy --------------------------------------

const hosted = (over = {}) => ({
  paths: { inbox: '/data/inbox', outbox: '/data/outbox' },
  accounts: { dataDir: '/data/accounts' },
  shopify: { dataDir: '/data/autopilot' },
  creatives: { dataDir: '/data/creatives' },
  blog: { dataDir: '/data/blog' },
  ...over,
});

test('a laptop is left alone — its per-user data directory outlives the process', () => {
  // The whole point of the OS data dir is that it persists. Firing there would be wrong, and would
  // make every local run demand a /data that does not exist.
  const local = hosted({ accounts: { dataDir: 'C:\Users\David\AppData\Local\fotomalovanky\accounts' } });
  for (const host of ['127.0.0.1', 'localhost', '::1', undefined]) {
    assert.doesNotThrow(() => assertPersistentDataDirs({ config: local, env: {}, bindHost: host }), `${host} is this machine`);
  }
});

test('a hosted bind with everything on the disk starts', () => {
  assert.doesNotThrow(() => assertPersistentDataDirs({ config: hosted(), env: {}, bindHost: '0.0.0.0' }));
});

test('a hosted bind with an off-disk directory refuses to start, and names it', () => {
  // This is the failure with no symptom: the app boots, writes to scratch space, serves correctly,
  // and loses it on the next deploy. The only trace was two profile photos going missing.
  const bad = hosted({ accounts: { dataDir: '/root/.local/share/fotomalovanky/accounts' } });
  assert.throws(
    () => assertPersistentDataDirs({ config: bad, env: {}, bindHost: '0.0.0.0' }),
    (err) => err instanceof ConfigError
      && /Refusing to start/.test(err.message)
      && /accounts\.dataDir = \/root\/\.local/.test(err.message)
      && /survives a redeploy/.test(err.message),
    'it must say which key and which path',
  );
});

test('every directory at risk is reported at once, not one per restart', () => {
  const bad = hosted({
    accounts: { dataDir: '/root/accounts' },
    shopify: { dataDir: '/root/autopilot' },
    paths: { inbox: '/data/inbox', outbox: '/tmp/outbox' },
  });
  try {
    assertPersistentDataDirs({ config: bad, env: {}, bindHost: '0.0.0.0' });
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /3 data directories/);
    for (const k of ['accounts.dataDir', 'shopify.dataDir', 'paths.outbox']) assert.ok(err.message.includes(k), `${k} named`);
    assert.ok(!err.message.includes('paths.inbox'), 'and the one that is fine is not');
  }
});

test('the autopilot handled map is guarded too — losing it makes a finished week look new', () => {
  const bad = hosted({ shopify: { dataDir: '/root/autopilot' } });
  assert.throws(() => assertPersistentDataDirs({ config: bad, env: {}, bindHost: '0.0.0.0' }), /shopify\.dataDir/);
});

test('FMA_DATA_ROOT moves the mount, it does not switch the check off', () => {
  const cfg = hosted({ accounts: { dataDir: '/mnt/disk/accounts' }, paths: { inbox: '/mnt/disk/in', outbox: '/mnt/disk/out' },
    shopify: { dataDir: '/mnt/disk/a' }, creatives: { dataDir: '/mnt/disk/c' }, blog: { dataDir: '/mnt/disk/b' } });
  assert.doesNotThrow(() => assertPersistentDataDirs({ config: cfg, env: { FMA_DATA_ROOT: '/mnt/disk' }, bindHost: '0.0.0.0' }));
  // Pointing it at scratch is the same mistake spelled out, so the check still applies to the rest.
  assert.throws(() => assertPersistentDataDirs({ config: hosted(), env: { FMA_DATA_ROOT: '/mnt/disk' }, bindHost: '0.0.0.0' }), /Refusing to start/);
});

test('a directory the config never set is not invented, and never blamed', () => {
  // An install with no creatives or blog block has nothing to lose there.
  const sparse = { paths: { inbox: '/data/inbox', outbox: '/data/outbox' }, accounts: { dataDir: '/data/accounts' } };
  assert.doesNotThrow(() => assertPersistentDataDirs({ config: sparse, env: {}, bindHost: '0.0.0.0' }));
  assert.doesNotThrow(() => assertPersistentDataDirs({ config: {}, env: {}, bindHost: '0.0.0.0' }));
});

test('autoRunSeconds reaches the server, so 0 can actually stop the inbox sweep', () => {
  // server.js has always read `config.autoRunSeconds` and its own comment has always said 0
  // disables auto-run — but the key was not carried through the loader, so the switch could not be
  // reached from config.json and every instance swept on the 15-second default. That is only a
  // curiosity while the studio runs in one place; with a second instance polling the same shop it
  // is two machines generating the same orders against the same GPU account.
  assert.equal(validateConfig({ ...good, autoRunSeconds: 0 }).autoRunSeconds, 0, 'zero survives the loader');
  assert.equal(validateConfig({ ...good, autoRunSeconds: 30 }).autoRunSeconds, 30);
  assert.equal(validateConfig(good).autoRunSeconds, undefined, 'unset leaves the server on its own default');
  assert.equal(validateConfig({ ...good, autoRunSeconds: -5 }).autoRunSeconds, undefined, 'and nonsense does not become a timer');
});

test('a remote mailbox must be reached over TLS, or the config is refused', () => {
  // secure:false is right for Proton Bridge on loopback — nothing can intercept traffic that never
  // leaves the machine. Against a real host it puts the mailbox password and every customer's mail
  // on the wire in the clear, so it is refused at load rather than left to "work".
  const mail = { enabled: true, user: 'info@fotomalovanky.cz', pass: 'x' };

  assert.doesNotThrow(() => validateConfig({ ...good, mail: { ...mail } }), 'Bridge on the default loopback host is fine');
  assert.doesNotThrow(() => validateConfig({ ...good, mail: { ...mail, host: '127.0.0.1', secure: false } }));
  assert.doesNotThrow(() => validateConfig({ ...good, mail: { ...mail, host: 'imap.migadu.com', port: 993, secure: true } }), 'and a remote host over TLS is fine');

  assert.throws(
    () => validateConfig({ ...good, mail: { ...mail, host: 'imap.migadu.com', port: 143, secure: false } }),
    /mail\.secure must be true/,
    'a remote host without TLS is refused',
  );
});
