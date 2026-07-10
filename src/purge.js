// Delete the customer photographs of books finished long ago.
//
//   npm run purge                 what it would delete, and nothing else
//   npm run purge -- --yes        actually delete them
//   npm run purge -- --days 60    override config.json's retentionDays
//
// A dry run by default. Everything else in this tool can be done again; this cannot.

import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { purgeOriginals, purgeWarning } from './retention.js';

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
      lines.push(`  ${o.orderId}  ${String(o.photos.length).padStart(3)} photo(s)  ${mb(o.bytes).padStart(9)}  printed ${o.ageDays} days ago`);
    }
    lines.push('');
    lines.push(`  ${result.photos} photograph(s), ${mb(result.bytes)}.`);
  } else {
    lines.push(`Nothing to delete: no finished book is older than ${result.days} days.`);
  }

  if (result.skipped.length) {
    lines.push('');
    lines.push('Left alone:');
    for (const o of result.skipped) lines.push(`  ${o.orderId}  ${o.skip}`);
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
  const result = purgeOriginals({
    outboxRoot: config.paths.outbox,
    days: days ?? config.retentionDays,
    dryRun: !yes,
  });
  console.log(`\n${report(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  });
}
