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
