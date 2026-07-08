# Fotomalovánky Order Automation

Local tool that batch-generates coloring-book versions of order photos and drives
the print-ready A4 PDF for **fotomalovanky.cz**. It sits between the existing
Chrome extension (which downloads order photos from Shopify) and the print
builder, automating the tedious per-photo generation loop.

Plan: `docs/plans/2026-07-08-001-feat-fotomalovanky-order-automation-plan.md`.

> **Status: Phase 0 (walking skeleton).** The offline core is built and tested, and
> **both live seams are implemented**:
> - **Generator (U2):** scripted HTTP API — resolved *and live-validated*
>   (`generator.mode = "api"`; `docs/spikes/2026-07-09-u2-generator-api.md`).
> - **Builder (U5):** Playwright + headless-Chromium print pipeline — resolved and
>   coded, *pending a live validation run* (`docs/spikes/2026-07-09-u5-builder.md`).
>   Requires `npx playwright install chromium` once (the browser binary is skipped by
>   a plain `npm install`).

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

Runs the offline suite (config validation, output naming, the `state.json` state
machine, and the QC heuristics) with Node's built-in test runner — no network, no
installed dependencies required.

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

## Finishing Phase 0 (what's left)

Both seams are resolved (U2 live-validated; U5 coded). To close Phase 0:

1. `npx playwright install chromium` — one-time, for the builder's headless print path.
2. **A live builder validation run** — build a real order folder to a PDF and eyeball it
   against the current manual output (`… Final.pdf`).
3. Confirm the operator's standard **title/cover routine** so the builder defaults match.

That completes the walking skeleton: one order proven end-to-end to a print-ready A4 PDF.

## Layout

```
src/
  config.js              # load/validate config; redact secrets for logs
  organize.js            # builder-compatible output naming (<base>.jpg + <base>_bw.png + <base>.svg)
  manifest.js            # state.json read/write + state machine + builder gate
  qc.js                  # pure QC heuristics (near-blank / near-solid / empty-SVG)
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
