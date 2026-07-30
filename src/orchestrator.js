import { existsSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { ingestOrders } from './ingest.js';
import { generateOrder, describeFailure } from './batch.js';
import { assessIntake, intakeSummary } from './intake.js';
import { renderEmail } from './emailDrafts.js';
import { createGeneratorDriver } from './generator/factory.js';
import { BuilderDriver, collectPairs } from './builder/builderDriver.js';
import { photoBase } from './organize.js';
import {
  STATES,
  getStatus,
  getDedication,
  hasDedication,
  setDedication,
  readManifest,
  writeManifest,
  setIntake,
  getIntake,
  clearIntake,
  getIntakeOverride,
  isBuilderEligible,
  manifestPath,
} from './manifest.js';
import { deriveDedication, deriveSlug } from './dedication.js';
import { shopDedication, readOrderInfo, resolveFormat } from './orderInfo.js';
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

/** Per-order outcome. `held` means the operator has photos to review — not a failure. `ready` means
 *  all pages generated cleanly but the PDF was deliberately not built yet (a generate-only "Go" run) —
 *  the operator checks the pages, then presses "PDF" to build. */
export const ORDER_STATUS = Object.freeze({ DONE: 'done', HELD: 'held', FAILED: 'failed', READY: 'ready' });

/** Where an order's finished book lands — the tool's existing output name. Exported so the status
 *  board (src/studio.js) tells a built order from an unbuilt one by the same path the build wrote. */
export const pdfPathFor = (orderDir, orderId) => join(orderDir, `${orderId} Final.pdf`);

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
    return `${missing.length} fotek nemá spárovanou omalovánku: ${missing.join(', ')}`;
  }
  const extra = [...have].filter((b) => !bases.includes(b));
  if (extra.length) {
    const shown = extra.slice(0, 3).join(', ') + (extra.length > 3 ? ', …' : '');
    return `the order folder holds ${extra.length} pair(s) that are not part of this order (${shown}) — they would be printed into the book`;
  }
  return null;
}

