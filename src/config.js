import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, relative, sep, isAbsolute } from 'node:path';
import { isLoopbackHost } from './auth/sessions.js';
import { homedir } from 'node:os';

const PLACEHOLDER = /REPLACE_WITH|<TOKEN>/i;

// The two print layouts the builder understands (BuilderDriver reads `options.mode`). Everything
// downstream — the per-order build format (U9) and the delivery caption (U5) — speaks these two
// internal names; the Czech display labels ("galerie"/"celostránkové") are a caption concern.
const BUILD_MODES = new Set(['gallery', 'fullpage']);

function defaultConfigPath() {
  return process.env.FMA_CONFIG ?? resolve(process.cwd(), 'config.json');
}

/** A per-user data directory OUTSIDE the repo tree for the overnight autopilot's cursor, handled-order
 *  set, and the night report. Those files hold customer PII (order emails/names in the report), so
 *  they must never be able to land in the working tree. Defaults to the OS per-user data dir; the
 *  operator can override with an absolute path in config.json. */
export function defaultAutopilotDir(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'fotomalovanky', 'autopilot');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'fotomalovanky', 'autopilot');
  }
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'fotomalovanky', 'autopilot');
}

/** A per-user data directory OUTSIDE the repo tree for the generated marketing creatives (the ad PNGs
 *  + their index). Not PII, but binary and bulky — it must never land in the working tree. Defaults to
 *  the OS per-user data dir; overridable with an absolute path in config.json (creatives.dataDir). */
export function defaultCreativesDir(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'fotomalovanky', 'creatives');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'fotomalovanky', 'creatives');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'fotomalovanky', 'creatives');
}

/** A per-user data directory OUTSIDE the repo tree for the blog drafts (blog-index.json + posts/). Not
 *  PII, but working content — kept out of the tree like the creatives store. Defaults to the OS per-user
 *  data dir; overridable with an absolute path in config.json (blog.dataDir). */
export function defaultBlogDir(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'fotomalovanky', 'blog');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'fotomalovanky', 'blog');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'fotomalovanky', 'blog');
}

/** A per-user data directory OUTSIDE the repo tree for the account file (who the two people are:
 *  display username + avatar reference) and their stored avatars. It is about PEOPLE, so it must
 *  never land in the working tree — the same guard as shopify.dataDir, not the repo-rooted MEMORY_DIR
 *  pattern. Never holds a password or a hash: those live only in the environment (KTD1). Defaults to
 *  the OS per-user data dir; overridable with an absolute path in config.json (accounts.dataDir). */
