import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { loadConfig } from '../config.js';
import { createGeneratorDriver } from '../generator/factory.js';
import { BuilderDriver } from '../builder/builderDriver.js';
import { runPipeline, formatEvent } from '../orchestrator.js';
import { ingestOrders, IngestError } from '../ingest.js';
import {
  reviewState,
  approve,
  reject,
  handoff,
  acceptReplacement,
  redo,
  setOrderDedication,
  overrideIntake,
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

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

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
    return [env.ComSpec ?? join(systemRoot(env), 'System32', 'cmd.exe'), ['/c', 'start', '', target]];
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
export function createReviewServer({ config, inboxRoot, outboxRoot, driver, builder, qc, intake, revealFinished = false, reveal = openExternally, log = () => {}, memoryRoot = MEMORY_DIR } = {}) {
  let inbox = inboxRoot ?? config.paths.inbox; // the Go bar can point the tool at another folder
  const outbox = outboxRoot ?? config.paths.outbox;
  const inFlight = new Map(); // "order/base" -> { message }
  const run = { active: false, stopping: false, lines: [], report: null, error: null };
  let runController = null; // the live run's AbortController, or null between runs
  let generator = driver ?? null;
  let builderDriver = builder ?? null;

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

  /** A run holds each order's manifest in memory and rewrites it after every photo. A verdict
   *  saved meanwhile would be silently overwritten, so verdicts are refused while a run is on. */
  const requireIdle = () => {
    if (run.active) throw new ReviewError('A run is in progress — wait for it to finish before changing anything.');
  };

  function startRun({ inbox: requested, force }) {
    if (run.active) throw new ReviewError('A run is already going.');
    if (inFlight.size) throw new ReviewError('A photo is still being regenerated — wait for it to finish.');

    const candidate = String(requested ?? '').trim() || inbox;
    if (candidate !== inbox) {
      scanInbox(candidate); // surfaces a missing folder before anything starts
      selected = null; // a new folder's orders are not the old folder's
      inbox = candidate;
    } else {
      ingestOrders(candidate);
    }

    if (selected?.length === 0) throw new ReviewError('Tick at least one order to run.');

    run.active = true;
    run.stopping = false;
    run.lines = [];
    run.report = null;
    run.error = null;
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
      only: selected,
      memoryRoot,
      signal: runController.signal,
      onEvent: (e) => {
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
        if (!revealFinished || !built.length) return;
        reveal(built.length === 1 ? built[0].orderDir : outbox);
      })
      .catch((err) => {
        run.error = `${err.seam ?? 'unknown'} seam: ${err.message}`;
      })
      .finally(() => {
        run.active = false;
        run.stopping = false;
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

    try {
      if (req.method === 'GET' && url.pathname === '/') {
        const html = readFileSync(join(HERE, 'static', 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        return json(res, 200, { orders: forClient(state(), inFlight), inbox, outbox, run, selected, queue });
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

      // POST /api/_run  { inbox?, force? } — the Go button.
      if (req.method === 'POST' && url.pathname === '/api/_run') {
        startRun(await readJson(req));
        return json(res, 202, { started: true, inbox });
      }

      // POST /api/_stop — the Stop button. Winds the run down at the next photo boundary.
      if (req.method === 'POST' && url.pathname === '/api/_stop') {
        return json(res, 200, stopRun());
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
      // next Go generates the order despite the flagged photos.
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 3 && parts[2] === 'intake-override') {
        requireIdle();
        const order = state().find((o) => o.orderId === parts[1]);
        if (!order) throw new ReviewError(`Unknown order "${parts[1]}".`);
        return json(res, 200, { override: overrideIntake(order.orderDir) });
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

      return json(res, 404, { error: 'Not found.' });
    } catch (err) {
      // Both carry operator-facing text; neither is a bug in the tool.
      if (err instanceof ReviewError || err instanceof IngestError) return json(res, 409, { error: err.message });
      console.error(err);
      return json(res, 500, { error: err.message ?? 'Something went wrong.' });
    }
  });

  return { server, inFlight };
}

// CLI: node src/ui/server.js [inbox] [outbox] [--port 4173] [--no-open]
// This is what the double-click launcher runs: the operator's whole tool is this page.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const portFlag = argv.indexOf('--port');
  const port = portFlag >= 0 ? Number(argv[portFlag + 1]) : 4173;
  const [inboxRoot, outboxRoot] = argv.filter((a) => !a.startsWith('--') && a !== String(port));

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`\n${err.message}\n`); // ConfigError already reads as instructions
    process.exit(1);
  }

  const { server } = createReviewServer({ config, inboxRoot, outboxRoot, revealFinished: true, log: (m) => console.log(`  ${m}`) });
  server.on('error', (err) => {
    const why =
      err.code === 'EADDRINUSE'
        ? `Port ${port} is already in use — the tool may already be open in another window.`
        : err.message;
    console.error(`\nCould not start: ${why}\n`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`\n  Fotomalovánky is running.\n\n  ${url}\n\n  Leave this window open. Close it (or press Ctrl-C) to stop.\n`);
    if (!argv.includes('--no-open')) {
      openExternally(url).then((opened) => {
        if (!opened) console.log(`  Could not open your browser by itself. Open it and go to  ${url}\n`);
      });
    }
  });
}
