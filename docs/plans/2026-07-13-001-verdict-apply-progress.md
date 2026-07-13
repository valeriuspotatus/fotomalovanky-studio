# Verdict apply — overnight autonomous run (2026-07-13)

Applying the hostile production audit in `reference/Verdict/claude verdict.txt` (§N change brief,
rows N1–N14) autonomously. Blocker-first. Commit after each row lands with tests green.

**Operator decisions made for the autonomous run (were flagged "needs David"):**
- **N3 printed-trigger:** operator marks `vytištěno` manually once Jirka confirms print → writes
  `printed.json` in the order's outbox folder (mirrors `delivered.json`). New terminal board state
  `printed`. Purge prefers the printed marker; keeps existing PDF-age behaviour as fallback.
- **N10 resend:** resend **replaces** (re-sends current `Final.pdf`). Store sent-file hash+time; a
  rebuild after send flips the row to `odesláno (zastaralé)` with an "Odeslat znovu" action.

## Status

| # | Change | Phase | Status |
|---|--------|-------|--------|
| N1 | Split `připraveno` → `schváleno` (approved, no PDF) / `připraveno k odeslání` (PDF built); one CTA per state everywhere | 1 | **done** bdd238e |
| N2 | Guard the override: typed page-count confirm + persistent `neúplná kniha` flag through PDF+send | 1 | **done** e2d5521 |
| N3 | `vytištěno` verdict + purge gate | 1 | **done** c13e404 |
| N5 | Fix calendar grid (7 visible columns, no overlap) | 1 | **done** 460db8c (visual — needs eyeball) |
| N6 | Disable send when WhatsApp unlinked | 1 | **done** e2d5521 |
| N7 | Unify shells: Generátor inside studio shell, one chip component, re-token buttons | 2 | todo |
| N8 | Board columns: add Stáří; rename FOTKY→Stránky w/ product denominator | 2 | **done** da3c4f3 |
| N4 | Waiting-since: "Označit: e-mail odeslán" timestamp; ">5 dní" danger | 2 | **done** 38ba8f9 |
| N9 | Mail↔order chips (regex `#?\d{4}` → chip w/ live status) | 2 | **done** ee4ebf8 |
| N12 | Lightbox + keyboard review (←→/A/B/R) | 2 | **done** 3784e77 |
| N13 | Czech unification (kill "waiting for you", "Go", "Choose File") | 2 | **done** 929844d |
| N10 | Sent-version staleness (hash+time; stale banner + Odeslat znovu) | 3 | **done** c4cf3e7 |
| N14 | Nastavení screen (folders, WhatsApp/token *status*, autopilot last-run, retention) | 3 | **done** 0de0937 |
| N11 | Kreativy seeds pass QC (every template×format×seed = pripraveno) + unit test | 2 | **done** 6abe687 |

Token rotation (P0-3) is a manual op for David (rotate generator token, move Shopify token to env),
not code — noted in final report, not applied here.

## Log
- (init) plan written; root decluttered into scratch/ + reference/.
- e2d5521 N2+N6 done. Override now typed-count-confirmed w/ permanent `incompleteBook` flag
  (manifest getIncompleteBook/setIncompleteBook, review.overrideIntake({on,confirmCount}) →
  ReviewError/409 on mismatch, studio boardEntry.incomplete, chip on card+board rows, deliver
  confirm). Send button disabled unless `state==="linked"`. 497 tests green.
- bdd238e N1 done. New `approved` board state (all approved, no PDF) split from `ready-to-send`
  (PDF on disk). deriveOrderStatus checks pdfBuilt before s.ready. dashboard STATUS map + orderRow
  actions ("Vytvořit PDF" link vs "Odeslat Jirkovi") + renderContinue CTA-per-state + kpi-ready now
  counts approved. Tests updated for the split. 497 green.
- 460db8c N5 done. Calendar grid `repeat(7,minmax(0,1fr))` + `.d{min-width:0}` (components.css) so the
  nowrap ev-label ellipsis-clips instead of forcing all 7 columns past the card. CSS-only — needs a
  visual eyeball but it's the standard grid-blowout fix. **Phase 1 code blockers N1/N2/N5/N6 done.**

### N3 design (next up — last Phase-1 blocker)
New terminal state `printed`, marker `printed.json` in the order outbox dir (mirror delivered.json):
studio.js markPrinted/unmarkPrinted + printedMarkerPath + PRINTED state; deriveOrderStatus gains a
`printed` predicate checked before `delivered`; studioBoard injects it. server.js POST /<order>/printed
+ /unprinted. dashboard: `sent` rows get "Označit vytištěno", `printed` is terminal (hidden unless
showDone) w/ Vrátit. Purge (retention.inspectOutbox): gate on the printed marker — an order is
purge-eligible only once `printed.json` exists AND age(from marker) ≥ retentionDays; "merely odesláno
is never purged" (verdict N3 acceptance). Update retention.test.js + studio.test.js accordingly.

