---
title: Order Intake Gate — input QC, expected-count, and photo-request emails
type: feat
date: 2026-07-11
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
note: Stack is Node/Playwright (the 2026-07-08 master plan's KTD1 "Python" is stale — see memory env-node-not-python).
---

# Order Intake Gate — input QC, expected-count, and photo-request emails

## Goal Capsule

- **Objective:** Add a pre-generation gate that checks each order's *input* photos before any GPU is spent — count vs expected, duplicates, resolution, blur, exposure, decodability — records the findings, and on a blocking problem **skips the whole order** and auto-writes a copy-paste Czech email asking the customer to reply with a replacement photo. This is the SOP's Step 4 and its stated automation priorities 1–4, none of which the tool does today.
- **Fits under the master plan:** The existing quality gate (master plan R7/R8, `qc.js`) is entirely *output*-side — it judges the generated coloring raster. This plan adds the missing *input*-side gate. It reuses the same manifest (`state.json`), the same review grid, and the same "tripwire, not judge; operator decides" philosophy.
- **Authority hierarchy:** This plan → existing repo conventions → operator preference. A scope/approach change is escalated, not guessed.
- **Stop conditions (escalate, don't guess):** If a real Shopify GraphQL capture shows the product's expected photo count is *not* recoverable from the order (no size in product/variant title, no usable field), stop the M2 expected-count work and keep the count check advisory — the rest of the gate still ships. Nothing here blocks generation permanently on a guess.
- **Execution profile:** Same as the tool — on-demand, single-operator, local, low volume.

---

## Problem Frame

Today `ingest.js` only counts and groups photos; `qc.js`/`qcFiles.js` only assess generated output. So every problem with the *customer's* photos is caught by the operator's eye (SOP Step 4): too few photos, duplicates, blurry/dark/tiny images, files that won't open. Two costs follow. First, the tool will happily spend generator minutes on a photo that never should have been generated. Second, the "email the customer for a better photo" branch is 100% manual — the operator writes each Czech email by hand.

The gate closes both: it inspects the photos first, holds the order when a human conversation is needed, and hands the operator a ready-to-send draft.

---

## Requirements

**Input QC**
- IN1. Before generation, each order's photos are checked and the findings recorded in that order's `state.json`.
- IN2. Checks: decodability, resolution, blur, exposure, exact + near duplicates, and count vs expected. **Non-goals for this plan:** face/eye detection, copyright/licensed-character detection, reliable screenshot detection (deferred; a weak aspect-ratio hint is the only nod).
- IN3. Every finding carries a severity — `ok` / `warn` / `hold`. Defaults are conservative: the gate fires only on objective, egregious problems, favouring false-negatives (a marginal photo through costs one review; a blocked good order costs trust).
- IN4. A `hold` **skips the whole order** — no generation — until the photos are fixed. `warn`/`ok` proceed, with any finding recorded and shown.
- IN5. The hold is re-derived from the current photos on every run, so it **lifts automatically** once the photo set is corrected; there is no manual flag to clear. The operator can also **override** a hold ("proceed anyway").
- IN6. Findings surface in the review grid and as a human-readable `qc_report.html` in the order folder (SOP Step 3's `issues/qc_report.txt` equivalent).

**Expected count**
- IN7. The expected photo count comes from the *order* (the product/variant purchased), captured by the Chrome extension into `objednavka.json`. It is never inferred from the number uploaded — that would make "customer uploaded too few" undetectable.
- IN8. When the expected count is unknown (old orders, unparseable product), the count check is **advisory only**, never a hold. The operator can type a per-order override.

**Photo-request emails**
- IN9. On a hold, the tool auto-writes a copy-paste **Czech** email keyed to the finding — missing / duplicate / poor-quality / unreadable — instructing the customer to **reply to the email with the photo attached**.
- IN10. Emails are **drafts only, never auto-sent** (SOP hard rule). Deterministic templates that obey the SOP style rules (polite, human, no em dashes, restrained exclamation, formal `paní/pane` + surname, signed `David / Fotomalovánky.cz`). The operator owns the final wording.
- IN11. The greeting personalises with the customer's surname when the extension captured it; otherwise `Dobrý den,`. The customer's email address is included when available, else left for the operator.

---

## Key Technical Decisions

- **KTD-A. Mirror the existing pure/adapter split.** `src/inputQc.js` (pure heuristics over decoded pixels + metadata, unit-testable with synthetic buffers) ↔ `src/inputQcFiles.js` (sharp adapter), exactly like `qc.js` ↔ `qcFiles.js`. Order-level logic (duplicates, count, verdict, report) in `src/intake.js`.
- **KTD-B. sharp only, no new dependencies.** sharp already decodes in `qcFiles.js`. Keeps packaging (master plan U7) and the zero-code operator simple.
- **KTD-C. Tripwire, not judge.** Same stance as `qcFiles.js`. Objective/egregious only; the operator's grid remains the judge of likeness/quality. Thresholds calibrated on real orders, shipped conservative and tightened from data.
- **KTD-D. Skip the whole order on hold; auto-lift.** Operator's decision (2026-07-11): wait until the customer sends new photos rather than generate partial. The hold is stateless (re-derived each run), so corrected photos lift it with no flag to clear.
- **KTD-E. Emails are deterministic templates, not an LLM call.** A local offline tool wants stable, style-compliant, copy-paste text — not text that varies per run and might break the "no em dashes" rule. Optional LLM polish is a later add-on.
- **KTD-F. Expected count comes from the shop, sidecar-carried, degrades to advisory.** Follows `orderInfo.js`: trusted fields only, a missing/unparseable value is "no answer," never a wrong one.
- **KTD-G. Extension change goes through `npm run patch-extension`, gated on a one-time GraphQL capture.** The line-item field path can't be read from the minified bundle; capture one real `OrderFulfillmentOrdersQuery` response, write it up in `docs/spikes/`, then patch.

---

## Design

### New modules

| File | Role | Mirrors |
|---|---|---|
| `src/inputQc.js` | Pure per-photo heuristics over decoded pixels + metadata. | `qc.js` |
| `src/inputQcFiles.js` | sharp adapter: decode one photo → feed the pure fns. | `qcFiles.js` |
| `src/intake.js` | Order-level pass: per-photo + duplicates + count → verdict, writes `state.json` intake block, renders the report, produces the email draft. | `batch.js` |
| `src/emailDrafts.js` | Finding → Czech template, slot fill, style rules. | (new) |

### Per-photo checks

Decode once: `sharp(path).rotate()` (honour EXIF, as the generator already does) → greyscale → resize short-side 512 (scale-normalises, bounds cost) → raw buffer; plus `metadata()` for true dimensions.

| Check | Measure | Default cutoff | Reason string | Severity |
|---|---|---|---|---|
| decodability | sharp throws | — | `unreadable` | hold |
| resolution (hard) | `min(w,h)` px, `w*h` MP | `< 600px` or `< 0.15 MP` | `low-resolution (0.2 MP)` | hold |
| resolution (soft) | MP | `< 0.5 MP` | `smallish (0.4 MP)` | warn |
| blur | variance of Laplacian on 512-grey | `< 60` *(calibrate)* | `possibly-blurry (var 42)` | warn |
| exposure — dark | mean luminance | `< 40` | `dark` | warn |
| exposure — bright | mean luminance | `> 225` | `overexposed` | warn |
| exposure — clipping | frac px ≤4 or ≥251 | `> 0.35` | `crushed/blown detail` | warn |
| shape | aspect ratio | outside `[0.2, 5]` | `unusual-shape (maybe a screenshot)` | warn (weak) |

Each returns `{ check, verdict, reason, value }` — same shape as `assessColoringPixels`.

### Order-level checks (`intake.js`)

- **Duplicates** — exact: equal file sha1 → `duplicate (identical file)` · **hold** (a distinct photo is genuinely missing). Near: 64-bit dHash, pairwise Hamming ≤ `dupHammingMax` (def 5) → `possible-duplicate: imgA ≈ imgB` · **warn** (burst shots are legitimately similar; operator confirms).
- **Count vs expected** — `unique = uploaded − exactDupExtras`.
  - known & `unique < expected` → `missing photos (5 of 8)` · **hold**.
  - known & `unique > expected` → `more photos than the product includes (10 vs 8)` · **warn**.
  - unknown → `8 photos uploaded; expected count unknown` · **info**.

**Order verdict** = worst severity present (`hold` > `warn` > `ok`).

### Severity → behaviour (in `orchestrator.runPipeline`, before `generateOrder`)

```js
const expected = resolveExpected(order, config);
const intake = await assessIntake({ order, orderDir, config, expected });
onEvent({ type: 'intake', orderId, verdict: intake.verdict, findings: intake.findings });

if (intake.verdict === 'hold' && !intake.override && !force) {
  writeEmailDraft(orderDir, intake);                 // draft-email.txt next to the order
  report.push({ orderId, orderDir, status: ORDER_STATUS.HELD, reason: intakeSummary(intake) });
  onEvent({ type: 'order-done', orderId, status: ORDER_STATUS.HELD, reason });
  continue;                                          // no GPU spent
}
// warn/ok → existing generateOrder → review gate → build (unchanged)
```

`assessIntake` creates `orderDir` (recursive mkdir — harmless, `generateOrder` does the same) and merges the intake block into `state.json`. `generateOrder` re-reads the manifest from disk, so the block persists. Reuses `ORDER_STATUS.HELD`; the grid distinguishes an intake hold by `intake.verdict === 'hold'` with no eligible photos yet.

### Data model — `state.json` intake block

```jsonc
{
  "orderId": "1523",
  "dedication": "Pro Jiříčka",
  "intake": {
    "checkedAt": "2026-07-11T…",
    "expected": 8, "uploaded": 8, "unique": 8,
    "verdict": "hold",
    "override": false,
    "emailCase": "missing",
    "findings": [
      { "check": "count", "severity": "hold", "reason": "missing photos (5 of 8)" },
      { "check": "blur", "severity": "warn", "base": "1523_img0003_…", "reason": "possibly-blurry (var 42)" }
    ]
  },
  "photos": { "…": { "status": "ok" } }
}
```

Plus `qc_report.html` (thumbnails + finding per photo, in the style of the outbox `contact.html`) and `draft-email.txt` in the order folder.

### Config block (`config.example.json`)

```jsonc
"intake": {
  "minMegapixels": 0.5, "hardMinMegapixels": 0.15, "minShortSidePx": 600,
  "blurVarianceMin": 60,
  "darkMeanMax": 40, "brightMeanMin": 225, "clipFractionMax": 0.35,
  "dupHammingMax": 5,
  "expected": { "source": "sidecar", "productSizeRegex": "(\\d+)\\s*fot", "map": {} }
}
```

### Photo-request emails (`emailDrafts.js`)

| Intake finding | Template |
|---|---|
| `missing photos (N of M)` | ask for the N missing photos |
| `duplicate (identical file)` / near-dup | note the repeat; replace or confirm intentional |
| `low-resolution` / `possibly-blurry` / `dark` | ask for a sharper/better version of that photo |
| `unreadable` | ask them to re-upload that file (it did not open) |

Slots: `{order} {expected} {uploaded} {missing} {surname} {email}` + which photo(s) by position. Always closes with "reply to this email with the photo attached." Example (draft — operator owns the Czech):

```
Předmět: Fotomalovánky.cz – objednávka {order}

Dobrý den{, paní/pane {surname}},

děkujeme za Vaši objednávku {order}. Vybraný produkt počítá s {expected}
fotkami, zatím se nám jich ale sešlo {uploaded}. Mohli byste nám prosím
{missing} chybějící poslat odpovědí na tento e-mail s fotkou v příloze?

Děkuji a přeji hezký den,
David
Fotomalovánky.cz
```

### Extension + sidecar (M2)

`injected.js` already parses the `OrderFulfillmentOrdersQuery` GraphQL for `customAttributesV2`. Extend that same walk to also collect line items (`title`, `variantTitle`, `quantity`) and customer (`surname`, `email`); the background script parses expected count via `productSizeRegex`/`map` and writes:

```jsonc
{ "order": "1523", "dedication": "Pro Jiříčka",
  "expectedPhotos": 8, "customer": { "surname": "Hofbauer", "email": "…" },
  "products": [ { "title": "Fotomalovánky 8 fotek", "variant": "…", "qty": 1 } ] }
```

Gated on a one-time capture (KTD-G). Edge: qty>1 / multiple line items → mark `expected: "ambiguous"` → advisory, don't guess.

### `orderInfo.js` changes

Extend the trusted-field reader (drops wrong types, as it already does) to return `expectedPhotos`, `customer`, `products`. `resolveExpected(order, config)` order: sidecar `expectedPhotos` → operator override in `state.json` → `null` (advisory). Old orders lack the fields → advisory; never an error.

---

## Milestones

- **M1 — tool-only, ships without the extension.** `inputQc.js` + `inputQcFiles.js` + `intake.js` + `emailDrafts.js` + config block + orchestrator hold + report lines + grid intake panel (proceed-anyway/override) + `qc_report.html` + `draft-email.txt` + unit tests. Count check advisory; emails use the fallback greeting. Delivers decodability / resolution / blur / exposure / duplicate immediately.
- **M2 — extension, gated on a live capture.** Capture `OrderFulfillmentOrdersQuery` → `docs/spikes/2026-07-11-order-line-items.md` → extend `injected.js` + background → `patch-extension`. Count check becomes authoritative (missing-photos hold works); emails gain surname + address.
- **M3 — calibration + wording.** Tune `blurVarianceMin` / `darkMeanMax` / `dupHammingMax` on the real order archive (like `qc.js` was tuned on order 1523). Operator's pass on the Czech templates (gender agreement, tone).

---

## Verification Contract

- **Unit:** `inputQc.js` pure fns against synthetic `Uint8` buffers — flat → low Laplacian variance (blurry), checkerboard → high, all-`10` → dark, identical inputs → Hamming 0, count arithmetic with duplicates.
- **Integration:** run intake over the `02 Example orders` fixtures + a sample of real orders; eyeball the findings for false-positives.
- **Behavioural:** a hold order (a) is not generated, (b) writes a `draft-email.txt` of the right case, (c) lifts on the next run once photos are corrected; a warn order still generates.

---

## Open items / inputs needed

1. **Calibration source (M3):** confirm `C:\Users\David\Desktop\Objednavky Hotove` is the full order history to tune against. Photos stay local; never committed to git.
2. **Product title format (M2):** the real Shopify product/variant names, or lift from the M2 capture.
3. **Wording (M3):** operator's pass on the Czech templates.
