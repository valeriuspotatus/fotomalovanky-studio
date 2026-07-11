import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, relative, sep, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const PLACEHOLDER = /REPLACE_WITH|<TOKEN>/i;

// The two print layouts the builder understands (BuilderDriver reads `options.mode`). Everything
// downstream — the per-order build format (U9) and the delivery caption (U5) — speaks these two
// internal names; the Czech display labels ("galerie"/"celostránkové") are a caption concern.
const BUILD_MODES = new Set(['gallery', 'fullpage']);

function defaultConfigPath() {
  return process.env.FMA_CONFIG ?? resolve(process.cwd(), 'config.json');
}

/** A per-user data directory OUTSIDE the repo tree for the WhatsApp LocalAuth store. That store is
 *  a full-account bearer credential — anyone with it can send as this WhatsApp — so it must never
 *  be able to land in the working tree. Defaults to the OS per-user data dir; the operator can
 *  override with an absolute path in config.json. */
export function defaultSessionDir(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'fotomalovanky', 'whatsapp-session');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'fotomalovanky', 'whatsapp-session');
  }
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'fotomalovanky', 'whatsapp-session');
}

/** The product/variant -> build-mode map (U9), dropping anything malformed and rejecting a typoed
 *  mode rather than silently building the wrong layout. */
function normalizeFormatMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!BUILD_MODES.has(val)) {
      throw new ConfigError(`delivery.formatMap["${key}"] must be "gallery" or "fullpage"; got ${JSON.stringify(val)}.`);
    }
    out[key] = val;
  }
  return out;
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

  // Jirka's WhatsApp handoff (Phase 2). Disabled by default so the tool runs with no delivery
  // config at all; when the operator turns it on, a missing recipient is a clear error, not a
  // silent no-op that quietly never delivers.
  const wa = cfg.whatsapp && typeof cfg.whatsapp === 'object' && !Array.isArray(cfg.whatsapp) ? cfg.whatsapp : {};
  const whatsappEnabled = wa.enabled === true;
  const recipient = typeof wa.recipient === 'string' && wa.recipient.trim() ? wa.recipient.trim() : null;
  if (whatsappEnabled && !recipient) {
    throw new ConfigError("whatsapp.recipient is required when whatsapp.enabled is true (Jirka's WhatsApp number/id).");
  }
  // An explicit sessionDir is honoured but must land OUTSIDE the repo tree — the LocalAuth store is
  // a full-account credential, and .gitignore can't catch an arbitrarily-named folder, so a path
  // inside the tree is one `git add -A` away from committing it. Only the default is trusted blind.
  let sessionDir = defaultSessionDir();
  if (typeof wa.sessionDir === 'string' && wa.sessionDir.trim()) {
    sessionDir = resolve(wa.sessionDir.trim());
    const rel = relative(process.cwd(), sessionDir);
    const outsideRepo = isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep);
    if (!outsideRepo) {
      throw new ConfigError(
        `whatsapp.sessionDir (${sessionDir}) resolves inside the project tree. The LocalAuth store is a full-account credential and must never be committable — use an absolute path outside the repo, or omit it to use the safe default.`,
      );
    }
  }

  // The per-order build format (U9): a default layout, plus a product/variant -> layout map. The
  // default mirrors the existing global builder mode so turning delivery on changes no output for
  // an order the map does not cover.
  const deliveryFormat = cfg.delivery?.format ?? cfg.builder?.pdf?.mode ?? 'gallery';
  if (!BUILD_MODES.has(deliveryFormat)) {
    throw new ConfigError(`delivery.format must be "gallery" or "fullpage"; got ${JSON.stringify(deliveryFormat)}.`);
  }
  const formatMap = normalizeFormatMap(cfg.delivery?.formatMap);
  const diffusionSteps = cfg.generator.diffusionSteps ?? 4;
  // A redo re-rolls by raising the step count (the generator takes no seed), so it needs a ceiling.
  const maxDiffusionSteps = cfg.generator.maxDiffusionSteps ?? 12;
  if (!Number.isInteger(maxDiffusionSteps) || maxDiffusionSteps < diffusionSteps) {
    throw new ConfigError(
      `generator.maxDiffusionSteps must be an integer >= generator.diffusionSteps (${diffusionSteps}); got ${JSON.stringify(cfg.generator.maxDiffusionSteps)}.`,
    );
  }
  return {
    generator: {
      baseUrl: genUrl,
      mode,
      variant: cfg.generator.variant ?? null,
      diffusionSteps,
      maxDiffusionSteps,
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
      // Layout options for the printed book: { title, dedication, mode, coverCount,
      // addAllCovers, rotationMin, rotationMax }. Defaults to none — an order number printed
      // on a customer's title page would be worse than no title page.
      pdf: cfg.builder.pdf ?? {},
    },
    paths: {
      inbox: cfg.paths?.inbox ?? './inbox',
      outbox: cfg.paths?.outbox ?? './outbox',
    },
    // Optional input-QC thresholds. Passed straight through to the intake pass, which merges them
    // over its own DEFAULT_INTAKE — so an absent block just means "use the defaults". Dropping it
    // here would silently ignore anything the operator tuned in config.json.
    intake: cfg.intake && typeof cfg.intake === 'object' && !Array.isArray(cfg.intake) ? cfg.intake : {},
    // Jirka's WhatsApp handoff. `sessionDir` is always an absolute path outside the repo tree.
    whatsapp: { enabled: whatsappEnabled, recipient, sessionDir },
    // Per-order build format (U9). `format` is the fallback layout; `formatMap` derives it per order.
    delivery: { format: deliveryFormat, formatMap },
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
