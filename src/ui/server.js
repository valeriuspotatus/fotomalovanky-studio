import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { loadConfig } from '../config.js';
import { createGeneratorDriver } from '../generator/factory.js';
import { reviewState, approve, reject, handoff, acceptReplacement, redo, ReviewError } from '../review.js';

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

/** Shape the state for the browser. Photo files are never addressed by path — the page asks for
 *  them by (order, base, kind), which also means a crafted path cannot reach the filesystem.
 *  The order folder *is* sent: the operator has to save a hand-repaired file into it. */
function forClient(orders, inFlight) {
  return orders.map((o) => ({
    orderId: o.orderId,
    dirName: o.dirName,
    orderDir: o.orderDir,
    summary: o.summary,
    photos: o.photos.map((p) => ({
      base: p.base,
      status: p.status,
      reason: p.reason,
      builderEligible: p.builderEligible,
      holdsForReview: p.holdsForReview,
      hasOriginal: Boolean(p.files.original),
      hasColoring: Boolean(p.files.coloring),
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
  const buf = await sharp(path)
    .flatten({ background: '#ffffff' })
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  if (thumbs.size > 300) thumbs.clear();
  thumbs.set(key, buf);
  return buf;
}

/** Best-effort "open this in the operator's desktop". Never throws into a request. */
function openExternally(target) {
  const cmd =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

export function createReviewServer({ config, inboxRoot, outboxRoot, driver, qc } = {}) {
  const inbox = inboxRoot ?? config.paths.inbox;
  const outbox = outboxRoot ?? config.paths.outbox;
  const inFlight = new Map(); // "order/base" -> { message }
  let generator = driver ?? null;

  const state = () => reviewState({ inboxRoot: inbox, outboxRoot: outbox });

  const find = (orderId, base) => {
    const order = state().find((o) => o.orderId === orderId);
    if (!order) throw new ReviewError(`Unknown order "${orderId}".`);
    const photo = order.photos.find((p) => p.base === base);
    if (!photo) throw new ReviewError(`Unknown photo "${base}" in order "${orderId}".`);
    return { order, photo };
  };

  async function startRedo(orderId, base) {
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
        return json(res, 200, { orders: forClient(state(), inFlight), inbox, outbox });
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

      // POST /api/<order>/<base>/<action>
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 4) {
        const [, orderId, base, action] = parts;
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
        return json(res, 404, { error: `Unknown action "${action}".` });
      }

      // POST /api/open/<generator|folder>[/<order>] — the server opens it, so no path or token
      // is ever handed to the page.
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'open') {
        if (parts[2] === 'generator') return json(res, 200, { opened: openExternally(config.generator.baseUrl) });
        if (parts[2] === 'folder' && parts[3]) {
          const order = state().find((o) => o.orderId === parts[3]);
          if (!order) return json(res, 404, { error: 'Unknown order.' });
          return json(res, 200, { opened: openExternally(order.orderDir) });
        }
      }

      return json(res, 404, { error: 'Not found.' });
    } catch (err) {
      if (err instanceof ReviewError) return json(res, 409, { error: err.message });
      console.error(err);
      return json(res, 500, { error: err.message ?? 'Something went wrong.' });
    }
  });

  return { server, inFlight };
}

// CLI: node src/ui/server.js [inbox] [outbox] [--port 4173]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const portFlag = argv.indexOf('--port');
  const port = portFlag >= 0 ? Number(argv[portFlag + 1]) : 4173;
  const [inboxRoot, outboxRoot] = argv.filter((a) => !a.startsWith('--') && a !== String(port));

  const config = loadConfig();
  const { server } = createReviewServer({ config, inboxRoot, outboxRoot });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`Review grid on ${url}  (local only — Ctrl-C to stop)`);
    openExternally(url);
  });
}
