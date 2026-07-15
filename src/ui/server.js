import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import sharp from 'sharp';
import { loadConfig } from '../config.js';
import { createGeneratorDriver } from '../generator/factory.js';
import { BuilderDriver } from '../builder/builderDriver.js';
import { runPipeline, formatEvent, pdfPathFor } from '../orchestrator.js';
import { studioBoard, markDelivered, unmarkDelivered, markPrinted, unmarkPrinted } from '../studio.js';
import { readReport } from '../autopilotReport.js';
import { runAutopilot } from '../autopilot.js';
import { hiddenMarkerPath } from '../review.js';
import { loadState, markHandled, saveState } from '../autopilotState.js';
import { createBridgeClient, BridgeError } from '../proton/bridgeClient.js';
import { createSmtpClient, SmtpError } from '../proton/smtpClient.js';
import { summarizeInbox } from '../proton/mailbox.js';
import { templateList, unfilledPlaceholders } from '../proton/templates.js';
import { createWhatsAppClient, WhatsAppError, deliveryCaption } from '../whatsapp/whatsappClient.js';
import { renderCreativePng, CreativeRenderError } from '../creatives/renderCreative.js';
import { generateMarketingImage, describeImage, generateText, AiImageError } from '../creatives/aiImage.js';
import { generateAdImages, describeAndGenerate, AdImageError, toDataUri } from '../creatives/adImages.js';
import { STUDIO_FORMATS, DEFAULT_FORMATS } from '../creatives/studio/formats.js';
import { THEMES } from '../creatives/studio/brandKit.js';
import { listTemplates, getTemplate, SEED_COPY } from '../creatives/studio/templates.js';
import { renderStudioHtml } from '../creatives/studio/renderStudioHtml.js';
import { validateConcept, creativeFilename, COPY_FIELDS } from '../creatives/studio/templateModel.js';
import { MARKETING_CAL, occasionKey } from '../creatives/calendar.js';
import { readIndex as readCreativesIndex } from '../creatives/adCalendar.js';
import { suggestTopics } from '../blog/topics.js';
import { generatePost, recomputePost } from '../blog/draft.js';
import { listPosts, readPost, savePost, deletePost } from '../blog/store.js';
import { createContentClient } from '../shopify/content.js';
import { ingestOrders, IngestError } from '../ingest.js';
import { selectAutoRunOrders } from '../autoRun.js';
import {
  reviewState,
  approve,
  reject,
  handoff,
  acceptReplacement,
  redo,
  setOrderDedication,
  overrideIntake,
  markCustomerEmailed,
  applyPhotoEdit,
  revertPhotoEdit,
  ReviewError,
} from '../review.js';
import { migrateDedications, MEMORY_DIR } from '../dedications.js';

// The U4 review grid: a local page over state.json. Bound to 127.0.0.1 only — it can approve
// photos and spend GPU, and it serves customer faces.
//
// The generator's token-scoped URL never reaches the page. "Open generator" is a POST that
// makes the *server* launch the browser, so the token stays out of the DOM, out of the JSON,
// and out of any screen recording of this tool.

const HERE = dirname(fileURLToPath(import.meta.url));
const THUMB_WIDTH = 720;

// The studio's own served tree. The dashboard (home) and the assets it loads live here, and copying
// them out of the secrets-laden Marketing Automatization/ folder is what lets the whole tree be
// served with a plain containment check instead of an asset whitelist (KTD2).
const STATIC_DIR = join(HERE, 'static');

// The real brand logo, embedded once as a data URI so every creative (live preview + PNG render) is
// self-contained. Read at load; null if the asset is missing, in which case the template falls back
// to its drawn mark rather than erroring.
const CREATIVE_LOGO_URI = (() => {
  try {
    return `data:image/png;base64,${readFileSync(join(STATIC_DIR, 'creatives', 'logo.png')).toString('base64')}`;
  } catch {
    return null;
  }
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

/** Serve a file from the studio's static tree, and only from there. The resolved path must stay
 *  inside static/, so a crafted request (../../config.json) resolves outside it and gets a 404
 *  rather than the file — no secret, source, or order data is reachable through here. */
function serveStatic(pathname, res) {
  let candidate;
  try {
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    candidate = resolve(STATIC_DIR, rel);
  } catch {
    return json(res, 404, { error: 'Not found.' }); // a malformed/percent-encoded path is just not found
  }
  if (candidate !== STATIC_DIR && !candidate.startsWith(STATIC_DIR + sep)) {
    return json(res, 404, { error: 'Not found.' });
  }
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    return json(res, 404, { error: 'Not found.' });
  }
  const ext = candidate.slice(candidate.lastIndexOf('.')).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  return res.end(readFileSync(candidate));
}

/** Read a small JSON body. Bounded — this is a local tool, but an unbounded read is still a bug. */
async function readJson(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ReviewError('Request body too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ReviewError('Request body was not valid JSON.');
  }
}

/** Shape the state for the browser. Photo files are never addressed by path — the page asks for
 *  them by (order, base, kind), which also means a crafted path cannot reach the filesystem.
 *  The order folder *is* sent: the operator has to save a hand-repaired file into it. */
function forClient(orders, inFlight) {
  return orders.map((o) => ({
    orderId: o.orderId,
    dirName: o.dirName,
    orderDir: o.orderDir,
    inInbox: o.inInbox,
    intake: o.intake,
    draftEmail: o.draftEmail,
    dedication: o.dedication,
    suggestedDedication: o.suggestedDedication,
    suggestionRemembered: o.suggestionRemembered,
    suggestionSource: o.suggestionSource,
    clearedDedication: o.clearedDedication,
    summary: o.summary,
    photos: o.photos.map((p) => ({
      base: p.base,
      status: p.status,
      reason: p.reason,
      builderEligible: p.builderEligible,
      holdsForReview: p.holdsForReview,
      hasOriginal: Boolean(p.files.original),
      hasColoring: Boolean(p.files.coloring),
      hasSvg: Boolean(p.files.svg),
      edited: p.edited,
      // The render's mtime versions its <img> URL, so a completed redo repaints the tile
      // instead of the browser showing the render the operator just rejected.
      coloringVersion: p.files.coloring ? statSync(p.files.coloring).mtimeMs : 0,
      busy: inFlight.get(`${o.orderId}/${p.base}`) ?? null,
    })),
  }));
}

const thumbs = new Map(); // `${path}:${mtimeMs}` -> jpeg Buffer

async function thumbnail(path) {
  const key = `${path}:${statSync(path).mtimeMs}`;
  const hit = thumbs.get(key);
  if (hit) return hit;
  // Decode from bytes, not from the path: handed a path, libvips keeps the file mapped while it
  // decodes, and on Windows the run cannot then overwrite that very file — the grid drawing a
  // tile would fail the photo being regenerated behind it. readFileSync closes before we decode.
  const buf = await sharp(readFileSync(path))
    .flatten({ background: '#ffffff' })
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  if (thumbs.size > 300) thumbs.clear();
  thumbs.set(key, buf);
  return buf;
}

const MAX_LOG_LINES = 400;

// Above this many orders in one folder, the operator has opened their archive rather than a
// batch. Ticking them all would generate every order they have ever shipped.
const AUTO_TICK_LIMIT = 8;

// Never ask PATH for a Windows binary. PATH is capped near 2047 characters and a machine that has
// grown past it silently loses its tail — this operator's had dropped System32, so a bare "cmd"
// resolved to nothing. ComSpec and SystemRoot are set by Windows itself and say where the real
// binaries are, so use those.
const systemRoot = (env) => env.SystemRoot ?? env.windir ?? 'C:\\Windows';

/** The command that hands `target` to the desktop. Absolute on Windows, by design. */
export function openCommand(target, platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    // A filesystem target must be an absolute, native-separator path before it reaches cmd's `start`:
    // a relative or forward-slashed one like "./outbox" (straight from config.paths) makes Explorer
    // report `cannot find …\.\outbox`. URLs (http://, file://) are left untouched — resolve() would
    // wreck them. The `://` test cleanly separates a URL from a Windows drive path (`C:\…` has no `://`).
    const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
    const t = isUrl ? target : resolve(target);
    return [env.ComSpec ?? join(systemRoot(env), 'System32', 'cmd.exe'), ['/c', 'start', '', t]];
  }
  if (platform === 'darwin') return ['open', [target]];
  return ['xdg-open', [target]];
}

