// The overnight autopilot's unattended entrypoint (KTD2/KTD3): poll the Shopify Admin API for new
// PAID photo orders, materialize them into the inbox, run the EXISTING pipeline over just those ids,
// and write a night report the morning dashboard reads. It adds a trigger — no generation or delivery
// logic of its own. The no-send invariant holds by construction: this module never imports or reaches
// a delivery/WhatsApp path, and it calls runPipeline with force:false, which produces the PDF and stops.
//
// Detection is a SLIDING WINDOW, not a hard cursor: the poll asks for every order updated in the last
// few days and the handled set (autopilotState.js) dedups the finished ones. That is deliberate — a
// hard `updated_at > cursor` bound would freeze a held order (its updatedAt is in the past) and defeat
// the overnight self-lift (KTD8). Held/failed orders therefore re-surface each run until they resolve
// or fall out of the window; a `pending → paid` transition re-stamps updatedAt and re-enters the window.

import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { runPipeline, ORDER_STATUS, formatEvent } from './orchestrator.js';
import { createAdminClient } from './shopify/adminClient.js';
import { extractJobs } from './shopify/orders.js';
import { materializeOrder } from './shopify/materialize.js';
import { loadState, saveState, isHandled, markHandled } from './autopilotState.js';
import { writeReport, reportPath } from './autopilotReport.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// How far back each poll looks. Wide enough that a customer's next-day re-upload still lands inside the
// window so an intake hold can self-lift (KTD8); the handled set keeps finished orders from re-running.
export const POLL_LOOKBACK_DAYS = 7;

const isPaid = (order) => String(order.financialStatus ?? '').toUpperCase() === 'PAID';

/** Map a pipeline order status (done/held/failed) to the report vocabulary (ready/held/failed). */
function reportStatus(status) {
  if (status === ORDER_STATUS.DONE) return 'ready';
  if (status === ORDER_STATUS.HELD) return 'held';
  return 'failed';
}

/** Run one autopilot pass. Never throws for a single bad order; a hard failure (config, poll) rejects
 *  so the CLI can log it and the next scheduled run retries. All external seams are injected so a test
 *  drives the whole detect → materialize → pipeline → report contract with no network and no GPU. */