export function defaultAccountsDir(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'fotomalovanky', 'accounts');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'fotomalovanky', 'accounts');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'fotomalovanky', 'accounts');
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

  // The per-order build format (U9): a default layout, plus a product/variant -> layout map. The
  // default mirrors the existing global builder mode so turning delivery on changes no output for
  // an order the map does not cover.
  const deliveryFormat = cfg.delivery?.format ?? cfg.builder?.pdf?.mode ?? 'gallery';
  if (!BUILD_MODES.has(deliveryFormat)) {
    throw new ConfigError(`delivery.format must be "gallery" or "fullpage"; got ${JSON.stringify(deliveryFormat)}.`);
  }
  const formatMap = normalizeFormatMap(cfg.delivery?.formatMap);

  // The dashboard's read-only Proton inbox tile, read over local IMAP through Proton Mail Bridge.
  // Disabled by default so the tool runs with no mail config at all; when the operator turns it on,
  // missing Bridge credentials are a clear error rather than a tile that silently never loads. The
  // Bridge password is a full-mailbox credential and lives only in gitignored config.json — same
  // posture as the generator token — never in source.
  const mailRaw = cfg.mail && typeof cfg.mail === 'object' && !Array.isArray(cfg.mail) ? cfg.mail : {};
  const mailEnabled = mailRaw.enabled === true;
  const mailHost = typeof mailRaw.host === 'string' && mailRaw.host.trim() ? mailRaw.host.trim() : '127.0.0.1';
  const mailPort = mailRaw.port ?? 1143;
  if (!Number.isInteger(mailPort) || mailPort < 1 || mailPort > 65535) {
    throw new ConfigError(`mail.port must be an integer 1-65535 (the Proton Bridge IMAP port); got ${JSON.stringify(mailRaw.port)}.`);
  }
  // Bridge exposes SMTP on a second port (default 1025) with the same username + Bridge password.
  // This is the outbound seam the dashboard composer sends through — nothing sends without an explicit click.
  const mailSmtpPort = mailRaw.smtpPort ?? 1025;
  if (!Number.isInteger(mailSmtpPort) || mailSmtpPort < 1 || mailSmtpPort > 65535) {
    throw new ConfigError(`mail.smtpPort must be an integer 1-65535 (the Proton Bridge SMTP port); got ${JSON.stringify(mailRaw.smtpPort)}.`);
  }
  const mailUser = typeof mailRaw.user === 'string' && mailRaw.user.trim() ? mailRaw.user.trim() : null;
  const mailPass = typeof mailRaw.pass === 'string' && mailRaw.pass ? mailRaw.pass : null;
  // The visible From on outbound replies. Auth stays on mailUser (the Bridge account); this may be any
  // address that account owns — a send-as alias (David sends the customer correspondence). Defaults to
  // the account address when unset. Proton rejects a From the account does not own, so a wrong value
  // surfaces as a send error, not silent spoofing.
  const mailFrom = typeof mailRaw.fromAddress === 'string' && mailRaw.fromAddress.trim() ? mailRaw.fromAddress.trim() : null;
  const mailSecure = mailRaw.secure === true;
  const mailLimit = Number.isInteger(mailRaw.recentLimit) && mailRaw.recentLimit > 0 ? mailRaw.recentLimit : 6;
  if (mailEnabled && (!mailUser || !mailPass)) {
    throw new ConfigError(
      'mail.user and mail.pass are required when mail.enabled is true (the Proton Bridge IMAP username and its Bridge-generated password).',
    );
  }

  // The Kreativy AI image step: Google's Gemini image model ("Nano Banana Pro"). Disabled by default
  // so the tool runs with no AI config at all; when the operator turns it on, a missing/placeholder
  // key is a clear error rather than a request that silently 401s. The key is a billable Google
  // credential and lives only in gitignored config.json — same posture as the generator token.
  const aiRaw = cfg.ai && typeof cfg.ai === 'object' && !Array.isArray(cfg.ai) ? cfg.ai : {};
  const aiEnabled = aiRaw.enabled === true;
  const aiKey = typeof aiRaw.apiKey === 'string' && aiRaw.apiKey.trim() ? aiRaw.apiKey.trim() : null;
  if (aiEnabled && (!aiKey || PLACEHOLDER.test(aiKey))) {
    throw new ConfigError('ai.apiKey is required when ai.enabled is true (your Google Gemini / Nano Banana API key).');
  }
  const aiModel = typeof aiRaw.model === 'string' && aiRaw.model.trim() ? aiRaw.model.trim() : 'gemini-3-pro-image-preview';
  // The vision model that reads a customer photo into an identity-free scene prompt (the "describe"
  // half of describe-then-generate). A cheaper text/vision model, separate from the image model above.
  // gemini-flash-lite-latest, not gemini-flash-latest: the plain flash-latest alias is heavily
  // contended and returns sustained 503 "high demand", which blocked Kreativy at the describe step.
  // The lite sibling is far more available and more than enough to write a scene description.
  const aiDescribeModel = typeof aiRaw.describeModel === 'string' && aiRaw.describeModel.trim() ? aiRaw.describeModel.trim() : 'gemini-flash-lite-latest';
  // Optional override for the privacy instruction sent with that photo; falls back to the built-in one.
  const aiDescribeInstruction =
    typeof aiRaw.describeInstruction === 'string' && aiRaw.describeInstruction.trim() ? aiRaw.describeInstruction.trim() : null;
  const aiEndpoint = typeof aiRaw.endpoint === 'string' && aiRaw.endpoint.trim() ? aiRaw.endpoint.trim() : 'https://generativelanguage.googleapis.com/v1beta';
  const aiTimeout = Number.isInteger(aiRaw.timeoutMs) && aiRaw.timeoutMs > 0 ? aiRaw.timeoutMs : 60000;
  // Image generation (gemini-3-pro-image-preview) is far slower than the text describe step and 60s
  // regularly isn't enough under load — the operator saw "This operation was aborted". Give it its own,
  // longer budget; describe keeps the shorter timeoutMs. Override with ai.imageTimeoutMs.
  const aiImageTimeout = Number.isInteger(aiRaw.imageTimeoutMs) && aiRaw.imageTimeoutMs > 0 ? aiRaw.imageTimeoutMs : 180000;
  // Gemini's image + flash models return 503 "high demand" in spikes; more retries with backoff ride
  // the spike out instead of surfacing a hard error to the operator. Override via ai.maxRetries/backoffBaseMs.
  const aiMaxRetries = Number.isInteger(aiRaw.maxRetries) && aiRaw.maxRetries >= 0 ? aiRaw.maxRetries : 5;
  const aiBackoffBaseMs = Number.isInteger(aiRaw.backoffBaseMs) && aiRaw.backoffBaseMs >= 0 ? aiRaw.backoffBaseMs : 1500;

  // The overnight autopilot: a scheduled Admin API poll that pulls new PAID photo orders into the
  // inbox and runs the existing pipeline (KTD2). Disabled by default so the tool runs with no Shopify
  // config at all; when the operator turns it on, a missing store or token is a clear error rather
  // than a poll that silently authenticates as nobody. The access token is a full-store `read_orders`
  // credential — a leak exposes every order's customer PII — so it lives ONLY in gitignored
  // config.json or the FMA_SHOPIFY_TOKEN env var, never in source, and redactForLog drops it whole.
  const shopRaw = cfg.shopify && typeof cfg.shopify === 'object' && !Array.isArray(cfg.shopify) ? cfg.shopify : {};
  const shopEnabled = shopRaw.enabled === true;
  const storeDomain = typeof shopRaw.storeDomain === 'string' && shopRaw.storeDomain.trim() ? shopRaw.storeDomain.trim() : null;
  // The token resolves from config OR the env var, so it can live entirely outside the committed file.
  const envToken = typeof process.env.FMA_SHOPIFY_TOKEN === 'string' && process.env.FMA_SHOPIFY_TOKEN.trim() ? process.env.FMA_SHOPIFY_TOKEN.trim() : null;
  const cfgToken =
    typeof shopRaw.accessToken === 'string' && shopRaw.accessToken.trim() && !PLACEHOLDER.test(shopRaw.accessToken)
      ? shopRaw.accessToken.trim()
      : null;
  const accessToken = cfgToken || envToken;
  // The blog writes articles as Shopify drafts, which needs the `write_content` scope — a wider
  // credential than the read-only orders token. Cleanest is one custom app with both scopes (reuse
  // `accessToken`); if David keeps the orders token narrow, a separate content token can live in
  // shopify.contentToken or the FMA_SHOPIFY_CONTENT_TOKEN env var. Resolve the dedicated one first,
  // fall back to the orders token, so a single-token setup just works.
  const envContentToken =
    typeof process.env.FMA_SHOPIFY_CONTENT_TOKEN === 'string' && process.env.FMA_SHOPIFY_CONTENT_TOKEN.trim()
      ? process.env.FMA_SHOPIFY_CONTENT_TOKEN.trim()
      : null;
  const cfgContentToken =
    typeof shopRaw.contentToken === 'string' && shopRaw.contentToken.trim() && !PLACEHOLDER.test(shopRaw.contentToken)
      ? shopRaw.contentToken.trim()
      : null;
  const contentToken = cfgContentToken || envContentToken || accessToken;
  if (shopEnabled && !storeDomain) {
    throw new ConfigError('shopify.storeDomain is required when shopify.enabled is true (e.g. aqi8it-7n.myshopify.com).');
  }
  if (shopEnabled && !accessToken) {
    throw new ConfigError(
      'shopify.accessToken is required when shopify.enabled is true (the read_orders token — set it in config.json or the FMA_SHOPIFY_TOKEN env var).',
    );
  }
  const apiVersion = typeof shopRaw.apiVersion === 'string' && shopRaw.apiVersion.trim() ? shopRaw.apiVersion.trim() : '2026-07';
  const photoKeyMatch = typeof shopRaw.photoKeyMatch === 'string' && shopRaw.photoKeyMatch.trim() ? shopRaw.photoKeyMatch.trim() : 'fotka';
  const dedicationKeyMatch =
    typeof shopRaw.dedicationKeyMatch === 'string' && shopRaw.dedicationKeyMatch.trim() ? shopRaw.dedicationKeyMatch.trim() : 'věnování';
  const layoutKeyMatch = typeof shopRaw.layoutKeyMatch === 'string' && shopRaw.layoutKeyMatch.trim() ? shopRaw.layoutKeyMatch.trim() : 'rozvržení';
  const photoHostAllowlist =
    Array.isArray(shopRaw.photoHostAllowlist) && shopRaw.photoHostAllowlist.some((h) => typeof h === 'string' && h.trim())
      ? shopRaw.photoHostAllowlist.filter((h) => typeof h === 'string' && h.trim()).map((h) => h.trim())
      : ['cdn.tigren.com'];
  // A rough per-order RunPod spend, shown in the morning summary (count × this). A placeholder to
  // refine from real invoices — no cap is enforced (David's choice); this only makes spend visible.
  const estSpendPerOrder =
    typeof shopRaw.estSpendPerOrder === 'number' && Number.isFinite(shopRaw.estSpendPerOrder) && shopRaw.estSpendPerOrder >= 0
      ? shopRaw.estSpendPerOrder
      : 0.3;
  // Whether the autopilot waits for PAID before generating. Default true (safe). David runs it false:
  // RunPod is cheap and customers often pay a little later, so process every photo order on arrival and
  // let payment catch up. When false, financial status is ignored for the "to process" decision.
  const requirePaid = shopRaw.requirePaid !== false;
  // How often (minutes) the running studio polls Shopify for new orders on its own, so they land on the
  // board without clicking "Načíst nové objednávky". 0 disables (manual button only). Default 10.
  const autoFetchMinutes =
    typeof shopRaw.autoFetchMinutes === 'number' && Number.isFinite(shopRaw.autoFetchMinutes) && shopRaw.autoFetchMinutes >= 0
      ? shopRaw.autoFetchMinutes
      : 10;
  // The cursor, handled-order set and night report land here — always an absolute path OUTSIDE the
  // repo tree (it holds customer PII). Only the default is trusted blind: .gitignore can't catch an
  // arbitrarily-named folder, so a path inside the tree is one `git add -A` away from committing it.
  let dataDir = defaultAutopilotDir();
  if (typeof shopRaw.dataDir === 'string' && shopRaw.dataDir.trim()) {
    dataDir = resolve(shopRaw.dataDir.trim());
    const rel = relative(process.cwd(), dataDir);
    const outsideRepo = isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep);
    if (!outsideRepo) {
      throw new ConfigError(
        `shopify.dataDir (${dataDir}) resolves inside the project tree. It holds the poll cursor, the handled-order set and the overnight report (customer PII) and must never be committable — use an absolute path outside the repo, or omit it to use the safe default.`,
      );
    }
  }

  // Where the generated marketing creatives live (ad PNGs + creatives-index.json) — always an absolute
  // path OUTSIDE the repo tree (bulky binaries, must stay uncommittable), same guard as shopify.dataDir.
  const creativesRaw = cfg.creatives && typeof cfg.creatives === 'object' && !Array.isArray(cfg.creatives) ? cfg.creatives : {};
  let creativesDir = defaultCreativesDir();
  if (typeof creativesRaw.dataDir === 'string' && creativesRaw.dataDir.trim()) {
    creativesDir = resolve(creativesRaw.dataDir.trim());
    const rel = relative(process.cwd(), creativesDir);
    const outsideRepo = isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep);
    if (!outsideRepo) {
      throw new ConfigError(
        `creatives.dataDir (${creativesDir}) resolves inside the project tree. It holds generated ad PNGs and must never be committable — use an absolute path outside the repo, or omit it to use the safe default.`,
      );
    }
  }

  // The Blog Creator: writes SEO Czech posts and pushes each to Shopify as an UNPUBLISHED draft.
  // Disabled by default so the tool runs with no blog config; the tab shows a "not configured" state
  // until on. `dataDir` holds the local drafts (working content, no PII) and is guarded outside the
  // repo like the others. Publishing needs a Shopify content token (resolved above) with write_content
  // — when blog.enabled but no store/token is usable, that's a clear error, not a silent 403 at publish.
  const blogRaw = cfg.blog && typeof cfg.blog === 'object' && !Array.isArray(cfg.blog) ? cfg.blog : {};
  const blogEnabled = blogRaw.enabled === true;
  let blogDir = defaultBlogDir();
  if (typeof blogRaw.dataDir === 'string' && blogRaw.dataDir.trim()) {
    blogDir = resolve(blogRaw.dataDir.trim());
    const rel = relative(process.cwd(), blogDir);
    const outsideRepo = isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep);
    if (!outsideRepo) {
      throw new ConfigError(
        `blog.dataDir (${blogDir}) resolves inside the project tree. Keep drafts out of the repo — use an absolute path outside it, or omit it to use the safe default.`,
      );
    }
  }
  const blogAuthor = typeof blogRaw.author === 'string' && blogRaw.author.trim() ? blogRaw.author.trim() : 'Fotomalovánky';
  const blogId = typeof blogRaw.blogId === 'string' && blogRaw.blogId.trim() ? blogRaw.blogId.trim() : null;
  const wordCountMin = Number.isInteger(blogRaw.wordCountMin) && blogRaw.wordCountMin > 0 ? blogRaw.wordCountMin : 800;
  const wordCountMax = Number.isInteger(blogRaw.wordCountMax) && blogRaw.wordCountMax >= wordCountMin ? blogRaw.wordCountMax : 1500;
  if (blogEnabled && (!storeDomain || !contentToken)) {
    throw new ConfigError(
      'blog.enabled needs Shopify configured with a content token — set shopify.storeDomain and a write_content token (shopify.contentToken / FMA_SHOPIFY_CONTENT_TOKEN, or the orders token if it has the scope).',
    );
  }

  // Where the two people's account file lives (display username + avatar reference, plus the stored
  // avatar images) — always an absolute path OUTSIDE the repo tree, same guard as shopify.dataDir.
  // This one is about people rather than bulk: a username and a photograph of the person using the
  // tool are exactly what must not be one `git add -A` away from a public repo. On Render this points
  // under the mounted disk, or both accounts reset to their defaults on every redeploy. Passwords
  // never come near it — they are scrypt hashes in the environment (KTD1).
  const accountsRaw = cfg.accounts && typeof cfg.accounts === 'object' && !Array.isArray(cfg.accounts) ? cfg.accounts : {};
  let accountsDir = defaultAccountsDir();
  if (typeof accountsRaw.dataDir === 'string' && accountsRaw.dataDir.trim()) {
    accountsDir = resolve(accountsRaw.dataDir.trim());
    const rel = relative(process.cwd(), accountsDir);
    const outsideRepo = isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep);
    if (!outsideRepo) {
      throw new ConfigError(
        `accounts.dataDir (${accountsDir}) resolves inside the project tree. It holds the two people's usernames and profile photos and must never be committable — use an absolute path outside the repo, or omit it to use the safe default.`,
      );
    }
  }

  // Board display: the first REAL order number. Older ids are test orders and are hidden from the
  // board and its counts. Null (default) shows everything, so nothing changes until the operator
  // sets it.
  const studioRaw = cfg.studio && typeof cfg.studio === 'object' && !Array.isArray(cfg.studio) ? cfg.studio : {};
  let firstLiveOrder = null;
  if (studioRaw.firstLiveOrder != null) {
    if (!Number.isInteger(studioRaw.firstLiveOrder) || studioRaw.firstLiveOrder < 0) {
      throw new ConfigError(
        `studio.firstLiveOrder must be a non-negative integer (order numbers below it are hidden as test orders); got ${JSON.stringify(studioRaw.firstLiveOrder)}.`,
      );
    }
    firstLiveOrder = studioRaw.firstLiveOrder;
  }

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
      // Ask the light vision model, per photo, which way is up and whether the customer sent a
      // screenshot — the two things the EXIF block cannot say (see photoFraming.js). On by default,
      // but inert unless `ai.enabled` and `ai.apiKey` are set, so an install with no AI key is
      // unaffected. Set generator.autoFraming:false to upload every photo exactly as it arrived.
      autoFraming: cfg.generator.autoFraming !== false,
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
      // Trim each coloring page to its ink before printing, so a subject stranded in white margin
      // (the model dropping the background) fills the page instead of printing white borders. On by
      // default; set builder.autoCrop:false in config.json to keep the raw generator framing.
      autoCrop: cfg.builder.autoCrop !== false,
    },
    paths: {
      inbox: cfg.paths?.inbox ?? './inbox',
      outbox: cfg.paths?.outbox ?? './outbox',
    },
    // Optional input-QC thresholds. Passed straight through to the intake pass, which merges them
    // over its own DEFAULT_INTAKE — so an absent block just means "use the defaults". Dropping it
    // here would silently ignore anything the operator tuned in config.json.
    intake: cfg.intake && typeof cfg.intake === 'object' && !Array.isArray(cfg.intake) ? cfg.intake : {},
    // Per-order build format (U9). `format` is the fallback layout; `formatMap` derives it per order.
    delivery: { format: deliveryFormat, formatMap },
    // The dashboard's read-only Proton inbox tile (via Proton Bridge over local IMAP). `enabled`
    // false means the tile shows an "offline" state and never connects.
    mail: { enabled: mailEnabled, host: mailHost, port: mailPort, smtpPort: mailSmtpPort, user: mailUser, pass: mailPass, fromAddress: mailFrom, secure: mailSecure, recentLimit: mailLimit },
    // Where generated marketing creatives (ad PNGs + index) are stored. Absolute, outside the repo.
    creatives: { dataDir: creativesDir },
    // The Kreativy AI image step (Gemini / Nano Banana Pro). `enabled` false means the studio's
    // "generate image" action is unavailable and never calls out.
    ai: {
      enabled: aiEnabled,
      apiKey: aiKey,
      model: aiModel,
      describeModel: aiDescribeModel,
      describeInstruction: aiDescribeInstruction,
      endpoint: aiEndpoint,
      timeoutMs: aiTimeout,
      imageTimeoutMs: aiImageTimeout,
      maxRetries: aiMaxRetries,
      backoffBaseMs: aiBackoffBaseMs,
    },
    // The overnight autopilot (Shopify Admin API poll). `enabled` false means no poll ever runs and
    // the runner exits inert. `dataDir` is always an absolute path outside the repo tree; `accessToken`
    // is a full-store credential and never leaves gitignored config / the env var.
    shopify: {
      enabled: shopEnabled,
      storeDomain,
      accessToken,
      contentToken,
      apiVersion,
      photoKeyMatch,
      dedicationKeyMatch,
      layoutKeyMatch,
      photoHostAllowlist,
      estSpendPerOrder,
      requirePaid,
      autoFetchMinutes,
      dataDir,
    },
    // The Blog Creator. `enabled` false means the tab shows a "not configured" state and nothing
    // publishes. `dataDir` is absolute, outside the repo. Publishing reuses shopify.contentToken.
    blog: { enabled: blogEnabled, dataDir: blogDir, blogId, author: blogAuthor, wordCountMin, wordCountMax },
    // Where the account file and the stored avatars live. Absolute, outside the repo. Usernames and
    // avatar references only — the password hashes stay in the environment.
    accounts: { dataDir: accountsDir },
    // Board display. `firstLiveOrder` hides older test orders; null shows everything.
    studio: { firstLiveOrder },
    retentionDays,
    manualTouchThreshold: cfg.manualTouchThreshold ?? null,
  };
}

