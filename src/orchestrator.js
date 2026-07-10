import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { ingestOrders } from './ingest.js';
import { generateOrder, describeFailure } from './batch.js';
import { createGeneratorDriver } from './generator/factory.js';
import { BuilderDriver, collectPairs } from './builder/builderDriver.js';
import { photoBase } from './organize.js';
import {
  STATES,
  getStatus,
  getDedication,
  hasDedication,
  setDedication,
  writeManifest,
  isBuilderEligible,
  manifestPath,
} from './manifest.js';
import { deriveDedication, deriveSlug } from './dedication.js';
import { recallDedication, migrateDedications, MEMORY_DIR } from './dedications.js';

// U6: the single "Go" run. ingest -> generate -> QC -> [review gate] -> builder -> PDF.
//
// The review gate is a wall, not a step: an order whose photos are not all builder-eligible
// is not built at all. That is what makes "only approved results reach the PDF" true — the
// builder pairs whatever files it finds in the folder, so it cannot enforce the gate itself.
//
// A break at either seam is caught, named in plain language, and recorded against that order.
// The rest of the batch continues; one dead GPU job must not cost the other orders.

const noop = () => {};

/** Per-order outcome. `held` means the operator has photos to review — not a failure. */
export const ORDER_STATUS = Object.freeze({ DONE: 'done', HELD: 'held', FAILED: 'failed' });

const pdfPathFor = (orderDir, orderId) => join(orderDir, `${orderId} Final.pdf`);

/** The PDF is stale the moment any verdict changes: state.json is rewritten by generation and
 *  by every review action, so its mtime is the order's "last decided" clock. */
function pdfIsCurrent(pdfPath, orderDir) {
  if (!existsSync(pdfPath)) return false;
  const state = manifestPath(orderDir);
  if (!existsSync(state)) return false;
  return statSync(pdfPath).mtimeMs >= statSync(state).mtimeMs;
}

/** Refuse to print a folder that does not hold exactly this order's approved photos.
 *  Returns an operator-facing reason, or null when the folder is safe to build. */
export function buildabilityProblem(orderDir, bases) {
  const have = new Set(collectPairs(orderDir).map((p) => p.base));
  const missing = bases.filter((b) => !have.has(b));
  if (missing.length) {
    return `${missing.length} photo(s) have no coloring page to pair with: ${missing.join(', ')}`;
  }
  const extra = [...have].filter((b) => !bases.includes(b));
  if (extra.length) {
    const shown = extra.slice(0, 3).join(', ') + (extra.length > 3 ? ', …' : '');
    return `the order folder holds ${extra.length} pair(s) that are not part of this order (${shown}) — they would be printed into the book`;
  }
  return null;
}

async function buildOrder({ orderId, orderDir, bases, dedication, builder, config, force, onEvent }) {
  const pdfPath = pdfPathFor(orderDir, orderId);

  // Safety before caching: a folder that changed under the operator must not silently reuse
  // the PDF printed from what used to be in it.
  const problem = buildabilityProblem(orderDir, bases);
  if (problem) {
    const reason = `builder seam (load): ${problem}`;
    onEvent({ type: 'build-failed', orderId, reason });
    return { status: ORDER_STATUS.FAILED, pdfPath: null, reason };
  }

  if (!force && pdfIsCurrent(pdfPath, orderDir)) {
    onEvent({ type: 'build-skipped', orderId, pdfPath });
    return { status: ORDER_STATUS.DONE, pdfPath, reason: null };
  }

  try {
    onEvent({ type: 'build-start', orderId, photos: bases.length, dedication });
    // The per-order dedication beats any global default: the title page is customer text.
    const options = { ...(config.builder.pdf ?? {}), outPdfPath: pdfPath };
    if (dedication) options.dedication = dedication;
    const { pairs } = await builder.buildPdf(orderDir, options);
    onEvent({ type: 'build-done', orderId, pdfPath, pairs });
    return { status: ORDER_STATUS.DONE, pdfPath, reason: null };
  } catch (err) {
    const reason = describeFailure(err);
    onEvent({ type: 'build-failed', orderId, reason });
    return { status: ORDER_STATUS.FAILED, pdfPath: null, reason };
  }
}

/** The text the builder will print on the title page: the customer's dedication, or a configured
 *  default if the operator set one.
 *
 *  The builder gives a book a title page when it has anything to put on it — the cover thumbnails
 *  or this text. Measured against the live builder with 8 pairs (2026-07-10): coverCount 4 prints
 *  20 pages with or without this text, and only `coverCount: 0` *and* no text drops the title page
 *  and prints 18. So under the operator's config an order with no dedication is the same book with
 *  an empty title line — not a structurally different one. */
export function titleTextFor(config, dedication) {
  const fallback = config.builder?.pdf ?? {};
  return dedication || fallback.dedication || fallback.title || '';
}

