import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAutopilot } from '../src/autopilot.js';
import { ORDER_STATUS } from '../src/orchestrator.js';
import { loadState, isHandled, saveState, markHandled } from '../src/autopilotState.js';
import { reportPath } from '../src/autopilotReport.js';

// A fixed clock so the poll window and the report timestamps are deterministic.
const NOW = () => '2026-07-12T06:00:00.000Z';

/** A directory pair (outside-repo data dir + inbox) with a cleanup handle. */
function dirs() {
  const base = mkdtempSync(join(tmpdir(), 'fma-autopilot-'));
  return { dataDir: join(base, 'data'), inbox: join(base, 'inbox'), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function makeConfig(dataDir, inbox) {
  return {
    paths: { inbox, outbox: inbox },
    shopify: {
      enabled: true,
      storeDomain: 'x.myshopify.com',
      accessToken: 'shpat_secret',
      apiVersion: '2026-07',
      photoKeyMatch: 'fotka',
      dedicationKeyMatch: 'věnování',
      layoutKeyMatch: 'rozvržení',
      photoHostAllowlist: ['cdn.tigren.com'],
      estSpendPerOrder: 0.5,
      dataDir,
    },
  };
}

/** A raw Admin-API-shaped order node (the real public shape: {key,value}, no `type` field). */
function node({ name, financial = 'PAID', updatedAt = '2026-07-12T01:00:00Z', photos = [], dedication = '', layout = '', variant = '🖨️ Tištěné omalovánky / 4', email = 'a@b.cz' }) {
  const attrs = [];
  photos.forEach((url, i) => attrs.push({ key: `Fotka (${photos.length})-${i + 1}`, value: url }));
  if (dedication) attrs.push({ key: 'Věnování', value: dedication });
  if (layout) attrs.push({ key: 'Rozvržení', value: layout });
  return {
    name,
    email,
    updatedAt,
    displayFinancialStatus: financial,
    lineItems: { edges: [{ node: { title: 'Fotomalovánky', variantTitle: variant, quantity: 1, customAttributes: attrs } }] },
  };
}

const clientWith = (nodes) => () => ({ listOrders: async () => nodes });

/** A materialize spy that records the ids it was asked to write and can be told to fail specific ones. */
function spyMaterialize(overrides = {}) {
  const calls = [];
  const fn = async (order) => {
    calls.push(order.orderId);
    return overrides[order.orderId] || { orderId: order.orderId, incomplete: false, files: ['photo.jpg'], errors: [] };
  };
  fn.calls = calls;
  return fn;
}

/** A runPipeline spy that returns canned per-order statuses and records how it was called. */
function spyPipeline(statusById) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    const orders = (args.only || []).map((orderId) => ({ orderId, status: statusById[orderId] ?? ORDER_STATUS.DONE, reason: statusById[orderId] === ORDER_STATUS.FAILED ? 'GPU said no' : null, pdfPath: null }));
    const counts = {
      done: orders.filter((o) => o.status === ORDER_STATUS.DONE).length,
      held: orders.filter((o) => o.status === ORDER_STATUS.HELD).length,
      failed: orders.filter((o) => o.status === ORDER_STATUS.FAILED).length,
    };
    return { orders, counts };
  };
  fn.calls = calls;
  return fn;
}

const PHOTO = 'https://cdn.tigren.com/media/a.jpg';

test('a new paid photo order is materialized, run over just its id with force:false, and reported ready', async () => {
  const { dataDir, inbox, cleanup } = dirs();
  try {
    const materialize = spyMaterialize();
    const runPipelineFn = spyPipeline({ 1600: ORDER_STATUS.DONE });
    const r = await runAutopilot({
      config: makeConfig(dataDir, inbox),
      now: NOW,
      createClient: clientWith([node({ name: '#1600', photos: [PHOTO] })]),
      materialize,
      runPipelineFn,
    });

    assert.equal(r.ran, true);
    assert.deepEqual(materialize.calls, ['1600']);
    assert.deepEqual(runPipelineFn.calls[0].only, ['1600']);
    assert.equal(runPipelineFn.calls[0].force, false, 'the no-send + spend bound both come from force:false');

    const report = JSON.parse(readFileSync(reportPath(dataDir), 'utf8'));
    assert.equal(report.counts.ready, 1);
    assert.equal(report.orders[0].orderId, '1600');
    assert.equal(report.orders[0].status, 'ready');
    assert.equal(report.processed, 1);
    assert.ok(isHandled(loadState(dataDir), '1600'), 'a built order joins the handled set so it never re-runs');
  } finally {
    cleanup();
  }
});

