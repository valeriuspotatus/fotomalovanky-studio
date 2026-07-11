import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { validateConfig, redactForLog, ConfigError, loadConfig, defaultSessionDir } from '../src/config.js';

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

test('an explicit whatsapp.sessionDir is honoured and resolved to an absolute path', () => {
  const cfg = validateConfig({ ...good, whatsapp: { enabled: true, recipient: '420123456789@c.us', sessionDir: './my-session' } });
  assert.ok(isAbsolute(cfg.whatsapp.sessionDir));
  assert.match(cfg.whatsapp.sessionDir, /my-session$/);
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
