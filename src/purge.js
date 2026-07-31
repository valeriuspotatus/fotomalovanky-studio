// Delete the customer photographs of books dispatched long ago.
//
//   npm run purge                 what it would delete, and nothing else
//   npm run purge -- --yes        actually delete them
//   npm run purge -- --days 60    override config.json's retentionDays
//
// A dry run by default. Everything else in this tool can be done again; this cannot.
//
// One run deletes at most PURGE_BATCH_CAP orders (retention.js) and says what it left for the next
// one — the first run on a box that has never purged would otherwise offer the whole outbox at
// once. The same report also lists orders printed but never dispatched, which never become eligible
// on their own and need somebody to decide what happened to them.

import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { purgeOriginals, purgeAutopilotData, purgeWarning } from './retention.js';

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function parseArgs(argv) {
  const yes = argv.includes('--yes');
  const at = argv.indexOf('--days');
  const days = at >= 0 ? Number(argv[at + 1]) : null;
  if (at >= 0 && (!Number.isInteger(days) || days <= 0)) throw new Error('--days needs a positive whole number of days.');
  return { yes, days };
}

export function report(result) {
  const lines = [];
  if (result.orders.length) {
    lines.push(result.dryRun ? `Would delete the photographs of ${result.orders.length} order(s):` : `Deleted the photographs of ${result.orders.length} order(s):`);
    for (const o of result.orders) {
      // "dispatched", not "printed": the gate moved to the dispatch marker (R18), and a report that
      // still said "printed N days ago" would name a different date from the one it acted on.
      const origin = o.backfilled ? '  (backfilled — printed before the lifecycle change)' : '';
      lines.push(`  ${o.orderId}  ${String(o.photos.length).padStart(3)} photo(s)  ${mb(o.bytes).padStart(9)}  dispatched ${o.ageDays} days ago${origin}`);
    }
    lines.push('');
    lines.push(`  ${result.photos} photograph(s), ${mb(result.bytes)}.`);
  } else {
    lines.push(`Nothing to delete: no dispatched book is older than ${result.days} days.`);
  }

  // Where the eligibility came from. A first run on a box that has never purged is almost entirely
  // backfilled — historical, not a bug — and the operator should be able to see that at a glance
  // before confirming a large batch.
  const e = result.eligibility;
  if (e && e.total) {
    lines.push('');
    lines.push(`  Eligible: ${e.total} — ${e.dispatched} dispatched by hand, ${e.backfilled} backfilled from an old print.`);
  }

  // The cap. Anything past it is untouched this run and comes up again on the next one.
  if (result.deferred?.length) {
    lines.push('');
    lines.push(`Left for the next run (a single run deletes at most ${result.cap}): ${result.deferred.length} order(s).`);
    lines.push(`  ${result.deferred.map((o) => o.orderId).join(', ')}`);
  }

  // Printed and never dispatched. Never deleted by anything here — they need a human decision.
  if (result.stalled?.length) {
    lines.push('');
    lines.push('Printed but never dispatched — these will never age out on their own:');
    for (const o of result.stalled) lines.push(`  ${o.orderId}  printed ${o.stalledDays} days ago, no dispatch marker`);
  }

  // The stalled orders are skipped too; they are listed above with their age, so they are not
  // repeated here.
  const skipped = result.skipped.filter((o) => o.stalledDays == null);
  if (skipped.length) {
    lines.push('');
    lines.push('Left alone:');
    for (const o of skipped) lines.push(`  ${o.orderId}  ${o.skip}`);
  }

  lines.push('');
  lines.push(purgeWarning);
  if (result.dryRun && result.orders.length) {
    lines.push('');
    lines.push('Nothing has been deleted. Run it again with --yes to go ahead.');
  }
  return lines.join('\n');
}

async function main(argv) {
  const { yes, days } = parseArgs(argv);
  const config = loadConfig();
  const keepDays = days ?? config.retentionDays;
  const result = purgeOriginals({ outboxRoot: config.paths.outbox, days: keepDays, dryRun: !yes });
  console.log(`\n${report(result)}\n`);

  // The overnight report + state hold order data on the same clock; clear them once autopilot has
  // been dormant `retentionDays` (never mid-operation — both files are rewritten on every run).
  const auto = purgeAutopilotData({ dataDir: config.shopify?.dataDir, days: keepDays, dryRun: !yes });
  if (auto.removed.length) {
    const verb = auto.dryRun ? 'Would clear' : 'Cleared';
    console.log(`${verb} ${auto.removed.length} stale autopilot file(s) (older than ${keepDays} days): ${auto.removed.map((f) => f.name).join(', ')}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  });
}
