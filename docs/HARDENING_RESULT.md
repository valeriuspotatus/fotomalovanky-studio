# Hardening result

Evidence-based closure for Prompt 2 through commit `b81ee8d`, relative to baseline `626c49b`. Phases 0–8 were materially completed. Phase 9 was audited/documented; Phases 10–16 remain mostly future work except Phase 14 recovery documentation and Phase 15 metrics groundwork.

## 1. What changed

- Added append-only generation-attempt and attempt-specific human-decision history.
- Added four-window manifest-derived metrics and a small operator summary.
- Made Shopify materialization stage, validate, and promote an exact source revision while preserving the last valid folder on failure.
- Added meaningful-source fingerprints and conservative changed-completed-order handling.
- Added bounded classified retries to Shopify Admin, Gemini image operations, and SMTP; the concurrency audit found no unbounded external API fan-out requiring a limiter.
- Documented current security scope, remaining risks, recovery boundaries, and restore procedure.

## 2. Files changed

Committed runtime files since `626c49b`: `src/autopilot.js`, `src/autopilotState.js`, `src/batch.js`, `src/creatives/aiImage.js`, `src/generationMetrics.js`, `src/manifest.js`, `src/proton/smtpClient.js`, `src/review.js`, `src/shopify/adminClient.js`, `src/shopify/materialize.js`, `src/shopify/orders.js`, `src/ui/server.js`, `src/ui/static/dashboard.html`, and `src/ui/static/index.html`.

Committed tests: `test/accounts.test.js`, `test/aiImage.test.js`, `test/autopilot.test.js`, `test/autopilotState.test.js`, `test/batch.test.js`, `test/generationMetrics.test.js`, `test/generationMetricsHttp.test.js`, `test/manifest.test.js`, `test/materialize.test.js`, `test/proton.test.js`, `test/review.test.js`, `test/reviewServer.test.js`, and `test/shopifyAdminClient.test.js`. Committed docs: `docs/TELEMETRY.md` and `docs/SHOPIFY_MATERIALIZATION.md`. Closure docs: `docs/RECOVERY.md`, `docs/SECURITY.md`, `docs/HARDENING_ROADMAP.md`, and this file.

## 3. Tests added

Coverage now includes manifest compatibility; multiple/failing/successful attempts; secret-safe telemetry; attempt-specific rejection/acceptance and generic redo; metrics calculations, HTTP access, and legacy/no-data semantics; exact/fewer/changed Shopify photo sets; failed download/conversion preservation and cleanup; source fingerprints and handled dispositions; and deterministic transient/permanent retry behavior for Admin, Gemini, and SMTP. Existing account/review HTTP expectations were updated for new operator data shapes.

## 4. Bugs fixed

- Failed or superseded generation history no longer disappears on redo.
- Human decisions remain attached to the judged attempt.
- Legacy manifests are not guessed to be first-pass metric successes.
- Re-materializing fewer/changed photos does not leave stale uploads active.
- Failed replacement materialization does not expose partial data or destroy the prior valid folder.
- Meaningfully changed completed orders are not silently overwritten by autopilot.
- Selected transient adapter failures retry boundedly; known permanent failures fail fast.

## 5. Reliability improvements

Durable histories, metrics, transactional materialization, revision identity, and deliberate adapter retries improve explainability and safe reruns while preserving builder eligibility, explicit review/release, per-order isolation, and visible failure.

Reliability remains incomplete: critical JSON still has direct overwrites, locks are process-local, corrupt autopilot state falls back to empty, and the full failure-injection matrix is unfinished.

## 6. Security improvements

Materialization now validates ID/path containment, and attempt telemetry/metrics expose allowlisted operational fields rather than secrets, customer content, URLs, or paths. Existing hosted-auth fail-closed behavior, route roles, redaction, photo-host allowlisting, retention gates, and persistent-directory checks remain.

Phase 9 was otherwise audit/documentation. Buffered `safeFetch`, DNS rebinding exposure, incomplete IPv6/symlink defenses, direct JSON writes, and process-local locks remain. See [SECURITY.md](SECURITY.md).

## 7. Telemetry added

Generator invocation records include ID/ordinal, timing, initial/redo kind, safe settings, result/failure, automatic QC, human decisions, and ceiling state. Operator aggregates cover photos, attempts, acceptance/redo distribution, failures, human/automatic QC rates, durations, ceiling hits, and rejection reasons for today, 7 days, 30 days, and all data. Legacy/no-data is distinct from zero.

## 8. New operator behavior

One-click rejection reasons persist and immediately start redo; generic redo remains as `unspecified`. The dashboard shows a minimal 30-day generation summary. Autopilot surfaces a changed completed source revision for manual review. No automatic release, semantic-QA decision, delivery, or smart regeneration was introduced.

## 9. Backwards compatibility

Old manifests without `generationAttempts` remain readable; the `attempt` compatibility view remains. Old generic redo works. Pre-fingerprint handled entries remain conservatively handled. State vocabulary, review actions, dedication behavior, builder gate, and file-backed architecture remain. Metrics exclude legacy evidence gaps instead of inventing outcomes.

## 10. Remaining risks

- Crash-torn direct JSON writes and cross-process races.
- Corrupt autopilot state appearing as an empty first run.
- Buffered photo downloads and DNS check/use separation.
- Incomplete IPv6 routability and symlink/reparse-point defenses.
- No stable structured output-QA contract or semantic shadow QA.
- Incomplete disk/interruption/lock/delivery failure injection.
- Recovery is documented but not rehearsed on production-like data.
- Insufficient real production metrics to justify further automation.

## 11. P0/P1/P2 future work

- **P0:** atomic/durable critical JSON writes; inter-process locks with owner/age and stale policy; visible corrupt handled-state reconciliation.
- **P1:** streaming `safeFetch` and DNS-to-connection binding; structured technical output QA; semantic comparison in shadow mode only; fuller failure injection; recovery rehearsal.
- **P2:** supported/evidence-based smart regeneration; versioned estimated cost observability; exception-first operator workflow; remaining retry/concurrency telemetry.

See [HARDENING_ROADMAP.md](HARDENING_ROADMAP.md) for ranking and prerequisites.

## 12. Metrics that require real production data before further automation

Collect first-pass acceptance, redo distribution, rejection-reason and `unspecified` coverage, provider failure/retry distributions, duration by generator settings, ceiling/manual-repair rates, automatic-QC versus human outcomes, and future shadow-QA false-pass/false-reject matrices. Smart regeneration needs outcome comparison by supported corrective control. Cost estimates need provider/model usage and time-versioned price inputs.

No current metric proves auto-approval, auto-release, semantic blocking, or reason-specific regeneration is safe.

## 13. Exact full test result

Latest full `npm test` result supplied for this hardening run: **931 tests, 928 pass, 0 fail, 3 skipped, duration 35708.4264ms**.

## 14. Recommended next production validation steps

1. Deploy with the human gate and release behavior unchanged.
2. Verify persistent paths, ACLs, HTTPS/auth, redaction, and narrow photo-host allowlists.
3. Monitor a small set containing first-pass success, reasoned/generic redo, transient adapter failure, and a changed completed order.
4. Confirm histories, metrics, exact active file sets, PDF freshness, and visible failures.
5. Rehearse [RECOVERY.md](RECOVERY.md) on a sanitized isolated loopback-only target with delivery disabled.
6. Implement P0 durability/locking before semantic automation or broader unattended work.
7. Establish production and human-label baselines before shadow QA, smart regeneration, cost estimates, or exception ranking.