export async function runAutopilot({
  config,
  now = () => new Date().toISOString(),
  lookbackDays = POLL_LOOKBACK_DAYS,
  createClient = createAdminClient,
  materialize = materializeOrder,
  runPipelineFn = runPipeline,
  onEvent = () => {},
} = {}) {
  const sh = config.shopify;
  if (!sh?.enabled || !sh.accessToken) {
    onEvent({ type: 'autopilot-inert', reason: sh?.enabled ? 'no access token' : 'shopify.enabled is false' });
    return { ran: false, reason: 'disabled' };
  }

  const ranAt = now();
  // Second-precision ISO for the window bound — Shopify's search grammar accepts an ISO-8601
  // timestamp, but dropping the milliseconds sidesteps any parser strictness on the `.000` fraction.
  const windowFrom = new Date(Date.parse(ranAt) - lookbackDays * DAY_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const state = loadState(sh.dataDir);
  onEvent({ type: 'autopilot-start', windowFrom, ranAt });

  const client = createClient({ storeDomain: sh.storeDomain, accessToken: sh.accessToken, apiVersion: sh.apiVersion });

  // One paged poll of the whole window (every payment state), so non-paid photo orders are visible in
  // the report rather than vanishing. Extraction is by key substring — no `type` field on the public API.
  const nodes = await client.listOrders({ query: `updated_at:>=${windowFrom}` });
  // flatMap, not map: one order node can hold more than one book, and each becomes its own job with
  // its own id, folder and PDF. Everything downstream of here still works one job at a time.
  const orders = nodes
    .flatMap((n) => extractJobs(n, { photoKeyMatch: sh.photoKeyMatch, dedicationKeyMatch: sh.dedicationKeyMatch, layoutKeyMatch: sh.layoutKeyMatch }));

  const photoOrders = orders.filter((o) => o.photos.length > 0);
  // With requirePaid:false (David's setting) an order is generated on arrival regardless of payment —
  // RunPod is cheap and people often pay slightly later, so waiting only wastes turnaround. The default
  // (true) keeps the original "paid only" gate. `nonPaidPhotoSeen` is still reported either way.
  const requirePaid = sh.requirePaid !== false;
  const eligible = requirePaid ? photoOrders.filter(isPaid) : photoOrders;
  const nonPaidPhotoSeen = photoOrders.filter((o) => !isPaid(o)).length;
  // Also check the bare purchase number, not just the job id. A multi-book purchase completed
  // BEFORE books were split was recorded under its plain order number ("1234"); it now extracts as
  // "1234-1" and "1234-2", neither of which is in the handled map. Inside the polling window that
  // would look like new work and regenerate a book already printed and packed — unattended,
  // overnight. For a single-book order the two ids are the same and this is one check.
  const toProcess = eligible.filter((o) => !isHandled(state, o.orderId) && !isHandled(state, o.purchase.orderId));
  const skippedResolved = eligible.length - toProcess.length;
  onEvent({ type: 'poll-done', seen: orders.length, paidPhoto: eligible.length, nonPaidPhotoSeen, toProcess: toProcess.length, skippedResolved, requirePaid });

  // Materialize the new paid photo orders. A photo that cannot be fetched marks its order incomplete
  // (safeFetch refuses SSRF/non-image/off-allowlist URLs) — that order is reported "failed / needs
  // manual pull" and NOT run, so a half folder never reaches the pipeline.
  const newIds = [];
  const byId = new Map();
  const failedMaterialize = [];
  for (const order of toProcess) {
    byId.set(order.orderId, order);
    const result = await materialize(order, { inboxRoot: config.paths.inbox, allowlist: sh.photoHostAllowlist, now });
    if (result.incomplete) {
      failedMaterialize.push({ orderId: order.orderId, reason: `photos could not be downloaded — needs manual pull${result.errors?.length ? ` (${result.errors.join('; ')})` : ''}` });
      onEvent({ type: 'materialize', orderId: order.orderId, incomplete: true, errors: result.errors });
    } else {
      newIds.push(order.orderId);
      onEvent({ type: 'materialize', orderId: order.orderId, incomplete: false, files: result.files.length });
    }
  }

  // Reuse the shipped pipeline unchanged, over just the new ids, with every guardrail (intake hold +
  // email draft, QC, review gate, resumable build). force:false means an already-built PDF is not
  // re-generated — the no-send invariant and the spend bound both come from this call, not a flag.
  const pipeline = newIds.length
    ? await runPipelineFn({ config, only: newIds, force: false, onEvent })
    : { orders: [], counts: { done: 0, held: 0, failed: 0 } };

  // Assemble the report + advance state. Only orders whose book actually built (ready) are handled —
  // held/failed stay re-pollable so they can self-lift on a later run (KTD8).
  const reportOrders = [];
  for (const entry of pipeline.orders) {
    const status = reportStatus(entry.status);
    reportOrders.push({ orderId: entry.orderId, status, reason: entry.reason ?? null });
    if (status === 'ready') markHandled(state, entry.orderId, { status, updatedAt: byId.get(entry.orderId)?.updatedAt ?? null, at: ranAt });
  }
  for (const f of failedMaterialize) reportOrders.push({ orderId: f.orderId, status: 'failed', reason: f.reason });

  const counts = {
    ready: reportOrders.filter((o) => o.status === 'ready').length,
    held: reportOrders.filter((o) => o.status === 'held').length,
    failed: reportOrders.filter((o) => o.status === 'failed').length,
  };
  // Spend is over orders that actually hit the GPU: a built book or a generation failure. Held orders
  // stop at the intake gate before any GPU spend, and a materialize failure never reaches generation.
  const generated = pipeline.orders.filter((o) => o.status === ORDER_STATUS.DONE || o.status === ORDER_STATUS.FAILED).length;
  const estSpend = Number((generated * sh.estSpendPerOrder).toFixed(2));

  const report = {
    ranAt,
    window: { from: windowFrom, to: ranAt },
    counts,
    orders: reportOrders.sort((a, b) => a.orderId.localeCompare(b.orderId, 'en', { numeric: true })),
    seen: orders.length,
    paidPhotoSeen: eligible.length,
    nonPaidPhotoSeen,
    skippedResolved,
    processed: newIds.length,
    generated,
    estSpend,
  };

  state.lastRunAt = ranAt;
  saveState(sh.dataDir, state);
  writeReport(sh.dataDir, report);
  onEvent({ type: 'autopilot-done', counts, processed: newIds.length, estSpend, reportPath: reportPath(sh.dataDir) });

  return { ran: true, report, reportPath: reportPath(sh.dataDir) };
}

// ---- CLI -------------------------------------------------------------------
// node src/autopilot.js  — what the Windows scheduled task runs every ~15 min.

function cliOnEvent(e) {
  const stamp = () => `[${new Date().toISOString().slice(11, 19)}]`;
  switch (e.type) {
    case 'autopilot-inert':
      return console.log(`${stamp()} autopilot inert — ${e.reason}. Nothing polled, nothing touched.`);
    case 'autopilot-start':
      return console.log(`${stamp()} polling photo orders updated since ${e.windowFrom.slice(0, 16).replace('T', ' ')} …`);
    case 'poll-done':
      return console.log(
        `${stamp()} ${e.seen} order(s) in window · ${e.paidPhoto} ${e.requirePaid ? 'paid ' : ''}photo to run-pool · ${e.toProcess} new to run · ${e.skippedResolved} already done · ${e.nonPaidPhotoSeen} not yet paid`,
      );
    case 'materialize':
      return console.log(
        e.incomplete
          ? `${stamp()}   ${e.orderId}: could not download photos — needs manual pull`
          : `${stamp()}   ${e.orderId}: materialized ${e.files} photo(s)`,
      );
    case 'autopilot-done':
      return console.log(
        `${stamp()} done — ${e.counts.ready} ready, ${e.counts.held} need you, ${e.counts.failed} failed · ${e.processed} run · est. spend ~$${e.estSpend}\n${stamp()} report: ${e.reportPath}`,
      );
    default: {
      // Pipeline events flow through the same renderer the interactive run uses.
      const line = formatEvent(e);
      if (line !== null && e.type !== 'progress') console.log(`${stamp()} ${line}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  runAutopilot({ config, onEvent: cliOnEvent })
    // A completed pass — whether it ran orders or exited inert — is a success (exit 0). Only a thrown
    // hard failure (bad config, poll error) is non-zero, so the scheduled task's next slot retries.
    .then(() => { process.exitCode = 0; })
    .catch((err) => {
      console.error(`Autopilot run failed at the ${err.seam ?? 'unknown'} seam: ${err.message}`);
      process.exitCode = 1;
    })
    // Do NOT call process.exit() here. On Windows + Node 24 that aborts inside libuv's teardown while
    // undici's keep-alive sockets (from the Shopify poll) are still closing — "Assertion failed:
    // !(handle->flags & UV_HANDLE_CLOSING), async.c:94" — which turns every clean run into a 0xC0000409
    // "failure" in Task Scheduler and makes the result code useless for monitoring. Instead we set
    // exitCode and let the event loop drain, so Node exits with the right code on its own. The unref'd
    // backstop force-exits only if some ref'd handle blocks the drain, so the task can never hang up to
    // its 2h limit; the unref() ensures this timer itself never keeps the process alive.
    .finally(() => {
      setTimeout(() => process.exit(process.exitCode ?? 0), 8000).unref();
    });
}
