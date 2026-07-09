import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, redactForLog, ConfigError, loadConfig } from '../src/config.js';

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

test('maxDiffusionSteps defaults to 12 and must leave room above diffusionSteps', () => {
  assert.equal(validateConfig(good).generator.maxDiffusionSteps, 12);

  const withSteps = (diffusionSteps, maxDiffusionSteps) =>
    validateConfig({ ...good, generator: { ...good.generator, diffusionSteps, maxDiffusionSteps } });

  assert.equal(withSteps(8, 10).generator.maxDiffusionSteps, 10);
  assert.equal(withSteps(8, 8).generator.maxDiffusionSteps, 8, 'equal means "no re-rolls", which is legal');
  assert.throws(() => withSteps(8, 7), ConfigError, 'a ceiling below the floor is a typo, not a policy');
  assert.throws(() => withSteps(8, 9.5), ConfigError);
});