async function buildOrder({ orderId, orderDir, bases, dedication, mode, builder, config, force, onEvent }) {
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
    // The per-order format (U9) beats the global builder mode: two orders in one burst can be
    // galerie and full-page, and neither should need a config edit between them.
    if (mode) options.mode = mode;
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

// ---- intake (input QC) gate ------------------------------------------------

/** The photo count the product includes, from the shop's own record. Null until a newer extension
 *  writes it — at which point the count check is advisory, never a hold on a guess. */
function resolveExpected(order) {
  return (order.dir ? readOrderInfo(order.dir) : null)?.expectedPhotos ?? null;
}

/** The copy-paste email for a held order, or null when the hold has no email case. Reads the
 *  customer from the shop record for the greeting and address; both are optional.
 *
 *  The order number in the email is the customer's, not ours. A book of a multi-book purchase is
 *  "1234-2" internally, but the customer's receipt says 1234 and always will — quoting the suffix
 *  at them would be quoting an id they have never seen. */
function draftEmailFor(result, order) {
  if (!result.emailCase) return null;
  const info = (order.dir && readOrderInfo(order.dir)) || {};
  return renderEmail(result.emailCase, {
    order: info.purchase?.orderId ?? order.orderId,
    surname: info.customer?.surname ?? '',
    email: info.customer?.email ?? '',
    expected: result.expected,
    uploaded: result.uploaded,
    missing: result.expected != null ? Math.max(0, result.expected - result.unique) : null,
    photos: problemPhotos(result),
  });
}

/** The photo(s) a held order's email is about, for the templates that name a file. */
function problemPhotos(result) {
  const bases = new Set();
  for (const f of result.findings) {
    if (f.verdict !== 'hold') continue;
    if (f.base) bases.add(f.base);
    if (f.bases) for (const b of f.bases) bases.add(b);
  }
  return [...bases].join(', ');
}

/** The draft as it lands on disk: a copy-paste block, recipient and subject included. */
function formatDraft(mail) {
  const to = mail.to ? `Komu: ${mail.to}\n` : '';
  return `${to}Předmět: ${mail.subject}\n\n${mail.body}\n`;
}

/** Run every order end to end. Never throws for a single order; returns a report.
 *
 *  `signal` is how the operator's Stop button reaches the loop. Stopping is cooperative and lands
 *  at an order or photo boundary: whatever is on the GPU finishes, then nothing new begins. Books
 *  already built stay built; an order left half-generated simply has pending photos, and the next
 *  Go continues it. */
export async function runPipeline({ config, inboxRoot, outboxRoot, generator, builder, qc, intake = assessIntake, onEvent = noop, force = false, only = null, buildPdfs = true, memoryRoot = MEMORY_DIR, signal }) {
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
  let stopped = false;
  for (const order of orders) {
    // The operator pressed Stop. Do not begin another order — the ones already done are the run.
    if (signal?.aborted) {
      stopped = true;
      break;
    }
    const { orderId } = order;
    onEvent({ type: 'order-start', orderId, dirName: order.dirName, photos: order.photos.length });

    // Input QC before any GPU spend. A blocking problem — too few photos, a duplicate upload, a
    // file that will not open — holds the whole order and drafts a copy-paste email; nothing is
    // generated until the photos are put right. The verdict is re-derived here every run, so once
    // the customer sends a replacement the hold lifts on its own. `force` and an operator override
    // ("generate it anyway") clear it too.
    const intakeDir = join(outbox, orderId);
    const overridden = getIntakeOverride(readManifest(intakeDir));
    const intakeResult = await intake({ order, config, expected: resolveExpected(order) });
    onEvent({ type: 'intake', orderId, verdict: intakeResult.verdict, findings: intakeResult.findings, expected: intakeResult.expected, uploaded: intakeResult.uploaded });

    if (intakeResult.verdict === 'hold' && !overridden && !force) {
      mkdirSync(intakeDir, { recursive: true });
      const m = readManifest(intakeDir);
      setIntake(m, { ...intakeResult, checkedAt: new Date().toISOString(), override: false });
      writeManifest(intakeDir, m);
      const mail = draftEmailFor(intakeResult, order);
      if (mail) writeFileSync(join(intakeDir, 'draft-email.txt'), formatDraft(mail), 'utf8');
      const reason = `${intakeSummary(intakeResult)}${mail ? ' (e-mail připraven)' : ''}`;
      report.push({ orderId, orderDir: intakeDir, summary: null, held: [], failed: [], pdfPath: null, reason, status: ORDER_STATUS.HELD, titled: false });
      onEvent({ type: 'order-done', orderId, status: ORDER_STATUS.HELD, pdfPath: null, reason });
      continue;
    }

    // The hold lifted on its own: the customer's replacement made intake pass. Clear the stale
    // hold verdict and its draft email so a now-buildable order stops surfacing as held — both in
    // the review grid and on the status board. Guarded so a clean order with no stored block is
    // never rewritten (its state.json mtime is the PDF-cache clock; a needless bump reprints it).
    // An overridden/forced order whose intake still fails keeps its block: the override flag, not a
    // cleared verdict, is what releases that one.
    if (intakeResult.verdict !== 'hold' && existsSync(intakeDir)) {
      const m = readManifest(intakeDir);
      if (getIntake(m)) {
        clearIntake(m);
        writeManifest(intakeDir, m);
      }
      rmSync(join(intakeDir, 'draft-email.txt'), { force: true });
    }

    gen ??= createGeneratorDriver(config);
    const { orderDir, manifest, summary } = await generateOrder({
      config,
      order,
      outboxRoot: outbox,
      driver: gen,
      qc,
      onEvent,
      signal,
    });

    const bases = order.photos.map(photoBase);
    const notEligible = bases.filter((b) => !isBuilderEligible(getStatus(manifest, b)));
    const failed = notEligible.filter((b) => getStatus(manifest, b) === STATES.FAILED);
    const held = notEligible.filter((b) => getStatus(manifest, b) !== STATES.FAILED);

    let entry = { orderId, orderDir, summary, held, failed, pdfPath: null, reason: null, status: null, titled: false };

    // The customer's own words. Recover them once, for an order nobody has decided the title of
    // yet — never over an operator who has already answered, including one who answered by
    // emptying the box.
    if (!hasDedication(manifest)) {
      // Three places the words can come from, best first:
      //   the shop      — what the customer typed, accents and all, straight out of Shopify
      //   the memory    — a spelling the operator corrected once, on an earlier order
      //   the file name — the last resort, and the only one that cannot spell "Jiříčka"
      const fromShop = shopDedication(order.dir);
      const remembered = fromShop ? '' : recallDedication(memoryRoot, deriveSlug(bases));
      const derived = fromShop || remembered || deriveDedication(bases);
      if (derived) {
        setDedication(manifest, derived);
        writeManifest(orderDir, manifest);
        onEvent({ type: 'title-derived', orderId, dedication: derived, source: fromShop ? 'shop' : remembered ? 'memory' : 'filename' });
      }
    }

    const dedication = getDedication(manifest);
    const titleText = titleTextFor(config, dedication);

    if (failed.length) {
      entry.status = ORDER_STATUS.FAILED;
      entry.reason = `${failed.length} fotek se nepodařilo vygenerovat: ${failed.map((b) => `${b} — ${manifest.photos[b].reason}`).join('; ')}`;
    } else {
      if (held.length) {
        entry.status = ORDER_STATUS.HELD;
        entry.reason = `${held.length} fotek čeká na vaši kontrolu`;
      } else if (!buildPdfs) {
        // Generate-only run (the operator's "Go"): every page generated cleanly, but hold off on the
        // PDF so the operator can eyeball the pages first, then press "PDF" to build. No Chromium is
        // touched on this path. A later build run finds the pages already generated (idempotent) and
        // only builds.
        entry.status = ORDER_STATUS.READY;
        entry.reason = 'vygenerováno — zkontrolujte stránky a stiskněte PDF';
        entry.titled = Boolean(titleText);
      } else {
        // Plenty of customers write nothing. Their book is the same book with an empty title
        // line, so it prints rather than waiting for an operator to invent words for them.
        // Said out loud all the same: a dedication that was meant to be there and one that was
        // never written look identical once the PDF exists.
        if (!titleText) onEvent({ type: 'no-title', orderId });
        build ??= new BuilderDriver(config);
        // The format the shop sold this order in. When the product/variant isn't in the map it
        // falls back to the config default and is flagged — surfaced here, never blocking.
        const { mode, mapped } = resolveFormat(order.dir ? readOrderInfo(order.dir) : null, config);
        onEvent({ type: 'order-format', orderId, mode, mapped });
        const result = await buildOrder({ orderId, orderDir, bases, dedication, mode, builder: build, config, force, onEvent });
        entry = { ...entry, ...result, titled: Boolean(titleText) };
      }
    }

    onEvent({ type: 'order-done', orderId, status: entry.status, pdfPath: entry.pdfPath, reason: entry.reason });
    report.push(entry);
  }

  // The signal can trip during the last order too, where the top-of-loop check never runs again.
  stopped = stopped || Boolean(signal?.aborted);

  const counts = {
    done: report.filter((o) => o.status === ORDER_STATUS.DONE).length,
    ready: report.filter((o) => o.status === ORDER_STATUS.READY).length,
    held: report.filter((o) => o.status === ORDER_STATUS.HELD).length,
    failed: report.filter((o) => o.status === ORDER_STATUS.FAILED).length,
  };
  if (stopped) onEvent({ type: 'run-stopped', counts, ran: report.length, total: orders.length });
  onEvent({ type: 'run-done', counts });
  return { inbox, outbox, orders: report, counts, stopped };
}

// ---- progress rendering ----------------------------------------------------

/** One run event as a line the operator can read. Returns null for events with nothing to say.
 *  Shared by the CLI and the review grid's run log, so both describe a run identically. */
export function formatEvent(e) {
  switch (e.type) {
    case 'run-start':
      return `${e.orders} objednávek ve složce ${e.inbox}${e.skipped ? ` (${e.skipped} dalších jste nezaškrtli)` : ''}`;
    case 'order-start': {
      const from = e.dirName && e.dirName !== e.orderId ? ` (z názvů fotek; složka je „${e.dirName}“)` : '';
      return `\nobjednávka ${e.orderId} — ${e.photos} fotek${from}`;
    }
    case 'intake': {
      if (e.verdict === 'ok') return null; // a clean order says nothing; the photos speak next
      const where = e.expected != null ? ` — ${e.uploaded} z ${e.expected} fotek` : '';
      const n = e.findings?.length ?? 0;
      return `  vstupní kontrola: ${e.verdict}${where} (${n} ${n === 1 ? 'poznámka' : 'poznámek'})`;
    }
    case 'photo-start': return `  ${e.base}${e.redo ? ' (znovu)' : ''}…`;
    case 'progress': return `    [${e.step}] ${e.message}`;
    case 'photo-ok': return `  ${e.base}: ok`;
    case 'photo-flagged': return `  ${e.base}: OZNAČENO (${e.reason}) — ke kontrole`;
    case 'photo-failed': return `  ${e.base}: SELHALO — ${e.reason}`;
    case 'photo-skipped': return `  ${e.base}: přeskočeno (${e.status})`;
    case 'memory-moved': return `Přesunuto ${e.count} uložených jmen ze složky outbox do složky nástroje.`;
    case 'title-derived': {
      const from = { shop: 'jak to napsal zákazník', memory: 'pravopis, který jste uložili', filename: 'z názvů fotek' }[e.source] ?? 'z názvů fotek';
      return `  titulní strana (${from}): ${e.dedication}`;
    }
    case 'no-title': return '  v názvech fotek není věnování — titulní strana se vytiskne bez textu';
    case 'order-format': {
      const label = e.mode === 'fullpage' ? 'celostránkové' : 'galerie';
      return `  formát: ${label}${e.mapped ? '' : ' (výchozí — produkt není ve formátové mapě)'}`;
    }
    case 'build-start': return `  stavím PDF z ${e.photos} fotek…`;
    case 'build-done': return `  PDF: ${e.pdfPath} (${e.pairs} párů)`;
    case 'build-skipped': return `  PDF už je aktuální: ${e.pdfPath}`;
    case 'build-failed': return `  STAVBA PDF SELHALA — ${e.reason}`;
    case 'run-stopped':
      return `\nZastaveno — ${e.ran} z ${e.total} objednávek hotovo. Zbytek zůstal nedotčený; pokračujte stiskem Spustit.`;
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
    if (o.status === ORDER_STATUS.DONE) console.log(`  ${id}  hotovo  ${o.pdfPath}${o.titled ? '' : '  (bez věnování)'}`);
    else if (o.status === ORDER_STATUS.READY) console.log(`  ${id}  připr.  ${o.reason}`);
    else if (o.status === ORDER_STATUS.HELD) console.log(`  ${id}  drženo  ${o.reason}`);
    else console.log(`  ${id}  SELHALO ${o.reason}`);
  }
  console.log(`\n${counts.done} hotovo, ${counts.ready} k sestavení, ${counts.held} čeká na vás, ${counts.failed} selhalo.`);
  if (counts.held) console.log('Zkontrolujte je:  npm run review -- <inbox>     a pak spusťte znovu.');
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