/** Mask the token-scoped generator URL and the Shopify access token so config can be logged safely.
 *  The Shopify token is a bare string, not a URL, so it is dropped whole rather than URL-masked. */
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
    ...(cfg.shopify
      ? { shopify: { ...cfg.shopify, accessToken: cfg.shopify.accessToken ? '<redacted>' : null, contentToken: cfg.shopify.contentToken ? '<redacted>' : null } }
      : {}),
  };
}

/**
 * Refuse to start when a hosted deployment would write people's data somewhere a restart erases.
 *
 * THE FAILURE THIS EXISTS FOR HAS NO SYMPTOM UNTIL IT IS TOO LATE. Every `dataDir` in this config
 * falls back to an OS per-user directory when it is not set — the right answer on a laptop, where
 * that directory is as permanent as anything else. In a container it is scratch space: the app
 * boots, writes there happily, serves correctly, and loses the lot on the next deploy. Nothing
 * errors, nothing warns, and the only visible trace is whatever could not fall back to a default.
 * That is exactly how the two profile photos disappeared — the usernames survived only because
 * "David" and "Jirka" are the defaults, so a wiped account file and an intact one look identical.
 *
 * Detected by the SAME signal `assertLocalModeIsSafe` already uses: a non-loopback bind. The
 * Dockerfile sets HOST=0.0.0.0, so this is a deploy; a laptop binds 127.0.0.1 and is left alone,
 * where the per-user directory is genuinely persistent and this check would be wrong.
 *
 * `FMA_DATA_ROOT` overrides the mount point for a host that mounts its disk elsewhere. It is not a
 * way to switch the check off: pointing it at a scratch directory is the same mistake, spelled out.
 *
 * @throws {ConfigError} naming every directory at risk and the config key that fixes it
 */
