# Fotomalovánky Order Automation

Local tool that batch-generates coloring-book versions of order photos and drives
the print-ready A4 PDF for **fotomalovanky.cz**. It sits between the existing
Chrome extension (which downloads order photos from Shopify) and the print
builder, automating the tedious per-photo generation loop.

**Using the tool?** Read [`docs/OPERATOR.md`](docs/OPERATOR.md) — it's the whole thing in
plain words, no terminal. Double-click `Setup.cmd` once, then `Fotomalovanky.cmd` to work.

The rest of this file is for whoever maintains the code.

Plan: `docs/plans/2026-07-08-001-feat-fotomalovanky-order-automation-plan.md`.

> **Status: Phase 1 (build-out).** Both live seams are implemented and the value gate
> (U8) is passed, so the batch pipeline is being built on top:
> - **Generator (U2):** scripted HTTP API — resolved *and live-validated*
>   (`generator.mode = "api"`; `docs/spikes/2026-07-09-u2-generator-api.md`).
> - **Builder (U5):** Playwright + headless-Chromium print pipeline — resolved, coded, and
>   *live-validated on a full 8-photo order* against the operator's own `1523 Final.pdf`:
>   same 20 pages, same A4, every content page's ink within one pixel of the manual book
>   (`docs/spikes/2026-07-09-u5-builder.md`). Requires `npx playwright install chromium` once
>   (the browser binary is skipped by a plain `npm install`).
> - **Value gate (U8):** passed — `docs/spikes/2026-07-09-u8-value-gate.md`. The shipped
>   config runs **8 diffusion steps**, which fixed both the missing edges and the
>   cut-off limbs. That same comparison found the 8-step config **fills hair and dark
>   clothing solid black** on some photos; `qc.js` now flags it (`solid-fill`).
> - **Ingest + batch (U3):** done — resumable, one `state.json` per order.
> - **Review gate (U4):** done — a local review grid over `state.json`.
> - **Orchestration (U6):** done — `npm run go` runs the whole pipeline to per-order PDFs.
> - **Packaging (U7):** done — `Setup.cmd` / `Fotomalovanky.cmd`, and a **Go** button in the
>   grid, so the operator never opens a terminal.
> - **Next:** a first real batch run by the operator, which also measures the redo rate and
>   gives the labelled set the solid-fill thresholds need.

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

## How the operator runs it

Double-click **`Fotomalovanky.cmd`**. It starts a local server on `127.0.0.1:4173` and opens
the page: choose a folder, press **Go**, watch the log, review what's flagged. Same pipeline
as the CLI below, driven from the page. `Setup.cmd` does the one-time `npm install` +
`playwright install chromium` + `config.json`.

There is no bundled `.exe`: `sharp` ships a native binary and Playwright keeps Chromium in a
separate cache, so a single-file build would still need both on disk. A `.cmd` is a
double-click launcher, and it fails with an instruction rather than a stack trace when Node
or the setup is missing.

While a run is going, **every verdict button and the title field are disabled**. The run
holds each order's `state.json` in memory and rewrites it after each photo; a verdict saved
meanwhile would be silently overwritten. The server refuses those requests too — the page
just doesn't offer them.

## Run the whole thing from a terminal

```bash
npm run go -- <inbox-folder> [outbox-folder]
```

Ingest → generate → QC → **review gate** → builder → one print-ready A4 PDF per order,
saved as `<outbox>/<order>/<order> Final.pdf`. It ends with a run report:

```
Run report
  1510    done    …\1510\1510 Final.pdf
  1523    held    2 photo(s) waiting for you in the review grid
  1534-1  done    …\1534-1\1534-1 Final.pdf
  1534-2  held    2 photo(s) waiting for you in the review grid
  1499    FAILED  1 photo(s) failed to generate: img0003 — generator seam (poll): …

2 done, 2 waiting for you, 1 failed.
Review them:  npm run review -- <inbox>     then run this again.
```

`1534-1` and `1534-2` are the two books of order 1534 — one customer, one checkout, one
parcel. Each is generated, held and built on its own.

**The review gate is a wall, not a step.** An order is printed only when *every* photo is
clean or explicitly approved. A single flagged photo holds back its own order's PDF and
nothing else — the other orders still print. Approve it in the review grid and run `go`
again.

Everything is resumable and idempotent: photos already done are not regenerated, and a
PDF is reprinted only when something actually changed (`state.json` is the order's
"last decided" clock). Add `--force` to reprint anyway, `--review` to open the review
grid automatically when an order is waiting for you.

A break at either seam is caught, named in plain language (`generator seam (poll): …` /
`builder seam (load): …`), recorded against that order, and the rest of the batch
continues. No stack traces.

### The title page

The builder prints a title page only when the order has **dedication text** — and every book the
operator ships has one, so an order without it would print a structurally different (2 pages
shorter) book. **The run holds such an order rather than printing it**, exactly as it holds an
order with a photo awaiting review. Set the text per order in the review grid and run again.

`config.json`'s `builder.pdf` holds the layout defaults (`mode`, `coverCount`, rotation); a
per-order dedication always wins over a configured `title`/`dedication` default, and a configured
default is enough to release the hold. `coverCount` is how many coloring pages appear as
thumbnails on the title page — the operator's books use **4**. It selects the *first* N photos of
the order; choosing *which* four still needs the builder page by hand. (`addAllCovers: true` is
the old spelling of `coverCount: 8`.)

### Czech or German books

The builder brands the generated pages in one of two languages. In **DE** it prints the German logo
(`logo-de.svg`) instead of the Czech one and drops the "Vyrobeno s ❤️ v 🇨🇿" title-page footer.

