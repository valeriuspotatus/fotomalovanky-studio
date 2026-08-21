# Production hardening audit baseline

Audit date: 2026-08-21. This document describes the checked-out implementation before Prompt 2 behavioral hardening. `PIPELINE.md` does not exist in this checkout; lifecycle claims below were reconstructed from source, tests, README, operator documentation, and relevant plans/spikes. No production behavior was changed during this phase.

## Current architecture

The application is a Node.js 20+ ESM monolith with file-backed state and a local/hostable HTTP operator UI. `src/ui/server.js` composes the order pipeline, review actions, two-role authentication, Shopify polling, mail, metrics, marketing, and operational routes. The same core pipeline is callable from `src/orchestrator.js`; `src/autopilot.js` adds Shopify discovery/materialization and deliberately stops at a built PDF.

Orders are isolated as directories. `src/ingest.js` discovers input photos, `src/intake.js` performs pre-generation checks, `src/batch.js` drives one photo at a time through the selected generator and output QC, `src/manifest.js` persists per-photo truth, and `src/orchestrator.js` invokes the Playwright-backed builder only when every expected photo is eligible. The browser UI reads and mutates the same files through `src/review.js` and `src/studio.js`.

The generator is adapter-based (`generator/factory.js`, API and browser drivers). The builder is also an adapter (`builder/builderDriver.js`) around the vendored web builder. Shopify network access and pure order extraction are separated. Proton IMAP/SMTP adapters are isolated and injectable. Tests use Node's built-in test runner and dependency injection extensively.

## End-to-end order lifecycle

1. Shopify Admin GraphQL lists recent orders. `extractJobs` normalizes photo-bearing line items; multi-book purchases become independently isolated job/order IDs.
2. Autopilot skips IDs in `autopilot-state.json`, then `materializeOrder` downloads allowlisted HTTPS image URLs, converts non-JPEG inputs, and writes photos plus `objednavka.json` under the inbox.
3. The orchestrator ingests selected folders and performs order-level input QC before GPU spend. Blocking count/quality findings are persisted in `state.json`, a draft customer email is written, and the order is held unless explicitly overridden.
4. Generation is sequential per order/photo. A manual crop or automatic framing correction is applied to a derived upload, never to the customer original. Successful output is written as the generator echo, SVG, and PNG. Mechanical QC assigns `ok` or `flagged`; failures assign `failed`.
5. `ok` is builder-eligible immediately. `flagged`/`pending_review` require operator action. The operator may approve, reject/redo, hand off for repair, edit/crop, accept a replacement, or revert an edit. Manual repair always returns to `pending_review`; it does not bypass review.
6. Only when every expected photo is `ok` or `approved`, and no stray/missing output pair exists, the builder produces `<orderId> Final.pdf`. PDF freshness currently uses `state.json` mtime as the "last decided" clock.
7. The dashboard exposes the PDF/ZIP and print batch. Jirka marks the book printed (`printed.json`); the operator separately marks it sent to the customer (`sent.json`). Source contains no active WhatsApp delivery adapter: comments explicitly state WhatsApp was removed and users fetch artifacts from the Studio.
8. Retention becomes eligible only for a finished, printed, dispatched order after the configured window. Purge is dry-run by default, confirmation-gated, capped at 25 orders, removes original/echo photos rather than PDFs/state, and preserves manifest mtime.

Autopilot does **not** deliver, print, or mark sent. It marks an order handled only after the pipeline reports `ready` (built PDF).

## Persistent state