test('a resolved order already in the handled set is skipped — not re-materialized, not re-run (R6)', async () => {
  const { dataDir, inbox, cleanup } = dirs();
  try {
    const seeded = loadState(dataDir);
    markHandled(seeded, '1600', { status: 'ready', at: 'earlier' });
    saveState(dataDir, seeded);

    const materialize = spyMaterialize();
    const runPipelineFn = spyPipeline({});
    const r = await runAutopilot({
      config: makeConfig(dataDir, inbox),
      now: NOW,
      createClient: clientWith([node({ name: '#1600', photos: [PHOTO] })]),
      materialize,
      runPipelineFn,
    });

    assert.deepEqual(materialize.calls, [], 'a handled order is never re-materialized');
    assert.equal(runPipelineFn.calls.length, 0, 'nothing new to run, so the pipeline is not invoked');
    assert.equal(r.report.skippedResolved, 1);
    assert.equal(r.report.processed, 0);
  } finally {
    cleanup();
  }
});

test('a held order stays re-pollable — it is re-materialized on the next run, never frozen out (KTD8)', async () => {
  const { dataDir, inbox, cleanup } = dirs();
  try {
    const materialize = spyMaterialize();
    const held = spyPipeline({ 1601: ORDER_STATUS.HELD });
    const cfg = makeConfig(dataDir, inbox);
    const nodes = [node({ name: '#1601', photos: [PHOTO] })];

    await runAutopilot({ config: cfg, now: NOW, createClient: clientWith(nodes), materialize, runPipelineFn: held });
    assert.equal(isHandled(loadState(dataDir), '1601'), false, 'a held order is deliberately NOT handled');

    // Second run (customer has re-uploaded): the order must be pulled again so intake can self-lift.
    const ready = spyPipeline({ 1601: ORDER_STATUS.DONE });
    await runAutopilot({ config: cfg, now: NOW, createClient: clientWith(nodes), materialize, runPipelineFn: ready });
    assert.deepEqual(materialize.calls, ['1601', '1601'], 'the held order is re-materialized on the second run');
    assert.ok(isHandled(loadState(dataDir), '1601'), 'once it builds it becomes terminal');
  } finally {
    cleanup();
  }
});

test('a no-photo order returned by the poll is skipped (R10)', async () => {
  const { dataDir, inbox, cleanup } = dirs();
  try {
    const materialize = spyMaterialize();
    const runPipelineFn = spyPipeline({});
    const r = await runAutopilot({
      config: makeConfig(dataDir, inbox),
      now: NOW,
      createClient: clientWith([node({ name: '#1700', photos: [] })]),
      materialize,
      runPipelineFn,
    });
    assert.deepEqual(materialize.calls, []);
    assert.equal(runPipelineFn.calls.length, 0);
    assert.equal(r.report.processed, 0);
    assert.equal(r.report.paidPhotoSeen, 0, 'a no-photo order is not a photo order');
  } finally {
    cleanup();
  }
});

test('an intake-held order is reported held (with a reason), never failed (R4)', async () => {
  const { dataDir, inbox, cleanup } = dirs();
  try {
    const r = await runAutopilot({
      config: makeConfig(dataDir, inbox),
      now: NOW,
      createClient: clientWith([node({ name: '#1602', photos: [PHOTO] })]),
      materialize: spyMaterialize(),
      runPipelineFn: spyPipeline({ 1602: ORDER_STATUS.HELD }),
    });
    assert.equal(r.report.counts.held, 1);
    assert.equal(r.report.counts.failed, 0);
    assert.equal(r.report.orders[0].status, 'held');
  } finally {
    cleanup();
  }
});

test('one generation failure is reported failed; other orders still complete; the batch exits clean', async () => {
  const { dataDir, inbox, cleanup } = dirs();
  try {
    const r = await runAutopilot({
      config: makeConfig(dataDir, inbox),
      now: NOW,
      createClient: clientWith([node({ name: '#1603', photos: [PHOTO] }), node({ name: '#1604', photos: [PHOTO] })]),
      materialize: spyMaterialize(),
      runPipelineFn: spyPipeline({ 1603: ORDER_STATUS.DONE, 1604: ORDER_STATUS.FAILED }),
    });
    assert.equal(r.ran, true);
    assert.equal(r.report.counts.ready, 1);
    assert.equal(r.report.counts.failed, 1);
    // Both orders hit the GPU (one built, one failed), so both count toward the spend estimate.
    assert.equal(r.report.generated, 2);
    assert.equal(r.report.estSpend, 1, '2 generated × $0.50');
    assert.equal(isHandled(loadState(dataDir), '1604'), false, 'a failed order stays re-pollable for a retry');
  } finally {
    cleanup();
  }
});