Which one an order gets is a property of **what the customer bought**, so it maps off the
product/variant exactly as the print format does — `delivery.languageMap`, keyed by variant title
(preferred) or product title, with `delivery.language` as the default for anything unmapped:

```json
"delivery": {
  "language": "cz",
  "languageMap": { "<the German product or variant title, exactly as Shopify spells it>": "de" }
}
```

> **No German product exists in the shop yet.** The plumbing is finished and tested, but the map has
> nothing real to key on, so **every order resolves to Czech today** — which is the correct and safe
> behaviour, not a bug. When the German product is created, add its exact title here and orders of it
> build in German from that moment. Nothing else needs changing.

A mixed batch is fine: each order resolves on its own, and no config edit is needed between a Czech
book and a German one.

Two deliberate safety choices. An order that maps to **cz**, or maps to nothing at all, leaves the
builder's language control untouched — Czech is its own default, so every existing order builds
exactly as before, even against a builder deploy that has no language toggle. A **de** order does
reach for the control, and a missing one fails that order loudly: printing the Czech logo onto a
German customer's book is not something to discover after it ships. A typo in the map (`"german"`)
fails the same way rather than silently falling back.

## Run generation only (no PDF)

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

**One purchase can hold more than one book.** A customer who buys the product twice in
one checkout gets one job per book, each with its own photos, dedication and PDF. Those
carry a position suffix — `1234-1`, `1234-2` — in the folder name, the photo names and
the run report. A suffix is not an error and not the folder/filename mismatch above; it
means "book 1 of 2 in that parcel". An ordinary single-book order is unsuffixed, exactly
as before. The split reads Shopify's line items, so it only happens on orders the tool
fetched itself — a folder pulled by hand has no line-item information and arrives as one
merged job.

The run is **resumable and idempotent**: `state.json` is written after every photo, so
an interrupted batch picks up exactly where it stopped. Re-running regenerates only
photos that are new, auto-flagged, or failed. It never re-generates a photo you are
repairing by hand — that would overwrite your work. One photo's failure is recorded and
the batch continues.

**A re-roll always changes the step count.** At 8+ steps this generator is deterministic and
its API takes no seed, so re-sending the same request returns the same page. Every re-roll of
a flagged photo therefore climbs one diffusion step (`generator.maxDiffusionSteps`, default 12).
At the ceiling the photo stops going back to the GPU and says so: approve it, repair it by hand,
or change `generator.variant`. A photo that *failed* (a lost GPU job) retries at the same step
count — there was no page to differ from.

This is the generation half of `npm run go`, without the builder. Useful when you want to
generate overnight and review in the morning.

## Review and redo the bad ones

```bash
npm run review -- <inbox-folder> [outbox-folder]
```

Opens a local page (127.0.0.1 only) showing every photo of every order: the original
beside its coloring page, sorted so the ones needing you come first. Per tile you can
**Approve**, **Mark bad**, **Redo** (regenerate at one diffusion step higher — an identical
re-run would return an identical page), or **Fix by hand** (repair it in the generator or Figma, save the new
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

1. **A first real batch run by the operator, following only `docs/OPERATOR.md`.** That is
   U7's actual verification, and it needs the operator, not me.
2. **Re-tune the solid-fill thresholds.** They are calibrated on one order (16 rasters, 2 of
   them bad — see `DEFAULT_QC` in `src/qc.js`), and the margin on the subtler of the two is
   only ~2× either side. The review grid's verdicts in `state.json` are the labelled set.
3. **Let the operator choose *which* photos go on the title page.** `builder.pdf.coverCount`
   takes the first N; the manual books do not always use the first four.
4. **Measure the redo rate on the shipped config, and set `manualTouchThreshold`.** The 15% in
   the U8 doc was the *old* 4-step config. On order 1523 the 8-step config filled 2 of 8 photos
   solid black, so the real rate may be worse than the number that passed the value gate. The
   review grid is the instrument — the verdicts land in `state.json`.
5. **The purge.** `retentionDays` is validated and then ignored — see *Data handling*. It needs
   a `printed` verdict (and a button that sets it) before it can be automated.
6. **Rotate the generator token.** It is visible in the operator's screen recording. Every
   surface of this tool keeps it hidden; that recording is the remaining exposure.

## Layout

```
Fotomalovanky.cmd        # double-click launcher (operator)
Setup.cmd                # one-time setup (operator)
docs/OPERATOR.md         # the operator's manual
src/
  config.js              # load/validate config; redact secrets for logs
  ingest.js              # extension folders -> order/photo model
  organize.js            # builder-compatible output naming (<base>.jpg + <base>_bw.png + <base>.svg)
  manifest.js            # state.json read/write + state machine + builder gate
  qc.js                  # pure QC heuristics (near-blank / near-solid / solid-fill / empty-SVG)
  qcFiles.js             # sharp adapter: decodes the outputs, feeds qc.js
  batch.js               # resumable per-order generation (U3)
  orchestrator.js        # the "Go" run: generate -> review gate -> builder -> PDF (U6)
  review.js              # the review gate: approve / reject / redo / manual handoff (U4)
  ui/
    server.js            # local server: Go button + review grid (127.0.0.1 only; the token never reaches the page)
    static/index.html    # the page
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
nothing to the cloud beyond what the generator already receives. Playwright debug
traces are gitignored and strip the token URL and photo bytes.

> **There is no purge yet.** `retentionDays` is read and validated, and then nothing uses it:
> no code in this repo deletes a customer's photos. Deleting them when the book is printed,
> or after 30 days, is currently the operator's job, and `docs/OPERATOR.md` asks them to do
> it. Automating it needs a *printed* verdict the tool does not have — nothing today records
> that a PDF actually reached the printer — so it is a unit of work, not a cleanup. Until it
> exists, do not describe this tool as purging anything.