| Information | Location and format |
|---|---|
| Per-order/per-photo generation and review truth | `<outbox>/<order>/state.json` |
| Customer-upload originals | `<inbox>/<order>/*.{jpg,jpeg}`; source paths are referenced from `state.json` |
| Generated echo, SVG, PNG and final PDF | `<outbox>/<order>/` |
| Customer/order metadata | `<inbox>/<order>/objednavka.json`; includes email, dedication, products, URLs, purchase identity, attribution |
| Intake customer-email draft | `<outbox>/<order>/draft-email.txt` while applicable |
| Manual-edit backup | `<outbox>/.originals/<order>/<base>.svg` |
| Hidden/printed/dispatched facts | `hidden.json`, `printed.json`, and `sent.json` in the order output directory |
| Handled orders and poll cursor | `<shopify.dataDir>/autopilot-state.json` |
| Overnight operational report | `<shopify.dataDir>/` (report path owned by `autopilotReport.js`) |
| Aggregate dashboard cache | `<shopify.dataDir>/metrics.json` |
| Accounts and avatars | external per-user `accounts.dataDir`; password hashes stay in environment variables |
| Dedication spelling memory | repository-rooted memory path used by `dedication.js` (customer-adjacent durable data; exact deployed path depends on process cwd) |
| Secrets | Gitignored `config.json` and/or environment (`FMA_SHOPIFY_TOKEN`, content token, role password hashes); normalized config holds generator URL, AI key, and mail credentials in process memory |
| Temporary generation/materialization files | generator work/order directories; marketing generation also uses OS temp directories with `finally` cleanup |
| Retained customer photos | inbox originals and generated echo images until confirmed retention purge; PDFs and operational state remain |

`shopify.dataDir` and other configured data directories are rejected when they resolve inside the repository. However, `state.json`, autopilot state, sidecars, and marker writes use direct `writeFileSync`; they are not temp-file-plus-rename atomic writes in the audited code.

## State machine

Per-photo states are `ok`, `flagged`, `pending_review`, `manual_in_progress`, `approved`, and `failed`. A missing entry is pending/unstarted.

Legal transitions enforced by `manifest.canTransition`:

- new/null -> any known state
- `ok` -> `flagged`, `approved`, `failed`
- `flagged` -> `approved`, `manual_in_progress`, `ok`, `failed`
- `manual_in_progress` -> `pending_review`, `flagged`, `failed`
- `pending_review` -> `approved`, `flagged`, `manual_in_progress`, `failed`
- `approved` -> `flagged`
- `failed` -> `ok`, `flagged`
- any state -> itself (idempotent)

Generation runs for null, `flagged`, or `failed`. Review holds are `flagged` and `pending_review`. Builder eligibility is exactly `ok` or `approved`. `manual_in_progress` is operator-owned and is never overwritten by an ordinary batch rerun.

Pipeline result states in `orchestrator.js` are `held`, `failed`, `ready`, and `done`: `ready` means review-complete but no PDF was requested; `done` means PDF built/current. The Studio board derives a broader operational lifecycle from manifests and markers: intake-held/generating/review-ready-to-print/printed/sent, rather than persisting a second mutable order status. Exact board labels are derived, so there is no single stored order-state transition table.

## Existing invariants

Enforced by code and tests:

- No generator, builder, mail, print, or dispatch fallback substitutes a missing artifact silently.
- Input QC precedes generation; an under-count override requires typing the actual page count and permanently records the incomplete-book warning.
- Every expected photo must be builder-eligible; missing and stray output pairs are refused.
- Manual repairs and edits return to review and cannot jump directly to builder eligibility.
- Runs are resumable per photo and failures are isolated per order; cooperative stop preserves completed files/state.
- Manual and autopilot runs share in-process locks; per-photo redos are also deduplicated in-process.
- Customer originals are not modified by crop/framing.
- Autopilot stops at PDF creation. Mail send occurs only on an explicit authenticated route. Printed and customer-sent are distinct explicit actions.
- Retention requires the final lifecycle markers and never purges a merely printed/unfinished book.
- Customer dedication is persisted verbatim except trim/500-character storage limit; an intentionally cleared dedication is distinguished from an unset one.
- Remote server binding without configured password hashes fails before listening. Route audiences enforce operator versus printer access.
- Photo fetch requires HTTPS, host allowlisting, public DNS results, image content type, redirect refusal, and a 25 MiB post-read cap.