/** Absolute path to Windows PowerShell, for the same reason. */
export function powershellPath(env = process.env) {
  return join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** The PowerShell that shows the folder dialog, and shows it *in front*.
 *
 *  An unshown TopMost form does not work: it has no window, so it is on top of nothing, and the
 *  dialog it owns opens behind the browser where the operator never finds it. Windows also
 *  refuses SetForegroundWindow to a process that neither owns the foreground nor received the
 *  last input — and the one that gets the click is Chrome, not this background server. So: show
 *  a real (1x1, transparent, taskbar-less) topmost owner, borrow the foreground thread's input
 *  queue long enough to be allowed forward, and open the dialog owned by it.
 *
 *  Exported so the probe in tools/ can drive the very script the server runs. */
export function pickFolderScript(startAt = '') {
  // PowerShell escapes a single quote by doubling it. Without this, a folder named "it's here"
  // closes the string and the rest of the operator's path is executed as code.
  const start = String(startAt).trim().replace(/'/g, "''");
  const openWhereTheyLeftOff = start ? `$d.SelectedPath = '${start}'` : '';
  return `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
}
"@
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.Width = 1
$owner.Height = 1
$owner.Show()

$fg = [Fg]::GetForegroundWindow()
$theirs = [Fg]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$mine = [Fg]::GetCurrentThreadId()
if ($theirs -ne $mine) { [void][Fg]::AttachThreadInput($theirs, $mine, $true) }
[void][Fg]::BringWindowToTop($owner.Handle)
[void][Fg]::SetForegroundWindow($owner.Handle)
if ($theirs -ne $mine) { [void][Fg]::AttachThreadInput($theirs, $mine, $false) }
$owner.Activate()

$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Choose the folder your Chrome extension downloads orders into'
$d.ShowNewFolderButton = $false
${openWhereTheyLeftOff}
if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }
$owner.Close()
$owner.Dispose()
`;
}

/** Ask Windows for a folder. A non-technical operator should not have to paste a path.
 *
 *  Resolves `{ path, available }`. `path` is null when the operator cancels — which is not a
 *  failure — so `available` says whether the dialog ever appeared, and only that earns a warning.
 *  Never throws. */
export function pickFolder(startAt = '', platform = process.platform) {
  if (platform !== 'win32') return Promise.resolve({ path: null, available: false });
  // -EncodedCommand, not -Command: the script has newlines, quotes and a here-string, and every
  // one of them is a way for Node's Windows argument escaping to mangle it.
  const encoded = Buffer.from(pickFolderScript(startAt), 'utf16le').toString('base64');
  return new Promise((resolve) => {
    let out = '';
    const ps = spawn(powershellPath(), ['-NoProfile', '-STA', '-EncodedCommand', encoded], { windowsHide: true });
    const timer = setTimeout(() => { ps.kill(); resolve({ path: null, available: false }); }, 120_000);
    ps.stdout.on('data', (d) => (out += d));
    ps.on('error', () => { clearTimeout(timer); resolve({ path: null, available: false }); });
    ps.on('close', (code) => {
      clearTimeout(timer);
      resolve({ path: out.trim() || null, available: code === 0 });
    });
  });
}

/** Best-effort "open this in the operator's desktop". Resolves false rather than throwing, and
 *  above all never lets a failure escape: spawn reports ENOENT on an asynchronous 'error' event,
 *  and an unhandled one takes the whole process down — the tool must not die because a browser
 *  would not open. */
export function openExternally(target, [bin, args] = openCommand(target)) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { detached: true, stdio: 'ignore' });
    } catch {
      return resolve(false);
    }
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

/** `revealFinished` opens the finished book's folder on the desktop. It defaults to off: a test
 *  or a smoke that constructs a server must never spawn a File Explorer window — and one that
 *  did, pointed at a temp folder the test then deleted, is how this default was chosen. Only the
 *  double-click launcher, where a real operator is watching, turns it on. */
