# Generation and review telemetry

Each photo may carry `generationAttempts`, an append-only array in `state.json`. Legacy manifests
without the array remain valid and report no history; the old `attempt` field remains the current
generator-settings compatibility view used by the reroll ladder.

Every actual generator invocation appends a record, including failures. Records contain a random
attempt ID, ordinal, start/finish/duration, initial-vs-redo kind, safe generator settings, outcome,
failure reason, and automatic QC verdict/reason/metrics where available. Generator settings are
allowlisted (`diffusionSteps`, `steps`, `variant`, `mode`); URLs, tokens, keys, credentials, full
configuration, customer data, photos, and filesystem paths are never copied into attempt telemetry.

Human decisions are appended to the specific current attempt. Rejection reasons are
`face_likeness`, `wrong_subject_count`, `anatomy`, `missing_subject_or_object`, `composition`, `crop`,
`solid_fill`, `too_detailed`, `too_simple`, `other`, or `unspecified`. The review grid offers one-click
reason buttons that persist the reason and immediately start redo; the existing generic redo remains
compatible and records `unspecified`. Approval records the accepted attempt, attempt count at the
decision, and whether it followed the manual-repair/pending-review path. A reroll ceiling annotates
the current attempt without inventing a generator invocation.

## PDF freshness

The existing builder treats `state.json` mtime as the order's last output-decision clock. Telemetry
does not introduce separate manifest writes: generation telemetry is saved in the same write as its
generation status, while review telemetry is saved in the same write as the existing human status
transition. Those events can change printable output or eligibility and should invalidate an older
PDF. There is currently no telemetry-only persistence path, so bookkeeping alone cannot stale a PDF.
If a future feature adds telemetry unrelated to output/eligibility, it must use a separate sidecar or
explicitly preserve the manifest mtime rather than calling `writeManifest` on its own.

## Generation metrics

`GET /api/generation-metrics` is an operator-only, uncached aggregate rebuilt from the
`generationAttempts` arrays in outbox manifests. It returns `today`, `7d`, `30d`, and `all` windows.
The calendar windows use `Europe/Prague`; today begins at local midnight, while 7d and 30d include
today plus the preceding 6 or 29 local calendar days.

A photo belongs to a window according to its first durable attempt. All later attempts for that photo
stay in the same cohort so first-pass and redo rates describe one coherent funnel. A manifest without
`generationAttempts` has no historical evidence and is not counted at all—not even when its current
status is approved. This is intentionally different from a known zero: a telemetry-bearing cohort
with no failures reports failure rate `0`, while a window with no telemetry reports counts and rates
as `null` and `hasData: false`. A rate is also `null` when its specific denominator is absent (for
example, first-pass acceptance before any photo has been accepted, or automatic-QC flag rate when no
QC verdict was recorded).

The aggregate includes generated photos, generator invocations, accepted photos, first-pass / exactly
one redo / two-or-more redo shares among accepted photos, attempts per accepted photo, generation
failure rate, human rejection rate among successful outputs, automatic-QC flag rate among recorded QC
verdicts, ceiling-hit share of generated photos, average and median invocation duration, and human
rejection-reason counts. It exposes no order IDs, photo names, inputs, paths, generator URLs, or
credentials. The dashboard shows only the 30-day first-pass share, attempts per accepted photo, and
generator failure rate; the section ships hidden and is revealed only for the operator role.
