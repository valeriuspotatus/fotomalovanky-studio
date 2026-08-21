# Disaster recovery

This run adds a recovery contract, not automated cloud backup infrastructure. Resolve deployment-specific paths from active configuration/environment before copying or restoring data.

## If this PC or persistent volume dies

The app can be reinstalled from source. Shopify can be polled again only for orders still visible in the configured window, and photos can be reacquired only while source URLs remain valid and unchanged.

Without backup, the following may be permanently lost:

- `state.json` attempts, QC, human decisions, crops/repairs, and builder eligibility.
- Generated SVG/PNG/echo artifacts and finished PDFs that cannot be reproduced identically.
- `autopilot-state.json` handled fingerprints/cursor, reports, and print/delivery/hidden markers.
- `objednavka.json` snapshots identifying the exact processed source revision.
- Account/profile, creative/blog, mail/operator state, and local-only configuration.
- Originals whose Shopify/CDN source expired or changed, and manual replacements/repairs never stored there.

Shopify is not a backup of human decisions, output, print/delivery evidence, repairs, or the exact historical source response. Regeneration costs money and may produce a different page.

## Data classes

### Durable operational knowledge to back up

- Configured **outbox**, including `state.json`, printable artifacts/PDFs, and lifecycle markers.
- `shopify.dataDir`, especially handled/source-fingerprint state and operational reports.
- Configured account, creative, and blog data when operationally required.
- `objednavka.json` sidecars and non-secret evaluation metadata. Sidecars currently share the inbox with photos, so privacy-aware backup may need selective copies.
- Application commit/version, `config.example.json`, and a separately protected record of non-secret deployed configuration shape.

Operational state can still contain identifiers/PII. Encrypt it, restrict access, and give it a retention policy.

### Temporary / retained short term

- Customer originals, generated echo/rejected images, crop/repair copies, staging/backup directories, browser downloads, editor/OS temporary files, and export ZIPs.

Retain these only to finish/recover current work and within the customer-photo policy. Backup must not become a permanent shadow archive defeating `retentionDays`.

### Secrets and disposable data

Do not put plaintext Shopify, Gemini, generator, Proton, or other credentials into normal data backups or repository archives. Restore them separately from an encrypted secret manager/vault. Dependencies, caches, reproducible build artifacts, completed staging directories, and logs with no required audit evidence are disposable.

## Backup policy

1. Inventory absolute inbox, outbox, Shopify, accounts, creative, and blog paths; confirm none is repository-local or ephemeral.
2. Back up durable state with encryption, least-privilege access, version history, integrity checks, and operator-visible last-success time.
3. Set frequency from acceptable decision/order loss. Daily-only copies can lose a full day of review history.
4. Expire photo-bearing versions at or below the approved privacy policy and verify provider-side version deletion.
5. Keep an isolated/versioned recovery point so corruption or ransomware does not replace every copy.
6. Record app commit/config schema without secret values, and periodically perform a restore—not just a copy test.

## Safe restore procedure

1. Stop Studio, CLI, autopilot, scheduled tasks, mail sends, and any second Node process.
2. Preserve damaged data read-only; do not overwrite the only corrupt copy. Record time, paths, version, and possible external print/delivery activity.
3. Install the matching app version into a clean isolated target with restrictive ACLs, sufficient space, and no public bind.
4. Restore credentials separately from the approved secret store; keep outbound sends disabled.
5. Restore outbox and durable data first. Restore inbox sidecars/photos only when required and within retention; exclude stale staging directories unless preserving incident evidence.
6. Validate path containment, JSON parsing, manifests, lifecycle markers, expected output pairs/PDFs, and backup checksums. Quarantine ambiguous files instead of deleting them.
7. Read/reconcile Shopify order IDs, fingerprints, and `updatedAt` without mutation. Do not overwrite a changed completed order; treat legacy handled entries conservatively.
8. Start loopback-only, inspect queues/metrics/warnings/PDFs/accounts, and run the matching test suite. Keep delivery disabled.
9. Run retention dry-run and verify marker mtimes survived. Restoring everything with today's timestamp can silently alter retention; correct clocks only from trustworthy metadata.
10. Resume one non-delivery recovery order first. Re-enable polling, then outbound actions last, while monitoring the first production cycle.
11. Record orders re-downloaded, regenerated, repaired, printed, or sent outside restored state. Never infer delivery from a PDF alone.

## Failure-specific decisions

| Failure | Safe response |
| --- | --- |
| Corrupt `state.json` | Quarantine; restore latest valid version; reconcile artifacts/decisions. Never replace blindly with empty state. |
| Corrupt/missing `autopilot-state.json` | Restore/reconcile handled fingerprints before broad polling; current code otherwise treats corruption as empty. |
| Failed rematerialization | Keep the valid active directory; investigate fetch/conversion/promotion report. |
| Lost photo with live source | Re-materialize only after source comparison and preservation of prior data. |
| Lost photo with expired source | Restore retained backup or request deliberate re-upload; never build fewer pages. |
| Lost output/PDF | Rebuild under operator control and repeat review as needed; regenerated output can differ. |
| Ambiguous printed/sent state | Reconcile physical/operator records before markers; avoid duplicate delivery. |
| Future stale lock | Inspect owner/age/process and follow an explicit stale policy; never guess-delete a live lock. |

## Recovery rehearsal acceptance criteria

The restored system must start on loopback, parse durable state, show expected queue/metrics, preserve decisions/markers, refuse incomplete books, report changed revisions, perform no delivery, and produce a retention dry run consistent with original clocks. Record gaps in [HARDENING_ROADMAP.md](HARDENING_ROADMAP.md).