Documented or intended but not fully enforced:

- "Atomic state writes" is not true for the principal JSON stores; a crash can truncate a direct write.
- Order materialization says an incomplete download should not mislead intake, but it writes directly into the active folder and does not remove stale files.
- Handled-order idempotency is keyed only by internal order ID; meaningful Shopify revisions are not modeled.
- Process-local locks do not prevent a second Node process or scheduled task instance from operating on the same directories.
- "No customer data in logs" is partly enforced through normalized client shapes and token avoidance, but there is no general log-redaction layer for arbitrary thrown messages.

## External dependencies

- Shopify Admin GraphQL for orders, metrics, attribution, and draft blog publishing.
- RunPod/token-scoped generator HTTP API or a browser-driven generator selected by config.
- Google Gemini for optional framing/creative AI paths; framing fails open to no correction.
- Local filesystem as the database, queue, artifact store, and lifecycle journal.
- Vendored browser builder controlled with Playwright; `sharp` for image decoding/conversion/QC.
- Proton Mail Bridge over IMAP and SMTP; remote mail requires TLS verification.
- Browser/Playwright and desktop process launching/folder picker routes.
- Windows-oriented `.cmd`/PowerShell launch/setup/task scripts, File Explorer integration, and filesystem behavior. Core Node tests are cross-platform but two baseline assertions differ/fail on Windows.
- No active WhatsApp dependency was found; it is historical documentation/comment context only.

## Current observability

The operator can see queue/order status, active order and bounded run logs, per-photo status and reason, intake findings, stored crop/framing, PDF presence, printed/sent markers, held-customer email age, purge preview/stalled orders, autopilot last report/error, Shopify business aggregates, and mail connectivity/errors. Adapter errors generally name their seam. `state.json` survives reload and explains the current verdict.

Generation stores only the settings for the **current successful output** (`attempt`); it does not retain failures, prior attempts, timestamps/durations, or which attempt a later human decision judged. Autopilot reports counts and estimated spend per order, not durable attempt-level cost/performance.

## Missing observability

The system cannot reliably answer first-pass acceptance, redo counts, historical generation failures, duration percentiles, rejection reasons, which attempt was accepted, QC-versus-human disagreement, generator ceiling hits, retry counts, source revisions, or cost per attempt. Generic redo/reject overwrites the current reason and successful attempt settings. Corrupt autopilot state is silently treated as empty, so the operator cannot distinguish first run from state loss. SMTP/Shopify retry attempts are not durably reported. There is no cross-process lock owner/age visibility.

## Manual workflow

- Start/stop the Studio; select/scan an inbox folder and selected orders.
- Trigger Shopify fetch/autopilot, generation-only, PDF build, or stop at a photo boundary.
- Set/clear dedication; override intake (with explicit count confirmation for missing photos); mark customer emailed.
- Approve, reject, generic redo, redo with overrides/original, hand off for manual repair, accept replacement, edit/erase/crop/revert output, save/clear/suggest input crop.
- Open the generator or order folder; download/view PDF, order ZIP, or print-batch ZIP.
- Mark/unmark printed; mark/unmark customer-sent; hide/delete from board; run marker migration.
- Compose/send, delete, or flag Proton messages.
- Preview and confirm retention purge.
- Update profile/account presentation and use operator-only settings/metrics/marketing/blog tools.

There is no current structured rejection-reason fast path, and no active WhatsApp send action.

## Failure recovery

