# Hardening roadmap

This roadmap records what the Prompt 2 run actually established and what remains. It is not a claim that every phase is complete. See [the audit baseline](AUDIT_BASELINE.md), [telemetry details](TELEMETRY.md), [security scope](SECURITY.md), and [recovery procedure](RECOVERY.md).

## Delivered foundations

Phases 0–8 were materially completed:

- **Phase 0 — audit:** `AUDIT_BASELINE.md` reconstructs the architecture, state, lifecycle, invariants, external seams, security boundaries, test coverage, and risks.
- **Phases 1–3 — generation and human-decision history:** `state.json` supports append-only `generationAttempts`, failed and successful invocation records, attempt-specific rejection reasons, acceptance history, manual-repair context, and ceiling annotations. Legacy manifests and the compatibility `attempt` view still work.
- **Phase 4 — metrics:** manifests feed operator-only generation metrics for today, 7 days, 30 days, and all available telemetry. Legacy/no-data is distinct from a measured zero. The dashboard exposes a deliberately small 30-day summary.
- **Phases 5–6 — Shopify materialization and source identity:** downloads and conversion occur in a validated staging directory, promotion preserves the last valid active folder on failure, paths/order IDs are constrained, and a deterministic meaningful-source fingerprint distinguishes the same revision from a changed completed order. Changed completed orders stop for manual review.
- **Phase 7 — retries:** Shopify Admin, Gemini image operations, and SMTP classify retryable failures and use bounded adapter-local backoff; permanent failures fail fast. The generator and photo-fetch paths retain their existing seam-specific retry behavior.
- **Phase 8 — concurrency audit:** no unbounded external API fan-out was found. The visible `Promise.all` intake path performs local Sharp/filesystem work, so no limiter was added without evidence. This does not prove that every future or less common fan-out is bounded.

Phase 9 was audited and is documented in `SECURITY.md`; this run did not implement the remaining `safeFetch`, storage-atomicity, or cross-process-lock changes. Recovery documentation completes the documentation portion of Phase 14. Metrics provide usage groundwork for Phase 15, but no monetary cost model exists. Phases 10–13 and 16 remain mostly future work.

## P0 — protect durable truth before more automation

1. **Make critical JSON writes crash-safe.** Replace direct overwrites of `state.json`, `autopilot-state.json`, lifecycle markers, metrics/cache files, and other operational truth with a shared Windows-tested temp-write, file flush, directory/rename, and recovery policy. Readers must remain backward compatible. Test interruption, truncated files, disk-full/write failures, and restoration of the last valid copy.
2. **Add inter-process locks.** Current locks prevent duplicate work only inside one Node process. Add per-order/run locks shared by Studio, CLI, and scheduled tasks, with owner, process, acquisition time, heartbeat/age diagnostics, and an explicit stale-lock recovery procedure. Do not silently steal a lock.
3. **Stop treating corrupt handled-order state as empty.** Preserve the damaged `autopilot-state.json`, surface an operator-visible recovery state, and require deliberate reconciliation before an empty handled set can cause re-materialization.

These are P0 because a crash or a second process can invalidate otherwise strong resumability and idempotency guarantees.

## P1 — close known network, QA, and recovery gaps

1. **Harden `safeFetch` while streaming.** Enforce the byte cap during body consumption, reject excessive `Content-Length` before download, complete IPv4/IPv6 routability classification, and bind the validated DNS result to the actual connection (or use an equivalently safe dispatcher) across retries. Continue to refuse redirects, non-HTTPS URLs, non-allowlisted hosts, private addresses, and non-image content.
2. **Create a structured output-QA record (Phase 10).** Preserve current technical QC behavior while exposing stable metrics, verdicts, and reasons. Do not change the human gate.
3. **Run original-versus-generated semantic QA in shadow mode only (Phase 11).** Persist structured results and compare them with attempt-specific human decisions. Measure false passes (`AI good`, human bad), false rejects, recall, and agreement before any workflow effect. It must not auto-approve, auto-release, or silently block shipping.
4. **Expand failure injection (Phase 13).** Add the missing crash/write, lock, disk, process-stop, partial promotion, duplicate/changed poll, mail, builder, and retry exhaustion cases. Every case must prove no silent success, no incomplete release, preserved completed work, safe rerun, and explainable state.
5. **Rehearse recovery.** Test `RECOVERY.md` on a clean machine or isolated directory using a sanitized backup, including version compatibility, permissions, marker clocks, manifest parsing, dry-run purge, and a no-send validation pass.

## P2 — learn from production evidence

1. **Smart regeneration (Phase 12):** map durable rejection reasons to controls the current generator actually supports. Keep a neutral fallback and measure outcomes; do not claim face preservation or composition control without an implemented capability and evidence.
2. **Cost estimation (Phase 15):** first record provider/model identity, call counts, retry counts, duration, and versioned price inputs. Report estimates as estimates with currency, effective date, and unknown coverage; never invent precision.
3. **Exception-first workflow (Phase 16):** rank failed, QA-concern, repeatedly regenerated, and high-risk work ahead of normal output while retaining explicit final human approval. Validate the ranking with operator use before expanding the dashboard.
4. **Operational refinements:** expose retry counts and terminal seam errors durably, audit every remaining external fan-out, and add performance/error budgets only after representative production data exists.

## Evidence required before changing automation

- A representative volume of attempt-specific human labels, including generic `unspecified` decisions.
- Shadow-QA confusion matrices, with false passes treated as the primary safety metric.
- Generator capability experiments proving which corrective controls change which failure class.
- Real latency, retry, failure, and provider-usage distributions.
- Observed concurrency and multi-process deployment behavior.
- A successful recovery rehearsal and failure-injection results for critical state.

Until that evidence exists, the human review/release wall, file-backed architecture, explicit failures, and conservative changed-order handling should remain.