test('a photo that cannot be downloaded marks the order failed / needs-manual-pull and is not run', async () => {
  const { dataDir, inbox, cleanup } = dirs();
  try {
    const materialize = spyMaterialize({ 1605: { orderId: '1605', incomplete: true, files: [], errors: ['photo 1: host not on allowlist'] } });
    const runPipelineFn = spyPipeline({});
    const r = await runAutopilot({
      config: makeConfig(dataDir, inbox),
      now: NOW,
      createClient: clientWith([node({ name: '#1605', photos: ['https://evil.example/x.jpg'] })]),
      materialize,
      runPipelineFn,
    });
    assert.equal(runPipelineFn.calls.length, 0, 'a half folder never reaches the pipeline');
    assert.equal(r.report.counts.failed, 1);
    assert.match(r.report.orders[0].reason, /needs manual pull/);
    assert.equal(r.report.processed, 0);
  } finally {
    cleanup();
  }
});

test('shopify disabled → the runner is inert: no report, no client, nothing touched (R9 fallback intact)', async () => {
  const { dataDir, inbox, cleanup } = dirs();
  try {
    const config = makeConfig(dataDir, inbox);
    config.shopify.enabled = false;
    let clientBuilt = false;
    const r = await runAutopilot({
      config,
      now: NOW,
      createClient: () => {
        clientBuilt = true;
        return { listOrders: async () => [] };
      },
      materialize: spyMaterialize(),
      runPipelineFn: spyPipeline({}),
    });
    assert.equal(r.ran, false);
    assert.equal(clientBuilt, false, 'a disabled autopilot never even builds a client');
    assert.equal(existsSync(reportPath(dataDir)), false, 'no report is written');
  } finally {
    cleanup();
  }
});

test('a non-paid photo order is counted seen-but-skipped, not vanished (payment-mix visibility)', async () => {
  const { dataDir, inbox, cleanup } = dirs();
  try {
    const materialize = spyMaterialize();
    const r = await runAutopilot({
      config: makeConfig(dataDir, inbox),
      now: NOW,
      createClient: clientWith([node({ name: '#1610', financial: 'PAID', photos: [PHOTO] }), node({ name: '#1611', financial: 'PENDING', photos: [PHOTO] })]),
      materialize,
      runPipelineFn: spyPipeline({ 1610: ORDER_STATUS.DONE }),
    });
    assert.deepEqual(materialize.calls, ['1610'], 'only the paid order is materialized');
    assert.equal(r.report.paidPhotoSeen, 1);
    assert.equal(r.report.nonPaidPhotoSeen, 1, 'the pending photo order is surfaced, not silently dropped');
  } finally {
    cleanup();
  }
});

test('with requirePaid:false an unpaid photo order is processed too (run everything, pay later)', async () => {
  const { dataDir, inbox, cleanup } = dirs();
  try {
    const base = makeConfig(dataDir, inbox);
    const config = { ...base, shopify: { ...base.shopify, requirePaid: false } };
    const materialize = spyMaterialize();
    const r = await runAutopilot({
      config,
      now: NOW,
      createClient: clientWith([node({ name: '#1630', financial: 'PAID', photos: [PHOTO] }), node({ name: '#1631', financial: 'PENDING', photos: [PHOTO] })]),
      materialize,
      runPipelineFn: spyPipeline({ 1630: ORDER_STATUS.DONE, 1631: ORDER_STATUS.DONE }),
    });
    assert.deepEqual([...materialize.calls].sort(), ['1630', '1631'], 'both the paid and the unpaid order are materialized');
    assert.equal(r.report.paidPhotoSeen, 2, 'the run-pool includes the unpaid order');
    assert.equal(r.report.nonPaidPhotoSeen, 1, 'the unpaid order is still surfaced as not-yet-paid');
    assert.equal(r.report.counts.ready, 2, 'both books built');
  } finally {
    cleanup();
  }
});

test('the night report is written to the fixed data-dir path and carries count + estimated spend', async () => {
  const { dataDir, inbox, cleanup } = dirs();
  try {
    const r = await runAutopilot({
      config: makeConfig(dataDir, inbox),
      now: NOW,
      createClient: clientWith([node({ name: '#1620', photos: [PHOTO] }), node({ name: '#1621', photos: [PHOTO] })]),
      materialize: spyMaterialize(),
      runPipelineFn: spyPipeline({ 1620: ORDER_STATUS.DONE, 1621: ORDER_STATUS.DONE }),
    });
    assert.equal(r.reportPath, reportPath(dataDir));
    const report = JSON.parse(readFileSync(reportPath(dataDir), 'utf8'));
    assert.equal(report.processed, 2);
    assert.equal(report.estSpend, 1, '2 generated × $0.50');
    assert.equal(report.ranAt, NOW());
    assert.ok(report.window.from < report.window.to, 'the run window is a real interval');
  } finally {
    cleanup();
  }
});