| Seam | Retry | Failure/state behavior | Visibility |
|---|---|---|---|
| Shopify Admin GraphQL | None in `adminClient` | Throws; prior local orders/state remain | UI/autopilot error; message avoids token |
| Photo download | Up to 5 for 403/408/429/5xx; first retries immediate, then exponential; no jitter | Continues other photos; active folder and sidecar still written; prior files can remain | Materialization errors/report |
| Image conversion | None | Records photo error; other files remain | Materialization incomplete |
| Generator | Driver/API retry exists for configured transient behavior; exact policy is adapter-specific | Current photo becomes `failed`; completed photos survive; next run retries | State reason and run log |
| Gemini/framing | Creative AI has configured retry/backoff; framing analysis returns no correction on timeout/quota/malformed output | Generation continues without automatic correction | Framing fallback is not prominent |
| Output QC/crop | No external retry | QC flags output; tidy/auto-crop is best-effort in several paths | Per-photo verdict/reason |
| Builder/Playwright | No generic retry | No PDF success; other orders continue; existing valid PDF is not silently replaced by a fallback | Named builder seam |
| SMTP | None | Explicit send fails; no delivery marker is written | HTTP error/code |
| IMAP | None | Reads/writes fail; opening-message seen update is best effort | Stable offline/auth/error states |
| State write | None; direct overwrite | Possible truncated JSON. Manifest read throws; autopilot load silently resets | Manifest corruption visible as failure; autopilot corruption is not |
| In-process concurrency | Manual/autopilot/redo guards | Rejects overlapping action; second OS process is uncontrolled | Clear UI errors in one process |
| Retention | Dry-run, confirmation, batch cap; idempotent | Finished outputs/state survive; purge restores manifest mtime | Detailed sanitized report |

## Security boundaries

Secrets are gitignored/environment-backed and config validation avoids placeholders; Shopify tokens are sent only to the configured store Admin endpoint, and photo fetch sends no auth. Client responses intentionally omit paths, credentials, hashes, and session tokens. Risks remain because generator token URLs and mail/AI credentials live in the normalized in-memory config, direct exception/log discipline is decentralized, and real deployment log/config handling was not available to inspect.

The server supports ungated local loopback mode and two-role password/session mode. Hosted/non-loopback binding without hashes is refused; persistent directories are checked before listen. Sessions are cookie-based and state-changing routes use request-origin/fetch-metadata defenses plus route/audience authorization. HTTPS termination is assumed to be provided by the hosting layer; TLS topology was not verifiable from this repository.

Filesystem access is generally rooted through discovered orders and known actions, and avatar/order routes validate identities before reads. Materialization uses `join(inboxRoot, order.orderId)` without a local validation step; normalized Shopify IDs appear constrained upstream, but the exported function accepts an arbitrary caller-supplied ID. Direct write/delete behavior should defensively validate IDs and resolved containment. Symlink/reparse-point behavior is not explicitly defended.

`safeFetch` has useful SSRF controls, but DNS is checked separately from the actual `fetch`, leaving DNS-rebinding/TOCTOU exposure. The 25 MiB limit is checked only after buffering the entire body, and IPv6 classification is prefix-based rather than a complete routability parser. Redirects are refused and content type is checked.

Customer photos are not exposed as a general static directory. Authenticated routes can serve operational PDFs/ZIPs to authorized roles. Customer PII remains in sidecars, state-adjacent paths, reports, mail, and local photos until retention rules apply; rejected/echo images are included in retention deletion. Backups and deployed disk access controls are unknown.

## Testing

The suite contains 903 tests in this baseline run (899 passing, 2 failing, 2 skipped). Broad unit coverage exists for config/auth, order extraction, manifest transitions, QC/math, framing/crop, email templates, metrics, and pure board logic. Integration-style tests cover ingest-to-generation-to-QC-to-builder orchestration, HTTP routes/auth, autopilot/materialization, review actions, retention, Proton adapters with fakes, and stop/resume behavior. Golden/fixture-like coverage exists for builder pairs, printables, dedication/rendering and UI snapshots/smokes, while Playwright smoke scripts are separate from `npm test`.

Failure injection already covers generator/builder failures, held intake, interrupted runs, missing/stray outputs, fetch HTTP/content/size guards, mail failures, corrupted caches, and retention invariants. Important gaps include transactional/fewer-photo rematerialization, crash-interrupted JSON writes, cross-process locks, durable source revision, attempt history, SMTP/Admin retry policy, streaming download limits/DNS rebinding, disk-full/write failures, and semantic output QA.

