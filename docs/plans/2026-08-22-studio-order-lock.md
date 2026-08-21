---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
title: Serialize Studio and pipeline order mutations
---

# Goal Capsule

Close the cross-process race between Shopify materialization, generation/PDF work, and Studio review/edit/redo mutations. All mutations for one logical order must use one fail-fast filesystem lock while unrelated orders remain independent.

# Key Decisions

- Keep the existing filesystem lock design and fail-fast behavior; automatic stale-lock stealing is rejected because crash recovery requires operator reconciliation.
- Lock the complete async mutation lifetime, including external regeneration and raster/QC work; process-local `requireIdle` alone is insufficient.
- Preserve the human review wall and all existing state transitions.

# Requirements

- R1: Materialization, pipeline processing, and every Studio order mutation derive the same lock from inbox root plus validated order ID.
- R2: A contender fails visibly without changing manifests, images, PDFs, or review history.
- R3: Locks release on success and every thrown/rejected path.
- R4: Different orders remain independently mutable.
- R5: No automatic stale-lock deletion or unrelated workflow changes.

# Implementation Units

### U1. Shared cross-process order lock

- Files: `src/orderLock.js`, `src/orchestrator.js`, `src/shopify/materialize.js`, `test/orderLock.test.js`, focused pipeline/materialization tests.
- Approach: reconstruct only the previously tested lock foundation required by this unit.
- Verification: real child-process contention; focused pipeline and materialization suites.

### U2. Studio mutation coverage

- Dependencies: U1
- Files: `src/ui/server.js`, focused server/review tests.
- Approach: introduce one server-local lock wrapper and route synchronous and asynchronous review mutations through it without nesting the same lock.
- Test scenarios: child process holds order lock while approve/reject/handoff/replacement/edit/revert/redo is attempted; zero state/output change; lock releases after async completion and error; different order remains available.
- Verification: focused server/review/lock tests and full `npm test`.

# Verification Contract

- `node --test test/orderLock.test.js test/materialize.test.js test/autopilot.test.js test/review.test.js test/reviewServer.test.js`
- `npm test`
- `git diff --check`
- Independent technical and security/privacy review find no unresolved P0/P1.

# Definition of Done

No Studio, materialization, or pipeline path can mutate one order concurrently across processes; contention is visible and lossless; all relevant tests pass; only unit-owned files are committed.
