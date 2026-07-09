# Fotomalovánky Order Automation

Local tool that batch-generates coloring-book versions of order photos and drives
the print-ready A4 PDF for **fotomalovanky.cz**. It sits between the existing
Chrome extension (which downloads order photos from Shopify) and the print
builder, automating the tedious per-photo generation loop.

Plan: `docs/plans/2026-07-08-001-feat-fotomalovanky-order-automation-plan.md`.

> **Status: Phase 1 (build-out).** Both live seams are implemented and the value gate
> (U8) is passed, so the batch pipeline is being built on top:
> - **Generator (U2):** scripted HTTP API — resolved *and live-validated*
>   (`generator.mode = "api"`; `docs/spikes/2026-07-09-u2-generator-api.md`).
> - **Builder (U5):** Playwright + headless-Chromium print pipeline — resolved and
>   coded, *pending a live validation run* (`docs/spikes/2026-07-09-u5-builder.md`).
>   Requires `npx playwright install chromium` once (the browser binary is skipped by
>   a plain `npm install`).
> - **Value gate (U8):** passed — `docs/spikes/2026-07-09-u8-value-gate.md`. The shipped
>   config runs **8 diffusion steps**, which fixed both the missing edges and the
>   cut-off limbs.
> - **Ingest + batch (U3):** done — resumable, one `state.json` per order.
> - **Review gate (U4):** done — a local review grid over `state.json`.
> - **Next:** U6 (orchestration), U7 (packaging).

## Requirements

- **Node ≥ 20** (this machine has v24). No Python needed.
- `npm install` (pulls Playwright + sharp — only needed once the live drivers are wired).

## Setup

1. `cp config.example.json config.json` (config.json is **gitignored** — it holds your
   token-scoped generator URL and never enters source control).
2. Fill in `config.json`:
   - `generator.baseUrl` — your token-scoped URL, e.g. `https://fotomalovanky-app.onrender.com/<your-token>/`
   - `generator.mode` — `"api"` (resolved by the U2 spike; the example config ships this).
   - `generator.variant`, `diffusionSteps`, `positivePrompt`, `negativePrompt` — the example
     ships your captured defaults; adjust `variant` (a `"<model>_<megapixels>"` key like `2509_1.5`) if you prefer another.
   - `builder.baseUrl` — the print builder URL
   - `retentionDays` — customer-photo retention window (default 30)

## Run the tests

```bash
npm test
```

Runs the offline suite (config validation, ingest, output naming, the `state.json`
state machine, the QC heuristics, the batch's resume/failure behaviour, and the
generator's retry logic) with Node's built-in test runner — no network.

## Run the walking skeleton

```bash
npm run skeleton -- <path-to-one-photo> [orderDir]
```

Wires one photo → generator → the builder triple (`<base>.jpg` + `<base>_bw.png` +
`<base>.svg`) → builder → PDF. Both seams are implemented; a full run needs
`npx playwright install chromium` first (for the builder).

You can also exercise either seam directly:

```bash
node src/generator/apiDriver.js <path-to-one-photo> [outDir]   # generator only
node src/builder/builderDriver.js <order-folder> [outPdfPath]  # builder only (needs chromium)
```

## Run a real batch (generation only, no PDF yet)

```bash
npm run batch -- <inbox-folder> [outbox-folder]
```

Point it at the folder the Chrome extension downloads into. Every photo-bearing
subfolder is one order; you can also point straight at a single order folder. Each
order becomes `<outbox>/<order>/` holding the builder triple per photo plus a
`state.json` manifest.

**The order number comes from the photo names** (`1523_img0001_-_…`), not the folder
name — folder names get hand-edited, and one real sample folder is named *1522* while
holding eight *1523* photos. If the two disagree, the run says so.

The run is **resumable and idempotent**: `state.json` is written after every photo, so
an interrupted batch picks up exactly where it stopped. Re-running regenerates only
photos that are new, auto-flagged (a redo is a fresh roll of a stochastic generator),
or failed. It never re-generates a photo you are repairing by hand — that would
overwrite your work. One photo's failure is recorded and the batch continues.

The PDF step is not wired into the batch yet (U6); use `npm run skeleton` or the
builder CLI for that.

## Review and redo the bad ones

```bash
npm run review -- <inbox-folder> [outbox-folder]
```

Opens a local page (127.0.0.1 only) showing every photo of every order: the original
beside its coloring page, sorted so the ones needing you come first. Per tile you can
**Approve**, **Mark bad**, **Redo** (regenerate — a fresh roll of a stochastic
generator), or **Fix by hand** (repair it in the generator or Figma, save the new
`<base>.svg` and `<base>_bw.png` into the order folder, then click *I've replaced it*).

The rule the whole gate exists for: **a flagged photo is never auto-approved.** Clean
results advance on their own; anything the QC tripwire or your eye doubted has to be
approved by hand before it can reach the PDF. A hand-repaired photo re-enters review as
`pending_review` — a handoff is a redo, not a shortcut past review.

Every verdict is written straight to the order's `state.json`, which is the same file
the batch reads to resume and the builder gate reads to decide what to print. Closing
the tool never loses a decision. You can leave the page open while a batch runs; tiles
fill in as photos complete.

The generator's token-scoped URL is never sent to the page — *Open generator* is a
request that makes the **server** launch your browser, so the token stays out of the
DOM and out of any screen recording.

Browser smoke (needs `npx playwright install chromium`, not part of `npm test`):

```bash
npm run grid-smoke -- --shot grid.png
```

## What's left

1. `npx playwright install chromium` — one-time, for the builder's headless print path.
2. **A live builder validation run** — build a real order folder to a PDF and eyeball it
   against the current manual output (`… Final.pdf`).
3. Confirm the operator's standard **title/cover routine** so the builder defaults match.
4. **U6** — one "Go" run: batch → review gate → builder → per-order PDF, and a launcher
   that starts the review grid instead of the operator running two commands.
5. **Measure the redo rate on the shipped config.** The 15% in the U8 doc was the *old*
   4-step config; the 8-step config has not been counted on a real batch yet. The review
   grid is the instrument — the verdicts now land in `state.json`, so the rate can be
   counted from a real order instead of estimated.

## Layout

```
src/
  config.js              # load/validate config; redact secrets for logs
  ingest.js              # extension folders -> order/photo model
  organize.js            # builder-compatible output naming (<base>.jpg + <base>_bw.png + <base>.svg)
  manifest.js            # state.json read/write + state machine + builder gate
  qc.js                  # pure QC heuristics (near-blank / near-solid / empty-SVG)
  qcFiles.js             # sharp adapter: decodes the outputs, feeds qc.js
  batch.js               # resumable per-order generation (U3)
  review.js              # the review gate: approve / reject / redo / manual handoff (U4)
  ui/
    server.js            # local review server (127.0.0.1 only; the token never reaches the page)
    static/index.html    # the review grid
  generator/
    driver.js            # GeneratorDriver interface
    apiDriver.js         # scripted HTTP driver (implemented — the active generator seam)
    browserDriver.js     # Playwright UI driver (kept as documented fallback)
    factory.js           # picks api vs browser from config.generator.mode
  builder/
    builderDriver.js     # Playwright + headless-print driver (implemented; needs chromium)
  skeleton.js            # Phase-0 walking-skeleton runner
test/                    # offline unit tests (node --test)
```

## Data handling

Customer photos, generated outputs, and PDFs stay **local only** — the tool sends
nothing to the cloud beyond what the generator already receives. Photos are purged
once an order's PDF is confirmed printed, or after `retentionDays`. Playwright debug
traces are gitignored and strip the token URL and photo bytes.
