# Hardening roadmap

Ranked backlog derived from `AUDIT_BASELINE.md`. This is not a claim that the work is implemented.

## P1 — protect order correctness and recoverability

1. Add append-only generation attempt history and human decision history without making telemetry-only writes invalidate PDFs.
2. Make Shopify materialization transactional: validated staging directory, exact source file set, atomic promotion where Windows permits, preservation of the last valid active version, cleanup after failure, and strict ID/path containment.
3. Add a deterministic meaningful-source fingerprint and distinguish same input, meaningful revision, and harmless metadata changes before changing handled behavior.
4. Replace direct critical JSON overwrites with durable temp-write/flush/rename patterns suitable for Windows, while retaining backward-compatible readers.
5. Add an inter-process order/run lock with owner/age diagnostics and a deliberate stale-lock policy.

## P2 — make external failures deliberate

1. Standardize adapter-local transient classification and bounded backoff/jitter for Shopify Admin, generator/Gemini, SMTP, and any remaining external seams. Keep permanent failures fast.
2. Stream photo downloads through a byte limit, improve IP classification, and bind DNS validation to connection behavior as far as the runtime permits.
3. Add operational generation metrics from durable manifests: attempts, first-pass acceptance, redos, failures, durations, ceiling hits, and rejection reasons. Represent legacy/no-data separately from zero.
4. Surface corrupt-state recovery explicitly rather than silently resetting autopilot memory.
5. Prove or cap concurrency at every external fan-out.

## P3 — improve learning and recovery after foundations exist

1. Add structured output-QA records, then semantic original-versus-generated QA in shadow mode only.
2. Compare shadow verdicts with attempt-specific human decisions before considering any automation.
3. Build a failure-injection matrix for disk faults, interrupted writes, partial materialization, duplicate/changed polls, stale locks, mail failures, and process interruption.
4. Document and rehearse recovery/backup boundaries, including what is deliberately not backed up for privacy.
5. Add measurable cost/latency observability and exception-first operator prioritization without removing the human gate.

## Decisions and unknowns to resolve with evidence

- Define meaningful Shopify revision fields from observed orders; do not use `updatedAt` alone.
- Decide whether telemetry has a separate file/clock or manifest writes preserve PDF freshness when output eligibility did not change.
- Confirm whether production ever has more than one process sharing inbox/outbox.
- Confirm backup, disk, ACL, TLS termination, and retention behavior on the production machine/host.
- Collect real human labels before tuning rejection categories, semantic QA thresholds, or smart regeneration.