Baseline failures (pre-existing and not changed here):

- `test/accounts.test.js`: Windows reports mode `666` where the test expects chmod `0600`.
- `test/sessions.test.js`: expired-session case expected HTTP 200 but received 401.

The existing metrics-cache permission test already skips its equivalent chmod assertion on Windows, suggesting the accounts test is a portability inconsistency. The session failure may be an expectation/behavior regression, but this audit did not diagnose or change it.

## Highest-risk weaknesses

### P0

No confirmed currently-exploitable P0 was proven in this audit. Production credentials, deployment topology, live filesystem, backups, and real order samples were unavailable, so absence of evidence is not a production guarantee.

### P1

- Shopify materialization writes directly into the active order directory. Re-materializing fewer/changed photos can leave stale uploads, and a failed refresh can expose a mixed partial version.
- Autopilot permanently considers a built order handled by order ID alone. A meaningful post-completion source change can be missed.
- Core JSON writes are non-atomic; a process or disk failure can corrupt the sole manifest/handled state.
- There is no cross-process lock, so Studio, CLI, and scheduled tasks can race despite strong in-process guards.

### P2

- Generation telemetry is last-attempt-only and successful-attempt-only; human rejection information is overwritten or generic.
- Shopify Admin and SMTP have no bounded transient retry; generator/Gemini/photo retries are inconsistent and not uniformly observable.
- `safeFetch` buffers before enforcing size and has DNS check/use separation.
- `materializeOrder` itself does not validate/contain an untrusted order ID.
- Corrupt autopilot state silently resets, hiding an operational incident.
- Manifest mtime couples every state write to PDF freshness, which will make future telemetry writes rebuild PDFs unless separated or the clock is preserved deliberately.

### P3

- Framing AI failure is intentionally fail-open but not strongly visible.
- Manual actions lack a durable actor/timestamp history.
- Production SLOs and backup/restore procedures are not yet evidenced.
- Network concurrency and retry jitter are not consistently configurable/measured.

## Things that should NOT be rewritten

- File-backed, per-order isolation is appropriate for the current scale and makes failures inspectable.
- The single manifest-backed photo state machine, transition guard, resumability, and explicit builder eligibility gate are strong foundations.
- Pure extraction/QC/business functions separated from injected network/browser adapters enable the extensive fast test suite.
- Sequential per-photo processing, order-level failure isolation, cooperative stop, and idempotent reruns should be preserved.
- Explicit human review, printed, sent, mail-send, and purge actions are valuable safety walls.
- The vendored builder and its preflight checks should be hardened in place, not replaced without evidence.
- External data directories, credential scoping, route audiences, client-shape sanitization, and retention marker model should be extended rather than redesigned.

## Unknowns

- Actual production `config.json`, generator API semantics/rate limits, Shopify scopes, host allowlist, and hosting TLS/proxy configuration.
- Whether the production operator runs Studio, CLI, scheduled autopilot, or multiple processes concurrently.
- Live directory ACLs, disk encryption, backup coverage, restore tests, disk capacity monitoring, antivirus/indexer interference, and symlink/reparse-point exposure.
- Whether Shopify edits after fulfillment occur in practice and which fields constitute a meaningful revision.
- Exact WhatsApp history or any delivery automation outside this repository; no active adapter exists here.
- Whether printer/customer delivery occurs through other systems not represented by `printed.json`/`sent.json`.
- Real generation failure/redo rates, latency/cost distribution, QC false-pass rate, and operator reason taxonomy frequency.
- Whether all customer-photo copies outside inbox/outbox (manual tools, downloads, OS temp/browser caches, backups) obey the same retention policy.
- Whether `PROJECT_EXTRACTION.md` is an authoritative generated artifact or an obsolete snapshot; code was treated as authoritative.
