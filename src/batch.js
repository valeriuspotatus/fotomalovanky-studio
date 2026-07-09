import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { ingestOrders } from './ingest.js';
import { createGeneratorDriver } from './generator/factory.js';
import { photoBase, writeOutputs } from './organize.js';
import { assessOutputFiles } from './qcFiles.js';
import {
  STATES,
  getStatus,
  setStatus,
  setSource,
  needsGeneration,
  readManifest,
  writeManifest,
  summarizeOrder,
} from './manifest.js';

const noop = () => {};

/** Plain-language failure text for the manifest and the operator's report. Never a stack trace. */
export function describeFailure(err) {
  const seam = err?.seam ?? 'unknown';
  const step = err?.step ? ` (${err.step})` : '';
  return `${seam} seam${step}: ${err?.message ?? String(err)}`;
}

/** One photo through the whole per-photo path: generate -> organize -> QC -> record.
 *  Never throws; a failure becomes a FAILED status. Writes state.json before returning, so an
 *  interrupt costs at most this photo. The review gate's redo calls this too — a redo must be
 *  the same code path as a first attempt, or the two drift. Returns the resulting status. */
export async function generatePhoto({ config, photoPath, orderDir, manifest, orderId, driver, qc = assessOutputFiles, onEvent = noop }) {
  const base = photoBase(photoPath);
  onEvent({ type: 'photo-start', orderId, base, redo: getStatus(manifest, base) != null });
  try {
    const result = await driver.generate(photoPath, {
      ...config.generator,
      onProgress: ({ step, message }) => onEvent({ type: 'progress', orderId, base, step, message }),
    });
    const out = writeOutputs(photoPath, orderDir, result);
    const verdict = await qc(out);
    const next = verdict.verdict === 'ok' ? STATES.OK : STATES.FLAGGED;
    setStatus(manifest, base, next, verdict.reason);
    setSource(manifest, base, photoPath);
    onEvent({ type: next === STATES.OK ? 'photo-ok' : 'photo-flagged', orderId, base, reason: verdict.reason });
  } catch (err) {
    setStatus(manifest, base, STATES.FAILED, describeFailure(err));
    onEvent({ type: 'photo-failed', orderId, base, reason: describeFailure(err) });
  } finally {
    writeManifest(orderDir, manifest);
  }
  return getStatus(manifest, base);
}

/** Generate every photo of one order that still needs it, writing state.json after each photo
 *  so an interrupted run resumes exactly where it stopped. A single photo's failure is recorded
 *  and the batch moves on — one dead GPU job must not cost the other fifteen photos. */
export async function generateOrder({ config, order, outboxRoot, driver, qc = assessOutputFiles, onEvent = noop }) {
  const generator = driver ?? createGeneratorDriver(config);
  const orderDir = join(outboxRoot, order.orderId);
  mkdirSync(orderDir, { recursive: true });

  const manifest = readManifest(orderDir);
  manifest.orderId ??= order.orderId;
  const { orderId } = order;

  for (const photoPath of order.photos) {
    const base = photoBase(photoPath);
    const status = getStatus(manifest, base);

    if (!needsGeneration(status)) {
      onEvent({ type: 'photo-skipped', orderId, base, status });
      continue;
    }

    await generatePhoto({ config, photoPath, orderDir, manifest, orderId, driver: generator, qc, onEvent });
  }

  return { orderId, orderDir, manifest, summary: summarizeOrder(manifest, order.photos.map(photoBase)) };
}

/** Ingest the inbox and generate every order. Orders are processed one at a time and
 *  sequentially within an order — the generator is a single shared GPU queue, not something
 *  to hammer. Returns a per-order report. */
export async function runBatch({ config, inboxRoot, outboxRoot, driver, qc, onEvent = noop }) {
  const inbox = inboxRoot ?? config.paths.inbox;
  const outbox = outboxRoot ?? config.paths.outbox;
  const orders = ingestOrders(inbox);
  onEvent({ type: 'batch-start', orders: orders.length, inbox, outbox });

  const results = [];
  for (const order of orders) {
    onEvent({ type: 'order-start', orderId: order.orderId, dirName: order.dirName, photos: order.photos.length });
    const result = await generateOrder({ config, order, outboxRoot: outbox, driver, qc, onEvent });
    onEvent({ type: 'order-done', orderId: order.orderId, summary: result.summary });
    results.push(result);
  }

  onEvent({ type: 'batch-done', orders: results.length });
  return { inbox, outbox, orders: results };
}

// CLI: node src/batch.js [inboxRoot] [outboxRoot] — U3 seam test, no builder step.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [inboxRoot, outboxRoot] = process.argv.slice(2);
  const config = loadConfig();
  const line = (e) => {
    if (e.type === 'batch-start') return `${e.orders} order(s) in ${e.inbox}`;
    if (e.type === 'order-start') {
      // The photo names decide the order id; say so when the folder disagrees.
      const from = e.dirName && e.dirName !== e.orderId ? ` (from the photo names; folder is "${e.dirName}")` : '';
      return `\norder ${e.orderId} — ${e.photos} photo(s)${from}`;
    }
    if (e.type === 'photo-start') return `  ${e.base}${e.redo ? ' (redo)' : ''}…`;
    if (e.type === 'progress') return `    [${e.step}] ${e.message}`;
    if (e.type === 'photo-ok') return `  ${e.base}: ok`;
    if (e.type === 'photo-flagged') return `  ${e.base}: FLAGGED (${e.reason}) — needs review`;
    if (e.type === 'photo-failed') return `  ${e.base}: FAILED — ${e.reason}`;
    if (e.type === 'photo-skipped') return `  ${e.base}: skipped (${e.status})`;
    if (e.type === 'order-done') {
      const s = e.summary;
      const parts = [`${s.eligible}/${s.total} ready`];
      if (s.held) parts.push(`${s.held} held for review`);
      if (s.manual) parts.push(`${s.manual} in manual repair`);
      if (s.failed) parts.push(`${s.failed} failed`);
      if (s.pending) parts.push(`${s.pending} never ran`);
      return `  → ${parts.join(', ')}`;
    }
    return null;
  };
  runBatch({ config, inboxRoot, outboxRoot, onEvent: (e) => { const l = line(e); if (l !== null) console.log(l); } })
    .then(({ orders, outbox }) => {
      if (orders.length === 0) {
        console.log('No orders found — looked for .jpg/.jpeg photos in the input folder and its subfolders.');
        return;
      }
      const ready = orders.filter((o) => o.summary.ready).length;
      console.log(`\n${ready}/${orders.length} order(s) ready for the builder. Outputs in ${outbox}`);
    })
    .catch((err) => {
      console.error(`Batch stopped at the ${err.seam ?? 'unknown'} seam: ${err.message}`);
      process.exit(1);
    });
}