/** Run every order end to end. Never throws for a single order; returns a report. */
export async function runPipeline({ config, inboxRoot, outboxRoot, generator, builder, qc, onEvent = noop, force = false, only = null, memoryRoot = MEMORY_DIR }) {
  const inbox = inboxRoot ?? config.paths.inbox;
  const outbox = outboxRoot ?? config.paths.outbox;
  // `only` is the operator ticking a few orders out of a folder that holds many. Orders still run
  // one at a time — the generator is one shared GPU queue, not something to fan out across.
  const found = ingestOrders(inbox);
  const orders = only ? found.filter((o) => only.includes(o.orderId)) : found;

  // The spellings used to be kept in the outbox, which is the one folder that gets emptied.
  const moved = migrateDedications(outbox, memoryRoot);
  if (moved.length) onEvent({ type: 'memory-moved', count: moved.length });

  // Drivers are constructed once, lazily, so a generation-only run never needs Chromium and a
  // rebuild-only run never needs the generator token.
  let gen = generator ?? null;
  let build = builder ?? null;

  onEvent({ type: 'run-start', orders: orders.length, inbox, outbox, skipped: found.length - orders.length });

  const report = [];
  for (const order of orders) {
    const { orderId } = order;
    onEvent({ type: 'order-start', orderId, dirName: order.dirName, photos: order.photos.length });

    gen ??= createGeneratorDriver(config);
    const { orderDir, manifest, summary } = await generateOrder({
      config,
      order,
      outboxRoot: outbox,
      driver: gen,
      qc,
      onEvent,
    });

    const bases = order.photos.map(photoBase);
    const notEligible = bases.filter((b) => !isBuilderEligible(getStatus(manifest, b)));
    const failed = notEligible.filter((b) => getStatus(manifest, b) === STATES.FAILED);
    const held = notEligible.filter((b) => getStatus(manifest, b) !== STATES.FAILED);

    let entry = { orderId, orderDir, summary, held, failed, pdfPath: null, reason: null, status: null, titled: false };

    // The customer's own words are in the photo names. Recover them once, for an order nobody
    // has decided the title of yet — never over an operator who has already answered, including
    // one who answered by emptying the box.
    if (!hasDedication(manifest)) {
      // A spelling the operator taught the tool wins: the shop folded the accents out of the file
      // name, so the name alone can only ever produce "Pro Jiricka".
      const remembered = recallDedication(memoryRoot, deriveSlug(bases));
      const derived = remembered || deriveDedication(bases);
      if (derived) {
        setDedication(manifest, derived);
        writeManifest(orderDir, manifest);
        onEvent({ type: 'title-derived', orderId, dedication: derived, remembered: Boolean(remembered) });
      }
    }

    const dedication = getDedication(manifest);
    const titleText = titleTextFor(config, dedication);

    if (failed.length) {
      entry.status = ORDER_STATUS.FAILED;
      entry.reason = `${failed.length} photo(s) failed to generate: ${failed.map((b) => `${b} — ${manifest.photos[b].reason}`).join('; ')}`;
    } else {
      if (held.length) {
        entry.status = ORDER_STATUS.HELD;
        entry.reason = `${held.length} photo(s) waiting for you in the review grid`;
      } else {
        // Plenty of customers write nothing. Their book is the same book with an empty title
        // line, so it prints rather than waiting for an operator to invent words for them.
        // Said out loud all the same: a dedication that was meant to be there and one that was
        // never written look identical once the PDF exists.
        if (!titleText) onEvent({ type: 'no-title', orderId });
        build ??= new BuilderDriver(config);
        const result = await buildOrder({ orderId, orderDir, bases, dedication, builder: build, config, force, onEvent });
        entry = { ...entry, ...result, titled: Boolean(titleText) };
      }
    }

    onEvent({ type: 'order-done', orderId, status: entry.status, pdfPath: entry.pdfPath, reason: entry.reason });
    report.push(entry);
  }

  const counts = {
    done: report.filter((o) => o.status === ORDER_STATUS.DONE).length,
    held: report.filter((o) => o.status === ORDER_STATUS.HELD).length,
    failed: report.filter((o) => o.status === ORDER_STATUS.FAILED).length,
  };
  onEvent({ type: 'run-done', counts });
  return { inbox, outbox, orders: report, counts };
}

// ---- progress rendering ----------------------------------------------------

/** One run event as a line the operator can read. Returns null for events with nothing to say.
 *  Shared by the CLI and the review grid's run log, so both describe a run identically. */