export function createReviewServer({ config, inboxRoot, outboxRoot, driver, builder, qc, intake, revealFinished = false, reveal = openExternally, log = () => {}, memoryRoot = MEMORY_DIR, mailClient, smtpClient, waClient, adImageFn } = {}) {
  let inbox = inboxRoot ?? config.paths.inbox; // the Go bar can point the tool at another folder
  const outbox = outboxRoot ?? config.paths.outbox;
  const inFlight = new Map(); // "order/base" -> { message }
  // `orderId` is the order the run is generating right now, so the board can tell 'generating' from
  // 'queued' — the review state alone shows both as all-null photo statuses.
  const run = { active: false, stopping: false, lines: [], report: null, error: null, orderId: null };
  // On-demand Shopify fetch (the "Načíst nové objednávky" button): runs the same autopilot as the
  // scheduled task — pull new paid orders, download photos, generate — but triggered by hand. Shares
  // the run-lock with the manual pipeline so the two can never generate over each other.
  const autopilot = { running: false, lines: [], report: null, error: null };
  let runController = null; // the live run's AbortController, or null between runs
  let generator = driver ?? null;
  let builderDriver = builder ?? null;

  // The dashboard's read-only Proton inbox tile. A caller can inject a client (tests do); otherwise
  // one is built from config only when mail is enabled, so an unconfigured tool never connects.
  const mail = mailClient ?? (config?.mail?.enabled ? createBridgeClient(config.mail) : null);
  // The outbound SMTP seam, wired only when mail is on. `smtp` null → the composer's Send is refused
  // with a clear message rather than silently failing. Same Bridge creds, the SMTP port (default 1025).
  const smtp = smtpClient ?? (config?.mail?.enabled ? createSmtpClient({ host: config.mail.host, port: config.mail.smtpPort, user: config.mail.user, pass: config.mail.pass, secure: config.mail.secure, fromAddress: config.mail.fromAddress }) : null);
  const mailLimit = config?.mail?.recentLimit ?? 6;
  let mailCache = null; // { at: epochMs, payload } — a successful read is reused briefly so the tile's
  const MAIL_TTL = 30_000; // poll doesn't reopen an IMAP session every few seconds.

  // The one WhatsApp seam: deliver the finished book to Jirka on the operator's explicit "Odeslat
  // Jirkovi" click. Built from config only when whatsapp is enabled (a caller/test may inject one);
  // null → the deliver action is refused with a clear message. The session links lazily on first use.
  const wa = waClient ?? (config?.whatsapp?.enabled ? createWhatsAppClient({ recipient: config.whatsapp.recipient, sessionDir: config.whatsapp.sessionDir, executablePath: config.whatsapp.executablePath }) : null);

  // Kreativy AI images: the operator uploads a reference photo, Nano Banana Pro reimagines it into a
  // marketing "before", and the existing RunPod generator turns that into the "after" line-art. The
  // pair is cached by a short id so the preview/render can reference it without a huge data: URI in a
  // GET URL. `adImageFn` is injectable so tests never touch the network or the GPU.
  const creativeImages = new Map(); // id -> { before: dataUri, after: dataUri, at: epochMs }
  let creativeImageSeq = 0;
  // In `auto` mode the operator's photo is first read into an identity-free scene prompt (describeImage),
  // and the "before" is generated from that TEXT ALONE — the customer's pixels never reach the image
  // model (describeAndGenerate passes referenceBase64:null downstream). In manual mode the typed prompt
  // is used and the reference (if any) is passed straight to the image model as an inline hint.
  const makeAdImages = adImageFn ?? (async ({ referenceBase64, referenceMime, prompt, auto = false }) => {
    if (!config?.ai?.enabled) throw new AiImageError('AI image generation is off (set ai.enabled + ai.apiKey in config.json).', 'not-configured');
    const aiFn = (args) => generateMarketingImage({ config: config.ai, ...args });
    const lineArtFn = async (before) => {
      // Line-art via the real RunPod generator, through a throwaway temp file (it reads a path).
      const dir = mkdtempSync(join(tmpdir(), 'fma-ad-'));
      try {
        const inPath = join(dir, before.mimeType?.includes('png') ? 'before.png' : 'before.jpg');
        writeFileSync(inPath, Buffer.from(before.base64, 'base64'));
        generator ??= createGeneratorDriver(config);
        const { coloringPngPath } = await generator.generate(inPath, { workDir: dir });
        return { base64: readFileSync(coloringPngPath).toString('base64'), mimeType: 'image/png' };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    if (auto) {
      return describeAndGenerate({
        referenceBase64,
        referenceMime,
        describeFn: (a) => describeImage({ config: config.ai, ...a }),
        aiFn,
        lineArtFn,
      });
    }
    return generateAdImages({ referenceBase64, referenceMime, prompt, aiFn, lineArtFn });
  });

  // The spellings used to live in the outbox, which is the one folder that gets emptied. Carry
  // any that are still there across, once, before anything can read the wrong one.
  const moved = migrateDedications(outbox, memoryRoot);
  if (moved.length) log(`Moved ${moved.length} saved spelling${moved.length > 1 ? 's' : ''} out of the outbox, into the tool's own folder.`);

  // Which orders in that folder the operator ticked. `null` means "all of them" — what a run
  // has always meant. An empty array means they ticked none, which is not the same thing.
  let selected = null;
  let queue = []; // the orders the last scan found in `inbox`, so a page reload still shows them

  const state = () => reviewState({ inboxRoot: inbox, outboxRoot: outbox, only: selected, memoryRoot });

  /** What is in this folder? Cheap, and it starts nothing. Throws IngestError for a bad path. */
  const scanInbox = (path) => {
    const found = ingestOrders(path);
    queue = found.map((o) => ({ orderId: o.orderId, dirName: o.dirName, photos: o.photos.length }));
    return found;
  };

  const find = (orderId, base) => {
    const order = state().find((o) => o.orderId === orderId);
    if (!order) throw new ReviewError(`Unknown order "${orderId}".`);
    const photo = order.photos.find((p) => p.base === base);
    if (!photo) throw new ReviewError(`Unknown photo "${base}" in order "${orderId}".`);
    return { order, photo };
  };

  /** Resolve a Creative Studio concept (template + format + copy + assets) from query params, for the
   *  layered renderer. Copy comes from ?<field>= (falling back to the template's seed copy); the image
   *  slots are filled from a generated AI pair (?images=<id>): the "before" marketing photo feeds the
   *  original + lifestyle slots, the "after" line-art feeds the coloring slot. Customer photos never
   *  reach here — the "before" is an identity-free AI image (see describeAndGenerate). */
  function studioConceptFrom(q) {
    const template = getTemplate(q.get('template')) ?? getTemplate('promena');
    const format = STUDIO_FORMATS[q.get('format')] ? q.get('format') : 'feed';
    const copy = { ...(SEED_COPY[template.id] ?? {}) };
    for (const f of [...COPY_FIELDS, 'headlineHi']) {
      if (q.has(f)) copy[f] = q.get(f); // an explicit empty value clears the seed
    }
    const assets = {};
    const pair = creativeImages.get(q.get('images'));
    if (pair) {
      assets.original = pair.before;
      assets.lifestyle = pair.before;
      assets.coloring = pair.after;
    }
    const brand = CREATIVE_LOGO_URI ? { logoSrc: CREATIVE_LOGO_URI } : {};
    return { template, format, copy, assets, brand };
  }

  /** A run holds each order's manifest in memory and rewrites it after every photo. A verdict
   *  saved meanwhile would be silently overwritten, so verdicts are refused while a run is on. */
  const requireIdle = () => {
    if (run.active) throw new ReviewError('A run is in progress — wait for it to finish before changing anything.');
    if (autopilot.running) throw new ReviewError('Fetching orders is in progress — wait for it to finish before changing anything.');
  };

  function startRun({ inbox: requested, force, buildPdfs = true, only = null, silent = false }) {
    if (run.active) throw new ReviewError('A run is already going.');
    if (autopilot.running) throw new ReviewError('Fetching orders is in progress — wait for it to finish.');
    if (inFlight.size) throw new ReviewError('A photo is still being regenerated — wait for it to finish.');

    const candidate = String(requested ?? '').trim() || inbox;
    if (candidate !== inbox) {
      scanInbox(candidate); // surfaces a missing folder before anything starts
      selected = null; // a new folder's orders are not the old folder's
      inbox = candidate;
    } else {
      ingestOrders(candidate);
    }

    // `only` lets the inbox auto-runner target specific new orders without disturbing the operator's
    // manual tick selection; the manual path still runs `selected`.
    const runOnly = only ?? selected;
    if (runOnly?.length === 0) throw new ReviewError('Tick at least one order to run.');

    run.active = true;
    run.stopping = false;
    run.lines = [];
    run.report = null;
    run.error = null;
    run.orderId = null;
    runController = new AbortController();

    generator ??= createGeneratorDriver(config);
    builderDriver ??= new BuilderDriver(config);

    // Deliberately not awaited: the operator watches the log while the GPU and the browser work.
    runPipeline({
      config,
      inboxRoot: inbox,
      outboxRoot: outbox,
      generator,
      builder: builderDriver,
      qc,
      intake,
      force: Boolean(force),
      buildPdfs: buildPdfs !== false,
      only: runOnly,
      memoryRoot,
      signal: runController.signal,
      onEvent: (e) => {
        // Track which order is on the GPU now, so the board reads 'generating' for it and 'queued'
        // for the ones behind it. Cleared when the order finishes; the run's finally clears the last.
        if (e.type === 'order-start') run.orderId = e.orderId;
        else if (e.type === 'order-done') run.orderId = null;
        const line = formatEvent(e);
        if (line === null) return;
        run.lines.push(line);
        if (run.lines.length > MAX_LOG_LINES) run.lines.splice(0, run.lines.length - MAX_LOG_LINES);
      },
    })
      .then((result) => {
        run.report = {
          counts: result.counts,
          orders: result.orders.map((o) => ({
            orderId: o.orderId,
            status: o.status,
            reason: o.reason,
            pdf: Boolean(o.pdfPath),
            titled: o.titled,
          })),
        };

        // The book is the point of the run, and it lands in a folder the operator never chose.
        // Show it to them. One order opens its own folder; a batch opens the one that holds
        // them all, rather than throwing a window per order at the screen.
        const built = result.orders.filter((o) => o.pdfPath);
        if (!revealFinished || silent || !built.length) return;
        reveal(built.length === 1 ? built[0].orderDir : outbox);
      })
      .catch((err) => {
        run.error = `${err.seam ?? 'unknown'} seam: ${err.message}`;
      })
      .finally(() => {
        run.active = false;
        run.stopping = false;
        run.orderId = null;
        runController = null;
      });
  }

  /** The Stop button. Cooperative: the photo on the GPU finishes, then the run winds down at the
   *  next boundary. Idempotent, and a no-op when nothing is running. */
  function stopRun() {
    if (!run.active || !runController) return { stopping: false };
    run.stopping = true;
    runController.abort();
    return { stopping: true };
  }

  /** The "Načíst nové objednávky" button: run the autopilot once, on demand. Same code the scheduled
   *  task runs — poll Shopify, download photos for new paid orders, generate. Not awaited (it can take
   *  minutes over the network + GPU); the dashboard watches `autopilot.running` on the /api/studio poll
   *  and refreshes the board when it clears. Guarded by the shared run-lock so it can't collide with a
   *  manual run. Spends real credit per new order — the client confirms before calling this. */
  function startAutopilot() {
    if (run.active) throw new ReviewError('Právě běží generování — počkejte, až doběhne.');
    if (autopilot.running) throw new ReviewError('Načítání objednávek už běží.');
    if (inFlight.size) throw new ReviewError('Právě se přegenerovává fotka — počkejte, až to doběhne.');
    if (!config.shopify?.enabled || !config.shopify?.accessToken) {
      throw new ReviewError('Shopify není nastaveno (shopify.enabled + accessToken) — objednávky nelze načíst.');
    }
    autopilot.running = true;
    autopilot.lines = [];
    autopilot.report = null;
    autopilot.error = null;

    runAutopilot({
      config,
      onEvent: (e) => {
        const line = formatEvent(e);
        if (line === null) return;
        autopilot.lines.push(line);
        if (autopilot.lines.length > MAX_LOG_LINES) autopilot.lines.splice(0, autopilot.lines.length - MAX_LOG_LINES);
      },
    })
      .then((res) => {
        autopilot.report = res?.report ?? null;
        if (res && res.ran === false) autopilot.error = res.reason === 'disabled' ? 'Shopify je vypnuté.' : String(res.reason || 'nespuštěno');
      })
      .catch((err) => {
        autopilot.error = `${err.seam ?? 'autopilot'}: ${err.message}`;
      })
      .finally(() => {
        autopilot.running = false;
      });
  }

  async function startRedo(orderId, base) {
    requireIdle();
    const key = `${orderId}/${base}`;
    if (inFlight.has(key)) throw new ReviewError(`"${base}" is already being regenerated.`);
    const { order } = find(orderId, base);
    generator ??= createGeneratorDriver(config);
    inFlight.set(key, { message: 'starting…' });

    // Deliberately not awaited: the operator keeps reviewing while the GPU works. The tile
    // polls /api/state for progress, and state.json is the durable record either way.
    redo({
      config,
      orderDir: order.orderDir,
      base,
      driver: generator,
      qc,
      onEvent: (e) => {
        if (e.type === 'progress') inFlight.set(key, { message: `${e.step}: ${e.message}` });
      },
    })
      .catch((err) => {
        // redo() only throws for "cannot redo at all"; generation failures land in state.json.
        console.error(`redo ${key}: ${err.message}`);
      })
      .finally(() => inFlight.delete(key));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    // Unauthenticated liveness probe for a cloud host's health check — must answer before the gate.
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    // Optional password gate for public hosting (Render has no built-in auth). Active only when both
    // STUDIO_USER + STUDIO_PASS are set, so local runs are unchanged. HTTPS at the host makes Basic
    // Auth safe enough for one operator; without it the whole customer-book/WhatsApp panel is open.
    if (!checkAuth(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Fotomalovanky"', 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Přihlášení vyžadováno.');
    }

    try {
      // Home is the studio dashboard; the review grid moved to /review. Both are served from the
      // static tree through the same contained path.
      if (req.method === 'GET' && url.pathname === '/') {
        return serveStatic('/dashboard.html', res);
      }
      if (req.method === 'GET' && url.pathname === '/review') {
        return serveStatic('/index.html', res);
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        return json(res, 200, { orders: forClient(state(), inFlight), inbox, outbox, run, selected, queue });
      }

      // GET /api/studio — the live order board behind the dashboard's Objednávky + Potřebuje vás
      // tabs: every order's derived status oldest-first, KPI counts, and the needs-you list.
      if (req.method === 'GET' && url.pathname === '/api/studio') {
        const board = studioBoard({
          inboxRoot: inbox,
          outboxRoot: outbox,
          runningOrderId: run.active ? run.orderId : null,
          only: selected,
          memoryRoot,
          firstLiveOrder: config.studio?.firstLiveOrder ?? null,
          dataDir: config.shopify?.dataDir ?? null,
        });
        return json(res, 200, { ...board, inbox, run: { active: run.active, orderId: run.orderId }, autopilot: { running: autopilot.running, error: autopilot.error, report: autopilot.report } });
      }

      // GET /api/mail — the read-only Proton inbox tile. Always 200 with a stable shape: the tile
      // renders an "offline" state from `available:false` rather than the fetch throwing. A good read
      // is cached briefly; failures are not, so the tile recovers as soon as Bridge is back.
      if (req.method === 'GET' && url.pathname === '/api/mail') {
        if (!mail) return json(res, 200, { available: false, reason: 'not-configured' });
        // The home tile takes the default few; the Pošta tab asks for a fuller inbox via ?limit (capped
        // at 50 so one IMAP fetch stays cheap). Cache is keyed by limit so the two callers don't thrash.
        const q = Number(url.searchParams.get('limit'));
        const limit = Number.isInteger(q) && q > 0 ? Math.min(q, 50) : mailLimit;
        if (mailCache && mailCache.limit === limit && Date.now() - mailCache.at < MAIL_TTL) return json(res, 200, mailCache.payload);
        try {
          const raw = await mail.fetchInbox({ limit });
          const payload = { ...summarizeInbox(raw, { limit }), fetchedAt: new Date().toISOString() };
          mailCache = { at: Date.now(), limit, payload };
          return json(res, 200, payload);
        } catch (err) {
          const reason = err instanceof BridgeError ? err.code : 'unknown';
          return json(res, 200, { available: false, reason, detail: err.message });
        }
      }

      // GET /api/mail/message?uid=N — one message's full body, opened by clicking it in the tile.
      if (req.method === 'GET' && url.pathname === '/api/mail/message') {
        if (!mail) return json(res, 503, { error: 'Pošta není nastavena.', code: 'not-configured' });
        const uid = Number(url.searchParams.get('uid'));
        if (!Number.isInteger(uid) || uid <= 0) return json(res, 400, { error: 'Neplatné id zprávy.' });
        try {
          const message = await mail.fetchMessage({ uid });
          mailCache = null; // opening marked the message \Seen; drop the cache so the unread badge re-reads
          return json(res, 200, message);
        } catch (err) {
          const code = err instanceof BridgeError ? err.code : 'unknown';
          return json(res, 502, { error: `Zprávu se nepodařilo načíst — ${err.message}`, code });
        }
      }

      // GET /api/mail/templates — the approved prewritten messages the composer's picker offers.
      if (req.method === 'GET' && url.pathname === '/api/mail/templates') {
        return json(res, 200, { templates: templateList() });
      }

      // POST /api/mail/send { to, subject, body, inReplyTo?, references? } — the composer's Send. This
      // is the only outbound action; it runs solely on an explicit click. A body still carrying a
      // [PLACEHOLDER] token is refused so a half-filled template can't go to a customer by accident.
      if (req.method === 'POST' && url.pathname === '/api/mail/send') {
        if (!smtp) return json(res, 503, { error: 'Odesílání pošty není nastaveno.', code: 'not-configured' });
        const { to, subject, body, inReplyTo, references } = await readJson(req, 1024 * 1024);
        if (!to || !String(to).trim()) return json(res, 400, { error: 'Chybí příjemce (komu).' });
        if (!body || !String(body).trim()) return json(res, 400, { error: 'Zpráva je prázdná.' });
        const left = unfilledPlaceholders(String(subject ?? ''), String(body));
        if (left.length) return json(res, 400, { error: `Před odesláním vyplňte: ${left.join(', ')}`, code: 'placeholder', placeholders: left });
        try {
          const sent = await smtp.sendMail({
            to: String(to).trim(),
            subject: String(subject ?? ''),
            text: String(body),
            inReplyTo: inReplyTo ? String(inReplyTo) : '',
            references: Array.isArray(references) ? references : references ? [String(references)] : [],
          });
          mailCache = null; // the Sent copy shifts the mailbox; let the next tile poll re-read
          return json(res, 200, { sent: true, messageId: sent.messageId });
        } catch (err) {
          const status = err instanceof SmtpError && err.code === 'bad-input' ? 400 : err instanceof SmtpError && err.code === 'auth' ? 502 : 502;
          const code = err instanceof SmtpError ? err.code : 'unknown';
          return json(res, status, { error: `Zprávu se nepodařilo odeslat — ${err.message}`, code });
        }
      }

      // POST /api/mail/delete { uid } — move one message to Trash. Reversible (Proton keeps it in
      // Trash); the list drops it and the cache is cleared so the next poll re-reads the mailbox.
      if (req.method === 'POST' && url.pathname === '/api/mail/delete') {
        if (!mail) return json(res, 503, { error: 'Pošta není nastavena.', code: 'not-configured' });
        const { uid } = await readJson(req, 4096);
        const id = Number(uid);
        if (!Number.isInteger(id) || id <= 0) return json(res, 400, { error: 'Neplatné id zprávy.' });
        try {
          const out = await mail.deleteMessage({ uid: id });
          mailCache = null; // the message left the inbox; let the next tile poll re-read
          return json(res, 200, out);
        } catch (err) {
          const code = err instanceof BridgeError ? err.code : 'unknown';
          return json(res, 502, { error: `Zprávu se nepodařilo smazat — ${err.message}`, code });
        }
      }

      // POST /api/mail/flag { uid, seen } — mark a message read (seen:true) or unread (seen:false),
      // e.g. to flag one to come back to. Cache cleared so the unread count re-reads from IMAP.
      if (req.method === 'POST' && url.pathname === '/api/mail/flag') {
        if (!mail) return json(res, 503, { error: 'Pošta není nastavena.', code: 'not-configured' });
        const { uid, seen } = await readJson(req, 4096);
        const id = Number(uid);
        if (!Number.isInteger(id) || id <= 0) return json(res, 400, { error: 'Neplatné id zprávy.' });
        try {
          const out = await mail.setSeen({ uid: id, seen: seen === true });
          mailCache = null;
          return json(res, 200, out);
        } catch (err) {
          const code = err instanceof BridgeError ? err.code : 'unknown';
          return json(res, 502, { error: `Zprávu se nepodařilo označit — ${err.message}`, code });
        }
      }

      // GET /api/whatsapp — the delivery channel's link state, so the board can show "propojeno" or a
      // QR to scan. Always 200 with a stable shape; the session links lazily on the first read.
      if (req.method === 'GET' && url.pathname === '/api/whatsapp') {
        if (!wa) return json(res, 200, { available: false, state: 'disabled' });
        try {
          return json(res, 200, await wa.status());
        } catch (err) {
          return json(res, 200, { available: false, state: 'offline', detail: err.message });
        }
      }

      // GET /api/whatsapp/groups — the groups the linked account is in, so delivery can target a stable
      // group id ("…@g.us") instead of one person's number. Requires a linked session (409 if not).
      if (req.method === 'GET' && url.pathname === '/api/whatsapp/groups') {
        if (!wa?.listGroups) return json(res, 503, { error: 'WhatsApp odesílání není nastaveno.', code: 'not-configured' });
        try {
          return json(res, 200, { groups: await wa.listGroups() });
        } catch (err) {
          const code = err instanceof WhatsAppError ? err.code : 'unknown';
          return json(res, code === 'not-linked' ? 409 : 503, { error: err.message, code });
        }
      }

      // GET /api/settings — the Nastavení screen's read-only status (N14). Reports what is wired and
      // where, never a secret value: tokens, passwords and the token-scoped generator URL are surfaced
      // only as configured-or-not (+ safe host/user), never rendered. Changing the input folder is a
      // separate POST /api/_scan, so this handler stays a pure read.
      if (req.method === 'GET' && url.pathname === '/api/settings') {
        const hostOf = (u) => { try { return new URL(u).host; } catch { return null; } };
        let whatsapp = { available: false, state: wa ? 'offline' : 'disabled' };
        if (wa) {
          try { const s = await wa.status(); whatsapp = { available: s.available, state: s.state }; } catch { /* keep offline */ }
        }
        const report = readReport(config.shopify?.dataDir ?? null);
        return json(res, 200, {
          folders: { inbox, outbox },
          whatsapp,
          integrations: {
            generator: { configured: Boolean(config.generator?.baseUrl), host: hostOf(config.generator?.baseUrl), mode: config.generator?.mode ?? null },
            shopify: { configured: Boolean(config.shopify?.accessToken), enabled: Boolean(config.shopify?.enabled), storeDomain: config.shopify?.storeDomain ?? null, apiVersion: config.shopify?.apiVersion ?? null },
            ai: { configured: Boolean(config.ai?.apiKey), enabled: Boolean(config.ai?.enabled), model: config.ai?.model ?? null },
            mail: { configured: Boolean(config.mail?.pass), enabled: Boolean(config.mail?.enabled), user: config.mail?.user ?? null, from: config.mail?.fromAddress ?? config.mail?.user ?? null, host: config.mail?.host ?? null, port: config.mail?.port ?? null },
          },
          autopilot: report ? { lastRun: report.ranAt ?? null, processed: report.processed ?? null, generated: report.generated ?? null, estSpend: report.estSpend ?? null } : { lastRun: null },
          retentionDays: config.retentionDays ?? null,
        });
      }

      // GET /api/studio/templates — the Creative Studio pickers: the 5 template families (each with the
      // image slots + copy fields it needs and its seed copy), the colour themes (secondary styling), and
      // the output formats. No customer data; marketing imagery is AI-made, never from orders.
      if (req.method === 'GET' && url.pathname === '/api/studio/templates') {
        return json(res, 200, {
          templates: listTemplates(),
          themes: Object.keys(THEMES),
          formats: DEFAULT_FORMATS.map((k) => ({ key: k, label: STUDIO_FORMATS[k].label, w: STUDIO_FORMATS[k].w, h: STUDIO_FORMATS[k].h })),
          aiEnabled: Boolean(config?.ai?.enabled),
        });
      }

      // GET /api/creatives/calendar — the marketing-calendar occasions, each merged with any ads already
      // generated for it (the "calendar of ads"). Ad PNGs are served by /creatives/ad/<key>/<file> below.
      if (req.method === 'GET' && url.pathname === '/api/creatives/calendar') {
        const index = readCreativesIndex(config.creatives.dataDir);
        const occasions = MARKETING_CAL.map((o) => {
          const key = occasionKey(o);
          const entry = index.occasions[key];
          return {
            key,
            m: o.m,
            d: o.d,
            name: o.name,
            persona: o.persona,
            angle: o.angle,
            tone: o.tone,
            generatedAt: entry?.generatedAt ?? null,
            ads: (entry?.ads ?? []).map((a) => ({
              family: a.family,
              template: a.template,
              format: a.format,
              copy: a.copy ?? null,
              url: `/creatives/ad/${key}/${encodeURIComponent(a.file)}`,
            })),
          };
        });
        return json(res, 200, { generatedAt: index.generatedAt, aiEnabled: Boolean(config?.ai?.enabled), occasions });
      }

      // GET /creatives/ad/<key>/<file> — one generated ad PNG from the creatives data dir. Addressed by
      // (key, file), both regex-validated, and the resolved path is confined to the ads folder so nothing
      // from the URL can escape it.
      if (req.method === 'GET' && parts[0] === 'creatives' && parts[1] === 'ad' && parts.length === 4) {
        const key = parts[2];
        const file = decodeURIComponent(parts[3]);
        if (!/^\d{2}-\d{2}-[a-z0-9-]+$/.test(key) || !/^[a-z0-9_.-]+\.png$/i.test(file)) return json(res, 400, { error: 'bad id' });
        const root = resolve(config.creatives.dataDir, 'ads');
        const path = resolve(root, key, file);
        if (!path.startsWith(root + sep)) return json(res, 400, { error: 'bad path' });
        if (!existsSync(path)) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        return res.end(readFileSync(path));
      }

      // GET /studio/preview?template=&format=&theme=&<copy fields>=&images=<id> — the layered concept as
      // HTML for the studio's <iframe>. The app assembles the ad from the template; the AI only supplied
      // the slot images. Also returns its QC status via a header the client reads for the status pill.
      if (req.method === 'GET' && url.pathname === '/studio/preview') {
        const concept = studioConceptFrom(url.searchParams);
        const qc = validateConcept(concept);
        const html = renderStudioHtml(concept);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Studio-Status': qc.status });
        return res.end(html);
      }

      // GET /api/studio/validate?... — the QC findings for the current concept (clickable warnings).
      if (req.method === 'GET' && url.pathname === '/api/studio/validate') {
        return json(res, 200, validateConcept(studioConceptFrom(url.searchParams)));
      }

      // GET /studio/render?... — the concept rasterised to a PNG for download, named per the export
      // scheme (fotomalovanky_<occasion>_<angle>_<format>_NN.png). The one place headless Chromium runs.
      if (req.method === 'GET' && url.pathname === '/studio/render') {
        const concept = studioConceptFrom(url.searchParams);
        const F = STUDIO_FORMATS[concept.format];
        const html = renderStudioHtml(concept);
        let buf;
        try {
          buf = await renderCreativePng({ html, width: F.w, height: F.h });
        } catch (err) {
          if (err instanceof CreativeRenderError) return json(res, 503, { error: err.message });
          throw err;
        }
        const name = creativeFilename({ occasion: url.searchParams.get('occasion') || concept.template.family, angle: concept.template.id, format: concept.format, index: Number(url.searchParams.get('index')) || 1 });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
        return res.end(buf);
      }

      // POST /api/creative/ai-image { referenceBase64?, referenceMime?, prompt?, auto? } — generate the
      // ad's before (Nano Banana Pro) + after (RunPod line-art), cache the pair, and return a short id
      // the preview/render reference via ?images=<id>. Two modes: manual needs a typed `prompt`; `auto`
      // needs a reference photo, which Gemini reads into an identity-free prompt (returned so the UI can
      // show it) before generating from that text alone. The only creative route that spends money.
      if (req.method === 'POST' && url.pathname === '/api/creative/ai-image') {
        const { referenceBase64, referenceMime, prompt, auto } = await readJson(req, 16 * 1024 * 1024); // photos are big
        const wantAuto = auto === true;
        if (wantAuto && !referenceBase64) return json(res, 400, { error: 'Pro automatický popis nahrajte fotku.' });
        if (!wantAuto && (!prompt || !String(prompt).trim())) return json(res, 400, { error: 'Zadejte prompt (co má AI vytvořit).' });
        let pair;
        try {
          pair = await makeAdImages({ referenceBase64: referenceBase64 || null, referenceMime: referenceMime || 'image/jpeg', prompt, auto: wantAuto });
        } catch (err) {
          if (err instanceof AiImageError || err instanceof AdImageError) {
            const status = err.code === 'not-configured' ? 503 : err.code === 'auth' ? 502 : err.code === 'timeout' ? 504 : err.code === 'bad-input' ? 400 : 502;
            return json(res, status, { error: err.message, code: err.code });
          }
          throw err;
        }
        const id = String(++creativeImageSeq);
        creativeImages.set(id, { before: toDataUri(pair.before), after: toDataUri(pair.after), at: Date.now() });
        // Bound the cache: drop the oldest once it grows past a couple dozen sets.
        while (creativeImages.size > 24) creativeImages.delete(creativeImages.keys().next().value);
        // `prompt` in the response is the auto-described one when present, else the operator's own text,
        // so the UI can drop it into the prompt box after an auto run.
        return json(res, 200, { id, before: toDataUri(pair.before), after: toDataUri(pair.after), prompt: pair.prompt ?? (prompt ?? null) });
      }

      // ---- Blog Creator (SEO Czech posts -> Shopify draft) ------------------------------------
      // The AI text seam for the blog (topics + drafts). Undefined when AI is off, so the topic engine
      // degrades to calendar-only and draft generation reports a clear "AI off" error instead of 500ing.
      const blogTextFn = config.ai?.enabled ? (a) => generateText({ config: config.ai, model: 'gemini-flash-latest', ...a }) : undefined;
      const blogDir = config.blog?.dataDir;

      // GET /api/blog/topics — the ranked topic list: calendar occasions + (if AI on) hot SEO suggestions.
      if (req.method === 'GET' && url.pathname === '/api/blog/topics') {
        if (!config.blog?.enabled) return json(res, 200, { enabled: false, aiEnabled: Boolean(config.ai?.enabled), topics: [] });
        const { topics, aiUsed } = await suggestTopics({ generateTextFn: blogTextFn, config: config.ai });
        return json(res, 200, { enabled: true, aiEnabled: Boolean(config.ai?.enabled), aiUsed, topics });
      }

      // POST /api/blog/draft { topic } — generate a full SEO draft from a topic, save it as `koncept`,
      // return the post. Never publishes; the model failing degrades to an editable skeleton.
      if (req.method === 'POST' && url.pathname === '/api/blog/draft') {
        if (!config.blog?.enabled) return json(res, 503, { error: 'Blog není zapnutý (blog.enabled).', code: 'not-configured' });
        if (!config.ai?.enabled) return json(res, 503, { error: 'AI není zapnutá (ai.enabled) — bez ní nelze psát článek.', code: 'ai-off' });
        const { topic } = await readJson(req, 64 * 1024);
        if (!topic || !topic.title) return json(res, 400, { error: 'Chybí téma článku.' });
        const post = await generatePost({
          topic,
          generateTextFn: blogTextFn,
          config: config.ai,
          wordCountMin: config.blog.wordCountMin,
          wordCountMax: config.blog.wordCountMax,
        });
        return json(res, 200, { post: savePost(blogDir, post) });
      }

      // GET /api/blog/posts        — list saved drafts (summaries)
      // GET /api/blog/posts?id=... — one full draft
      if (req.method === 'GET' && url.pathname === '/api/blog/posts') {
        if (!config.blog?.enabled) return json(res, 200, { enabled: false, posts: [] });
        const id = url.searchParams.get('id');
        if (id) {
          const post = readPost(blogDir, id);
          return post ? json(res, 200, { post }) : json(res, 404, { error: 'Koncept nenalezen.' });
        }
        return json(res, 200, { enabled: true, posts: listPosts(blogDir) });
      }

      // POST /api/blog/posts { post } — save David's edits. Re-derives plainText from the (edited) body
      // HTML and re-runs QC so warnings track what he actually wrote. The id (store key) stays stable.
      if (req.method === 'POST' && url.pathname === '/api/blog/posts') {
        if (!config.blog?.enabled) return json(res, 503, { error: 'Blog není zapnutý.', code: 'not-configured' });
        const { post } = await readJson(req, 1024 * 1024);
        if (!post || !post.id) return json(res, 400, { error: 'Chybí koncept k uložení.' });
        const existing = readPost(blogDir, post.id);
        if (!existing) return json(res, 404, { error: 'Koncept nenalezen.' });
        // Never let an edit flip a Shopify-sent post's server-owned fields; keep them from the stored copy.
        const merged = recomputePost({ ...existing, ...post, id: existing.id, status: existing.status, shopifyArticleId: existing.shopifyArticleId }, { wordCountMin: config.blog.wordCountMin });
        return json(res, 200, { post: savePost(blogDir, merged) });
      }

      // DELETE /api/blog/posts?id=... — remove a local draft.
      if (req.method === 'DELETE' && url.pathname === '/api/blog/posts') {
        if (!config.blog?.enabled) return json(res, 503, { error: 'Blog není zapnutý.', code: 'not-configured' });
        const id = url.searchParams.get('id');
        if (!id) return json(res, 400, { error: 'Chybí id konceptu.' });
        deletePost(blogDir, id);
        return json(res, 200, { ok: true });
      }

      // GET /api/blog/blogs — the store's Shopify blogs, so David can pick where the article lands.
      if (req.method === 'GET' && url.pathname === '/api/blog/blogs') {
        if (!config.shopify?.storeDomain || !config.shopify?.contentToken) {
          return json(res, 503, { error: 'Shopify content token není nastaven (write_content).', code: 'not-configured' });
        }
        const client = createContentClient({ storeDomain: config.shopify.storeDomain, contentToken: config.shopify.contentToken, apiVersion: config.shopify.apiVersion });
        try {
          return json(res, 200, { blogs: await client.listBlogs(), selected: config.blog?.blogId ?? null });
        } catch (err) {
          return json(res, 502, { error: err.message, code: err.code ?? 'unknown' });
        }
      }

      // POST /api/blog/publish { id, blogId? } — create the draft in Shopify as an UNPUBLISHED article and
      // move the local status to `odesláno`. David reviews + publishes from Shopify admin. Never goes live here.
      if (req.method === 'POST' && url.pathname === '/api/blog/publish') {
        if (!config.blog?.enabled) return json(res, 503, { error: 'Blog není zapnutý.', code: 'not-configured' });
        if (!config.shopify?.storeDomain || !config.shopify?.contentToken) {
          return json(res, 503, { error: 'Chybí Shopify content token s oprávněním write_content.', code: 'not-configured' });
        }
        const { id, blogId } = await readJson(req, 8192);
        const post = readPost(blogDir, id);
        if (!post) return json(res, 404, { error: 'Koncept nenalezen.' });
        const target = (typeof blogId === 'string' && blogId.trim()) || config.blog?.blogId;
        if (!target) return json(res, 400, { error: 'Vyberte cílový blog.', code: 'no-blog' });
        const client = createContentClient({ storeDomain: config.shopify.storeDomain, contentToken: config.shopify.contentToken, apiVersion: config.shopify.apiVersion });
        try {
          const article = await client.createArticleDraft({ blogId: target, post, author: config.blog.author });
          const updated = savePost(blogDir, { ...post, status: 'odeslano', shopifyArticleId: article.id, shopifyHandle: article.handle, publishedBlogId: target });
          return json(res, 200, { post: updated, article });
        } catch (err) {
          const status = err.code === 'handle-taken' ? 409 : err.code === 'scope' || err.code === 'auth' ? 502 : err.code === 'bad-input' || err.code === 'no-blog' ? 400 : 502;
          return json(res, status, { error: err.message, code: err.code ?? 'unknown' });
        }
      }

      // POST /api/_scan { path } — what orders are in that folder? Spends nothing, starts nothing.
      // Pointing at a folder is how the operator finds out what is in it.
      if (req.method === 'POST' && url.pathname === '/api/_scan') {
        requireIdle();
        const { path } = await readJson(req);
        const candidate = String(path ?? '').trim() || inbox;
        const found = scanInbox(candidate); // a missing folder becomes a 409, not a crash
        inbox = candidate;
        // A handful is what the operator meant to pick, so tick them. A folder holding hundreds
        // is the archive, opened by mistake — tick nothing rather than bill them for it.
        selected = found.length <= AUTO_TICK_LIMIT ? found.map((o) => o.orderId) : [];
        return json(res, 200, { inbox, selected, orders: queue });
      }

      // POST /api/_select { orders: [id] | null } — which of them to run. null means all.
      if (req.method === 'POST' && url.pathname === '/api/_select') {
        requireIdle();
        const { orders } = await readJson(req);
        selected = Array.isArray(orders) ? orders.map(String) : null;
        return json(res, 200, { selected });
      }

      // POST /api/_run  { inbox?, force?, buildPdfs? } — Go (buildPdfs:false, generate only) / PDF (build).
      if (req.method === 'POST' && url.pathname === '/api/_run') {
        startRun(await readJson(req));
        return json(res, 202, { started: true, inbox });
      }

      // POST /api/_stop — the Stop button. Winds the run down at the next photo boundary.
      if (req.method === 'POST' && url.pathname === '/api/_stop') {
        return json(res, 200, stopRun());
      }

      // POST /api/autopilot/run — the "Načíst nové objednávky" button. Fires the autopilot once (fetch
      // new Shopify orders + generate). 202 + returns immediately; the board poll tracks completion.
      if (req.method === 'POST' && url.pathname === '/api/autopilot/run') {
        startAutopilot(); // throws ReviewError → 409 when busy / Shopify off
        return json(res, 202, { started: true });
      }

      // GET /api/autopilot/status — running flag + the last run's log/report/error, for the button.
      if (req.method === 'GET' && url.pathname === '/api/autopilot/status') {
        return json(res, 200, { running: autopilot.running, lines: autopilot.lines, report: autopilot.report, error: autopilot.error });
      }

      // POST /api/_shutdown — stop the server cleanly. Runs the graceful shutdown (closes WhatsApp's
      // Chromium via client.destroy) BEFORE exiting, so the linked session flushes to disk and the next
      // start restores it without a re-scan. This is how the server is restarted programmatically on
      // Windows, where a background process can't be sent a real Ctrl-C/SIGINT. Localhost-only server.
      if (req.method === 'POST' && url.pathname === '/api/_shutdown') {
        json(res, 200, { stopping: true });
        // Answer first, then close the browser and exit once the response has flushed.
        setTimeout(() => { shutdown().finally(() => process.exit(0)); }, 150);
        return;
      }

      // POST /api/_pick-folder { startAt? } — a native folder dialog, so no path has to be typed.
      if (req.method === 'POST' && url.pathname === '/api/_pick-folder') {
        const { startAt } = await readJson(req);
        // Said out loud in the operator's window. A folder dialog that fails to appear is
        // otherwise indistinguishable from a button that never did anything at all.
        log('Opening the folder picker… (it may be behind this window)');
        const picked = await pickFolder(String(startAt ?? ''));
        log(picked.path ? `Folder chosen: ${picked.path}` : picked.available ? 'Folder picker closed without choosing.' : 'The folder picker could not be opened.');
        return json(res, 200, picked);
      }

      // GET /img/<order>/<base>/<original|coloring>
      if (req.method === 'GET' && parts[0] === 'img' && parts.length === 4) {
        const { photo } = find(parts[1], parts[2]);
        const path = parts[3] === 'coloring' ? photo.files.coloring : photo.files.original;
        if (!path) return json(res, 404, { error: 'not generated yet' });
        let buf;
        try {
          buf = await thumbnail(path);
        } catch {
          // A truncated download or a file that isn't really an image. One bad tile must not
          // take down the grid, and the operator needs to see *which* photo is unreadable.
          return json(res, 415, { error: 'unreadable image' });
        }
        // no-store: after a redo the same URL must not serve the previous render.
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
        return res.end(buf);
      }

      // GET /svg/<order>/<base> — the vector page itself, for the editor to draw on. Addressed
      // by (order, base) like the images, so no path from the page can reach the filesystem.
      if (req.method === 'GET' && parts[0] === 'svg' && parts.length === 3) {
        const { photo } = find(parts[1], parts[2]);
        if (!photo.files.svg) return json(res, 404, { error: 'not generated yet' });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(readFileSync(photo.files.svg));
      }

      // POST /api/_open/<generator|folder>[/<order>] — the server opens it, so no path or token
      // is ever handed to the page. Reserved prefix, so an order can never shadow this route.
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === '_open') {
        if (parts[2] === 'generator') return json(res, 200, { opened: await openExternally(config.generator.baseUrl) });
        if (parts[2] === 'folder' && parts[3]) {
          const order = state().find((o) => o.orderId === parts[3]);
          if (!order) return json(res, 404, { error: 'Unknown order.' });
          return json(res, 200, { opened: await openExternally(order.orderDir) });
        }
        return json(res, 404, { error: 'Not found.' });
      }

      // POST /api/<order>/dedication — the book's title-page text.
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 3 && parts[2] === 'dedication') {
        requireIdle();
        const order = state().find((o) => o.orderId === parts[1]);
        if (!order) throw new ReviewError(`Unknown order "${parts[1]}".`);
        const { text } = await readJson(req);
        return json(res, 200, { dedication: setOrderDedication(order.orderDir, text, { memoryRoot }) });
      }

      // POST /api/<order>/intake-override — "generate it anyway" clears an intake hold, so the
      // next Go generates the order despite the flagged photos. A missing-photos hold requires
      // `confirmCount` (the typed reduced page count); overrideIntake throws a ReviewError (→ 409)
      // if it does not match, so the operator cannot ship an under-count book on a stray click.
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 3 && parts[2] === 'intake-override') {
        requireIdle();
        const order = state().find((o) => o.orderId === parts[1]);
        if (!order) throw new ReviewError(`Unknown order "${parts[1]}".`);
        const { confirmCount = null } = await readJson(req).catch(() => ({}));
        return json(res, 200, overrideIntake(order.orderDir, { confirmCount }));
      }

      // POST /api/whatsapp/test — send a test document to confirm the link works end-to-end, WITHOUT
      // marking any order delivered. The server picks a built PDF (never a client-supplied path, so this
      // can't be used to exfiltrate an arbitrary file). Optional body { to } overrides the destination —
      // used to verify a group id ("…@g.us") before it's made the configured recipient.
      if (req.method === 'POST' && url.pathname === '/api/whatsapp/test') {
        if (!wa) return json(res, 503, { error: 'WhatsApp odesílání není nastaveno.', code: 'not-configured' });
        const { to } = await readJson(req, 4096).catch(() => ({}));
        const withPdf = state().map((o) => ({ o, pdf: pdfPathFor(o.orderDir, o.orderId) })).find((x) => existsSync(x.pdf));
        if (!withPdf) return json(res, 400, { error: 'Není žádné hotové PDF k odeslání jako test.' });
        try {
          const sent = await wa.sendDocument({ filePath: withPdf.pdf, caption: 'Test z Fotomalovánky studia ✅ — WhatsApp spojení funguje.', to: to || undefined });
          return json(res, 200, { sent: true, to: sent.to, order: withPdf.o.orderId });
        } catch (err) {
          const code = err instanceof WhatsAppError ? err.code : 'unknown';
          return json(res, 502, { error: `Testovací odeslání selhalo — ${err.message}`, code });
        }
      }

      // POST /api/<order>/deliver — the operator's explicit "Odeslat Jirkovi": send the finished
      // <order> Final.pdf to Jirka's WhatsApp with the order number as caption, THEN mark it delivered.
      // The order is written to 'sent' ONLY when the WhatsApp send resolves — a failed send leaves the
      // order on the board with a visible error so the operator can retry. Sent regardless of payment.
      // This is the sole point books leave for the printer; the overnight autopilot never reaches here.
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 3 && parts[2] === 'deliver') {
        if (!wa) return json(res, 503, { error: 'WhatsApp odesílání není nastaveno.', code: 'not-configured' });
        const order = state().find((o) => o.orderId === parts[1]);
        if (!order) throw new ReviewError(`Unknown order "${parts[1]}".`);
        const pdfPath = pdfPathFor(order.orderDir, order.orderId);
        if (!existsSync(pdfPath)) return json(res, 409, { error: 'PDF ještě není hotové — nejdřív ho vytvořte.', code: 'no-pdf' });
        try {
          const sent = await wa.sendDocument({ filePath: pdfPath, caption: deliveryCaption(order.orderId) });
          const status = markDelivered(order.orderDir, { by: 'whatsapp', to: sent.to, messageId: sent.id }); // marks 'sent' — only reached on a successful send
          return json(res, 200, { status, sent: true, messageId: sent.id });
        } catch (err) {
          const code = err instanceof WhatsAppError ? err.code : 'unknown';
          return json(res, 502, { error: `Odeslání Jirkovi selhalo — ${err.message}`, code });
        }
      }

      // POST /api/<order>/sent — the operator confirms the finished book has gone to Jirka. Writes
      // the delivery marker so the order derives to 'sent' and drops off the active board. Manual
      // only: nothing here contacts anyone, it records that the operator already did (the fallback
      // when WhatsApp isn't linked and David sent the book by hand).
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 3 && parts[2] === 'sent') {
        const order = state().find((o) => o.orderId === parts[1]);
        if (!order) throw new ReviewError(`Unknown order "${parts[1]}".`);
        return json(res, 200, { status: markDelivered(order.orderDir) });
      }

      // GET /api/<order>/pdf — the finished <order> Final.pdf, inline, so the operator can open it in a
      // new tab and check the book before sending it to Jirka. Addressed by order id (no path from the
      // page reaches the filesystem); 404 until the book is built. no-store so a rebuilt PDF isn't cached.
      if (req.method === 'GET' && parts[0] === 'api' && parts.length === 3 && parts[2] === 'pdf') {
        const order = state().find((o) => o.orderId === parts[1]);
        if (!order) return json(res, 404, { error: 'Unknown order.' });
        const pdfPath = pdfPathFor(order.orderDir, order.orderId);
        if (!existsSync(pdfPath)) return json(res, 404, { error: 'PDF ještě není hotové.' });
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${order.orderId}.pdf"`,
          'Cache-Control': 'no-store',
        });
        return res.end(readFileSync(pdfPath));
      }

      // POST /api/<order>/delete — remove an order from the board for good. Writes a hidden marker so it
      // stops showing (the folder + files stay on disk, recoverable by deleting the marker), and marks it
      // handled so the auto-fetch poll never re-materializes and regenerates it from Shopify. Refused
      // while that order is mid-generation, so a live run's folder isn't yanked out from under it.
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 3 && parts[2] === 'delete') {
        const order = state().find((o) => o.orderId === parts[1]);
        if (!order) return json(res, 404, { error: 'Unknown order.' });
        if (run.active && run.orderId === order.orderId) return json(res, 409, { error: 'Objednávka se právě generuje — počkejte, než doběhne.', code: 'busy' });
        mkdirSync(order.orderDir, { recursive: true });
        writeFileSync(hiddenMarkerPath(order.orderDir), JSON.stringify({ hiddenAt: new Date().toISOString() }, null, 2));
        if (config.shopify?.dataDir) {
          try {
            const st = loadState(config.shopify.dataDir);
            markHandled(st, order.orderId, { status: 'deleted', at: new Date().toISOString() });
            saveState(config.shopify.dataDir, st);
          } catch { /* best-effort — the hidden marker alone still keeps it off the board */ }
        }
        return json(res, 200, { deleted: order.orderId });
      }

      // POST /api/<order>/unsent — undo a delivery mark set by mistake; the order returns to the board.
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 3 && parts[2] === 'unsent') {
        const order = state().find((o) => o.orderId === parts[1]);
        if (!order) throw new ReviewError(`Unknown order "${parts[1]}".`);
        unmarkDelivered(order.orderDir);
        return json(res, 200, { ok: true });
      }

      // POST /api/<order>/emailed { on? } — the operator marks (or clears) that they emailed the
      // customer about a held order (N4), so the queue can age it and stop the hold from rotting.
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 3 && parts[2] === 'emailed') {
        const order = state().find((o) => o.orderId === parts[1]);
        if (!order) throw new ReviewError(`Unknown order "${parts[1]}".`);
        const { on = true } = await readJson(req).catch(() => ({}));
        return json(res, 200, { emailedAt: markCustomerEmailed(order.orderDir, on) });
      }

      // POST /api/<order>/printed — the operator confirms Jirka printed the book (N3). Terminal marker
      // that closes the lifecycle past 'sent' and makes the order's photos purge-eligible. Manual only.
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 3 && parts[2] === 'printed') {
        const order = state().find((o) => o.orderId === parts[1]);
        if (!order) throw new ReviewError(`Unknown order "${parts[1]}".`);
        return json(res, 200, { status: markPrinted(order.orderDir) });
      }

      // POST /api/<order>/unprinted — undo a printed mark set by mistake; the order returns to 'sent'.
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 3 && parts[2] === 'unprinted') {
        const order = state().find((o) => o.orderId === parts[1]);
        if (!order) throw new ReviewError(`Unknown order "${parts[1]}".`);
        unmarkPrinted(order.orderDir);
        return json(res, 200, { ok: true });
      }

      // POST /api/<order>/<base>/<action>
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 4) {
        const [, orderId, base, action] = parts;
        requireIdle();
        const { order } = find(orderId, base);
        if (action === 'approve') return json(res, 200, { status: approve(order.orderDir, base) });
        if (action === 'reject') return json(res, 200, { status: reject(order.orderDir, base) });
        if (action === 'handoff') return json(res, 200, { status: handoff(order.orderDir, base) });
        if (action === 'replaced') {
          const { status } = await acceptReplacement({ orderDir: order.orderDir, base, qc });
          return json(res, 200, { status });
        }
        if (action === 'redo') {
          await startRedo(orderId, base);
          return json(res, 202, { started: true });
        }
        // The operator's own white pencil and crop. The SVG is what the book prints, so that is
        // what gets edited; the raster the grid shows is re-made from it.
        if (action === 'edit') {
          const { strokes, crop } = await readJson(req, 4 * 1024 * 1024);
          const { status } = await applyPhotoEdit({ orderDir: order.orderDir, base, edits: { strokes, crop }, qc });
          return json(res, 200, { status });
        }
        if (action === 'revert') {
          const { status } = await revertPhotoEdit({ orderDir: order.orderDir, base, qc });
          return json(res, 200, { status });
        }
        return json(res, 404, { error: `Unknown action "${action}".` });
      }

      // Any other GET is a dashboard asset (the creatives SVGs it loads, its favicon, etc.), served
      // from static/ or 404. Every explicit route above has already returned, so this shadows none.
      if (req.method === 'GET') return serveStatic(url.pathname, res);

      return json(res, 404, { error: 'Not found.' });
    } catch (err) {
      // Both carry operator-facing text; neither is a bug in the tool.
      if (err instanceof ReviewError || err instanceof IngestError) return json(res, 409, { error: err.message });
      console.error(err);
      return json(res, 500, { error: err.message ?? 'Something went wrong.' });
    }
  });

  // Auto-fetch: poll Shopify for new orders on a timer so they land on the board on their own, without
  // the operator clicking "Načíst nové objednávky". Same pass as the button (fetch + generate), so a
  // tick that lands mid-run/redo/fetch is skipped silently by startAutopilot's run-lock. Off when
  // shopify.autoFetchMinutes<=0 or Shopify isn't configured. unref'd so it never blocks a clean stop.
  let autoFetchTimer = null;
  const autoFetchMin = config.shopify?.autoFetchMinutes ?? 0;
  if (autoFetchMin > 0 && config.shopify?.enabled && config.shopify?.accessToken) {
    const tick = () => { try { startAutopilot(); } catch { /* busy or unconfigured — skip this tick */ } };
    autoFetchTimer = setInterval(tick, Math.max(1, autoFetchMin) * 60_000);
    autoFetchTimer.unref?.();
    setTimeout(tick, 15_000).unref?.(); // pull new orders soon after boot, not a full interval later
    log(`auto-fetch: polling Shopify for new orders every ${autoFetchMin} min`);
  }

  // Auto-run: the Chrome extension drops a new order folder into the inbox, and nothing else triggers
  // generation for it (the Shopify autopilot only runs orders IT fetched). So poll the inbox and start
  // the pipeline the moment a folder is COMPLETE and settled — no manual "Spustit". Complete means
  // objednavka.json has landed (so the dedication is present) AND all expected photos are on disk AND the
  // folder has been quiet for SETTLE_MS (the download finished). An order whose outbox dir already holds a
  // state.json is skipped (already processed); the run-lock keeps this off a manual or autopilot run.
  function autoRunInbox() {
    if (run.active || autopilot.running || inFlight.size) return; // busy — catch it next tick
    let ready;
    try { ready = selectAutoRunOrders({ inbox, outbox }); } catch { return; } // missing folder — nothing to do
    if (!ready.length) return;
    try {
      startRun({ only: ready, buildPdfs: true, silent: true }); // full pipeline → PDF; update the board, never pop a desktop window
      log(`auto-run: started ${ready.length} new order(s): ${ready.join(', ')}`);
    } catch { /* a run started between the check and the call — next tick retries */ }
  }
  const autoRunSec = config.autoRunSeconds ?? 15; // seconds between inbox sweeps; 0 disables auto-run
  let autoRunTimer = null;
  if (autoRunSec > 0) {
    autoRunTimer = setInterval(autoRunInbox, Math.max(3, autoRunSec) * 1_000);
    autoRunTimer.unref?.();
    setTimeout(autoRunInbox, 6_000).unref?.(); // sweep soon after boot, not a full interval later
    log(`auto-run: watching inbox for new orders every ${autoRunSec}s`);
  }

  // Graceful stop: close the WhatsApp session's Chromium cleanly + stop the auto-fetch timer. Without the
  // clean WhatsApp close, killing the server (Ctrl-C, a restart) tears the browser down mid-flush and
  // whatsapp-web.js's NEXT restore hangs in 'connecting' forever — the recurring "re-scan the QR after
  // every restart" pain. Best-effort.
  async function shutdown() {
    if (autoFetchTimer) clearInterval(autoFetchTimer);
    if (autoRunTimer) clearInterval(autoRunTimer);
    try { await wa?.close?.(); } catch { /* best-effort */ }
  }

  return { server, inFlight, shutdown };
}