test('the no-send invariant is structural — autopilot imports no delivery/WhatsApp/Proton path', () => {
  const src = readFileSync(new URL('../src/autopilot.js', import.meta.url), 'utf8');
  const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));
  for (const forbidden of ['whatsapp', 'proton', 'delivery', 'markdelivered', 'bridge']) {
    assert.ok(
      !importLines.some((l) => l.toLowerCase().includes(forbidden)),
      `autopilot must not import a "${forbidden}" module — no send path may exist in this scope`,
    );
  }
});

// --- one purchase, several books ---------------------------------------------------------------

/** An order node holding two books: the same product added twice, a photo set uploaded to each. */
function twoBookNode(name, { updatedAt = '2026-07-12T01:00:00Z' } = {}) {
  const book = (prefix) => ({
    node: {
      title: 'Fotomalovánky',
      variantTitle: '🖨️ Tištěné omalovánky / 2',
      quantity: 1,
      customAttributes: [
        { key: 'Fotka (2)-1', value: `https://cdn.tigren.com/media/${prefix}1.jpg` },
        { key: 'Fotka (2)-2', value: `https://cdn.tigren.com/media/${prefix}2.jpg` },
        { key: 'Věnování', value: `Pro ${prefix}` },
      ],
    },
  });
  return { name, email: 'a@b.cz', updatedAt, displayFinancialStatus: 'PAID', lineItems: { edges: [book('a'), book('b')] } };
}

test('a two-book purchase materializes as two jobs, each with its own folder', async () => {
  const { dataDir, inbox, cleanup } = dirs();
  try {
    const materialize = spyMaterialize();
    await runAutopilot({
      config: makeConfig(dataDir, inbox),
      now: NOW,
      createClient: clientWith([twoBookNode('#1700')]),
      materialize,
      runPipelineFn: spyPipeline({}),
    });
    assert.deepEqual(materialize.calls, ['1700-1', '1700-2'], 'one node yields two jobs — the poll flat-maps rather than maps');
  } finally {
    cleanup();
  }
});

test('the two books of one purchase are handled independently, not as one entry', async () => {
  const { dataDir, inbox, cleanup } = dirs();
  try {
    await runAutopilot({
      config: makeConfig(dataDir, inbox),
      now: NOW,
      createClient: clientWith([twoBookNode('#1700')]),
      materialize: spyMaterialize(),
      runPipelineFn: spyPipeline({ '1700-1': ORDER_STATUS.DONE, '1700-2': ORDER_STATUS.HELD }),
    });
    const state = loadState(dataDir);
    assert.ok(isHandled(state, '1700-1'), 'the finished book is terminal');
    assert.equal(isHandled(state, '1700-2'), false, 'its held sibling stays re-pollable on its own');
  } finally {
    cleanup();
  }
});

test('a purchase completed before books were split is not re-run under its new suffixed ids', async () => {
  const { dataDir, inbox, cleanup } = dirs();
  try {
    // What the handled map looks like on the machine this change deploys to: the purchase finished
    // as ONE merged job, recorded under its bare order number.
    const seeded = loadState(dataDir);
    markHandled(seeded, '1700', { status: 'ready', at: 'before the split shipped' });
    saveState(dataDir, seeded);

    const materialize = spyMaterialize();
    const pipeline = spyPipeline({});
    await runAutopilot({
      config: makeConfig(dataDir, inbox),
      now: NOW,
      createClient: clientWith([twoBookNode('#1700')]),
      materialize,
      runPipelineFn: pipeline,
    });
    assert.deepEqual(materialize.calls, [], 'nothing is re-materialized');
    assert.deepEqual(pipeline.calls, [], 'and nothing is regenerated — the book may already be printed and packed');
  } finally {
    cleanup();
  }
});

test('an unhandled purchase still processes both books — the cutover guard is not a blanket skip', async () => {
  const { dataDir, inbox, cleanup } = dirs();
  try {
    const materialize = spyMaterialize();
    await runAutopilot({
      config: makeConfig(dataDir, inbox),
      now: NOW,
      createClient: clientWith([twoBookNode('#1701')]),
      materialize,
      runPipelineFn: spyPipeline({}),
    });
    assert.deepEqual(materialize.calls, ['1701-1', '1701-2']);
  } finally {
    cleanup();
  }
});
