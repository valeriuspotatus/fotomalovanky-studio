import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PLACEHOLDER = /REPLACE_WITH|<TOKEN>/i;

function defaultConfigPath() {
  return process.env.FMA_CONFIG ?? resolve(process.cwd(), 'config.json');
}

export class ConfigError extends Error {}

/** Load and validate the live config (config.json). The token-scoped generator
 *  URL lives here, never in source — config.json is gitignored. */
export function loadConfig(configPath = defaultConfigPath()) {
  if (!existsSync(configPath)) {
    throw new ConfigError(
      `Config not found at ${configPath}. Copy config.example.json to config.json and paste your generator token URL.`,
    );
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Config at ${configPath} is not valid JSON: ${err.message}`);
  }
  return validateConfig(raw);
}

/** Validate a parsed config object and return a normalized copy. */
export function validateConfig(cfg) {
  const genUrl = cfg?.generator?.baseUrl;
  if (!genUrl || typeof genUrl !== 'string') {
    throw new ConfigError('generator.baseUrl is required (the token-scoped generator URL).');
  }
  if (PLACEHOLDER.test(genUrl)) {
    throw new ConfigError(
      'generator.baseUrl still holds a placeholder — paste your real token-scoped generator URL into config.json.',
    );
  }
  const buildUrl = cfg?.builder?.baseUrl;
  if (!buildUrl || typeof buildUrl !== 'string') {
    throw new ConfigError('builder.baseUrl is required (the print builder URL).');
  }
  const retentionDays = cfg.retentionDays ?? 30;
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new ConfigError('retentionDays must be a positive integer (days to keep customer photos locally).');
  }
  const mode = cfg.generator.mode ?? null;
  if (mode !== null && mode !== 'api' && mode !== 'browser') {
    throw new ConfigError(`generator.mode must be "api", "browser", or null (unset); got ${JSON.stringify(mode)}.`);
  }
  return {
    generator: {
      baseUrl: genUrl,
      mode,
      variant: cfg.generator.variant ?? null,
      diffusionSteps: cfg.generator.diffusionSteps ?? 4,
      positivePrompt: cfg.generator.positivePrompt ?? '',
      negativePrompt: cfg.generator.negativePrompt ?? '',
      // Optional driver tuning (request/poll timeouts, retries); the driver falls back to its own defaults.
      timeouts: cfg.generator.timeouts ?? null,
    },
    builder: {
      baseUrl: buildUrl,
      // Passed straight through to BuilderDriver, which reads both. Dropping them here would
      // silently ignore anything the operator set in config.json.
      timeouts: cfg.builder.timeouts ?? null,
      // Layout options for the printed book: { title, dedication, mode, addAllCovers,
      // rotationMin, rotationMax }. Defaults to none — an order number printed on a
      // customer's title page would be worse than no title page.
      pdf: cfg.builder.pdf ?? {},
    },
    paths: {
      inbox: cfg.paths?.inbox ?? './inbox',
      outbox: cfg.paths?.outbox ?? './outbox',
    },
    retentionDays,
    manualTouchThreshold: cfg.manualTouchThreshold ?? null,
  };
}

/** Mask the token-scoped generator URL so config can be logged safely. */
export function redactForLog(cfg) {
  const mask = (url) => {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}/<redacted>`;
    } catch {
      return '<redacted>';
    }
  };
  return {
    ...cfg,
    generator: { ...cfg.generator, baseUrl: mask(cfg.generator.baseUrl) },
  };
}