export function assertPersistentDataDirs({ config, env = process.env, bindHost = env.HOST } = {}) {
  if (isLoopbackHost(bindHost)) return; // a laptop: the per-user data dir outlives the process

  const root = env.FMA_DATA_ROOT || '/data';
  const withinRoot = (dir) => {
    const rel = relative(root, resolve(dir));
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
  };

  // Everything whose loss costs something: customer photographs, finished books, who the two people
  // are, and the autopilot's handled map — which, wiped, makes a week of finished orders look new.
  const named = [
    ['paths.inbox', config?.paths?.inbox],
    ['paths.outbox', config?.paths?.outbox],
    ['accounts.dataDir', config?.accounts?.dataDir],
    ['shopify.dataDir', config?.shopify?.dataDir],
    ['creatives.dataDir', config?.creatives?.dataDir],
    ['blog.dataDir', config?.blog?.dataDir],
  ];
  const stray = named.filter(([, dir]) => typeof dir === 'string' && dir && !withinRoot(dir));
  if (stray.length === 0) return;

  throw new ConfigError(
    `Refusing to start: ${stray.length} data ${stray.length === 1 ? 'directory is' : 'directories are'} outside ${root}, ` +
      `which on this host is the only storage that survives a redeploy. Everything written there is lost ` +
      `the next time the service restarts, silently and with no error:\n` +
      stray.map(([key, dir]) => `  ${key} = ${dir}`).join('\n') +
      `\n\nPoint each at a path under ${root} in config.json (for example "accounts": { "dataDir": "${root}/accounts" }), ` +
      `or set FMA_DATA_ROOT if this host mounts its disk somewhere else.`,
  );
}