export function formatEvent(e) {
  switch (e.type) {
    case 'run-start':
      return `${e.orders} order(s) in ${e.inbox}${e.skipped ? ` (${e.skipped} more you did not tick)` : ''}`;
    case 'order-start': {
      const from = e.dirName && e.dirName !== e.orderId ? ` (from the photo names; folder is "${e.dirName}")` : '';
      return `\norder ${e.orderId} — ${e.photos} photo(s)${from}`;
    }
    case 'photo-start': return `  ${e.base}${e.redo ? ' (redo)' : ''}…`;
    case 'progress': return `    [${e.step}] ${e.message}`;
    case 'photo-ok': return `  ${e.base}: ok`;
    case 'photo-flagged': return `  ${e.base}: FLAGGED (${e.reason}) — needs review`;
    case 'photo-failed': return `  ${e.base}: FAILED — ${e.reason}`;
    case 'photo-skipped': return `  ${e.base}: skipped (${e.status})`;
    case 'memory-moved': return `Moved ${e.count} saved spelling${e.count > 1 ? 's' : ''} out of the outbox, into the tool's own folder.`;
    case 'title-derived': return `  title page (${e.remembered ? 'spelling you taught it' : 'from the photo names'}): ${e.dedication}`;
    case 'no-title': return '  no dedication in the photo names — the title page prints without text';
    case 'build-start': return `  building the PDF from ${e.photos} photo(s)…`;
    case 'build-done': return `  PDF: ${e.pdfPath} (${e.pairs} pairs)`;
    case 'build-skipped': return `  PDF already up to date: ${e.pdfPath}`;
    case 'build-failed': return `  BUILD FAILED — ${e.reason}`;
    default: return null;
  }
}

/** What the run is busy with, for a heartbeat. null when nothing long is in flight. */
export function workingOn(e) {
  if (e.type === 'photo-start') return e.base;
  if (e.type === 'build-start') return `${e.orderId} PDF`;
  if (['photo-ok', 'photo-flagged', 'photo-failed', 'build-done', 'build-failed'].includes(e.type)) return null;
  return undefined; // no change
}

// ---- CLI -------------------------------------------------------------------

const HEARTBEAT_MS = 15_000;

function cliRenderer() {
  let lastAt = Date.now();
  let working = null;
  const since = () => {
    const s = Math.round((Date.now() - lastAt) / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
  };

  // Diffusion and vectorize can go minutes without a word. Say something, or a slow call
  // reads as a hang and the operator kills the run.
  const timer = setInterval(() => {
    if (working && Date.now() - lastAt >= HEARTBEAT_MS) console.log(`    … still working on ${working} (${since()})`);
  }, 5_000);
  timer.unref();

  return {
    stop: () => clearInterval(timer),
    onEvent: (e) => {
      const next = workingOn(e);
      if (next !== undefined) working = next;
      lastAt = Date.now();
      // The driver's poll chatter keeps the heartbeat quiet without flooding the terminal.
      if (e.type === 'progress') return;
      const line = formatEvent(e);
      if (line !== null) console.log(line);
      if (e.type === 'order-done') console.log('');
    },
  };
}

function printReport({ orders, counts }) {
  console.log('Run report');
  if (!orders.length) {
    console.log('  no orders found — looked for .jpg/.jpeg photos in the input folder and its subfolders');
    return;
  }
  const width = Math.max(...orders.map((o) => o.orderId.length));
  for (const o of orders) {
    const id = o.orderId.padEnd(width);
    if (o.status === ORDER_STATUS.DONE) console.log(`  ${id}  done    ${o.pdfPath}${o.titled ? '' : '  (no dedication)'}`);
    else if (o.status === ORDER_STATUS.HELD) console.log(`  ${id}  held    ${o.reason}`);
    else console.log(`  ${id}  FAILED  ${o.reason}`);
  }
  console.log(`\n${counts.done} done, ${counts.held} waiting for you, ${counts.failed} failed.`);
  if (counts.held) console.log('Review them:  npm run review -- <inbox>     then run this again.');
}

// node src/orchestrator.js [inbox] [outbox] [--force] [--review]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const review = argv.includes('--review');
  const [inboxRoot, outboxRoot] = argv.filter((a) => !a.startsWith('--'));

  const config = loadConfig();
  const cli = cliRenderer();
  runPipeline({ config, inboxRoot, outboxRoot, force, onEvent: cli.onEvent })
    .then(async (result) => {
      cli.stop();
      printReport(result);
      if (review && result.counts.held) {
        const { createReviewServer } = await import('./ui/server.js');
        const { server } = createReviewServer({ config, inboxRoot: result.inbox, outboxRoot: result.outbox });
        server.listen(4173, '127.0.0.1', () => console.log('\nReview grid: http://127.0.0.1:4173/  (Ctrl-C to stop)'));
        return;
      }
      process.exit(result.counts.failed ? 1 : 0);
    })
    .catch((err) => {
      cli.stop();
      console.error(`Run stopped at the ${err.seam ?? 'unknown'} seam: ${err.message}`);
      process.exit(1);
    });
}
