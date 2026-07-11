// ============================================================================
// Fotomalovánky Content Studio v1 - Blog Creation System
// Barrel exports + a small local demo runner.
// ----------------------------------------------------------------------------
// This module wires nothing to the internet. No Shopify API, no credentials,
// no publishing. Everything is local and produces draft text for manual paste.
// ============================================================================

export * from './blog-types';
export * from './fotomalovanky-brand';
export * from './blog-constants';
export * from './calendar-events';
export * from './blog-prompts';
export * from './blog-quality-checker';
export * from './example-inputs';

import { buildBrainstormBlogPrompt, buildGenerateBlogPrompt } from './blog-prompts';
import { getRelevantEvents, recommendBlogIdeasForEvent } from './calendar-events';
import { runQualityChecks, summarizeWarnings } from './blog-quality-checker';
import {
  EXAMPLE_BRAINSTORM_INPUT,
  EXAMPLE_GENERATE_INPUT,
  EXAMPLE_SOURCE_MATERIAL,
} from './example-inputs';
import type { BlogPackage } from './blog-types';

/**
 * Local demo. Prints:
 *  1. Events relevant to a given date (event-relevance logic).
 *  2. Seed ideas for Den matek.
 *  3. The brainstorm prompt (paste into your LLM).
 *  4. The generate prompt (paste into your LLM).
 *
 * It does NOT call any model or network. Run with ts-node / tsx if you like:
 *   npx tsx src/index.ts
 */
export function demo(referenceDate: string = '2026-04-20'): void {
  /* eslint-disable no-console */
  console.log('=== Relevantní události k', referenceDate, '(okno 45 dní) ===');
  for (const r of getRelevantEvents(referenceDate, 45)) {
    console.log(`${r.event.emoji} ${r.event.name} - za ${r.daysUntil} dní`
      + (r.withinLeadTime ? ' [čas publikovat]' : ''));
  }

  console.log('\n=== Seed nápady pro Den matek ===');
  for (const idea of recommendBlogIdeasForEvent('den-matek', EXAMPLE_SOURCE_MATERIAL)) {
    console.log(`- ${idea.title} [kw: ${idea.targetKeyword}]`);
  }

  console.log('\n=== BRAINSTORM PROMPT (zkopíruj do LLM) ===\n');
  console.log(buildBrainstormBlogPrompt(EXAMPLE_BRAINSTORM_INPUT));

  console.log('\n=== GENERATE PROMPT (zkopíruj do LLM) ===\n');
  console.log(buildGenerateBlogPrompt(EXAMPLE_GENERATE_INPUT));
  /* eslint-enable no-console */
}

/**
 * Validate a BlogPackage you got back from the LLM (paste it in as an object).
 * Returns the warnings plus a pass/fail gate (fails if any "block" severity).
 */
export function validateBlogPackage(pkg: BlogPackage, source = EXAMPLE_SOURCE_MATERIAL) {
  const warnings = runQualityChecks(pkg, source);
  return { warnings, ...summarizeWarnings(warnings) };
}

// Note: this file is a pure barrel + helpers with no side effects on import.
// The runnable entry point is `src/demo.ts` (npm run demo).