- c13e404 N3 done. **Phase 1 (N1/N2/N3/N5/N6) COMPLETE.** printed.json marker + PRINTED terminal
  state (studio markPrinted/unmarkPrinted/printedMarkerPath, derive `printed` before delivered,
  studioBoard injects it); server /printed + /unprinted routes; dashboard "Označit vytištěno" on sent
  rows, printed folds into "dokončené", nav count excludes printed. retention.inspectOutbox now gates
  on the marker (age from marker mtime) — sent-but-unconfirmed never purges. 499 tests green.
  UI flows (calendar visual, override prompt, printed button) still want a browser eyeball.

### Phase 2 plan (next)
Order by value/effort: N13 (Czech remnants — likely mostly done by f5115f8, verify) → N11 (Kreativy
seeds pass QC + unit test) → N9 (mail↔order #chips) → N4 (waiting-since) → N8 (board Stáří/Stránky —
needs an order-date source, use folder mtime proxy) → N10 (sent staleness) → N14 (Nastavení) → N7
(unify shells, big) → N12 (lightbox+keyboard, big).

- 929844d N13 done (bigger than expected — f5115f8 had missed the run log). index.html Go→Spustit /
  PDF→Vytvořit PDF; orchestrator formatEvent + CLI summary + buildability reason all Czech; intake.js
  describeFinding/intakeSummary + studio heldReason fallback Czech; Kreativy file input styled w/
  Czech "Vybrat soubor". ~15 test assertions updated. 499 green. **6/14 done (Phase1 + N13).**
  Next: N11 (Kreativy seeds pass QC + unit test).
- 6abe687 N11 done. Nudged headline/support/CTA/logo/badge boxes in templates.js just inside each
  format's safe zone (probe-verified all 5×3 clean). Added creativeStudio test asserting
  validateConcept(seed)==='pripraveno' for every family×format. 500 green. **7/14 done.**
  Next: N9 (mail↔order #chips) → N4 (waiting-since) → N8 → N10 → N14 → N7 → N12.
- ee4ebf8 N9 done. dashboard mail reading pane: orderChipsFor() detects `#?\d{4}` (bare number only
  chips if #-prefixed or a known order → no year/price false links), renders live-status chip →
  go('orders'). Detection logic verified in isolation. 500 green. **8/14 done.** Next: N4.
- 38ba8f9 N4 done. Order-level `customerEmailedAt` (manifest get/setEmailedAt, review.markCustomerEmailed,
  POST /<order>/emailed, studio boardEntry.emailedAt, reviewState exposes it). Generator held panel +
  dashboard Potřebuje vás show "Čeká na zákazníka od X (N dní)" (danger >5) or "e-mail neodeslán",
  with a mark/undo button. manifest round-trip test. 501 green. **9/14 done.**
  Remaining: N8 (board Stáří/Stránky), N10 (sent staleness), N14 (Nastavení), N7 (unify shells), N12 (lightbox).
- da3c4f3 N8 done. studio boardEntry.expectedPages/missingPhotos (from intake count finding);
  buildBoard injected createdAt (studioBoard = folder birthtime, mtime fallback). dashboard: "Stáří"
  col (board only, fmtAge), Fotky→Stránky w/ product denominator + "(N fotka chybí)". headers +
  colspans updated. Test for derived fields + age. 502 green. **10/14 done.**
  Remaining: N10 (sent staleness), N14 (Nastavení), N7 (unify shells, big), N12 (lightbox, big).
- c4cf3e7 N10 done. markDelivered stamps sent PDF mtime into delivered.json; studioBoard `stale`
  predicate (current PDF mtime > sent + 1s), entry.stale only for SENT. dashboard: "zastaralé" chip +
  "Odeslat znovu" primary action (reuses /deliver, re-stamps → clears). End-to-end test. 503 green.
  **11/14 done.** Remaining: N14 (Nastavení screen), N7 (unify shells, big), N12 (lightbox, big).
- 0de0937 N14 done. GET /api/settings = read-only wiring status (folders, generator/shopify/ai/mail
  configured + safe host/user only, whatsapp state, autopilot last-run from readReport, retentionDays);
  never renders a token/password/baseUrl. Dashboard Nastavení view (footer nav) w/ status cards +
  editable inbox folder that repoints the generator via POST /api/_scan. Test asserts host surfaces but
  the token path / secret key names never do. components.css .settings block. 504 green. **12/14 done.**
  Remaining: N7 (unify shells, big), N12 (lightbox + keyboard review, big).
- 3784e77 N12 done. Generator page: tile click → lightbox with original+coloring side by side, tap-to-
  zoom 1:1, and keyboard review (←/→ move, A schválit, B špatně, R přegenerovat, Esc). Review set
  snapshotted as stable (order,base) keys on open so nav/auto-advance survive the attention re-sort;
  each key re-resolves to the live tile so images + offered actions reflect now; a keyboard verdict is
  a no-op unless the tile offers it; approve/reject auto-advance, redo stays. Frontend-only (no DOM test
  harness); parse-checked. 504 green. **13/14 done.** Remaining: N7 (unify shells, big).