// CLI: node src/ui/server.js [inbox] [outbox] [--port 4173] [--no-open]
// This is what the double-click launcher runs: the operator's whole tool is this page.
/** Optional HTTP Basic Auth gate for public hosting. Returns true when the request is allowed: either
 *  no gate is configured (STUDIO_USER/STUDIO_PASS unset → local runs unchanged) or the request carries
 *  matching credentials. Timing-safe compare so the check can't be probed by response timing. */
export function checkAuth(req) {
  const user = process.env.STUDIO_USER;
  const pass = process.env.STUDIO_PASS;
  if (!user || !pass) return true; // no gate configured — local/dev
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return false;
  }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return safeEqual(decoded.slice(0, i), user) && safeEqual(decoded.slice(i + 1), pass);
}

/** Constant-time string compare (length-guarded — timingSafeEqual throws on length mismatch). */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const portFlag = argv.indexOf('--port');
  // Cloud hosts (Render) inject $PORT and require binding 0.0.0.0; local defaults stay 127.0.0.1:4173.
  const port = portFlag >= 0 ? Number(argv[portFlag + 1]) : Number(process.env.PORT) || 4173;
  const host = process.env.HOST || '127.0.0.1';
  const [inboxRoot, outboxRoot] = argv.filter((a) => !a.startsWith('--') && a !== String(port));

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`\n${err.message}\n`); // ConfigError already reads as instructions
    process.exit(1);
  }

  const { server, shutdown } = createReviewServer({ config, inboxRoot, outboxRoot, revealFinished: true, log: (m) => console.log(`  ${m}`) });
  // Close the WhatsApp Chromium cleanly on stop so the next start restores its session instead of
  // hanging. Guard against double-fire (SIGINT then SIGTERM) and give the browser a moment to flush.
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await shutdown();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  server.on('error', (err) => {
    const why =
      err.code === 'EADDRINUSE'
        ? `Port ${port} is already in use — the tool may already be open in another window.`
        : err.message;
    console.error(`\nCould not start: ${why}\n`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`;
    console.log(`\n  Fotomalovánky is running.\n\n  ${url}\n\n  Leave this window open. Close it (or press Ctrl-C) to stop.\n`);
    if (!argv.includes('--no-open')) {
      openExternally(url).then((opened) => {
        if (!opened) console.log(`  Could not open your browser by itself. Open it and go to  ${url}\n`);
      });
    }
  });
}
