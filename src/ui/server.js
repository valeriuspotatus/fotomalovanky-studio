import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { ZipArchive } from 'archiver';
import { loadConfig, assertPersistentDataDirs } from '../config.js';
import { createGeneratorDriver } from '../generator/factory.js';
import { BuilderDriver } from '../builder/builderDriver.js';
import { runPipeline, formatEvent, pdfPathFor } from '../orchestrator.js';
import { studioBoard, markSent, unmarkSent, markPrinted, unmarkPrinted } from '../studio.js';
import { backfillSentMarkers, planSentMarkerBackfill, SentMarkerMigrationError } from '../migrations/sentMarker.js';
import { inspectOutbox, purgeAutopilotData, purgeOriginals, purgeWarning } from '../retention.js';
import { readReport } from '../autopilotReport.js';
import { runAutopilot } from '../autopilot.js';
import { hiddenMarkerPath } from '../review.js';
import { loadState, markHandled, saveState } from '../autopilotState.js';
import { createBridgeClient, BridgeError } from '../proton/bridgeClient.js';
import { createSmtpClient, SmtpError } from '../proton/smtpClient.js';
import { summarizeInbox } from '../proton/mailbox.js';
import { templateList, unfilledPlaceholders } from '../proton/templates.js';
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
import { generatePost, recomputePost, wouldLoseWork } from '../blog/draft.js';
import { listPosts, readPost, savePost, deletePost, siblingsInCluster } from '../blog/store.js';
import { createAdminClient, ShopifyApiError } from '../shopify/adminClient.js';
import { backfillAttribution } from '../backfillAttribution.js';
import { getMetrics, MetricsError } from '../metricsCache.js';
import { readGenerationMetrics } from '../generationMetrics.js';
import { spendForWindow, writeAdSpend, AdSpendError, SPEND_SOURCES } from '../adSpend.js';
import { ROLLING_DAYS } from '../metrics.js';
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
  setPhotoCrop,
  suggestPhotoCrop,
  ReviewError,
} from '../review.js';
import { migrateDedications, MEMORY_DIR } from '../dedications.js';
import { verifyRolePassword } from '../auth/credentials.js';
import { AccountError, readAccount, readAccounts, updateAccount } from '../auth/accounts.js';
import {
  AVATAR_BODY_LIMIT,
  AVATAR_MIME,
  AVATAR_TOO_LARGE_MESSAGE,
  AvatarError,
  avatarFilePath,
  removeAvatar,
  storeAvatar,
} from '../auth/avatar.js';
import {
  AUTH_MODES,
  AuthConfigError,
  IMPLICIT_OPERATOR,
  LOGIN_PAGE_PATH,
  SIGN_IN_PATH,
  SIGN_OUT_PATH,
  assertLocalModeIsSafe,
  clearedSessionCookie,
  createSessionStore,
  isLoopbackHost,
  isPreGate,
  resolveAuthMode,
  sessionCookie,
  tokenFromRequest,
  wantsSignInPage,
} from '../auth/sessions.js';
import { SignInBusyError, isSameOrigin, sharedSignInThrottle } from '../auth/throttle.js';
import { acquireOrderLock, OrderLockedError } from '../orderLock.js';

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

/** The file this pathname names inside the studio's static tree, or null. The resolved path must
 *  stay inside static/, so a crafted request (../../config.json) resolves outside it and is nothing
 *  — no secret, source, or order data is reachable through here.
 *
 *  Split out from `serveStatic` because the route policy needs the same answer without serving
 *  anything: "is this GET a real asset?" is what keeps the dispatcher's static fallback from
 *  swallowing a newly added route into the printer's allowlist (see ROUTE_POLICY). */
function staticAssetPath(pathname) {
  let candidate;
  try {
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    candidate = resolve(STATIC_DIR, rel);
  } catch {
    return null; // a malformed/percent-encoded path is just not found
  }
  if (candidate !== STATIC_DIR && !candidate.startsWith(STATIC_DIR + sep)) return null;
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return null;
  return candidate;
}

/** The decoded path segments of a request, or null when the path cannot be decoded at all.
 *
 *  TOTAL, like staticAssetPath's decode and for the same reason: `decodeURIComponent('%zz')` throws
 *  a URIError, and the caller of this runs inside an async request listener where a throw is an
 *  unhandled rejection and the process exits. A malformed path must be a 404, not an outage — it
 *  cannot name a route either way. */
export function pathSegments(pathname) {
  const raw = pathname.split('/').filter(Boolean);
  try {
    return raw.map(decodeURIComponent);
  } catch {
    return null;
  }
}

/** Serve a file from the studio's static tree, and only from there. */
function serveStatic(pathname, res) {
  const candidate = staticAssetPath(pathname);
  if (!candidate) return json(res, 404, { error: 'Not found.' });
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
    // `code` so a caller can answer 413 for its own seam instead of the blanket 409 a ReviewError
    // gets: an avatar over the cap is "too big", not "the studio refused your request".
    if (size > limit) throw Object.assign(new ReviewError('Request body too large.'), { code: 'too-large' });
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
      // Straightened, or cut out of a screenshot, before it was drawn — so the grid can say so and
      // offer the undo. Null for the ordinary photo that needed nothing, which is nearly all of them.
      framing: p.framing,
      // The operator's own crop, so the card can say the photo is cropped and offer the way back
      // before any regeneration has finished. Null for the overwhelming majority of photos.
      manualCrop: p.manualCrop,
      hasSource: Boolean(p.files.source),
      // The render's mtime versions its <img> URL, so a completed redo repaints the tile
      // instead of the browser showing the render the operator just rejected.
      coloringVersion: p.files.coloring ? statSync(p.files.coloring).mtimeMs : 0,
      // The ORIGINAL needs the same treatment now that it can change. It could not before: the
      // photo was written once and never touched again, so an unversioned URL was safe. Automatic
      // framing rewrites it — a screenshot is cropped, a sideways photo turned — and without this
      // the browser keeps serving the copy it cached, so the page shows a cropped colouring page
      // beside an uncropped photo and the fix looks like it did not happen.
      originalVersion: p.files.original ? statSync(p.files.original).mtimeMs : 0,
      busy: inFlight.get(`${o.orderId}/${p.base}`) ?? null,
    })),
  }));
}

const thumbs = new Map(); // `${path}:${mtimeMs}:${width}` -> jpeg Buffer

// The crop editor zooms, so it is served a bigger copy than a grid tile. Still a copy: the
// full-resolution original is never sent to the browser, and the crop is stored as fractions, so
// the box the operator drags applies to the full-resolution file all the same.
const CROP_WIDTH = 1600;

async function thumbnail(path, width = THUMB_WIDTH) {
  const key = `${path}:${statSync(path).mtimeMs}:${width}`;
  const hit = thumbs.get(key);
  if (hit) return hit;
  // Decode from bytes, not from the path: handed a path, libvips keeps the file mapped while it
  // decodes, and on Windows the run cannot then overwrite that very file — the grid drawing a
  // tile would fail the photo being regenerated behind it. readFileSync closes before we decode.
  const buf = await sharp(readFileSync(path))
    // Honour EXIF orientation, exactly as the generator's upload prep does (apiDriver.js). A phone
    // stores a portrait photo as landscape pixels plus a "rotate me" flag, and sharp ignores that
    // flag unless asked — so the grid showed the customer's original sideways while the generated
    // page, which DOES rotate, came out upright. A file with no flag (every _bw.png) is unaffected.
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  if (thumbs.size > 300) thumbs.clear();
  thumbs.set(key, buf);
  return buf;
}

const MAX_LOG_LINES = 400;

// A print run is a stack of paper somebody carries to a press. Past this it is not a run, it is the
// archive — and building that archive would hold the box up for minutes.
const MAX_BATCH_ORDERS = 100;

/** `1510_Pro-Jiricka.pdf` — the order number first, because that is what the printer matches against
 *  the board, and the title after it only so a stack of paper can be told apart by eye.
 *
 *  SANITISED HARD. This string becomes a path inside an archive somebody unpacks on their own
 *  desktop: anything that could read as a directory, a drive letter or a shell argument is stripped
 *  rather than escaped, accents are folded rather than dropping the word they sit on, and what is
 *  left is short enough to survive Windows' path limit. An order with no title is just its number. */
