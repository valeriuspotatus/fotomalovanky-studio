// The overnight report: what a scheduled run detected, generated, held and failed, written to a single
// fixed path under the outside-repo data dir so the morning dashboard can read it (U5). It carries
// aggregate counts, per-order status, the run window and an estimated spend — never the token, and no
// customer email/name beyond the order number, so it is safe for the dashboard to surface.
//
// Kept in its own tiny module (not autopilot.js) so studio.js can read the report without importing
// the whole runner and its Shopify/network dependencies.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPORT_FILE = 'overnight-report.json';

/** The single fixed report path under the data dir. */
export const reportPath = (dataDir) => join(dataDir, REPORT_FILE);

/** Write the night report, creating the (outside-repo) data dir if needed. */
export function writeReport(dataDir, report) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(reportPath(dataDir), JSON.stringify(report, null, 2));
}

/** Read the night report, or null when there is none (a manual-only day / fresh install) or it is
 *  unreadable. Never throws — a missing report just means "no overnight rollup to show". */
export function readReport(dataDir) {
  if (!dataDir) return null;
  const path = reportPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
