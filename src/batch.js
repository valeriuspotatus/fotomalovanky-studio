import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { ingestOrders } from './ingest.js';
import { createGeneratorDriver } from './generator/factory.js';
import { photoBase, writeOutputs } from './organize.js';
import { tidyColoringPage } from './autoCrop.js';
import { assessOutputFiles } from './qcFiles.js';
import {
  STATES,
  getStatus,
  setStatus,
  setSource,
  setAttempt,
  appendGenerationAttempt,
  markGeneratorCeilingHit,
  setFraming,
  getAttempt,
  getManualCrop,
  correctionFromManualCrop,
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

export const DEFAULT_MAX_STEPS = 12;

/** What to send the generator when re-rolling a photo whose last attempt came back bad.
 *
 *  It must differ from `prev`, or the re-roll returns the same page: at >= 8 steps the generator
 *  is deterministic within a run, and its API takes no seed. The step count is the only knob that
 *  changes the sampler's trajectory while staying above 8, where the negative prompt is evaluated
 *  at all. Returns null once the ceiling is reached — at that point re-rolling cannot help and
 *  saying so is better than burning a GPU minute to reprint the same defect.
 *
 *  @param {object} generator  config.generator
 *  @param {?{steps:number}} prev  the attempt that produced what is on disk now
 *  @returns {?object} settings for driver.generate, or null when exhausted */
export function nextAttemptSettings(generator, prev) {
  const ceiling = generator.maxDiffusionSteps ?? DEFAULT_MAX_STEPS;
  const last = prev?.steps ?? generator.diffusionSteps;
  const steps = last + 1;
  if (steps > ceiling) return null;
  return { ...generator, diffusionSteps: steps };
}

/** One photo through the whole per-photo path: generate -> organize -> QC -> record.
 *  Never throws; a failure becomes a FAILED status. Writes state.json before returning, so an
 *  interrupt costs at most this photo. The review gate's redo calls this too — a redo must be
 *  the same code path as a first attempt, or the two drift. Returns the resulting status.
 *
 *  A photo that is flagged and already carries an attempt is being re-rolled, so it goes back to
 *  the generator with a changed step count rather than the identical request that produced the
 *  page the operator just rejected. */
export async function generatePhoto({ config, photoPath, orderDir, manifest, orderId, driver, qc = assessOutputFiles, onEvent = noop, overrides = null }) {
  const base = photoBase(photoPath);
  const prev = getAttempt(manifest, base);
  const isRedo = getStatus(manifest, base) != null;
  const reroll = prev != null && getStatus(manifest, base) === STATES.FLAGGED;

  const settings = reroll ? nextAttemptSettings(config.generator, prev) : { ...config.generator };
  // The operator's own crop, if they drew one. Read from the manifest rather than passed in, so it
  // holds for EVERY later generation of this photo — a redo from the grid, a re-roll, a whole batch
  // re-run — not just the regeneration that followed the click. It replaces the automatic framing
  // for this photo; the driver applies it to the same source and never re-trims its edges.
  if (settings) {
    const manual = correctionFromManualCrop(getManualCrop(manifest, base));
    if (manual) settings.correction = manual;
  }
  // Per-run overrides from the operator — `noFraming`, the undo for an automatic straighten or
  // screenshot crop. Applied after the re-roll ladder so it cannot disturb it, and after the crop so
  // "regenerate exactly as it arrived" still wins (the driver checks noFraming first).
  if (overrides && settings) Object.assign(settings, overrides);
  if (settings === null) {
    const reason =
      `re-rolled up to ${prev.steps} diffusion steps, the ceiling — this generator repeats itself, ` +
      `so running it again returns the same page. Approve it, repair it by hand, or change generator.variant.`;
    setStatus(manifest, base, STATES.FLAGGED, reason);
    markGeneratorCeilingHit(manifest, base);
    writeManifest(orderDir, manifest);
    onEvent({ type: 'photo-flagged', orderId, base, reason });
    return getStatus(manifest, base);
  }

  onEvent({ type: 'photo-start', orderId, base, redo: getStatus(manifest, base) != null, steps: settings.diffusionSteps });
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  try {
    const result = await driver.generate(photoPath, {
      ...settings,
      onProgress: ({ step, message }) => onEvent({ type: 'progress', orderId, base, step, message }),
    });
    const out = await writeOutputs(photoPath, orderDir, result);
    // Trim the coloring page down to its ink so a subject the model marooned in white doesn't print
    // with wide white borders (config.builder.autoCrop, default on). Never fail a page the GPU already
    // paid for over a crop hiccup — the uncropped page is still perfectly usable.
    if (config.builder?.autoCrop !== false) {
      const t = await tidyColoringPage({ pngPath: out.coloringPng, svgPath: out.coloringSvg });
      if (t.deframed) onEvent({ type: 'deframed', orderId, base });
      if (t.cropped) onEvent({ type: 'auto-cropped', orderId, base, kept: Number(t.kept.toFixed(2)) });
      if (t.error) onEvent({ type: 'auto-crop-skipped', orderId, base, reason: t.error });
    }
    const verdict = await qc(out);
    const next = verdict.verdict === 'ok' ? STATES.OK : STATES.FLAGGED;
    setStatus(manifest, base, next, verdict.reason);
    setSource(manifest, base, photoPath);
    // Only a completed generation records an attempt: a lost GPU job left no page to differ from,
    // so its retry must repeat the settings rather than climb the ladder for nothing.
    setAttempt(manifest, base, { steps: settings.diffusionSteps, variant: settings.variant ?? null });
    appendGenerationAttempt(manifest, base, {
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      kind: isRedo ? 'redo' : 'initial',
      variant: settings.variant ?? null,
      diffusionSteps: settings.diffusionSteps,
      settings,
      result: 'success',
      automaticQc: {
        verdict: verdict.verdict,
        reason: verdict.reason ?? null,
        metrics: Object.fromEntries(['coverage', 'solidFill', 'solidBlob', 'blockPx', 'blocks']
          .filter((key) => Number.isFinite(verdict[key]))
          .map((key) => [key, verdict[key]])),
      },
    });
    // What the framing pass did, if anything, so the grid can show it and the operator can undo it.
    setFraming(manifest, base, result.framing);
    if (result.framing?.rotate || result.framing?.crop) {
      onEvent({ type: 'reframed', orderId, base, rotate: result.framing.rotate ?? 0, cropped: Boolean(result.framing.crop) });
    }
    onEvent({ type: next === STATES.OK ? 'photo-ok' : 'photo-flagged', orderId, base, reason: verdict.reason });
  } catch (err) {
    const failureReason = describeFailure(err);
    setStatus(manifest, base, STATES.FAILED, failureReason);
    appendGenerationAttempt(manifest, base, {
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      kind: isRedo ? 'redo' : 'initial',
      variant: settings.variant ?? null,
      diffusionSteps: settings.diffusionSteps,
      settings,
      result: 'failure',
      failureReason,
    });
    onEvent({ type: 'photo-failed', orderId, base, reason: describeFailure(err) });
  } finally {
    writeManifest(orderDir, manifest);
  }
  return getStatus(manifest, base);
}

/** Generate every photo of one order that still needs it, writing state.json after each photo
 *  so an interrupted run resumes exactly where it stopped. A single photo's failure is recorded
 *  and the batch moves on — one dead GPU job must not cost the other fifteen photos. */
export async function generateOrder({ config, order, outboxRoot, driver, qc = assessOutputFiles, onEvent = noop, signal }) {
  const generator = driver ?? createGeneratorDriver(config);
  const orderDir = join(outboxRoot, order.orderId);
  mkdirSync(orderDir, { recursive: true });

  const manifest = readManifest(orderDir);
  manifest.orderId ??= order.orderId;
  const { orderId } = order;

  for (const photoPath of order.photos) {
    // Stopping lands here, between photos: a generation already handed to the GPU cannot be
    // pulled back, but the next one need never start. Photos already done keep their verdict;
    // the untouched ones stay pending and the next Go picks them up.
    if (signal?.aborted) break;

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
