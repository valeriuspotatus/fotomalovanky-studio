import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { validateConfig, redactForLog, ConfigError, loadConfig, defaultSessionDir, defaultAutopilotDir } from '../src/config.js';

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
  assert.equal(cfg.ai.describeModel, 'gemini-flash-latest');
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

// ---- WhatsApp handoff + per-order delivery format (U1) ----------------------

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

test('whatsapp is disabled by default and needs no recipient', () => {
  const cfg = validateConfig(good);
  assert.equal(cfg.whatsapp.enabled, false);
  assert.equal(cfg.whatsapp.recipient, null);
});

test('whatsapp.enabled=true without a recipient is a clear error naming the missing key', () => {
  assert.throws(
    () => validateConfig({ ...good, whatsapp: { enabled: true } }),
    (err) => err instanceof ConfigError && /whatsapp\.recipient/.test(err.message),
  );
});

test('the resolved whatsapp.sessionDir is an absolute path outside the repo tree', () => {
  const cfg = validateConfig(good);
  assert.ok(isAbsolute(cfg.whatsapp.sessionDir), 'session dir must be absolute');
  // The LocalAuth store is a full-account credential; it must not sit inside the working tree.
  assert.ok(!cfg.whatsapp.sessionDir.startsWith(process.cwd()), `session dir ${cfg.whatsapp.sessionDir} is inside the repo`);
});

test('an explicit whatsapp.sessionDir OUTSIDE the repo is honoured and resolved to an absolute path', () => {
  const cfg = validateConfig({ ...good, whatsapp: { enabled: true, recipient: '420123456789@c.us', sessionDir: '../fma-wa-session-outside' } });
  assert.ok(isAbsolute(cfg.whatsapp.sessionDir));
  assert.match(cfg.whatsapp.sessionDir, /fma-wa-session-outside$/);
});

test('an explicit whatsapp.sessionDir INSIDE the repo tree is rejected (never committable)', () => {
  // The LocalAuth store is a full-account credential; .gitignore can't catch an arbitrary name.
  for (const inside of ['./wa-session', 'wa-session', 'sub/dir/session', '.']) {
    assert.throws(
      () => validateConfig({ ...good, whatsapp: { enabled: true, recipient: 'x@c.us', sessionDir: inside } }),
      (err) => err instanceof ConfigError && /sessionDir/.test(err.message) && /inside the project tree/.test(err.message),
      `expected ${inside} to be rejected`,
    );
  }
});

test('defaultSessionDir places the store under an OS per-user data dir, never the cwd', () => {
  // node:path join is OS-native, so compare separator-agnostically — the branch logic is the point.
  const norm = (p) => p.replace(/\\/g, '/');
  const win = defaultSessionDir({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'win32', 'C:\\Users\\x');
  assert.match(norm(win), /AppData\/Local\/fotomalovanky\/whatsapp-session$/);
  const linux = defaultSessionDir({ XDG_DATA_HOME: '/home/x/.local/share' }, 'linux', '/home/x');
  assert.match(norm(linux), /\.local\/share\/fotomalovanky\/whatsapp-session$/);
  const mac = defaultSessionDir({}, 'darwin', '/Users/x');
  assert.match(norm(mac), /Library\/Application Support\/fotomalovanky\/whatsapp-session$/);
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
