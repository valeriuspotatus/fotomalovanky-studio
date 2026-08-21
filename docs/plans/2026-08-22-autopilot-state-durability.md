---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
title: Crash-safe fail-closed autopilot state
---

# Goal Capsule

Prevent corrupt or torn `autopilot-state.json` from becoming an empty handled-order ledger and replaying completed orders. Preserve the existing missing-file clean-start behavior and state schema.

# Requirements

- R1: A missing state file returns the existing empty state.
- R2: Existing malformed or structurally invalid state fails visibly before Shopify polling or materialization.
- R3: Saves use same-directory atomic replacement and clean temporary files on failure.
- R4: Existing valid state round-trips without schema changes.
- R5: No new dependency or recovery automation; deliberate operator reconciliation remains required after corruption.

# High-Level Technical Design

Keep the change inside `src/autopilotState.js`. Parse and validate the persisted top-level ledger instead of silently substituting defaults for corrupt fields. Save JSON through a uniquely named same-directory temporary file, flush it, close it, then rename it over the target; remove only that run's temporary file on failure. Let callers receive the error so autopilot fails closed.

# Implementation Units

### U1. Fail-closed state loading and atomic saving

- Requirements: R1–R5
- Files: `src/autopilotState.js`, `test/autopilotState.test.js`
- Dependencies: none
- Approach: strengthen focused tests first, then implement the smallest local state-store change.
- Test scenarios: missing file; valid round trip; malformed JSON throws; invalid handled ledger throws; no leftover temp file after successful save; previous valid target remains readable if a temp artifact exists.
- Verification: `node --test test/autopilotState.test.js`; `npm test`.

# Verification Contract

- Focused state tests pass.
- Full Node test suite has zero failures.
- `git diff --check` passes.
- No files outside the unit are modified by implementation.

# Definition of Done

- Corrupt durable state cannot silently trigger a clean-slate replay.
- Writes cannot expose partially written JSON at the canonical path.
- Compatibility behavior and focused/full regression evidence are recorded.
