# Fotomalovánky Order Automation

Local tool that batch-generates coloring-book versions of order photos and drives
the print-ready A4 PDF for **fotomalovanky.cz**. It sits between the existing
Chrome extension (which downloads order photos from Shopify) and the print
builder, automating the tedious per-photo generation loop.

Plan: `docs/plans/2026-07-08-001-feat-fotomalovanky-order-automation-plan.md`.

> **Status: Phase 0 (walking skeleton).** The offline core is built and tested.
> The two live seams — the generator and the builder — are stubbed until the HAR
> capture (see *Proving the seam*). Running the skeleton today stops with a clear
> message at whichever live seam it reaches first; that is expected and proves the
> wiring is correct ahead of the seam work.

## Requirements

- **Node ≥ 20** (this machine has v24). No Python needed.
- `npm install` (pulls Playwright + sharp — only needed once the live drivers are wired).

## Setup

1. `cp config.example.json config.json` (config.json is **gitignored** — it holds your
   token-scoped generator URL and never enters source control).
2. Fill in `config.json`:
   - `generator.baseUrl` — your token-scoped URL, e.g. `https://fotomalovanky-app.onrender.com/<your-token>/`
   - `generator.variant`, `diffusionSteps`, `positivePrompt`, `negativePrompt` — your usual defaults
   - `generator.mode` — leave `null` for now; the HAR spike sets it to `"api"` or `"browser"`
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

Wires one photo → generator → `<base>.jpg` + `<base>_bw.svg` pair → builder → PDF.
Until the live drivers are filled in it stops at the generator seam with a
plain-language message.

## Proving the seam (what's needed from the operator)

Phase 0 exists to observe and prove the two live seams. To finish it, provide:

1. **The token-scoped generator config** — pasted into `config.json` (see Setup).
2. **1–2 real sample photos.**
3. **A HAR capture** of one manual generation in the app: open the generator in the
   browser, DevTools → **Network**, do one full conversion, then right-click the
   request list → **Save all as HAR**. This reveals the upload/job/poll/download
   calls so we can decide `generator.mode = "api"` (script the calls) vs
   `"browser"` (drive the UI) — instead of guessing.
4. **OK to run Playwright against the live apps** from this machine.

With those, the generator + builder driver bodies get filled in and one photo is
proven end-to-end to a print-ready PDF (the Phase-0 stop-condition check).

## Layout

```
src/
  config.js              # load/validate config; redact secrets for logs
  organize.js            # builder-compatible output naming (<base>.jpg + <base>_bw.svg)
  manifest.js            # state.json read/write + state machine + builder gate
  qc.js                  # pure QC heuristics (near-blank / near-solid / empty-SVG)
  generator/
    driver.js            # GeneratorDriver interface
    apiDriver.js         # scripted HTTP driver (stub, pending HAR)
    browserDriver.js     # Playwright UI driver (stub, pending observation)
    factory.js           # picks api vs browser from config.generator.mode
  builder/
    builderDriver.js     # print-builder driver (stub, pending observation)
  skeleton.js            # Phase-0 walking-skeleton runner
test/                    # offline unit tests (node --test)
```

## Data handling

Customer photos, generated outputs, and PDFs stay **local only** — the tool sends
nothing to the cloud beyond what the generator already receives. Photos are purged
once an order's PDF is confirmed printed, or after `retentionDays`. Playwright debug
traces are gitignored and strip the token URL and photo bytes.
