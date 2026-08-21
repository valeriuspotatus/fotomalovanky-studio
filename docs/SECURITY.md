# Security and privacy

This document describes the current security boundary after the Prompt 2 hardening run. It is a scoped threat model for a small operator system, not a certification or a claim that every listed control is complete.

## Assets and trust boundaries

The highest-value assets are customer photographs (often of children), names and email addresses, dedication text, paid-order metadata, generated books, delivery/print history, Shopify and AI credentials, Proton credentials, and authenticated Studio sessions.

The main boundaries are Shopify and customer/app-influenced photo URLs entering the pipeline; the Studio server between operator browsers and filesystem data; generator, Gemini, SMTP/Proton, PDF/Playwright, and conversion adapters; and configured inbox, outbox, and data directories. The design assumes trusted operators and host OS account. A stolen operator machine, compromised provider, malicious host administrator, supply-chain compromise, or fully compromised OS is outside the protection the application alone can provide.

## Current controls

### Secrets and logs

- Provider credentials come from configuration/environment rather than customer state. `redactForLog` drops Shopify tokens and masks token-bearing generator URL paths.
- Generation telemetry allowlists `diffusionSteps`, `steps`, `variant`, and `mode`; metrics omit order IDs, photo names, URLs, paths, customer content, and credentials.
- The photo downloader sends no Shopify or generator credentials to photo hosts.
- Configured data directories are rejected when they resolve inside the repository, reducing accidental PII/secret commits.

These controls do not make arbitrary logs, backups, crash dumps, shell history, screenshots, or manually copied files safe. Do not paste secrets or customer data into issues, commits, or support messages.

### Studio server and authentication

- Ungated mode is permitted only on loopback; startup refuses an unauthenticated non-loopback bind. Partial role configuration fails closed.
- Hosted sessions use random 256-bit opaque tokens held in memory. Cookies are `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, and eight-hour limited; sign-out invalidates server state.
- Anonymous access is limited to health/login and explicitly named brand assets. Application shells and APIs remain gated; roles restrict operator surfaces.
- Mutating requests check same-origin `Origin`/`Referer` when present, and login throttling limits guessing/concurrency.

TLS is an infrastructure requirement: the app is plain Node HTTP and relies on loopback use or trusted HTTPS termination. Header-less non-browser clients remain accepted for mutations, so origin checking is defense in depth, not a universal CSRF token.

### Filesystem

- Shopify materialization accepts numeric IDs with optional numeric suffixes and requires resolved active/staging/backup directories to be direct inbox children.
- Downloads, conversion, sidecar creation, and exact-file validation finish in private staging. A failed replacement preserves the previous active folder.
- Review routes resolve known orders/photos instead of exposing a general static photo directory. Builder eligibility requires every expected photo to be `ok` or explicitly `approved`; missing and stray output pairs are refused.
- Retention deletion is lifecycle-gated, dry-run/confirmation based, capped, and limited to enumerated photo artifacts. PDFs and operational state remain.

Known limitations: critical JSON is generally overwritten directly; locks are process-local; a hostile local filesystem user bypasses app controls; and explicit symlink/reparse-point defense is incomplete. Use least-privilege ACLs and do not share data directories with untrusted users.

### SSRF and photo downloads

`safeFetch` requires HTTPS, an exact/subdomain allowlist match, public DNS answers, no redirects, an image content type, a non-empty body, and a 25 MiB post-download limit. It sends no secret headers and has bounded seam-specific retries.

Remaining gaps are material:

- DNS validation is separate from the connection used by `fetch`, leaving DNS-rebinding/time-of-check-time-of-use exposure.
- The entire body is buffered before enforcing the byte cap; `Content-Length` is not rejected early.
- IPv6/private-address classification is prefix-based rather than a complete routability decision.

Future work should stream through the byte limit and pin or validate the actual connection address across retries. Until then, keep the allowlist narrow; never add arbitrary customer-provided hosts.

### Customer privacy and retention

Originals live in the inbox; generated echoes/output and operational state live in per-order outbox directories. PII also exists in `objednavka.json`, filesystem paths, mail content, and reports. Purge removes original and generated echo/rejected photo artifacts only after finished, printed, dispatched, and aged lifecycle evidence, and can age stale autopilot report/state files.

The app cannot prove browser downloads, OS/editor temporary files, provider copies, screenshots, or backups follow the same policy. Photo-bearing backups need access controls and an expiry that does not defeat `retentionDays`; see [RECOVERY.md](RECOVERY.md).

## Threats and current disposition

| Threat | Current disposition | Residual risk / next control |
| --- | --- | --- |
| Public unauthenticated Studio | Fail-closed non-loopback/auth checks | Proxy/TLS mistakes and stolen credentials remain |
| Credential leakage | Config redaction and telemetry allowlists | Audit ad-hoc logs/backups; rotate after suspected exposure |
| Malicious order/path | ID and containment validation in materialization | Complete symlink/reparse-point defenses |
| SSRF | HTTPS, allowlist, DNS/IP checks, redirect refusal | Bind DNS validation to connection; complete IP classification |
| Oversized response | Content-type and post-buffer cap | Stream cap and early `Content-Length` refusal |
| Cross-site mutation | Secure SameSite cookie plus origin checks | Consider explicit CSRF tokens if exposure expands |
| Torn state write | Read failures are generally visible | Atomic JSON, last-known-good recovery, fault injection |
| Concurrent processes | In-process locks only | Inter-process owner/age locks and stale policy |
| Incomplete release | Exact builder gate and human wall | Preserve invariant tests; no QA bypass |
| Excess retention | Lifecycle purge | Backup expiry, encryption, ACLs, restore-time deletion |

## Deployment checklist and deliberate scope

1. Use loopback for ungated local operation. Configure every role hash and trusted HTTPS termination for any non-loopback bind.
2. Keep all data directories on intended persistent storage outside the repository, with service-account-only ACLs and encrypted media where available.
3. Keep photo-host allowlists minimal; never put provider credentials into photo URLs or logs.
4. Review retention dry runs before confirmation, and age out backup copies too.
5. Treat corrupt JSON, held locks, changed completed orders, and materialization failures as reconciliation exceptions—not reasons to delete state blindly.

The small file-backed architecture remains reasonable under trusted-machine/operator assumptions. Concrete next security work is crash-safe JSON, inter-process locking, and downloader hardening. A database, microservices, public photo service, enterprise identity provider, or zero-touch release is not justified by this audit.