export function batchPdfName(order) {
  const title = String(order.dedication ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  // Leading dots go too: a zip entry called "..something" is harmless but reads as a traversal
  // attempt to every archive tool that shows it, and to the person opening it.
  const id = String(order.orderId).replace(/[^\w.-]/g, '_').replace(/^\.+/, '');
  return title ? `${id}_${title}.pdf` : `${id}.pdf`;
}

// Above this many orders in one folder, the operator has opened their archive rather than a
// batch. Ticking them all would generate every order they have ever shipped.
const AUTO_TICK_LIMIT = 8;

// The homepage compares paid against organic over a rolling window, so spend is read over exactly
// the span the revenue was measured over — imported from metrics.js rather than retyped here. A
// return-on-spend figure that divided a 30-day revenue by a 7-day spend would be wrong by a factor
// of four and look entirely reasonable on screen.
const SPEND_WINDOW_DAYS = ROLLING_DAYS;

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

// --- WHO MAY REACH WHAT (R8, KTD10) ------------------------------------------------------------
//
// An ALLOWLIST, and the distinction is the whole point. Written as a deny-list — "the printer may
// not reach settings and shutdown" — the first draft of this left Jirka able to send and delete
// customer mail from the business Proton account, publish articles to the live storefront, and spend
// money on AI image generation, because none of those routes existed when the deny-list was written.
// A route added tomorrow would join them. So the table below names what a printer MAY reach and
// `routeAudience` answers OPERATOR for everything else, including a path that matches no entry at
// all. A new route is refused for the printer until somebody writes down a decision about it.
//
// The table is also the record of that decision, one line per route, and `test/reviewServer.test.js`
// reads BOTH this table and the dispatcher's source and fails when a route exists with no entry
// here. That test is the thing that stops this boundary drifting: it makes "I added a route and
// forgot the policy" a red suite rather than a quiet hole. It finds routes by their idiom —
// `url.pathname === '<literal>'` and `parts[n] === '<segment>'` — so a new route must keep to those
// or declare itself here; `tokens` on each entry is what links a line in this table to the literals
// in the dispatcher.
//
// Enforced on the server, before dispatch. The dashboard hides what a printer cannot use, but that
// is cosmetics: hiding a control does not close a route (KTD10).

export const AUDIENCES = Object.freeze({
  /** No session needed — the gate answers these before an identity exists. */
  ANYONE: 'anyone',
  /** Both people. Everything printing a book needs, and nothing else. */
  BOTH: 'both',
  /** David only: settings, money, customer correspondence, publishing, dispatch, the box itself. */
  OPERATOR: 'operator',
});

/** Match one exact pathname. */
const atPath = (wanted) => (method, pathname) => pathname === wanted;
/** Match /api/<order>/<name> — the three-segment per-order actions. */
const orderAction = (name) => (method, pathname, parts) =>
  parts[0] === 'api' && parts.length === 3 && parts[2] === name;

/** `methods: ANY_METHOD` — this route answers every verb, on purpose. Only /healthz does: a host's
 *  health check may probe with HEAD, and losing the probe is how an instance gets killed. */
export const ANY_METHOD = '*';

/** Does this entry claim that verb? Every other entry names its verbs, and that is load-bearing:
 *  `POST /img/<order>/<base>/rotate` must not inherit the audience of `GET /img/<order>/<base>/<kind>`
 *  just because the path shape matches. A NEW VERB ON AN OLD PATH IS A NEW ROUTE, and it falls
 *  through to the operator-only default until somebody writes a line for it. */
const answersMethod = (entry, method) => entry.methods === ANY_METHOD || entry.methods.includes(method);

/**
 * Route -> who may reach it. Ordered: the FIRST match wins, so an operator-only entry that overlaps
 * a broader printer pattern is listed above it and the overlap resolves closed.
 *
 * Every entry carries four things: `methods` (see above), `match` (the path shape), `tokens` (the
 * literals the dispatcher branches on, which is how the drift test links a line here to a route
 * there) and `sample` — one concrete pathname this line is meant to catch. `sample` is not
 * documentation: the drift test drives every entry's own sample back through this table and fails
 * unless it lands on that entry and on no earlier one, and unless every verb the entry does NOT
 * declare lands somewhere else.
 */
export const ROUTE_POLICY = Object.freeze([
  // -- Before there is an identity at all ---------------------------------------------------------
  // Every verb, deliberately: the dispatcher answers /healthz without asking the method, because a
  // host's health check may probe with HEAD and a probe that 404s kills the instance.
  { id: 'ANY /healthz', audience: AUDIENCES.ANYONE, methods: ANY_METHOD, tokens: ['/healthz'], match: atPath('/healthz'), sample: '/healthz' },
  { id: 'GET /login', audience: AUDIENCES.ANYONE, methods: ['GET'], tokens: [LOGIN_PAGE_PATH], match: atPath(LOGIN_PAGE_PATH), sample: LOGIN_PAGE_PATH },
  { id: 'POST /api/login', audience: AUDIENCES.ANYONE, methods: ['POST'], tokens: [SIGN_IN_PATH], match: atPath(SIGN_IN_PATH), sample: SIGN_IN_PATH },
  { id: 'POST /api/logout', audience: AUDIENCES.ANYONE, methods: ['POST'], tokens: [SIGN_OUT_PATH], match: atPath(SIGN_OUT_PATH), sample: SIGN_OUT_PATH },

  // -- Operator only. Listed first so nothing below can accidentally widen one of them -------------
  // Settings names the folders, the integrations and the retention window (AE5).
  { id: 'GET /api/settings', audience: AUDIENCES.OPERATOR, methods: ['GET'], tokens: ['/api/settings'], match: atPath('/api/settings'), sample: '/api/settings' },
  // Unit economics for the homepage. Operator-only: it is the shop's revenue, and the printer's
  // screen is a work list.
  { id: 'GET /api/metrics', audience: AUDIENCES.OPERATOR, methods: ['GET'], tokens: ['/api/metrics'], match: atPath('/api/metrics'), sample: '/api/metrics' },
  { id: 'GET /api/generation-metrics', audience: AUDIENCES.OPERATOR, methods: ['GET'], tokens: ['/api/generation-metrics'], match: atPath('/api/generation-metrics'), sample: '/api/generation-metrics' },
  // What the shop spent on advertising, and the operator typing a figure in. Same audience as the
  // metrics beside it and for the same reason: this is the shop's money, on a screen the printer
  // opens to print books.
  { id: 'GET|POST /api/spend', audience: AUDIENCES.OPERATOR, methods: ['GET', 'POST'], tokens: ['/api/spend'], match: atPath('/api/spend'), sample: '/api/spend' },
  // The one-shot that fills the Zdroj column in for orders downloaded before it existed. Operator
  // only: it rewrites order sidecars and talks to the shop.
  { id: 'POST /api/backfill-attribution', audience: AUDIENCES.OPERATOR, methods: ['POST'], tokens: ['/api/backfill-attribution'], match: atPath('/api/backfill-attribution'), sample: '/api/backfill-attribution' },
  // The box and the filesystem around it: re-pointing the inbox, the native folder dialog, and the
  // button that stops the server everybody else is using.
  { id: 'POST /api/_scan', audience: AUDIENCES.OPERATOR, methods: ['POST'], tokens: ['/api/_scan'], match: atPath('/api/_scan'), sample: '/api/_scan' },
  { id: 'POST /api/_pick-folder', audience: AUDIENCES.OPERATOR, methods: ['POST'], tokens: ['/api/_pick-folder'], match: atPath('/api/_pick-folder'), sample: '/api/_pick-folder' },
  { id: 'POST /api/_shutdown', audience: AUDIENCES.OPERATOR, methods: ['POST'], tokens: ['/api/_shutdown'], match: atPath('/api/_shutdown'), sample: '/api/_shutdown' },
  // /api/_open/<generator|folder> spawns a desktop process on the SERVER and hands out the
  // token-scoped generator URL. Four segments, so it must sit above the per-photo action pattern.
  {
    id: 'POST /api/_open/*',
    audience: AUDIENCES.OPERATOR,
    methods: ['POST'],
    tokens: ['_open', 'generator', 'folder'],
    match: (method, pathname, parts) => parts[0] === 'api' && parts[1] === '_open',
    sample: '/api/_open/folder/1510',
  },
  // The business mailbox: reading customers' mail, sending as info@, deleting it, flagging it.
  { id: 'GET /api/mail', audience: AUDIENCES.OPERATOR, methods: ['GET'], tokens: ['/api/mail'], match: atPath('/api/mail'), sample: '/api/mail' },
  { id: 'GET /api/mail/message', audience: AUDIENCES.OPERATOR, methods: ['GET'], tokens: ['/api/mail/message'], match: atPath('/api/mail/message'), sample: '/api/mail/message' },
  { id: 'GET /api/mail/templates', audience: AUDIENCES.OPERATOR, methods: ['GET'], tokens: ['/api/mail/templates'], match: atPath('/api/mail/templates'), sample: '/api/mail/templates' },
  { id: 'POST /api/mail/send', audience: AUDIENCES.OPERATOR, methods: ['POST'], tokens: ['/api/mail/send'], match: atPath('/api/mail/send'), sample: '/api/mail/send' },
  { id: 'POST /api/mail/delete', audience: AUDIENCES.OPERATOR, methods: ['POST'], tokens: ['/api/mail/delete'], match: atPath('/api/mail/delete'), sample: '/api/mail/delete' },
  { id: 'POST /api/mail/flag', audience: AUDIENCES.OPERATOR, methods: ['POST'], tokens: ['/api/mail/flag'], match: atPath('/api/mail/flag'), sample: '/api/mail/flag' },
  // Publishing to the live storefront blog, and the AI that writes it.
  { id: 'GET /api/blog/topics', audience: AUDIENCES.OPERATOR, methods: ['GET'], tokens: ['/api/blog/topics'], match: atPath('/api/blog/topics'), sample: '/api/blog/topics' },
  { id: 'POST /api/blog/draft', audience: AUDIENCES.OPERATOR, methods: ['POST'], tokens: ['/api/blog/draft'], match: atPath('/api/blog/draft'), sample: '/api/blog/draft' },
  // The one route in the table that answers three verbs: list, save and remove a draft post.
  { id: 'GET|POST|DELETE /api/blog/posts', audience: AUDIENCES.OPERATOR, methods: ['GET', 'POST', 'DELETE'], tokens: ['/api/blog/posts'], match: atPath('/api/blog/posts'), sample: '/api/blog/posts' },
  { id: 'GET /api/blog/blogs', audience: AUDIENCES.OPERATOR, methods: ['GET'], tokens: ['/api/blog/blogs'], match: atPath('/api/blog/blogs'), sample: '/api/blog/blogs' },
  { id: 'POST /api/blog/publish', audience: AUDIENCES.OPERATOR, methods: ['POST'], tokens: ['/api/blog/publish'], match: atPath('/api/blog/publish'), sample: '/api/blog/publish' },
  // Marketing: the ad calendar, the studio renderer, and the one route that spends money per click.
  { id: 'GET /api/creatives/calendar', audience: AUDIENCES.OPERATOR, methods: ['GET'], tokens: ['/api/creatives/calendar'], match: atPath('/api/creatives/calendar'), sample: '/api/creatives/calendar' },
  {
    id: 'GET /creatives/ad/<key>/<file>',
    audience: AUDIENCES.OPERATOR,
    methods: ['GET'],
    tokens: ['creatives', 'ad'],
    match: (method, pathname, parts) => parts[0] === 'creatives' && parts[1] === 'ad',
    sample: '/creatives/ad/12-24-vanoce/x.png',
  },
  { id: 'POST /api/creative/ai-image', audience: AUDIENCES.OPERATOR, methods: ['POST'], tokens: ['/api/creative/ai-image'], match: atPath('/api/creative/ai-image'), sample: '/api/creative/ai-image' },
  { id: 'GET /api/studio/templates', audience: AUDIENCES.OPERATOR, methods: ['GET'], tokens: ['/api/studio/templates'], match: atPath('/api/studio/templates'), sample: '/api/studio/templates' },
  { id: 'GET /api/studio/validate', audience: AUDIENCES.OPERATOR, methods: ['GET'], tokens: ['/api/studio/validate'], match: atPath('/api/studio/validate'), sample: '/api/studio/validate' },
  { id: 'GET /studio/preview', audience: AUDIENCES.OPERATOR, methods: ['GET'], tokens: ['/studio/preview'], match: atPath('/studio/preview'), sample: '/studio/preview' },
  { id: 'GET /studio/render', audience: AUDIENCES.OPERATOR, methods: ['GET'], tokens: ['/studio/render'], match: atPath('/studio/render'), sample: '/studio/render' },
  // The unattended fetch: it pulls new paid orders from Shopify and generates them, which is spend.
  { id: 'POST /api/autopilot/run', audience: AUDIENCES.OPERATOR, methods: ['POST'], tokens: ['/api/autopilot/run'], match: atPath('/api/autopilot/run'), sample: '/api/autopilot/run' },
  { id: 'GET /api/autopilot/status', audience: AUDIENCES.OPERATOR, methods: ['GET'], tokens: ['/api/autopilot/status'], match: atPath('/api/autopilot/status'), sample: '/api/autopilot/status' },
  // Order actions that are the operator's act, not the printer's: dispatch to the customer and
  // undoing it, writing to the customer, and taking an order off the board for good.
  { id: 'POST /api/<order>/sent', audience: AUDIENCES.OPERATOR, methods: ['POST'], tokens: ['sent'], match: orderAction('sent'), sample: '/api/1510/sent' },
  { id: 'POST /api/<order>/unsent', audience: AUDIENCES.OPERATOR, methods: ['POST'], tokens: ['unsent'], match: orderAction('unsent'), sample: '/api/1510/unsent' },
  { id: 'POST /api/<order>/emailed', audience: AUDIENCES.OPERATOR, methods: ['POST'], tokens: ['emailed'], match: orderAction('emailed'), sample: '/api/1510/emailed' },
  // The one-shot marker migration (U10). It writes into live customer order folders, so it belongs
  // to the person who owns the disk — and it must be decided here rather than fall through to the
  // table's operator-by-default, which would be refused-by-accident rather than a decision.
  {
    id: 'POST /api/migrate/sent-markers',
    audience: AUDIENCES.OPERATOR,
    methods: ['POST'],
    tokens: ['/api/migrate/sent-markers'],
    match: atPath('/api/migrate/sent-markers'),
    sample: '/api/migrate/sent-markers',
  },
  { id: 'POST /api/<order>/delete', audience: AUDIENCES.OPERATOR, methods: ['POST'], tokens: ['delete'], match: orderAction('delete'), sample: '/api/1510/delete' },
  // The retention purge (U11, R19). Both halves are the operator's: the report because it enumerates
  // what is on the disk, and the confirmation because it deletes photographs of customers' children
  // and nothing gets them back. Jirka prints books; this is not printing a book.
  { id: 'GET /api/purge/report', audience: AUDIENCES.OPERATOR, methods: ['GET'], tokens: ['/api/purge/report'], match: atPath('/api/purge/report'), sample: '/api/purge/report' },
  { id: 'POST /api/purge/confirm', audience: AUDIENCES.OPERATOR, methods: ['POST'], tokens: ['/api/purge/confirm'], match: atPath('/api/purge/confirm'), sample: '/api/purge/confirm' },

  // -- Both people: printing a book, end to end ---------------------------------------------------
  { id: 'GET /', audience: AUDIENCES.BOTH, methods: ['GET'], tokens: ['/'], match: atPath('/'), sample: '/' },
  { id: 'GET /review', audience: AUDIENCES.BOTH, methods: ['GET'], tokens: ['/review'], match: atPath('/review'), sample: '/review' },
  { id: 'GET /api/state', audience: AUDIENCES.BOTH, methods: ['GET'], tokens: ['/api/state'], match: atPath('/api/state'), sample: '/api/state' },
  { id: 'GET /api/studio', audience: AUDIENCES.BOTH, methods: ['GET'], tokens: ['/api/studio'], match: atPath('/api/studio'), sample: '/api/studio' },
  // Each person's OWN profile — the route reads the role off the session and ignores any role in the
  // body, so "both" here can never mean "either one's".
  { id: 'POST /api/profile', audience: AUDIENCES.BOTH, methods: ['POST'], tokens: ['/api/profile'], match: atPath('/api/profile'), sample: '/api/profile' },
  {
    id: 'GET /api/avatar/<file>',
    audience: AUDIENCES.BOTH,
    methods: ['GET'],
    tokens: ['avatar'],
    match: (method, pathname, parts) => parts[0] === 'api' && parts[1] === 'avatar',
    sample: '/api/avatar/operator-0123456789abcdef.webp',
  },
  // An order's photographs and its two downloads: the book itself and the archive Jirka prints from.
  // `source` is the customer's own upload rather than the generator's echo — the frame the crop
  // editor measures in. Same audience as the other two: it is the same photograph, and whoever may
  // look at an order's pictures may look at the one it was made from.
  {
    id: 'GET /img/<order>/<base>/<kind>',
    audience: AUDIENCES.BOTH,
    methods: ['GET'],
    tokens: ['img', 'coloring', 'source'],
    match: (method, pathname, parts) => parts[0] === 'img',
    sample: '/img/1510/clean/coloring',
  },
  { id: 'GET /svg/<order>/<base>', audience: AUDIENCES.BOTH, methods: ['GET'], tokens: ['svg'], match: (method, pathname, parts) => parts[0] === 'svg', sample: '/svg/1510/clean' },
  { id: 'GET /api/<order>/pdf', audience: AUDIENCES.BOTH, methods: ['GET'], tokens: ['pdf'], match: orderAction('pdf'), sample: '/api/1510/pdf' },
  { id: 'GET /api/<order>/zip', audience: AUDIENCES.BOTH, methods: ['GET'], tokens: ['zip'], match: orderAction('zip'), sample: '/api/1510/zip' },
  // A whole print run in one download. Same audience as the single PDF beside it — this exists FOR
  // the printer, and it only ever contains books that are already on disk.
  { id: 'GET /api/print-batch', audience: AUDIENCES.BOTH, methods: ['GET'], tokens: ['/api/print-batch'], match: atPath('/api/print-batch'), sample: '/api/print-batch' },
  // Generation. Jirka runs it: with WhatsApp gone he fetches the book himself, and a book that never
  // generated is a book he cannot fetch.
  { id: 'POST /api/_run', audience: AUDIENCES.BOTH, methods: ['POST'], tokens: ['/api/_run'], match: atPath('/api/_run'), sample: '/api/_run' },
  { id: 'POST /api/_stop', audience: AUDIENCES.BOTH, methods: ['POST'], tokens: ['/api/_stop'], match: atPath('/api/_stop'), sample: '/api/_stop' },
  { id: 'POST /api/_select', audience: AUDIENCES.BOTH, methods: ['POST'], tokens: ['/api/_select'], match: atPath('/api/_select'), sample: '/api/_select' },
  // The book's title page, and clearing an intake hold so a flagged order can be generated anyway.
  { id: 'POST /api/<order>/dedication', audience: AUDIENCES.BOTH, methods: ['POST'], tokens: ['dedication'], match: orderAction('dedication'), sample: '/api/1510/dedication' },
  { id: 'POST /api/<order>/intake-override', audience: AUDIENCES.BOTH, methods: ['POST'], tokens: ['intake-override'], match: orderAction('intake-override'), sample: '/api/1510/intake-override' },
  // Printing, and undoing a mis-click on it (R10).
  { id: 'POST /api/<order>/printed', audience: AUDIENCES.BOTH, methods: ['POST'], tokens: ['printed'], match: orderAction('printed'), sample: '/api/1510/printed' },
  { id: 'POST /api/<order>/unprinted', audience: AUDIENCES.BOTH, methods: ['POST'], tokens: ['unprinted'], match: orderAction('unprinted'), sample: '/api/1510/unprinted' },
  // The per-photo review verdicts. Four segments, so every four-segment operator route above must
  // stay above this line.
  {
    id: 'POST /api/<order>/<base>/<action>',
    audience: AUDIENCES.BOTH,
    methods: ['POST'],
    tokens: ['approve', 'reject', 'handoff', 'replaced', 'redo', 'unframe', 'edit', 'revert', 'crop'],
    match: (method, pathname, parts) => parts[0] === 'api' && parts.length === 4,
    sample: '/api/1510/clean/approve',
  },
  // The dashboard's own CSS, JS, fonts and graphics — the dispatcher's static fallback. Deliberately
  // matched by "a file of that name really exists under static/" rather than by "it is a GET":
  // a bare catch-all here would swallow the next GET route somebody adds into the printer's
  // allowlist by accident — the exact drift this table exists to stop.
  // Nothing under static/ is secret; everything that is lives behind a route above.
  {
    id: 'GET <static asset>',
    audience: AUDIENCES.BOTH,
    methods: ['GET'],
    tokens: [],
    match: (method, pathname) => staticAssetPath(pathname) !== null,
    sample: '/dashboard.html',
  },
]);

/**
 * Who may reach this request? OPERATOR when nothing matches — that default IS the allowlist, and it
 * is why an unrecorded route is refused rather than open.
 */
export function routeAudience(method, pathname, parts = pathname.split('/').filter(Boolean)) {
  return routePolicyFor(method, pathname, parts)?.audience ?? AUDIENCES.OPERATOR;
}

/** The single table line that answers this request, or null when none does (→ operator-only). The
 *  method is part of the question: an entry only answers the verbs it declares, so a new verb on an
 *  existing path is undecided rather than inherited. Exported for the drift test, which drives every
 *  entry's own `sample` back through here. */
export function routePolicyFor(method, pathname, parts = pathname.split('/').filter(Boolean)) {
  return ROUTE_POLICY.find((r) => answersMethod(r, method) && r.match(method, pathname, parts)) ?? null;
}

/** May this role reach that audience? The operator reaches everything; the printer reaches what the
 *  table named for both of them, and nothing it did not. */
export function mayReach(role, audience) {
  if (audience === AUDIENCES.ANYONE || audience === AUDIENCES.BOTH) return true;
  return role === 'operator';
}

/** A purge result as the PAGE is allowed to see it (U11).
 *
 *  Counts and reasons, never a path. `inspectOutbox` carries absolute filesystem paths — the order
 *  folder and every photograph inside it — because the deletion needs them; the browser needs none
 *  of that and the board already refuses to hand out paths for the same reason (see boardEntry).
 *  `backfilled` and `stalledDays` DO cross, because they are the two things the operator has to be
 *  able to see: whether a large batch is historical, and which orders will never age out at all. */
export function purgeReportForClient(result, autopilot = null) {
  const row = (o) => ({
    orderId: o.orderId,
    photos: o.photos.length,
    bytes: o.bytes,
    ageDays: o.ageDays,
    backfilled: o.backfilled,
    stalledDays: o.stalledDays,
    skip: o.skip,
  });
  return {
    dryRun: result.dryRun,
    days: result.days,
    cap: result.cap,
    photos: result.photos,
    bytes: result.bytes,
    eligibility: result.eligibility,
    orders: result.orders.map(row),
    deferred: result.deferred.map(row),
    stalled: result.stalled.map(row),
    skipped: result.skipped.filter((o) => o.stalledDays == null).map(row),
    // The overnight report and handled-set, which age out on the same clock and are cleared by the
    // same confirmation. Names only, no paths — and present on BOTH routes: the report is supposed
    // to be exactly what confirming does, and a confirmation that also deleted two files the report
    // never mentioned would make that a lie (see the routes).
    autopilotFiles: (autopilot?.removed ?? []).map((f) => f.name),
    warning: purgeWarning,
  };
}

/** `revealFinished` opens the finished book's folder on the desktop. It defaults to off: a test
 *  or a smoke that constructs a server must never spawn a File Explorer window — and one that
 *  did, pointed at a temp folder the test then deleted, is how this default was chosen. Only the
 *  double-click launcher, where a real operator is watching, turns it on. */
export function createReviewServer({ config, inboxRoot, outboxRoot, driver, builder, qc, intake, revealFinished = false, reveal = openExternally, log = () => {}, memoryRoot = MEMORY_DIR, mailClient, smtpClient, adImageFn, authEnv = process.env, bindHost = authEnv.HOST, sessions = createSessionStore(), signInThrottle = sharedSignInThrottle() } = {}) {
  let inbox = inboxRoot ?? config.paths.inbox; // the Go bar can point the tool at another folder
  const outbox = outboxRoot ?? config.paths.outbox;

  // --- Sign-in, decided ONCE, here, from the environment this server was built with ---------------
  //
  // Snapshotted rather than re-read per request: the mode is a property of the deployment, and
  // re-reading process.env on every request would let a later mutation silently open a server that
  // started closed. It also keeps two servers in one process (the test suite) independent.
  //
  // `assertLocalModeIsSafe` is the guard that makes the ungated path survivable. It throws — before
  // a socket exists — when no password hashes are configured AND the server would bind an address
  // beyond this machine. The Dockerfile sets HOST=0.0.0.0, so a Render deploy that forgot the
  // hashes stops here instead of publishing the studio.
  assertLocalModeIsSafe({ env: authEnv, bindHost });
  // And the same shape for storage: on a hosted bind, a data directory outside the mounted disk is
  // scratch space that the next deploy erases without a word. Both guards run before a socket
  // exists, so a deployment that gets either wrong fails loudly at start instead of quietly later.
  assertPersistentDataDirs({ config, env: authEnv, bindHost });
  const auth = resolveAuthMode(authEnv);
  const accountsDir = config?.accounts?.dataDir ?? null;
  if (auth.mode === AUTH_MODES.MISCONFIGURED) log(auth.message);
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

  const lockOrder = (orderId) => acquireOrderLock({ inboxRoot: inbox, orderId, operation: 'Studio review mutation' });
  async function withOrderLock(orderId, mutation) {
    const release = lockOrder(orderId);
    try { return await mutation(); }
    finally { release(); }
  }
  async function withOrderLocks(orderIds, mutation) {
    const releases = [];
    try {
      for (const orderId of [...new Set(orderIds)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) releases.push(lockOrder(orderId));
      return await mutation();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

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

  async function startRedo(orderId, base, overrides = null, rejection = null, prepare = null) {
    requireIdle();
    const releaseLock = lockOrder(orderId);
    const key = `${orderId}/${base}`;
    try {
      if (inFlight.has(key)) throw new ReviewError(`"${base}" is already being regenerated.`);
      const found = find(orderId, base);
      const { order } = found;
      generator ??= createGeneratorDriver(config);
      const prepared = prepare?.(found);
      if (prepared?.skipRedo) {
        releaseLock();
        return prepared.value;
      }
      inFlight.set(key, { message: 'starting…' });

    // Deliberately not awaited: the operator keeps reviewing while the GPU works. The tile
    // polls /api/state for progress, and state.json is the durable record either way.
      redo({
      config,
      orderDir: order.orderDir,
      base,
      driver: generator,
      qc,
      overrides,
      rejection,
      onEvent: (e) => {
        if (e.type === 'progress') inFlight.set(key, { message: `${e.step}: ${e.message}` });
      },
      })
      .catch((err) => {
        // redo() only throws for "cannot redo at all"; generation failures land in state.json.
        console.error(`redo ${key}: ${err.message}`);
      })
        .finally(() => { inFlight.delete(key); releaseLock(); });
      return prepared;
    } catch (err) {
      releaseLock();
      throw err;
    }
  }

  /** The role that answers to a typed username, or null. Usernames live in the account file and can
   *  be renamed at runtime; the password hash is keyed by ROLE, so a rename can never lock anybody
   *  out (KTD1). Compared the same case-insensitive way accounts.js refuses a colliding name. */
  function roleForUsername(username) {
    const wanted = String(username ?? '').trim().toLocaleLowerCase('cs');
    if (!wanted) return null;
    const match = readAccounts(accountsDir).find((a) => a.username.toLocaleLowerCase('cs') === wanted);
    return match ? match.role : null;
  }

  /**
   * The signed-in person as the PAGE is allowed to see them (R8 step 3, R11).
   *
   * Three fields and a flag, assembled here rather than spread across the endpoints that return it,
   * so there is exactly one place to check what crosses to the browser. What is deliberately absent
   * is the point: no session token, no password hash, no environment variable name, nothing that
   * helps anybody become this person. The role is included because the UI reflects it; it is not
   * what enforces it (the check above is).
   */
  function identityFor(req) {
    if (!req.identity) return null;
    const account = readAccount(accountsDir, req.identity.role); // defaults when no account file exists yet
    return {
      role: req.identity.role,
      username: account.username,
      // A URL, never the file name on disk: the page has no business knowing how the accounts dir
      // is laid out, and the route is the only way into it anyway.
      avatar: account.avatar ? `/api/avatar/${account.avatar}` : null,
      // KTD11: ungated local mode resolves ONE implicit operator. The page hides the profile surface
      // on this flag — there is no second identity to tell apart and nothing to sign out of.
      implicit: req.identity.implicit === true,
    };
  }

  /**
   * POST /api/login — verify a password and mint a session.
   *
   * Three things are load-bearing and none of them are obvious from the happy path:
   *
   *   - EVERY answer is the same. Unknown username, wrong password and a role whose hash is missing
   *     all return the identical 401 after the identical scrypt work (credentials.js derives against
   *     a dummy hash rather than returning early), so the response cannot be used to enumerate who
   *     has an account here.
   *   - The token is minted fresh by the session store and never adopted from the request. There is
   *     no code path that turns a client-supplied cookie into a live session, which is session
   *     fixation closed by construction.
   *   - The attempt is logged — outcome, attempted username, timestamp — and NOTHING else. The
   *     password, the stored hash and the new token never reach the log line.
   */
  async function handleSignIn(req, res) {
    const body = await readJson(req, 8 * 1024);
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const at = new Date().toISOString();
    /** Never interpolate anything but the typed username here. */
    const attempt = (outcome, detail = '') => log(`sign-in ${outcome} for ${JSON.stringify(username)} at ${at}${detail ? ` — ${detail}` : ''}`);

    if (auth.mode !== AUTH_MODES.GATED) {
      attempt('unavailable', 'no passwords are configured; this studio runs ungated');
      return json(res, 409, { error: 'Přihlášení není v místním režimu potřeba.', code: 'ungated' });
    }
    if (!username || !password) {
      attempt('rejected', 'missing username or password');
      return json(res, 400, { error: 'Vyplňte jméno i heslo.' });
    }

    const role = roleForUsername(username);
    let ok;
    try {
      // The throttle owns the pacing AND the global cap on concurrent derivations; the callback is
      // the only thing inside it that sees a password. An unknown username still runs a full
      // derivation (verifyRolePassword against no hash) so it costs what a real one costs.
      ok = await signInThrottle.run(username, () => verifyRolePassword(role ?? '__unknown__', password, { env: authEnv }));
    } catch (err) {
      if (err instanceof SignInBusyError) {
        attempt('deferred', 'too many verifications in flight');
        res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': String(err.retryAfterSeconds) });
        return res.end(JSON.stringify({ error: err.message, code: 'busy' }));
      }
      throw err;
    }

    if (!ok) {
      attempt('failed');
      return json(res, 401, { error: 'Jméno nebo heslo nesouhlasí.' });
    }

    const token = sessions.create(role);
    attempt('ok', `role ${role}`);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': sessionCookie(token),
    });
    return res.end(JSON.stringify({ ok: true, role }));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = pathSegments(url.pathname);
    // A path this server cannot even decode is a 404, decided here, before anything else runs.
    //
    // `decodeURIComponent` THROWS on a malformed escape ("/%zz"), and it used to be called on this
    // line outside the try/catch below — in an async listener, where an unhandled rejection takes the
    // whole process down. One unauthenticated GET, no session, no route: the studio stops. Total
    // decoding (see pathSegments) turns that into the only honest answer — a path that is not valid
    // UTF-8 percent-encoding names no route, no order and no asset — and it mirrors what
    // staticAssetPath has always done with its own decode.
    if (parts === null) return json(res, 404, { error: 'Not found.' });

    // Unauthenticated liveness probe for a cloud host's health check — must answer before the gate.
    // Reports the deployed commit so "is my fix actually live?" is answerable from outside, without
    // the Render dashboard. Without it, polling /healthz cannot tell a new build from the old one —
    // Render keeps the previous instance serving until the new one is healthy, so {ok:true} means
    // "something is up", never "your push is live". RENDER_GIT_COMMIT is injected by Render; null
    // locally. It is the commit only, no repo/branch/env — nothing worth gating behind auth, and this
    // route must stay unauthenticated or the host's health check kills the instance.
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, commit: process.env.RENDER_GIT_COMMIT ?? null });
    // Same-origin check on anything that can change something (KTD4). Ahead of the gate because the
    // sign-in POST is itself mutating and itself pre-gate; a GET is never affected.
    if (!isSameOrigin(req)) {
      return json(res, 403, { error: 'Požadavek přišel z jiné stránky a byl odmítnut.' });
    }

    // --- THE REQUEST GATE (KTD9) -----------------------------------------------------------------
    //
    // Exactly where checkAuth stood: after the /healthz early return, once per request. Deliberately
    // REQUEST-scoped and not stream-scoped — /api/<order>/zip streams for minutes after its headers
    // are sent, and a session expiring mid-download must not truncate the operator's archive. There
    // are no per-chunk checks anywhere downstream, and there must not be.
    //
    // The identity it resolves hangs off the request for handlers to read (role enforcement is U6).
    if (auth.mode === AUTH_MODES.MISCONFIGURED) {
      // Half-configured: one role has a hash, the other's env var is missing or misspelled. This is
      // the case the old boolean would have collapsed into "not configured" and served the whole
      // studio for. It refuses everything but /healthz instead, and says what is missing. Logged
      // once at construction, not here — a refusal per request would bury the reason in noise.
      return json(res, 503, { error: auth.message, code: 'auth-misconfigured' });
    }
    if (auth.mode === AUTH_MODES.UNGATED) {
      // No role has a password at all: the desktop workflow. Safe only because the constructor
      // already refused to build this server on a non-loopback bind (assertLocalModeIsSafe).
      req.identity = IMPLICIT_OPERATOR; // KTD11 — role checks need a defined answer
    } else {
      const session = sessions.get(tokenFromRequest(req));
      if (session) {
        req.identity = { role: session.role, implicit: false };
      } else if (!isPreGate(req.method, url.pathname)) {
        // Anonymous. A page request gets the sign-in form; an API call is refused where it stands
        // rather than redirected, so fetch() reports "signed out" instead of choking on HTML.
        if (wantsSignInPage(req.method, url.pathname)) return serveStatic('/login.html', res);
        return json(res, 401, { error: 'Přihlaste se prosím.', code: 'signed-out' });
      }
    }

    // --- THE ROLE CHECK (R8, KTD10) ---------------------------------------------------------------
    //
    // One table-driven check, ahead of every handler, so no route can be reached by a role the table
    // did not name — including a route whose own handler forgot to ask. `req.identity` is undefined
    // only on the pre-gate paths (the sign-in POST, the two branded assets), which the table records
    // as reachable by anyone; in ungated local mode it is the implicit operator (KTD11), so the
    // answer here is defined in every mode rather than "no identity, therefore no check".
    //
    // The refusal is logged with the route and the role and nothing else — a refused printer is
    // either a stale tab or somebody typing URLs, and the operator should be able to tell which.
    if (req.identity && !mayReach(req.identity.role, routeAudience(req.method, url.pathname, parts))) {
      log(`refused ${req.method} ${url.pathname} for role ${req.identity.role}`);
      return json(res, 403, { error: 'Tahle část studia je jen pro operátora.', code: 'forbidden' });
    }

    try {
      // --- Sign in / sign out ---------------------------------------------------------------------
      // The only endpoint in the app that touches a password, and the only one that mints a session.
      if (req.method === 'POST' && url.pathname === SIGN_IN_PATH) {
        return await handleSignIn(req, res);
      }
      // Sign-out is NOT pre-gate: destroying a session requires holding one. It deletes the SERVER
      // entry — clearing the cookie alone would leave a copied token live (KTD3).
      if (req.method === 'POST' && url.pathname === SIGN_OUT_PATH) {
        sessions.destroy(tokenFromRequest(req));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': clearedSessionCookie() });
        return res.end(JSON.stringify({ ok: true }));
      }
      // The sign-in page for someone who already has a session: send them to the studio rather than
      // showing a form they do not need.
      // In ungated local mode this is every visit to /login, and it is why that mode has no sign-in
      // page at all (KTD11): there is nothing to sign in to and nobody to distinguish.
      if (req.method === 'GET' && url.pathname === LOGIN_PAGE_PATH) {
        if (req.identity) {
          res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
          return res.end();
        }
        return serveStatic('/login.html', res);
      }

      // POST /api/profile { username?, image? } — a person changes their OWN display name or photo
      // (R11, R13). The role comes off the SESSION and a `role` in the body is never read, so "may I
      // change this account?" is not a check that can be forgotten — there is no code path here that
      // writes to the other person's record. The username goes through accounts.js's mutator, so the
      // collision rule (two people who cannot be told apart) applies to this route for free.
      //
      // `image` is base64 in the JSON body (KTD8), read under AVATAR_BODY_LIMIT — the cap is applied
      // BY THE READER, so an oversized upload is refused mid-stream rather than after it has already
      // been buffered. `image: null` clears the photo.
      if (req.method === 'POST' && url.pathname === '/api/profile') {
        // Ungated local mode has one implicit identity and no sign-in (KTD11). Renaming an account
        // nobody signs in as would change a label with no way back through the UI, so it is refused
        // here and the surface is hidden in the page.
        if (!req.identity || req.identity.implicit) {
          return json(res, 409, { error: 'V místním režimu se profil nenastavuje — nikdo se nepřihlašuje.', code: 'ungated' });
        }
        if (!accountsDir) return json(res, 503, { error: 'Účty nejsou nastavené (accounts.dataDir).', code: 'not-configured' });

        const role = req.identity.role;
        // The size refusal is the READER's (it stops mid-stream, before the memory is spent), so it
        // is the reader's error that has to become the 413 the page expects — it used to fall through
        // to the blanket ReviewError 409 and told the operator nothing about what was wrong.
        let body;
        try {
          body = await readJson(req, AVATAR_BODY_LIMIT);
        } catch (err) {
          if (err?.code === 'too-large') return json(res, 413, { error: AVATAR_TOO_LARGE_MESSAGE, code: 'too-large' });
          throw err;
        }
        const before = readAccount(accountsDir, role);
        const patch = {};
        if (typeof body?.username === 'string') patch.username = body.username;

        let written = null; // the file this request created, for the rollback below
        try {
          if (typeof body?.image === 'string' && body.image.trim()) {
            // Stored BEFORE the account is updated, and the previous file is kept until the update
            // lands: a colliding username must not leave the record pointing at a deleted photo.
            written = await storeAvatar({ dataDir: accountsDir, role, payload: body.image });
            patch.avatar = written.file;
          } else if (body?.image === null) {
            patch.avatar = null;
          }
          if (!('username' in patch) && !('avatar' in patch)) return json(res, 400, { error: 'Není co změnit.' });
          updateAccount(accountsDir, role, patch);
        } catch (err) {
          if (written) removeAvatar(accountsDir, written.file); // roll back the orphan
          if (err instanceof AvatarError) {
            return json(res, err.code === 'not-configured' ? 503 : err.code === 'too-large' ? 413 : 400, { error: err.message, code: err.code });
          }
          if (err instanceof AccountError) return json(res, 409, { error: err.message, code: 'account' });
          throw err;
        }
        // The record now points at the new file (or at nothing), so the old one is safe to drop.
        if ('avatar' in patch && before.avatar && before.avatar !== patch.avatar) removeAvatar(accountsDir, before.avatar);
        return json(res, 200, { identity: identityFor(req) });
      }

      // GET /api/avatar/<file> — a stored profile photo, from the accounts data dir and nowhere else.
      // The name is matched against the shape THIS SERVER generates (avatarFilePath), so a path from
      // the URL cannot reach the filesystem; the Content-Type is the one the re-encode chose, never
      // one the upload claimed; and nosniff stops a browser deciding it knows better.
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'avatar' && parts.length === 3) {
        const path = avatarFilePath(accountsDir, parts[2]);
        if (!path || !existsSync(path)) return json(res, 404, { error: 'Not found.' });
        res.writeHead(200, {
          'Content-Type': AVATAR_MIME,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        });
        return res.end(readFileSync(path));
      }

      // Home is the studio dashboard; the review grid moved to /review. Both are served from the
      // static tree through the same contained path.
      if (req.method === 'GET' && url.pathname === '/') {
        return serveStatic('/dashboard.html', res);
      }
      if (req.method === 'GET' && url.pathname === '/review') {
        return serveStatic('/index.html', res);
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        // `identity` rides along on the state read the review grid already makes, so the page never
        // needs a second round trip to know who is signed in (R8 step 3). Credential material never
        // appears in it — see identityFor.
        return json(res, 200, { orders: forClient(state(), inFlight), inbox, outbox, run, selected, queue, identity: identityFor(req) });
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
        // The dashboard polls this one, so the identity travels here too: the page decides which
        // views to build from it, and it must not paint an operator's nav for a printer for the
        // 2.5 seconds before a second request answers.
        const identity = identityFor(req);
        // Where an order came from is marketing data, and this is the one route both roles reach.
        // The homepage hides the column with `data-operator hidden`, but hiding it in markup is not
        // withholding it — the campaign names were in the printer's response body regardless. Strip
        // them here, where the role is known, so the wire matches the screen.
        const orders = identity?.role === 'operator' ? board.orders : board.orders.map(({ attribution, ...rest }) => rest);
        return json(res, 200, { ...board, orders, inbox, identity, run: { active: run.active, orderId: run.orderId }, autopilot: { running: autopilot.running, error: autopilot.error, report: autopilot.report } });
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

      // GET /api/settings — the Nastavení screen's read-only status (N14). Reports what is wired and
      // where, never a secret value: tokens, passwords and the token-scoped generator URL are surfaced
      // only as configured-or-not (+ safe host/user), never rendered. Changing the input folder is a
      // separate POST /api/_scan, so this handler stays a pure read.
      if (req.method === 'GET' && url.pathname === '/api/settings') {
        const hostOf = (u) => { try { return new URL(u).host; } catch { return null; } };
        const report = readReport(config.shopify?.dataDir ?? null);
        return json(res, 200, {
          folders: { inbox, outbox },
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

      // GET /api/metrics — unit economics for the homepage (AOV, tier mix, trend). The aggregate is
      // cached on disk for an hour: every miss is 90 days of orders over the Admin API, and this is
      // polled by a tab somebody leaves open all day. Nothing customer-shaped is written — see
      // metricsCache.js, which reduces the aggregate through an allowlist before it reaches the disk.
      //
      // `?refresh=1` forces a pull past a fresh cache, for the operator who just changed a price.
      // GET /api/spend — what the shop spent on advertising over the same rolling window the
      // metrics use, or null when nobody has said. Null is the honest answer and the page renders
      // it as "we don't know" rather than as zero, which would read as "the ads were free".
      if (req.method === 'GET' && url.pathname === '/api/spend') {
        const dataDir = config.shopify?.dataDir ?? null;
        const to = new Date();
        const from = new Date(to.getTime() - SPEND_WINDOW_DAYS * 86_400_000);
        // One response shape whether or not a data dir is configured — a body whose keys depend on
        // which branch ran makes the page's own null-handling the only thing standing between a
        // fresh install and a `window.days` of undefined.
        const window = { from: from.toISOString(), to: to.toISOString(), days: SPEND_WINDOW_DAYS };
        if (!dataDir) return json(res, 200, { spend: null, configured: false, window });
        return json(res, 200, {
          spend: spendForWindow(dataDir, { from: window.from, to: window.to }),
          configured: true,
          window,
        });
      }

      // POST /api/spend { amount, from, to, currency? } — the operator types a figure in. Always
      // stored as `typed`, whatever the body claims: a request cannot promote itself to a fetched
      // record and quietly lose to a later hand-entered correction.
      if (req.method === 'POST' && url.pathname === '/api/spend') {
        const dataDir = config.shopify?.dataDir ?? null;
        if (!dataDir) return json(res, 409, { error: 'Není nastavená složka pro data (shopify.dataDir).', code: 'not-configured' });
        const body = await readJson(req, 4 * 1024);
        try {
          const saved = writeAdSpend(dataDir, { ...body, source: SPEND_SOURCES.TYPED });
          return json(res, 200, { saved });
        } catch (err) {
          if (err instanceof AdSpendError) return json(res, 400, { error: err.message, code: err.code });
          throw err;
        }
      }

      // POST /api/backfill-attribution { write? } — fill the Zdroj column in for the back catalogue.
      //
      // This exists because the CLI cannot reach the machine that matters: the studio runs on Render,
      // where there is no shell. Without it the column reads "bez zdroje" for every order downloaded
      // before attribution was recorded, until the whole back catalogue ages out.
      //
      // Dry by default — `write: true` is what actually patches — and idempotent either way, so the
      // worst a stray double-click costs is a second pass reporting nothing to do.
      if (req.method === 'POST' && url.pathname === '/api/backfill-attribution') {
        const shop = config.shopify ?? null;
        if (!shop?.enabled || !shop?.accessToken) {
          return json(res, 409, { error: 'Shopify není propojené — není se čeho ptát.', code: 'not-configured' });
        }
        const { write } = await readJson(req, 1024);
        try {
          const counts = await backfillAttribution({
            config,
            client: createAdminClient({ storeDomain: shop.storeDomain, accessToken: shop.accessToken, apiVersion: shop.apiVersion }),
            write: write === true,
          });
          // The per-folder lines carry order numbers and campaign names; the page only needs the
          // counts, so the detail stays in the run rather than crossing to a browser.
          const { lines, ...summary } = counts;
          return json(res, 200, { ...summary, write: write === true });
        } catch (err) {
          if (err instanceof ShopifyApiError) return json(res, 503, { error: err.message, code: 'shopify' });
          throw err;
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/metrics') {
        const shop = config.shopify ?? null;
        const listOrders = shop?.enabled && shop?.accessToken
          ? (args) => createAdminClient({ storeDomain: shop.storeDomain, accessToken: shop.accessToken, apiVersion: shop.apiVersion }).listOrders(args)
          : null;
        try {
          const out = await getMetrics({ config, listOrders, force: url.searchParams.get('refresh') === '1' });
          return json(res, 200, out);
        } catch (err) {
          if (err instanceof MetricsError) return json(res, 503, { error: err.message, code: err.code });
          throw err;
        }
      }

      // Production telemetry is rebuilt directly from privacy-safe attempt histories in the
      // outbox. It never needs Shopify and never returns order IDs, filenames, or generator inputs.
      if (req.method === 'GET' && url.pathname === '/api/generation-metrics') {
        return json(res, 200, { windows: readGenerationMetrics(outbox) });
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

      // GET /api/blog/topics — the ranked topic list: curated keyword map, then calendar occasions,
      // then AI-invented keywords only if blog.aiTopics is explicitly on (default off).
      if (req.method === 'GET' && url.pathname === '/api/blog/topics') {
        if (!config.blog?.enabled) return json(res, 200, { enabled: false, aiEnabled: Boolean(config.ai?.enabled), topics: [] });
        const { topics, aiUsed } = await suggestTopics({ generateTextFn: blogTextFn, config: config.ai, useSeo: config.blog.aiTopics === true });
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
          // Real internal links: the articles already on the storefront in this topic's cluster.
          siblings: siblingsInCluster(blogDir, topic.cluster),
          wordCountMin: config.blog.wordCountMin,
          wordCountMax: config.blog.wordCountMax,
        });
        // A model failure degrades to the seed skeleton, which is right for a first draft and wrong
        // on top of one that already exists — a transient 503 would replace 500 words with 30.
        const previous = readPost(blogDir, post.id);
        if (wouldLoseWork(post, previous)) {
          return json(res, 502, { error: 'AI se nepovedla — původní koncept zůstal beze změny. Zkuste to prosím znovu.', code: 'ai-failed', post: previous });
        }
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
          // The blog's handle is half of the storefront path (/blogs/<blog>/<article>) that later
          // articles link to. Best-effort: a lookup failure must not fail a successful publish — a
          // post without it simply never gets offered as an internal link.
          const blogHandle = await client
            .listBlogs()
            .then((blogs) => blogs.find((b) => b.id === target)?.handle ?? null)
            .catch(() => null);
          const updated = savePost(blogDir, { ...post, status: 'odeslano', shopifyArticleId: article.id, shopifyHandle: article.handle, publishedBlogId: target, publishedBlogHandle: blogHandle });
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

      // GET /api/print-batch?orders=1510,1523 — one download for a whole print run.
      //
      // WHAT IT IS NOT: a status change. Downloading a batch is fetching paper, not printing it —
      // the press jams, the toner runs out, half the run goes home unprinted. Marking these books
      // printed here would put a lie on the board that only the person at the press could see, so
      // "Označit vytištěno" stays the separate, explicit act it already was.
      if (req.method === 'GET' && url.pathname === '/api/print-batch') {
        const asked = String(url.searchParams.get('orders') ?? '')
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
          .slice(0, MAX_BATCH_ORDERS);
        if (!asked.length) return json(res, 400, { error: 'Nevybrali jste žádnou objednávku.' });
        const board = state();
        const picked = [];
        for (const id of asked) {
          const order = board.find((o) => o.orderId === id);
          if (!order) continue; // an id the board does not know reaches no file, by construction
          const pdfPath = pdfPathFor(order.orderDir, order.orderId);
          if (existsSync(pdfPath)) picked.push({ order, pdfPath });
        }
        if (!picked.length) return json(res, 404, { error: 'Žádná z vybraných objednávek zatím nemá hotové PDF.' });

        const day = new Date().toISOString().slice(0, 10);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="print_batch_${day}.zip"`,
          'Cache-Control': 'no-store',
        });
        // Streamed and level 6, for the same reasons as the per-order archive above: a print run is
        // tens of megabytes of PDF, which does not compress and must not be held in memory.
        const archive = new ZipArchive({ zlib: { level: 6 } });
        archive.on('error', (err) => {
          log(`Tiskovy balik selhal: ${err.message}`);
          res.destroy(); // a truncated download is visibly broken; a short one looks complete
        });
        archive.pipe(res);
        for (const { order, pdfPath } of picked) archive.file(pdfPath, { name: batchPdfName(order) });
        log(`Tiskovy balik: ${picked.length} kniha(y) - ${picked.map((x) => x.order.orderId).join(', ')}`);
        return archive.finalize();
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

      // POST /api/_shutdown — stop the server cleanly. Runs the graceful shutdown (stops the polling
      // timers) BEFORE exiting, so nothing fires into a half-torn-down process. This is how the server
      // is restarted programmatically on Windows, where a background process can't be sent a real
      // Ctrl-C/SIGINT. Localhost-only server.
      if (req.method === 'POST' && url.pathname === '/api/_shutdown') {
        json(res, 200, { stopping: true });
        // Answer first, then stop the timers and exit once the response has flushed.
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

      // GET /img/<order>/<base>/<original|coloring|source>
      //
      // `source` is the customer's own upload — what the next generation will read, and therefore
      // the only frame a crop rectangle can be measured in. Served larger than the other two because
      // the crop editor zooms into it.
      if (req.method === 'GET' && parts[0] === 'img' && parts.length === 4) {
        const { photo } = find(parts[1], parts[2]);
        const wantsSource = parts[3] === 'source';
        const path = parts[3] === 'coloring' ? photo.files.coloring : wantsSource ? photo.files.source : photo.files.original;
        if (!path) return json(res, 404, { error: 'not generated yet' });
        let buf;
        try {
          buf = await thumbnail(path, wantsSource ? CROP_WIDTH : THUMB_WIDTH);
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
        const { text } = await readJson(req);
        return json(res, 200, { dedication: await withOrderLock(parts[1], () => {
          const order = state().find((o) => o.orderId === parts[1]);
          if (!order) throw new ReviewError(`Unknown order "${parts[1]}".`);
          return setOrderDedication(order.orderDir, text, { memoryRoot });
        }) });
      }

      // POST /api/<order>/intake-override — "generate it anyway" clears an intake hold, so the
      // next Go generates the order despite the flagged photos. A missing-photos hold requires
      // `confirmCount` (the typed reduced page count); overrideIntake throws a ReviewError (→ 409)
      // if it does not match, so the operator cannot ship an under-count book on a stray click.
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 3 && parts[2] === 'intake-override') {
        requireIdle();
        const { confirmCount = null } = await readJson(req).catch(() => ({}));
        return json(res, 200, await withOrderLock(parts[1], () => {
          const order = state().find((o) => o.orderId === parts[1]);
          if (!order) throw new ReviewError(`Unknown order "${parts[1]}".`);
          return overrideIntake(order.orderDir, { confirmCount });
        }));
      }

      // POST /api/<order>/sent — the operator confirms the PRINTED book has gone into the post to
      // the CUSTOMER (R14). Writes the dispatch marker (sent.json — a different file from the
      // retired delivered.json, KTD6) so the order derives to 'sent', becomes terminal and drops off
      // the active board. Manual only: nothing here posts anything, it records that the operator
      // already did. Operator-only in ROUTE_POLICY — Jirka prints, David posts.
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 3 && parts[2] === 'sent') {
        // Signed by the person who clicked (R9, U8). `identityFor` is the same resolved identity the
        // page is shown, so the name on the marker is the name in the sidebar of whoever wrote it —
        // and in ungated local mode it is the implicit operator (KTD11), where nobody signed in.
        return json(res, 200, await withOrderLock(parts[1], () => {
          const order = state().find((o) => o.orderId === parts[1]);
          if (!order) throw new ReviewError(`Unknown order "${parts[1]}".`);
          return { status: markSent(order.orderDir, identityFor(req)) };
        }));
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

      // GET /api/<order>/zip — one order's whole output in a single archive: every photo's original
      // and its vector .svg, plus the finished "<order> Final.pdf" once the book is built. Addressed
      // by order id like /pdf above, so no path from the page reaches the filesystem. This route is
      // the only way to get a finished order off a hosted deployment — the outbox lives on the server,
      // and nothing else here hands files back whole.
      if (req.method === 'GET' && parts[0] === 'api' && parts.length === 3 && parts[2] === 'zip') {
        const order = state().find((o) => o.orderId === parts[1]);
        if (!order) return json(res, 404, { error: 'Unknown order.' });
        const files = [];
        for (const p of order.photos) {
          if (p.files.original) files.push(p.files.original);
          if (p.files.svg) files.push(p.files.svg);
        }
        const pdfPath = pdfPathFor(order.orderDir, order.orderId);
        if (existsSync(pdfPath)) files.push(pdfPath);
        if (!files.length) return json(res, 404, { error: 'Objednávka nemá žádné soubory ke stažení.' });
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${order.orderId.replace(/[^\w.-]/g, '_')}.zip"`,
          'Cache-Control': 'no-store',
        });
        // Streamed, not buffered: a sixteen-photo book runs to tens of megabytes, and the hosted box
        // should not hold one in memory to send it. Level 6 rather than 9 because the bulk of the
        // bytes are JPEG and PDF, which do not compress — only the SVGs gain, and not enough to pay
        // for the slower squeeze on a small instance.
        const archive = new ZipArchive({ zlib: { level: 6 } });
        // The 200 and its headers are already gone, so a mid-stream failure can no longer become an
        // error response. Destroy the socket instead: a truncated transfer is a visibly broken
        // download, where quietly ending the stream would look like a complete archive missing files.
        archive.on('error', (err) => {
          log(`ZIP ${order.orderId} selhal: ${err.message}`);
          res.destroy();
        });
        archive.pipe(res);
        for (const f of files) archive.file(f, { name: basename(f) });
        return archive.finalize();
      }

      // POST /api/<order>/delete — remove an order from the board for good. Writes a hidden marker so it
      // stops showing (the folder + files stay on disk, recoverable by deleting the marker), and marks it
      // handled so the auto-fetch poll never re-materializes and regenerates it from Shopify. Refused
      // while that order is mid-generation, so a live run's folder isn't yanked out from under it.
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 3 && parts[2] === 'delete') {
        return json(res, 200, await withOrderLock(parts[1], () => {
          const order = state().find((o) => o.orderId === parts[1]);
          if (!order) throw new ReviewError(`Unknown order "${parts[1]}".`);
          if (run.active && run.orderId === order.orderId) throw new ReviewError('Objednávka se právě generuje — počkejte, než doběhne.');
          mkdirSync(order.orderDir, { recursive: true });
          writeFileSync(hiddenMarkerPath(order.orderDir), JSON.stringify({ hiddenAt: new Date().toISOString() }, null, 2));
          if (config.shopify?.dataDir) {
            try {
              const st = loadState(config.shopify.dataDir);
              markHandled(st, order.orderId, { status: 'deleted', at: new Date().toISOString() });
              saveState(config.shopify.dataDir, st);
            } catch { /* best-effort — the hidden marker alone still keeps it off the board */ }
          }
          return { deleted: order.orderId };
        }));
      }

      // POST /api/<order>/unsent — undo a dispatch mark set by mistake; the order returns to
      // 'printed' and back onto the active board.
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 3 && parts[2] === 'unsent') {
        await withOrderLock(parts[1], () => {
          const order = state().find((o) => o.orderId === parts[1]);
          if (!order) throw new ReviewError(`Unknown order "${parts[1]}".`);
          unmarkSent(order.orderDir);
        });
        return json(res, 200, { ok: true });
      }

      // POST /api/<order>/emailed { on? } — the operator marks (or clears) that they emailed the
      // customer about a held order (N4), so the queue can age it and stop the hold from rotting.
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 3 && parts[2] === 'emailed') {
        const { on = true } = await readJson(req).catch(() => ({}));
        return json(res, 200, await withOrderLock(parts[1], () => {
          const order = state().find((o) => o.orderId === parts[1]);
          if (!order) throw new ReviewError(`Unknown order "${parts[1]}".`);
          return { emailedAt: markCustomerEmailed(order.orderDir, on) };
        }));
      }

      // POST /api/<order>/printed — Jirka confirms he printed the book (N3, R15). It now precedes
      // dispatch: a printed book is not finished, it is waiting for the operator to post it.
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 3 && parts[2] === 'printed') {
        // Signed by the printer who clicked it (R9, U8) — the marker this route writes and the
        // dispatch marker above must be able to name two different people, or the split between the
        // two acts records nothing.
        return json(res, 200, await withOrderLock(parts[1], () => {
          const order = state().find((o) => o.orderId === parts[1]);
          if (!order) throw new ReviewError(`Unknown order "${parts[1]}".`);
          return { status: markPrinted(order.orderDir, identityFor(req)) };
        }));
      }

      // POST /api/<order>/unprinted — undo a printed mark set by mistake; the order returns to
      // 'ready-to-print'.
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 3 && parts[2] === 'unprinted') {
        await withOrderLock(parts[1], () => {
          const order = state().find((o) => o.orderId === parts[1]);
          if (!order) throw new ReviewError(`Unknown order "${parts[1]}".`);
          unmarkPrinted(order.orderDir);
        });
        return json(res, 200, { ok: true });
      }

      // POST /api/migrate/sent-markers { confirm? } — the one-shot U10 backfill (KTD7, R17).
      //
      // REPORTS by default and writes only on a separate, explicit `confirm: true`, mirroring the
      // purge's report-then-confirm shape: it writes markers into live customer order folders on the
      // mounted disk, and the operator gets to read what it intends to do first.
      //
      // Deliberately NOT run at startup. A deploy would then write into every order folder before
      // anyone could read a report, on an instance nobody was watching — and a migration over
      // customer data is not something to discover after the fact. Operator-only in ROUTE_POLICY.
      if (req.method === 'POST' && url.pathname === '/api/migrate/sent-markers') {
        const { confirm = false } = await readJson(req);
        try {
          if (confirm !== true) return json(res, 200, backfillSentMarkers({ outboxRoot: outbox }));
          const plan = planSentMarkerBackfill({ outboxRoot: outbox });
          const ids = [...plan.planned, ...plan.skipped].map((item) => item.orderId);
          return json(res, 200, await withOrderLocks(ids, () => {
            const locked = new Set(ids);
            const fresh = planSentMarkerBackfill({ outboxRoot: outbox });
            fresh.planned = fresh.planned.filter((item) => locked.has(item.orderId));
            fresh.skipped = fresh.skipped.filter((item) => locked.has(item.orderId));
            return backfillSentMarkers({ outboxRoot: outbox, apply: true, plan: fresh });
          }));
        } catch (err) {
          if (err instanceof SentMarkerMigrationError) return json(res, 409, { error: err.message, seam: err.seam });
          throw err;
        }
      }

      // --- THE PURGE, REPORT THEN CONFIRM (R19, U11) ----------------------------------------------
      //
      // Retention has existed since the first commit and has never once run on the hosted box: it
      // was a CLI on a machine nobody has a shell into. These two routes are the whole of R19, and
      // they are deliberately two:
      //
      //   GET  /api/purge/report   — what a purge would delete, and why every other order is kept.
      //   POST /api/purge/confirm  — the deletion, and only on an explicit `confirm: true`.
      //
      // The report is a GET and a dry run (purgeOriginals' default posture), so there is no code
      // path through it that opens an order folder for writing. A test asserts the fixture tree is
      // byte-identical afterwards, because "read-only" is a claim about photographs of children and
      // it should be checked rather than asserted in a comment.
      //
      // Both are operator-only in ROUTE_POLICY. Jirka prints books; he does not delete customers'
      // photographs.
      if (req.method === 'GET' && url.pathname === '/api/purge/report') {
        const days = config.retentionDays;
        if (!Number.isInteger(days) || days <= 0) {
          return json(res, 503, { error: 'Doba uchování (retentionDays) není nastavená — úklid je vypnutý.', code: 'not-configured' });
        }
        // The autopilot files are reported DRY here for the same reason the photographs are: this
        // route's whole contract is "what would confirming do", and it was quietly incomplete —
        // confirm cleared the night report and handled-set as well, and the report said nothing
        // about them. Same call, same clock, `dryRun` the only difference between the two routes.
        const autopilot = purgeAutopilotData({ dataDir: config.shopify?.dataDir ?? null, days });
        return json(res, 200, purgeReportForClient(purgeOriginals({ outboxRoot: outbox, days }), autopilot));
      }
      if (req.method === 'POST' && url.pathname === '/api/purge/confirm') {
        const days = config.retentionDays;
        if (!Number.isInteger(days) || days <= 0) {
          return json(res, 503, { error: 'Doba uchování (retentionDays) není nastavená — úklid je vypnutý.', code: 'not-configured' });
        }
        // A separate, explicit confirmation, not a flag on the report route. The dry run stays the
        // default posture everywhere: a purge must be something somebody asked for twice.
        const { confirm = false } = await readJson(req).catch(() => ({}));
        if (confirm !== true) {
          return json(res, 409, { error: 'Smazání je potřeba potvrdit.', code: 'confirm-required' });
        }
        const inspected = inspectOutbox({ outboxRoot: outbox, days });
        const ids = inspected.map((order) => order.orderId);
        const result = await withOrderLocks(ids, () => {
          const locked = new Set(ids);
          const fresh = inspectOutbox({ outboxRoot: outbox, days }).filter((order) => locked.has(order.orderId));
          return purgeOriginals({ outboxRoot: outbox, days, dryRun: false, inspected: fresh });
        });
        log(`purge: deleted ${result.photos} photograph(s) across ${result.orders.length} order(s); ${result.deferred.length} left for the next run`);
        // The night report and handled-set age out on the same clock (they carry order numbers), so
        // the confirmed run clears them too — the CLI has always done both in one pass, and the
        // REPORT route above now lists them for exactly this reason.
        const auto = purgeAutopilotData({ dataDir: config.shopify?.dataDir ?? null, days, dryRun: false });
        return json(res, 200, purgeReportForClient(result, auto));
      }

      // POST /api/<order>/<base>/<action>
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 4) {
        const [, orderId, base, action] = parts;
        requireIdle();
        if (action === 'approve') return json(res, 200, { status: await withOrderLock(orderId, () => approve(find(orderId, base).order.orderDir, base)) });
        if (action === 'reject') return json(res, 200, { status: await withOrderLock(orderId, () => reject(find(orderId, base).order.orderDir, base)) });
        if (action === 'handoff') return json(res, 200, { status: await withOrderLock(orderId, () => handoff(find(orderId, base).order.orderDir, base)) });
        if (action === 'replaced') {
          const { status } = await withOrderLock(orderId, () => acceptReplacement({ orderDir: find(orderId, base).order.orderDir, base, qc }));
          return json(res, 200, { status });
        }
        if (action === 'redo') {
          const body = await readJson(req, 2048).catch(() => ({}));
          await startRedo(orderId, base, null, { reason: body.reason ?? 'unspecified', note: body.note ?? null });
          return json(res, 202, { started: true });
        }
        // Undo an automatic straighten / screenshot crop: regenerate this one photo from the bytes
        // exactly as the customer sent them. Only restores fully while their original is still in the
        // inbox — once the photos are purged, the generator's echo is all there is, and that echo is
        // the corrected image. redo() already prefers the source over the echo.
        if (action === 'unframe') {
          // Also throws away the operator's own rectangle, because this button says "exactly as the
          // customer sent it" and a stored crop would quietly keep being applied. It is the revert.
          await startRedo(orderId, base, { noFraming: true }, null, ({ order }) =>
            setPhotoCrop({ orderDir: order.orderDir, base, crop: null, bases: order.photos.map((x) => x.base) })
          );
          return json(res, 202, { started: true });
        }
        // The operator's own crop of the CUSTOMER'S PHOTO — a rectangle, not a file. Three things on
        // one route because they are one decision: propose a box, store a box, clear a box.
        //
        // Nothing here writes an image. The stored fractions are applied to the customer's own
        // upload on every later generation (see batch.js generatePhoto), which is what makes the
        // original recoverable: it is never overwritten, so "revert" is deleting four numbers.
        if (action === 'crop') {
          const body = await readJson(req);
          // A proposal, computed and thrown away. Writes nothing, so it is safe to offer on a photo
          // the operator then decides not to crop at all.
          if (body.suggest === true) {
            const { photo } = find(orderId, base);
            return json(res, 200, { suggestion: await suggestPhotoCrop(photo.files.source) });
          }
          // `bases` from the board, not from the manifest: a photo that has never been generated has
          // no manifest entry yet, and that is exactly when cropping a screenshot saves a GPU run.
          const prepareCrop = ({ order, photo }) => {
            const manualCrop = setPhotoCrop({
              orderDir: order.orderDir,
              base,
              crop: body.crop ?? null,
              bases: order.photos.map((x) => x.base),
            });
            return photo.status == null ? { skipRedo: true, value: { started: false, manualCrop } } : { manualCrop };
          };
          // A photo that has never generated has nothing to regenerate; the crop simply waits for
          // the first run. Anything else goes straight back to the generator, because a crop the
          // operator drew and then had to remember to re-run is a crop that silently does nothing.
          const prepared = await startRedo(orderId, base, null, null, prepareCrop);
          if (prepared?.started === false) return json(res, 200, prepared);
          const { manualCrop } = prepared;
          return json(res, 202, { started: true, manualCrop });
        }
        // The operator's own white pencil and crop. The SVG is what the book prints, so that is
        // what gets edited; the raster the grid shows is re-made from it.
        if (action === 'edit') {
          const { strokes, crop } = await readJson(req, 4 * 1024 * 1024);
          const { status } = await withOrderLock(orderId, () => applyPhotoEdit({ orderDir: find(orderId, base).order.orderDir, base, edits: { strokes, crop }, qc }));
          return json(res, 200, { status });
        }
        if (action === 'revert') {
          const { status } = await withOrderLock(orderId, () => revertPhotoEdit({ orderDir: find(orderId, base).order.orderDir, base, qc }));
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
      if (err instanceof ReviewError || err instanceof IngestError || err instanceof OrderLockedError) return json(res, 409, { error: err.message, code: err.code ?? undefined });
      console.error(err);
      return json(res, 500, { error: err.message ?? 'Something went wrong.' });
    }
  });

  // The last word on the fail-open guard, checked against the address the socket ACTUALLY bound.
  // `assertLocalModeIsSafe` above reads the declared HOST, which is what a deploy gets wrong; this
  // catches a caller that passed a different address to listen() and would otherwise publish an
  // ungated studio anyway. Closing and re-raising is a refusal to start, not a degraded mode.
  server.on('listening', () => {
    if (auth.mode !== AUTH_MODES.UNGATED) return;
    const address = server.address();
    const bound = address && typeof address === 'object' ? address.address : null;
    if (isLoopbackHost(bound)) return;
    server.close();
    server.emit('error', new AuthConfigError(
      `Refusing to serve: no password hashes are configured and the server bound ${bound}, which is not ` +
        `loopback. Set the role password hashes, or bind 127.0.0.1.`,
    ));
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

  // Graceful stop: silence the background timers. Without this a Ctrl-C or a programmatic restart can
  // fire an auto-fetch or an auto-run into a process that is already on its way out, which starts a
  // generation nobody is left to watch. Best-effort; the process exits either way.
  async function shutdown() {
    if (autoFetchTimer) clearInterval(autoFetchTimer);
    if (autoRunTimer) clearInterval(autoRunTimer);
  }

  return { server, inFlight, shutdown };
}

// CLI: node src/ui/server.js [inbox] [outbox] [--port 4173] [--no-open]
// This is what the double-click launcher runs: the operator's whole tool is this page.
//
// The Basic Auth gate that used to live here (STUDIO_USER/STUDIO_PASS) is gone. It has been replaced
// by the session gate inside createReviewServer: per-role scrypt hashes, a sign-in page, and a
// refusal to run ungated anywhere but a loopback bind (src/auth/sessions.js).
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

  // `host` is handed in rather than re-read inside, so the safety check is made against the address
  // this process is actually about to bind — including a --port/HOST combination the env alone would
  // not describe. An AuthConfigError here means the studio would have been served ungated to the
  // world; it is a refusal to start, printed like the config errors above.
  let started;
  try {
    started = createReviewServer({ config, inboxRoot, outboxRoot, revealFinished: true, bindHost: host, log: (m) => console.log(`  ${m}`) });
  } catch (err) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  const { server, shutdown } = started;
  // Stop the background timers cleanly on the way out. Guard against double-fire (SIGINT then SIGTERM).
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
