// CLI wrapper for the attribution backfill. The logic lives in src/backfillAttribution.js because
// the deployed studio has no shell to run this in — the dashboard drives the same function through
// an operator-only route.
//
//   node tools/backfillAttribution.mjs           # say what would change, touch nothing
//   node tools/backfillAttribution.mjs --write   # do it

import { loadConfig } from '../src/config.js';
import { createAdminClient } from '../src/shopify/adminClient.js';
import { backfillAttribution } from '../src/backfillAttribution.js';

const write = process.argv.includes('--write');
const config = loadConfig();

if (!config.shopify?.enabled || !config.shopify?.accessToken) {
  console.error('Shopify is not configured — nothing to look orders up against.');
  process.exit(2);
}

const counts = await backfillAttribution({
  config,
  client: createAdminClient(config.shopify),
  write,
  onLine: (line) => console.log('  ' + line),
});

console.log(
  `\n${write ? 'Patched' : 'Would patch'} ${counts.patched} folder(s). ` +
    `${counts.already} already had it, ${counts.unresolved} not found in Shopify, ` +
    `${counts.failed} lookup(s) failed, ${counts.unreadable} unreadable.` +
    (write ? '' : '\nRe-run with --write to apply.'),
);
