# PROJECT_EXTRACTION.md

**Repo:** `fotomalovanky-studio` (`package.json` name: `fotomalovanky-automation`, v0.0.1, private)
**Extracted:** 2026-07-16, at commit `3c5e5fc`
**Purpose of this document:** a complete, from-scratch rebuild reference. Everything of value in this codebase, specific enough to rebuild from without reading the original source.

> **⚠️ CREDENTIALS ARE NOT IN THIS FILE.** This document lists every credential's *name, purpose, and location*, but never its value. The live secret values are in **`PROJECT_EXTRACTION.secrets.md`**, which is gitignored. This file is safe to commit; that one is not. See §3.
>
> **Why:** this repo pushes to GitHub and auto-deploys to Render. A file at the repo root holding live API keys is one `git add .` away from being public. The four live secrets (Gemini key, Shopify token, Proton Bridge password, generator URL token) are real and currently active.

---

## Table of contents

1. [Project purpose](#1-project-purpose)
2. [Architecture](#2-architecture)
3. [External services and credentials](#3-external-services-and-credentials)
4. [Data](#4-data)
5. [Business logic worth preserving](#5-business-logic-worth-preserving)
6. [AI prompts and templates](#6-ai-prompts-and-templates)
7. [Known issues and unfinished work](#7-known-issues-and-unfinished-work)
8. [What I would keep vs rebuild](#8-what-i-would-keep-vs-rebuild)

---

## 1. PROJECT PURPOSE

### What it actually does

**Fotomalovánky.cz** sells personalised colouring books: a customer uploads their own family photos to a Shopify store, and receives a printed A4 colouring book whose pages are black-and-white line-art versions of those photos.

This repo is the **operator's private back-office** that turns a paid Shopify order into a print-ready PDF and hands it to the printer. It is not the storefront and not the line-art model — it is the machine that sits between them, automating what used to be an entirely manual per-photo loop.

It has since grown well past that original scope. Today it is four tools sharing one dashboard:

| Subsystem | What it does |
|---|---|
| **Order pipeline** (the core) | Shopify order → download photos → QC them → generate line art on a GPU → QC the output → operator review → print-ready A4 PDF → WhatsApp it to the printer |
| **Kreativy** (Creative Studio) | Generates on-brand marketing ad images (a 33-occasion annual calendar of ads), AI imagery + a deterministic template renderer |
| **Blog Creator** | Generates SEO-optimised Czech blog posts and pushes them to Shopify **as unpublished drafts** |
| **Pošta** | A read/reply mail tile over the business inbox, via a local Proton Mail Bridge |

### Who uses it

**Exactly one person: David**, the business owner, on his own Windows 10 PC — plus a cloud instance on Render so it keeps running when the PC is off. A second person, **Jirka**, is the printer: he receives finished PDFs over WhatsApp and never touches this tool.

This single-operator reality explains most of the architecture. There is no multi-tenancy, no user accounts, no permissions model, no database. The UI is in Czech throughout (code and identifiers stay English). The docs (`docs/OPERATOR.md`) are written for a non-technical user who never opens a terminal — the everyday entry point is double-clicking `Fotomalovanky.cmd`.

### The core workflow, input to output

```
Shopify paid order (customer's photos + dedication text)
        │
        ├── autopilot polls the Admin API every ~10 min  ─┐
        └── or a Chrome extension drops a folder on disk  ─┤
                                                           ▼
                              inbox/<orderId>/*.jpg + objednavka.json
                                                           │
                          INTAKE GATE — input photo QC (resolution, blur,
                          exposure, duplicates, count-vs-paid)
                                    │                      │
                              hold ─┘                      │ ok/warn
                        (draft email written for           ▼
                         the operator to send)   GPU generation (RunPod)
                                                  per photo, resumable
                                                           │
                                          auto-crop + deframe the page
                                                           │
                             OUTPUT QC — near-blank / solid-fill tripwire
                                    │                      │
                            flagged ┘                      │ clean
                                    ▼                      ▼
                          REVIEW GATE — the operator approves / redoes /
                          hand-fixes every doubted page. A flagged photo
                          is NEVER auto-approved.
                                                           │
                                                           ▼
                              Print builder (headless Chromium drives a
                              separate client-side web app → page.pdf())
                                                           │
                                          outbox/<orderId>/<orderId> Final.pdf
                                                           │
                                  operator clicks "Odeslat Jirkovi"
                                                           ▼
                                    WhatsApp → the printer (Jirka)
                                                           │
                                  operator confirms print → printed.json
                                                           │
                                       ≥30 days → purge the originals
```

### The three invariants that shape everything

These are load-bearing. A rebuild that drops them will hurt real customers.

1. **The no-send invariant.** The automated overnight pipeline **never delivers anything to anyone**. It generates and stops. Every outbound message — WhatsApp to the printer, email to a customer — requires an explicit human click. This is enforced *structurally*: `src/autopilot.js` never imports the WhatsApp client. There is no flag to turn this off.
2. **The review gate is a wall, not a step.** An order prints only when *every* photo is clean or explicitly approved by a human. One flagged photo holds back its own order's PDF — and nothing else; the other orders still print.
3. **Nothing is published live.** The Blog Creator's Shopify mutation always sends `isPublished: false`. There is no publish-live code path. David publishes from the real Shopify admin, by hand.

### What this project is NOT

Worth stating plainly, because the names mislead:

- **Not the line-art model.** The photo→line-art conversion is a RunPod-hosted diffusion model behind a separate Render app (`fotomalovanky-app.onrender.com`). This repo only calls its HTTP API. **The model is not in this repo and cannot be rebuilt from it.**
- **Not the print builder.** The PDF layout engine is a separate client-side web app (`fotomalovanky-service.onrender.com`) with no HTTP API. This repo drives its DOM with Playwright and calls `page.pdf()`. **Also not in this repo.**
- **Not the storefront.** Shopify owns the store, the products, and all pricing. There is no money logic anywhere in this codebase.

A rebuild therefore inherits **two external service dependencies it does not own the source of**. Both are token/URL-addressed and both must keep working, or be rebuilt separately.

---

## 2. ARCHITECTURE

### 2.1 Tech stack, exact versions

**Runtime:** Node.js **≥20** (`package.json` `engines`), plain **ESM** (`"type": "module"`) throughout.

**There is no build step.** No TypeScript, no bundler, no transpiler, no linter/formatter config. No `tsconfig.json`, `.eslintrc*`, `.prettierrc*`, `webpack`/`vite`/`esbuild`. Source runs exactly as written.

**No web framework** — `src/ui/server.js` uses raw `node:http` `createServer` with hand-rolled routing (`req.url` split into segments, `if` chains). No Express/Koa/Fastify.

**No frontend framework** — two single-file vanilla HTML pages with inline `<script>`, polling the JSON API with `fetch`. No React/Vue/Svelte. **Zero frontend npm dependencies.**

**No database** — all state is flat JSON files on disk. The filesystem itself is the queue.

**Test runner:** Node's built-in `node --test`. No Jest/Mocha/Vitest.

#### Direct dependencies (resolved versions from `package-lock.json`, lockfileVersion 3)

| Package | Range | **Resolved** | Used for | Imported by |
|---|---|---|---|---|
| `imapflow` | `^1.4.7` | **1.4.7** | IMAP — reads the Proton Bridge inbox (127.0.0.1:1143) | `src/proton/bridgeClient.js` (lazy) |
| `mailparser` | `^3.9.14` | **3.9.14** | Parses raw RFC822 → text/HTML/attachments | `src/proton/bridgeClient.js` (lazy, `simpleParser`) |
| `nodemailer` | `^9.0.3` | **9.0.3** | SMTP — sends via Bridge (127.0.0.1:1025) | `src/proton/smtpClient.js` (lazy) |
| `playwright` | `^1.48.0` | **1.61.1** | Headless Chromium | `src/builder/builderDriver.js` (drives the print app + `page.pdf()`); `src/creatives/renderCreative.js` (HTML→PNG); `src/generator/browserDriver.js` (dead stub) |
| `qrcode` | `^1.5.4` | **1.5.4** | WhatsApp link QR → data URL | `src/whatsapp/whatsappClient.js` (lazy) |
| `sharp` | `^0.33.5` | **0.33.5** | Image decode/resize/composite (libvips) | Everywhere images are touched — see below |
| `whatsapp-web.js` | `^1.34.7` | **1.34.7** | Headless WhatsApp Web + `LocalAuth` session | `src/whatsapp/whatsappClient.js` (lazy) |

`sharp` call sites: `src/review.js` (rasterize edited SVG), `src/ui/server.js` (`thumbnail()`), `src/generator/apiDriver.js` (`prepareImageForUpload` — EXIF-rotate + downscale), `src/autoCrop.js` (ink bounding box + keyline removal), `src/qcFiles.js` / `src/inputQcFiles.js` (decode for QC), `src/shopify/materialize.js` (re-encode non-JPEG → JPEG).

**Note the lazy-import pattern:** every heavy/optional dependency is imported inside the function that needs it, not at module top level. This is deliberate — it keeps `import`ing a module cheap, lets the app boot with a dependency uninstalled (WhatsApp degrades to a `not-installed` state instead of crashing the server), and keeps the test suite free of native binaries.

#### Notable transitive dependencies

- **`puppeteer` / `puppeteer-core` 24.38.0** — via `whatsapp-web.js`. Launches its **own** headless Chromium, entirely separate from Playwright's. Launch args: `{ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'], protocolTimeout: 300_000 }`. `config.whatsapp.executablePath` can repoint it at a system Chrome when its pinned download goes missing.
- **`fluent-ffmpeg` 2.1.3** — via `whatsapp-web.js`, never called by app code.
- **`archiver` 7.0.1`, `ws` 8.21.0** — further transitives, not imported directly.

#### Docker image

`Dockerfile:6` — `FROM mcr.microsoft.com/playwright:v1.61.1-jammy` (Ubuntu 22.04 + Node 20 + every system lib Playwright and puppeteer need).

> **The base image tag MUST match the `playwright` version in `package-lock.json`.** This has already broken production once (commit `2478927`): the base was `v1.48.0-jammy` while the lockfile pinned `1.61.1`, so the Chromium build the app drives wasn't in the image and **every PDF build failed** with `Executable doesn't exist at /ms-playwright/chromium_headless_shell-1228`. The Dockerfile now also runs `npx playwright install chromium` as belt-and-braces. **On any Playwright bump, bump the base tag in the same commit.**

Other Dockerfile facts: `npm ci` from the lockfile; `.dockerignore` is a **deny-by-default whitelist** (only `src/`, `package.json`, `package-lock.json`, `config.example.json`) so secrets/customer photos/reference material can never enter the image; `ENV HOST=0.0.0.0 NODE_ENV=production`; `CMD ["node", "src/ui/server.js", "--no-open"]`.

No `.nvmrc` — Node version is pinned only by the Docker base image and the `engines` field.

### 2.2 Folder structure

#### Repo root

| Path | What it is |
|---|---|
| `Fotomalovanky.cmd` | The operator's everyday double-click launcher. Checks Node / `node_modules` / `config.json` exist with a plain-language error if not, runs `node src\ui\server.js`, pauses on exit so failures stay readable. |
| `Setup.cmd` | One-time setup: `npm install --no-fund --no-audit`, `npx playwright install chromium`, copies `config.example.json` → `config.json` and opens it in Notepad. |
| `Dockerfile` | Render container build (above). |
| `config.example.json` | Documented config template. **Partly stale — see §7.** |
| `config.render.example.json` | Cloud template: mail off, `/data/*` paths, `requirePaid:false`, `whatsapp.enabled:true`. |
| `config.json` | **The live, gitignored config.** Holds four real secrets. |
| `README.md` | **Badly stale — see §7.** Describes the app at its earliest milestone; actively misstates behaviour. Do not trust it. |
| `.gitignore` / `.dockerignore` | Heavily commented deny-lists. |
| `_*.mjs`, `_*.log` | ~21 gitignored one-off scratch drivers. See §7.4. |
| `Marketing Automatization/`, `Fotomalovanky/`, `Figma/`, `reference/`, `scratch/` | Reference material / legacy. See §7.7. |

#### `src/` — core order pipeline (root level)

| File | Purpose |
|---|---|
| `config.js` | Loads/validates `config.json` (or `$FMA_CONFIG`) into a normalised object. Defines every default, resolves all out-of-repo data dirs, and `redactForLog()`. Single source of truth for every feature flag. |
| `orchestrator.js` | **The "Go" run.** `runPipeline()`: ingest → intake gate → generate → review-gate check → builder → PDF, per order, sequentially. Owns `ORDER_STATUS`, `pdfPathFor()`, `buildabilityProblem()`, `formatEvent()` (the shared Czech event renderer used by CLI, dashboard and autopilot alike). Also a CLI. |
| `batch.js` | Resumable per-order/per-photo generation. `generatePhoto()`, `generateOrder()`, `runBatch()`, `nextAttemptSettings()` (the re-roll ladder). CLI for generate-only runs. |
| `autoRun.js` | `selectAutoRunOrders()` — pure decision about which inbox folders the extension-drop watcher should auto-start (unprocessed + sidecar present + count matches + folder settled ≥8s). No side effects. |
| `autopilot.js` | The unattended overnight entry point. `runAutopilot()` polls Shopify, materialises new orders, runs the **same** `runPipeline` over just those ids, writes the night report. **Never imports a delivery path — the no-send invariant is structural.** |
| `autopilotReport.js` | Read/write for `overnight-report.json`. Deliberately separate from `autopilot.js` so `studio.js` can read the report without pulling in Shopify/network deps. |
| `autopilotState.js` | Persists the handled-set + poll cursor + `lastRunAt`. Only **terminal** orders are marked handled. |
| `manifest.js` | `state.json` read/write + the photo status state machine (`STATES`, `canTransition`, `TRANSITIONS`), order dedication, intake block, override flags. **The single source of truth every other module reads through.** |
| `ingest.js` | Maps extension download folders → `{orderId, dirName, dir, photos[]}`. Recovers the order id from photo filenames, majority-voting when folder and filename disagree. |
| `intake.js` | The order-level **input QC gate** (`assessIntake`): per-photo checks + cross-photo findings (duplicates, count-vs-expected) → one verdict (`ok`/`warn`/`hold`). Czech operator text. |
| `inputQc.js` | **Pure** input heuristics, no I/O: resolution / blur (Laplacian variance) / exposure thresholds, perceptual dHash + Hamming distance, `assessCount`, `worstVerdict`. |
| `inputQcFiles.js` | `sharp` adapter feeding `inputQc.js`: sha1 (exact dupes), EXIF-rotate, downsample to 512px short side. |
| `qc.js` | **Pure** output heuristics: `assessColoringPixels` (near-blank/near-solid ink coverage), `measureSolidFill`/`assessSolidFill` (the block-grid + flood-fill tripwire), `assessColoringSvg`. |
| `qcFiles.js` | `sharp` adapter feeding `qc.js`: decodes `_bw.png` + `.svg`, flattens transparency to white. |
| `organize.js` | Builder-compatible naming: `<base>.jpg` + `<base>_bw.png` + `<base>.svg`. `writeOutputs()`, `copyWithRetry()` (retries Windows file-lock errors — EBUSY/EPERM/EACCES/UNKNOWN — 6× with backoff). |
| `autoCrop.js` | `deframe()` (strips a solid black border keyline the model sometimes draws) and `autoCropColoring()` (trims to the ink bounding box + margin, rewrites the SVG `viewBox`). |
| `dedication.js` | Pure text recovery: extracts the customer's title-page text from photo filenames (two extension dialects, `+`-joined names, Czech capitalisation, generic-placeholder detection). Majority-votes across an order. |
| `dedications.js` | The operator's "taught spellings" memory (`dedications.json`), stored **beside `config.json`, outside the outbox**. Exists because filenames strip diacritics and no rule can restore "Jiříčka" from "jiricka". |
| `orderInfo.js` | Reads `objednavka.json`: the shop's own dedication (accented), expected photo count, customer surname/email, line items. `resolveFormat()` derives gallery-vs-fullpage. |
| `emailDrafts.js` | Deterministic Czech copy-paste customer emails for held orders (missing/unreadable/duplicate/quality), with Czech plural + gendered greeting logic. **Drafts only — never sent by the tool.** |
| `review.js` | The **review gate**: `reviewState()`, `approve`/`reject`/`handoff`/`acceptReplacement`/`redo`, `applyPhotoEdit`/`revertPhotoEdit`, `setOrderDedication`, `overrideIntake`. |
| `editor.js` | Pure SVG editing: browser pencil strokes → white `<path>` overlays; crop → new `viewBox`. Edits the **SVG** (what prints), never the raster. |
| `studio.js` | The **live order board**: `deriveOrderStatus()` (pure state machine over review-state + 3 injected facts), `buildBoard()`, `markDelivered`/`markPrinted` + their unmarks, `overnightSummary()`, `studioBoard()`. |
| `skeleton.js` | Phase-0 walking skeleton — one photo end to end. Superseded operationally, kept as the minimal seam proof. |
| `purge.js` | CLI (`npm run purge`) for deleting settled customers' photographs. Dry-run by default. |
| `retention.js` | The purge logic: `inspectOutbox()`/`purgeOriginals()` + `inspectAutopilotData()`/`purgeAutopilotData()`. |
| `brandVoice.js` | Shared brand voice (`BRAND_CORE`, `BLOG_VOICE`, `AD_VOICE`) + the banned-vocabulary matcher. Pure data + one matcher. Used by both the ad-copy and blog generators. |

#### `src/blog/` — Blog Creator

| File | Purpose |
|---|---|
| `topics.js` | `suggestTopics()` — merges calendar-anchored occasions (next 8 weeks, needs no AI) with a Gemini "what's hot now" SEO step. Degrades to calendar-only on failure, so the picker is never empty. |
| `draft.js` | `generatePost()` — one Gemini call returns **structured JSON** (never raw HTML); `buildBodyHtml()` assembles the HTML deterministically, so structure is enforced in code, not by the model. `qcPost()` is a non-blocking SEO/brand QC pass. Falls back to a `skeleton()` post so a draft always exists. |
| `store.js` | File persistence: `posts/<id>.json` + `blog-index.json`. `isValidId()` guards the slug against path traversal. |

#### `src/creatives/` — Creative Studio + ad calendar

| File | Purpose |
|---|---|
| `aiImage.js` | The Gemini seam: `generateMarketingImage()`, `describeImage()` (the privacy step), `generateText()`. Shared `callGemini()` handles retry/backoff on 429/500/503. |
| `adImages.js` | One ad's "before" (AI photo) + "after" (line art via the **same RunPod generator** used for customer orders). `describeAndGenerate()` is the privacy-safe auto path. |
| `adCalendar.js` | Batch ad generator per occasion: `pickTemplates()`, three scene-prompt builders, `buildAssets()`, `generateOccasionAds()`. **Not wired into the live server** — only driven by the gitignored `_gencal.mjs`. |
| `adCopy.js` | Gemini Czech ad copy: strict-JSON prompt per template, clamps/dedupes, and swaps any banned-vocabulary field back to seed copy. |
| `calendar.js` | `MARKETING_CAL` — the 33-occasion 2026 marketing calendar. **Mirrored inline in `dashboard.html` (~line 1238) — keep in sync.** |
| `renderCreative.js` | `renderCreativePng()` — screenshots creative HTML → PNG via the same Playwright Chromium as the PDF builder. |
| `studio/formats.js` | The 4 canvas formats with pixel size + safe-zone inset. Pure data. |
| `studio/brandKit.js` | Palette, themes, hand-drawn SVG decoration atoms (tape, arrow, crayon, sun, sparkle, starburst), drawn logo/wordmark fallback. |
| `studio/templateModel.js` | The template engine: `resolveTemplate()`, `boxToPx()`, `validateConcept()` (the QC pass), `creativeFilename()`. |
| `studio/templates.js` | The 5 template families as pure layered-element data + seed copy. |
| `studio/renderStudioHtml.js` | Resolved template + copy + assets → one self-contained HTML doc. **The same HTML feeds both the live preview and the PNG export, guaranteeing pixel parity.** |

#### `src/generator/` — the line-art seam

| File | Purpose |
|---|---|
| `driver.js` | The `GeneratorDriver` interface + `GeneratorError` / `GeneratorNotImplementedError`. |
| `factory.js` | `createGeneratorDriver(config)` — picks api vs browser from `config.generator.mode`. |
| `apiDriver.js` | **The live driver.** Scripted HTTP reproducing the generator web UI's calls: `upload → status → process → process-status (poll) → vectorize → download×3`. EXIF-rotate/downscale before upload, cold-start-aware retry, and **resubmits a fresh job** on GPU `FAILED`. |
| `browserDriver.js` | **Dead code.** Unimplemented stub that throws unconditionally. See §7.2. |

#### `src/builder/`

| File | Purpose |
|---|---|
| `builderDriver.js` | Drives the print builder's **client-side web app** with Playwright: loads the order folder into its `webkitdirectory` input, sets layout options, waits for every page `<img>`, then `page.pdf()`. `collectPairs()` mirrors the builder's own pairing rule. |

#### `src/proton/` — mail

| File | Purpose |
|---|---|
| `bridgeClient.js` | IMAP over Bridge's local self-signed 127.0.0.1:1143: `fetchInbox()`, `fetchMessage()` (marks `\Seen`), `deleteMessage()` (→ Trash), `setSeen()`. `embedImages()` inlines `cid:` images as `data:` URIs (4MB/image, 12MB total cap). |
| `mailbox.js` | **Pure** shaping of a raw IMAP fetch into the tile payload. No I/O, fully unit-testable. |
| `smtpClient.js` | SMTP over Bridge 127.0.0.1:1025 — the **one** outbound-mail seam, fired only by an explicit click. |
| `templates.js` | 6 pre-approved Czech reply templates (mined from David's real Sent folder) + `unfilledPlaceholders()`, which refuses to send a template with an un-replaced `[TOKEN]`. |

#### `src/shopify/`

| File | Purpose |
|---|---|
| `adminClient.js` | Authenticated Admin **GraphQL** client (`read_orders`). `listOrders()` pages `updated_at:>=...` queries. |
| `orders.js` | **Pure** normalisation: `extractOrder()` pulls photos/dedication/layout/products out of line-item `customAttributes` by **key-substring match**. `expectedPhotosFrom()` parses a variant's `/ N` suffix. |
| `materialize.js` | Normalised order → on-disk inbox folder: downloads photos via `safeFetch`, re-encodes non-JPEG → JPEG, writes `objednavka.json`. The autopilot's stand-in for the Chrome extension. |
| `safeFetch.js` | **SSRF-hardened** photo fetcher: https-only, host allowlist, DNS-resolve + reject private/loopback IPs, no auth header ever attached, content-type + size cap. |
| `content.js` | The **write** seam, deliberately separate from the read-only client: `write_content` token, `listBlogs()`, `createArticleDraft()` — **always `isPublished:false`**. |

#### `src/ui/`

| File | Purpose |
|---|---|
| `server.js` | **The whole HTTP surface** (~1438 lines). Instantiates every subsystem's client, holds all in-process run-locks and background timers. Both the `npm start` entry point and what `orchestrator.js --review` launches. |
| `static/index.html` | The **review grid** (~1627 lines) at `/review`. Vanilla JS polling `/api/state`. |
| `static/dashboard.html` | **The studio home** (~1877 lines) at `/`. Tabs: home, Objednávky, Potřebuje vás, Pošta, Kreativy, Blog, Kalendář, Nastavení. |
| `static/css/tokens.css`, `components.css` | Shared design tokens (light/dark via `data-theme`) + component classes. |
| `static/creatives/*.svg`, `logo.*`, `avatar.png`, `favicon.png` | Static assets, served with a path-containment check bounding them to `static/`. |

#### `src/whatsapp/`

| File | Purpose |
|---|---|
| `whatsappClient.js` | Wraps `whatsapp-web.js`: lifecycle state machine (`connecting → needs-qr → linked / offline / not-installed`), QR→data-URL, `sendDocument()` (the one outbound seam), `listGroups()`, `chatIdOf()` normalisation. |

#### `tools/` — dev/smoke scripts (none run in production)

`gridSmoke.mjs`, `studioSmoke.mjs`, `queueSmoke.mjs`, `editorSmoke.mjs` (proves a hand-edit reaches the SVG, not just the preview), `extensionSmoke.mjs` + `patchExtension.mjs` (drive/patch the external Chrome extension), `dedicationSafety.mjs` (proves dedication text can never be silently emptied), `folderPickerProbe.mjs`, `installAutopilotTask.ps1` (registers the Windows Scheduled Task), `run-autopilot-hidden.vbs` (auto-generated, gitignored — runs the task with no console window).

Research tooling for calibrating the generator: `abSheet.mjs`, `cellSheet.mjs`, `cropCompare.mjs`, `eyeSheet.mjs`, `reviewSheet.mjs`, `promptAB.mjs`, `u8Sample.mjs`.

#### `test/` — 39 files, `node --test`, fully offline (no network/GPU/browser)

Covers config validation, ingest/order-id recovery, dedication recovery + memory, the manifest state machine, input QC + adapter, output QC, auto-crop/deframe, batch resume/redo, orchestrator end-to-end (fake generator+builder), review-gate transitions + hand-edit round-trip, studio board derivation, email drafts, Shopify extraction + safeFetch SSRF guards + materialisation, mailbox shaping + image embedding, the WhatsApp state machine, Gemini calls (mocked), ad copy/images, the Creative Studio template model, blog topics/store/QC, the Basic-auth gate, and two live-server integration suites.

#### `docs/`

`OPERATOR.md` (the non-technical manual — **stale, see §7**), `RENDER.md` (deployment guide), `autopilot-setup.md`, `blog-creator.md`, `creative-studio.md` + `creative-studio-changelog.md`, `OVERNIGHT-2026-07-10.md`, `design/*.md` (the redesign brief — **never executed, see §7**), `plans/*.md` (dated build plans), `spikes/*.md` (**the Phase-0 reverse-engineering spikes that resolved the generator, builder and value-gate seams — the primary sources for the exact request shapes in `apiDriver.js`/`builderDriver.js`**).

`docs/*.docx` / `*.xlsx` are David's business docs (brand guide, pricing, GTM strategy, ad copy). **Gitignored** — the GTM sheet holds plaintext social-media passwords. Never tracked.

### 2.3 How the pieces connect

#### The core pipeline

```
Chrome extension (external)          Shopify Admin API (autopilot)
        │  drops photos + objednavka.json      │  materializeOrder()
        └───────────────┬──────────────────────┘
                        ▼
              <inbox>/<orderId>/*.jpg + objednavka.json
                        │  ingestOrders()          (src/ingest.js)
                        ▼
             intake.assessIntake()  ──hold──► draft-email.txt + state.json (held)
                        │ ok/warn
                        ▼
       batch.generateOrder() → generatePhoto() per photo
                        │
       generator/factory.createGeneratorDriver()
                        │  (upload→process→poll→vectorize→download)
                        ▼
       organize.writeOutputs()  →  <outbox>/<orderId>/<base>.jpg + _bw.png + .svg
                        │
       autoCrop.deframe() + autoCropColoring()
                        │
       qcFiles.assessOutputFiles() → qc.js → STATES.OK | STATES.FLAGGED
                        │
                 manifest.writeManifest()   ← state.json, the source of truth
                        │
       ┌────────────────┴─────────────────┐
       │ any FLAGGED / PENDING_REVIEW     │ all eligible (OK/APPROVED)
       ▼                                   ▼
 review.js (approve/reject/redo/       builder/builderDriver.buildPdf()
 handoff/edit)                          (Playwright → the builder web app)
       │  approve → APPROVED             │
       └────────────────┬────────────────┘
                        ▼
            <outbox>/<orderId>/<orderId> Final.pdf
                        │  operator clicks "Odeslat Jirkovi"
                        ▼
            whatsapp.sendDocument()  → only on success →
            studio.markDelivered() → delivered.json  (board → 'sent')
                        │  operator confirms print
                        ▼
            studio.markPrinted() → printed.json  (purge-eligible)
                        │  ≥ retentionDays
                        ▼
            retention.purgeOriginals()   (manual, dry-run default)
```

`orchestrator.runPipeline()` walks this whole chain per order (minus delivery, which is always a separately-triggered route). **There is no job-queue data structure — the filesystem is the queue.** An order is "queued" simply by having a photo-bearing folder in the inbox.

#### Two ways a run starts

1. **Manual.** Dashboard → `POST /api/_run` → `startRun()` → `runPipeline()`, not awaited; streamed via an in-memory `run.lines[]` the dashboard polls. Identical code path to `npm run go`.
2. **Overnight automatic.** A **Windows Scheduled Task** runs `node src/autopilot.js` every ~15 min as a **fresh, separate OS process** — not a timer inside the server. `runAutopilot()` polls Shopify over a **7-day sliding window** (not a hard cursor — so a held order self-lifts when the customer re-uploads days later), filters to unhandled photo orders, materialises them, then calls the **same** `runPipeline({ only: newIds, force: false })`, and writes the night report.

#### Background timers inside the server process

Both are `setInterval` in `createReviewServer()`, `.unref()`'d so they never block exit, and both kick off seconds after boot rather than waiting a full interval:

- **`autoFetchTimer`** (`server.js:1316-1324`) — every `shopify.autoFetchMinutes` (default 10; 0 = off), runs the same Shopify poll-and-generate pass. So new Shopify orders reach the board with no click.
- **`autoRunTimer`** (`server.js:1332-1349`) — every `config.autoRunSeconds` (default 15), finds inbox folders the **Chrome extension** just finished dropping (complete + settled ≥8s) and runs the full pipeline through to PDF, silently.

So "automatic" has two halves: Shopify-sourced orders come via `autoFetchTimer`/the scheduled task; extension-sourced orders come via `autoRunTimer`.

#### Concurrency guards

Three pieces of in-process state gate each other so a manual run, an autopilot fetch, an auto-run sweep and a single-photo redo can never race the same `state.json`:

- `run = { active, stopping, lines, report, error, orderId }` — the pipeline lock. `runController` is an `AbortController`; **Stop is cooperative**, checked only between orders/photos, never preemptive.
- `autopilot = { running, lines, report, error }` — the Shopify-poll lock.
- `inFlight = Map<"orderId/base", {message}>` — per-photo redo tracker.
- `requireIdle()` throws → HTTP 409 on every verdict-mutating route if a run or autopilot is active.

> **A real gap:** these locks are **per-process only**. The standalone Scheduled-Task autopilot process can in principle race the server's own poll. Both ultimately serialise through `runPipeline`'s per-order `state.json` writes, but there is no cross-process lock. Worth fixing in a rebuild.

#### Creative Studio flow

Dashboard → `GET /api/studio/templates` → operator picks a template + uploads a reference photo or types a prompt → `POST /api/creative/ai-image` → `describeImage()` (identity-free description — **customer pixels never reach the image model**) → `generateMarketingImage()` ("before") → the **same RunPod driver as customer orders** makes the line-art "after" → both cached in-memory (`creativeImages` Map, capped at 24) → `GET /studio/preview` renders the template HTML into an `<iframe>` → `GET /studio/render` screenshots it to PNG.

The **batch calendar generator** (`adCalendar.generateOccasionAds`) is **not wired into any route** — only `_gencal.mjs` drives it. The server's `/api/creatives/calendar` only *reads* the index it produced.

#### Blog flow

Blog tab → `GET /api/blog/topics` → `POST /api/blog/draft` (structured JSON → deterministic HTML → non-blocking QC) → saved locally → operator edits (`POST /api/blog/posts` re-derives `plainText`/QC) → `POST /api/blog/publish` → `createArticleDraft()` — **always unpublished.**

#### Mail flow

Pošta tile → `GET /api/mail` (30s in-memory TTL cache) → `fetchInbox()` → `summarizeInbox()`. Opening a message marks it `\Seen` and invalidates the cache. `POST /api/mail/send` is the only outbound path, refuses a body with an unfilled `[TOKEN]`, and goes through Bridge's local SMTP.

#### WhatsApp flow

Client built only when `whatsapp.enabled`. `GET /api/whatsapp` (status/QR) polled by the dashboard for the one-time scan. `POST /api/<order>/deliver` is the **sole production send path** — sends `Final.pdf` captioned with the order number, and calls `markDelivered()` **only if the send actually resolved**. `POST /api/whatsapp/test` sends without marking. Session lives in `whatsapp.sessionDir`, which `config.js` **hard-refuses** to resolve inside the repo (it is a full-account bearer credential).

#### The persistence model — "files as DB"

| What | File | Where |
|---|---|---|
| Per-order photo/verdict state | `state.json` | in each `<outbox>/<orderId>/` |
| Delivered / printed markers | `delivered.json` / `printed.json` | in each order folder |
| Hidden-from-board marker | `hidden.json` | in each order folder |
| Held-order draft email | `draft-email.txt` | in each order folder |
| Shop-supplied order metadata | `objednavka.json` | in each `<inbox>/<orderId>/` |
| Taught dedication spellings | `dedications.json` | beside `config.json` |
| Autopilot handled-set + cursor | `autopilot-state.json` | `shopify.dataDir` |
| Overnight report | `overnight-report.json` | `shopify.dataDir` |
| Generated ads + index | `creatives-index.json` + `ads/<key>/*.png` | `creatives.dataDir` |
| Blog drafts | `blog-index.json` + `posts/<id>.json` | `blog.dataDir` |
| WhatsApp session | LocalAuth profile | `whatsapp.sessionDir` |

`config.js` **forces every sensitive dir outside the repo tree** and throws a `ConfigError` on any override that resolves inside it.

### 2.4 Entry points and startup

#### npm scripts

| Script | Command | Purpose |
|---|---|---|
| `start` | `node src/ui/server.js` | **The production entry point.** |
| `review` | `node src/ui/server.js` | Alias of `start` (historical — the grid used to be the whole app). |
| `go` | `node src/orchestrator.js` | CLI full pipeline. |
| `batch` | `node src/batch.js` | CLI generate-only. |
| `skeleton` | `node src/skeleton.js` | One-photo proof. |
| `purge` | `node src/purge.js` | Retention purge (dry-run unless `-- --yes`). |
| `test` | `node --test` | The offline suite. |
| `smoke` | chains 5 browser smokes | `grid-smoke && studio-smoke && queue-smoke && editor-smoke && ded-safety`. |

#### Executable entry points

Every one is guarded by `import.meta.url === pathToFileURL(process.argv[1]).href`, so importing the module never triggers its CLI.

- **`src/ui/server.js:1393`** — parses `--port`/`--no-open`/positional inbox/outbox; resolves `PORT`/`HOST` (defaults `127.0.0.1:4173` locally, `0.0.0.0` in cloud); `loadConfig()` → `createReviewServer()` → `listen()`. Registers `SIGINT`/`SIGTERM` → `shutdown()`, **which closes the WhatsApp Chromium cleanly — skipping this makes the next start hang in `connecting` forever.**
- **`src/orchestrator.js:432`** — `node src/orchestrator.js [inbox] [outbox] [--force] [--review]`. With `--review` and orders held, launches the server in-process on 4173.
- **`src/batch.js:170`**, **`src/skeleton.js:41`**, **`src/purge.js:67`** — CLIs.
- **`src/autopilot.js:181`** — what the Scheduled Task invokes. Notably does **not** call `process.exit()` on completion: it sets `process.exitCode` and lets the loop drain, with an `unref()`'d 8s backstop, **to dodge a Node-24/Windows/libuv assertion crash (`UV_HANDLE_CLOSING`, 0xC0000409) that turned clean runs into spurious Task Scheduler failures.**
- **`src/generator/apiDriver.js`** / **`src/builder/builderDriver.js`** — each has a direct-run CLI for isolated seam testing.
- **`tools/*.mjs`** — standalone, never imported by app code.

#### Operator entry: `Setup.cmd` → `Fotomalovanky.cmd`

`Setup.cmd` runs once (`npm install`, `npx playwright install chromium`, seed `config.json`, open Notepad). `Fotomalovanky.cmd` is the daily double-click: validates Node/`node_modules`/`config.json` with plain-language errors, runs the server, pauses so failures stay readable.

#### Windows Scheduled Task

`tools/installAutopilotTask.ps1` registers a task firing every ~15 min → `tools/run-autopilot-hidden.vbs` (auto-generated, gitignored) → `Shell.Run` of `node src\autopilot.js` with a hidden window, so the desktop never flashes a console at night.

#### Docker / Render

`CMD ["node", "src/ui/server.js", "--no-open"]` — the same entry point as the desktop, with cloud env: `HOST=0.0.0.0`, Render-injected `PORT`, `FMA_CONFIG` (→ the mounted Secret File), `STUDIO_USER`/`STUDIO_PASS` (the Basic-auth gate), optionally `FMA_SHOPIFY_TOKEN`.

> **There is no Scheduled Task in the cloud.** The overnight cadence on Render comes *entirely* from the in-process `autoFetchTimer`. See §7.5 — this looks like an unexamined gap between two plans rather than a decision.

#### Config loading

`loadConfig(configPath = process.env.FMA_CONFIG ?? resolve(process.cwd(), 'config.json'))` (`config.js:12-13`) runs at the top of every entry point. Throws a `ConfigError` with **operator-facing instructions, not a stack trace**, if the file is missing, unparsable, or still holds a `REPLACE_WITH...` placeholder.

Every optional subsystem (`whatsapp`, `mail`, `ai`, `shopify`, `blog`) is **off by default** and only strictly validated once its own `enabled:true` is set — so a bare config (just `generator.baseUrl` + `builder.baseUrl`) runs the core pipeline. Two secrets resolve from config *or* env, config winning: `shopify.accessToken` ← `FMA_SHOPIFY_TOKEN`, `shopify.contentToken` ← `FMA_SHOPIFY_CONTENT_TOKEN` (falling back to `accessToken`).

`redactForLog()` masks the generator URL to `protocol//host/<redacted>` and blanks Shopify tokens before anything reaches a log line.

---
## 3. EXTERNAL SERVICES AND CREDENTIALS

> **Live secret values are in `PROJECT_EXTRACTION.secrets.md` (gitignored), not here.** This section gives every name, purpose, location and default. Secrets are shown masked.

### 3.1 Environment variables (every `process.env` read in the repo)

| Var | Purpose | Read at | Required? |
|---|---|---|---|
| `FMA_CONFIG` | Overrides the `config.json` path. Render points it at `/etc/secrets/config.json`. | `src/config.js:13` | optional (defaults `./config.json`) |
| `FMA_SHOPIFY_TOKEN` | Shopify `read_orders` token, as an alternative to `shopify.accessToken` | `src/config.js:226` | optional (config *or* env required if `shopify.enabled`) |
| `FMA_SHOPIFY_CONTENT_TOKEN` | Shopify `write_content` token for the blog | `src/config.js:238` | optional (falls back to the orders token) |
| `STUDIO_USER` | HTTP Basic Auth username gating the **whole** dashboard | `src/ui/server.js:1370`, `checkAuth()` `:1369-1384`, `:622` | optional — **unset means no auth at all** |
| `STUDIO_PASS` | The paired password | `src/ui/server.js:1371` | optional, same |
| `PORT` | HTTP listen port (Render injects) | `src/ui/server.js:1397` | optional, default `4173` |
| `HOST` | Bind address (Render needs `0.0.0.0`; the Dockerfile sets it) | `src/ui/server.js:1398` | optional, default `127.0.0.1` |
| `LOCALAPPDATA` / `XDG_DATA_HOME` | OS per-user data root for the default out-of-repo dirs | `src/config.js:22,36,48,57` | optional, OS default |
| `NODE_ENV` | Set `production` in the Dockerfile; **read nowhere in `src/`** — informational only | `Dockerfile:32` | n/a |

#### ⚠️ Two config keys are dead — read by code, never emitted by the loader

- **`config.autoRunSeconds`** — read at `src/ui/server.js:1342`, but `validateConfig()` never puts it on the returned object (`src/config.js:358-442`). **Setting it in `config.json` does nothing**; the timer always uses its hardcoded 15s default.
- **`config.copyModel`** — read at `src/creatives/aiImage.js:163`, never populated by the loader. So `generateText()`'s model **always** falls through to `describeModel`. Every ad-copy and blog call runs on `gemini-flash-lite-latest` regardless of config.

Both are "configurable" surfaces that aren't. A rebuild should either wire them through the loader or delete them.

### 3.2 Config keys

#### `generator.*` — the line-art generator (Render app fronting RunPod)

| Key | Purpose | Default | Code |
|---|---|---|---|
| `baseUrl` | **Token-scoped** base URL (the token is IN the path — a secret) | none — **required** | `config.js:97-105` |
| `mode` | `"api"` (live) or `"browser"` (dead stub) | `null` → throws at driver creation | `config.js:114-117`, `factory.js:7-14` |
| `variant` | `<model>_<megapixels>`, e.g. `2511_1.5` | `null` (must be set) | `apiDriver.js:52-62,96-102` |
| `diffusionSteps` | Steps sent to `/process` | `4` (example ships 8; **live is 8**) | `config.js:350`, `apiDriver.js:104` |
| `maxDiffusionSteps` | Ceiling for redo re-rolls | `12` | `config.js:352-357` |
| `positivePrompt` / `negativePrompt` | The tuned recipe. **Empty → the server's own untuned default** | `''` | `config.js:365-366`, `apiDriver.js:105-106,182-183` |
| `timeouts.requestMs` | Per-HTTP-call timeout | `60000` | `apiDriver.js:78` |
| `timeouts.vectorizeMs` | `/vectorize` timeout | `180000` | `apiDriver.js:79,266` |
| `timeouts.pollIntervalMs` | `/process-status` poll cadence | `4000` | `apiDriver.js:80` |
| `timeouts.maxPollMs` | Max total wait for COMPLETED | `1200000` (20 min) | `apiDriver.js:81` |
| `timeouts.retries` | Transport (network/5xx) retries | `4` | `apiDriver.js:82` |
| `timeouts.gpuRetries` | Resubmits after the GPU accepts then FAILs | `2` | `apiDriver.js:83` |
| `timeouts.backoffBaseMs` | Backoff base | `1000` | `apiDriver.js:84` |

#### `builder.*` — the print PDF builder (a separate client-side Render app)

| Key | Purpose | Default | Code |
|---|---|---|---|
| `baseUrl` | Builder page URL (no auth — it's a client-side app) | none — **required** | `config.js:106-109` |
| `timeouts.navMs/loadMs/renderMs` | Nav / pairing / image-render | `90000/30000/60000` | `builderDriver.js:86-88` |
| `pdf.mode` | `gallery` or `fullpage` | falls back to `delivery.format` | `config.js:146-149` |
| `pdf.coverCount` | Title-page thumbnails (max 8) | `0` (**live: 2**) | `builderDriver.js:42-48` |
| `pdf.coverVariant` | `classic` or `pencils` | builder default (**live: `pencils`**) | `builderDriver.js:50-65` |
| `pdf.rotationMin/Max` | Collage rotation range | builder default | `builderDriver.js:168-169` |
| `autoCrop` | Trim each page to its ink before printing | `true` | `config.js:382` |

#### `paths.*`

`inbox` (default `./inbox`; **live: `C:/Users/David/Desktop/Objednavky Nove`**), `outbox` (default `./outbox`).

#### `intake.*` — input QC thresholds

Merged over `DEFAULT_INTAKE` (`src/inputQc.js:12-31`): `minMegapixels:0.5`, `hardMinMegapixels:0.15`, `minShortSidePx:600`, `blurVarianceMin:60`, `darkMeanMax:40`, `brightMeanMin:225`, `clipFractionMax:0.35`, `dupHammingMax:5`. All optional overrides.

#### `whatsapp.*`

| Key | Purpose | Default | Code |
|---|---|---|---|
| `enabled` | The delivery tile/seam | `false` (**live: true**) | `config.js:123` |
| `recipient` | Number or group JID — **required if enabled** | none | `config.js:124-127`, `whatsappClient.js:25-31` |
| `sessionDir` | LocalAuth store — **must resolve outside the repo (enforced)** | OS per-user dir | `config.js:131-141` |
| `executablePath` | Path to a system Chrome when puppeteer's pinned build is missing | `''` | `config.js:395`, `whatsappClient.js:64-68` |

#### `mail.*` — Proton Bridge

`enabled` (`false`; live true), `host` (`127.0.0.1`), `port` (`1143`), `smtpPort` (`1025`), `user` (**required if enabled**), `pass` (**secret**, required if enabled), `fromAddress` (defaults to `user` — a send-as alias), `secure` (`false`), `recentLimit` (`6`). `config.js:158-183`.

#### `ai.*` — Google Gemini

| Key | Purpose | Default | Code |
|---|---|---|---|
| `enabled` | The Kreativy AI step | `false` (**live: true**) | `config.js:190` |
| `apiKey` | **Secret** — required if enabled | none | `config.js:191-194` |
| `model` | Image model | `gemini-3-pro-image-preview` (**live: `gemini-3.1-flash-image`**) | `config.js:195` |
| `describeModel` | Vision/text model | `gemini-flash-lite-latest` | `config.js:201` |
| `describeInstruction` | Override for the privacy describe prompt | built-in | `config.js:203-204` |
| `endpoint` | API base | `https://generativelanguage.googleapis.com/v1beta` | `config.js:205` |
| `timeoutMs` | Text/describe timeout | `60000` | `config.js:206` |
| `imageTimeoutMs` | **Image timeout — separate on purpose** | `180000` | `config.js:207-210` |
| `maxRetries` / `backoffBaseMs` | Retry on 429/500/503 | `5` / `1500` | `config.js:213-214` |

#### `shopify.*`

| Key | Purpose | Default |
|---|---|---|
| `enabled` | The poll/autopilot | `false` (**live: true**) |
| `storeDomain` | **required if enabled** | none |
| `accessToken` | **Secret**, `read_orders` — or `$FMA_SHOPIFY_TOKEN` | none |
| `contentToken` | **Secret**, `write_content` for the blog | falls back to `accessToken` |
| `apiVersion` | Admin API version | `2026-07` |
| `photoKeyMatch` / `dedicationKeyMatch` / `layoutKeyMatch` | Custom-attribute key substrings | `fotka` / `věnování` / `rozvržení` |
| `photoHostAllowlist` | SSRF allowlist | `['cdn.tigren.com']` |
| `estSpendPerOrder` | Rough RunPod cost for the morning summary — **not a cap** | `0.3` |
| `requirePaid` | Wait for PAID before generating | `true` (**live: false** — see §5) |
| `autoFetchMinutes` | Poll interval; `0` = off | `10` |
| `dataDir` | Cursor + handled set + report — **outside repo (enforced)** | OS per-user dir |

#### `creatives.dataDir`, `blog.*`, `delivery.*`, `studio.firstLiveOrder`

- `creatives.dataDir` — generated ad PNGs + index, outside repo. `config.js:47-51,296-306`.
- `blog.enabled` (`false`; **live true**), `blog.dataDir`, `blog.author` (`Fotomalovánky`), `blog.blogId` (`null` — pick via `listBlogs()`), `blog.wordCountMin/Max` (`800`/`1500`).
- `delivery.format` (fallback layout), `delivery.formatMap` (variant-title string → layout).
- `studio.firstLiveOrder` — order numbers below this are hidden as test orders (**live: `1524`**).
- Top-level: `retentionDays` (`30`, positive int), `manualTouchThreshold` (`null`, **validated but read by nothing — dead**).

### 3.3 The live secrets (masked — values in the secrets file)

| Key | Purpose | Fingerprint |
|---|---|---|
| `generator.baseUrl` path token | Path auth for the generator app | `tdcG…` (24 chars) |
| `mail.pass` | Bridge password for `info@fotomalovanky.cz` | `w16T…` (22 chars) |
| `ai.apiKey` | Google Gemini | `AQ.A…` (53 chars) |
| `shopify.accessToken` | Admin API `read_orders` | `shpa…` (38 chars) |

#### ⚠️ `redactForLog()` is incomplete

`src/config.js:447-463` masks `generator.baseUrl` and blanks `shopify.accessToken`/`contentToken`. **It does not redact `ai.apiKey` or `mail.pass`.** If the config object is ever logged whole rather than through this function, the Gemini key and the Bridge password leak into the log. Harden this in a rebuild.

#### Non-secret live values worth carrying over

`generator.variant = "2511_1.5"`, `generator.diffusionSteps = 8`, `ai.model = "gemini-3.1-flash-image"`, `shopify.requirePaid = false`, `shopify.storeDomain = "aqi8it-7n.myshopify.com"`, `shopify.apiVersion = "2026-07"`, `studio.firstLiveOrder = 1524`, `mail.user = "info@fotomalovanky.cz"`, `mail.fromAddress = "david@fotomalovanky.cz"`, `builder.pdf = { mode: "gallery", coverCount: 2, coverVariant: "pencils" }`, `retentionDays = 30`.

`delivery.formatMap` (the live mapping — note the emoji are part of the literal Shopify variant strings):
```json
{
  "🖼️ Galerie (vaše fotka vedle omalovánky)": "gallery",
  "📄 Celostránková omalovánka (plná stránka pro vybarvování)": "fullpage"
}
```

`whatsapp.recipient = "120363411363494650@g.us"` — the **"Objednávky" WhatsApp group JID**, not a personal number. Not itself a bearer credential (the LocalAuth session authenticates); it's the delivery target and must be re-entered by hand.

### 3.4 Third-party APIs

#### Google Gemini — `src/creatives/aiImage.js`

- **Endpoint:** `POST {endpoint}/models/{model}:generateContent` (`aiImage.js:51`).
- **Auth:** header `x-goog-api-key`. No OAuth, no SDK — raw `fetch`.
- **Calls:** `generateMarketingImage()` (`:96-115`, `responseModalities:['IMAGE']`), `describeImage()` (`:128-148`, photo as inline base64), `generateText()` (`:162-180`).
- **Quirks:** 429/500/503 retried with exponential backoff (`RETRYABLE_STATUS`, `:43,50-84`). Image calls get a **separate, longer timeout** (180s vs 60s) because they were failing with "This operation was aborted" under load.
- **Privacy design (load-bearing):** the customer photo is sent **only** to `describeImage`. `generateMarketingImage` receives **text alone**. No pixel of a customer photo can reach the image model.

#### RunPod line-art — `src/generator/apiDriver.js`

- Not called directly. `generator.baseUrl` (a `*.onrender.com` app) fronts RunPod serverless GPUs; responses carry `runpod_job_id`. **No RunPod key exists in this repo.**
- **Endpoints** (token-in-path, no other auth), raw `fetch`:
  - `POST {prefix}/upload` (multipart `files[]`) → `{ job_id }`
  - `GET {prefix}/status/{job}` → `{ files:[{filename}] }` (server hash-prefixes the name)
  - `POST {prefix}/process/{job}/{file}` `{model, megapixels, steps, positive_prompt?, negative_prompt?}` → `{ success, variant_key, runpod_job_id }`
  - `GET {prefix}/process-status/{job}/{file}/{variantKey}` → `{ status: IN_QUEUE|IN_PROGRESS|COMPLETED|FAILED }`
  - `POST {prefix}/vectorize/{job}/{file}` `{variant_key}` → `{ success, jpg_filename, png_filename, svg_filename }`
  - `GET {prefix}/download/{job}/{filename}` → raw bytes
- **Quirks:** GPU jobs die **~8% of the time**; a `FAILED` status is retried by **resubmitting a new job** (re-polling a dead job just re-reads FAILED), up to `gpuRetries`. 408/429/500/502/503/504 transport-retried with backoff. Uploads mirror the web UI's own client-side downscale/rotation.

#### Shopify Admin API (GraphQL) — `src/shopify/adminClient.js`, `src/shopify/content.js`

- **Endpoint:** `https://{storeDomain}/admin/api/{apiVersion}/graphql.json`.
- **Auth:** `X-Shopify-Access-Token`. **Two separate files with two separate tokens on purpose** — the read-only path is never touched by a write scope.
- **Calls:** `fetchOrderByName(name)`, `listOrders({query,pageSize,maxPages})` (paged `orders(first, after, sortKey:UPDATED_AT, reverse:true, query)`), `listBlogs()`, `createArticleDraft()` (**always `isPublished:false`**).
- **The scope quirk that shapes the query:** `read_orders` can read `name, email, updatedAt, displayFinancialStatus, lineItems.customAttributes, lineItems.variantTitle` — but requesting the `customer{}` or `variant{}` connections **fails the WHOLE query with `ACCESS_DENIED`**. The selection deliberately avoids them. All order data (photo URLs, dedication, layout) is smuggled through line-item **custom attributes**, matched **by key substring** — the public API has no `type` field on them.
- 429 and GraphQL `THROTTLED` are surfaced distinctly for backoff.

#### Photo CDN — `src/shopify/safeFetch.js`

Customer photo URLs point at **`cdn.tigren.com`** (a public CDN, not Shopify). Fetched with SSRF hardening: https-only, host allowlist, DNS-resolve + reject private/loopback, image content-type check, 25 MB cap, and **no auth header is ever attached** — so the Shopify token cannot leak to that host.

#### Proton Mail Bridge — `src/proton/*`

Not a remote API: Bridge runs **locally** and exposes IMAP/SMTP on `127.0.0.1` with a **self-signed cert** and Bridge-generated credentials (hence `tls:{rejectUnauthorized:false}` — it never leaves loopback).
- IMAP via `imapflow`: `connect`, `status`, `getMailboxLock`, `fetch`/`fetchOne`, `messageMove` (→ Trash), `messageFlagsAdd/Remove`.
- SMTP via `nodemailer`: `createTransport` + `sendMail`, STARTTLS.
- Parsing via `mailparser`'s `simpleParser`, plus a hand-rolled `embedImages()` rewriting `cid:` → `data:` URIs.
- **Quirks:** opening a message auto-marks `\Seen` (best-effort, non-fatal); connection errors are classified `'auth'` vs `'offline'` so the UI distinguishes bad credentials from Bridge simply not running.

#### WhatsApp — `src/whatsapp/whatsappClient.js`

`whatsapp-web.js` drives headless Chromium via puppeteer; session persisted with `LocalAuth({clientId:'jirka', dataPath: sessionDir})`.
- **Calls:** `client.initialize()` (**not awaited** — it resolves only once linked, so events drive state), `sendMessage(chatId, media, {caption})`, `getChats()`, `MessageMedia.fromFilePath()`, `destroy()`.
- **Quirks:** `protocolTimeout` raised 180s → **300s** because a slow session restore hit `Runtime.callFunctionOn timed out`. A missing dependency surfaces as state `'not-installed'` with an install hint rather than crashing. `chatIdOf()` normalises a bare number / `+`-prefixed / `@c.us` / `@g.us`.

#### Print builder — `src/builder/builderDriver.js`

**Not an API.** A client-side-only web app with no HTTP endpoints. Playwright navigates to it, drives its DOM (folder input, mode/cover buttons, title field, cover tiles, rotation), waits for every `<img>`, then `page.pdf()` — which uses print media, reproducing the app's own `window.print()` output with no dialog.
- **Quirks:** the folder input pairs `<base>.jpg/.jpeg/.png` with `<base>.svg` and **ignores `_bw.png`**; the driver's `collectPairs()` mirrors that exact rule so it can never disagree with the live app. The "add all covers" button always selects 8, so the driver clicks the first N tiles individually instead.

### 3.5 Network-facing surfaces

| Surface | Value |
|---|---|
| Local server | `127.0.0.1:4173` (override `--port`/`PORT`/`HOST`) |
| Render bind | `0.0.0.0:$PORT` |
| Health check | `GET /healthz` → `{ok:true}`, **unauthenticated, answers before the auth gate** |
| Public auth gate | HTTP Basic via `STUDIO_USER`/`STUDIO_PASS` — **the only thing protecting the public URL** |
| Live studio | `https://fotomalovanky-studio.onrender.com` |
| Generator | `https://fotomalovanky-app.onrender.com/{token}/` |
| Builder | `https://fotomalovanky-service.onrender.com/` |
| Bridge IMAP / SMTP | `127.0.0.1:1143` / `127.0.0.1:1025` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta` |
| Shopify | `https://aqi8it-7n.myshopify.com/admin/api/2026-07/graphql.json` |
| Photo CDN | `cdn.tigren.com` |
| Render disk | `/data`, 5 GB — **everything outside it vanishes on redeploy** |
| Render Secret File | `config.json` at `/etc/secrets/config.json`, via `FMA_CONFIG` |

Cloud data dirs (`config.render.example.json`): `/data/inbox`, `/data/outbox`, `/data/whatsapp-session`, `/data/autopilot`, `/data/blog`, `/data/creatives`.

Deployment: Render Docker Web Service, **Pro instance (2 CPU / 4 GB, ~$85/mo)** — the 1-CPU Standard kept crashing under generation, and the free tier sleeps after 15 min which would stop automation entirely. Pushing to `main` auto-redeploys.

### 3.6 Hardcoded-credentials audit

**Result: no live secrets are hardcoded anywhere — tracked source or scratch scripts.** Verified by grepping tracked files (`git ls-files`) and all 21 `_*.mjs` scratch scripts for keys, tokens, `Bearer`, `x-goog-api-key`, chat JIDs and Czech phone patterns.

Every credential-shaped string in `src/`/`test/` is one of:
- a config-schema error message showing the expected *shape* (e.g. `"e.g. aqi8it-7n.myshopify.com"`),
- an obviously-fake test fixture (`'shpat_x'`, `'dummy-token'`, `'420123456789'`),
- or an invariant being asserted — `test/config.test.js:220`: `assert.ok(!json.includes('shpat_super_secret'), 'the token must never appear in redacted output')`.

`_credprobe.mjs` and `_diag.mjs` — the two likeliest to hold a pasted key — both load via `loadConfig()`. Clean.

**Personal data:** no personal phone numbers are hardcoded anywhere; every phone-shaped string in tracked source is a test fixture. The only real identifiers are the WhatsApp group JID and the two business email addresses, all in `config.json` only.

**Still outstanding (a manual op, not code):** `docs/plans/2026-07-13-001-verdict-apply-progress.md` flags **P0-3 token rotation** — rotate the generator token (it appeared in a screen recording) and move the Shopify token to an env var. Never done.

---

## 4. DATA

**There is no database.** All state is files on disk, plus constants baked into source. Two disk regions with very different lifecycles:

- **Inside the repo tree** (`./inbox/`, `./outbox/`) — customer photos and per-order working state. Fully gitignored (`/inbox/`, `/outbox/`, `**/state.json`). Never committed.
- **Outside the repo tree** — WhatsApp session, autopilot state, creatives, blog. Resolved per-OS by `config.js`: Windows `%LOCALAPPDATA%\fotomalovanky\<name>\`, macOS `~/Library/Application Support/fotomalovanky/<name>/`, Linux `$XDG_DATA_HOME/fotomalovanky/<name>/`. Overridable — but the loader **rejects any override resolving inside the repo tree**, because these hold a full-account WhatsApp credential, a Shopify token, or bulk binaries.

### 4.1 `outbox/<orderId>/` — the per-order working directory

One dir per Shopify order number. Live examples on disk: `1231`, `1269`, `1479`, `1521`–`1535`.

| File | Written by | Read by | Purpose |
|---|---|---|---|
| `state.json` | `manifest.js` | `manifest.js`, `review.js`, `retention.js`, `orchestrator.js` | Per-photo status + order dedication/intake. **The single source of truth.** |
| `objednavka.json` | the Chrome extension, or `shopify/materialize.js` | `orderInfo.js` | The shop's record: accented dedication, expected count, customer, line items, layout. **Optional — its absence is not an error.** |
| `<base>.jpg` | `organize.js` | review, builder, `retention.js` | The customer's original photo. **This is what gets purged.** |
| `<base>.svg` | generator → `organize.js` | builder, `review.js`/`editor.js` | Vector line art. **What actually prints.** |
| `<base>_bw.png` | generator → `organize.js` | review grid, QC, builder | Raster line art. Note `_bw` is on the **PNG**, not the SVG. |
| `<orderId> Final.pdf` | `builderDriver.js` | operator, `retention.js` | The finished book. |
| `draft-email.txt` | `orchestrator.js` via `emailDrafts.js` | `review.js` | Copy-paste email for a held order. **Never sent.** |
| `hidden.json` | `review.js` | `review.js` | Soft-delete marker. Files stay; deleting the marker restores the order. |
| `delivered.json` | `studio.js` | `studio.js` | "Sent to Jirka" — the sole truth for the `sent` state. |
| `printed.json` | `studio.js` | `studio.js`, **`retention.js`** | "Jirka confirmed print" — terminal, and **the only thing that lets purge delete photos**. |

### 4.2 `outbox/.originals/<orderId>/<base>.svg` — pre-edit backups

Written the **first** time the operator hand-edits a page: a copy of the SVG as the generator produced it. Deliberately kept **outside the order folder** (sibling `.originals/`) so the builder — handed the whole order dir — never picks up a spare SVG. Its mere existence is what marks a photo "edited" in the UI (`edited: existsSync(editBackupPath(...))`); `revertPhotoEdit` reads it back. Live for orders 1479, 1524, 1525, 1527–1530.

### 4.3 `inbox/<anything>/` — extension download folders

Not a fixed schema. `ingest.js` treats **every subdirectory containing `.jpg`/`.jpeg`** as one order (loose photos at the root = one order), and **recovers the order id from the photo filenames, not the folder name** — folder names get hand-edited and lie. (A real sample folder is named *1522* while holding eight *1523* photos.) `materialize.js` writes into this same shape.

### 4.4 The JSON schemas, field by field

#### `state.json` (`src/manifest.js`)

```
{
  orderId: string | null,
  dedication?: string,              // operator-set, max 500, trimmed.
                                    // ABSENT = "never decided"; "" = "deliberately empty"
  customerEmailedAt?: string(ISO),  // when the operator emailed about a hold
  intake?: {
    ...assessIntake() result,
    checkedAt: string(ISO),
    override: boolean,              // operator said "generate anyway"
    incompleteBook?: { pages, expected, at }   // operator shipped an under-count book
  },
  photosPurgedAt?: string(ISO),     // set by retention.js
  photos: {
    "<photoBase>": {
      status: "ok"|"flagged"|"pending_review"|"manual_in_progress"|"approved"|"failed",
      reason: string | null,        // e.g. "ok", "solid-fill"
      source?: string,              // absolute path to the original input
      attempt?: { steps: number, variant: string }
    }
  }
}
```

Real example (order 1522 — no PII in this one):
```json
{
  "orderId": "1522",
  "photos": {
    "1522_img0001": {
      "status": "ok", "reason": "ok",
      "source": "C:\\Users\\David\\Desktop\\Objednavky Hotove\\Fotomalovanky.cz - Objednávka 1522\\1522_img0001.jpg",
      "attempt": { "steps": 8, "variant": "2509_1.5" }
    }
  }
}
```

Real example (order 1231 — **REDACTED**: the child's name in filenames/dedication replaced with `[NAME]`), showing `dedication` and a `flagged` verdict:
```json
{
  "orderId": "1231",
  "photos": {
    "1231_img0001 - [NAME]": { "status": "ok", "reason": "ok",
      "source": "…\\1231\\1231_img0001 - [NAME].jpg",
      "attempt": { "steps": 8, "variant": "2509_1.5" } },
    "1231_img0004 - [NAME]": { "status": "flagged", "reason": "solid-fill",
      "source": "…\\1231\\1231_img0004 - [NAME].jpg",
      "attempt": { "steps": 8, "variant": "2509_1.5" } }
  },
  "dedication": "Pro [NAME]"
}
```

The `intake` block (computed by `intake.js`'s `assessIntake`):
```
{
  expected: number | null,      // from objednavka.json, or null
  uploaded: number,
  unique: number,               // uploaded minus exact-duplicate extras
  verdict: "ok" | "warn" | "hold",
  emailCase: "missing"|"unreadable"|"duplicate"|"quality"|null,
  findings: [
    { check:"resolution"|"blur"|"exposure", base, verdict, reason, ...measurement },
    { check:"duplicate", verdict, reason:"duplicate-identical"|"possible-duplicate", bases:[...] },
    { check:"count", verdict, reason:"missing-photos"|"extra-photos", expected, uploaded, unique, missing }
  ],
  checkedAt: string(ISO),
  override: boolean
}
```

#### `objednavka.json` (`src/orderInfo.js`, `src/shopify/materialize.js`)

```
{
  order: string,
  dedication: string,                     // the customer's literal, ACCENTED text
  expectedPhotos?: number,                // positive int only; else dropped to null
  customer?: { surname: string, email: string },
  products: [ { title, variant, qty } ],
  // autopilot-only fields:
  photos?: string[],                      // source URLs
  layout?: string,                        // the raw "Rozvržení" value
  source?: "shopify-admin-api",
  downloadedAt?: string(ISO)
}
```

`readOrderInfo()` is **defensively strict**: any field of the wrong type is silently dropped rather than trusted, and a missing/corrupt file returns `null`, never an error — **a book must stay printable from photographs alone.**

#### The lifecycle markers

```json
// hidden.json
{ "hiddenAt": "2026-07-13T15:26:41.407Z" }

// printed.json  — the retention-purge gate
{ "at": "2026-07-13T12:46:54.639Z", "by": "operator" }

// delivered.json — `by` is "operator" (manual) or "whatsapp" (auto-send)
{
  "at": "2026-07-13T15:33:53.247Z",
  "by": "whatsapp",
  "to": "120363411363494650@g.us",
  "messageId": "true_120363411363494650@g.us_3EB0D8CED3232F001A1B66_241961864806588@lid",
  "sentPdfMtime": 1783946025325.8174
}
```

`sentPdfMtime` is the mtime of the **exact PDF that went out** — used to detect "book rebuilt after send, offer to re-send". Deliberately an mtime, not a hash: cheaper, and a rebuild always changes mtime.

#### `autopilot-state.json` (`src/autopilotState.js`)

```
{
  handled: { "<orderId>": { status: "ready"|"deleted", at: ISO } },
  cursor: string(ISO) | null,
  lastRunAt: string(ISO) | null
}
```

**Only terminal orders are recorded.** Held/failed orders are deliberately excluded so the next poll re-pulls them — that's what lets an overnight customer re-upload lift a hold with no human involved.

Live file:
```json
{
  "handled": {
    "1519": { "status": "ready", "at": "2026-07-12T19:14:36.655Z" },
    "1525": { "status": "deleted", "at": "2026-07-13T15:26:41.408Z" },
    "1535": { "status": "ready", "at": "2026-07-16T09:49:27.519Z" }
  },
  "cursor": "2026-07-16T09:35:58Z",
  "lastRunAt": "2026-07-16T15:49:27.651Z"
}
```

#### `overnight-report.json` (`src/autopilotReport.js`)

```
{
  ranAt: ISO,
  window: { from: ISO, to: ISO },
  counts: { ready, held, failed },
  orders: [...],
  seen, paidPhotoSeen, nonPaidPhotoSeen, skippedResolved, processed, generated,
  estSpend: number        // generated × shopify.estSpendPerOrder
}
```
Documented as safe to surface on the dashboard: **never the token, and no customer email/name beyond the order number.**

#### `creatives-index.json` (`src/creatives/adCalendar.js`)

```
{
  generatedAt: ISO,
  occasions: {
    "<occasionKey>": {                     // "MM-DD-slug", e.g. "02-14-sv-valentyn"
      key, occasion: { m, d, name, persona, angle, tone },
      ads: [ { id, template, family, format, file, copy: {...}, copySource: "ai"|"seed" } ],
      generatedAt: ISO
    }
  }
}
```
Live: ~2160 lines, 30+ occasions × 4 ads (2 concepts × feed/story). No PII — the imagery comes from text prompts, never a customer photo.

#### `blog-index.json` + `posts/<id>.json` (`src/blog/store.js`)

```
// blog-index.json — summaries only, so the list view needn't open every post
{ updatedAt: ISO|null,
  posts: { "<id>": { id, seoTitle, keyword, source:"manual"|"calendar"|"seo",
                     status, hasHero, warnings, createdAt, updatedAt } } }

// posts/<id>.json
{
  id: string,                    // = handle; validated /^[a-z0-9][a-z0-9-]{0,120}$/
  topic: { title, keyword, intent, source, occasionKey },
  seoTitle: string,              // ≤60
  metaDescription: string,       // ≤155
  handle, tags: string[],        // ≤6
  intro: string,
  sections: [ { h2, paragraphs: [], bullets: [] } ],
  faq: [ { q, a } ],
  internalLinkHint, heroPrompt, heroAlt,
  heroImage: null|object,
  status: "koncept"|…,
  shopifyArticleId: string|null,
  copySource: "ai"|"seed",
  plainText: string,             // derived from bodyHtml, recomputed every save
  bodyHtml: string,              // deterministically assembled — never raw model HTML
  qc: { warnings: [ { code, message } ] },
  createdAt: ISO,                // stamped once
  updatedAt: ISO                 // stamped every save
}
```

#### `dedications.json` (`src/dedications.js`)

Flat `{ "<slug>": "<corrected text>" }`, e.g. `{ "pro_jiricka": "Pro Jiříčka" }`. Written atomically (`.tmp` + rename). **Lives beside `config.json`, in the project root — deliberately NOT in the outbox**, so it survives the outbox being emptied to an archive. A legacy `outbox/.dedications.json` is auto-migrated in and then deleted. Never committed (it would be pure PII).

### 4.5 Render `/data` mapping

| Local default | Render |
|---|---|
| `./inbox` | `/data/inbox` |
| `./outbox` | `/data/outbox` |
| `whatsapp.sessionDir` | `/data/whatsapp-session` |
| `shopify.dataDir` | `/data/autopilot` |
| `creatives.dataDir` | `/data/creatives` |
| `blog.dataDir` | `/data/blog` |

Everything under `/data` survives a redeploy; everything else does not. `config.json` is **not** on the disk — it's a Render Secret File at `/etc/secrets/config.json`.

### 4.6 `MARKETING_CAL` — the 33-occasion marketing calendar (`src/creatives/calendar.js`)

Hand-authored business content, not code. `tone`: `brand` = love/family, `warm` = seasonal/gift, `info` = general. `occasionKey(o)` → `MM-DD-slug`, which names the creatives folder.

> **This is mirrored inline in `dashboard.html` (~line 1238).** Two copies, kept in sync by hand. **A rebuild should collapse this to one source.**

| M/D | Name | Persona | Tone | Angle |
|---|---|---|---|---|
| 1/2 | Novoroční detox & Slow Living | Dospělí (mindfulness) | info | Po shonu Vánoc vypněte. Nalijte si čaj a vybarvěte vzpomínku na klidnou zimní krajinu. |
| 1/19 | Blue Monday | Přátelé / kolegové | info | Nejdepresivnější den v roce? Pošlete kamarádovi vtipnou fotku z poslední akce jako omalovánku. |
| 2/13 | Galentine's Day | Kamarádky | brand | Kdo potřebuje chlapa, když má nejlepší kámošku? Omalovánka z vaší dámské jízdy. |
| 2/14 | Sv. Valentýn | Páry | brand | Rande s vínem a pastelkami nad vaší společnou fotkou — originální obraz do ložnice. |
| 2/16 | Jarní prázdniny | Rodiče, prarodiče | warm | Když na horách prší nebo děti nelyžují — zábava na chatě bez Wi-Fi. |
| 3/8 | MDŽ | Muži pro ženy / ženy sobě | brand | Pro ženu vašeho života. Nejen kytku, ale chvilku pro sebe, kdy může tvořit a relaxovat. |
| 3/13 | Světový den spánku | Dospělí (stresovaní) | info | Nemůžete spát? Místo koukání do mobilu zkuste vybarvovat — prokazatelně uklidňuje. |
| 3/20 | První jarní den | Všichni (hobby) | warm | Svět se barví, vy taky. Vyfoťte první sněženky a zachyťte to kouzlo. |
| 4/1 | Apríl | Přátelé (vtipálci) | info | Máte fotku, kde se kamarád tváří „inteligentně"? Udělejte z toho omalovánku. |
| 4/5 | Velikonoce | Rodina / kreativci | warm | Letos žádné čokoládové figurky. Kreativní výslužka, která se nezkazí. |
| 4/15 | Svatební sezóna (start) | Svatebčané | brand | Omalovánka místa seznámení — nebo zábava pro děti na svatební hostině. |
| 5/1 | 1. máj (lásky čas) | Páry | brand | Nestihli jste polibek pod rozkvetlou třešní? Nevadí, vybarvěte si ho doma. |
| 5/10 | Den matek | Děti pro mámy | brand | Mámo, díky za vše. Naše společná chvíle, kterou si můžeš vybarvit a zarámovat. |
| 5/15 | Mezinárodní den rodiny | Rodina | warm | Vypněte TV, sedněte si všichni ke stolu. Velká sada omalovánek pro celou rodinu. |
| 6/1 | Den dětí | Rodiče / prarodiče | warm | Dítě jako hlavní hrdina — omalovánka, kde je on sám Batmanem nebo princeznou. |
| 6/21 | Den otců | Děti pro táty | info | Pro tátu a jeho „hračky" — omalovánka jeho auta, motorky, psa nebo fotbalu. |
| 6/30 | Konec školního roku | Žáci pro učitele | warm | Místo bonboniéry koláž třídy jako omalovánka. Památka na vaše „zlobidla". |
| 7/1 | Cestování & prázdniny | Cestovatelé | info | Vyfoť, pošli, vybarvi. Až se vrátíte z dovolené, prodlužte si ten pocit. |
| 7/15 | Letní festivaly & párty | Mladí dospělí | warm | Legendární fotka z festivalu? Zvěčněte ji. Skvělý dárek k narozeninám pro parťáka. |
| 8/8 | Mezinárodní den koček | Majitelé koček | info | Váš kočičí vládce si zaslouží portrét. Relaxace u vybarvování chlupáče. |
| 8/15 | Svatby (vrchol sezóny) | Rozlučka se svobodou | brand | Vtipný dárek pro nevěstu? Omalovánka ženicha (nebo svalnatého plavčíka). |
| 8/26 | Mezinárodní den psů | Majitelé psů | info | Z fotky z parku uděláme umělecké dílo. Nejlepší dekorace do bytu pejskaře. |
| 9/1 | Back to School / Work | Dospělí (office) | info | Šéf vás štve? Uklidněte se u omalovánky z letní dovolené. Zenová pauza v kanceláři. |
| 9/15 | Výročí & rande | Páry | brand | První výročí je „papírové". Co je lepšího než papírová vzpomínka na váš den D? |
| 10/1 | Den prarodičů | Vnoučata pro prarodiče | warm | Trénink bystrosti pro babičku a dědu — a největší motivací je fotka vnoučat. |
| 10/10 | Světový den duševního zdraví | Dospělí (self-care) | info | Terapie uměním. Vypněte hlavu, vnímejte jen tahy tužkou. Vaše fotka jako mandala. |
| 10/31 | Halloween | Rodiny / přátelé | warm | Ta maska se fakt povedla! Uchovejte ji navždy — nebo strašidelný dárek pro kamarády. |
| 11/1 | Movember | Muži / přátelé | info | Máte fotku s knírem? Udělejte z ní vtipnou omalovánku pro kámoše. |
| 11/27 | Black Friday | Všichni | brand | Nekupujte lapače prachu. Kupte zážitek a emoci — dárek, který má smysl. |
| 11/29 | Adventní přípravy | Rodiny | warm | 24 malých fotek jako omalovánkový adventní kalendář? Proč ne! |
| 12/5 | Mikuláš | Děti | warm | Zdravější než sladkosti. Omalovánka čerta, kterého dítě „přemaluje" na hodného. |
| 12/24 | Vánoce | Všichni (hlavní sezóna) | brand | Ten NEJ dárek — pro babičku vnoučata, pro partnera rande, pro kamaráda momentka. |
| 12/31 | Silvestr | Přátelé | info | Originální PF? Vybarvená fotka vaší rodiny nebo týmu. Pošlete to dál. |

> Note the **Black Friday angle carries no discount** — it is on-brand precisely by refusing the obvious play. `sleva` is a banned stem (§6.4).

### 4.7 `TEMPLATES` + `SEED_COPY` (`src/creatives/studio/templates.js`)

Each template is a **deterministic layout program**: an ordered array of typed elements (`background`/`panel`/`image`/`text`/`cta`/`logo`/`decoration`), each with a percentage `box {x,y,w,h}`, a `layer`, a `style`, optional `constraints`, and per-format overrides. ~230 lines of **hand-tuned geometry — carry it forward verbatim.**

| id | family | theme | supportedFormats | requiresCta | image slots |
|---|---|---|---|---|---|
| `promena` | Proměna | `grape` (flagship) | feed, story, landscape, portrait | false | `original`, `coloring` |
| `emotivni-darek` | Emotivní dárek | `terracotta` | feed, story, landscape | true | `lifestyle`, `product` |
| `spolecne-vybarvovani` | Společné vybarvování | `meadow` | feed, story, landscape | true | `lifestyle` |
| `produktova-ukazka` | Produktová ukázka | `sand` | feed, story, landscape | true | `product` |
| `reference-zakaznika` | Reference zákazníka | `denim` | feed, story, landscape | false | `lifestyle`, `product` |

`promena` is the flagship: David's favourite "sourozenci" ad rebuilt as layers — a taped before-photo polaroid + a black-keyline after-page joined by a hand-drawn orange arrow, on solid brand-violet, with a white headline card + logo along the bottom.

`SEED_COPY` — the fallback used whenever AI copy fails **or is off-brand**:

| id | headline | headlineHi | support | cta | badge / testimonial |
|---|---|---|---|---|---|
| `promena` | "Omalovánky z" | "vašich fotek" | "Z vaší fotky uděláme omalovánku na míru." | "Vytvořit omalovánku" | badge: "Originální dárek" |
| `emotivni-darek` | "Dárek, který" | "potěší" | "Osobní omalovánka z vaší nejmilejší fotky." | "Objednat dárek" | badge: "Dárek na míru" |
| `spolecne-vybarvovani` | "Společné chvíle u" | "vybarvování" | "Zábava pro celou rodinu — vaše vlastní omalovánky." | "Vyzkoušet" | — |
| `produktova-ukazka` | "Vaše fotky jako" | "kniha" | "Tištěná omalovánková kniha z vašich vzpomínek." | "Prohlédnout" | — |
| `reference-zakaznika` | "Co říkají" | "zákazníci" | "" | "Objednat také" | testimonial: „Nádherný dárek, babička měla slzy v očích." / author: "— Jana N." |

Declared per-element constraints (the budget `adCopy.js` reads via `templateFieldLimits`):

| template | headline | support | cta | testimonial | author |
|---|---|---|---|---|---|
| `promena` | 44 / 2 lines | — | — | — | — |
| `emotivni-darek` | 40 / 2 | 90 / 2 (**capped to 58** by `copyCap`) | 28 | — | — |
| `spolecne-vybarvovani` | 42 / 2 | — | 26 | — | — |
| `produktova-ukazka` | 40 / 2 | 80 / 2 (**→ 58**) | 26 | — | — |
| `reference-zakaznika` | — | — | — | 140 / 4, **required** | 40 |

Helpers to port alongside: `templateSlots()`, `templateFields()`, `templateFieldLimits()`, `listTemplates()`.

### 4.8 `BRAND` + `THEMES` (`src/creatives/studio/brandKit.js`)

```js
BRAND = { ink: '#2A2622', paper: '#FBF7F0',
          hues: ['#F1543F','#F5A623','#22A06B','#3B82F6'], accent: '#F1543F' }
```

| Theme | Background | Accent | Used by |
|---|---|---|---|
| `rainbow` | gradient `#DDF3E3→#FBF2D6→#FDE4D4→#FBD9E7` | `#22A06B` | (spare, legacy) |
| `sunset` | gradient `#FCDDEA→#FDE6D6→#FBEFD4` | `#F1543F` | (spare, legacy) |
| `sky` | gradient `#E4F0FB→#EAF6EE→#FBE8F0` | `#3B82F6` | (spare, legacy) |
| `cream` | gradient `#FDF6EC→#FBEFE0` | `#F5A623` | (spare, legacy) |
| `forest` | gradient `#E7F3E9→#F3F7E4` | `#22A06B` | (spare, legacy) |
| **`grape`** | solid `#6C5CE7` | `#F5A623` | `promena` (flagship) |
| **`terracotta`** | solid `#D96A4F` | `#F5A623` | `emotivni-darek` |
| **`meadow`** | solid `#2E9E6B` | `#F7B733` | `spolecne-vybarvovani` |
| **`sand`** | solid `#F3EADB` | `#E0673F` | `produktova-ukazka` |
| **`denim`** | solid `#3D6E9E` | `#F5A623` | `reference-zakaznika` |

**The gradient washes are legacy; the solid grounds are the current formula.** The comment records the design evolution: the flagship look is *a flat brand hue, not a wash* — the five gradient themes remain only as spares, and reaching for one would undo the rework that made the calendar read as a premium set rather than "five gradient stock ads".

Hand-drawn SVG atoms (inline, resolution-independent): `crayon`, `scribble`, `sun`, `sparkle`, **`tape`** (the signature amber washi-tape holding every photo/product card), **`arrow`** (the flagship before→after orange arrow), plus `starburst()` (badge disc), `logoMark()` / `wordmark()` (the drawn-logo fallback, each letter cycling the brand hues). `decoration(name, color)` returns `''` for an unknown name — **a template typo degrades to "no doodle", never a broken image.**

### 4.9 `STUDIO_FORMATS` (`src/creatives/studio/formats.js`)

| key | w×h | label | ratio | safe inset |
|---|---|---|---|---|
| `feed` | 1080×1080 | Feed 1:1 | 1:1 | 64px |
| `story` | 1080×1920 | Story 9:16 | 9:16 | 96px |
| `landscape` | 1200×628 | Landscape 1.91:1 | 1.91:1 | 56px |
| `portrait` | 1080×1350 | Feed 4:5 | 4:5 | 64px |

`DEFAULT_FORMATS = ['feed','story','landscape']`. `portrait` is defined but required of no template. `AUTO_FORMATS` (auto-produced per concept) = `['feed','story']`.

### 4.10 Hand-authored linguistic data (`src/dedications.js`)

Two curated word sets, each learned from real customer filenames — **port verbatim**:

- **`LOWERCASE_WITHIN`** — Czech prepositions/conjunctions staying lowercase mid-title:
  `a, i, k, ke, o, od, po, pro, s, se, u, v, ve, z, ze, do, na, za, při, nad, pod, bez, aneb, nebo`
- **`GENERIC_LABELS`** — words meaning "the customer left it blank and the shop auto-filled a placeholder", so they must **not** be printed as a dedication:
  `foto, fota, fotka, fotky, fotku, fotografie, fotografia, fotografy, photo, photos, picture, pictures, pic, pics, image, images, img, obrazek, obrazky, obrazku, snimek, snimky, snimku`

Plus the two filename-separator conventions the two Chrome-extension versions have used — `'_-_'` and `' - '` — both meaning "what follows is the dedication".

### 4.11 Test fixtures

No `test/fixtures/` dir — every test builds its own inline via `mkdtempSync`/`tmpdir()`. Nothing here is a reusable data *file*, but several encode the schema's edge cases as executable spec and should be ported with their modules:

- `test/adCalendar.test.js` — asserts **every `SEED_COPY` entry is itself banned-word-clean**. The seed data is treated as brand-safety-critical, not decorative.
- `test/orderInfo.test.js` — `objednavka.json` variants + malformed-input rejection (`expectedPhotos: 0` or `4.5` → dropped; `customer` as a string → dropped) + `resolveFormat()` mapping.
- `test/manifest.test.js` — the transition table.
- `test/dedications.test.js` / `test/dedication.test.js` — both separator conventions, the `+` convention, majority vote, generic-label stripping.
- `test/retention.test.js` — the full purge-eligibility matrix, with real mtimes via `utimesSync`.
- `test/autopilotState.test.js` — handled/cursor/corrupt-degrades-to-empty.
- `test/blog.test.js` — store round-trips + `qcPost` warning codes.

### 4.12 Retention / cleanup (`src/retention.js`, `src/purge.js`)

**Trigger: manual only** — `npm run purge` (dry-run by default; `--yes` to delete; `--days N` to override). **There is no scheduled purge.**

**What gets deleted:** only the customer's **original photograph** (`<base>.jpg`). The line art (`.svg`, `_bw.png`) and the PDF are **never** deleted — "it is a drawing, and the operator may want to reprint from it."

The file's own header records why it exists: it had been a no-op since the first commit — *"Every child's face this tool has processed was still on the disk."*

**The eligibility gate — all four must hold:**
1. `printed.json` exists. **A book merely *sent* over WhatsApp is explicitly not enough** — only Jirka's confirmed-print marker counts.
2. `<orderId> Final.pdf` exists.
3. The PDF's mtime is **newer** than `state.json`'s — i.e. it was printed from the decisions currently on disk, not left stale by a verdict changed afterward.
4. `now - printed.json mtime >= retentionDays` — age from the **confirmation**, not the build.

Each failure yields a human-readable skip reason (`"not confirmed printed yet"`, `"a decision changed after the book was printed"`, `"printed N days ago, keeping for D"`, …).

**On delete:** each photo `rmSync`'d, `state.json` stamped `photosPurgedAt` (so the UI says "purged" not "missing", and a second run is idempotent), and — deliberately — **`state.json`'s mtime is restored via `utimesSync`**, because that mtime is the orchestrator's "last decided" clock and **a purge is not a decision**.

**The caveat surfaced every run** (`purgeWarning`): *"The photographs are also inside each '<order> Final.pdf', and in whatever folder you archived the finished books to. This only clears the working outbox."* — this purge does **not** make the photographs gone from the machine.

**Autopilot data purge** (same command, same clock): ages out `autopilot-state.json` + `overnight-report.json`. Both are rewritten on every run, so crossing the age threshold only happens when the autopilot has genuinely stopped — exactly when its cached order data should go.

---
## 5. BUSINESS LOGIC WORTH PRESERVING

This section is the part of the repo that took real thought. The prompts can be re-tuned, the tables
re-typed, the UI re-drawn — but the heuristics below encode bugs that were actually hit in
production, thresholds calibrated against a real order, and state machines whose every edge was put
there because something went wrong without it. The code comments in this codebase document *the bug
each piece fixed*. That reasoning is the most valuable thing in the repository and is preserved
verbatim below.

---

### 5.1 Image processing — `src/autoCrop.js`

The generator returns each coloring page on its own canvas. Two things go wrong with that canvas, and
`autoCrop.js` fixes both — in the right order, on both the raster and the vector.

The module header states the whole problem and the source-of-truth rule:

```js
// src/autoCrop.js:1-8
// Auto-crop the generator's coloring page down to its actual drawing. The image model returns each
// page on its own canvas, and when it drops the background (a boat on water becomes a boat on white)
// the subject ends up marooned in a wide white margin — which then prints as ugly white borders and
// wastes the page. This trims the page to the ink and rewrites the SVG's viewBox to match, so the
// drawing fills the printable area. A page whose ink already reaches the edges is left untouched.
//
// The raster (_bw.png) is the source of truth for where the ink is (measuring an SVG needs a render);
// the SVG is what actually prints, so both are cropped to the same box, in the SVG's own units.
```

That last paragraph is the load-bearing design decision: **measure on the PNG, apply to both.** The
SVG is what the builder prints, but measuring an SVG's ink would require rendering it first. The
`_bw.png` is already a rendered raster of the same drawing, so it is the cheap measuring stick — and
whatever box it yields is then applied to the SVG in the SVG's own coordinate units.

#### The tuned constants

```js
// src/autoCrop.js:13-19
const INK = 120; // a grayscale value below this is a drawn line, not paper
const NOISE_FRACTION = 0.003; // a row/column needs this fraction of ink pixels to count as content (ignores stray specks)
const MARGIN_FRACTION = 0.012; // breathing room left around the drawing so lines aren't flush to the cut
const SKIP_ABOVE = 0.94; // when the ink already fills >94% of the frame, there's nothing to gain — leave it

const FRAME_BAND = 0.05; // only look this far in from each edge for a border keyline
const FRAME_INK_FRACTION = 0.85; // a perimeter row/col this solid across its whole span is a frame, not content
```

Each of these is a decision, not a magic number:

- `INK = 120` — the ink/paper split on a grayscale 0-255 scale. Shared by `deframe`, `contentBox`,
  and (as `darkThreshold: 128`) by `qc.js`.
- `NOISE_FRACTION = 0.003` — a single stray speck in a corner must not define the bounding box. A
  row needs ~0.3% of its pixels inked before it counts as content.
- `MARGIN_FRACTION = 0.012` — the crop leaves ~1.2% breathing room, so a line is never flush to the
  paper cut.
- `SKIP_ABOVE = 0.94` — when the ink already fills the frame, cropping gains nothing and only risks
  damage. Leave it alone.
- `FRAME_BAND = 0.05` — a border keyline is by definition *near an edge*. Only the outer 5% of each
  side is scanned, so a solid line through the middle of the drawing can never be mistaken for a
  frame.
- `FRAME_INK_FRACTION = 0.85` — the crux of the deframe heuristic (see below).

#### `deframe()` — the black keyline stripper

```js
// src/autoCrop.js:21-27
/** Remove a solid black keyline the model sometimes draws around a page (mostly on wide/landscape
 *  outputs) — it would otherwise print as an ugly black border, and it defeats autoCrop because the
 *  frame IS the outermost ink (so the ink box is the whole page). We scan each edge's outer band for a
 *  near-100%-ink line and crop the page (PNG + SVG viewBox together) to just inside it. Content lines
 *  are never fully solid edge-to-edge, so the 0.85 threshold leaves real drawing alone; edges with no
 *  border keep their edge. Returns { deframed } — false when no border line is found (the common case),
 *  so it's safe to run on every page before autoCrop. */
```

**Why it exists:** two separate bugs in one. (1) The model draws a black border on some wide/landscape
pages; that border prints as an ugly black frame around the customer's coloring page. (2) More
subtly, the border *defeats `autoCropColoring` entirely* — the frame IS the outermost ink, so the ink
bounding box is the whole page and the crop becomes a no-op. Deframing has to run *first*, or the
crop silently does nothing on exactly the pages that need it most.

```js
// src/autoCrop.js:28-57
export async function deframe({ pngPath, svgPath } = {}) {
  const { data, info } = await sharp(pngPath).grayscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const rowFrac = (y) => { let c = 0; const o = y * W; for (let x = 0; x < W; x++) if (data[o + x] < INK) c++; return c / W; };
  const colFrac = (x) => { let c = 0; for (let y = 0; y < H; y++) if (data[y * W + x] < INK) c++; return c / H; };
  const bandY = Math.max(1, Math.round(H * FRAME_BAND));
  const bandX = Math.max(1, Math.round(W * FRAME_BAND));
  // The innermost frame line inside each edge band (or -1). Innermost so a doubled border is fully cleared.
  let top = -1; for (let y = 0; y < bandY; y++) if (rowFrac(y) >= FRAME_INK_FRACTION) top = y;
  let bottom = -1; for (let y = H - 1; y >= H - bandY; y--) if (rowFrac(y) >= FRAME_INK_FRACTION) bottom = y;
  let left = -1; for (let x = 0; x < bandX; x++) if (colFrac(x) >= FRAME_INK_FRACTION) left = x;
  let right = -1; for (let x = W - 1; x >= W - bandX; x--) if (colFrac(x) >= FRAME_INK_FRACTION) right = x;
  // Only treat it as a border when it's actually frame-shaped: a full rectangle (≥3 edges) or a
  // letterbox (an opposite pair). A single solid edge line — a wall, a table edge flush to the border —
  // is real drawing, not a frame, and must be left alone.
  const found = [top >= 0, bottom >= 0, left >= 0, right >= 0].filter(Boolean).length;
  const pairH = top >= 0 && bottom >= 0;
  const pairV = left >= 0 && right >= 0;
  if (found < 3 && !pairH && !pairV) return { deframed: false };
  const l = left >= 0 ? left + 1 : 0;
  const t = top >= 0 ? top + 1 : 0;
  const r = right >= 0 ? right - 1 : W - 1;
  const b = bottom >= 0 ? bottom - 1 : H - 1;
  // A frame should only ever be a thin border; if "inside the frame" is less than half the page, the
  // detection is wrong (e.g. a genuinely ink-heavy page) — leave it alone rather than gut the drawing.
  if (r - l < W * 0.5 || b - t < H * 0.5) return { deframed: false };
  const box = { W, H, left: l, top: t, width: r - l + 1, height: b - t + 1 };
  await cropTo({ pngPath, svgPath, box });
  return { deframed: true, box };
}
```

**The three guards** — this is the part that makes the heuristic safe to run on every page:

1. **≥3 edges, or an opposite pair.** `if (found < 3 && !pairH && !pairV) return { deframed: false };`
   A frame is *frame-shaped*: a full rectangle (3 or 4 edges detected) or a letterbox (an opposite
   pair — top+bottom, or left+right). A single solid line along one edge is **real drawing** — the
   comment names the exact false positives: *"a wall, a table edge flush to the border"*. Cropping
   those would cut into the customer's picture.

2. **Innermost wins.** The loops deliberately do **not** `break` on the first hit — they keep
   scanning and keep the last (innermost) match: *"Innermost so a doubled border is fully cleared."*
   The model sometimes draws a double keyline; taking the outermost line would leave the inner one
   printed.

3. **≥50% of the page must survive.** `if (r - l < W * 0.5 || b - t < H * 0.5) return { deframed: false };`
   A frame is by definition a thin border. If "inside the frame" is less than half the page, the
   detection has misfired (a genuinely ink-heavy page whose edges happen to be dark) — and the code
   would gut the drawing. *"leave it alone rather than gut the drawing."* The failure mode is
   deliberately biased toward "do nothing".

Note the return contract: `{ deframed: false }` in the common case, which is why the caller can run
it unconditionally on every page before `autoCropColoring`.

#### `contentBox()` — the ink bounding box

```js
// src/autoCrop.js:59-79
/** The tight bounding box of the ink in a coloring page, plus a small margin. Null for a blank page
 *  (all paper) — cropping that to nothing would be worse than leaving it. Returns box in PNG pixels. */
export async function contentBox(pngPath) {
  const { data, info } = await sharp(pngPath).grayscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const minRow = Math.max(2, Math.round(W * NOISE_FRACTION));
  const minCol = Math.max(2, Math.round(H * NOISE_FRACTION));
  const rowInk = (y) => { let c = 0; const o = y * W; for (let x = 0; x < W; x++) if (data[o + x] < INK) c++; return c; };
  const colInk = (x) => { let c = 0; for (let y = 0; y < H; y++) if (data[y * W + x] < INK) c++; return c; };

  let top = 0; while (top < H && rowInk(top) < minRow) top++;
  if (top === H) return null; // no ink anywhere
  let bottom = H - 1; while (bottom > top && rowInk(bottom) < minRow) bottom--;
  let left = 0; while (left < W && colInk(left) < minCol) left++;
  let right = W - 1; while (right > left && colInk(right) < minCol) right--;

  const mx = Math.round(W * MARGIN_FRACTION), my = Math.round(H * MARGIN_FRACTION);
  left = Math.max(0, left - mx); top = Math.max(0, top - my);
  right = Math.min(W - 1, right + mx); bottom = Math.min(H - 1, bottom + my);
  return { W, H, left, top, width: right - left + 1, height: bottom - top + 1 };
}
```

Walk in from each of the four edges until a row/column carries at least `NOISE_FRACTION` of ink, then
expand by `MARGIN_FRACTION` and clamp to the page. `null` for a page with no ink at all — *"cropping
that to nothing would be worse than leaving it."* The `Math.max(2, …)` floor means even a tiny image
needs at least 2 ink pixels in a row before that row counts.

#### `cropSvgViewBox()` — the vector half

```js
// src/autoCrop.js:81-96
/** Rewrite an SVG's viewBox to the crop box (given in PNG pixels), scaled into the SVG's own units.
 *  The generator writes a viewBox and no width/height, so the viewBox alone frames the page. */
function cropSvgViewBox(svgPath, box) {
  const svg = readFileSync(svgPath, 'utf8');
  const m = svg.match(/viewBox\s*=\s*"([^"]+)"/i);
  if (!m) return false;
  const [x0, y0, vw, vh] = m[1].trim().split(/[\s,]+/).map(Number);
  if (![x0, y0, vw, vh].every(Number.isFinite) || vw <= 0 || vh <= 0) return false;
  const sx = vw / box.W, sy = vh / box.H; // usually 1:1, but the SVG may be at a different scale
  const nx = (x0 + box.left * sx).toFixed(2);
  const ny = (y0 + box.top * sy).toFixed(2);
  const nw = (box.width * sx).toFixed(2);
  const nh = (box.height * sy).toFixed(2);
  writeFileSync(svgPath, svg.replace(m[0], `viewBox="${nx} ${ny} ${nw} ${nh}"`));
  return true;
}
```

Key facts encoded here:

- **The generator writes a viewBox and no width/height**, so rewriting the viewBox alone reframes the
  printed page. No other SVG surgery is needed.
- The `sx`/`sy` scale factors exist because the SVG's coordinate space need not match the PNG's pixel
  dimensions — *"usually 1:1, but the SVG may be at a different scale"*. Measuring on the raster and
  applying to the vector requires this conversion; hard-coding 1:1 would work in testing and silently
  mis-crop the moment the generator changed its output scale.
- Both failure paths return `false` rather than throwing: no viewBox, or an unparseable one. A crop
  hiccup must never fail a page the GPU already paid for (see `generatePhoto` in §5.4).

#### `cropTo()` — the shared apply step, and a real platform bug

```js
// src/autoCrop.js:98-105
/** Extract a box (in PNG pixels) from the raster and crop the SVG viewBox to match, so the printed
 *  vector and the raster stay in sync. Shared by autoCrop and deframe. */
async function cropTo({ pngPath, svgPath, box }) {
  // sharp can't read and overwrite the same file in one pipeline — buffer, then write.
  const cropped = await sharp(pngPath).extract({ left: box.left, top: box.top, width: box.width, height: box.height }).png().toBuffer();
  writeFileSync(pngPath, cropped);
  if (svgPath) cropSvgViewBox(svgPath, box);
}
```

`sharp` (libvips) keeps a file mapped while it works; you cannot read and overwrite the same path in
one pipeline. Buffer first, then write. **This same libvips-holds-the-file trap recurs three more
times in the codebase** (`review.js:304` `rasterize`, `ui/server.js:180` `thumbnail`) — see §5.9.

#### `autoCropColoring()` — the public entry point

```js
// src/autoCrop.js:107-116
/** Crop a coloring page (PNG raster + SVG vector) to its ink. No-op when the drawing already fills
 *  the frame. Returns { cropped, kept } — `kept` is the fraction of area retained. */
export async function autoCropColoring({ pngPath, svgPath }) {
  const box = await contentBox(pngPath);
  if (!box) return { cropped: false, reason: 'blank' };
  const kept = (box.width * box.height) / (box.W * box.H);
  if (kept > SKIP_ABOVE) return { cropped: false, reason: 'already-full', kept };
  await cropTo({ pngPath, svgPath, box });
  return { cropped: true, kept, box };
}
```

Three outcomes, all non-throwing: `blank` (no ink — leave it, QC will flag it), `already-full` (>94%
kept — nothing to gain), or a real crop with `kept` reported so the run log can say how much came off.

**Rebuild note:** the ordering `deframe()` → `autoCropColoring()` is not stylistic. Deframe must run
first or the crop is a no-op on framed pages. See `batch.js:87-98` for the call site.

---

### 5.2 Output QC — `src/qc.js` / `src/qcFiles.js`

#### The pure/adapter split

```js
// src/qc.js:1-2
// Pure QC heuristics. They operate on already-decoded data so they are testable
// without an image library; a thin sharp-based adapter feeds these at runtime.
```

This split — pure heuristic in one file, thin sharp adapter in another — is repeated exactly for
input QC (`inputQc.js` / `inputQcFiles.js`). It is one of the codebase's cross-cutting principles
(§5.9): the judgement is a pure function of decoded pixels, so it is unit-testable with a plain
array; only the adapter needs sharp.

#### What QC is, and what it is explicitly NOT

```js
// src/qcFiles.js:5-9
// Runtime adapter: decode one photo's organized outputs and feed the pure heuristics in
// qc.js. This is a tripwire for output that is wrong on its face — a blank page, a solid black
// page, an SVG with no paths, a drawing whose dark areas are filled in rather than outlined —
// not a judge of drawing quality. It cannot see an invented background or a lost likeness.
// The operator's review grid is that judge.
```

This scope statement is the whole philosophy of the gate. QC is a **tripwire**, not a critic. It
catches output that is wrong *on its face*. It cannot see an invented background or a lost likeness —
that judgement belongs to the human, and the review grid exists for it. Keeping QC's ambition this
low is what keeps its false-positive rate low enough that the operator trusts it.

#### `DEFAULT_QC` and the calibration provenance

```js
// src/qc.js:4-18
export const DEFAULT_QC = Object.freeze({
  darkThreshold: 128, // luminance below this counts as "ink"
  minInk: 0.005, // < 0.5% ink -> near-blank (failed conversion)
  maxInk: 0.6, // > 60% ink -> near-solid / too dark

  // Solid-fill tripwire. Thresholds calibrated on order 1523 (16 rasters: the 8 the operator
  // shipped and the 8 this tool generated for the same photos). Worst shipped page scored
  // 0.122% solid / 0.025% blob; the two pages with filled hair and trousers scored 0.242% /
  // 0.111% and 3.946% / 2.399%. Both limits sit near the geometric midpoint of that gap.
  // Two positives is a thin basis — re-tune from the review grid's verdicts in state.json.
  solidRatio: 0.95, // a block counts as solid when >= 95% of its pixels are ink
  blocksAcrossShortSide: 128, // block edge = shortSide/128, so the measure is scale-invariant
  maxSolidBlob: 0.0005, // largest *connected* solid area, as a fraction of the page
  maxSolidFill: 0.01, // total solid area — backstop for fill scattered too thin to connect
});
```

**This comment is the single most valuable block in the file and must survive any rewrite verbatim.**
It records:

- **The calibration set:** order 1523, 16 rasters — the 8 pages the operator actually shipped
  (known-good) and the 8 this tool generated for the same photos (2 of which were bad).
- **The measured numbers:** worst *good* page = 0.122% solid / 0.025% blob. The two *bad* pages
  (filled hair, filled trousers) = 0.242% / 0.111% and 3.946% / 2.399%.
- **The chosen limits and their derivation:** `maxSolidFill: 0.01` (1%) and `maxSolidBlob: 0.0005`
  (0.05%) — *"Both limits sit near the geometric midpoint of that gap."*
- **The honest confidence statement:** *"Two positives is a thin basis — re-tune from the review
  grid's verdicts in state.json."*

Do the arithmetic on the margin, because it matters for anyone touching these:

| measure | worst GOOD page | limit | nearest BAD page | margin to good | margin to bad |
|---|---|---|---|---|---|
| solidFill | 0.122% | **1.0%** | 0.242% | ~8× | ~4× *below* the limit |
| solidBlob | 0.025% | **0.05%** | 0.111% | **2×** | ~2× |

The blob limit — the sharper signal — has only **~2× margin on each side**. There is one good page at
0.025% and one bad page at 0.111%, and the threshold sits between them at 0.05%. That is a two-sample
calibration. Any change to the generator, the vectorizer, or the raster resolution can invalidate it.
The comment says so; the rebuild must keep saying so.

#### `assessColoringPixels` — the degenerate-output tripwire

```js
// src/qc.js:20-35
/** Assess a coloring raster from its grayscale pixels (0-255 luminance).
 *  @param {ArrayLike<number>} grayPixels
 *  @returns {{ verdict: 'ok'|'flagged', reason: string, coverage?: number }} */
export function assessColoringPixels(grayPixels, opts = {}) {
  const { darkThreshold, minInk, maxInk } = { ...DEFAULT_QC, ...opts };
  const total = grayPixels.length;
  if (total === 0) return { verdict: 'flagged', reason: 'empty-image' };
  let ink = 0;
  for (let i = 0; i < total; i++) {
    if (grayPixels[i] < darkThreshold) ink++;
  }
  const coverage = ink / total;
  if (coverage < minInk) return { verdict: 'flagged', reason: 'near-blank', coverage };
  if (coverage > maxInk) return { verdict: 'flagged', reason: 'near-solid', coverage };
  return { verdict: 'ok', reason: 'ok', coverage };
}
```

Three reasons: `empty-image`, `near-blank` (<0.5% ink — a failed conversion produced a white page),
`near-solid` (>60% ink — the page came back black). Simple, cheap, and catches the catastrophic
failures. `coverage` is returned even on `ok` so the caller can carry the number forward.

#### `measureSolidFill` — the block-grid + flood-fill tripwire

The doc comment explains a bug that ink coverage **structurally cannot see**:

```js
// src/qc.js:37-51
/** Measure ink that forms *areas* rather than lines.
 *
 *  Ink coverage cannot see this: a page whose hair and trousers are filled solid black still
 *  covers only ~14% of the paper, nowhere near `maxInk`. So it passes the tripwire and prints,
 *  and the customer colours nothing on the parts that matter most.
 *
 *  The raster is split into blocks about 1/128 of its short side. A block is "solid" when nearly
 *  all of it is ink. Dense hatching — which the operator draws and ships — keeps white paper
 *  between its lines and so rarely fills a block; a filled hair mass fills many adjacent ones.
 *  Hence two numbers: the total solid area, and the largest *connected* solid area. The second is
 *  the sharper signal, because the defect is contiguous by nature and stray solid blocks (a pupil,
 *  a bold contour, a sunglasses lens) are isolated and small.
 *
 *  @param {ArrayLike<number>} grayPixels  row-major luminance, length width*height
 *  @returns {{ solidFill: number, solidBlob: number, blockPx: number, blocks: number }} fractions of the page */
```

**The bug:** a coloring page with the child's hair and trousers filled solid black covers only ~14%
of the paper. `maxInk` is 60%. So it sails through `assessColoringPixels`, prints, and the customer
gets a page where the parts that matter most cannot be coloured. Coverage is the wrong measure
entirely — the defect is about *shape*, not *quantity*.

**The insight:** measure ink that forms **areas** rather than **lines**. Split the raster into blocks;
a block is "solid" when nearly all of it is ink. Dense hatching — which the operator draws by hand
and ships happily — keeps white paper between its strokes and so rarely fills a whole block. A filled
hair mass fills many *adjacent* blocks.

**Why two numbers:** `solidFill` (total solid area) and `solidBlob` (largest *connected* solid area).
The blob is the sharper signal *"because the defect is contiguous by nature and stray solid blocks (a
pupil, a bold contour, a sunglasses lens) are isolated and small."* The named false positives — pupil,
bold contour, sunglasses lens — are exactly the small isolated solid blocks that a total-area measure
would punish and a connectivity measure ignores. `solidFill` remains as the backstop for *"fill
scattered too thin to connect"*.

```js
// src/qc.js:52-108
export function measureSolidFill(grayPixels, width, height, opts = {}) {
  const { darkThreshold, solidRatio, blocksAcrossShortSide } = { ...DEFAULT_QC, ...opts };
  if (!(width > 0) || !(height > 0) || grayPixels.length < width * height) {
    return { solidFill: 0, solidBlob: 0, blockPx: 0, blocks: 0 };
  }

  const blockPx = Math.max(4, Math.round(Math.min(width, height) / blocksAcrossShortSide));
  const cols = Math.ceil(width / blockPx);
  const rows = Math.ceil(height / blockPx);
  const solid = new Uint8Array(cols * rows);
  let solidCount = 0;

  for (let by = 0; by < rows; by++) {
    const y1 = Math.min((by + 1) * blockPx, height);
    for (let bx = 0; bx < cols; bx++) {
      const x1 = Math.min((bx + 1) * blockPx, width);
      let ink = 0;
      let n = 0;
      for (let y = by * blockPx; y < y1; y++) {
        const row = y * width;
        for (let x = bx * blockPx; x < x1; x++, n++) {
          if (grayPixels[row + x] < darkThreshold) ink++;
        }
      }
      if (n > 0 && ink / n >= solidRatio) {
        solid[by * cols + bx] = 1;
        solidCount++;
      }
    }
  }

  // Largest connected run of solid blocks (4-neighbour flood fill, explicit stack).
  const seen = new Uint8Array(cols * rows);
  const stack = new Int32Array(cols * rows);
  let largest = 0;
  for (let start = 0; start < solid.length; start++) {
    if (!solid[start] || seen[start]) continue;
    let top = 0;
    let size = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top > 0) {
      const p = stack[--top];
      size++;
      const x = p % cols;
      const y = (p - x) / cols;
      if (x > 0 && solid[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[top++] = p - 1; }
      if (x < cols - 1 && solid[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[top++] = p + 1; }
      if (y > 0 && solid[p - cols] && !seen[p - cols]) { seen[p - cols] = 1; stack[top++] = p - cols; }
      if (y < rows - 1 && solid[p + cols] && !seen[p + cols]) { seen[p + cols] = 1; stack[top++] = p + cols; }
    }
    if (size > largest) largest = size;
  }

  const blocks = cols * rows;
  return { solidFill: solidCount / blocks, solidBlob: largest / blocks, blockPx, blocks };
}
```

Implementation decisions worth preserving:

- **Scale invariance:** `blockPx = shortSide / 128`. The block size scales with the image, so the
  measure means the same thing at any raster resolution. `Math.max(4, …)` floors it so a tiny image
  doesn't degenerate to 1-pixel blocks.
- **`Math.ceil` for cols/rows + `Math.min(..., width/height)` clamps:** the edge blocks are partial,
  and `n` counts only the pixels actually in the block, so a partial edge block is judged on its own
  real area rather than being diluted by out-of-bounds pixels.
- **Explicit stack, not recursion:** `new Int32Array(cols * rows)` with a manual `top` pointer. A
  recursive flood fill over a large solid region would blow the JS stack. Pre-allocated typed arrays,
  no allocation in the hot loop.
- **4-neighbour connectivity** (not 8): stricter, so diagonal touching doesn't merge two separate
  blobs into one false positive.
- **Degenerate input returns zeros, not a throw:** a buffer shorter than `width*height` yields
  `{ solidFill: 0, solidBlob: 0, … }` — an "ok" answer. Corruption is never fatal (§5.9); the
  degenerate-output check in `qcFiles.js` runs first anyway and would already have flagged it.

#### `assessSolidFill` — the verdict

```js
// src/qc.js:110-117
/** Flag a coloring raster whose ink forms filled regions instead of colourable outlines.
 *  @returns {{ verdict: 'ok'|'flagged', reason: string, solidFill: number, solidBlob: number }} */
export function assessSolidFill(grayPixels, width, height, opts = {}) {
  const { maxSolidBlob, maxSolidFill } = { ...DEFAULT_QC, ...opts };
  const { solidFill, solidBlob } = measureSolidFill(grayPixels, width, height, opts);
  const verdict = solidBlob > maxSolidBlob || solidFill > maxSolidFill ? 'flagged' : 'ok';
  return { verdict, reason: verdict === 'ok' ? 'ok' : 'solid-fill', solidFill, solidBlob };
}
```

Either limit trips it (OR, not AND). Both raw numbers are returned regardless of the verdict, so the
review grid can show *why* and a future re-calibration can mine `state.json` for the distribution.

#### `assessColoringSvg` — the vector check

```js
// src/qc.js:119-127
/** A coloring SVG must be non-empty and contain actual drawing elements. */
export function assessColoringSvg(svg) {
  if (typeof svg !== 'string' || svg.trim() === '') {
    return { verdict: 'flagged', reason: 'empty-svg' };
  }
  const hasDrawing = /<(path|polyline|polygon|line|circle|ellipse|rect)\b/i.test(svg);
  if (!hasDrawing) return { verdict: 'flagged', reason: 'no-paths' };
  return { verdict: 'ok', reason: 'ok' };
}
```

Deliberately not an XML parse — a regex for any of the seven SVG drawing primitives. The SVG is what
prints; a vectorize step that returned a well-formed but empty document would otherwise print a blank
page. `\b` on the tag name prevents `<pathological>` style false matches.

#### `assessOutputFiles` — the adapter, and its ordering rule

```js
// src/qcFiles.js:11-38
/** @param {{coloringPng?: string, coloringSvg: string}} out  paths from organize.outputPaths */
export async function assessOutputFiles(out, opts = {}) {
  if (!existsSync(out.coloringSvg)) return { verdict: 'flagged', reason: 'missing-svg' };
  const svg = assessColoringSvg(readFileSync(out.coloringSvg, 'utf8'));
  if (svg.verdict !== 'ok') return svg;

  if (!out.coloringPng || !existsSync(out.coloringPng)) return { verdict: 'flagged', reason: 'missing-png' };
  let gray, width, height;
  try {
    // flatten() first: a transparent pixel is white paper, not ink.
    const decoded = await sharp(out.coloringPng)
      .flatten({ background: '#ffffff' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    gray = decoded.data;
    ({ width, height } = decoded.info);
  } catch {
    return { verdict: 'flagged', reason: 'unreadable-image' };
  }

  // Degenerate output first — a blank or black page makes the solid-fill measure meaningless.
  const ink = assessColoringPixels(gray, opts);
  if (ink.verdict !== 'ok') return ink;

  const fill = assessSolidFill(gray, width, height, opts);
  return { ...fill, coverage: ink.coverage };
}
```

Two bugs fixed in this adapter:

1. **`flatten({ background: '#ffffff' })` before greyscale.** *"a transparent pixel is white paper,
   not ink."* Without it, an alpha channel decodes transparent regions to 0 (black), and a coloring
   page with a transparent background would read as ~100% ink → `near-solid` → every page flagged.
2. **Ordering: degenerate check before solid-fill.** *"a blank or black page makes the solid-fill
   measure meaningless."* On an all-black page every block is solid, `solidBlob` = 1.0, and the
   reported reason would be `solid-fill` — technically true but useless. The operator needs to hear
   `near-solid`. Cheap checks first, and the more specific diagnosis wins.

The full failure vocabulary from this seam: `missing-svg`, `empty-svg`, `no-paths`, `missing-png`,
`unreadable-image`, `empty-image`, `near-blank`, `near-solid`, `solid-fill`, `ok`.

---

### 5.3 Input QC / the intake gate — `src/inputQc.js` / `src/inputQcFiles.js` / `src/intake.js`

Output QC catches a bad page *after* the GPU has been paid for. Input QC catches a bad *photo*
before any GPU spend at all — and, more importantly, catches the case where the customer simply
hasn't sent everything, which no amount of generation can fix.

#### The stance, and the asymmetric cost that sets every threshold

```js
// src/inputQc.js:1-10
// Pure input-QC heuristics: they judge the customer's *photos*, before any generation, from
// already-decoded pixels and dimensions — so they are testable without an image library, exactly
// like qc.js. A thin sharp adapter (inputQcFiles.js) decodes each photo and feeds these.
//
// The stance is qcFiles.js's: a tripwire for photos that are wrong on their face — too small to
// print, too blurry to use, too dark to see, a duplicate of another, or a file that will not open
// — not a judge of whether a photo makes a good coloring page. That judgement stays with the
// operator's review grid. Defaults are deliberately loose: a marginal photo let through costs one
// review; a good order held on a false alarm costs trust. Calibrate the numbers on the real
// archive before tightening them — the same way qc.js's solid-fill limits were tuned on order 1523.
```

**The asymmetry is the whole calibration philosophy:** *"a marginal photo let through costs one
review; a good order held on a false alarm costs trust."* A false negative costs the operator 30
seconds. A false positive emails a paying customer to tell them their photo is bad when it isn't.
The thresholds are therefore deliberately loose, and the honest admission that they are uncalibrated
is written into the code.

#### `DEFAULT_INTAKE`

```js
// src/inputQc.js:12-32
export const DEFAULT_INTAKE = Object.freeze({
  // resolution
  hardMinMegapixels: 0.15, // below this a photo cannot print at A4 — a hold
  minMegapixels: 0.5, // below this it is small enough to mention — a warn
  minShortSidePx: 600, // a long thin strip can clear the MP bar yet still be unprintable

  // blur — variance of the Laplacian on the normalised grey. Sharp photos run into the hundreds
  // and up, a soft phone photo into the tens. CALIBRATE before trusting this number.
  blurVarianceMin: 60,

  // exposure — mean luminance (0-255) and the fraction of pixels crushed to black / blown to white
  darkMeanMax: 40,
  brightMeanMin: 225,
  clipFractionMax: 0.35,

  // duplicates — Hamming distance between 64-bit dHashes; <= this reads as "the same shot".
  // Never a hold on its own: a burst of the same child is genuinely similar but not a duplicate,
  // so the operator confirms. An exact byte-for-byte repeat is caught upstream (file hash) and is
  // the one that holds, because it means a distinct photo is actually missing.
  dupHammingMax: 5,
});
```

The exact thresholds, and what each is *for*:

| key | value | verdict it drives | why this number |
|---|---|---|---|
| `hardMinMegapixels` | 0.15 | **hold** | below this a photo cannot print at A4 at all |
| `minMegapixels` | 0.5 | warn | small enough to mention, not to block |
| `minShortSidePx` | 600 | **hold** | *"a long thin strip can clear the MP bar yet still be unprintable"* |
| `blurVarianceMin` | 60 | warn | *"CALIBRATE before trusting this number."* |
| `darkMeanMax` | 40 | warn | mean luminance 0-255 |
| `brightMeanMin` | 225 | warn | mean luminance 0-255 |
| `clipFractionMax` | 0.35 | warn | fraction crushed to black or blown to white |
| `dupHammingMax` | 5 | warn (never hold) | bits differing out of 64 |

Three of these carry a documented rationale that is easy to lose in a rewrite:

- **`minShortSidePx` exists because megapixels alone lie.** A 3000×200 strip is 0.6 MP — it clears
  `hardMinMegapixels` and `minMegapixels` — and is completely unprintable. Two independent
  resolution gates, not one.
- **`blurVarianceMin: 60` is explicitly flagged as uncalibrated**, in shouting caps. The scale is
  documented (*"Sharp photos run into the hundreds and up, a soft phone photo into the tens"*) so a
  successor knows which direction is which, but the number itself is a guess and says so.
- **`dupHammingMax` is never a hold on its own.** *"a burst of the same child is genuinely similar
  but not a duplicate, so the operator confirms."* The distinction between near-duplicate (warn) and
  exact-byte duplicate (hold) is the crux — see the rollup below.

#### `assessResolution`

```js
// src/inputQc.js:34-46
/** Verdict from a photo's true pixel dimensions. Zero/absent dimensions mean the decoder gave us
 *  nothing — treated as unreadable, which the adapter also reaches when sharp throws. */
export function assessResolution(width, height, opts = {}) {
  const { hardMinMegapixels, minMegapixels, minShortSidePx } = { ...DEFAULT_INTAKE, ...opts };
  if (!(width > 0) || !(height > 0)) return { verdict: 'hold', reason: 'unreadable', mp: 0, shortSide: 0 };
  const mp = (width * height) / 1e6;
  const shortSide = Math.min(width, height);
  if (mp < hardMinMegapixels || shortSide < minShortSidePx) {
    return { verdict: 'hold', reason: 'low-resolution', mp, shortSide };
  }
  if (mp < minMegapixels) return { verdict: 'warn', reason: 'smallish', mp, shortSide };
  return { verdict: 'ok', reason: 'ok', mp, shortSide };
}
```

Resolution is the **only** per-photo check that can produce a `hold`. Blur and exposure are warns —
*"A dark or blown photo still often generates acceptably"*. Resolution is different because it is a
hard physical fact: you cannot print what isn't there.

Note the `!(width > 0)` idiom rather than `width <= 0` — it also catches `NaN` and `undefined`, which
is exactly the "decoder gave us nothing" case.

#### `laplacianVariance` — the blur detector

```js
// src/inputQc.js:48-70
/** Variance of the Laplacian — the standard cheap focus measure. A flat or blurred image has
 *  little high-frequency energy, so its Laplacian is near-zero everywhere and the variance is low;
 *  a crisp one has strong edges and a high variance. Interior pixels only (the border has no
 *  4-neighbourhood). Returns 0 for a buffer too small or too short to measure. */
export function laplacianVariance(gray, width, height) {
  if (!(width > 2) || !(height > 2) || gray.length < width * height) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}
```

The standard cheap focus measure. The kernel is the 4-neighbour discrete Laplacian
(`4*center - up - down - left - right`), applied inline rather than via a convolution library — no
dependency, one pass, no intermediate buffer. Variance is computed by the streaming
`E[x²] - E[x]²` identity in the same pass, so the whole thing is O(n) with two accumulators.

**Interior pixels only** (`y` from 1 to `height-2`): the border has no 4-neighbourhood, so including
it would either need edge-clamping (biasing the result) or index out of bounds.

`width > 2` / `height > 2` guard: below 3×3 there are no interior pixels at all, and `n === 0` would
divide by zero. Returns 0 — which reads as maximally blurry and produces a warn, never a hold, so a
degenerate buffer costs at most one glance.

```js
// src/inputQc.js:72-77
export function assessBlur(gray, width, height, opts = {}) {
  const { blurVarianceMin } = { ...DEFAULT_INTAKE, ...opts };
  const variance = laplacianVariance(gray, width, height);
  const verdict = variance < blurVarianceMin ? 'warn' : 'ok';
  return { verdict, reason: verdict === 'ok' ? 'ok' : 'blurry', variance };
}
```

The measured `variance` is returned regardless of verdict — the review grid says *"blurry (var 42)"*
without re-measuring, and a future calibration can mine the distribution from `state.json`.

#### `assessExposure`

```js
// src/inputQc.js:79-98
/** Mean luminance and clipping. A dark or blown photo still often generates acceptably, so these
 *  are warns the operator weighs, not holds. */
export function assessExposure(gray, opts = {}) {
  const { darkMeanMax, brightMeanMin, clipFractionMax } = { ...DEFAULT_INTAKE, ...opts };
  const total = gray.length;
  if (total === 0) return { verdict: 'warn', reason: 'empty', mean: 0, clip: 0 };
  let sum = 0;
  let clipped = 0;
  for (let i = 0; i < total; i++) {
    const v = gray[i];
    sum += v;
    if (v <= 4 || v >= 251) clipped++;
  }
  const mean = sum / total;
  const clip = clipped / total;
  if (mean < darkMeanMax) return { verdict: 'warn', reason: 'dark', mean, clip };
  if (mean > brightMeanMin) return { verdict: 'warn', reason: 'overexposed', mean, clip };
  if (clip > clipFractionMax) return { verdict: 'warn', reason: 'clipped', mean, clip };
  return { verdict: 'ok', reason: 'ok', mean, clip };
}
```

The clipping window is `v <= 4 || v >= 251` — a small tolerance either side of pure black/white
rather than exact 0/255, because JPEG quantisation rarely produces exact extremes. One pass computes
both mean and clip fraction.

#### `dHash` — the perceptual hash

```js
// src/inputQc.js:100-122
/** Difference hash: a 9x8 grey grid, one bit per adjacent-column comparison, 64 bits in an 8-row
 *  by 8-comparison layout. Sampled by nearest neighbour so it needs no separate resize step and
 *  stays pure. Two photos of the same moment produce hashes a few bits apart; unrelated photos are
 *  far apart. Returns an all-zero hash for an unusable buffer (which then matches nothing but
 *  another empty). */
export function dHash(gray, width, height) {
  const COLS = 9;
  const ROWS = 8;
  const bits = new Uint8Array(64);
  if (!(width > 0) || !(height > 0) || gray.length < width * height) return bits;
  const sample = (gx, gy) => {
    const sx = Math.min(width - 1, Math.floor(((gx + 0.5) / COLS) * width));
    const sy = Math.min(height - 1, Math.floor(((gy + 0.5) / ROWS) * height));
    return gray[sy * width + sx];
  };
  let b = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS - 1; c++) {
      bits[b++] = sample(c, r) < sample(c + 1, r) ? 1 : 0;
    }
  }
  return bits;
}
```

The classic difference-hash: sample a 9×8 grid, compare each cell to its right neighbour, one bit per
comparison → 8 rows × 8 comparisons = **64 bits**.

Design decisions that matter:

- **Nearest-neighbour sampling instead of a resize step** — *"so it needs no separate resize step and
  stays pure."* A proper box-filter downscale would need sharp, which would drag the image library
  into the pure module and break the pure/adapter split.
- **The `+ 0.5` cell centring** in `sample()` — samples the centre of each grid cell, not its corner,
  so the grid is symmetric across the image.
- **Comparison-based, so it is illumination-invariant**: brightening the whole photo doesn't change
  which of two adjacent cells is darker. This is why dHash catches "same shot, re-exported" where a
  byte hash cannot.
- **All-zero hash for an unusable buffer**, which *"then matches nothing but another empty"* — two
  empty hashes are Hamming distance 0 from each other and 32-ish from anything real. Corruption
  degrades to a harmless answer.

```js
// src/inputQc.js:124-141
/** Bits that differ between two 64-bit dHashes. */
export function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < 64; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** Index pairs [i, j] whose hashes are within dupHammingMax — the near-duplicate candidates. */
export function nearDuplicatePairs(hashes, opts = {}) {
  const { dupHammingMax } = { ...DEFAULT_INTAKE, ...opts };
  const pairs = [];
  for (let i = 0; i < hashes.length; i++) {
    for (let j = i + 1; j < hashes.length; j++) {
      if (hamming(hashes[i], hashes[j]) <= dupHammingMax) pairs.push([i, j]);
    }
  }
  return pairs;
}
```

`nearDuplicatePairs` is an O(n²) all-pairs scan. That is the correct call here and needs no
optimisation: n is the photo count of one order — typically 4 to 8, at most a couple of dozen. A BK-tree
or LSH index would be more code than the thing it replaces. The hash is stored as a `Uint8Array` of
64 single bits rather than a packed BigInt, which makes `hamming` a plain loop instead of a popcount —
again, correct at this n, and it keeps the module readable.

#### `assessCount` — and why an unknown expectation is never a hold

```js
// src/inputQc.js:143-151
/** Count of distinct photos against what the product includes. Unknown expected is not a failure —
 *  the count simply goes unjudged (info), never a hold on a guess. `unique` is the upload count
 *  minus exact-duplicate extras, computed by the caller. */
export function assessCount({ expected, unique }) {
  if (expected == null) return { verdict: 'info', reason: 'expected-unknown', expected: null, unique };
  if (unique < expected) return { verdict: 'hold', reason: 'missing-photos', expected, unique };
  if (unique > expected) return { verdict: 'warn', reason: 'extra-photos', expected, unique };
  return { verdict: 'ok', reason: 'ok', expected, unique };
}
```

**This is the single most important rule in the intake gate.** `expected == null` returns `'info'`,
which ranks as "proceed". *"never a hold on a guess."*

The reason is architectural: `expectedPhotos` comes from the shop's own record via a *newer*
extension (see `orderInfo.js:36-40` — *"An older download has neither, and that is not an error"*).
Older order downloads simply don't have it. If unknown-expected held the order, every legacy order
would jam the board waiting for an operator to unblock a check that never had any data to run on.

The three real verdicts:
- `unique < expected` → **hold** `missing-photos`. This is the one thing generation cannot fix: a
  photo that was never uploaded cannot be drawn. The customer must act.
- `unique > expected` → **warn** `extra-photos`. The customer sent more than the product includes;
  the operator decides which to use. Not a block.
- equal → ok.

`unique` is *distinct* photos — the upload count minus exact-duplicate extras. That is what makes
"you sent 4 files but two are the same file, so you're really missing one" work.

#### `worstVerdict` — the rank rollup

```js
// src/inputQc.js:153-158
const RANK = Object.freeze({ ok: 0, info: 0, warn: 1, hold: 2 });

/** The order's gating verdict: the worst any finding reached. info and ok both mean "proceed". */
export function worstVerdict(verdicts) {
  return verdicts.reduce((w, v) => (RANK[v] > RANK[w] ? v : w), 'ok');
}
```

Four verdicts, **three ranks**: `ok` and `info` both rank 0. That is how "we couldn't judge this" and
"this is fine" both mean proceed while remaining distinguishable in the findings list. `warn` = 1 (the
operator should look, the run proceeds), `hold` = 2 (the run stops, the customer is emailed).

The reduce seeds with `'ok'`, so an empty findings list rolls up to `ok`. The whole gate is a
one-line max over a rank table.

#### `assessPhotoFile` — the adapter

```js
// src/inputQcFiles.js:7-14
// Runtime adapter: decode one input photo and feed the pure heuristics in inputQc.js — the input
// mirror of qcFiles.js. The bytes are read once, hashed for exact-duplicate detection, then sharp
// decodes a small normalised grey copy for the blur / exposure / perceptual-hash measures.
// Resolution is judged on the true stored dimensions, not the normalised copy. The photo is
// EXIF-rotated first, exactly as the generator does before upload, so a portrait shot stored
// sideways is not mistaken for a different image than its corrected twin.

const NORM = 512; // short-side target: scale-normalises blur/exposure/hash and bounds cost
```

Four decisions in that header, each fixing a distinct bug:

1. **Bytes read once, hashed, then decoded.** One `readFile`, sha1 from those bytes, sharp decodes
   from the same buffer. Never two reads, and never a path handed to sharp (the libvips file-mapping
   trap again).
2. **Normalised to a 512px short side** before blur/exposure/hash. Laplacian variance is
   scale-dependent — the *same photo* at 12 MP and at 2 MP would score wildly differently — so
   normalising makes `blurVarianceMin` mean one thing. It also bounds the cost of the scan.
3. **Resolution is judged on the TRUE stored dimensions**, not the normalised copy. Obviously: the
   normalised copy is always 512px, so measuring it would make every photo pass.
4. **EXIF rotation first — `.rotate()` — *"exactly as the generator does before upload"*.** This is
   the subtle one. A portrait photo stored sideways with an EXIF orientation flag hashes completely
   differently from its already-corrected twin. Without the rotate, the duplicate detector would miss
   the pair, *and* `assessResolution`'s `shortSide` would be computed on the wrong axis. The comment
   pins the reason it must match the generator: both must see the same pixels.

```js
// src/inputQcFiles.js:16-61
/** Decode and assess one photo file.
 *  @returns {Promise<{ base:string, path:string, readable:boolean, sha1:?string,
 *    width:number, height:number, hash:Uint8Array,
 *    resolution:object, blur:object, exposure:object }>} */
export async function assessPhotoFile(photoPath, opts = {}) {
  const base = photoBase(photoPath);

  let bytes;
  try {
    bytes = await readFile(photoPath);
  } catch {
    return unreadable(base, photoPath, null);
  }
  const sha1 = createHash('sha1').update(bytes).digest('hex');

  try {
    const img = sharp(bytes, { failOn: 'none' }).rotate(); // honour EXIF, like apiDriver's upload
    const meta = await img.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;

    const { data, info } = await img
      .greyscale()
      .resize({ width: NORM, height: NORM, fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });

    return {
      base,
      path: photoPath,
      readable: true,
      sha1,
      width,
      height,
      hash: dHash(data, info.width, info.height),
      resolution: assessResolution(width, height, opts),
      blur: assessBlur(data, info.width, info.height, opts),
      exposure: assessExposure(data, opts),
    };
  } catch {
    // A file that reads as bytes but will not decode (truncated upload, an unsupported format) is
    // as un-generatable as a missing one — hold it, but keep the sha1 so a later re-upload of the
    // same broken bytes is still recognised as the same file.
    return unreadable(base, photoPath, sha1);
  }
}
```

`failOn: 'none'` tells sharp to decode a slightly-corrupt JPEG rather than throw — customers send
imperfect files and a recoverable one should be judged, not rejected.

`withoutEnlargement: true` means a photo already smaller than 512 isn't upscaled (which would fake
sharpness into the Laplacian).

**The catch block's reasoning is worth preserving:** a file that reads as bytes but will not decode
(a truncated upload, an unsupported format) is *"as un-generatable as a missing one — hold it, but
keep the sha1"*. Keeping the sha1 on an undecodable file means a later re-upload of the same broken
bytes is still recognised as the same file by the exact-duplicate check.

```js
// src/inputQcFiles.js:63-76
function unreadable(base, path, sha1) {
  return {
    base,
    path,
    readable: false,
    sha1,
    width: 0,
    height: 0,
    hash: new Uint8Array(64),
    resolution: { verdict: 'hold', reason: 'unreadable', mp: 0, shortSide: 0 },
    blur: { verdict: 'ok', reason: 'ok', variance: 0 },
    exposure: { verdict: 'ok', reason: 'ok', mean: 0, clip: 0 },
  };
}
```

An unreadable photo returns a **complete, well-formed** finding object — `hold` on resolution, `ok`
on blur and exposure. Not a throw, not a partial object. The order-level code never has to special-case
it: one photo's undecodability holds the order via the normal rank rollup, and the blur/exposure
fields are `ok` so they don't pile a meaningless second and third finding onto the same file.

#### `assessIntake` — the order-level rollup

```js
// src/intake.js:5-9
// Order-level input QC: decode every photo, gather the per-photo findings, add the cross-photo ones
// (exact + near duplicates, count vs expected), and roll up one verdict. That verdict gates the
// run — `hold` means the orchestrator skips the order and writes the email draft; `warn`/`info`
// proceed with the findings recorded. Decoding is injected (`assess`) so this order-level logic is
// unit-testable without an image library, the same pure/adapter split as qc.js and qcFiles.js.
```

```js
// src/intake.js:16-20
// The numeric evidence to carry alongside each per-photo finding, so the report and the review grid
// can say "blurry (var 42)" without re-measuring.
const VALUE_KEYS = {
  resolution: (a) => ({ mp: round(a.mp), shortSide: a.shortSide }),
  blur: (a) => ({ variance: round(a.variance) }),
  exposure: (a) => ({ mean: round(a.mean), clip: round(a.clip, 3) }),
};
```

```js
// src/intake.js:22-89
export async function assessIntake({ order, config = {}, expected = null, assess = assessPhotoFile }) {
  const opts = { ...DEFAULT_INTAKE, ...(config.intake ?? {}) };
  const photos = order?.photos ?? [];
  const perPhoto = await Promise.all(photos.map((p) => assess(p, opts)));

  const findings = [];

  // Per-photo: surface every non-ok resolution / blur / exposure verdict.
  for (const ph of perPhoto) {
    for (const check of ['resolution', 'blur', 'exposure']) {
      const a = ph[check];
      if (a && a.verdict !== 'ok') {
        findings.push({ check, base: ph.base, verdict: a.verdict, reason: a.reason, ...(VALUE_KEYS[check]?.(a) ?? {}) });
      }
    }
  }

  // Exact duplicates: identical bytes mean a distinct photo is genuinely missing. Hold.
  const bySha = new Map();
  for (const ph of perPhoto) {
    if (!ph.sha1) continue;
    if (!bySha.has(ph.sha1)) bySha.set(ph.sha1, []);
    bySha.get(ph.sha1).push(ph);
  }
  const exactPairs = new Set();
  let exactDupExtras = 0;
  for (const group of bySha.values()) {
    if (group.length < 2) continue;
    exactDupExtras += group.length - 1;
    findings.push({ check: 'duplicate', verdict: 'hold', reason: 'duplicate-identical', bases: group.map((p) => p.base) });
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) exactPairs.add(pairKey(group[i].base, group[j].base));
    }
  }

  // Near duplicates: the same shot, a different file. A warn the operator confirms — a burst of the
  // same child is legitimately similar. Skip any pair already caught as an exact duplicate.
  const readable = perPhoto.filter((p) => p.readable);
  for (const [i, j] of nearDuplicatePairs(readable.map((p) => p.hash), opts)) {
    const a = readable[i].base;
    const b = readable[j].base;
    if (!exactPairs.has(pairKey(a, b))) {
      findings.push({ check: 'duplicate', verdict: 'warn', reason: 'possible-duplicate', bases: [a, b] });
    }
  }

  // Count vs expected, on distinct photos.
  const uploaded = perPhoto.length;
  const unique = uploaded - exactDupExtras;
  const countAssess = assessCount({ expected, unique });
  if (countAssess.verdict !== 'ok') {
    findings.push({
      check: 'count',
      verdict: countAssess.verdict,
      reason: countAssess.reason,
      expected: countAssess.expected,
      uploaded,
      unique,
      missing: expected != null ? Math.max(0, expected - unique) : null,
    });
  }

  const verdict = worstVerdict(findings.map((f) => f.verdict));
  return { expected, uploaded, unique, verdict, emailCase: pickEmailCase(findings), findings };
}
```

The duplicate logic is the subtle part, and the two-tier design is deliberate:

- **Exact duplicate (identical sha1) → `hold`.** *"identical bytes mean a distinct photo is genuinely
  missing."* This is not really a duplicate finding at all — it is a *count* finding in disguise. The
  customer uploaded the same file twice, which means one of the photos they meant to send isn't
  there. Nothing the tool does can recover it.
- **Near duplicate (dHash within 5) → `warn`.** *"a burst of the same child is legitimately similar."*
  Two frames from a burst are a few bits apart but are genuinely two different photos, and the
  customer may well want both. The operator confirms.
- **`exactPairs` deduplication.** A pair already caught as an exact byte duplicate is skipped in the
  near-duplicate scan — it would be Hamming distance 0 and would otherwise produce a redundant second
  warn about the same two files.
- **`pairKey(a, b) = a < b ? \`${a}|${b}\` : \`${b}|${a}\`** — order-independent, so the exact-pair
  set matches regardless of which order the near-duplicate scan produces the pair in.
- **`exactDupExtras` feeds `unique`**, which feeds `assessCount`. This is how "4 files, 2 identical"
  becomes "3 distinct photos, expected 4, missing 1".
- **Near-duplicate scan runs on `readable` photos only** — an unreadable photo's all-zero hash would
  otherwise pair with every other unreadable photo.

#### `describeFinding` — Czech, never a code

```js
// src/intake.js:92-109
/** Human text for one finding — for the run log, the grid and the held-order summary. Czech, to match
 *  the client-side FINDING map in index.html (the whole operator UI is Czech). */
export function describeFinding(f) {
  switch (f.reason) {
    case 'missing-photos': return `jen ${f.unique} z ${f.expected} fotek — ${f.missing} chybí`;
    case 'extra-photos': return `${f.uploaded} fotek, víc než ${f.expected} v produktu`;
    case 'duplicate-identical': return `stejná fotka je nahraná víckrát (${(f.bases ?? []).join(', ')})`;
    case 'possible-duplicate': return `dvě fotky vypadají jako stejný záběr (${(f.bases ?? []).join(', ')})`;
    case 'unreadable': return `${f.base} nejde otevřít`;
    case 'low-resolution': return `${f.base} je moc malá na tisk (${f.mp} MP)`;
    case 'smallish': return `${f.base} je spíš menší (${f.mp} MP)`;
    case 'blurry': return `${f.base} vypadá rozmazaně`;
    case 'dark': return `${f.base} je hodně tmavá`;
    case 'overexposed': return `${f.base} je hodně světlá`;
    case 'clipped': return `${f.base} má ztracené detaily ve světlech nebo stínech`;
    default: return `${f.base ?? ''} ${f.reason}`.trim();
  }
}
```

Every finding has a plain-Czech sentence with the evidence embedded. The `default` case degrades to
the raw reason rather than throwing on an unknown code.

```js
// src/intake.js:111-117
/** One operator-facing line for a held order. */
export function intakeSummary(result) {
  const count = result.findings.find((f) => f.check === 'count' && f.verdict === 'hold');
  if (count) return `jen ${result.unique} z ${result.expected} fotek — čeká na vás`;
  const holds = result.findings.filter((f) => f.verdict === 'hold');
  return `${[...new Set(holds.map(describeFinding))].join('; ')} — čeká na vás`;
}
```

The missing-photos hold **wins the summary line** if present — it is the one the customer must act on,
so it is the one sentence the operator sees. Otherwise every distinct hold reason is joined (the
`new Set` collapses duplicates, e.g. three unreadable files producing three identical sentences).

---

### 5.4 Generation + the re-roll ladder — `src/batch.js`

#### `describeFailure` — never a stack trace

```js
// src/batch.js:25-30
/** Plain-language failure text for the manifest and the operator's report. Never a stack trace. */
export function describeFailure(err) {
  const seam = err?.seam ?? 'unknown';
  const step = err?.step ? ` (${err.step})` : '';
  return `${seam} seam${step}: ${err?.message ?? String(err)}`;
}
```

The `seam` / `step` convention runs through the whole codebase: every custom error class stamps
`this.seam` (`BuilderError` → `'builder'`, `ReviewError` → `'review'`, generator errors → their seam)
and optionally `this.step` (`'load'`, `'launch'`, `'render'`, `'export'`). `describeFailure` turns
that into one line naming *where* it broke, not a JS stack. This text goes into `state.json` and onto
the operator's screen — the operator is not a developer, and a stack trace is not information to them.

The `?.` chain and the `String(err)` fallback mean it never throws on a non-Error throw.

#### `nextAttemptSettings` — the 8-step-determinism finding

This is the single hardest-won piece of knowledge in the repository.

```js
// src/batch.js:32-51
export const DEFAULT_MAX_STEPS = 12;

/** What to send the generator when re-rolling a photo whose last attempt came back bad.
 *
 *  It must differ from `prev`, or the re-roll returns the same page: at >= 8 steps the generator
 *  is deterministic within a run, and its API takes no seed. The step count is the only knob that
 *  changes the sampler's trajectory while staying above 8, where the negative prompt is evaluated
 *  at all. Returns null once the ceiling is reached — at that point re-rolling cannot help and
 *  saying so is better than burning a GPU minute to reprint the same defect.
 *
 *  @param {object} generator  config.generator
 *  @param {?{steps:number}} prev  the attempt that produced what is on disk now
 *  @returns {?object} settings for driver.generate, or null when exhausted */
export function nextAttemptSettings(generator, prev) {
  const ceiling = generator.maxDiffusionSteps ?? DEFAULT_MAX_STEPS;
  const last = prev?.steps ?? generator.diffusionSteps;
  const steps = last + 1;
  if (steps > ceiling) return null;
  return { ...generator, diffusionSteps: steps };
}
```

The same finding is restated at the state-storage end, with the spike reference:

```js
// src/manifest.js:148-154
/** Remember the generator settings that produced the output now on disk.
 *
 *  A redo has to change at least one of them. At >= 8 diffusion steps this generator is
 *  deterministic within a run: re-sending a byte-identical request returns a byte-identical
 *  page, so a plain re-roll of a bad photo is a no-op that looks like work. The API exposes no
 *  seed, so the step count is the knob we turn. See docs/spikes/2026-07-09-u8-value-gate.md.
 *  Recorded only when generation succeeded — a lost GPU job produced no page to differ from. */
```

**Unpack what this actually says, because a rebuild that misses it ships a broken feature that looks
like it works:**

1. **The generator is deterministic at ≥8 diffusion steps within a run.** Send a byte-identical
   request, get a byte-identical page back.
2. **The API exposes no seed.** The usual escape — re-roll with a different seed — is not available.
3. Therefore **a plain "re-roll this bad photo" button is a no-op that looks like work.** The
   operator clicks redo, the GPU spins for a minute, and the identical defective page comes back.
   This is the bug the whole ladder exists to fix.
4. **The step count is the only knob that changes the sampler's trajectory.**
5. **But it must stay above 8**, *"where the negative prompt is evaluated at all"* — below 8 steps
   the negative prompt isn't applied, so dropping steps to force a difference would silently disable
   the generator's quality guardrail. The ladder therefore only ever climbs: `steps = last + 1`.
6. **`DEFAULT_MAX_STEPS = 12` is the ceiling.** Returns `null` when exhausted, because *"at that
   point re-rolling cannot help and saying so is better than burning a GPU minute to reprint the same
   defect."*

The evidence is filed at `docs/spikes/2026-07-09-u8-value-gate.md`.

The ladder is `prev.steps + 1`, seeded from `generator.diffusionSteps` on the first re-roll — so a
config starting at 8 gives 5 rungs (8 → 9, 10, 11, 12, exhausted).

#### `generatePhoto` — the whole per-photo path

```js
// src/batch.js:53-60
/** One photo through the whole per-photo path: generate -> organize -> QC -> record.
 *  Never throws; a failure becomes a FAILED status. Writes state.json before returning, so an
 *  interrupt costs at most this photo. The review gate's redo calls this too — a redo must be
 *  the same code path as a first attempt, or the two drift. Returns the resulting status.
 *
 *  A photo that is flagged and already carries an attempt is being re-rolled, so it goes back to
 *  the generator with a changed step count rather than the identical request that produced the
 *  page the operator just rejected. */
```

Four rules in one doc comment:

- **Never throws.** A failure becomes a `FAILED` status, not an exception.
- **Writes `state.json` before returning** — *"so an interrupt costs at most this photo."*
- **The redo path is the same code path.** *"a redo must be the same code path as a first attempt,
  or the two drift."* This is why `review.js`'s `redo()` sets the photo to `FLAGGED` and calls
  `generatePhoto` rather than reimplementing generation.
- **Flagged + has an attempt ⇒ re-roll**, with a changed step count.

```js
// src/batch.js:61-76
export async function generatePhoto({ config, photoPath, orderDir, manifest, orderId, driver, qc = assessOutputFiles, onEvent = noop }) {
  const base = photoBase(photoPath);
  const prev = getAttempt(manifest, base);
  const reroll = prev != null && getStatus(manifest, base) === STATES.FLAGGED;

  const settings = reroll ? nextAttemptSettings(config.generator, prev) : { ...config.generator };
  if (settings === null) {
    const reason =
      `re-rolled up to ${prev.steps} diffusion steps, the ceiling — this generator repeats itself, ` +
      `so running it again returns the same page. Approve it, repair it by hand, or change generator.variant.`;
    setStatus(manifest, base, STATES.FLAGGED, reason);
    writeManifest(orderDir, manifest);
    onEvent({ type: 'photo-flagged', orderId, base, reason });
    return getStatus(manifest, base);
  }
```

The `reroll` condition is **two facts, both required**: an attempt is recorded (`prev != null`) AND
the current status is `FLAGGED`. A first run has no attempt; a photo that is `ok` isn't being
re-rolled.

The exhaustion message is a model of operator-facing error text: it says what happened (*"re-rolled
up to 12 diffusion steps, the ceiling"*), why it can't continue (*"this generator repeats itself, so
running it again returns the same page"*), and offers **three concrete next actions**: approve it,
repair it by hand, or change `generator.variant`. It does not just say "failed".

```js
// src/batch.js:77-114
  onEvent({ type: 'photo-start', orderId, base, redo: getStatus(manifest, base) != null, steps: settings.diffusionSteps });
  try {
    const result = await driver.generate(photoPath, {
      ...settings,
      onProgress: ({ step, message }) => onEvent({ type: 'progress', orderId, base, step, message }),
    });
    const out = await writeOutputs(photoPath, orderDir, result);
    // Trim the coloring page down to its ink so a subject the model marooned in white doesn't print
    // with wide white borders (config.builder.autoCrop, default on). Never fail a page the GPU already
    // paid for over a crop hiccup — the uncropped page is still perfectly usable.
    if (config.builder?.autoCrop !== false) {
      try {
        // First whiten any black border keyline (the model draws one on some wide pages) so the crop
        // below removes it from both the PNG and the printed SVG instead of the frame defeating the crop.
        const df = await deframe({ pngPath: out.coloringPng, svgPath: out.coloringSvg });
        if (df.deframed) onEvent({ type: 'deframed', orderId, base });
        const c = await autoCropColoring({ pngPath: out.coloringPng, svgPath: out.coloringSvg });
        if (c.cropped) onEvent({ type: 'auto-cropped', orderId, base, kept: Number(c.kept.toFixed(2)) });
      } catch (err) {
        onEvent({ type: 'auto-crop-skipped', orderId, base, reason: err.message });
      }
    }
    const verdict = await qc(out);
    const next = verdict.verdict === 'ok' ? STATES.OK : STATES.FLAGGED;
    setStatus(manifest, base, next, verdict.reason);
    setSource(manifest, base, photoPath);
    // Only a completed generation records an attempt: a lost GPU job left no page to differ from,
    // so its retry must repeat the settings rather than climb the ladder for nothing.
    setAttempt(manifest, base, { steps: settings.diffusionSteps, variant: settings.variant ?? null });
    onEvent({ type: next === STATES.OK ? 'photo-ok' : 'photo-flagged', orderId, base, reason: verdict.reason });
  } catch (err) {
    setStatus(manifest, base, STATES.FAILED, describeFailure(err));
    onEvent({ type: 'photo-failed', orderId, base, reason: describeFailure(err) });
  } finally {
    writeManifest(orderDir, manifest);
  }
  return getStatus(manifest, base);
}
```

Five decisions here, each fixing something:

1. **The auto-crop block is wrapped in its own try/catch.** *"Never fail a page the GPU already paid
   for over a crop hiccup — the uncropped page is still perfectly usable."* A crop failure emits
   `auto-crop-skipped` and the page continues to QC. The cost asymmetry is explicit: a GPU minute is
   real money; an uncropped page is a cosmetic loss.
2. **`deframe` before `autoCropColoring`**, with the reason restated at the call site: *"so the crop
   below removes it from both the PNG and the printed SVG instead of the frame defeating the crop."*
3. **`config.builder?.autoCrop !== false`** — default-on, opt-out. An unset config gets the crop.
4. **`setAttempt` only inside the success path.** *"a lost GPU job left no page to differ from, so
   its retry must repeat the settings rather than climb the ladder for nothing."* This is the
   critical interaction with `nextAttemptSettings`: if a network drop recorded an attempt, the retry
   would climb a rung for nothing and burn one of the five available re-rolls without ever having
   produced a page.
5. **`writeManifest` in `finally`.** Success, QC flag, or a thrown seam error — the manifest is on
   disk before the function returns. This is what "an interrupt costs at most this photo" means.

Also note `setSource(manifest, base, photoPath)` — recording which input photo produced this output,
so a later redo regenerates from the operator's original rather than the generator's echoed-back copy
(§5.5, `manifest.js:135-137`).

#### `generateOrder` — resume, idempotence, and the one-bad-unit rule

```js
// src/batch.js:116-146
/** Generate every photo of one order that still needs it, writing state.json after each photo
 *  so an interrupted run resumes exactly where it stopped. A single photo's failure is recorded
 *  and the batch moves on — one dead GPU job must not cost the other fifteen photos. */
export async function generateOrder({ config, order, outboxRoot, driver, qc = assessOutputFiles, onEvent = noop, signal }) {
  const generator = driver ?? createGeneratorDriver(config);
  const orderDir = join(outboxRoot, order.orderId);
  mkdirSync(orderDir, { recursive: true });

  const manifest = readManifest(orderDir);
  manifest.orderId ??= order.orderId;
  const { orderId } = order;

  for (const photoPath of order.photos) {
    // Stopping lands here, between photos: a generation already handed to the GPU cannot be
    // pulled back, but the next one need never start. Photos already done keep their verdict;
    // the untouched ones stay pending and the next Go picks them up.
    if (signal?.aborted) break;

    const base = photoBase(photoPath);
    const status = getStatus(manifest, base);

    if (!needsGeneration(status)) {
      onEvent({ type: 'photo-skipped', orderId, base, status });
      continue;
    }

    await generatePhoto({ config, photoPath, orderDir, manifest, orderId, driver: generator, qc, onEvent });
  }

  return { orderId, orderDir, manifest, summary: summarizeOrder(manifest, order.photos.map(photoBase)) };
}
```

**The resume / idempotence rules:**

- **`state.json` is written after every photo** (inside `generatePhoto`'s `finally`), so an
  interrupted run resumes exactly where it stopped.
- **`needsGeneration(status)` is the resume filter** (defined in `manifest.js` — §5.5). Re-running the
  same order is idempotent: finished photos are skipped with a `photo-skipped` event; only
  never-run/flagged/failed photos re-run.
- **Stopping is cooperative and lands between photos.** *"a generation already handed to the GPU
  cannot be pulled back, but the next one need never start."* The signal is checked at the top of the
  loop, never mid-generation. Photos already done keep their verdicts; untouched ones stay pending
  and the next Go picks them up. There is no rollback, no partial state, nothing to clean up.
- **`manifest.orderId ??= order.orderId`** — set once, never overwritten, so a manifest that already
  knows its id keeps it.
- **`summarizeOrder(manifest, order.photos.map(photoBase))`** — the summary is computed against the
  *order's* photo list, not the manifest's keys. Critical; see §5.5.

**The one-bad-unit rule:** *"A single photo's failure is recorded and the batch moves on — one dead
GPU job must not cost the other fifteen photos."* `generatePhoto` never throws, so the loop cannot be
broken by one photo. This rule recurs at every level of the system (§5.9).

#### `runBatch` — sequential by design

```js
// src/batch.js:148-167
/** Ingest the inbox and generate every order. Orders are processed one at a time and
 *  sequentially within an order — the generator is a single shared GPU queue, not something
 *  to hammer. Returns a per-order report. */
export async function runBatch({ config, inboxRoot, outboxRoot, driver, qc, onEvent = noop }) {
  const inbox = inboxRoot ?? config.paths.inbox;
  const outbox = outboxRoot ?? config.paths.outbox;
  const orders = ingestOrders(inbox);
  onEvent({ type: 'batch-start', orders: orders.length, inbox, outbox });

  const results = [];
  for (const order of orders) {
    onEvent({ type: 'order-start', orderId: order.orderId, dirName: order.dirName, photos: order.photos.length });
    const result = await generateOrder({ config, order, outboxRoot: outbox, driver, qc, onEvent });
    onEvent({ type: 'order-done', orderId: order.orderId, summary: result.summary });
    results.push(result);
  }

  onEvent({ type: 'batch-done', orders: results.length });
  return { inbox, outbox, orders: results };
}
```

**Sequential is a decision, not laziness:** *"the generator is a single shared GPU queue, not
something to hammer."* A `Promise.all` over orders would queue them all on the same GPU and gain
nothing but a thundering-herd failure mode. The same reasoning is restated in
`orchestrator.js:174-175`: *"Orders still run one at a time — the generator is one shared GPU queue,
not something to fan out across."*

Note the contrast with `assessIntake`, which *does* use `Promise.all` over photos — decoding is
local CPU work with no shared queue, so parallelism there is free.

---

### 5.5 State machines — the lifecycle

There are **three** state machines in this system, at three levels, and keeping them distinct is the
whole design:

| level | states live in | who owns them | source of truth |
|---|---|---|---|
| **per photo** | `manifest.js` `STATES` | the run + the operator's review grid | `state.json` (stored) |
| **per order, in a run** | `orchestrator.js` `ORDER_STATUS` | one `runPipeline` pass | the run report (transient) |
| **per order, on the board** | `studio.js` `ORDER_BOARD_STATES` | nobody — **derived** | computed on read |

The board state is **never stored**. That is the key decision, and §5.5.3 explains why.

---

#### 5.5.1 `src/manifest.js` — the per-photo state machine

```js
// src/manifest.js:4-13
/** Per-photo status vocabulary. state.json is the single source of truth for
 *  run/review state and drives resumability + the builder gate. */
export const STATES = Object.freeze({
  OK: 'ok',
  FLAGGED: 'flagged',
  PENDING_REVIEW: 'pending_review',
  MANUAL_IN_PROGRESS: 'manual_in_progress',
  APPROVED: 'approved',
  FAILED: 'failed',
});
```

**Every state, what it means, and what puts a photo there:**

| state | meaning | entered by |
|---|---|---|
| *(null)* | never generated | initial — no manifest entry exists |
| `ok` | generated and passed QC automatically | `generatePhoto` when `qc().verdict === 'ok'` |
| `flagged` | QC tripwire or the operator doubted it | `generatePhoto` on a QC flag; `reject()`; `handoff()` (pass-through); `redo()` (pass-through); ladder exhaustion |
| `manual_in_progress` | handed out for hand repair, awaiting a replacement file | `handoff()` |
| `pending_review` | a replacement/edit landed, re-QC'd, waiting for the operator's eye | `acceptReplacement()`, `applyPhotoEdit()`, `revertPhotoEdit()` |
| `approved` | the operator said it's good — the only way a flagged photo reaches the PDF | `approve()` |
| `failed` | generation never completed (usually a lost GPU job) | `generatePhoto`'s catch |

**The three predicates** are the entire public contract of the state machine — nothing outside
`manifest.js` compares statuses by string:

```js
// src/manifest.js:17-35
/** Builder-eligible only when clean or explicitly operator-approved. */
export function isBuilderEligible(status) {
  return status === STATES.OK || status === STATES.APPROVED;
}

/** Holds at the review gate until the operator acts. */
export function holdsForReview(status) {
  return status === STATES.FLAGGED || status === STATES.PENDING_REVIEW;
}

/** Should the batch (re-)generate this photo?
 *  Yes for never-run, auto-flagged (which re-rolls with a changed step count — see
 *  `nextAttemptSettings`; an identical re-run would return the identical page), and failed
 *  (usually a lost GPU job, worth another attempt on the next run).
 *  No for finished photos, and no for the two states the *operator* owns —
 *  regenerating those would overwrite a manual repair that is waiting to be reviewed. */
export function needsGeneration(status) {
  return status == null || status === STATES.FLAGGED || status === STATES.FAILED;
}
```

`needsGeneration`'s comment names the bug it prevents: `manual_in_progress` and `pending_review` are
**operator-owned states**, and regenerating them *"would overwrite a manual repair that is waiting to
be reviewed"* — destroying work the operator did by hand in Figma.

`isBuilderEligible` is the review gate in one line: **`ok` or `approved`, nothing else.** A flagged
photo is never auto-approved.

#### `summarizeOrder` and the incomplete-book bug

```js
// src/manifest.js:37-55
/** Per-order tally used by the review gate and the run report. An order reaches the builder
 *  only once every one of its photos is builder-eligible.
 *
 *  Pass the order's photo bases: a run killed before its last photo was recorded leaves no
 *  manifest entry for it, and counting only what the manifest knows would call that order
 *  ready and print an incomplete book. An unrecorded photo counts as pending. */
export function summarizeOrder(manifest, bases = Object.keys(manifest.photos ?? {})) {
  const statuses = bases.map((b) => getStatus(manifest, b));
  const count = (fn) => statuses.filter(fn).length;
  return {
    total: bases.length,
    eligible: count(isBuilderEligible),
    held: count(holdsForReview),
    manual: count((s) => s === STATES.MANUAL_IN_PROGRESS),
    failed: count((s) => s === STATES.FAILED),
    pending: count((s) => s == null),
    ready: bases.length > 0 && count(isBuilderEligible) === bases.length,
  };
}
```

**The bug this comment records is a real one and a subtle one.** If you summarize over
`Object.keys(manifest.photos)` — what the manifest *knows about* — then a run killed before its last
photo was recorded produces a manifest with 7 of 8 photos, all `ok`, and the summary says
`ready: true`. **The tool would then print a 7-page book for an 8-page order.**

The fix: pass the order's *actual* photo bases from the inbox. A photo with no manifest entry has
status `null`, counts as `pending`, and `ready` is false. The default parameter exists only for
callers that genuinely have nothing else to go on.

`ready` also requires `bases.length > 0` — an empty order is not "ready", it's empty.

#### `TRANSITIONS` — the legal edges

```js
// src/manifest.js:57-66
// Legal transitions. from -> allowed to-states.
const TRANSITIONS = {
  [STATES.OK]: [STATES.FLAGGED, STATES.APPROVED, STATES.FAILED],
  [STATES.FLAGGED]: [STATES.APPROVED, STATES.MANUAL_IN_PROGRESS, STATES.OK, STATES.FAILED],
  // FLAGGED: the operator abandoned the handoff and wants the generator to try again instead.
  [STATES.MANUAL_IN_PROGRESS]: [STATES.PENDING_REVIEW, STATES.FLAGGED, STATES.FAILED],
  [STATES.PENDING_REVIEW]: [STATES.APPROVED, STATES.FLAGGED, STATES.MANUAL_IN_PROGRESS, STATES.FAILED],
  [STATES.APPROVED]: [STATES.FLAGGED],
  [STATES.FAILED]: [STATES.OK, STATES.FLAGGED],
};
```

**Every edge and what triggers it:**

- `ok → flagged` — the operator rejects a clean-looking page (`reject`), or asks for a redo (`redo`
  sets flagged first), or hands it off (`handoff` passes through flagged).
- `ok → approved` — the operator explicitly approves an already-clean page.
- `ok → failed` — a redo of a clean page whose generation then died.
- `flagged → approved` — **the money edge.** `approve()`. The only way a flagged photo reaches the PDF.
- `flagged → manual_in_progress` — `handoff()`.
- `flagged → ok` — a re-roll came back clean and QC passed. Auto-advance, no operator action.
- `flagged → failed` — the re-roll's generation died.
- `manual_in_progress → pending_review` — `acceptReplacement()`: the repaired file landed and re-QC'd.
- `manual_in_progress → flagged` — annotated in the source: *"the operator abandoned the handoff and
  wants the generator to try again instead."* Without this edge, a handoff would be a one-way door.
- `manual_in_progress → failed` — a redo from a handoff whose generation died.
- `pending_review → approved` — the operator blesses the repair.
- `pending_review → flagged` — the repair isn't good either; back to the queue / redo.
- `pending_review → manual_in_progress` — send it out for another round of hand repair.
- `pending_review → failed` — generation died.
- `approved → flagged` — **the only edge out of `approved`.** An approval can be revoked (the
  operator changed their mind, or a redo). It can never jump straight to `ok`, `pending_review`, or
  `manual_in_progress` — everything routes back through `flagged`, which is what makes "flagged is
  the doorway to every operator action" true.
- `failed → ok` — the retry succeeded and QC passed.
- `failed → flagged` — the retry produced a page QC didn't like.

Note the **shape** of the graph: `flagged` is the hub. Every operator action either starts from
flagged or passes through it (`handoff` and `redo` both force flagged first). That is deliberate —
it means "the operator touched this" is always recorded, even on a photo that looked clean.

#### `canTransition` — and why idempotence is not a transition

```js
// src/manifest.js:68-75
/** null `from` means initial assignment (always allowed). Re-recording the status a photo
 *  already has is idempotent, not a transition — a redo that comes back just as bad stays
 *  flagged, and a resumed run must be able to re-write what it already wrote. */
export function canTransition(from, to) {
  if (!ALL.has(to)) return false;
  if (from == null || from === to) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}
```

Two escape hatches, both load-bearing:

- **`from == null`** — initial assignment is always legal. A new photo can land in any state.
- **`from === to`** — self-transition is idempotent, not a transition. **This is required for
  correctness**, and the comment gives both reasons: (1) *"a redo that comes back just as bad stays
  flagged"* — `flagged → flagged` is the normal outcome of an unsuccessful re-roll, and it must not
  throw; (2) *"a resumed run must be able to re-write what it already wrote."*

Without the `from === to` clause, `TRANSITIONS[FLAGGED]` would need `FLAGGED` in its own list, which
would muddle "what can change" with "what can repeat".

`if (!ALL.has(to)) return false` guards the target; `setStatus` separately throws `ManifestError` on
an unknown status so a typo is caught at the write, not silently ignored.

```js
// src/manifest.js:122-133
/** Set a photo's status, enforcing the transition guard. Merges, so fields that outlive a
 *  status change (`source`) survive it. Returns the manifest. */
export function setStatus(manifest, base, status, reason = null) {
  if (!ALL.has(status)) throw new ManifestError(`Unknown status: ${status}`);
  const current = getStatus(manifest, base);
  if (!canTransition(current, status)) {
    throw new ManifestError(`Illegal transition for ${base}: ${current ?? '(new)'} -> ${status}`);
  }
  manifest.photos ??= {};
  manifest.photos[base] = { ...manifest.photos[base], status, reason };
  return manifest;
}
```

**The merge (`{ ...manifest.photos[base], status, reason }`) is the bug fix**: *"fields that outlive a
status change (`source`) survive it."* A replace would drop `source` and `attempt` on every status
write — which would break the re-roll ladder (no attempt to climb from) and break redo-from-original
(no source path).

#### The per-photo side-car fields

```js
// src/manifest.js:135-146
/** Remember which input photo produced this output, so a redo re-generates from the operator's
 *  original rather than from the generator's own echoed-back copy (a second JPEG compression).
 *  The original may be purged after `retentionDays`; callers fall back to the order folder. */
export function setSource(manifest, base, sourcePath) {
  manifest.photos ??= {};
  manifest.photos[base] = { ...manifest.photos[base], source: sourcePath };
  return manifest;
}
```

**Why `source` exists:** the generator echoes the input photo back alongside its outputs. Regenerating
from that echoed copy would be a **second JPEG compression** of the customer's photo — visibly worse
each time. So the path to the operator's original is recorded, and `redo()` prefers it.

#### The order-level manifest fields

`state.json` also carries **order-level** state, deliberately in the same file:

```js
// src/manifest.js:165-167
// ---- input QC (intake) -----------------------------------------------------
// The order-level intake block: the pre-generation photo checks and the operator's override. Kept
// beside the per-photo statuses so one state.json stays the single source of truth.
```

**The dedication and the "never set" vs "deliberately emptied" distinction:**

```js
// src/manifest.js:101-120
/** The book's title-page text, an order-level operator input, usually recovered from the photo
 *  names (see dedication.js). Empty is a legitimate answer: the customer wrote nothing, and their
 *  title page prints without a text line. See `titleTextFor` for what the page count does. */
const MAX_DEDICATION = 500;

export function getDedication(manifest) {
  return manifest.dedication ?? '';
}

/** Has anyone decided this order's title page yet? Distinguishes "never set" — where a text
 *  derived from the photo names is a helpful guess — from "the operator deliberately emptied
 *  it", where re-deriving it would overwrite their decision on every poll. */
export function hasDedication(manifest) {
  return manifest.dedication !== undefined;
}

export function setDedication(manifest, text) {
  manifest.dedication = String(text ?? '').trim().slice(0, MAX_DEDICATION);
  return manifest;
}
```

`hasDedication` tests `!== undefined`, **not** truthiness. `''` is a *decision* (the operator emptied
the box); `undefined` is *nobody has decided*. Without this distinction, the suggestion machinery
would re-derive a dedication from the photo names on every single poll and silently overwrite an
operator who deliberately wanted no text. `MAX_DEDICATION = 500` and the trim happen at the setter,
so nothing downstream has to validate.

**`clearIntake` and the stale-hold bug:**

```js
// src/manifest.js:178-184
/** Drop the stored intake block. Used when a previously-held order passes intake on a re-run —
 *  the hold lifted on its own, so the stale "we're missing photos" verdict must not linger and
 *  keep the order looking held. */
export function clearIntake(manifest) {
  delete manifest.intake;
  return manifest;
}
```

**`getEmailedAt` / `setEmailedAt` — communication state, orthogonal to the verdict:**

```js
// src/manifest.js:186-198
/** When the operator emailed the customer about a held order (ISO string), or null. Order-level
 *  communication state (N4), orthogonal to the intake verdict: it records that the ball is in the
 *  customer's court since a date, so a held order shows "čeká na zákazníka od X" and doesn't rot
 *  un-chased. Distinct from the drafted email, which is only a copy-paste template. */
export function getEmailedAt(manifest) {
  return manifest.customerEmailedAt ?? null;
}
```

*"doesn't rot un-chased"* — the failure mode this prevents is a held order sitting on the board
forever because nobody remembers whether the customer was ever told.

**`incompleteBook` — the flag that outlives its cause:**

```js
// src/manifest.js:211-225
/** The persistent "operator knowingly shipped an under-count book" flag, or null. Set only when the
 *  operator overrides a missing-photos hold by typing the reduced page count. It OUTLIVES the hold —
 *  the intake block stays in state.json after the override lifts the hold — so the board, the order
 *  card and the send step all keep warning that this book has fewer pages than the product sold. */
export function getIncompleteBook(manifest) {
  return manifest.intake?.incompleteBook ?? null;
}

export function setIncompleteBook(manifest, { pages, expected }) {
  manifest.intake = {
    ...(manifest.intake ?? {}),
    incompleteBook: { pages, expected, at: new Date().toISOString() },
  };
  return manifest;
}
```

**"It OUTLIVES the hold"** is the whole point. Once the override lifts the hold, the order looks
normal — it generates, it builds, it's ready to send. Without a persistent flag, the fact that this
book has 3 pages where the customer paid for 4 would vanish the moment the hold cleared. The flag is
set once and **never cleared**, so it warns on every board glance and in the send confirmation
(`studio.js:159-161`: *"Set at override time and never cleared, so it warns on every board glance and
in the send confirmation."*).

---

#### 5.5.2 `src/review.js` — the review gate

```js
// src/review.js:34-40
// The U4 review gate. state.json is the single source of truth: every verdict here is written
// to disk before the call returns, so closing the tool never loses a decision, and the builder
// gate (isBuilderEligible) reads exactly what the operator saw.
//
// The one rule the whole gate exists to enforce: a flagged photo is NEVER auto-approved.
// Clean results advance on their own; anything the QC tripwire or the operator doubted has to
// be approved by hand before it can reach the PDF.
```

**The one rule: a flagged photo is NEVER auto-approved.** Every function in the file is in service of
that sentence.

#### `reviewState` — joining the inbox with the manifest

```js
// src/review.js:63-65
/** Join what the inbox says an order contains with what the manifest says happened to it.
 *  Photos the batch has not reached yet appear with a null status — that is the grid's
 *  "generating…" placeholder, and it is why an order with a photo still to run is not ready. */
```

The inbox says *what the order contains*; the manifest says *what happened to it*. The join is the
review state. A photo in the inbox with no manifest entry is `null` — which renders as "generating…"
and blocks `ready`. Same principle as `summarizeOrder`.

```js
// src/review.js:66-101
/** An order the operator deleted from the board carries this marker in its outbox folder. The order
 *  and its files stay on disk (recoverable — delete the marker to restore it), but it no longer shows
 *  anywhere the board is derived from reviewState. Same folder-marker pattern as delivered/printed. */
export const hiddenMarkerPath = (orderDir) => join(orderDir, 'hidden.json');

export function reviewState({ inboxRoot, outboxRoot, only = null, memoryRoot = MEMORY_DIR }) {
  let ingested = [];
  try {
    ingested = inboxRoot ? ingestOrders(inboxRoot) : [];
  } catch {
    ingested = []; // no inbox (photos purged, or the operator only kept the outputs)
  }
  // The operator may have ticked a few orders out of a folder holding hundreds. Filtering here
  // keeps the poll cheap: nothing else walks those folders or reads their manifests.
  if (only) ingested = ingested.filter((o) => only.includes(o.orderId));

  const byId = new Map(ingested.map((o) => [o.orderId, { ...o, inInbox: true }]));

  // Orders that exist only in the outbox still deserve a review page — a finished book whose
  // photos have been purged, or one from a folder the operator has since moved on from. They are
  // not what the operator is working on now, and the grid says so.
  for (const order of outboxOrders(outboxRoot)) if (!byId.has(order.orderId)) byId.set(order.orderId, { ...order, inInbox: false });

  const orders = [];
  for (const [orderId, order] of byId) {
    const orderDir = join(outboxRoot, orderId);
    if (existsSync(hiddenMarkerPath(orderDir))) continue; // the operator deleted it from the board
    const manifest = readManifest(orderDir);
    const sources = new Map((order.photos ?? []).map((p) => [photoBase(p), p]));
    const bases = sources.size > 0 ? [...sources.keys()] : Object.keys(manifest.photos ?? {});

    // Best source first. The shop's own record is the only one that can spell "Pro Jiříčka"; the
    // photo names lost the accents before this tool ever saw them.
    const fromShop = order.dir ? shopDedication(order.dir) : '';
    const remembered = fromShop ? '' : recallDedication(memoryRoot, deriveSlug(bases));
    const suggestion = fromShop || remembered || deriveDedication(bases);
```

Decisions worth keeping:

- **A missing inbox is not an error** — `catch { ingested = []; }`. *"no inbox (photos purged, or the
  operator only kept the outputs)."* A delivered order whose photos were purged by retention still
  has a review page.
- **`inInbox: false` for outbox-only orders** — *"They are not what the operator is working on now,
  and the grid says so."* Not hidden, just labelled.
- **The `hidden.json` folder-marker pattern** — the same pattern as `delivered.json` and
  `printed.json`. The order and its files stay on disk, recoverable by deleting the marker. Nothing
  is ever destroyed by a UI click.
- **`bases` prefers the inbox**, falling back to manifest keys only when the inbox has nothing —
  the `summarizeOrder` rule again.
- **The dedication source cascade, best first**: shop → memory → filename. *"The shop's own record is
  the only one that can spell 'Pro Jiříčka'; the photo names lost the accents before this tool ever
  saw them."* Filenames are ASCII-mangled by the time the tool sees them; the shop record is the only
  place the customer's actual diacritics survive.

```js
// src/review.js:124-148 (the emitted order shape — the interesting fields)
      // Only ever a *suggestion* for an untouched order. Once the operator has decided — even
      // by emptying the box — the grid must show their decision, not talk them out of it.
      suggestedDedication: hasDedication(manifest) ? '' : suggestion,
      suggestionRemembered: Boolean(!hasDedication(manifest) && remembered),
      // Where the suggestion came from, so the grid can say whether it needs checking.
      suggestionSource: hasDedication(manifest) || !suggestion ? '' : fromShop ? 'shop' : remembered ? 'memory' : 'filename',
      // What an empty box used to say, so a clear the operator did not mean is one click away.
      clearedDedication: manifest.dedicationWas ?? '',
```

*"Once the operator has decided — even by emptying the box — the grid must show their decision, not
talk them out of it."* `suggestionSource` is surfaced so the operator knows whether to trust it — a
filename-derived suggestion needs checking; a shop-derived one doesn't.

#### `setOrderDedication` — the one thing that cannot be regenerated

```js
// src/review.js:160-185
/** Set the order's title-page text. Writing it also makes any already-printed PDF stale,
 *  because state.json is the order's "last decided" clock.
 *
 *  Customer text is the one thing here that cannot be regenerated: the photos can be re-run, the
 *  PDF reprinted, but nobody remembers what a stranger wrote. So an emptied dedication is kept
 *  under `dedicationWas`, and the grid offers it back. One real order lost its text to something
 *  we could not reproduce; this is what makes the next one survivable. */
export function setOrderDedication(orderDir, text, { memoryRoot = MEMORY_DIR } = {}) {
  const manifest = readManifest(orderDir);
  const before = getDedication(manifest);
  setDedication(manifest, text);
  const after = getDedication(manifest);

  if (before && !after) manifest.dedicationWas = before;
  else if (after) delete manifest.dedicationWas;

  writeManifest(orderDir, manifest);

  // Whatever they typed is the true spelling of this name. Remember it against the file name's
  // slug so the next customer called Jiříček is not typed out again — and so nobody has to notice
  // that the shop dropped the accents in the first place.
  const slug = deriveSlug(Object.keys(manifest.photos ?? {}));
  if (slug) learnDedication(memoryRoot, slug, after);

  return after;
}
```

**"One real order lost its text to something we could not reproduce; this is what makes the next one
survivable."** This is the highest-value comment in `review.js`. The reasoning:

- The photos can be re-run. The PDF can be reprinted. Everything in this system is reproducible —
  *except the customer's own words*. Nobody remembers what a stranger wrote.
- So an emptied dedication is stashed under `dedicationWas` and offered back with one click.
- The bug that caused it was never reproduced. The fix is not a fix for the bug; it is a fix for the
  *consequence*.

Also: **writing the dedication makes any printed PDF stale**, because `state.json`'s mtime is the
order's "last decided" clock (`orchestrator.js:51-58`). And `learnDedication` records the operator's
spelling against the filename slug, so the *next* Jiříček is spelled right automatically.

#### `overrideIntake` — the confirmCount + incompleteBook rule

```js
// src/review.js:187-214
/** "Generate it anyway": clear an intake hold so the next run generates the order despite the
 *  flagged photos. Order-level, like the dedication — the whole order was held, not one photo.
 *
 *  When the hold is that photos are MISSING, an unguarded override would ship a book with fewer
 *  pages than the customer paid for. So that case demands `confirmCount` — the operator has to type
 *  the reduced page count (the number of photos actually present) back to us — and we stamp a
 *  persistent `incompleteBook` flag that follows the order through PDF and send. Quality-only holds
 *  (blur, dark, duplicate) are not under-count and clear with a plain override. */
export function overrideIntake(orderDir, { on = true, confirmCount = null } = {}) {
  const manifest = readManifest(orderDir);
  const under = on
    ? (getIntake(manifest)?.findings ?? []).find((f) => f.check === 'count' && f.verdict === 'hold' && f.missing > 0)
    : null;

  if (under) {
    const pages = under.unique; // photos actually present = the pages this book will have
    if (Number(confirmCount) !== pages) {
      throw new ReviewError(
        `Neúplná kniha: napište ${pages} pro potvrzení, že kniha bude mít ${pages} stran místo ${under.expected}.`,
      );
    }
    setIncompleteBook(manifest, { pages, expected: under.expected });
  }

  setIntakeOverride(manifest, on);
  writeManifest(orderDir, manifest);
  return { override: getIntakeOverride(manifest), incompleteBook: getIncompleteBook(manifest) };
}
```

**The two-tier override is the important design.** Not all holds are equal:

- **Quality-only holds** (blur, dark, unreadable, duplicate) → a plain override clears them. The
  operator looked at the photo and decided it's fine. Their judgement, one click.
- **A missing-photos hold** → **type-to-confirm**. *"an unguarded override would ship a book with
  fewer pages than the customer paid for."* This is not a quality judgement; it is shipping less
  product than was sold. So the operator must type the reduced page count back — `Number(confirmCount)
  !== pages` throws — and the persistent `incompleteBook` flag is stamped.

The detection is precise: `f.check === 'count' && f.verdict === 'hold' && f.missing > 0`. An
`extra-photos` finding is a warn, not a hold, and never triggers this. `pages = under.unique` — the
photos actually present *are* the pages this book will have.

The error message names the exact number to type and states the consequence in Czech: *"napište 3 pro
potvrzení, že kniha bude mít 3 stran místo 4"* — write 3 to confirm this book will have 3 pages
instead of 4. The friction is proportional to the irreversibility.

The HTTP layer surfaces this correctly (`ui/server.js:1139-1149`): *"overrideIntake throws a
ReviewError (→ 409) if it does not match, so the operator cannot ship an under-count book on a stray
click."*

#### The verdict functions

```js
// src/review.js:227-233
function update(orderDir, base, fn) {
  const manifest = readManifest(orderDir);
  if (!manifest.photos?.[base]) throw new ReviewError(`No photo "${base}" in ${orderDir}.`);
  fn(manifest);
  writeManifest(orderDir, manifest);
  return getStatus(manifest, base);
}
```

Read → mutate → **write** → return. Every verdict is on disk before the call returns. No caller can
forget.

```js
// src/review.js:235-265
/** The operator says this one is good. The only way a flagged photo reaches the builder. */
export function approve(orderDir, base) {
  return update(orderDir, base, (manifest) => {
    const status = getStatus(manifest, base);
    if (status === STATES.MANUAL_IN_PROGRESS) {
      throw new ReviewError(
        `"${base}" is out for manual repair. Save the replacement into the order folder and click "I've replaced it" first.`,
      );
    }
    if (status === STATES.FAILED) {
      throw new ReviewError(`"${base}" never generated, so there is nothing to approve. Redo it first.`);
    }
    setStatus(manifest, base, STATES.APPROVED, 'operator approved');
  });
}

/** The operator's eye overrules the QC tripwire: send a photo back to the review queue. */
export function reject(orderDir, base, reason = 'operator marked bad') {
  return update(orderDir, base, (manifest) => setStatus(manifest, base, STATES.FLAGGED, reason));
}

/** Hand a photo to the generator/Figma for manual repair. Always passes through flagged, so
 *  "hand off" on a clean-looking photo still records that the operator rejected it. */
export function handoff(orderDir, base) {
  return update(orderDir, base, (manifest) => {
    if (getStatus(manifest, base) !== STATES.FLAGGED) {
      setStatus(manifest, base, STATES.FLAGGED, 'operator sent it for manual repair');
    }
    setStatus(manifest, base, STATES.MANUAL_IN_PROGRESS, 'awaiting a hand-repaired replacement');
  });
}
```

`approve` refuses two states with **actionable** messages, not just "invalid":

- `manual_in_progress` → *"is out for manual repair. Save the replacement into the order folder and
  click 'I've replaced it' first."* Approving here would approve the *old* page while a repair is
  pending — a real footgun.
- `failed` → *"never generated, so there is nothing to approve. Redo it first."* There is literally
  no file.

`handoff`'s pass-through-flagged is not ceremony: *"'hand off' on a clean-looking photo still records
that the operator rejected it."* The state machine wouldn't allow `ok → manual_in_progress` anyway
(see TRANSITIONS), and that restriction exists precisely to force this recording.

#### `acceptReplacement` — a handoff is a redo, not a shortcut

```js
// src/review.js:267-288
/** The operator saved a repaired file into the order folder. Re-run QC on what actually landed
 *  and put the tile back in the queue as pending_review — a handoff is a redo, not a shortcut
 *  past review, so this never approves and never marks a photo clean. */
export async function acceptReplacement({ orderDir, base, qc = assessOutputFiles }) {
  const manifest = readManifest(orderDir);
  const status = getStatus(manifest, base);
  if (status !== STATES.MANUAL_IN_PROGRESS && status !== STATES.PENDING_REVIEW) {
    throw new ReviewError(`"${base}" was not handed off for manual repair (it is ${status ?? 'not generated'}).`);
  }

  const out = outputPaths(`${base}.jpg`, orderDir);
  if (!existsSync(out.coloringSvg) || !existsSync(out.coloringPng)) {
    throw new ReviewError(
      `No replacement found for "${base}". Save the repaired ${base}.svg and ${base}_bw.png into ${orderDir}, then click again.`,
    );
  }

  const verdict = await qc(out);
  setStatus(manifest, base, STATES.PENDING_REVIEW, verdict.reason);
  writeManifest(orderDir, manifest);
  return { status: STATES.PENDING_REVIEW, verdict };
}
```

**"a handoff is a redo, not a shortcut past review, so this never approves and never marks a photo
clean."** Even a hand-repaired file lands in `pending_review`, never `ok` and never `approved`. QC is
re-run on *what actually landed* — the operator could have saved the wrong file, or a broken one.

Note the error message names the exact filenames and the exact folder. The operator is working in
Figma and Explorer, not a terminal.

#### `applyPhotoEdit` — the SVG is the truth

```js
// src/review.js:290-307
/** Where the page looked like before the operator first drew on it.
 *
 *  Kept *outside* the order folder: the builder is handed that whole directory, and a spare SVG
 *  sitting in it is one more thing for it to pair up and print. */
export function editBackupPath(orderDir, base) {
  return join(dirname(orderDir), '.originals', basename(orderDir), `${base}.svg`);
}

/** Render the coloring page's SVG to the raster the grid and QC look at.
 *
 *  Decoded from bytes rather than a path: handed a path, libvips keeps the file mapped while it
 *  works, and on Windows the very next line cannot then overwrite it. */
async function rasterize(svgText, width) {
  let img = sharp(Buffer.from(svgText), { density: 96 });
  if (width) img = img.resize({ width }); // keep the resolution the generator gave us
  return img.flatten({ background: '#ffffff' }).png().toBuffer();
}
```

**The backup lives outside the order folder** — because the builder is handed that whole directory and
pairs by filename. A stray `<base>.svg` backup sitting in it would be **paired up and printed into
the customer's book**. That is a real, shipped-defect-class bug avoided by one `dirname()`.

**The libvips file-mapping trap again** (third occurrence in the codebase).

```js
// src/review.js:310-349
/** The operator's white pencil and crop, applied to the page the book actually prints.
 *
 *  The SVG is the truth and the PNG is made from it, never the other way round — the builder
 *  ignores `_bw.png` entirely, so a raster-only fix would look right in the grid and print wrong.
 *  Lands in pending_review by the same path a hand-repaired file does: an edit is a repair, not a
 *  shortcut past the review gate. */
export async function applyPhotoEdit({ orderDir, base, edits, qc = assessOutputFiles }) {
  const manifest = readManifest(orderDir);
  const status = getStatus(manifest, base);
  if (status == null) throw new ReviewError(`No photo "${base}" in ${orderDir}.`);

  const out = outputPaths(`${base}.jpg`, orderDir);
  if (!existsSync(out.coloringSvg)) throw new ReviewError(`"${base}" has no coloring page to fix yet — generate it first.`);

  const before = readFileSync(out.coloringSvg, 'utf8');
  let after;
  try {
    after = applyEdits(before, edits);
  } catch (err) {
    if (err instanceof EditError) throw new ReviewError(err.message);
    throw err;
  }

  // Render before writing anything: an SVG that will not rasterize must not reach the order
  // folder, where the next run would hand it straight to the builder.
  const width = (await sharp(readFileSync(out.coloringPng)).metadata()).width;
  const png = await rasterize(after, width);

  const backup = editBackupPath(orderDir, base);
  if (!existsSync(backup)) {
    mkdirSync(dirname(backup), { recursive: true });
    writeFileSync(backup, before); // the generated page, before anyone drew on it
  }

  writeFileSync(out.coloringSvg, after);
  writeFileSync(out.coloringPng, png);

  if (status !== STATES.MANUAL_IN_PROGRESS && status !== STATES.PENDING_REVIEW) handoff(orderDir, base);
  return acceptReplacement({ orderDir, base, qc });
}
```

**"The SVG is the truth and the PNG is made from it, never the other way round — the builder ignores
`_bw.png` entirely, so a raster-only fix would look right in the grid and print wrong."** The grid
shows the PNG; the book prints the SVG. Edit the PNG only and the operator sees a fixed page and the
customer gets a broken one. Silent, and only discovered after printing.

**"Render before writing anything: an SVG that will not rasterize must not reach the order folder,
where the next run would hand it straight to the builder."** Validate-then-write ordering. A broken
SVG in the order folder is a broken book.

**The backup is only written on the FIRST edit** (`if (!existsSync(backup))`) — so "revert" always
goes back to the *generated* page, not to the state before the most recent brush stroke.

The tail routes through `handoff` → `acceptReplacement`, so an edit lands in `pending_review` by
exactly the same path a hand-repaired file does.

```js
// src/review.js:351-371
/** Throw away every edit and put the generated page back. */
export async function revertPhotoEdit({ orderDir, base, qc = assessOutputFiles }) {
  const backup = editBackupPath(orderDir, base);
  if (!existsSync(backup)) throw new ReviewError(`"${base}" has never been edited, so there is nothing to undo.`);

  const out = outputPaths(`${base}.jpg`, orderDir);
  const original = readFileSync(backup, 'utf8');
  // At its own size, not the current PNG's: a crop changed the page's shape, and matching the
  // cropped raster's width would stretch the page we are putting back.
  const png = await rasterize(original);

  writeFileSync(out.coloringSvg, original);
  writeFileSync(out.coloringPng, png);
  // Only once both files are back: the page is the generated one again, so it must stop calling
  // itself hand-fixed and stop offering to undo an edit that no longer exists.
  rmSync(backup, { force: true });
  ...
}
```

Two more fixed bugs:

- **`rasterize(original)` with no width** — *"a crop changed the page's shape, and matching the
  cropped raster's width would stretch the page we are putting back."* `applyPhotoEdit` passes the
  current PNG's width (to keep the generator's resolution); `revertPhotoEdit` must not, because the
  page being restored has a different aspect ratio.
- **`rmSync(backup)` happens LAST**, after both files are back. If it ran first and a write then
  failed, the page would be un-revertable forever. Order of operations as crash-safety.

#### `redo` — same code path, different rung

```js
// src/review.js:373-397
/** Re-generate one photo. A redo always starts from flagged, so it runs the identical code path
 *  a first attempt runs (generatePhoto) and a clean result auto-advances to ok exactly as it
 *  would have in the batch. Regenerating from flagged is also what makes the re-roll differ from
 *  the attempt the operator rejected — generatePhoto raises the step count rather than re-sending
 *  a request this deterministic generator would answer identically.
 *  Regenerates from the operator's original photo when it still exists; the generator's echoed-back
 *  copy is a second JPEG compression and is only the fallback. */
export async function redo({ config, orderDir, base, driver, qc, onEvent }) {
  const manifest = readManifest(orderDir);
  const status = getStatus(manifest, base);
  if (status == null) throw new ReviewError(`No photo "${base}" in ${orderDir}.`);
  if (status !== STATES.FLAGGED) {
    setStatus(manifest, base, STATES.FLAGGED, 'operator requested a redo');
    writeManifest(orderDir, manifest);
  }

  const source = getSource(manifest, base);
  const fallback = outputPaths(`${base}.jpg`, orderDir).original;
  const photoPath = source && existsSync(source) ? source : existsSync(fallback) ? fallback : null;
  if (!photoPath) {
    throw new ReviewError(`Cannot redo "${base}": neither the original photo nor ${fallback} is on disk.`);
  }

  return generatePhoto({ config, photoPath, orderDir, manifest, orderId: manifest.orderId, driver, qc, onEvent });
}
```

**"A redo always starts from flagged"** does three jobs at once:

1. It runs the **identical code path** a first attempt runs, so the two cannot drift.
2. A clean result **auto-advances to `ok`** exactly as it would have in the batch — no special
   "redo succeeded" handling.
3. **It is what makes the re-roll differ.** `generatePhoto`'s `reroll` condition requires `FLAGGED`.
   Without forcing flagged first, `nextAttemptSettings` would never be called and the redo would
   re-send the identical request to a deterministic generator — a no-op that looks like work.

The source cascade — operator's original, else the generator's echoed copy — avoids a second JPEG
compression, and fails with a clear message when neither is on disk (retention purged the original
and the echo is gone).

---

#### 5.5.3 `src/studio.js` — `deriveOrderStatus`, and why there is no stored status

```js
// src/studio.js:8-14
// The live order board behind the dashboard's Objednávky and Potřebuje vás tabs (KTD5/KTD6).
//
// Every order-level status is DERIVED on read, never stored: the review grid already owns the
// per-photo truth in state.json, and a second mutable "order status" field beside it would be one
// more thing to keep in sync. The aggregation is a pure function over the review state plus three
// facts that state cannot see on its own — is the run generating this order right now, is its PDF
// built, and has it been delivered to Jirka — so a test drives it with fakes and never touches disk.
```

**This is the architectural decision of the whole board.** There is no `order.status` field anywhere
on disk. The reasoning:

- `state.json` already owns the per-photo truth.
- A second mutable "order status" field beside it would be **one more thing to keep in sync** — and
  every code path that changed a photo status would have to remember to recompute it. Miss one and
  the board lies.
- So the order status is a **pure function** over the review state plus a small number of facts that
  the review state cannot see on its own.

The facts that must be injected, because they live in the filesystem rather than in `state.json`:
`generating` (is the run on this order right now), `pdfBuilt`, `delivered`, `printed`.

Every one of those four is a **filesystem fact** — a marker file or a PDF's existence — which is why
they must be injected: `deriveOrderStatus` stays pure and testable with plain booleans.

```js
// src/studio.js:69-80
/** The order-level board statuses. Distinct from the per-photo STATES and from the photo-level
 *  `handoff` (manual repair) — this is where the whole order sits on its way to Jirka. The client
 *  `STATUS` map in src/ui/static/dashboard.html must carry a label for each of these values. */
export const ORDER_BOARD_STATES = Object.freeze({
  QUEUED: 'queued',
  GENERATING: 'generating',
  HELD: 'held',
  PENDING_REVIEW: 'pending-review',
  APPROVED: 'approved', // every photo approved, but no Final.pdf on disk yet → CTA "Vytvořit PDF"
  READY_TO_SEND: 'ready-to-send', // the book exists on disk → CTA "Odeslat Jirkovi"
  SENT: 'sent', // delivered to Jirka, awaiting his print confirmation → CTA "Označit vytištěno"
  PRINTED: 'printed', // Jirka confirmed the print; terminal, and the only state a purge will touch
  FAILED: 'failed',
});
```

**Every board state, and what puts an order there:**

| state | meaning | derived from |
|---|---|---|
| `queued` | untouched, or part-generated with nothing flagged — press Go | the fallthrough |
| `generating` | the run is on this order right now | injected `generating` |
| `held` | intake hold, not overridden, nothing generated yet | `intakeHeld` |
| `pending-review` | a photo awaits the operator | `s.held > 0 \|\| s.manual > 0` |
| `approved` | every photo eligible, **no PDF yet** → CTA "Vytvořit PDF" | `s.ready && !pdfBuilt` |
| `ready-to-send` | the book is on disk → CTA "Odeslat Jirkovi" | injected `pdfBuilt` |
| `sent` | delivered to Jirka, awaiting print confirmation | `delivered.json` |
| `printed` | Jirka confirmed; **terminal**, and the only state a purge touches | `printed.json` |
| `failed` | a photo's generation died | `s.failed > 0` |

```js
// src/studio.js:82-109
/** One order's board status from its review state plus the three injected facts. Pure.
 *
 *  Order matters: the delivery marker is terminal, an intake hold outranks generation (a held
 *  order never generates), and a live run on this order beats any half-finished photo state. */
export function deriveOrderStatus(order, { generating = false, pdfBuilt = false, delivered = false, printed = false } = {}) {
  const s = order.summary ?? { total: 0, eligible: 0, held: 0, manual: 0, failed: 0, pending: 0, ready: false };
  // A stored intake hold only means "held" while nothing has generated past it. Generation is
  // skipped entirely for a held order, so a genuine hold has every photo still pending; once the
  // customer's fix lets the order generate and build, a lingering block (cleared at the source on
  // the next run, but guarded here too) must not keep a finished book under "needs you".
  const intakeHeld = order.intake?.verdict === 'hold' && order.intake?.override !== true && s.pending === s.total;

  if (printed) return ORDER_BOARD_STATES.PRINTED; // terminal — outranks sent, the lifecycle is closed
  if (delivered) return ORDER_BOARD_STATES.SENT; // the marker is idempotent — a sent order stays sent
  if (intakeHeld) return ORDER_BOARD_STATES.HELD; // surfaces under Potřebuje vás with its draft email
  if (generating) return ORDER_BOARD_STATES.GENERATING; // the run is on this order right now
  if (s.failed > 0) return ORDER_BOARD_STATES.FAILED;
  if (s.held > 0 || s.manual > 0) return ORDER_BOARD_STATES.PENDING_REVIEW; // a photo awaits the operator
  // Split the old "připraveno" collision (N1): a book already on disk is ready to SEND; an order with
  // every photo approved but no PDF yet is APPROVED and needs "Vytvořit PDF". One state → one CTA, so
  // the home card and the board can never disagree about whether the PDF exists.
  if (pdfBuilt) return ORDER_BOARD_STATES.READY_TO_SEND; // the finished book is on disk → send it
  if (s.ready) return ORDER_BOARD_STATES.APPROVED; // all photos approved, PDF not built yet → build it
  // Anything left is unfinished with nothing flagged: an untouched order, or one a stopped run left
  // part-generated (some photos ok, the rest still to run). Both just need Go pressed to finish —
  // queued, not a review the operator would open to find nothing waiting.
  return ORDER_BOARD_STATES.QUEUED;
}
```

**The precedence order is the design, and every step is annotated:**

1. `printed` — terminal, outranks everything. The lifecycle is closed.
2. `delivered` — *"the marker is idempotent — a sent order stays sent."*
3. `intakeHeld` — outranks `generating`, because a held order never generates.
4. `generating` — a live run beats any half-finished photo state.
5. `failed` → `pending-review` → `ready-to-send` → `approved` → `queued`.

**The `intakeHeld` triple condition is a real bug fix.** It is not just `verdict === 'hold'`:

```js
order.intake?.verdict === 'hold' && order.intake?.override !== true && s.pending === s.total
```

The `s.pending === s.total` clause is the subtle one: *"Generation is skipped entirely for a held
order, so a genuine hold has every photo still pending; once the customer's fix lets the order
generate and build, a lingering block ... must not keep a finished book under 'needs you'."* A stale
intake block on an order that has since generated and built would otherwise park a finished book
under "Potřebuje vás" forever. `clearIntake` in the orchestrator fixes it at the source; this is the
belt-and-braces guard on the read side.

**The `approved` / `ready-to-send` split (N1)** is the other documented fix: *"Split the old
'připraveno' collision."* One status used to mean both "all photos approved" and "book built", so the
UI could not decide which button to show. **One state → one CTA**, *"so the home card and the board
can never disagree about whether the PDF exists."*

**The `queued` fallthrough** is reasoned, not a default: *"an untouched order, or one a stopped run
left part-generated ... Both just need Go pressed to finish — queued, not a review the operator would
open to find nothing waiting."* The alternative — routing a part-generated order to `pending-review` —
would send the operator to a screen with nothing to act on.

#### The marker-file pattern

```js
// src/studio.js:16-35
/** The Jirka-delivery marker written into an order's outbox folder once the book is on its way to
 *  the printer (Phase 2). Its presence is the single source of truth for 'sent'. */
export const deliveredMarkerPath = (orderDir) => join(orderDir, 'delivered.json');

/** The operator confirms a finished book has gone to Jirka: write the terminal delivery marker so
 *  the order derives to 'sent' and drops off the active board. This is a MANUAL acknowledgement —
 *  nothing here contacts Jirka; it only records that the operator already did. Idempotent. Later,
 *  automated WhatsApp delivery (Phase 2) would write the same marker in the operator's place. */
export function markDelivered(orderDir, info = {}) {
  // Stamp the mtime of the exact PDF that went out (N10): if the book is rebuilt after this, the
  // board can tell the sent file is now stale and offer to re-send. mtime, not a hash — a rebuild
  // always rewrites the file, and hashing every sent PDF on each board poll would be wasteful.
  const pdf = pdfPathFor(orderDir, basename(orderDir));
  const sentPdfMtime = existsSync(pdf) ? statSync(pdf).mtimeMs : null;
  writeFileSync(
    deliveredMarkerPath(orderDir),
    JSON.stringify({ at: new Date().toISOString(), by: 'operator', ...info, sentPdfMtime }, null, 2),
  );
  return ORDER_BOARD_STATES.SENT;
}
```

**Markers as state.** Four folder markers carry the order-level lifecycle: `delivered.json`,
`printed.json`, `hidden.json`, and the existence of `<orderId> Final.pdf`. All are:
- **idempotent** (write it twice, same result),
- **reversible** (`unmarkDelivered`, `unmarkPrinted` — `rmSync(..., { force: true })`, safe when
  absent),
- **inspectable** (the operator can look in the folder),
- **survivable** (losing one degrades to "not yet done", never to a wrong action).

**`sentPdfMtime` (N10)** — the staleness check. *"mtime, not a hash — a rebuild always rewrites the
file, and hashing every sent PDF on each board poll would be wasteful."* The cheaper signal is
sufficient because a rebuild always rewrites.

```js
// src/studio.js:44-59
/** The 'printed' marker: the operator confirms Jirka actually printed the book (N3). This single
 *  manual bit closes the lifecycle past 'sent' — a WhatsApp message could be lost, so 'odesláno' is
 *  not proof of print — and it is what gates the photo purge: a customer's photos are only ever
 *  deleted once their book is confirmed printed (see retention.js). Its presence is the source of
 *  truth for 'printed'. */
```

**"a WhatsApp message could be lost, so 'odesláno' is not proof of print"** — this is why `printed` is
a separate state from `sent` rather than a rename. And it is what gates the **irreversible** action in
the whole system: **a customer's photos are only ever deleted once their book is confirmed printed.**
The most destructive operation is gated on the one bit a human explicitly set.

#### `buildBoard` and the staleness/age wiring

```js
// src/studio.js:165-201
/** Build the whole board from review-state orders plus injected fact-providers. Pure over its
 *  inputs — `pdfBuilt`/`delivered` are predicates, `runningOrderId` a plain id — so the whole
 *  status machine is testable without a filesystem or a running server. */
export function buildBoard(orders, { runningOrderId = null, pdfBuilt = () => false, delivered = () => false, printed = () => false, createdAt = () => null, stale = () => false, firstLiveOrder = null } = {}) {
  // Hide old test orders: everything below the first real order number never reaches the board or
  // its counts. Non-numeric ids are always kept — the floor only judges what it can compare.
  const live =
    firstLiveOrder == null
      ? orders
      : orders.filter((order) => {
          const n = Number.parseInt(order.orderId, 10);
          return Number.isNaN(n) || n >= firstLiveOrder;
        });
  ...
    // Only a sent order can be stale: its PDF was rebuilt after it went to Jirka (N10).
    entry.stale = status === ORDER_BOARD_STATES.SENT && stale(order);
  ...
  // Oldest-first: the operator works the queue in the order the customers sent it.
  board.sort((a, b) => a.orderId.localeCompare(b.orderId, 'en', { numeric: true }));
```

- **`firstLiveOrder`** hides old test orders below a numeric floor. *"Non-numeric ids are always kept
  — the floor only judges what it can compare."* A `NaN` order id is never silently swallowed.
- **`localeCompare(..., { numeric: true })`** everywhere order ids are sorted — so `1523` sorts after
  `999`, not before. String sort on numeric ids is a classic and it is consistently avoided.
- **Every injected fact is a *function*** (`pdfBuilt(order)`, `delivered(order)`), not a value — so
  the board can stat the filesystem lazily per order in production and return a constant in a test.

`studioBoard` (`studio.js:225-258`) is the only part that touches disk, and it is the thin adapter:
`pdfBuilt: (o) => existsSync(...)`, `delivered: (o) => existsSync(...)`, plus:

```js
// src/studio.js:235-254
    // Order age (N8): the folder's creation time, best proxy for when the order arrived. birthtime is
    // unreliable on some filesystems (reads 0) — fall back to mtime there.
    createdAt: (o) => {
      try {
        const st = statSync(o.orderDir);
        return st.birthtimeMs || st.mtimeMs || null;
      } catch {
        return null;
      }
    },
    // Sent-file staleness (N10): the current PDF is newer than the one recorded at send time.
    stale: (o) => {
      const marker = deliveredMarkerPath(o.orderDir);
      const pdf = pdfPathFor(o.orderDir, o.orderId);
      if (!existsSync(marker) || !existsSync(pdf)) return false;
      try {
        const { sentPdfMtime } = JSON.parse(readFileSync(marker, 'utf8'));
        return typeof sentPdfMtime === 'number' && statSync(pdf).mtimeMs > sentPdfMtime + 1000; // 1s epsilon
      } catch {
        return false;
      }
    },
```

Three real-world details: **`birthtimeMs` reads 0 on some filesystems** so it falls back to `mtimeMs`;
the **1-second epsilon** on the staleness comparison absorbs filesystem timestamp granularity; and
**every one of these degrades to a safe answer** (`null`, `false`) rather than throwing.

`heldReason` (`studio.js:111-123`) is the same shape — *"Falls back rather than throwing on an
override-only or malformed block"* — with a neutral Czech default.

---

#### 5.5.4 `src/autopilotState.js` — the sliding window vs the hard cursor

```js
// src/autopilotState.js:1-9
// The autopilot's persisted memory: which orders it has already carried all the way to a built book,
// and how far the poll cursor has advanced. Lives in the outside-repo data dir (config.shopify.dataDir)
// so a 15-minute poll never re-pulls a finished order and no cursor/PII is ever committable (KTD4).
//
// Only TERMINAL orders (their PDF is built — status `ready`) land in the handled set. Held and failed
// orders are deliberately left OUT so the next poll re-pulls them: that is what lets a customer's
// re-upload lift an intake hold overnight, unattended (KTD8). A lost or corrupt state file degrades to
// "start clean" — the pipeline's own force:false caching means already-built PDFs are not re-generated,
// so the blast radius of a state loss is a re-download, never a re-spend.
```

**"Only TERMINAL orders land in the handled set."** This is the decision, and it is counter-intuitive
enough to be worth spelling out: the obvious design is "record every order you've seen so you don't
re-process it". That design is **wrong here**, and the reason is KTD8.

**The reasoning chain:**

1. If a held order were marked handled, the next poll would skip it.
2. But a held order is held *because the customer needs to do something* — re-upload a missing photo.
3. When they do, nothing would ever look at the order again. The hold would never lift.
4. So held and failed orders are **deliberately left out**, and they re-surface on every poll until
   they resolve.
5. That is what lets a customer's overnight re-upload lift an intake hold **unattended**.

**The paired decision — a sliding window, not a hard cursor** (stated in `autopilot.js:7-11`):

```js
// src/autopilot.js:7-11
// Detection is a SLIDING WINDOW, not a hard cursor: the poll asks for every order updated in the last
// few days and the handled set (autopilotState.js) dedups the finished ones. That is deliberate — a
// hard `updated_at > cursor` bound would freeze a held order (its updatedAt is in the past) and defeat
// the overnight self-lift (KTD8). Held/failed orders therefore re-surface each run until they resolve
// or fall out of the window; a `pending → paid` transition re-stamps updatedAt and re-enters the window.
```

**Why the hard cursor fails:** a held order's `updatedAt` is in the past. A `updated_at > cursor` query
would never return it again — the cursor has moved past it. The order would freeze, held forever,
even after the customer fixed it. The sliding window (`updated_at:>=now-7d`) re-asks for everything
recent, every time, and the handled set does the deduplication.

The two mechanisms are **complementary, and the split is the design**:
- The **window** decides what is *visible*.
- The **handled set** decides what is *finished*.

Neither alone works. A window without a handled set re-runs finished orders. A handled set without a
window (i.e. a cursor) freezes held orders.

```js
// src/autopilot.js:22-26
const DAY_MS = 24 * 60 * 60 * 1000;

// How far back each poll looks. Wide enough that a customer's next-day re-upload still lands inside the
// window so an intake hold can self-lift (KTD8); the handled set keeps finished orders from re-running.
export const POLL_LOOKBACK_DAYS = 7;
```

7 days is the tuning knob: wide enough for a customer's next-day (or next-week) re-upload to land
inside it. The stated failure mode is bounded — an order that falls out of the window stops
self-lifting and needs the operator. Also noted: *"a `pending → paid` transition re-stamps updatedAt
and re-enters the window"* — the window is `updated_at`-based, so a payment brings a stale order back.

```js
// src/autopilotState.js:19-43
const empty = () => ({ handled: {}, cursor: null, lastRunAt: null });

/** Read the persisted state, or a clean slate when there is none / it is unreadable. Never throws —
 *  a half-written file must not abort the night. */
export function loadState(dataDir) {
  const path = statePath(dataDir);
  if (!existsSync(path)) return empty();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty();
    return {
      handled: parsed.handled && typeof parsed.handled === 'object' && !Array.isArray(parsed.handled) ? parsed.handled : {},
      cursor: typeof parsed.cursor === 'string' ? parsed.cursor : null,
      lastRunAt: typeof parsed.lastRunAt === 'string' ? parsed.lastRunAt : null,
    };
  } catch {
    return empty();
  }
}
```

**"Never throws — a half-written file must not abort the night."** Every field is type-checked
individually — a corrupt `handled` degrades to `{}` while a valid `cursor` survives. `Array.isArray`
is checked explicitly because `typeof [] === 'object'`.

**The blast radius is stated and bounded:** *"A lost or corrupt state file degrades to 'start clean' —
the pipeline's own force:false caching means already-built PDFs are not re-generated, so the blast
radius of a state loss is a re-download, never a re-spend."* This is why it is safe for `loadState`
to be so forgiving: the expensive thing (GPU generation) is protected by a *second, independent*
mechanism (the PDF cache + `needsGeneration`), so state loss costs bandwidth, not money.

```js
// src/autopilotState.js:45-58
/** True once an order has been carried to a built book and should never re-run. Held/failed orders
 *  are never recorded here, so this is false for them and they stay re-pollable (KTD8). */
export function isHandled(state, orderId) {
  return Boolean(state.handled?.[orderId]);
}

/** Record an order that reached its terminal state (PDF built). Advances the cursor to the latest
 *  `updatedAt` fully handled — a lower bound and an observability signal, not the poll's only filter
 *  (the sliding window + this handled set together do the dedup). Mutates and returns `state`. */
export function markHandled(state, orderId, { status = 'ready', updatedAt = null, at = null } = {}) {
  state.handled[orderId] = { status, at };
  if (updatedAt && (!state.cursor || updatedAt > state.cursor)) state.cursor = updatedAt;
  return state;
}
```

**The `cursor` still exists but is explicitly demoted:** *"a lower bound and an observability signal,
not the poll's only filter."* It records how far the autopilot has got, for a human reading the state
file. It does **not** gate the poll. Keeping it while stripping its authority is the honest way to
record "we tried the cursor design and it was wrong".

Note `markHandled` is also called from the UI's delete endpoint with `status: 'deleted'`
(`ui/server.js:1229`) — so a deleted order is never re-materialized from Shopify.

---

#### 5.5.5 `src/orchestrator.js` — `ORDER_STATUS`, `buildabilityProblem`, and the safety-before-cache bug

```js
// src/orchestrator.js:31-38
// U6: the single "Go" run. ingest -> generate -> QC -> [review gate] -> builder -> PDF.
//
// The review gate is a wall, not a step: an order whose photos are not all builder-eligible
// is not built at all. That is what makes "only approved results reach the PDF" true — the
// builder pairs whatever files it finds in the folder, so it cannot enforce the gate itself.
//
// A break at either seam is caught, named in plain language, and recorded against that order.
// The rest of the batch continues; one dead GPU job must not cost the other orders.
```

**"The review gate is a wall, not a step."** And the reason it must be enforced *here*: *"the builder
pairs whatever files it finds in the folder, so it cannot enforce the gate itself."* The builder is a
dumb client-side app (§5.7) that pairs by filename. It has no idea which pages were approved. So the
orchestrator must refuse to invoke it at all for an order that hasn't passed the gate — there is no
way to pass the gate *through* to the builder.

```js
// src/orchestrator.js:42-58
/** Per-order outcome. `held` means the operator has photos to review — not a failure. `ready` means
 *  all pages generated cleanly but the PDF was deliberately not built yet (a generate-only "Go" run) —
 *  the operator checks the pages, then presses "PDF" to build. */
export const ORDER_STATUS = Object.freeze({ DONE: 'done', HELD: 'held', FAILED: 'failed', READY: 'ready' });

/** Where an order's finished book lands — the tool's existing output name. Exported so the status
 *  board (src/studio.js) tells a built order from an unbuilt one by the same path the build wrote. */
export const pdfPathFor = (orderDir, orderId) => join(orderDir, `${orderId} Final.pdf`);

/** The PDF is stale the moment any verdict changes: state.json is rewritten by generation and
 *  by every review action, so its mtime is the order's "last decided" clock. */
function pdfIsCurrent(pdfPath, orderDir) {
  if (!existsSync(pdfPath)) return false;
  const state = manifestPath(orderDir);
  if (!existsSync(state)) return false;
  return statSync(pdfPath).mtimeMs >= statSync(state).mtimeMs;
}
```

**`ORDER_STATUS` — the per-run vocabulary:**

| status | meaning |
|---|---|
| `done` | the PDF is built (or was already current) |
| `held` | *"the operator has photos to review — **not a failure**"* — an intake hold, or a flagged photo |
| `ready` | every page generated cleanly, PDF deliberately not built (a generate-only "Go") |
| `failed` | a photo's generation died, or the build broke |

The `held` ≠ failure distinction runs all the way through: it is a *normal* outcome, the system
working as designed.

**`pdfPathFor` is exported so `studio.js` finds a built PDF by the same path the build wrote.** One
source of truth for the path — the board and the builder cannot disagree about where the book is.

**`pdfIsCurrent` — `state.json`'s mtime is the "last decided" clock.** *"The PDF is stale the moment
any verdict changes: state.json is rewritten by generation and by every review action."* This is an
elegant reuse: no separate PDF-version tracking, no hash. Every action that could change the book
already rewrites `state.json`. `pdf.mtime >= state.mtime` ⟺ the PDF reflects the current verdicts.

It also explains a guard elsewhere — `orchestrator.js:230-237` clears a stale intake block only `if
(getIntake(m))`, *"Guarded so a clean order with no stored block is never rewritten (its state.json
mtime is the PDF-cache clock; a needless bump reprints it)."* A gratuitous `writeManifest` would
invalidate every PDF on every poll.

#### `buildabilityProblem` — refusing to print the wrong folder

```js
// src/orchestrator.js:60-74
/** Refuse to print a folder that does not hold exactly this order's approved photos.
 *  Returns an operator-facing reason, or null when the folder is safe to build. */
export function buildabilityProblem(orderDir, bases) {
  const have = new Set(collectPairs(orderDir).map((p) => p.base));
  const missing = bases.filter((b) => !have.has(b));
  if (missing.length) {
    return `${missing.length} fotek nemá spárovanou omalovánku: ${missing.join(', ')}`;
  }
  const extra = [...have].filter((b) => !bases.includes(b));
  if (extra.length) {
    const shown = extra.slice(0, 3).join(', ') + (extra.length > 3 ? ', …' : '');
    return `the order folder holds ${extra.length} pair(s) that are not part of this order (${shown}) — they would be printed into the book`;
  }
  return null;
}
```

**Exactly this order's photos — both directions.** The builder prints *whatever it finds*, so:

- **`missing`** — a photo with no paired SVG would silently produce a shorter book.
- **`extra`** — *"they would be printed into the book"*. A stray pair in the folder (a leftover from
  a renamed order, a file the operator dropped in) becomes a page in a stranger's book. This is the
  worst-case privacy failure the system can produce, and it is one `existsSync`-free set difference
  away.

`collectPairs` is imported from the builder driver, so the check uses the **builder's own pairing
rules** rather than reimplementing them — if the builder would pair it, this sees it.

Returns a **reason string or null** rather than throwing: the caller turns it into a `FAILED` entry
and continues with the rest of the batch.

#### The safety-check-before-cache ordering bug

```js
// src/orchestrator.js:76-92
async function buildOrder({ orderId, orderDir, bases, dedication, mode, builder, config, force, onEvent }) {
  const pdfPath = pdfPathFor(orderDir, orderId);

  // Safety before caching: a folder that changed under the operator must not silently reuse
  // the PDF printed from what used to be in it.
  const problem = buildabilityProblem(orderDir, bases);
  if (problem) {
    const reason = `builder seam (load): ${problem}`;
    onEvent({ type: 'build-failed', orderId, reason });
    return { status: ORDER_STATUS.FAILED, pdfPath: null, reason };
  }

  if (!force && pdfIsCurrent(pdfPath, orderDir)) {
    onEvent({ type: 'build-skipped', orderId, pdfPath });
    return { status: ORDER_STATUS.DONE, pdfPath, reason: null };
  }
```

**This ordering is the bug fix, and it is easy to get backwards.** The "obvious" optimisation is to
check the cache first — why validate a folder you're not going to build? The comment answers:

> *"Safety before caching: a folder that changed under the operator must not silently reuse the PDF
> printed from what used to be in it."*

The failure mode: the folder changes (a photo is removed, a stray pair appears) **without** `state.json`
being rewritten. `pdfIsCurrent` returns true — the PDF is newer than `state.json`, because nothing
*decided* anything. Cache-first would return `DONE` with a PDF printed from **the folder's previous
contents**, and the operator would ship it. Safety-first catches the mismatch and fails loudly.

A performance micro-optimisation would reintroduce a silent wrong-book bug. Any rewrite must keep
this order.

The rest of `buildOrder`:

```js
// src/orchestrator.js:93-109
  try {
    onEvent({ type: 'build-start', orderId, photos: bases.length, dedication });
    // The per-order dedication beats any global default: the title page is customer text.
    const options = { ...(config.builder.pdf ?? {}), outPdfPath: pdfPath };
    // The per-order format (U9) beats the global builder mode: two orders in one burst can be
    // galerie and full-page, and neither should need a config edit between them.
    if (mode) options.mode = mode;
    if (dedication) options.dedication = dedication;
    const { pairs } = await builder.buildPdf(orderDir, options);
    onEvent({ type: 'build-done', orderId, pdfPath, pairs });
    return { status: ORDER_STATUS.DONE, pdfPath, reason: null };
  } catch (err) {
    const reason = describeFailure(err);
    onEvent({ type: 'build-failed', orderId, reason });
    return { status: ORDER_STATUS.FAILED, pdfPath: null, reason };
  }
}
```

**Per-order beats global, twice, for the same reason:** *"two orders in one burst can be galerie and
full-page, and neither should need a config edit between them."* The config is a *default*, not a
setting. Same for the dedication: *"the title page is customer text."*

`buildOrder` **never throws** — a build failure is a returned `FAILED` entry, so the batch continues.

#### `runPipeline` — the intake gate, and cooperative stopping

```js
// src/orchestrator.js:165-197
/** Run every order end to end. Never throws for a single order; returns a report.
 *
 *  `signal` is how the operator's Stop button reaches the loop. Stopping is cooperative and lands
 *  at an order or photo boundary: whatever is on the GPU finishes, then nothing new begins. Books
 *  already built stay built; an order left half-generated simply has pending photos, and the next
 *  Go continues it. */
export async function runPipeline({ config, inboxRoot, outboxRoot, generator, builder, qc, intake = assessIntake, onEvent = noop, force = false, only = null, buildPdfs = true, memoryRoot = MEMORY_DIR, signal }) {
  ...
  // Drivers are constructed once, lazily, so a generation-only run never needs Chromium and a
  // rebuild-only run never needs the generator token.
  let gen = generator ?? null;
  let build = builder ?? null;
```

**Lazy driver construction is a real ergonomic fix:** a generate-only run never needs Chromium
installed; a rebuild-only run never needs a RunPod token. `gen ??= createGeneratorDriver(config)` and
`build ??= new BuilderDriver(config)` at the point of first use.

```js
// src/orchestrator.js:200-237
    // Input QC before any GPU spend. A blocking problem — too few photos, a duplicate upload, a
    // file that will not open — holds the whole order and drafts a copy-paste email; nothing is
    // generated until the photos are put right. The verdict is re-derived here every run, so once
    // the customer sends a replacement the hold lifts on its own. `force` and an operator override
    // ("generate it anyway") clear it too.
    const intakeDir = join(outbox, orderId);
    const overridden = getIntakeOverride(readManifest(intakeDir));
    const intakeResult = await intake({ order, config, expected: resolveExpected(order) });
    onEvent({ type: 'intake', orderId, verdict: intakeResult.verdict, findings: intakeResult.findings, expected: intakeResult.expected, uploaded: intakeResult.uploaded });

    if (intakeResult.verdict === 'hold' && !overridden && !force) {
      mkdirSync(intakeDir, { recursive: true });
      const m = readManifest(intakeDir);
      setIntake(m, { ...intakeResult, checkedAt: new Date().toISOString(), override: false });
      writeManifest(intakeDir, m);
      const mail = draftEmailFor(intakeResult, order);
      if (mail) writeFileSync(join(intakeDir, 'draft-email.txt'), formatDraft(mail), 'utf8');
      const reason = `${intakeSummary(intakeResult)}${mail ? ' (e-mail připraven)' : ''}`;
      report.push({ orderId, orderDir: intakeDir, summary: null, held: [], failed: [], pdfPath: null, reason, status: ORDER_STATUS.HELD, titled: false });
      onEvent({ type: 'order-done', orderId, status: ORDER_STATUS.HELD, pdfPath: null, reason });
      continue;
    }

    // The hold lifted on its own: the customer's replacement made intake pass. Clear the stale
    // hold verdict and its draft email so a now-buildable order stops surfacing as held — both in
    // the review grid and on the status board. Guarded so a clean order with no stored block is
    // never rewritten (its state.json mtime is the PDF-cache clock; a needless bump reprints it).
    // An overridden/forced order whose intake still fails keeps its block: the override flag, not a
    // cleared verdict, is what releases that one.
    if (intakeResult.verdict !== 'hold' && existsSync(intakeDir)) {
      const m = readManifest(intakeDir);
      if (getIntake(m)) {
        clearIntake(m);
        writeManifest(intakeDir, m);
      }
      rmSync(join(intakeDir, 'draft-email.txt'), { force: true });
    }
```

**The intake gate's key property: the verdict is RE-DERIVED every run, never trusted from storage.**
*"so once the customer sends a replacement the hold lifts on its own."* The stored `intake` block is a
*record* of the last verdict for the UI, not the gate itself. That is what makes the KTD8 overnight
self-lift work: nothing has to notice the customer's re-upload; the next poll simply re-measures and
the hold evaporates.

**Three ways past a hold**, and they are different:
- The customer fixes the photos (the verdict changes — the hold lifts on its own).
- The operator overrides (`overridden` — the flag releases it, the verdict is unchanged).
- `force` (a deliberate operator bypass).

**The clear-stale-hold block's last sentence** is the precise distinction: *"An overridden/forced
order whose intake still fails keeps its block: the override flag, not a cleared verdict, is what
releases that one."* The condition is `intakeResult.verdict !== 'hold'` — i.e. the *fresh* verdict is
clean. An overridden order whose photos are still bad keeps its block on record (and its
`incompleteBook` flag), because the truth hasn't changed — only the operator's decision to proceed.

The dedication recovery block:

```js
// src/orchestrator.js:257-273
    // The customer's own words. Recover them once, for an order nobody has decided the title of
    // yet — never over an operator who has already answered, including one who answered by
    // emptying the box.
    if (!hasDedication(manifest)) {
      // Three places the words can come from, best first:
      //   the shop      — what the customer typed, accents and all, straight out of Shopify
      //   the memory    — a spelling the operator corrected once, on an earlier order
      //   the file name — the last resort, and the only one that cannot spell "Jiříčka"
      const fromShop = shopDedication(order.dir);
      const remembered = fromShop ? '' : recallDedication(memoryRoot, deriveSlug(bases));
      const derived = fromShop || remembered || deriveDedication(bases);
      if (derived) {
        setDedication(manifest, derived);
        writeManifest(orderDir, manifest);
        onEvent({ type: 'title-derived', orderId, dedication: derived, source: fromShop ? 'shop' : remembered ? 'memory' : 'filename' });
      }
    }
```

The same three-source cascade as `reviewState`, gated on `hasDedication` — *"never over an operator
who has already answered, including one who answered by emptying the box."*

The stop handling:

```js
// src/orchestrator.js:192-197, 313-314
    // The operator pressed Stop. Do not begin another order — the ones already done are the run.
    if (signal?.aborted) {
      stopped = true;
      break;
    }
  ...
  // The signal can trip during the last order too, where the top-of-loop check never runs again.
  stopped = stopped || Boolean(signal?.aborted);
```

The second check is a fixed off-by-one: if the operator stops during the final order, the top-of-loop
check never runs again, and the run would report as completed rather than stopped.

`formatEvent` (`orchestrator.js:329-369`) deserves one note: *"Shared by the CLI and the review
grid's run log, so both describe a run identically."* One renderer, two surfaces — the operator sees
the same words whichever they're looking at.

---

### 5.6 The no-send invariant

**The invariant:** *nothing automated ever sends a book to Jirka.* A book leaves for the printer only
when a human clicks "Odeslat Jirkovi". The overnight autopilot polls, downloads, generates, builds a
PDF — **and stops**.

What makes this worth documenting is *how* it is enforced. It is not a flag, not a config setting,
not an `if (autopilot) return` guard. It is **structural: by the absence of an import.**

#### 5.6.1 Where it is enforced — the absence of an import

```js
// src/autopilot.js:1-5
// The overnight autopilot's unattended entrypoint (KTD2/KTD3): poll the Shopify Admin API for new
// PAID photo orders, materialize them into the inbox, run the EXISTING pipeline over just those ids,
// and write a night report the morning dashboard reads. It adds a trigger — no generation or delivery
// logic of its own. The no-send invariant holds by construction: this module never imports or reaches
// a delivery/WhatsApp path, and it calls runPipeline with force:false, which produces the PDF and stops.
```

**"The no-send invariant holds by construction: this module never imports or reaches a
delivery/WhatsApp path."**

This is verifiable by reading the import block at the top of `src/autopilot.js:13-20`:

```js
// src/autopilot.js:13-20
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { runPipeline, ORDER_STATUS, formatEvent } from './orchestrator.js';
import { createAdminClient } from './shopify/adminClient.js';
import { extractOrder } from './shopify/orders.js';
import { materializeOrder } from './shopify/materialize.js';
import { loadState, saveState, isHandled, markHandled } from './autopilotState.js';
import { writeReport, reportPath } from './autopilotReport.js';
```

There is no `whatsappClient`, no `markDelivered`, no `deliveryCaption`. **The capability is not
present in the module's reachable graph.** `runPipeline` — the only thing autopilot calls that does
real work — likewise never imports a delivery path; it ends at `builder.buildPdf`.

This is a much stronger guarantee than a runtime check. A flag can be flipped by a config typo. A
guard can be bypassed by a new code path that forgets it. **An unimported module cannot be called.**
The autopilot *physically cannot* send, and the way to break the invariant is to add an import — a
visible, reviewable, one-line diff, not an accidental omission.

The reciprocal statement is on the send path (`ui/server.js:1169-1173`):

```js
// src/ui/server.js:1169-1173
// POST /api/<order>/deliver — the operator's explicit "Odeslat Jirkovi": send the finished
// <order> Final.pdf to Jirka's WhatsApp with the order number as caption, THEN mark it delivered.
// The order is written to 'sent' ONLY when the WhatsApp send resolves — a failed send leaves the
// order on the board with a visible error so the operator can retry. Sent regardless of payment.
// This is the sole point books leave for the printer; the overnight autopilot never reaches here.
```

**"This is the sole point books leave for the printer; the overnight autopilot never reaches here."**
One place, named, reachable only from an HTTP POST that a human triggers.

The single WhatsApp seam is constructed once, guarded (`ui/server.js:354-357`):

```js
// src/ui/server.js:354-357
  // The one WhatsApp seam: deliver the finished book to Jirka on the operator's explicit "Odeslat
  // Jirkovi" click. Built from config only when whatsapp is enabled (a caller/test may inject one);
  // null → the deliver action is refused with a clear message. The session links lazily on first use.
  const wa = waClient ?? (config?.whatsapp?.enabled ? createWhatsAppClient({ recipient: config.whatsapp.recipient, sessionDir: config.whatsapp.sessionDir, executablePath: config.whatsapp.executablePath }) : null);
```

`null` when unconfigured → *"the deliver action is refused with a clear message"* rather than
silently failing. And a test that constructs a server never connects to WhatsApp.

The second half of the invariant: `force: false`.

```js
// src/autopilot.js:100-105
  // Reuse the shipped pipeline unchanged, over just the new ids, with every guardrail (intake hold +
  // email draft, QC, review gate, resumable build). force:false means an already-built PDF is not
  // re-generated — the no-send invariant and the spend bound both come from this call, not a flag.
  const pipeline = newIds.length
    ? await runPipelineFn({ config, only: newIds, force: false, onEvent })
    : { orders: [], counts: { done: 0, held: 0, failed: 0 } };
```

*"the no-send invariant and the spend bound both come from this call, not a flag."* The autopilot
reuses the shipped pipeline **unchanged** — every guardrail (intake hold, QC, review gate, resumable
build) applies identically whether a human or the scheduler triggered it. There is no "autopilot
mode" with different rules. That is why there is no second code path to audit.

#### 5.6.2 Every guard that refuses an action

**`requireIdle()` — the manifest-clobber guard**

```js
// src/ui/server.js:447-452
  /** A run holds each order's manifest in memory and rewrites it after every photo. A verdict
   *  saved meanwhile would be silently overwritten, so verdicts are refused while a run is on. */
  const requireIdle = () => {
    if (run.active) throw new ReviewError('A run is in progress — wait for it to finish before changing anything.');
    if (autopilot.running) throw new ReviewError('Fetching orders is in progress — wait for it to finish before changing anything.');
  };
```

**The bug it prevents is a lost-update race, and it is specific:** `generateOrder` reads the manifest
**once** into memory and rewrites the whole object after every photo (`batch.js:124`, then
`writeManifest` in `generatePhoto`'s `finally`). If the operator approves a photo mid-run, `approve()`
does its own read-modify-write — and the run's next `writeManifest` writes its stale in-memory copy
over the top. **The approval vanishes silently.**

The lazy fix would be per-order or per-photo locking. The chosen fix is a **global refusal**: no
verdicts while a run is on. Correct for the actual usage (one operator, one machine), and impossible
to get subtly wrong.

`requireIdle()` guards the mutating endpoints — approve, reject, handoff, redo, dedication,
intake-override (`ui/server.js:1144`), etc.

**The run / autopilot / inFlight locks**

```js
// src/ui/server.js:332-340
  const inFlight = new Map(); // "order/base" -> { message }
  // `orderId` is the order the run is generating right now, so the board can tell 'generating' from
  // 'queued' — the review state alone shows both as all-null photo statuses.
  const run = { active: false, stopping: false, lines: [], report: null, error: null, orderId: null };
  // On-demand Shopify fetch (the "Načíst nové objednávky" button): runs the same autopilot as the
  // scheduled task — pull new paid orders, download photos, generate — but triggered by hand. Shares
  // the run-lock with the manual pipeline so the two can never generate over each other.
  const autopilot = { running: false, lines: [], report: null, error: null };
  let runController = null; // the live run's AbortController, or null between runs
```

```js
// src/ui/server.js:454-457
  function startRun({ inbox: requested, force, buildPdfs = true, only = null, silent = false }) {
    if (run.active) throw new ReviewError('A run is already going.');
    if (autopilot.running) throw new ReviewError('Fetching orders is in progress — wait for it to finish.');
    if (inFlight.size) throw new ReviewError('A photo is still being regenerated — wait for it to finish.');
```

**Three mutually-exclusive locks, checked in both directions:**

| lock | guards | why |
|---|---|---|
| `run.active` | the manual pipeline is generating | one shared GPU queue; one in-memory manifest per order |
| `autopilot.running` | the on-demand Shopify fetch is running | *"Shares the run-lock with the manual pipeline so the two can never generate over each other."* |
| `inFlight` (Map, `"order/base"`) | a single-photo redo is in progress | a redo also holds a manifest in memory |

`startRun` checks all three; `requireIdle` checks the first two. `inFlight` is per-photo (so the grid
can show *which* tile is busy — `forClient` at `server.js:169` reads
`inFlight.get(\`${o.orderId}/${p.base}\`)`), but `startRun` refuses on **any** entry, because a batch
run would collide with any redo.

The on-demand fetch button *is* the autopilot — *"runs the same autopilot as the scheduled task"* —
which is why it shares the lock rather than having its own. Same code, same guardrails, different
trigger.

**`run.orderId` exists for a reason worth noting:** *"so the board can tell 'generating' from
'queued' — the review state alone shows both as all-null photo statuses."* This is exactly the
"fact that `state.json` cannot see on its own" that `deriveOrderStatus` needs injected (§5.5.3).

**Deliver-only-marks-on-success**

```js
// src/ui/server.js:1174-1188
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 3 && parts[2] === 'deliver') {
        if (!wa) return json(res, 503, { error: 'WhatsApp odesílání není nastaveno.', code: 'not-configured' });
        const order = state().find((o) => o.orderId === parts[1]);
        if (!order) throw new ReviewError(`Unknown order "${parts[1]}".`);
        const pdfPath = pdfPathFor(order.orderDir, order.orderId);
        if (!existsSync(pdfPath)) return json(res, 409, { error: 'PDF ještě není hotové — nejdřív ho vytvořte.', code: 'no-pdf' });
        try {
          const sent = await wa.sendDocument({ filePath: pdfPath, caption: deliveryCaption(order.orderId) });
          const status = markDelivered(order.orderDir, { by: 'whatsapp', to: sent.to, messageId: sent.id }); // marks 'sent' — only reached on a successful send
          return json(res, 200, { status, sent: true, messageId: sent.id });
        } catch (err) {
          const code = err instanceof WhatsAppError ? err.code : 'unknown';
          return json(res, 502, { error: `Odeslání Jirkovi selhalo — ${err.message}`, code });
        }
      }
```

**`markDelivered` is INSIDE the try, AFTER the await.** *"The order is written to 'sent' ONLY when
the WhatsApp send resolves — a failed send leaves the order on the board with a visible error so the
operator can retry."*

The bug this prevents: mark-then-send (or mark-in-a-finally) would drop the order off the active
board while the book never actually reached Jirka. The order would look done, and **nobody would ever
notice**. The customer's book simply never gets printed.

The bias is deliberate and correct: **a false "not sent" costs one retry; a false "sent" loses a
book.** The one line of ordering encodes that.

Note the guard chain: `!wa` → 503 not-configured. Unknown order → error. **No PDF → 409 with `code:
'no-pdf'`.** You cannot deliver a book that doesn't exist.

**`/api/whatsapp/test` — sends without marking**

```js
// src/ui/server.js:1151-1167
      // POST /api/whatsapp/test — send a test document to confirm the link works end-to-end, WITHOUT
      // marking any order delivered. The server picks a built PDF (never a client-supplied path, so this
      // can't be used to exfiltrate an arbitrary file). Optional body { to } overrides the destination —
      // used to verify a group id ("…@g.us") before it's made the configured recipient.
```

Deliberately the inverse: it sends, and marks nothing. Two properties: **the server picks the PDF**
(*"never a client-supplied path, so this can't be used to exfiltrate an arbitrary file"* — a
path-traversal refusal by construction), and no `markDelivered` call, so testing the link cannot
accidentally retire an order from the board.

**The manual fallback — `/api/<order>/sent`**

```js
// src/ui/server.js:1190-1198
      // POST /api/<order>/sent — the operator confirms the finished book has gone to Jirka. Writes
      // the delivery marker so the order derives to 'sent' and drops off the active board. Manual
      // only: nothing here contacts anyone, it records that the operator already did (the fallback
      // when WhatsApp isn't linked and David sent the book by hand).
```

*"nothing here contacts anyone, it records that the operator already did."* The marker and the
sending are separate concerns — WhatsApp writes the same marker the operator would.

**The delete guard**

```js
// src/ui/server.js:1216-1223
      // POST /api/<order>/delete — remove an order from the board for good. Writes a hidden marker so it
      // stops showing (the folder + files stay on disk, recoverable by deleting the marker), and marks it
      // handled so the auto-fetch poll never re-materializes and regenerates it from Shopify. Refused
      // while that order is mid-generation, so a live run's folder isn't yanked out from under it.
      if (req.method === 'POST' && parts[0] === 'api' && parts.length === 3 && parts[2] === 'delete') {
        const order = state().find((o) => o.orderId === parts[1]);
        if (!order) return json(res, 404, { error: 'Unknown order.' });
        if (run.active && run.orderId === order.orderId) return json(res, 409, { error: 'Objednávka se právě generuje — počkejte, než doběhne.', code: 'busy' });
```

A **narrower** lock than `requireIdle` — only refused if *this specific order* is generating, because
deleting a different order is harmless. And "delete" writes a marker; the files stay, recoverable.
The `markHandled(..., { status: 'deleted' })` call is best-effort:

```js
// src/ui/server.js:1231
          } catch { /* best-effort — the hidden marker alone still keeps it off the board */ }
```

The comment names why the failure is tolerable: two independent mechanisms, and the primary one is
the marker.

**`unfilledPlaceholders()` — refusing a half-finished email**

```js
// src/proton/templates.js:65-71
/** The unfilled `[TOKEN]` placeholders left in some text — bracketed all-uppercase words like
 *  `[ČÍSLO]`, `[ODKAZ]`, `[POČET]`. The composer uses this to refuse sending a half-filled template
 *  (a placeholder is a sign the operator hasn't finished), while leaving ordinary text untouched. */
export function unfilledPlaceholders(...texts) {
  const found = texts.join('\n').match(/\[[\p{Lu}0-9 ]{2,}\]/gu) ?? [];
  return [...new Set(found)];
}
```

**The one guard on the outbound-email path.** The templates carry `[ČÍSLO]`, `[ODKAZ]`, `[POČET]`
placeholders; a placeholder in the composed text means the operator hasn't finished filling it in.
Sending it would mail a customer a literal `[ČÍSLO]`.

The regex is precisely scoped so it doesn't false-positive on ordinary Czech prose:
- `\p{Lu}` with the `u` flag — **Unicode uppercase**, so `[ČÍSLO]` and `[POČET]` match. An ASCII
  `[A-Z]` class would miss every Czech placeholder, which is the whole point.
- `{2,}` — at least two characters, so `[1]` or `[a]` in ordinary text is left alone.
- Uppercase + digits + space only — so `[see below]` is not a placeholder.

`new Set` dedups, so a token used three times is reported once. Returns the *list*, so the refusal
can name exactly what's still unfilled rather than saying "something's wrong".

#### 5.6.3 The shape of the invariant

Every refusal in this system follows the same pattern:

1. **Structural where possible** — the autopilot cannot send because the code isn't reachable.
2. **A named, actionable message where not** — *"wait for it to finish"*, *"PDF ještě není hotové —
   nejdřív ho vytvořte"*, *"napište 3 pro potvrzení"*.
3. **Biased toward refusing** — a false refusal costs a retry; a false permit loses a book, ships a
   short book, or mails a stranger a placeholder.
4. **Reversible when it does act** — every marker has an `unmark`.

---

### 5.7 Rendering / layout

Two rendering engines live here, and they share one principle: **the app places every element; the AI
never assembles anything.**

---

#### 5.7.1 `src/creatives/studio/templateModel.js` — the deterministic template model

```js
// src/creatives/studio/templateModel.js:1-14
// The deterministic template model (pure). A template is an ordered list of typed, boxed elements;
// the app — never the AI — places them. This module owns the geometry and the quality checks:
//   - resolveTemplate(template, format): merge each element's base box/style with its per-format
//     override, drop hidden elements, order back-to-front by layer.
//   - boxToPx: percent box (0..100 of the canvas) -> pixel box for a format.
//   - validateConcept: the QC pass — missing copy/asset, text overflow, logo too small, safe-zone
//     breaches -> findings + an overall status (pripraveno / varovani / nedokonceno).
//   - creativeFilename: the export naming scheme.
//
// Boxes are PERCENTAGES of the format canvas so a base layout already adapts across ratios; per-format
// overrides (element.formats[format]) handle the cases where a straight percentage would break
// hierarchy. No IO, no rendering — renderStudioHtml.js turns a resolved template into HTML.
```

**"the app — never the AI — places them."** The AI writes *words* (see `adCopy.js`). It never
decides where anything goes. Geometry is data in a template table, and this module is the pure
function that resolves it.

**Percentages + per-format overrides** is the layout strategy: a percentage box adapts across ratios
for free, and the override exists *"for the cases where a straight percentage would break
hierarchy"* — a headline that reads fine at 60% width on a square feed post becomes a wall of text at
60% of a story's narrow column.

```js
// src/creatives/studio/templateModel.js:16-25
export const ELEMENT_TYPES = Object.freeze(['background', 'panel', 'image', 'text', 'badge', 'cta', 'logo', 'decoration']);
export const IMAGE_SLOTS = Object.freeze(['original', 'coloring', 'lifestyle', 'product']);
/** Structured copy fields (the brief's copy model). A text/cta/badge element binds to one via `field`. */
export const COPY_FIELDS = Object.freeze(['headline', 'support', 'cta', 'badge', 'offer', 'deadline', 'testimonial', 'testimonialAuthor', 'legal']);
```

Eight element types, four image slots, nine copy fields. A template element declares a `type` (how it
renders), optionally a `slot` (which asset) or a `field` (which copy). The indirection is what lets
one copy object drive every template.

#### `resolveElement` — the merge precedence

```js
// src/creatives/studio/templateModel.js:27-38
/** Merge one element with its per-format override. Never mutates the input. */
export function resolveElement(el, format) {
  const o = (el.formats && el.formats[format]) || {};
  return {
    ...el,
    box: { ...el.box, ...(o.box || {}) },
    style: { ...(el.style || {}), ...(o.style || {}) },
    text: o.text ?? el.text,
    hidden: o.hidden ?? el.hidden ?? false,
    layer: o.layer ?? el.layer ?? 0,
  };
}
```

**The precedence rules are not uniform, and the difference is the design:**

| field | rule | why |
|---|---|---|
| `box` | **shallow merge**, override wins per-key | an override can nudge `y` alone and inherit `x`/`w`/`h` |
| `style` | **shallow merge**, override wins per-key | an override can change `fontSize` alone and keep colour, align, pill |
| `text` | **replace** (`??`) | text is atomic — half a string is meaningless |
| `hidden` | **replace**, default `false` | boolean |
| `layer` | **replace**, default `0` | a number |

The `box`/`style` merge is what makes the override table small: `{ story: { style: { fontSize: 48 } } }`
is a complete, valid override that changes exactly one property. A replace would force every override
to restate the whole style object, and the tables would drift.

`??` rather than `||` on `text`/`hidden`/`layer` — so an override of `text: ''`, `hidden: false`, or
`layer: 0` is honoured. `||` would silently fall back to the base for all three.

**Never mutates the input** — the template tables are module-level constants shared across every
render; mutating one would corrupt every subsequent request.

#### `resolveTemplate` — and why an unsupported format throws

```js
// src/creatives/studio/templateModel.js:40-51
/** All visible elements of a template for a format, back-to-front by layer. Throws if the template
 *  doesn't declare support for the format (a format change must be an intentional layout, not a guess). */
export function resolveTemplate(template, format) {
  if (!template || !Array.isArray(template.elements)) throw new Error('A template must have an elements array.');
  if (Array.isArray(template.supportedFormats) && !template.supportedFormats.includes(format)) {
    throw new Error(`Template "${template.id}" does not support format "${format}".`);
  }
  return template.elements
    .map((el) => resolveElement(el, format))
    .filter((el) => !el.hidden)
    .sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0));
}
```

**This is the one place in the rendering path that throws rather than degrading**, and the comment
says why: *"a format change must be an intentional layout, not a guess."*

Compare with §5.9's "a guess is never a hold": that principle governs *judging customer data*, where
a guess must never block. This is the opposite situation — an unsupported format would render a
*visibly broken ad* using percentages designed for a different aspect ratio. There is no safe
degradation. Better to refuse.

Order of operations: **resolve → filter hidden → sort by layer**. Hidden is filtered *after* resolve,
because an override can hide (or unhide) an element for one format only.

`Array.isArray(template.supportedFormats)` — a template with no `supportedFormats` supports
everything. Opt-in restriction.

#### `boxToPx`

```js
// src/creatives/studio/templateModel.js:53-62
/** Percent box {x,y,w,h in 0..100} -> integer pixel box for a format. */
export function boxToPx(box, format) {
  const F = formatDef(format);
  return {
    x: Math.round(((box?.x ?? 0) / 100) * F.w),
    y: Math.round(((box?.y ?? 0) / 100) * F.h),
    w: Math.round(((box?.w ?? 0) / 100) * F.w),
    h: Math.round(((box?.h ?? 0) / 100) * F.h),
  };
}
```

Integers — `Math.round`, not raw floats. Sub-pixel CSS positions cause seams and blurry edges in a
screenshot. Every `?? 0` means a partial box (`{ x: 10 }`) resolves rather than producing `NaN` and
an invisible element.

#### `textForElement`

```js
// src/creatives/studio/templateModel.js:64-68
/** The text a text-ish element shows: the campaign copy for its `field`, else its literal `text`. */
export function textForElement(el, copy = {}) {
  if (el.field && copy[el.field] != null && copy[el.field] !== '') return String(copy[el.field]);
  return el.text != null ? String(el.text) : '';
}
```

**Campaign copy beats the literal, but only when non-empty.** The `!== ''` check means an empty copy
field falls back to the template's literal, not to blank — so a partially-filled copy object still
renders a coherent ad.

#### `estimateLines` — and the 0.52 glyph ratio

```js
// src/creatives/studio/templateModel.js:70-91
/** Rough line estimate: chars that fit per line ≈ box width / (fontSize * average glyph ratio).
 *  Approximate on purpose — it drives a soft overflow WARNING, never a hard block. */
export function estimateLines(text, el, format) {
  const px = boxToPx(el.box, format);
  const fontSize = el.style?.fontSize ?? 40;
  const glyph = fontSize * 0.52; // average advance width for the rounded display face
  const perLine = Math.max(1, Math.floor(px.w / glyph));
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  let lines = 1;
  let len = 0;
  for (const w of words) {
    const add = (len ? 1 : 0) + w.length;
    if (len + add > perLine && len > 0) {
      lines += 1;
      len = w.length;
    } else {
      len += add;
    }
  }
  return lines;
}
```

**`0.52` is the average advance width for the rounded display face**, as a fraction of the font size.
It is an empirical constant for the brand's typeface (Fredoka / Baloo 2 / a rounded system fallback),
not a universal number — a condensed face would be ~0.45, a wide slab ~0.62.

**"Approximate on purpose — it drives a soft overflow WARNING, never a hard block."** This is the
justification for a text-metrics approximation that would otherwise be indefensible. The exact
answer requires laying the text out in the actual font, which means Chromium, which means this module
stops being pure and stops being unit-testable. The trade is explicit: an approximate measure driving
a warning the operator can ignore.

The greedy word-wrap simulation is correct enough to be useful: `add = (len ? 1 : 0) + w.length`
counts the space *before* a word only when the line isn't empty. `len > 0` on the wrap condition
means a single word longer than `perLine` doesn't produce an infinite loop or a spurious extra line —
it just overflows its line, which is what a browser does too.

`Math.max(1, ...)` on `perLine` — a box narrower than one glyph still yields 1 char/line instead of a
division-by-zero cascade.

#### `validateConcept` — the full rule table

```js
// src/creatives/studio/templateModel.js:93-143
/** The QC pass over one concept-in-a-format. Returns { status, findings }. Findings carry a
 *  severity ('error'|'warn'), the offending elementId (so a warning is clickable), a code and a
 *  Czech message. Errors → 'nedokonceno', warnings only → 'varovani', clean → 'pripraveno'. */
export function validateConcept({ template, format, copy = {}, assets = {} } = {}) {
  const F = formatDef(format);
  const findings = [];
  const add = (severity, elementId, code, message) => findings.push({ severity, elementId, code, message });

  const elements = resolveTemplate(template, format);
  let hasCta = false;

  for (const el of elements) {
    const px = boxToPx(el.box, format);
    const c = el.constraints || {};

    if (el.type === 'text' || el.type === 'cta' || el.type === 'badge') {
      if (el.type === 'cta') hasCta = true;
      const text = textForElement(el, copy);
      const trimmed = text.trim();
      if (c.required && !trimmed) {
        add('error', el.id, 'missing-copy', `Chybí ${fieldLabel(el.field)}.`);
      }
      if (c.maxChars && trimmed.length > c.maxChars) {
        add('warn', el.id, 'overflow-chars', `Text „${fieldLabel(el.field)}" má ${trimmed.length} znaků (limit ${c.maxChars}).`);
      }
      if (c.maxLines && trimmed && estimateLines(trimmed, el, format) > c.maxLines) {
        add('warn', el.id, 'overflow-lines', `Text „${fieldLabel(el.field)}" se nevejde na ${c.maxLines} řádky.`);
      }
      if (!c.allowBleed && trimmed && (px.x < F.safe || px.y < F.safe || px.x + px.w > F.w - F.safe || px.y + px.h > F.h - F.safe)) {
        add('warn', el.id, 'safe-zone', `Prvek „${fieldLabel(el.field)}" zasahuje do okraje (bezpečná zóna ${F.safe}px).`);
      }
    }

    if (el.type === 'image') {
      const src = assets[el.slot];
      if (c.required && !src) add('error', el.id, 'missing-asset', `Chybí obrázek: ${slotLabel(el.slot)}.`);
    }

    if (el.type === 'logo') {
      const minW = c.minW != null ? (c.minW / 100) * F.w : 96;
      if (px.w < minW) add('warn', el.id, 'logo-small', `Logo je menší než ${Math.round(minW)}px — hůř čitelné.`);
      if (px.x < F.safe || px.x + px.w > F.w - F.safe) add('warn', el.id, 'logo-safe', 'Logo zasahuje do okraje.');
    }
  }

  // A template that declares it needs a CTA but resolves without one (all hidden) is incomplete.
  if (template.requiresCta && !hasCta) add('warn', null, 'missing-cta', 'Kreativa nemá výzvu k akci (CTA).');

  const status = findings.some((f) => f.severity === 'error') ? 'nedokonceno' : findings.some((f) => f.severity === 'warn') ? 'varovani' : 'pripraveno';
  return { status, findings };
}
```

**The full rule table:**

| element types | rule | condition | severity | code |
|---|---|---|---|---|
| text / cta / badge | required copy present | `c.required && !trimmed` | **error** | `missing-copy` |
| text / cta / badge | char limit | `trimmed.length > c.maxChars` | warn | `overflow-chars` |
| text / cta / badge | line limit | `estimateLines(...) > c.maxLines` | warn | `overflow-lines` |
| text / cta / badge | safe zone | any edge within `F.safe`, unless `c.allowBleed` | warn | `safe-zone` |
| image | required asset present | `c.required && !src` | **error** | `missing-asset` |
| logo | minimum width | `px.w < (c.minW% of F.w, default 96px)` | warn | `logo-small` |
| logo | horizontal safe zone | `px.x < F.safe \|\| px.x + px.w > F.w - F.safe` | warn | `logo-safe` |
| template | declares `requiresCta` but resolves without one | `template.requiresCta && !hasCta` | warn | `missing-cta` |

**Errors vs warnings — the line is drawn precisely at "is something missing":**

- **error** (`nedokonceno`, "unfinished") — required copy or a required asset is **absent**. The ad
  cannot be exported; there is literally a hole in it.
- **warn** (`varovani`) — everything measured or estimated: overflow, safe zone, logo size. The ad is
  complete and exportable; it might look wrong. **The operator decides.**

Every measured/estimated rule is a warning, because every measurement here is approximate
(`estimateLines`) or a house rule (safe zone, min logo width) rather than a fact. Only *absence* is a
fact, and only absence blocks.

Other details:

- **`elementId` on every finding** — *"so a warning is clickable"*. The UI can jump to the offending
  element.
- **`trimmed` everywhere** — whitespace-only copy is missing copy.
- **The safe-zone check is skipped for empty text** (`&& trimmed`) — an empty box's position is
  irrelevant.
- **`allowBleed`** — an opt-out for elements *designed* to run off the edge (a background, a
  decoration).
- **The logo safe zone checks x only**, not y. A logo at the very top or bottom is a normal placement;
  a logo running off the left or right is a mistake.
- **`minW` default 96px** absolute, or a percentage of the canvas when the constraint sets it — so a
  logo scales its minimum with the format.
- **`missing-cta` is a warn, not an error**, even though it's an absence — because the CTA element
  might legitimately be hidden for one format, and `requiresCta` is a soft declaration.
- **`status` is the max severity** — same rank-rollup shape as `worstVerdict` (§5.3).
- Statuses are **accent-free Czech identifiers** (`pripraveno`, `varovani`, `nedokonceno`) so they're
  safe as data keys, while the *messages* carry full Czech with diacritics.

#### `slugify` and `creativeFilename`

```js
// src/creatives/studio/templateModel.js:145-161
/** Accent-folding slug for filenames: "Vánoce" -> "vanoce", "Emotivní dárek" -> "emotivni-darek". */
export function slugify(s) {
  return (
    String(s ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'x'
  );
}

/** Export filename, e.g. fotomalovanky_vanoce_emotivni-darek_feed_01.png. */
export function creativeFilename({ occasion = '', angle = '', format = 'feed', index = 1, ext = 'png' } = {}) {
  const nn = String(Math.max(1, Math.floor(index))).padStart(2, '0');
  return `fotomalovanky_${slugify(occasion)}_${slugify(angle)}_${slugify(format)}_${nn}.${ext}`;
}
```

**`slugify` is the standard NFD accent-fold**, and it matters here because the whole product is
Czech: `Vánoce` → `vanoce`, `Emotivní dárek` → `emotivni-darek`. `normalize('NFD')` decomposes
`á` into `a` + combining acute, then the combining-diacritics range is stripped. Everything
non-alphanumeric collapses to `-`, leading/trailing dashes are trimmed.

**The `|| 'x'` fallback** is the guard that matters: a string of *only* accents/punctuation would
slugify to `''`, and `creativeFilename` would emit `fotomalovanky__feed_01.png` — a filename that
collides with every other empty-slug export. `'x'` is ugly on purpose; it's a visible placeholder,
not a silent collision.

`creativeFilename` is a fixed scheme —
`fotomalovanky_<occasion>_<angle>_<format>_<NN>.<ext>` — sortable and self-describing in a folder.
`padStart(2, '0')` so `10` sorts after `09`. `Math.max(1, Math.floor(index))` clamps a bad index
rather than producing `NaN` or `00`.

---

#### 5.7.2 `src/creatives/studio/renderStudioHtml.js` — the layered renderer

```js
// src/creatives/studio/renderStudioHtml.js:1-8
// The deterministic layered renderer (pure): a template + a format + the campaign copy + the chosen
// assets -> ONE self-contained HTML document. renderCreative.js screenshots it to PNG with the same
// headless Chromium the PDF builder uses, so the on-screen preview and the exported file are the same
// pixels. The app places every element from the template's geometry; the AI never assembles the ad.
//
// No IO, no network: images arrive as ready `src` strings (data: URIs or file URLs), the logo as a
// data URI in `brand.logoSrc`. Fonts follow the app's rounded display stack (Fredoka not self-hosted
// yet — a known limitation; Chromium falls back to a rounded system face, identical preview<->export).
```

**"the on-screen preview and the exported file are the same pixels."** The preview is the same HTML
the exporter screenshots, rendered in the same engine. There is no second layout path to keep in sync
— the classic source of "it looked right in the editor" bugs.

**"No IO, no network"** — images arrive as ready `src` strings. The renderer is a pure
string-producing function; `renderCreative.js` is the only seam that touches Playwright and the
filesystem.

**A known limitation, honestly stated:** Fredoka is not self-hosted, so Chromium falls back to a
rounded system face. The mitigation is that the fallback is *identical* in preview and export, so
what the operator approves is what ships. (This also explains the `0.52` glyph ratio being
approximate — the actual face isn't pinned.)

#### The element dispatch

```js
// src/creatives/studio/renderStudioHtml.js:40-51
export function renderStudioHtml({ template, format = 'feed', copy = {}, assets = {}, brand = {} } = {}) {
  const F = formatDef(format);
  const theme = themeDef(template.theme);
  const accent = brand.accent ?? theme.accent;
  const elements = resolveTemplate(template, format);

  const layers = elements
    .map((el, i) => {
      const px = boxToPx(el.box, format);
      const rot = el.style?.rotate ? `transform:rotate(${el.style.rotate}deg);` : '';
      const base = `position:absolute;left:${px.x}px;top:${px.y}px;width:${px.w}px;height:${px.h}px;z-index:${i + 1};${rot}`;
```

Every element is `position:absolute` with its box in pixels. **The whole layout is one flat
absolutely-positioned stack** — no flow, no document order dependency, no cascade surprises. The
template's geometry is the layout, completely.

#### The `z-index: i + 1` detail

```js
const base = `position:absolute;left:${px.x}px;top:${px.y}px;width:${px.w}px;height:${px.h}px;z-index:${i + 1};${rot}`;
```

**`i` is the array index *after* `resolveTemplate` has sorted by `layer`.** So:

- **`i + 1`, not `el.layer`.** The template's `layer` values are sparse and arbitrary (the tables use
  0, 10, 20…) — they exist to express *relative* order, and templates can share a layer number.
  Using them directly as z-index would let two elements tie, and the tie-break would be document
  order, which is a different sort. Re-indexing to a dense `1, 2, 3…` sequence makes stacking
  **exactly** the resolved order, with no ties possible.
- **`+ 1`, not `i`.** The first element would get `z-index: 0`, which does **not** create a stacking
  context the way a positive value does and can be overlapped by a positioned sibling with no
  z-index. Starting at 1 puts every element unambiguously in the stack.

This is the detail that makes the whole "back-to-front by layer" contract actually hold in the
browser. `resolveTemplate` sorts; the renderer's job is to not lose that sort — and `i + 1` is how.

Note the background element ignores `base`'s geometry entirely but **keeps the same z-index**:

```js
// src/creatives/studio/renderStudioHtml.js:52-55
      if (el.type === 'background') {
        const fill = el.style?.fill ?? theme.bg;
        return `<div style="position:absolute;inset:0;z-index:${i + 1};background:${fill}"></div>`;
      }
```

`inset: 0` — full bleed, ignoring the box, because a background *is* the canvas. But it still takes
its place in the stack, so a template can legitimately put a background *above* something.

#### The per-type dispatch, and the style defaults

Every branch follows the same shape: pull `el.style || {}`, apply the template's value or a
brand-sensible default. The defaults are the house style encoded in code:

```js
// src/creatives/studio/renderStudioHtml.js:57-60
      if (el.type === 'panel') {
        const s = el.style || {};
        return `<div style="${base}background:${s.fill ?? '#fff'};border-radius:${s.radius ?? 30}px;box-shadow:${s.shadow ?? '0 26px 64px rgba(150,95,60,.20)'};${s.border ? `border:${s.border};` : ''}"></div>`;
      }
```

```js
// src/creatives/studio/renderStudioHtml.js:62-69
      if (el.type === 'image') {
        const s = el.style || {};
        const frame = s.frame
          ? `background:#fff;padding:${s.pad ?? 16}px;border-radius:${s.radius ?? 26}px;box-shadow:${s.shadow ?? '0 24px 60px rgba(150,95,60,.20)'};`
          : `border-radius:${s.radius ?? 0}px;overflow:hidden;`;
        const border = s.border ? `border:${s.border};` : '';
        return `<div style="${base}${frame}${border}box-sizing:border-box"><div style="width:100%;height:100%;overflow:hidden;border-radius:${(el.style?.innerRadius ?? el.style?.radius ?? 14)}px">${renderImage(el, assets, px)}</div></div>`;
      }
```

The image is **two nested divs**: the outer carries the frame (white padding + shadow, the polaroid
look), the inner clips the image with its own radius. `box-sizing: border-box` so the padding doesn't
grow the element past its box. The `innerRadius ?? radius ?? 14` cascade lets a template set both
radii independently or share one.

The shadow colour `rgba(150,95,60,.20)` is a warm brown, not black — the brand's shadows are tinted.
That is a design decision living as a default in three places.

```js
// src/creatives/studio/renderStudioHtml.js:71-81
      if (el.type === 'text') {
        const s = el.style || {};
        const pill = s.pill ? `background:${s.pillColor ?? '#fff'};border-radius:${s.radius ?? 30}px;box-shadow:${s.shadow ?? '0 18px 44px rgba(150,95,60,.16)'};` : '';
        const pad = s.pad ?? (s.pill ? 26 : 0);
        const align = s.align ?? 'center';
        const justify = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
        const valign = s.valign === 'top' ? 'flex-start' : s.valign === 'bottom' ? 'flex-end' : 'center';
        return `<div style="${base}display:flex;align-items:${valign};justify-content:${justify}">
          <div style="${pill}padding:${pad}px;text-align:${align};font-size:${s.fontSize ?? 44}px;font-weight:${s.fontWeight ?? 600};line-height:${s.lineHeight ?? 1.12};color:${s.color ?? BRAND.ink};max-width:100%">${renderText(el, copy, accent)}</div>
        </div>`;
      }
```

Text is a **flex container + an inner block**, so the text is centred (or aligned) *within its box*
in both axes without knowing its own height. `pad ?? (s.pill ? 26 : 0)` — a pill needs internal
padding to look like a pill; bare text doesn't. `max-width: 100%` keeps the inner block inside the
box.

```js
// src/creatives/studio/renderStudioHtml.js:83-100
      if (el.type === 'cta') {
        const s = el.style || {};
        const text = textForElement(el, copy);
        if (!text.trim()) return '';
        ...
      }

      if (el.type === 'badge') {
        const s = el.style || {};
        const text = textForElement(el, copy);
        if (!text.trim()) return '';
        return `<div style="${base}display:flex;align-items:center;justify-content:center;text-align:center">
          ${starburst()}
          <span style="position:relative;font-weight:600;font-size:${s.fontSize ?? 19}px;line-height:1.14;padding:0 ${s.pad ?? 30}px;color:${BRAND.ink}">${esc(text)}</span>
        </div>`;
      }
```

**`if (!text.trim()) return '';` on `cta` and `badge`, but NOT on `text`.** This is a deliberate
asymmetry:

- A CTA or badge with no text renders **nothing** — an empty coloured pill or a floating starburst
  with no words on it is a visible defect. Absent is better than empty.
- A plain `text` element with no text renders an empty div — invisible, harmless, and it keeps the
  layout stack intact.

`validateConcept` separately warns/errors about the missing copy; the renderer just doesn't draw
garbage.

The badge's `starburst()` is behind the text (`position: relative` on the span lifts it above the SVG
in document order without another z-index).

```js
// src/creatives/studio/renderStudioHtml.js:102-114
      if (el.type === 'logo') {
        const inner = brand.logoSrc
          ? `<img src="${esc(brand.logoSrc)}" alt="Fotomalovánky" style="width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 3px 0 rgba(255,255,255,.55))">`
          : `<div style="display:flex;flex-direction:column;align-items:${el.style?.align ?? 'center'};gap:10px;height:100%;justify-content:center">
              <div style="width:38%">${logoMark()}</div>
              <div style="font-weight:600;letter-spacing:.5px;font-size:${el.style?.fontSize ?? 46}px;line-height:1;text-shadow:0 2px 0 rgba(255,255,255,.55)">${wordmark()}</div>
            </div>`;
        return `<div style="${base}">${inner}</div>`;
      }

      if (el.type === 'decoration') {
        return `<div style="${base}pointer-events:none">${decoration(el.name, el.color ?? accent)}</div>`;
      }

      return '';
```

The logo has a **drawn fallback** (`logoMark()` + `wordmark()`) when no real logo data-URI is
supplied, so a render never shows a broken image. `object-fit: contain` so the real logo never
distorts. The white drop-shadow/text-shadow is the brand's "sticker" lift, keeping the logo legible
on a busy background.

**The final `return ''`** — an unknown element type renders nothing rather than throwing. A template
with a typo'd type produces an ad missing one element, not a 500.

#### The `.hi` highlight gradient

```js
// src/creatives/studio/renderStudioHtml.js:31-36
function renderText(el, copy, accent) {
  const text = textForElement(el, copy);
  const hi = el.hiField && copy[el.hiField] ? esc(copy[el.hiField]) : el.hi ? esc(el.hi) : '';
  const body = hi ? `${esc(text)} <span class="hi">${hi}</span>` : esc(text);
  return body;
}
```

```js
// src/creatives/studio/renderStudioHtml.js:125
  .hi{color:${accent};background:linear-gradient(180deg,transparent 56%,${accent}30 56%,${accent}30 94%,transparent 94%);border-radius:4px;padding:0 .1em;white-space:nowrap}
```

**The highlighter-pen effect, done in one gradient.** Unpacking it:

- `linear-gradient(180deg, ...)` — top to bottom.
- `transparent 56%` → `${accent}30 56%` — a **hard stop** at 56%: nothing above, colour below. Two
  stops at the same position means no blend, a crisp edge.
- `${accent}30` — the accent colour at **hex alpha `30`** ≈ 19% opacity. Translucent, so it reads as
  a marker stroke over the text rather than a solid block behind it.
- `${accent}30 94%` → `transparent 94%` — another hard stop; the band ends.

So the band covers **56%→94% of the line box** — starting below the cap height, ending just above the
baseline's descender space. That is where a real highlighter would land: through the lower two-thirds
of the letters, not centred, not full-height. Getting this to look hand-drawn rather than like a
`background-color` is the whole trick.

- `color: ${accent}` — the highlighted word is *also* in the accent colour, so it works even if the
  band is subtle.
- `white-space: nowrap` — **the highlighted phrase never breaks across lines.** A highlighter stroke
  split across two lines looks like a bug. This is the constraint that makes the effect safe to apply
  to arbitrary copy.
- `padding: 0 .1em` — the band extends slightly past the word, like a real stroke overshooting.
- `border-radius: 4px` — softened ends.

The two-source `hi` resolution (`el.hiField && copy[el.hiField]`, else the literal `el.hi`) mirrors
`textForElement`: campaign copy can supply the highlighted word (`headlineHi`), or the template can
hard-code it.

#### The placeholder

```js
// src/creatives/studio/renderStudioHtml.js:14-19
/** A labelled placeholder for an empty image slot, so an unfinished concept reads clearly rather
 *  than showing a broken image. */
function placeholder(label, kind) {
  const bg = kind === 'coloring' ? '#fff' : 'repeating-linear-gradient(45deg,#F3ECE4,#F3ECE4 14px,#EDE3D8 14px,#EDE3D8 28px)';
  return `<div class="ph" style="background:${bg}"><span>${esc(label)}</span></div>`;
}
```

```js
// src/creatives/studio/renderStudioHtml.js:126-127
  .ph{width:100%;height:100%;display:flex;align-items:flex-end;justify-content:center;padding-bottom:18px;
    font-size:16px;font-weight:600;color:#B8A99A;text-transform:uppercase;letter-spacing:.06em}
```

**"so an unfinished concept reads clearly rather than showing a broken image."** An empty slot is a
normal state during composition, not an error. The placeholder is:

- **Labelled** with the slot's Czech name (`slotLabel`: `původní fotka`, `omalovánka`, `lifestyle
  fotka`, `produkt`) — so the operator knows *which* asset is missing.
- **Branded** — a 45° diagonal stripe in the brand's warm neutrals (`#F3ECE4` / `#EDE3D8`), not a
  grey box. An unfinished concept still looks like the product.
- **Special-cased for `coloring`** — plain white, because a coloring page *is* white paper. A striped
  placeholder there would misrepresent what goes in the slot.
- Label at the **bottom** (`align-items: flex-end`), small, uppercase, low-contrast — present but not
  competing with the composition.

```js
// src/creatives/studio/renderStudioHtml.js:21-29
function renderImage(el, assets, px) {
  const src = assets[el.slot];
  const fit = el.style?.fit ?? 'cover';
  const focus = el.style?.focus ?? 'center';
  const inner = src
    ? `<img src="${esc(src)}" alt="" style="width:100%;height:100%;object-fit:${esc(fit)};object-position:${esc(focus)};display:block">`
    : placeholder(el.placeholder ?? el.slot, el.slot);
  return inner;
}
```

`object-fit: cover` + `object-position` (default `center`) — the template controls the crop focus per
element. `display: block` kills the inline-image baseline gap. `alt=""` — decorative; the output is a
PNG, there is no accessibility tree to serve.

#### Escaping

```js
// src/creatives/studio/brandKit.js:37-39
export function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
```

Four characters: `&`, `<`, `>`, `"`. **`&` is replaced first by virtue of being in the same pass** — a
single `.replace` with a character class cannot double-escape, whereas four chained `.replace` calls
starting with `&` would turn `<` into `&amp;lt;`. This is the classic escaping bug, avoided by
construction.

`"` is escaped because **every value here goes into a `style="..."` or `src="..."` attribute** — this
is an attribute-context escaper, not just a text-context one. `'` is absent, which is safe *given*
the codebase's invariant that every attribute is double-quoted.

`String(s ?? '')` — `null`/`undefined` become empty, never the strings `"null"`/`"undefined"`.

**Where `esc` is applied is the interesting part.** It wraps every **untrusted** value: `src` strings,
all text (`esc(text)`), the `hi` fragment, the `fit`/`focus` style values, the logo `src`, the
placeholder label. It is *not* applied to template-supplied style values (`s.fill`, `s.shadow`,
`s.radius`, `s.border`, `s.pad`) — those come from the module's own frozen template tables, which are
code, not input. The trust boundary is drawn at "did this come from outside the repo": copy (from the
AI or the operator) and assets (from uploads) are escaped; the template tables are not.

Note `wordmark()` (`brandKit.js:42-44`) also runs each character through `esc` — belt and braces on a
constant string.

#### The document shell

```js
// src/creatives/studio/renderStudioHtml.js:120-132
  return `<!doctype html><html lang="cs"><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${F.w}px;height:${F.h}px;overflow:hidden}
  .stage{position:relative;width:${F.w}px;height:${F.h}px;overflow:hidden;background:${theme.bg};
    font-family:"Fredoka","Baloo 2",ui-rounded,"Segoe UI",system-ui,sans-serif;color:${BRAND.ink}}
  .hi{...}
  .ph{...}
</style></head><body>
  <div class="stage">
    ${layers}
  </div>
</body></html>`;
```

`html, body` sized **exactly** to the format and `overflow: hidden` — the screenshot clip and the
document are the same rectangle, so nothing can scroll or bleed. `.stage` is
`position: relative`, which is what every `position: absolute` layer is positioned against. The font
stack degrades: Fredoka → Baloo 2 → `ui-rounded` → Segoe UI → system-ui → sans-serif — always
something rounded.

---

#### 5.7.3 `src/creatives/renderCreative.js` — the one Playwright seam

```js
// src/creatives/renderCreative.js:1-4
// Render a creative's HTML to PNG with the same headless Chromium the PDF builder uses
// (src/builder/builderDriver.js). The HTML is produced by the Creative Studio's layered renderer
// (src/creatives/studio/renderStudioHtml.js); this is the one seam that touches Playwright and the
// filesystem, so it stays thin and injectable for tests.
```

```js
// src/creatives/renderCreative.js:9-36
export class CreativeRenderError extends Error {}

/** Render one creative's HTML to a PNG, sized exactly to the format. With `outPath` it writes the
 *  file and returns the path; without it, it returns the PNG bytes as a Buffer (for streaming a
 *  download straight to the browser). `launcher` returns a Playwright browser; it defaults to
 *  headless Chromium and is overridden in tests. */
export async function renderCreativePng({ html, width, height, outPath, launcher }) {
  const launch = launcher ?? (async () => (await import('playwright')).chromium.launch());
  let browser;
  try {
    browser = await launch();
  } catch (err) {
    throw new CreativeRenderError(`Could not launch the headless browser — run "npx playwright install chromium" once. (${err.message})`);
  }
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle' });
    const clip = { x: 0, y: 0, width, height };
    if (outPath) {
      await mkdir(dirname(outPath), { recursive: true });
      await page.screenshot({ path: outPath, clip });
      return outPath;
    }
    return await page.screenshot({ clip });
  } finally {
    await browser.close();
  }
}
```

The whole file is 36 lines, and every line is a decision:

- **Lazy `await import('playwright')`** — importing this module doesn't require the browser binary.
  Same pattern as `builderDriver.js`.
- **`launcher` injectable** — a test drives the whole path with a fake browser, no binary needed.
- **The launch failure is caught separately** from the render, with the exact fix in the message:
  *"run `npx playwright install chromium` once"*. This is the single most common first-run failure,
  and the error tells you how to fix it rather than surfacing a Playwright stack.
- **`viewport` = the format, `deviceScaleFactor: 1`, `clip` = the same rectangle.** Three independent
  statements of the same size — the viewport sizes the layout, the clip bounds the capture. Belt and
  braces so a stray pixel of scrollbar or overflow can never enter the PNG.
- **`waitUntil: 'networkidle'`** — data: URIs decode synchronously but `<img>` elements still need a
  tick; networkidle is the safe wait for a page whose only "network" is inline data.
- **Two return modes:** `outPath` → write and return the path; no `outPath` → return the Buffer *"for
  streaming a download straight to the browser"*. The download endpoint never touches a temp file.
- **`browser.close()` in `finally`** — a leaked Chromium on a failed render would accumulate until
  the machine died.

---

#### 5.7.4 `src/builder/builderDriver.js` — driving a client-side app

#### The U5 spike finding

```js
// src/builder/builderDriver.js:4-14
// Drives the print builder (fotomalovanky-service). The U5 spike found the builder is a
// CLIENT-SIDE app (no HTTP API): a webkitdirectory folder input pairs "<base>.jpg/.jpeg/.png"
// with "<base>.svg" (it ignores "_bw.png"), lays them out under an "@media print / @page A4"
// stylesheet, and exports by calling window.print(). So the driver loads the folder with
// Playwright and renders the PDF via headless Chromium's print pipeline (page.pdf(), which
// uses print media by default) — reproducing the builder's exact output without the print
// dialog. See docs/spikes/2026-07-09-u5-builder.md.
//
// Playwright is imported lazily inside buildPdf so importing this module stays cheap and
// doesn't require the browser binary until an actual build runs.
```

**The finding, and why it shaped everything:** the builder — the operator's existing, trusted,
already-in-production tool — **has no HTTP API**. It is a client-side web app. The book is produced
by a human picking a folder, clicking some buttons, and hitting Print.

That rules out the obvious integrations (POST some JSON, get a PDF) and leaves exactly one option:
**drive the app the way a human does, in a headless browser.** Hence Playwright.

**The key insight that makes it work:** the builder exports via `window.print()` under an
`@media print` / `@page A4` stylesheet. Playwright's `page.pdf()` **uses print media by default** —
so it reproduces *the builder's exact output* without ever opening a print dialog. Not a
reimplementation of the layout: the same code, the same stylesheet, the same engine. The book the
tool produces is byte-for-byte the book the operator's manual routine produced.

This is why the whole system is built around a browser automation rather than a layout library. The
alternative — reimplementing the builder's layout in code — would have produced a *different* book,
and the operator's proven output is the spec.

Evidence: `docs/spikes/2026-07-09-u5-builder.md`.

#### `collectPairs` — and the `_bw` ordering trap

```js
// src/builder/builderDriver.js:29-37
// An original may be .jpg/.jpeg or .png: customer uploads are usually JPEG, but the
// generator echoes back whatever was uploaded, and the reference orders in the operator's
// fixture pack are PNG throughout. The live builder pairs those PNGs happily.
const PHOTO = /\.(jpe?g|png)$/i;
// "<base>_bw.png" is the generator's raster line-art, NOT an input photo. It must be
// skipped before PHOTO is applied, or it registers as a photo with base "<base>_bw".
const COLORING_PNG = /_bw\.png$/i;
const SVG = /\.svg$/i;
const svgBase = (n) => n.replace(/_bw\.svg$/i, '').replace(/\.svg$/i, '');
```

```js
// src/builder/builderDriver.js:67-80
/** Find the builder's photo+SVG pairs in an order folder (mirrors its own pairing rules). */
export function collectPairs(orderDir) {
  const names = readdirSync(orderDir);
  const photos = new Map(); // base -> filename
  const svgs = new Map();
  for (const n of names) {
    if (COLORING_PNG.test(n)) continue;
    if (PHOTO.test(n)) photos.set(n.replace(PHOTO, ''), n);
    else if (SVG.test(n)) svgs.set(svgBase(n), n);
  }
  const pairs = [];
  for (const [base, photo] of photos) if (svgs.has(base)) pairs.push({ base, photo, svg: svgs.get(base) });
  return pairs;
}
```

**The `_bw` ordering trap:** `PHOTO` is `/\.(jpe?g|png)$/i`. `child_bw.png` **matches it**. If
`PHOTO` were tested first, `child_bw.png` would register as a photo with base `child_bw` — a phantom
photo that pairs with nothing (there is no `child_bw.svg`) and, worse, changes the pair count and
`buildabilityProblem`'s "extra" set.

So `COLORING_PNG` must be tested **first**, with a `continue`:

```js
    if (COLORING_PNG.test(n)) continue;
    if (PHOTO.test(n)) ...
```

**The order of these two lines is load-bearing.** Swap them and the builder gate breaks. The comment
names the exact consequence: *"or it registers as a photo with base '<base>_bw'."*

The same trap is handled in `svgBase`, which strips `_bw.svg` before `.svg` — a chained `.replace`
where the *more specific pattern goes first*. Same principle, same file.

**`PHOTO` accepts PNG** for a documented reason: *"customer uploads are usually JPEG, but the
generator echoes back whatever was uploaded, and the reference orders in the operator's fixture pack
are PNG throughout. The live builder pairs those PNGs happily."* The rule was verified against the
live builder, not assumed.

**`collectPairs` mirrors the builder's own pairing rules** — which is why `buildabilityProblem`
(§5.5.5) imports it rather than reimplementing. One pairing implementation; the safety check and the
build see the same set. The alternative — two implementations that drift — would mean the check
passes and the builder prints something else.

#### `coverCountFor` — the triple `Math.min`

```js
// src/builder/builderDriver.js:39-48
// The builder caps the title-page collage at 8 thumbnails, and its "add all" button always
// selects that many. The operator's books use four, so the driver clicks the first N cover
// tiles instead of pressing the button — `addAllCovers` stays as the old spelling of "8".
const MAX_COVERS = 8;

/** How many cover thumbnails belong on the title page, given the options and the pairs on hand. */
export function coverCountFor({ coverCount, addAllCovers } = {}, pairs = 0) {
  const wanted = Number.isInteger(coverCount) ? coverCount : addAllCovers ? MAX_COVERS : 0;
  return Math.max(0, Math.min(wanted, pairs, MAX_COVERS));
}
```

**Three independent ceilings, one expression:**

| bound | source | what it prevents |
|---|---|---|
| `wanted` | the operator's config | asking for more than intended |
| `pairs` | the photos actually on hand | **clicking a tile that doesn't exist** — a 3-photo order cannot have 4 covers; the driver would time out waiting for `.cover-grid-item` nth(3) |
| `MAX_COVERS` (8) | the builder's own cap | asking for a 9th tile the builder never renders |

Plus `Math.max(0, ...)` — a negative `coverCount` in config becomes 0, not a negative loop bound.

**Each bound comes from a different system** (the config, the filesystem, the third-party app), which
is exactly why they can't be collapsed into one check. The `pairs` bound in particular is the one
that fires in production: order sizes vary, the config doesn't.

**`addAllCovers` is a compatibility spelling:** *"`addAllCovers` stays as the old spelling of '8'."*
The builder has an "add all" button that always selects 8. The operator's books use 4. So the driver
**does not press the button** — it clicks the first N tiles individually, which the button cannot
express. The old boolean config key is preserved and mapped to `MAX_COVERS`, so an existing config
keeps working.

```js
// src/builder/builderDriver.js:158-166
      // Each tile toggles one thumbnail onto the title page. Clicking the first N reproduces the
      // operator's four-up collage, which the "add all" button (always 8) cannot.
      const covers = coverCountFor(options, pairs.length);
      if (covers > 0) {
        await page.waitForSelector('.cover-grid-item', { timeout: this.loadTimeoutMs })
          .catch(() => { throw new BuilderError('Builder never offered cover thumbnails to choose from.', { step: 'load' }); });
        const tiles = page.locator('.cover-grid-item');
        for (let i = 0; i < covers; i++) await tiles.nth(i).click();
      }
```

#### `coverVariantFor` — a named-but-unknown variant throws

```js
// src/builder/builderDriver.js:50-65
// The builder's title page comes in two cover variants (`.cover-variant-btn[data-cover-variant]`):
// "classic" (plain, the builder's default) and "pencils" (the decorated pencil-border style the
// operator ships). The driver leaves the builder default untouched unless a variant is named.
const COVER_VARIANTS = new Set(['classic', 'pencils']);

/** The cover variant to select in the builder, or null to leave its default (classic).
 *  Unset means "don't touch the control"; a named-but-unknown variant throws rather than
 *  silently falling back to classic, so a decorated-cover order can never quietly ship plain. */
export function coverVariantFor({ coverVariant } = {}) {
  if (coverVariant == null || coverVariant === '') return null;
  const v = String(coverVariant).trim().toLowerCase();
  if (!COVER_VARIANTS.has(v)) {
    throw new BuilderError(`Unknown cover variant ${JSON.stringify(coverVariant)} — use "classic" or "pencils".`, { step: 'load' });
  }
  return v;
}
```

**Three-way logic, and the middle case is the point:**

- **unset/empty → `null`** = *"don't touch the control"*. The builder's own default stands.
- **a known variant → select it.**
- **a named-but-unknown variant → throw.** *"so a decorated-cover order can never quietly ship
  plain."*

A silent fallback to classic would produce a **plain cover on an order that paid for a decorated
one**, and nobody would notice until the customer did. A typo in config must be loud.

The same reasoning extends to a *missing control* at runtime:

```js
// src/builder/builderDriver.js:140-153
      // Cover variant (classic|pencils). A named variant whose button is absent is a hard failure,
      // not a silent fall-through to classic — an older builder deploy or a renamed control must be
      // caught here, or a decorated-cover order would quietly print the plain cover to a customer.
      const coverVariant = coverVariantFor(options);
      if (coverVariant) {
        const variantBtn = page.locator(`.cover-variant-btn[data-cover-variant="${coverVariant}"]`);
        if ((await variantBtn.count()) === 0) {
          throw new BuilderError(
            `Builder has no "${coverVariant}" cover-variant control — the deployed builder may be out of date.`,
            { step: 'load' },
          );
        }
        await variantBtn.first().click();
      }
```

**"an older builder deploy or a renamed control must be caught here"** — this is the classic browser-
automation failure mode: the third-party app changes, the selector stops matching, the click silently
does nothing, and the output is subtly wrong forever. An explicit `count() === 0` check converts a
silent wrong-output into a named failure that says *"the deployed builder may be out of date."*

#### `buildPdf` — the drive sequence

```js
// src/builder/builderDriver.js:98-135
  async buildPdf(orderDir, options = {}) {
    if (!existsSync(orderDir)) throw new BuilderError(`Order folder not found: ${orderDir}`, { step: 'load' });
    const pairs = collectPairs(orderDir);
    if (pairs.length === 0) {
      throw new BuilderError(
        `No "<base>.jpg|.jpeg|.png + <base>.svg" pairs found in ${orderDir} — the builder needs each photo paired with its SVG coloring page.`,
        { step: 'load' },
      );
    }
    ...
    try {
      browser = await chromium.launch();
    } catch (err) {
      throw new BuilderError(
        `Could not launch the headless browser — run "npx playwright install chromium" once. (${err.message})`,
        { step: 'launch', cause: err },
      );
    }
    ...
      // 1. Load the order folder into the webkitdirectory input. A webkitdirectory input
      //    requires a directory PATH (Playwright uploads its contents with webkitRelativePath);
      //    the app filters to jpg/jpeg/png + svg and skips _bw.png itself.
      await page.setInputFiles('#folderInput', resolve(orderDir));

      // 2. Pairing is done when the Print button enables (it does so only when pairs > 0).
      await page.waitForSelector('#printBtn:not([disabled])', { timeout: this.loadTimeoutMs })
        .catch(() => { throw new BuilderError('Builder never enabled Print — it found no usable photo+SVG pairs.', { step: 'load' }); });
```

Each numbered step is a stated fact about the third-party app:

1. **`setInputFiles` with a directory PATH** — *"A webkitdirectory input requires a directory PATH
   (Playwright uploads its contents with webkitRelativePath)"*. Not a file list. And *"the app filters
   to jpg/jpeg/png + svg and skips `_bw.png` itself"* — which confirms `collectPairs` mirrors reality.
2. **The Print button's enabled state is the pairing-complete signal** — *"it does so only when pairs
   > 0"*. There is no event, no API; the driver reads the app's own UI state as its readiness signal.
   This is the correct way to drive an app you don't own: wait on *its* observable state, not a
   `sleep`.

```js
// src/builder/builderDriver.js:136-139
      // 3. Apply layout options (all controls are visible on screen; do NOT emulate print here,
      //    the print stylesheet hides them).
      if (options.mode === 'fullpage') await page.click('.mode-btn[data-mode="fullpage"]');
```

**"do NOT emulate print here, the print stylesheet hides them."** A real trap: the natural instinct
when producing a PDF is `emulateMedia({ media: 'print' })` up front. But the builder's `@media print`
stylesheet **hides its own controls** — so emulating print early makes every control invisible and
every click fail. Configure in screen media; render in print media.

```js
// src/builder/builderDriver.js:171-182
      // 4. Wait for every page image (photos + SVGs, loaded as <img> from object URLs) to finish.
      await page.waitForFunction(
        () => {
          const imgs = Array.from(document.querySelectorAll('#pagesContainer img'));
          return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
        },
        { timeout: this.renderTimeoutMs },
      ).catch(() => { throw new BuilderError('Page images did not finish rendering before the timeout.', { step: 'render' }); });
      await page.waitForTimeout(500); // small settle for fonts/layout

      // 5. Render via the print pipeline. page.pdf() uses print media, so @media print + @page A4 apply.
      await page.pdf({ path: outPdfPath, preferCSSPageSize: true, printBackground: true });
```

4. **`i.complete && i.naturalWidth > 0`** — both, because `complete` is `true` for a *failed* image
   too. `naturalWidth > 0` is what proves it actually decoded. `imgs.length > 0` guards against the
   check passing on an empty container. This is a real correctness detail: without
   `naturalWidth`, a broken image would satisfy the wait and print blank pages.
5. **`preferCSSPageSize: true`** — honour the builder's `@page A4` rather than Playwright's default
   Letter. **`printBackground: true`** — print the background graphics, which `@media print` normally
   strips. Both are required for the output to match the operator's manual print.

The `waitForTimeout(500)` settle is a `ponytail:`-shaped shortcut — a fixed sleep for fonts/layout,
honestly labelled *"small settle"* rather than dressed up as a wait condition.

```js
// src/builder/builderDriver.js:186-195
    } finally {
      await browser.close();
    }

    // 6. Validate the PDF is genuine.
    if (!existsSync(outPdfPath) || statSync(outPdfPath).size === 0) {
      throw new BuilderError(`Builder produced no PDF at ${outPdfPath}.`, { step: 'export' });
    }
    if (!readFileSync(outPdfPath).subarray(0, 5).toString('latin1').startsWith('%PDF')) {
      throw new BuilderError(`Builder output at ${outPdfPath} is not a valid PDF.`, { step: 'export' });
    }
    return { pdfPath: outPdfPath, pairs: pairs.length };
  }
```

6. **The output is verified, not assumed.** Exists, non-zero, and starts with the `%PDF` magic bytes.
   `page.pdf()` resolving is not proof of a valid file. **Write to disk, then verify what landed** —
   the same instinct as `acceptReplacement` re-running QC on the file that actually arrived (§5.9).

`browser.close()` in `finally` — a leaked Chromium per build would kill the machine overnight.

**The timeouts are named and reasoned:**

```js
// src/builder/builderDriver.js:83-89
  constructor(config) {
    this.config = config;
    const t = config?.builder?.timeouts ?? {};
    this.navTimeoutMs = t.navMs ?? 90_000; // Render cold start
    this.loadTimeoutMs = t.loadMs ?? 30_000; // client-side pairing + SVG measuring
    this.renderTimeoutMs = t.renderMs ?? 60_000; // all photos + SVGs finish loading
  }
```

Three different timeouts because they wait on three different things: **90s for navigation** because
the builder is hosted on Render and a cold start is slow; **30s for pairing** (client-side work);
**60s for rendering** (decoding every photo and SVG). One global timeout would be either too short
for the cold start or too long to notice a hang.

---

### 5.8 Pricing / ordering / business rules

These are the rules that connect what the shop sold to what the tool builds. Most were discovered by
looking at real orders, and several are non-obvious enough that a rebuild would get them wrong by
guessing.

#### 5.8.1 Page count = photo count — `expectedPhotosFrom`

**The rule:** the number of photos the customer uploads *is* the number of pages in their book. There
is no separate page-count field anywhere. A 4-photo product makes a 4-page book.

Which means the whole "did we get everything" question reduces to: *how many photos does this product
include?* That number comes from the **variant title**:

```js
// src/shopify/orders.js:82-90
/** The photo count a "… / N" variant title advertises ("🖨️ Tištěné omalovánky / 4" -> 4), or null.
 *  Used to seed `expectedPhotos` so the intake count check is meaningful for autopilot orders. */
export function expectedPhotosFrom(products) {
  for (const p of products ?? []) {
    const m = /\/\s*(\d+)\s*$/.exec(p.variant || '');
    if (m) return Number(m[1]);
  }
  return null;
}
```

The variant title is `🖨️ Tištěné omalovánky / 4`. The trailing `/ N` is the photo count. The regex is
anchored to the **end** (`$`) so a `/` elsewhere in the title can't match, and tolerates whitespace
either side of the number.

**Returns `null` when nothing matches** — the first product with a `/ N` wins, and no match at all
means unknown. That `null` flows straight into `assessCount`, which returns `info` (never a hold) —
§5.3. The chain is deliberate: an unparseable variant title makes the count check *advisory*, it
never blocks an order.

The same "null is fine" stance is repeated at the sidecar reader:

```js
// src/orderInfo.js:36-40
  // The product's expected photo count and the customer, both written by a newer extension. An
  // older download has neither, and that is not an error — the count check goes advisory and the
  // email greeting stays neutral. Only positive integers and non-empty strings are trusted.
  const expectedPhotos = Number.isInteger(parsed.expectedPhotos) && parsed.expectedPhotos > 0 ? parsed.expectedPhotos : null;
```

*"An older download has neither, and that is not an error."* And `Number.isInteger(...) && > 0` —
`"4"`, `4.5`, `0`, `-1` all become `null` rather than a bogus expectation. **Only positive integers
are trusted.**

The write side (`shopify/materialize.js:75`) is where the autopilot seeds it:

```js
// src/shopify/materialize.js:72-81
  const sidecar = {
    order: order.orderId,
    dedication: order.dedication,
    expectedPhotos: expectedPhotosFrom(order.products),
    customer: { surname: '', email: order.email },
    products,
    photos: order.photos,
    layout: order.layout,
    source: 'shopify-admin-api',
    downloadedAt: now(),
```

`orderInfo.js` reads one `objednavka.json` shape regardless of whether it came from the browser
extension or the Admin API — one reader, two writers.

#### 5.8.2 Photo ordering = page ordering — `photoIndex`

**The rule:** the order the customer uploaded their photos in is the order the pages appear in the
book. Not the order the API happened to return them.

```js
// src/shopify/orders.js:22-28
/** The trailing "-M" index in a photo key ("Fotka (4)-2" -> 2), or null when there is none.
 *  Photos are ordered by it so the book pages follow the customer's upload order, not the
 *  order the attributes happened to arrive in. */
function photoIndex(key) {
  const m = /-(\d+)\s*$/.exec(key);
  return m ? Number(m[1]) : null;
}
```

```js
// src/shopify/orders.js:52-56
  const photos = attrs
    .filter((a) => keyIncludes(a.key, photoKeyMatch) && isUrl(a.value))
    .map((a) => ({ url: a.value, idx: photoIndex(a.key) }))
    .sort((x, y) => (x.idx ?? 1e9) - (y.idx ?? 1e9))
    .map((p) => p.url);
```

The custom-attribute key is `Fotka (4)-2` — *"N = total count, M = 1-based index"*. The trailing `-M`
is the customer's upload position.

**`(x.idx ?? 1e9)` is the detail worth keeping:** a photo whose key has no index sorts to the **end**,
not to position 0. `null` coerced by `-` would become 0 and jump an unindexed photo to the front of
the book. The sentinel keeps unknowns last, where they're least disruptive, and the sort stays stable
for the indexed ones.

The whole ordering guarantee — customer's upload order → attribute sort → file names → `collectPairs`
→ builder page order — is one `.sort()` at the point of extraction. Everything downstream is
name-ordered and inherits it.

#### 5.8.3 The layout discovery — `Rozvržení`, not the variant (KTD9)

```js
// src/shopify/orders.js:1-11
// Pure normalization of a Shopify Admin API order node into the shape the autopilot pipeline
// needs. No I/O — given a raw GraphQL order node, it returns photos, dedication, format and
// recipient, extracted from the line-item custom attributes.
//
// The public Admin API returns `customAttributes` as `{ key, value }` — there is NO `type` field
// (that is admin-internal-only; see the U0 spike / KTD1). So extraction matches on the KEY
// substring, never on a type. Confirmed keys on the live store:
//   photos     — "Fotka (N)-M"   (N = total count, M = 1-based index)
//   dedication — "Věnování"
//   format     — "Rozvržení"     (the ONLY galerie-vs-full-page signal; not the variant — KTD9)
//   internal   — "_tpo_add_by"   (and any "_"-prefixed key) — skipped
```

**KTD9 — "the ONLY galerie-vs-full-page signal; not the variant".**

This is a discovery that a rebuild would almost certainly get wrong. The natural assumption is that
the *product variant* encodes the format — variants are how Shopify normally expresses product
options, and the variant title already carries the photo count (`/ 4`). It would be entirely
reasonable to look there for the layout too.

**It's not there.** The galerie-vs-full-page choice lives in a **line-item custom attribute** called
`Rozvržení` ("layout"), added by the product-options app, and **that is the only place it exists**.
Reading the variant would silently produce the wrong layout for every order.

The second finding in the same header is KTD1, from the U0 spike:

> *"The public Admin API returns `customAttributes` as `{ key, value }` — there is NO `type` field
> (that is admin-internal-only)."*

So extraction **matches on the key substring, never on a type**:

```js
// src/shopify/orders.js:13-20
const DEFAULTS = Object.freeze({
  photoKeyMatch: 'fotka',
  dedicationKeyMatch: 'věnování',
  layoutKeyMatch: 'rozvržení',
});

const isUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);
const keyIncludes = (key, needle) => key.toLowerCase().includes(needle.toLowerCase());
```

Substring, case-folded, on Czech keys with diacritics. The three match strings are configurable
(`config.shopify.photoKeyMatch` etc.) so a store-side rename doesn't need a code change.

```js
// src/shopify/orders.js:30-40
/** All `{ key, value }` custom attributes across every line item, dropping "_"-prefixed internals. */
function customerAttributes(node) {
  const out = [];
  for (const le of node.lineItems?.edges ?? []) {
    for (const a of le.node?.customAttributes ?? []) {
      if (!a || typeof a.key !== 'string' || a.key.startsWith('_')) continue;
      out.push(a);
    }
  }
  return out;
}
```

**`_`-prefixed keys are internal** (`_tpo_add_by` — the product-options app's own bookkeeping) and
are dropped wholesale. Without this, `_tpo_add_by` could match a substring filter and pollute the
extraction.

`isUrl` on photo values — an attribute matching "fotka" whose value isn't an `http(s)` URL is not a
photo. Belt and braces against a `Fotka - poznámka` style key.

The layout then travels to the builder as a pseudo-product:

```js
// src/shopify/materialize.js:69-70
  if (order.layout) products.push({ title: 'Rozvržení', variant: order.layout, qty: null });
  for (const p of order.products) products.push(p);
```

**Clever and worth understanding:** rather than adding a `layout` field that `resolveFormat` would
need to special-case, the layout is injected into the `products` array as a synthetic line item with
title `Rozvržení` and the layout as its variant. It is pushed **first**, so `resolveFormat`'s
first-match-wins loop finds it before any real product. The format map can then be keyed by the
layout value using the exact same mechanism as a product/variant key — no new code path.

The header of `materialize.js` states it plainly: *"(orderInfo.js) then matches it against
config.delivery.formatMap with no change to orderInfo.js."*

#### 5.8.4 `resolveFormat` — mapped vs fallback, never a block

```js
// src/orderInfo.js:73-95
/** The print layout an order should build in (U9), derived from the product/variant the shop sold
 *  — the same `objednavka.json` the expected-count check reads. Returns the builder `mode` and
 *  whether it came from the format map: `mapped: false` means "no product/variant matched, so this
 *  fell back to the configured default" — a flag for the operator, never a silent guess, and never
 *  a block on the pipeline.
 *
 *  The fallback walks `delivery.format` (which validateConfig mirrors from the global builder mode)
 *  then the raw `builder.pdf.mode`, so an un-mapped order keeps building exactly as it does today
 *  even for a config that never set a delivery block. */
export function resolveFormat(orderInfo, config = {}) {
  const map = config?.delivery?.formatMap ?? {};
  const fallback = config?.delivery?.format ?? config?.builder?.pdf?.mode ?? 'gallery';
  for (const p of orderInfo?.products ?? []) {
    // The variant is the more specific key (size/format live there); the product title is the
    // coarser fallback. Whichever the operator keyed the map by wins.
    for (const key of [p.variant, p.title]) {
      if (key && Object.prototype.hasOwnProperty.call(map, key)) {
        return { mode: map[key], mapped: true };
      }
    }
  }
  return { mode: fallback, mapped: false };
}
```

**The `mapped` flag is the design.** *"a flag for the operator, never a silent guess, and never a
block on the pipeline."* Three possible behaviours for an unmapped product, and the chosen one is the
middle:

- Block the order → an unmapped product jams the pipeline for a config gap. Too strict.
- Silently default → the operator never learns the map has a hole. Too loose.
- **Default and say so** → the book builds, and the run log says *"formát: galerie (výchozí — produkt
  není ve formátové mapě)"* (`orchestrator.js:357-359`).

**Variant before title** — *"The variant is the more specific key (size/format live there); the
product title is the coarser fallback. Whichever the operator keyed the map by wins."* The operator
can key the map either way and it works.

**`Object.prototype.hasOwnProperty.call(map, key)`** rather than `map[key]` — so a mapped value of
`''` or a key named `constructor`/`toString` behaves. Prototype-pollution-safe lookup on a
config-supplied object.

**The three-deep fallback chain** — `delivery.format` → `builder.pdf.mode` → `'gallery'` — exists so
*"an un-mapped order keeps building exactly as it does today even for a config that never set a
delivery block."* A new feature must not change the behaviour of an old config.

The call site treats per-order as authoritative over global:

```js
// src/orchestrator.js:300-303
        // The format the shop sold this order in. When the product/variant isn't in the map it
        // falls back to the config default and is flagged — surfaced here, never blocking.
        const { mode, mapped } = resolveFormat(order.dir ? readOrderInfo(order.dir) : null, config);
        onEvent({ type: 'order-format', orderId, mode, mapped });
```

#### 5.8.5 `titleTextFor` and the "no dedication does not block the book" rule

```js
// src/orchestrator.js:111-122
/** The text the builder will print on the title page: the customer's dedication, or a configured
 *  default if the operator set one.
 *
 *  The builder gives a book a title page when it has anything to put on it — the cover thumbnails
 *  or this text. Measured against the live builder with 8 pairs (2026-07-10): coverCount 4 prints
 *  20 pages with or without this text, and only `coverCount: 0` *and* no text drops the title page
 *  and prints 18. So under the operator's config an order with no dedication is the same book with
 *  an empty title line — not a structurally different one. */
export function titleTextFor(config, dedication) {
  const fallback = config.builder?.pdf ?? {};
  return dedication || fallback.dedication || fallback.title || '';
}
```

**This is a measured finding, not an assumption, and the measurement is recorded.**

The worry was: does an order with no dedication produce a *structurally different* book? If the title
page vanished without text, a no-dedication order would print 18 pages where its neighbour prints 20
— and the tool would be silently shipping two different products.

**The experiment (2026-07-10, live builder, 8 pairs):**

| coverCount | title text | pages |
|---|---|---|
| 4 | present | **20** |
| 4 | absent | **20** |
| 0 | absent | 18 |

**The conclusion:** the builder prints a title page when it has *anything* to put on it — the cover
thumbnails **or** the text. Under the operator's config (`coverCount: 2`, formerly 4 — see the
memory note on the cover redesign), the covers alone guarantee the title page. So *"an order with no
dedication is the same book with an empty title line — not a structurally different one."*

**Therefore: no dedication does not block the book.** It prints.

The rule is enforced at the call site, and the discomfort is stated out loud rather than buried:

```js
// src/orchestrator.js:293-298
      } else {
        // Plenty of customers write nothing. Their book is the same book with an empty title
        // line, so it prints rather than waiting for an operator to invent words for them.
        // Said out loud all the same: a dedication that was meant to be there and one that was
        // never written look identical once the PDF exists.
        if (!titleText) onEvent({ type: 'no-title', orderId });
```

**"a dedication that was meant to be there and one that was never written look identical once the PDF
exists."** The system cannot tell "the customer wrote nothing" from "we lost their words". The
mitigation is threefold: the `no-title` event tells the operator (*"v názvech fotek není věnování —
titulní strana se vytiskne bez textu"*, `orchestrator.js:356`), `dedicationWas` preserves an
accidental clear (§5.5.2), and the honest limitation is documented rather than papered over.

The `dedication || fallback.dedication || fallback.title || ''` chain: the **customer's text beats
everything**, then an operator-configured default, then a configured title, then empty. `||` rather
than `??` is correct here — an empty-string dedication *should* fall through to the configured
default, because the operator's config default is a deliberate choice about what an empty book gets.

#### 5.8.6 Cover count

Covered mechanically in §5.7.4 (`coverCountFor`'s triple `Math.min`). The business rules on top:

- **The builder caps the collage at 8**, and its "add all" button always selects exactly 8.
- **The operator's books do not use 8.** The driver therefore clicks the first N tiles individually,
  *"which the 'add all' button (always 8) cannot"*.
- **`addAllCovers` is kept as a compatibility spelling of 8** — an old config keeps working.
- **The count is bounded by the photos on hand** — a 3-photo order can never have 4 covers.
- Per the project memory (`pdf-cover-two-photos`), the cover was redesigned in the builder app to
  **2 photos**, and `coverCount` moved 4 → 2, verified end-to-end. The mechanism is unchanged; the
  number is config.

#### 5.8.7 `estSpendPerOrder` — visibility, not a cap

```js
// src/autopilot.js:122-125
  // Spend is over orders that actually hit the GPU: a built book or a generation failure. Held orders
  // stop at the intake gate before any GPU spend, and a materialize failure never reaches generation.
  const generated = pipeline.orders.filter((o) => o.status === ORDER_STATUS.DONE || o.status === ORDER_STATUS.FAILED).length;
  const estSpend = Number((generated * sh.estSpendPerOrder).toFixed(2));
```

**`estSpendPerOrder` is a reporting multiplier. It never gates anything.** There is no budget check,
no "stop after $X", no refusal path anywhere. Grep confirms it appears only in `config.js` (parse) and
`autopilot.js` (multiply into the report).

**Why that's the right call:** the *actual* spend bound is structural, not numeric. It comes from
three independent mechanisms already in place:

1. **The intake gate** — a held order never reaches the GPU at all.
2. **`needsGeneration`** — an already-generated photo is skipped on every subsequent run.
3. **`force: false` + `pdfIsCurrent`** — an already-built book is never rebuilt.

A dollar cap on top would add a failure mode (a run that stops halfway through an order, mid-book) to
protect against a cost the caching already bounds. So the number exists to make spend **visible** —
in the night report and the morning dashboard banner (`studio.js:206-219`) — not to control it.

**The `generated` filter is precise about what actually costs money:**

| status | hit the GPU? | counted |
|---|---|---|
| `done` | yes — the book built | ✅ |
| `failed` | yes — generation was attempted and died | ✅ |
| `held` | **no** — *"Held orders stop at the intake gate before any GPU spend"* | ❌ |
| materialize failure | **no** — *"never reaches generation"* | ❌ |

Counting `failed` is the honest choice: a dead GPU job still burned a GPU minute. Counting held orders
would inflate the number and make the report useless.

`toFixed(2)` then `Number()` — a clean 2-decimal number, not a string, for the JSON report.

#### 5.8.8 `requirePaid: false` — an explicit operator trade

```js
// src/autopilot.js:71-80
  const photoOrders = orders.filter((o) => o.photos.length > 0);
  // With requirePaid:false (David's setting) an order is generated on arrival regardless of payment —
  // RunPod is cheap and people often pay slightly later, so waiting only wastes turnaround. The default
  // (true) keeps the original "paid only" gate. `nonPaidPhotoSeen` is still reported either way.
  const requirePaid = sh.requirePaid !== false;
  const eligible = requirePaid ? photoOrders.filter(isPaid) : photoOrders;
  const nonPaidPhotoSeen = photoOrders.filter((o) => !isPaid(o)).length;
```

```js
// src/config.js:272
  const requirePaid = shopRaw.requirePaid !== false;
```

**This is a business decision written down as a business decision.** The reasoning, verbatim:

> *"RunPod is cheap and people often pay slightly later, so waiting only wastes turnaround."*

The trade is explicit: generate on arrival regardless of payment. The downside is a few cents of GPU
on an order that never gets paid. The upside is faster turnaround for the majority who pay a few
minutes or hours late. **The operator (David) made this call knowingly**, and the comment names him,
so a successor knows it's a deliberate setting and not a bug.

Three details that make it safe:

- **`sh.requirePaid !== false`** — the default is `true`. **Opt-out, not opt-in.** An unset config
  keeps the original "paid only" gate. Only an explicit `false` turns it off. Same idiom in
  `config.js` and `autopilot.js`, so parse and use agree.
- **`nonPaidPhotoSeen` is reported either way** — *"so non-paid photo orders are visible in the report
  rather than vanishing"* (`autopilot.js:64-65`). Whichever mode you're in, you can see how many
  unpaid orders are in the window. The visibility is independent of the gate.
- **`isPaid` is defensive**: `String(order.financialStatus ?? '').toUpperCase() === 'PAID'`
  (`autopilot.js:28`) — a null status is not paid; case is normalised.

Note the delivery path makes the same call, independently: *"Sent regardless of payment"*
(`ui/server.js:1172`). Consistent, and stated at both ends.

#### 5.8.9 Never fabricate a testimonial

**The one content rule with a hard structural enforcement.** It appears in four independent places:

```js
// src/creatives/adCopy.js:6-7
// The `reference-zakaznika` (testimonial) family is deliberately NOT auto-generated anywhere — we
// never fabricate a customer review. adCalendar.js excludes it from the auto mix.
```

```js
// src/creatives/adCalendar.js:6-8
// The imagery is generated from TEXT prompts (occasion → scene), never from a customer photo, so
// these brand ads carry no customer identity. `reference-zakaznika` is excluded from the auto mix
// (we never fabricate a testimonial).
```

```js
// src/creatives/studio/templates.js:161-162
  name: 'Reference zákazníka — recenze + produkt',
  explanation: 'Skutečná recenze zákazníka s produktem a podpůrnou fotkou. Recenzi nikdy nevymýšlíme.',
```

```js
// src/brandVoice.js:16
  'proměně a vytvoření; o vzpomínkách, radosti, společném čase a dárku. Nevymýšlej recenze, slevy, akce,',
```

**The enforcement is layered, and each layer alone would be insufficient:**

1. **The template exists** — the operator *can* build a testimonial ad, by typing a real review they
   actually received.
2. **It is excluded from the auto mix** (`adCalendar.js`) — the calendar-of-ads generator never
   produces one, so no unattended path can emit a fabricated review.
3. **`adCopy.js` never generates its fields** — even if the template were rendered, the AI would not
   be asked to write the quote.
4. **The brand voice forbids it at the prompt level** (`brandVoice.js`) — *"Nevymýšlej recenze,
   slevy, akce"* (don't invent reviews, discounts, promotions).
5. **The template's own `explanation` says it in Czech, in the UI** — *"Recenzi nikdy nevymýšlíme"*
   (we never invent the review). The operator sees the rule at the moment they'd break it.

The seed copy (`templates.js:21`) does carry a sample quote (*„Nádherný dárek, babička měla slzy v
očích."* — *"— Jana N."*), but it is **seed copy for the template preview**, and `validateConcept`
marks the quote field `required: true` — so a real export forces the operator to replace it or hit a
`missing-copy` **error** (`nedokonceno`, un-exportable).

This is the §5.6 pattern applied to content: **structural exclusion first** (not in the auto mix),
**a guard second** (required field), **a stated rule third** (the prompt, the UI explanation). A
fabricated review is a legal and trust problem, not a quality problem, so it gets defence in depth.

The sibling rule from the same file: *"The imagery is generated from TEXT prompts (occasion → scene),
never from a customer photo, so these brand ads carry no customer identity."* Marketing images never
carry a real customer's face — the same identity-free stance the Kreativy describe-then-generate flow
takes (`ui/server.js:365-368`: *"the 'before' is generated from that TEXT ALONE — the customer's
pixels never reach the image model"*).

---

### 5.9 Cross-cutting principles

These are the decisions that recur across unrelated files. None is stated as a rule anywhere; each
was reached independently several times, which is what makes them the codebase's actual design.

#### 5.9.1 Pure heuristic + thin adapter

Every piece of judgement is a pure function over decoded data; a separate thin module does the IO.

| pure | adapter | what the adapter does |
|---|---|---|
| `qc.js` | `qcFiles.js` | sharp-decodes the outputs |
| `inputQc.js` | `inputQcFiles.js` | sharp-decodes one input photo |
| `intake.js` (order-level) | injected `assess` | *"unit-testable without an image library"* |
| `templateModel.js` | `renderStudioHtml.js` → `renderCreative.js` | *"the one seam that touches Playwright and the filesystem"* |
| `studio.js` `deriveOrderStatus`/`buildBoard` | `studioBoard` | stats the filesystem |
| `shopify/orders.js` `extractOrder` | `materialize.js` | fetches and writes |

Stated three times in near-identical words:

- `qc.js:1-2` — *"Pure QC heuristics. They operate on already-decoded data so they are testable
  without an image library; a thin sharp-based adapter feeds these at runtime."*
- `inputQc.js:1-3` — *"...so they are testable without an image library, exactly like qc.js."*
- `intake.js:8-9` — *"the same pure/adapter split as qc.js and qcFiles.js."*

**The payoff is concrete:** the entire QC, intake, board, and layout logic is testable with plain
arrays and objects. No fixtures, no image files, no browser, no network. The adapters are thin enough
to be verified by eye.

#### 5.9.2 One source of truth, derived everywhere else

Every fact has exactly one home, and everything else is computed:

| fact | the one home | derived by |
|---|---|---|
| per-photo state | `state.json` | the grid, the summary, the board |
| order board status | **nothing** — computed | `deriveOrderStatus` |
| "the book is built" | `<orderId> Final.pdf` existing | `pdfPathFor`, shared by builder and board |
| "sent" / "printed" / "hidden" | a marker file in the order folder | `existsSync` |
| "the PDF is stale" | `state.json`'s mtime | `pdfIsCurrent` |
| photo↔SVG pairing | `collectPairs` | the builder driver **and** `buildabilityProblem` |
| an order's format | `objednavka.json` | `resolveFormat` |

The reasoning, from `studio.js:10-12`:

> *"Every order-level status is DERIVED on read, never stored: the review grid already owns the
> per-photo truth in state.json, and a second mutable 'order status' field beside it would be one
> more thing to keep in sync."*

Three instances worth calling out:

- **`pdfPathFor` is exported from the orchestrator** *"so the status board tells a built order from an
  unbuilt one by the same path the build wrote"* — one path constant, two consumers, no drift.
- **`buildabilityProblem` imports `collectPairs` from the builder driver** rather than reimplementing
  the pairing. If the builder would pair it, the safety check sees it.
- **`state.json`'s mtime doubles as the PDF-cache clock** — no separate version field, because every
  action that could change the book already writes that file. And the consequence is respected:
  `orchestrator.js:230-237` guards a `writeManifest` because *"a needless bump reprints it."*

The intake block is the clearest case of the principle applied to a *record*: the stored `intake`
verdict is for the UI, but the **gate re-derives it every run** — which is exactly what makes the
overnight self-lift work without anything having to notice the customer's re-upload.

#### 5.9.3 Corruption is never fatal; a guess is never a hold

Every reader of external or on-disk data degrades to a safe answer rather than throwing:

```js
// src/autopilotState.js:21-22
/** Read the persisted state, or a clean slate when there is none / it is unreadable. Never throws —
 *  a half-written file must not abort the night. */
```

```js
// src/orderInfo.js:27-31
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null; // a truncated write, or a file the operator opened and saved from Word
  }
```

*"a file the operator opened and saved from Word"* — the failure modes anticipated are the real ones.

Others: `reviewState`'s missing-inbox catch (*"no inbox (photos purged...)"*); `heldReason`'s
*"Falls back rather than throwing on an override-only or malformed block"*; `studioBoard`'s
`createdAt`/`stale` both returning null/false on any error; `cropSvgViewBox` returning `false` on an
unparseable viewBox; `measureSolidFill` returning zeros on a short buffer; `dHash` returning an
all-zero hash *"which then matches nothing but another empty"*; `unreadable()` returning a complete
well-formed finding object; `overnightSummary` type-checking every field.

**And the paired rule: a guess is never a hold.**

- `assessCount`: *"Unknown expected is not a failure — the count simply goes unjudged (info), never a
  hold on a guess."*
- `resolveFormat`: *"a flag for the operator, never a silent guess, and never a block on the
  pipeline."*
- `orderInfo.js`: *"An older download has neither, and that is not an error."*
- Near-duplicate detection: *"Never a hold on its own... so the operator confirms."*
- Blur/exposure: warns, because *"A dark or blown photo still often generates acceptably."*

Only **facts** hold: too few photos, an identical byte-for-byte upload, a file that will not decode,
a resolution that cannot print. Never an estimate, never an absence of information.

**The one deliberate exception proves the rule:** `resolveTemplate` throws on an unsupported format —
*"a format change must be an intentional layout, not a guess."* The difference is that there is no
safe degradation: an unsupported format renders a visibly broken ad. Where a guess can degrade, it
degrades; where it can't, it refuses.

**The blast radius is always stated when a degradation is chosen:**

> *"A lost or corrupt state file degrades to 'start clean' — the pipeline's own force:false caching
> means already-built PDFs are not re-generated, so the blast radius of a state loss is a
> re-download, never a re-spend."* (`autopilotState.js:8-9`)

That is what licenses the forgiving reader: a second, independent mechanism protects the expensive
thing.

#### 5.9.4 Every seam injectable

Every external dependency arrives as a parameter with a real default:

| seam | parameter | default |
|---|---|---|
| output QC | `qc = assessOutputFiles` | the real one |
| intake | `intake = assessIntake` | the real one |
| photo decode | `assess = assessPhotoFile` | the real one |
| generator | `driver` / `generator` | lazily constructed |
| builder | `builder` | lazily constructed |
| Shopify | `createClient = createAdminClient` | the real one |
| materialize | `materialize = materializeOrder` | the real one |
| the whole pipeline | `runPipelineFn = runPipeline` | the real one |
| Playwright | `launcher` | headless Chromium |
| review state | `state = reviewState` | the real one |
| board facts | `pdfBuilt`, `delivered`, `printed`, `createdAt`, `stale` | `() => false` / `() => null` |
| mail / SMTP / WhatsApp | `mailClient`, `smtpClient`, `waClient` | config-built or `null` |
| AI images | `adImageFn` | config-built |
| clock | `now = () => new Date().toISOString()` | the real clock |
| the report reader | `readReportFn = readReport` | the real one |
| memory dir | `memoryRoot = MEMORY_DIR` | the real one |
| stop signal | `signal` | undefined |
| events | `onEvent = noop` | silent |

The stated payoffs:

- `autopilot.js:38-39` — *"All external seams are injected so a test drives the whole detect →
  materialize → pipeline → report contract with no network and no GPU."*
- `studio.js:165-167` — *"Pure over its inputs... so the whole status machine is testable without a
  filesystem or a running server."*
- `adCalendar.js:3-4` — *"Every external call (copy, image, line-art, render) is an injected dep, so
  this orchestration is unit-testable with stubs — no network/GPU."*

**Two things make this more than boilerplate:**

1. **The defaults are real**, so production code passes nothing. Injection costs the caller nothing.
2. **Lazy construction where the dependency is expensive** — *"Drivers are constructed once, lazily,
   so a generation-only run never needs Chromium and a rebuild-only run never needs the generator
   token"* (`orchestrator.js:183-184`). Injectability and laziness are the same mechanism here.

And injection is used for **safety**, not only testing:

```js
// src/ui/server.js:325-328
/** `revealFinished` opens the finished book's folder on the desktop. It defaults to off: a test
 *  or a smoke that constructs a server must never spawn a File Explorer window — and one that
 *  did, pointed at a temp folder the test then deleted, is how this default was chosen. Only the
 *  double-click launcher, where a real operator is watching, turns it on. */
```

*"one that did, pointed at a temp folder the test then deleted, is how this default was chosen."*
The default is off because of an actual incident.

#### 5.9.5 Failures named in plain Czech, never a stack trace

```js
// src/batch.js:25
/** Plain-language failure text for the manifest and the operator's report. Never a stack trace. */
```

The `seam` / `step` convention gives every error a location without a stack:

```js
// src/builder/builderDriver.js:18-27
/** A builder-seam failure phrased for the operator; `step` names where it broke. */
export class BuilderError extends Error {
  constructor(message, { step, cause } = {}) {
    super(message);
    this.name = 'BuilderError';
    this.seam = 'builder';
    this.step = step ?? null;
    if (cause !== undefined) this.cause = cause;
  }
}
```

Even the top-level CLI catch respects it: `` console.error(`Run stopped at the ${err.seam ?? 'unknown'} seam: ${err.message}`) `` (`orchestrator.js:454`).

**The operator UI is entirely Czech** (`intake.js:92-93`: *"Czech, to match the client-side FINDING
map in index.html (the whole operator UI is Czech)"*), and the messages carry the evidence and the
next action:

| message | what makes it good |
|---|---|
| `jen 3 z 4 fotek — 1 chybí` | the numbers, not "count check failed" |
| `Neúplná kniha: napište 3 pro potvrzení, že kniha bude mít 3 stran místo 4.` | names the exact number to type and the consequence |
| `PDF ještě není hotové — nejdřív ho vytvořte.` | says what to do |
| `Zastaveno — 3 z 7 objednávek hotovo. Zbytek zůstal nedotčený; pokračujte stiskem Spustit.` | reassures that nothing was lost, names the next click |
| `"x" is out for manual repair. Save the replacement into the order folder and click "I've replaced it" first.` | the exact remedy |
| `re-rolled up to 12 diffusion steps, the ceiling — this generator repeats itself... Approve it, repair it by hand, or change generator.variant.` | why it can't continue + three options |
| `Could not launch the headless browser — run "npx playwright install chromium" once.` | the literal command |

And `formatEvent` is *"Shared by the CLI and the review grid's run log, so both describe a run
identically"* — one vocabulary, every surface.

The heartbeat exists for the same reason:

```js
// src/orchestrator.js:391-392
  // Diffusion and vectorize can go minutes without a word. Say something, or a slow call
  // reads as a hang and the operator kills the run.
```

Silence is a failure mode too.

#### 5.9.6 One bad unit never costs the batch

The same sentence, three levels of nesting:

- **photo → order:** *"A single photo's failure is recorded and the batch moves on — one dead GPU job
  must not cost the other fifteen photos."* (`batch.js:117-118`)
- **order → run:** *"The rest of the batch continues; one dead GPU job must not cost the other
  orders."* (`orchestrator.js:37-38`)
- **order → night:** *"Never throws for a single bad order; a hard failure (config, poll) rejects so
  the CLI can log it and the next scheduled run retries."* (`autopilot.js:37-38`)

The mechanism is uniform: **the unit-level function never throws.** `generatePhoto` catches into a
`FAILED` status. `buildOrder` catches into a `FAILED` entry. `runPipeline` catches per order. Loops
cannot be broken by their contents.

**A finer-grained instance:** the auto-crop try/catch inside `generatePhoto` — *"Never fail a page the
GPU already paid for over a crop hiccup — the uncropped page is still perfectly usable."* One
cosmetic step's failure doesn't cost the expensive step's output.

**And the distinction that makes it coherent:** only a *hard, shared* failure propagates — a bad
config, a failed poll. Those aren't one bad unit; they mean nothing can work.

#### 5.9.7 Write to disk before returning

```js
// src/batch.js:54-55
 *  Never throws; a failure becomes a FAILED status. Writes state.json before returning, so an
 *  interrupt costs at most this photo.
```

```js
// src/review.js:34-36
// The U4 review gate. state.json is the single source of truth: every verdict here is written
// to disk before the call returns, so closing the tool never loses a decision, and the builder
// gate (isBuilderEligible) reads exactly what the operator saw.
```

`generatePhoto` uses `finally`. `review.js`'s `update()` helper makes it structural — read, mutate,
write, return — so no verdict function can forget. `generateOrder` writes after every photo *"so an
interrupted run resumes exactly where it stopped."*

**The paired principle: the ORDER of writes is crash-safety.**

- `applyPhotoEdit` — *"Render before writing anything: an SVG that will not rasterize must not reach
  the order folder."* Validate, then write.
- `revertPhotoEdit` — `rmSync(backup)` **last**: *"Only once both files are back."* If it ran first
  and a write failed, the page would be un-revertable forever.
- `deliver` — `markDelivered` **after** the await resolves. A false "sent" loses a book.
- `buildOrder` — safety check **before** the cache check. Cache-first would reuse a PDF printed from
  the folder's previous contents.

**And: verify what actually landed, don't trust that you wrote it.**

- `builderDriver` step 6 — exists, non-zero, `%PDF` magic bytes. *"page.pdf() resolving is not proof
  of a valid file."*
- `acceptReplacement` — re-runs QC on the file that actually arrived, because the operator could have
  saved the wrong one.

#### 5.9.8 The recurring platform trap: libvips holds the file

Not a principle so much as a scar, but it appears **four times** and any rewrite will hit it:

```js
// src/autoCrop.js:101
  // sharp can't read and overwrite the same file in one pipeline — buffer, then write.
```

```js
// src/review.js:301-303
 *  Decoded from bytes rather than a path: handed a path, libvips keeps the file mapped while it
 *  works, and on Windows the very next line cannot then overwrite it.
```

```js
// src/ui/server.js:180-182
  // Decode from bytes, not from the path: handed a path, libvips keeps the file mapped while it
  // decodes, and on Windows the run cannot then overwrite that very file — the grid drawing a
  // tile would fail the photo being regenerated behind it. readFileSync closes before we decode.
```

Plus `inputQcFiles.js:32` — `sharp(bytes, { failOn: 'none' })`, bytes not path.

**The rule: never hand sharp a path you intend to write.** `readFileSync` closes the handle before
decoding. On Windows the mapped file cannot be overwritten, and the symptom is remote from the cause
— *"the grid drawing a tile would fail the photo being regenerated behind it."*

#### 5.9.9 The shape of it

Read together, the principles describe one stance: **the system is a careful assistant to a human who
is accountable for the output.**

- It measures what it can measure honestly (§5.2's 2× margin, admitted; §5.3's `CALIBRATE`).
- It refuses only on facts, never on guesses (§5.9.3).
- It never takes the irreversible action — sending, deleting — without a human (§5.6, and the purge
  gated on the manually-set `printed` marker).
- It says what happened in the operator's language, with the numbers, and names the next click
  (§5.9.5).
- It loses nothing when it's killed, and one bad unit costs one unit (§5.9.6, §5.9.7).
- And it writes down *why* — every threshold's provenance, every measured finding, every bug a guard
  prevents.

That last one is the thing to preserve above the code itself. The code can be rewritten in an
afternoon. The knowledge that the generator is deterministic at ≥8 steps and exposes no seed, that
`Rozvržení` is the only layout signal, that a title page survives an empty dedication, that the solid-
fill limits rest on two positives from order 1523 — that took months of looking at real orders, and a
rewrite that discards it starts from zero.
## 6. AI PROMPTS AND TEMPLATES

> **Verbatim fidelity is the entire point of this section.** These prompts are the accumulated result of many tuning sessions against real failures. Copy them exactly — do not "clean up" the Czech, do not paraphrase, do not truncate. The generator prompt pair in particular lives in the gitignored `config.json` and would be **silently lost** in a migration: an empty `positivePrompt`/`negativePrompt` doesn't error, it just falls back to the RunPod server's own untuned default and line-art quality regresses with no warning.

### 6.0 Model selection summary

| Seam | Config key | Default in code | **LIVE value** |
|---|---|---|---|
| Image generation | `ai.model` | `gemini-3-pro-image-preview` | **`gemini-3.1-flash-image`** |
| Photo→scene description | `ai.describeModel` | `gemini-flash-lite-latest` | not set → default |
| Ad copy / blog text | `ai.copyModel` → falls back to `describeModel` | `gemini-flash-lite-latest` | **not settable — the key is dead (§3.1)** |
| Line art | `generator.variant` | none (required) | **`2511_1.5`** (model `2511`, 1.5 MP) |
| Image timeout | `ai.imageTimeoutMs` | `180000` | not set locally; Render sets it explicitly |
| Image retries | `ai.maxRetries` / `backoffBaseMs` | `5` / `1500` | not overridden |

All Gemini calls: `https://generativelanguage.googleapis.com/v1beta` (`aiImage.js:11`), header `x-goog-api-key`.

**Why `gemini-flash-lite-latest` and not `gemini-flash-latest`** (`config.js:196-200`):
> "the plain flash-latest alias is heavily contended and returns sustained 503 'high demand', which blocked Kreativy at the describe step. The lite sibling is far more available and more than enough to write a scene description."

**Why `gemini-3.1-flash-image` and not the pro tier:** the `gemini-3-pro-image` family (both `-preview` and stable) went **server-side unavailable** — requests hang and time out at 45–180s rather than erroring. Flash-image is fast (~6–8s) and the quality proved premium in practice. If the pro tier recovers, switching back is a one-line config change plus a full regen.

---

### 6.1 The describe-then-generate privacy pipeline (`src/creatives/aiImage.js:21-39`)

**What calls it:** the Kreativy image flow, and `adImages.js`'s `describeAndGenerate()`. The operator uploads a customer photo → `describeImage()` sends photo + this instruction to a cheap vision model → the returned text (photo **not** included) goes to `generateMarketingImage()`.

**Why it's two steps** (`aiImage.js:1-9`):
> "The privacy design (David, 2026-07-12): the operator uploads a customer photo, describeImage turns it into a generic marketing scene description with NO faces/identity, and generateMarketingImage then makes a fresh image from that TEXT ALONE — the customer photo is never sent to the image model, so no pixel of it can reach the output."

`adImages.js:60` passes `referenceBase64: null` to `aiFn` explicitly, to guarantee this at the call site too.

**`DESCRIBE_INSTRUCTION` — VERBATIM** (joined with `\n`; overridable via `ai.describeInstruction`, currently unset so this is live):

```
You are writing a prompt for an AI image generator to create marketing imagery for a company that
turns family photos into printable coloring pages. Look at the attached photo and write ONE vivid
image-generation prompt (2–4 sentences, in English) for a brand-new, synthetic marketing photo
inspired only by the general mood, setting, activity, colours and lighting.

STRICT PRIVACY RULES — the generated image must never resemble a real person:
- Do NOT describe or reference any individual's face, facial features, hairstyle, skin tone, exact
  age, body, tattoos, clothing logos, visible text, or anything that could identify a real person,
  place, brand, or pet.
- Refer to people only in generic terms ("a parent and a young child", "a small child", "a family")
  with no distinguishing detail.
- Focus on the warm scene, emotion, environment, props, season, and photographic style.

Return ONLY the prompt text — no preamble, quotes, or explanation.
```

---

### 6.2 The ad copy prompt (`src/creatives/adCopy.js:25-56`)

**What calls it:** `adCalendar.generateOccasionAds` → `deps.copyFn`, once per (occasion × template), to write the Czech copy composited onto the ad PNG.

**Assembled from parts.** The builder, verbatim:

```js
export function buildCopyPrompt({ occasion, template }) {
  const fields = templateFields(template);
  const limits = templateFieldLimits(template);
  const spec = fields
    .map((f) => `  "${f}": ${fieldHint(f)}${copyCap(f, limits) ? ` (max ${copyCap(f, limits)} znaků)` : ''}`)
    .join('\n');
  return [
    AD_VOICE,
    '',
    `Příležitost: ${occasion.name} (${occasion.m}/${occasion.d}).`,
    `Cílová skupina: ${occasion.persona}.`,
    `Úhel sdělení: ${occasion.angle}`,
    `Šablona reklamy: ${template.family} — ${template.explanation}`,
    '',
    'Napiš text pro tuto konkrétní reklamu. Vrať POUZE platný JSON objekt s přesně těmito klíči,',
    'v češtině, bez uvozovek okolo celého objektu, bez markdown fencí, bez komentářů:',
    '{',
    spec,
    '}',
    '',
    fields.includes('headlineHi')
      ? 'Titulek rozděl na dvě NEPŘEKRÝVAJÍCÍ se části, které dohromady tvoří jednu větu: "headline" = ' +
        'začátek titulku a "headlineHi" = posledních 1–2 slova, která větu dokončí (zvýrazní se). Např. ' +
        'celý titulek „Vzpomínka, která se dá vybarvit“ => "headline":„Vzpomínka, která se dá“, ' +
        '"headlineHi":„vybarvit“. Slova z "headlineHi" se NESMÍ objevit v "headline".'
      : '',
    TIGHT_HEADLINE[template.id]
      ? `Celý titulek ("headline" + "headlineHi" dohromady) musí být krátký — nejvýše ${TIGHT_HEADLINE[template.id]} znaků, aby se vešel na dva řádky.`
      : '',
    'Dodrž limity znaků. Text musí být konkrétní k této příležitosti, ne obecný.',
  ].filter(Boolean).join('\n');
}
```

**`fieldHint(field)` — VERBATIM** (`adCopy.js:59-74`):

| field | hint |
|---|---|
| `headline` | `začátek titulku (bez zvýrazněného konce)` |
| `headlineHi` | `posledních 1–2 slova titulku, která na "headline" navazují a zvýrazní se` |
| `support` | `krátká podpůrná věta na jeden řádek` |
| `cta` | `výzva k akci (tlačítko)` |
| `badge` | `krátký odznak/štítek (např. „Dárek na míru“)` |
| *default* | `text` |

**`copyCap()`** (`adCopy.js:19-22`) — each field capped at the template's `maxChars`, **except `support`**, clamped tighter to `min(base || 80, 58)` regardless of the template's own limit, so *"it stays a punchy ~single line and can't overflow into the CTA in the tighter product layout."*

**`TIGHT_HEADLINE`** (`adCopy.js:15`) = `{ 'emotivni-darek': 34 }` — *"a longer headline wraps to 3 lines and overlaps [support/CTA] — `emotivni-darek` is the one such family (left-aligned 60%-wide box). The wide centered-pill headlines are fine."* A measured layout fact for exactly one template.

**Fully assembled example** (occasion = Sv. Valentýn, template = `promena`):

```
[AD_VOICE — see §6.4]

Příležitost: Sv. Valentýn (2/14).
Cílová skupina: Páry.
Úhel sdělení: Rande s vínem a pastelkami nad vaší společnou fotkou — originální obraz do ložnice.
Šablona reklamy: Proměna — Vlajková reklama: nalepená fotka a hotová omalovánka spojené oranžovou šipkou, dole bílá karta s nadpisem a logem.

Napiš text pro tuto konkrétní reklamu. Vrať POUZE platný JSON objekt s přesně těmito klíči,
v češtině, bez uvozovek okolo celého objektu, bez markdown fencí, bez komentářů:
{
  "headline": začátek titulku (bez zvýrazněného konce) (max 44 znaků)
  "headlineHi": posledních 1–2 slova titulku, která na "headline" navazují a zvýrazní se
}

Titulek rozděl na dvě NEPŘEKRÝVAJÍCÍ se části, které dohromady tvoří jednu větu: "headline" = začátek titulku a "headlineHi" = posledních 1–2 slova, která větu dokončí (zvýrazní se). Např. celý titulek „Vzpomínka, která se dá vybarvit“ => "headline":„Vzpomínka, která se dá“, "headlineHi":„vybarvit“. Slova z "headlineHi" se NESMÍ objevit v "headline".
Dodrž limity znaků. Text musí být konkrétní k této příležitosti, ne obecný.
```

**Failure handling** (`adCopy.js:137-141`): any field whose text hits `bannedHits()` is discarded and replaced with that template's `SEED_COPY` — because *"nobody reviews a calendar ad before it renders onto the canvas — so 'AI'/'sleva' must not survive this function."*

---

### 6.3 The ad imagery prompts (`src/creatives/adCalendar.js`)

**What calls them:** `buildAssets()` per (occasion × template), filling whichever image slots the template needs. **Text-to-image only — no reference photo is ever attached** (`adCalendar.js:6-8`): *"generated from TEXT prompts (occasion → scene), never from a customer photo, so these brand ads carry no customer identity."*

#### `momentPrompt(occasion)` — the `promena` "before"

*Why (`adCalendar.js:28-30`):* "a warm, identity-free MEMORY moment — the kind of photo a customer would send. Its 'after' is the line-art coloring page, so the transformation itself is the product; **no book in this frame (a book here would muddy the before→after story)**."

```
A warm, candid, editorial-quality lifestyle photograph — a cherished, un-staged family moment of
the kind a customer would treasure and want turned into a keepsake.
Occasion and mood: ${occasion.name} — ${occasion.angle}
Subject: ${occasion.persona}, shown only in generic terms with NO identifiable faces (candid angle,
seen from behind, or soft focus). Cozy Czech home or seasonal outdoor setting, soft natural window
light, gentle shadows, shallow depth of field, muted tasteful colours, authentic and heart-warming.
Photorealistic. No text, no logos, no watermark, no illustration, no UI.
```

#### `scenePrompt(occasion)` — the product-in-use lifestyle shot

*Why (`adCalendar.js:43-44`):* "the printed personalized coloring book is the HERO — so the ad actually shows the product in use. Identity-free, premium, uncluttered (**deliberately not 'AI slop'**)."

```
A warm, editorial-quality lifestyle photograph for a premium brand that turns family photos into
personalized printed coloring books. HERO PRODUCT, clearly visible and in sharp focus: a real
printed coloring book open to a clean black-and-white line-art page, being coloured in with a few
quality coloured pencils — or resting open on a cozy table mid-colouring.
Occasion and mood: ${occasion.name} — ${occasion.angle}
People (${occasion.persona}) present only as hands or a soft over-the-shoulder view, NO
identifiable faces. Natural window light, soft shadows, shallow depth of field, tasteful,
uncluttered, high-end and authentic. No text, no logos, no watermark, no UI, no illustration overlays.
```

#### `productPrompt(occasion)` — the pure product shot

```
A premium, magazine-quality product photograph of a printed personalized coloring book resting on
a light wooden table, open to reveal a clean, friendly black-and-white line-art page, a few quality
coloured pencils resting neatly beside it. Soft natural daylight, gentle shadows, minimalist and
tasteful. A subtle seasonal hint of: ${occasion.name}. No readable text, no logos, no watermark, no clutter.
```

**Fully assembled example** (`momentPrompt`, Sv. Valentýn):

```
A warm, candid, editorial-quality lifestyle photograph — a cherished, un-staged family moment of the kind a customer would treasure and want turned into a keepsake. Occasion and mood: Sv. Valentýn — Rande s vínem a pastelkami nad vaší společnou fotkou — originální obraz do ložnice. Subject: Páry, shown only in generic terms with NO identifiable faces (candid angle, seen from behind, or soft focus). Cozy Czech home or seasonal outdoor setting, soft natural window light, gentle shadows, shallow depth of field, muted tasteful colours, authentic and heart-warming. Photorealistic. No text, no logos, no watermark, no illustration, no UI.
```

#### The asset-reuse contract (a real cost saver)

`buildAssets()` (`adCalendar.js:74-95`) — `original` and `lifestyle` never co-occur in a template, so **at most one scene image is generated per concept**. The `promena` "before" is generated once and **fed to the line-art step as its own "after"**, so the flagship costs one image call, not two:

```js
  let sceneForLineArt = null;
  if (slots.includes('original')) {
    const img = await imageFn({ prompt: momentPrompt(occasion) });
    assets.original = dataUri(img);
    sceneForLineArt = img;
  }
  ...
  if (slots.includes('coloring')) {
    if (typeof lineArtFn !== 'function') throw new Error('coloring slot needs a lineArtFn');
    if (!sceneForLineArt) sceneForLineArt = await imageFn({ prompt: momentPrompt(occasion) });
    assets.coloring = dataUri(await lineArtFn(sceneForLineArt));
  }
```

#### The auto-mix rule

`pickTemplates()` (`adCalendar.js:23-26`) — `promena` always, plus one tone-appropriate second family. Two concepts × `AUTO_FORMATS` (`feed`, `story`) = 4 ads per occasion.

```js
export function pickTemplates(occasion) {
  const second = occasion.tone === 'brand' ? 'emotivni-darek' : occasion.tone === 'warm' ? 'spolecne-vybarvovani' : 'produktova-ukazka';
  return ['promena', second];
}
```

The tone→family mapping IS the business rule: `brand` → gift emotion, `warm` → family togetherness, `info` → clean product. **`reference-zakaznika` is structurally unreachable from the auto mix — "we never fabricate a testimonial."**

---

### 6.4 The brand voice (`src/brandVoice.js`)

**Prepended to every Czech-copy prompt** — ad copy (§6.2), blog topics (§6.5), blog drafts (§6.6).

**Source** (`brandVoice.js:1-9`): transcribed from David's brand guide (*"Brand Guide & AI Context"* in `docs/Fotomalovánky 2026.docx`, §4 Tone of Voice + §5 Jak komunikujeme vs. NEkomunikujeme).
> "The one rule everything hangs on: we sell the EMOTION (a kept memory, a personal gift), never the technology or a discount. The guide is explicit — 'Nikdy neprodáváme AI algoritmus'."

**`BRAND_CORE`** (`brandVoice.js:12-18`, joined with single spaces):

```
Fotomalovánky.cz proměňují osobní fotky zákazníků na omalovánky a tištěné omalovánkové knihy na míru. Prodáváme emoci a vzpomínku, ne technologii ani slevu. NIKDY nezmiňuj umělou inteligenci, algoritmy, „generování“ ani „renderování“ — pro člověka na druhé straně je to ruční, osobní výrobek. Mluv o kouzlu, proměně a vytvoření; o vzpomínkách, radosti, společném čase a dárku. Nevymýšlej recenze, slevy, akce, výprodeje ani konkrétní ceny a termíny. Žádné klišé, žádné křičení velkými písmeny.
```

**`BLOG_VOICE`** = `BRAND_CORE` + ` ` +:
```
Píšeme česky, vřele a osobně, vykáním, jako rada od někoho, kdo tomu rozumí — ne jako reklama.
```

**`AD_VOICE`** = `BRAND_CORE` + ` ` +:
```
Tón: vřelý, osobní, česky, vykáním, s lehkou hravostí. Mluvíme k jednomu člověku, ne k davu. Žádné vykřičníky navíc. Nejsme chladní technokraté ani přehnaně sluníčkoví prodejci.
```

*Note the register split:* the ad voice stays on **vykání** to match the templates' seed copy — the brand guide reserves *hravé tykání* for organic social, which this calendar does not write.

**`BANNED_STEMS`** (`brandVoice.js:37-57`) — diacritics-folded, lowercased substrings:

```
umela inteligence
umelou inteligenci
 ai 
algoritm
neuronov
neuronka
vygenerov
generovani
renderov
personalizovany produkt
sleva
slevu
slevy
zlevn
nejlevnej
levny vyrobek
akcni
vyprodej
zabaveni ditete
```

> **The `' ai '` entry is space-padded on both sides, and `bannedHits()` pads the haystack to match** (`` const hay = ` ${fold(text)} ` ``). This is subtle and load-bearing: a bare `ai` substring would false-positive on ordinary Czech words containing those letters. The padding makes it match the standalone word only, including at string start/end. **Port the padding, not just the list.**

Two severities on the same list, by design:
- **Blog** — a match is a soft QC **warning**. David edits every post before it ships.
- **Ads** — a match is a **hard fallback to seed copy**. Nobody reviews a calendar ad before it renders.

---

### 6.5 The blog topic / SEO prompt (`src/blog/topics.js:46-60`)

**What calls it:** `suggestTopics()`. Runs **alongside**, not instead of, the pure-calendar list — best-effort, so *"if the model fails, the calendar half still yields a full, timely list, so the topic picker is never empty."*

**`NICHE`** (`topics.js:13`):
```
personalizované omalovánky a tištěné omalovánkové knihy z vlastních fotek (Fotomalovánky.cz)
```

**`buildSeoPrompt()` — VERBATIM:**

```js
export function buildSeoPrompt({ now, upcoming, limit }) {
  const dateStr = `${now.getDate()}. ${now.getMonth() + 1}. ${now.getFullYear()}`;
  const names = upcoming.slice(0, 8).map((u) => `${u.occasion.name} (za ${u.days} dní)`).join(', ') || 'žádné v nejbližším okně';
  return [
    BLOG_VOICE,
    '',
    `Dnešní datum: ${dateStr}. Obor: ${NICHE}.`,
    `Nadcházející marketingové příležitosti: ${names}.`,
    '',
    `Navrhni ${limit} konkrétních SEO témat na blog, která dávají smysl PRÁVĚ TEĎ (sezóna, nadcházející svátky,`,
    'nákupní chování). Každé cílí na reálný český vyhledávací dotaz a je jiné než ostatní.',
    'Vrať POUZE platný JSON objekt (bez markdown fencí, bez komentářů):',
    '{ "topics": [ { "title": "titulek článku", "keyword": "cílové klíčové slovo", "intent": "jednou větou, proč to lidé hledají teď" } ] }',
  ].join('\n');
}
```

---

### 6.6 The blog draft prompt (`src/blog/draft.js:23-49`)

**What calls it:** `generatePost()`. Returns **structured JSON, never raw HTML** — `buildBodyHtml()` (`draft.js:58-74`) then assembles the body deterministically, so **structure is enforced in code, not by the model.**

**`buildDraftPrompt()` — VERBATIM** (`SEO_TITLE_MAX = 60`, `META_MAX = 155`):

```js
export function buildDraftPrompt({ topic, wordCountMin, wordCountMax }) {
  return [
    BLOG_VOICE,
    '',
    `Napiš SEO optimalizovaný český článek na blog na téma: „${topic.title}".`,
    `Cílové klíčové slovo: „${topic.keyword}". Musí být v titulku, v prvním odstavci (do ~100 slov) a přirozeně v textu — bez keyword stuffingu.`,
    topic.intent ? `Kontext / vyhledávací záměr: ${topic.intent}` : '',
    `Rozsah ${wordCountMin}–${wordCountMax} slov. Struktura: úvod, 3–5 sekcí s podnadpisy, aspoň jeden seznam, blok FAQ.`,
    '',
    'Vrať POUZE platný JSON objekt (bez markdown fencí, bez komentářů), přesně v tomto tvaru:',
    '{',
    `  "seoTitle": "SEO titulek s klíčovým slovem (max ${SEO_TITLE_MAX} znaků)",`,
    `  "metaDescription": "meta popis s klíčovým slovem (max ${META_MAX} znaků)",`,
    '  "handle": "url-slug-s-klicovym-slovem",',
    '  "tags": ["štítek1", "štítek2", "štítek3"],',
    '  "intro": "úvodní odstavec, klíčové slovo v prvních ~100 slovech",',
    '  "sections": [ { "h2": "podnadpis", "paragraphs": ["odstavec", "odstavec"], "bullets": ["bod", "bod"] } ],',
    '  "faq": [ { "q": "otázka", "a": "odpověď" } ],',
    '  "internalLinkHint": "návrh, na jaký produkt/kolekci v článku odkázat",',
    '  "heroPrompt": "popis titulní fotky (bez identifikovatelných tváří, bez textu)",',
    '  "heroAlt": "alt text titulní fotky s klíčovým slovem"',
    '}',
    'Text je konkrétní k tématu, ne obecný. "bullets" je volitelné pole (vynech u sekcí bez seznamu).',
  ]
    .filter(Boolean)
    .join('\n');
}
```

**Anti-fabrication** (`draft.js:7-8`): *"No fabricated claims: the prompt forbids invented reviews, discounts and deadlines, and QC flags the brand's banned vocabulary."* — enforced by `BRAND_CORE`'s own line plus the post-hoc `bannedHits()` QC pass.

---

### 6.7 The coloring-book generator prompts (`config.json` → `config.generator`)

> **⚠️ THE HIGHEST-VALUE, MOST-EASILY-LOST ARTEFACT IN THE PROJECT.** These live in the **gitignored** `config.json`. They are not secrets — they are the tuned recipe. `apiDriver.js:182-183` sends them **only if non-empty**; an empty value silently falls back to the server's untuned default. A migration that forgets these loses line-art quality with **no error and no warning**.

**What calls it:** every photo→line-art conversion — both the customer order pipeline (`batch.js`) and the "after" step of ad generation (`adCalendar.buildAssets` → `lineArtFn`).

**Target:** not an LLM — the RunPod diffusion model selected by `generator.variant`, parsed as `<model>_<megapixels>` (`apiDriver.js:51-62`). **Live: `2511_1.5`** (model `2511`, 1.5 MP). Steps: **`diffusionSteps: 8`**, ceiling `maxDiffusionSteps: 12`.

**`positivePrompt` — VERBATIM** (identical in `config.json` and `config.example.json`):

```
Convert the image into a clean black-and-white coloring book illustration.

Preserve the original composition, proportions, and recognizable features of all subjects including people, animals, objects, and background elements.

Use clean contour outlines to represent all shapes. All enclosed areas must remain white and colorable.

Do not fill any regions with solid black. Dark objects such as hair, fur, clothing, trees, shadows, or dark materials must be represented using outlines and simple interior contour lines only.

Remove all shading, grayscale, gradients, shadows, and cross-hatching.

Facial features must remain clear and natural.

Simplify textures so the drawing stays detailed but easy to color. Fur, hair, and fabric folds should be represented with light directional lines rather than dense texture.

Keep foreground and background clearly separated using clean outlines while preserving the original background scene.

Output style: professional coloring book page, clean vector-style line art, consistent line weight, crisp edges, white background.
```

**`negativePrompt` — VERBATIM, the LIVE tuned version from `config.json`:**

```
solid black fill, filled clothing, filled fur, filled shadows, silhouette fill, grayscale shading, gradients, cross-hatching, engraving style, comic shading, painterly shading, sketch shading, dense texture, messy lines, rough pencil, blurry outlines, uneven line thickness, missing pupils, blank eyes, invented background elements, stray lines, unconnected lines, incomplete outlines, unfinished edges, border, frame, page border, black frame, black blobs, stray black spots
```

> **`config.example.json`'s negative prompt is STALE** — an older, shorter version missing the tail `, border, frame, page border, black frame, black blobs, stray black spots`. **`config.json` is authoritative.** Anyone seeding a new install from the example gets the older recipe.

#### The tuning rules that make these prompts work

These are not in `config.json` and are the part most likely to be lost:

1. **NEVER name objects in the prompt.** The positive prompt is deliberately *universal* — it never says "a boat", "a dog", "a child". Naming an object makes the model invent it. This is the single most important rule of the recipe.

2. **Never fix backgrounds by adding prompt detail.** The failure mode is the model marooning the subject in white; the fix was strengthening the *general* background instruction (and `autoCrop`), never describing the specific scene.

3. **8 steps is a floor, not a preference — and the step count is the seed.** From `batch.js:34-40` (`nextAttemptSettings`):
   > "It must differ from `prev`, or the re-roll returns the same page: at >= 8 steps the generator is deterministic within a run, and its API takes no seed. The step count is the only knob that changes the sampler's trajectory while staying above 8, where the negative prompt is evaluated at all."

   So: a re-roll **never changes the prompt text** — it increments `diffusionSteps` by 1 (capped at 12) and resubmits. **Below 8 steps the negative prompt has no effect at all.** This is why re-rolling a bad face is a step-count change, and why the ladder climbs rather than descends.

4. **The prompt asks; the QC verifies.** `"Do not fill any regions with solid black"` (positive) + `"solid black fill, filled clothing, filled fur"` (negative) are exactly what `qc.js`'s `measureSolidFill` tripwire exists to police. They are a matched pair — port both or neither makes sense.

5. **A GPU `FAILED` is not a bad result** (`apiDriver.js:198-200`) — it's a hard RunPod failure, retried by resubmitting a **new** job (`gpuRetries`, default 2); re-polling a dead job only re-reads FAILED. ~8% of jobs failed in a recorded session (≈1 dropped photo per 16-photo order).

6. **EXIF handling is upstream of the prompt entirely** (`prepareImageForUpload`, `apiDriver.js:39-49`) — camera rotation is baked in **before** upload, because a raw re-encode without `.rotate()` drops the EXIF orientation flag and the generator draws the subject sideways, limbs cut off by the wrong-shaped frame.

---

### 6.8 Email templates (`src/proton/templates.js:11-63`)

**Not LLM-generated** — hand-authored static Czech, *"mined from the real Sent folder … and approved by him"*. Included because they're pre-approved customer-facing copy that took real thought.

**`SIGN`** (`templates.js:8`), appended to every body:
```
\n\nS pozdravem,\nDavid\nFotomalovánky.cz
```

`[BRACKET]` tokens are deliberate placeholders. **`unfilledPlaceholders()`** (`templates.js:68-71`) matches `/\[[\p{Lu}0-9 ]{2,}\]/gu` and the composer **refuses to send** a template still holding one.

**1. `hotovo-odkaz`** — "Hotové Fotomalovánky — odkaz" · Subject: `Vaše Fotomalovánky #[ČÍSLO]`
```
Dobrý den,

připravili jsme vaše Fotomalovánky, můžete si je stáhnout a vytisknout zde: [ODKAZ]

Doporučujeme tisknout na 100 % velikosti bez okrajů. Budeme moc rádi za jakoukoliv zpětnou vazbu.

S pozdravem,
David
Fotomalovánky.cz
```

**2. `hotovo-priloha`** — "Hotové Fotomalovánky — v příloze" · Subject: `Vaše Fotomalovánky #[ČÍSLO]`
```
Dobrý den,

připravili jsme vaše Fotomalovánky, posíláme je v příloze. Doporučujeme tisknout na 100 % velikosti bez okrajů. Budeme moc rádi za jakoukoliv zpětnou vazbu.

S pozdravem,
David
Fotomalovánky.cz
```

**3. `omluva-zdrzeni`** — "Omluva za delší dobu vyřízení" · Subject: `Vaše objednávka Fotomalovánky`
```
Dobrý den,

chtěli bychom se vám omluvit za delší dobu vyřízení vaší objednávky. Upřímně jsme nečekali tak obrovský zájem o naše produkty a momentálně pracujeme naplno, abychom vše co nejdříve zpracovali a odeslali. Vaší objednávce se věnujeme a brzy ji odešleme.

Děkujeme za trpělivost.

S pozdravem,
David
Fotomalovánky.cz
```

**4. `chybi-fotka`** — "Chybí nám fotografie" · Subject: `Chybí nám fotografie k vaší objednávce`
```
Dobrý den,

k vaší objednávce nám bohužel chybí [POČET] fotografie. Mohli byste nám ji prosím zaslat v odpovědi na tento e-mail? Jakmile ji budeme mít, hned se do vašich Fotomalovánek pustíme.

S pozdravem,
David
Fotomalovánky.cz
```

**5. `storno`** — "Potvrzení storna" · Subject: `Storno objednávky #[ČÍSLO]`
```
Dobrý den,

potvrzuji storno vaší objednávky.

S pozdravem,
David
Fotomalovánky.cz
```

**6. `doba-vyroby`** — "Doba výroby a expedice" · Subject: `Vaše objednávka Fotomalovánky`
```
Dobrý den,

aktuálně je doba výroby a odeslání cca do 2 dnů. V případě jakýchkoliv dotazů nám napište.

S pozdravem,
David
Fotomalovánky.cz
```

---
## 7. KNOWN ISSUES AND UNFINISHED WORK

### 7.1 TODO / FIXME markers

**There are almost none.** No literal `FIXME`/`HACK`/`XXX` exists anywhere in tracked `src/`, `test/` or `docs/`. This codebase writes long prose comments and plan documents instead of scattering markers — **the debt here is architectural and documentational, not inline.** The few that matter:

| Location | What | Severity |
|---|---|---|
| `src/generator/browserDriver.js:5` | *"Stub until Phase-0 observation of the live UI."* The whole class throws unconditionally. The spike happened long ago and resolved to `"api"` mode, so this is **permanently unreachable**, not an open TODO. | Cosmetic — but confusing; a rebuilder may think "browser mode" is a real fallback. |
| `src/proton/bridgeClient.js:40` | `ponytail: hard byte cap; add a /api/mail/attachment byte-serving route if operators hit big mail.` A self-labelled deferred shortcut — large attachments are capped, not streamed. | Low — mail is a read-only convenience, off entirely in the cloud. |
| `src/config.js:263` | `estSpendPerOrder` is *"A placeholder to refine from real invoices — no cap is enforced."* Still a guess (`0.3`), never tuned against a real RunPod bill. | Low — visibility only. |
| `README.md` "What's left" | Is itself a live TODO list — and **stale** (see §7.7). | Misleading. |

### 7.2 Dead code

- **`src/generator/browserDriver.js`** — fully dead. `factory.js` instantiates it only if `mode === 'browser'`; both example configs hardcode `"api"`, and **no test references it at all**. Zero coverage, unreachable. **Delete.**
- **`manualTouchThreshold`** — validated in `config.js:441`, present in `config.example.json`, asserted in `test/config.test.js` — and **read by nothing in `src/`**. It was meant to gate the "redo rate" metric README's "What's left #4" wanted; the consumer was never built. A config key with zero behaviour.
- **`config.autoRunSeconds`** and **`config.copyModel`** — read by code but never emitted by the loader (see §3.1). Dead in the other direction: the code thinks they're configurable, the loader disagrees.
- **No large commented-out blocks anywhere.** This team deletes rather than comments out — the old hard-coded ad engine (`creativeTemplate.js`, its sample tool and test) was fully removed during the Creative Studio rebuild. Good hygiene; nothing to salvage.

> **Do NOT mistake these for dead pairs:** `dedication.js`/`dedications.js`, `qc.js`/`qcFiles.js`, `inputQc.js`/`inputQcFiles.js` look duplicated but are each an intentional **pure-logic / IO-adapter split**. Port both halves.

### 7.3 Half-built features

**Creative Studio ("Kreativy")** — the biggest deliberately-incomplete surface, self-documented in `docs/creative-studio.md` "Known limitations":
- No persistence — edit-live only, no saved campaign list, no autosave, no reopen. The Campaign/Asset/Concept/GenerationJob data model from the brief was never built.
- No asset library or uploads — product/lifestyle slots depend entirely on the AI "before" image; a real photo can't be dropped in.
- One concept at a time — no multi-concept campaign generation, no AI copy actions (Zkrátit / Více emotivní / …).
- No ZIP or batch export — "Všechny formáty" downloads PNGs one at a time.
- Fonts are a **system fallback**, not the self-hosted Fredoka/Baloo the brief specifies. Preview==export holds, but not against the real brand typeface.
- **`docs/plans/2026-07-14-002-feat-creatives-rework-plan.md`** (David's punch-list #9 — the flagship diptych rework, `odhaleni`/`kampan` families, a real copy engine seeded from the brand knowledge base) is a detailed, **entirely unimplemented** upgrade plan with concrete element-box specs and a 6-phase sequence (U1–U6). **None of it landed.** Read it before assuming the current 5 families are "the design."

**Blog Creator** — functional but incomplete per `docs/blog-creator.md`: hero-image generation is described in the editor but **never uploaded to Shopify** (`buildArticleInput` only attaches an image if a real `http(s)` URL already exists — there's no staged-upload path); per-section regenerate and a richer keyword-density check are deferred. Also **still blocked on David granting the Shopify `write_content` scope** — drafting works, publishing does not.

**Studio UI redesign** — `docs/design/REDESIGN_ROADMAP.md` describes dedicated `/orders`, `/calendar`, `/settings` routes with their own JSON stores, self-hosted Fredoka/Manrope/JetBrains Mono + an inlined Lucide icon set under `static/fonts/`/`static/icons/`, a command palette, and a `/legacy` cutover. **Neither directory exists. None of this was built.** What shipped instead was a narrower incremental punch-list (N1–N14) bolted onto the existing single-page shell. **Treat `REDESIGN_ROADMAP.md` as a road not taken, not a description of the app.**

**N7 "deep re-architecture"** — explicitly deferred: collapsing the Generator page into a pure batch runner with board-row → order-workspace routing. Marked *"a product decision needing David's sign-off... risky to do blind"*. Never revisited. Relatedly, the dashboard's **global search box is a cosmetic placeholder with no handler** — it renders and does nothing.

**Feature flags that gate whole subsystems off by default** (all `enabled: false` in `config.js`; live config turns most on): `whatsapp`, `mail` (**permanently off in cloud**), `ai`, `shopify`, `blog`. None are bugs — they're deliberately safe defaults — but "the app does X" in the docs often means "X exists behind a flag not flipped in every environment."

### 7.4 The scratch scripts (`_*.mjs`, gitignored)

~21 one-off drivers. None are imported by `src/` or `test/`. **One matters:**

> **`_gencal.mjs` is the ONLY way to drive the ad-calendar generator.** `src/creatives/adCalendar.js` — a real, tested subsystem — has **no server route and no npm script**. It runs exclusively from this gitignored throwaway. A rebuild must give it a proper home, or the whole calendar-of-ads feature is unreachable from the app.

The rest are disposable: `_applyrecipe`/`_fixprompt`/`_resetprompt`/`_commit2511` (config-rewriting one-offs, already applied), `_approve`, `_buildpdfs` (hardcoded stale order ids), `_credprobe`/`_diag` (Gemini probes — mildly reusable as ops checks, trivial to rewrite), `_fixemotivni`/`_genvanoce`/`_regen`/`_rollone` (one-time repairs), `_imgsample`/`_modeltest`/`_testprompt` (dev comparisons), `_blogShot`/`_kreativyShot`/`_ovf`/`_promenaShot`/`_reworkShot` (screenshot smokes), `_gencal.log`/`_server.log` (raw logs).

Their sheer number is itself a signal: **the generator recipe and Gemini model choice needed constant hands-on tuning.** That fragility is the real finding here.

### 7.5 Operational fragility (what actually breaks)

#### WhatsApp — the most fragile thing in the system

- **`src/ui/server.js:1351-1354`**: killing the server without a clean shutdown tears the WhatsApp Chromium down mid-flush, and **the next restore hangs in `'connecting'` forever** — "the recurring 're-scan the QR after every restart' pain." `shutdown()` exists as mitigation but is **best-effort only**.
- **`protocolTimeout` raised 180s → 300s** because a slow restore hit `Runtime.callFunctionOn timed out`.
- **`executablePath` exists** because puppeteer's pinned Chromium download "can be missing/broken" (a cache clean breaks it).
- **Only ONE server may hold the session at a time.** Multiple `node server.js` processes competing over the same LocalAuth dir was diagnosed as the true root cause of repeated "authenticated but never ready" hangs. A background task reporting "killed" may leave the process alive — verify, don't assume.
- **Running WhatsApp from a datacenter IP (Render) is an accepted, un-mitigated risk** to the number. The documented fallback is to keep delivery on the PC.
- **Reliable model:** a fresh QR scan links every time; then **leave the server running**. Restarts are the only trigger for the hang.

#### Gemini

- **`config.example.json:54` and `docs/creative-studio.md:105` still show `"describeModel": "gemini-flash-latest"`** — the exact value `config.js:198-201`'s comment warns against. **Anyone seeding from the example gets the known-flaky model.** A live footgun, not history.
- Image generation needs its own 180s timeout (vs 60s text); 503s are routine, not exceptional — hence 5 retries with backoff built in.
- The **pro image tier went down server-side** (hangs, not errors). Flash-image is the current live choice.
- **Credits have run dry repeatedly.** The Gemini API bills against the **"Prepay – AI Studio"** pool, which is **separate from "Prepay – Google Cloud Services"** — a top-up into the wrong pool looks like it "drains instantly" because it never funded the right account. Verify credits with a **text** call, not an image call (the image model can be down independently).

#### Playwright/Chromium pinning

The Dockerfile base tag **must** match the `playwright` npm version. **This already broke production once** (`2478927`) — base was 1.48.0 while the lockfile said 1.61.1, so every PDF build failed with `Executable doesn't exist`. The added `npx playwright install chromium` guards drift, but the coupling is still a manual thing to remember on every bump.

#### Windows

- Windows 10 Home **forces updates and can auto-reboot outside active hours**, silently killing an in-flight overnight run. The only mitigation offered is "set active hours" plus using the morning banner's stale timestamp as a tell. Sleep must be disabled or wake timers configured, or the task never fires.
- The autopilot trigger is a **Windows Task Scheduler entry**, not portable cron.
- `src/autopilot.js` must **not** call `process.exit()` — see §2.4 (the Node-24/libuv `UV_HANDLE_CLOSING` crash).

#### Mail is permanently PC-only

Proton Bridge runs only on David's Windows box. `docs/RENDER.md`: *"Mail is off in the cloud... The Pošta inbox tab shows 'not configured' in the cloud — that's expected."* **Permanent, not a gap** — there is no cloud IMAP path designed or planned.

#### ⚠️ The cloud autopilot trigger gap

The Render deploy plan **never mentions the Windows Scheduled Task**. Phase 1 made the *server* cloud-ready, but the autopilot's *trigger* is Windows-only. Unless something else schedules `node src/autopilot.js` on Render, **the cloud instance's only Shopify polling is the in-process `autoFetchTimer`**. This reads as an unexamined gap between two plans rather than a decision. **Verify against whatever Render is actually configured with.**

#### The cross-process lock gap

The run-locks (§2.3) are **in-process only**. The standalone Scheduled-Task autopilot can race the server's own `autoFetchTimer`. Both serialise through per-order `state.json` writes, so it's not catastrophic, but there is no real mutual exclusion.

### 7.6 Test coverage gaps

~558 tests across 39 files. Pure-logic coverage is genuinely thorough, with injected fakes at every network/FS/AI seam. The holes:

- **The entire client-side UI is untested.** `index.html` (1,627 lines) + `dashboard.html` (1,877 lines) — **~3,500 lines of inline HTML/CSS/JS driving the whole operator experience** — have **zero** unit or DOM-level coverage. No jsdom, no component tests. The only checks are ad-hoc Playwright screenshot scripts that aren't part of `npm test` and mostly assert "no console errors" rather than exercising interaction. The verdict-apply log says it outright: *"Frontend-only (no DOM test harness); parse-checked."* **This is the single biggest hole in the repo.**
- **The real WhatsApp client** is only testable via an injected fake. The most operationally fragile subsystem has **no automated regression protection** against whatsapp-web.js upstream changes.
- **The real Playwright builder** — pure helpers are tested; the actual browser-driven PDF build is validated only by a one-time spike and manual runs.
- **The real Gemini API** is correctly never hit — but that means the 503/retry logic **has never been proven against the flaky surface it was written to survive**.
- **Visual/CSS regressions** are uncovered by design; several shipped UI changes were never visually verified by a human.

### 7.7 Stale and abandoned material

- **`README.md` is badly out of date.** It describes the app at its earliest "Phase 1 (build-out)" milestone — a CLI + review grid — with **no mention of** the Shopify autopilot, WhatsApp delivery, Creative Studio, Blog Creator, mail tile, or Render. It also **actively misstates behaviour**: *"There is no purge yet... no code in this repo deletes a customer's photos"* — but `src/purge.js` + `src/retention.js` are fully implemented, tested, and documented. **Anyone starting from README alone gets a badly wrong model of the app.**
- **`docs/OPERATOR.md`** — the doc README points to as "the whole thing in plain words" — is equally stale: 250 lines with **zero** mentions of Shopify, WhatsApp, autopilot, Kreativy, Blog, Render or "dashboard". It documents only the original Browse→Go→grid flow. Meaningful, since it's the daily-operation manual.
- **`docs/design/REDESIGN_ROADMAP.md`** — reads as current, is aspirational-only (§7.3).
- **`docs/blog-creator.md:75`** references `src/blog/voice.js`, which no longer exists (promoted to `src/brandVoice.js` in `3c5e5fc`). One-line doc fix.
- **`config.example.json`** — stale `describeModel` (§7.5) and a stale, shorter `negativePrompt` (§6.7).
- **`Marketing Automatization/`** — **91 files still tracked in git**, despite `.gitignore` now listing the folder as reference-only. `.gitignore` doesn't retroactively untrack. Nothing in `src/` imports from it, and `.dockerignore`'s whitelist excludes it from the image entirely.

  > **Correction worth stating precisely:** the folder is **4.1 GB on disk**, but the **tracked** portion is only **2.7 MB** (91 files) — the bulk is untracked reference assets. So the git history is not carrying 4.1 GB; it is carrying 2.7 MB of dead weight. Still worth `git rm -r --cached "Marketing Automatization"`, but it is not the repo-bloat emergency the raw disk figure suggests.

---

## 8. WHAT I WOULD KEEP VS REBUILD

My honest read, having gone through the whole thing. The short version: **the pure logic is genuinely good and should be ported almost verbatim; the delivery mechanism around it is where the rot is.**

This codebase has an unusual quality: it *documents its own scar tissue*. Comments routinely explain the bug they fixed, not just what the code does. That reasoning is worth more than the code — a rebuild that keeps the code but drops the comments will rediscover every bug in them.

### 8.1 Port directly — solid, tested, hard-won

| What | Why |
|---|---|
| **`src/qc.js`, `src/inputQc.js`** | Pure heuristics with thresholds **calibrated against 16 real rasters from order 1523**. That comparison set may no longer exist. You cannot re-derive `0.0005`/`0.01`/`0.95`/`128` from first principles. |
| **`src/autoCrop.js`** | `deframe()`'s three guards each correspond to a distinct false positive found in production. Pure trial-and-error knowledge. |
| **`src/dedication.js`, `src/dedications.js`** | Every rule (`__`→`+`, `GENERIC_LABELS`, `LOWERCASE_WITHIN`, the two filename dialects, majority vote) was learned from a real customer's filename. Irreplaceable linguistic data. |
| **`src/creatives/studio/*`** | ~230 lines of hand-tuned layout geometry + the brand kit's inline SVG atoms. This IS the visual product. |
| **`src/creatives/calendar.js`** | 33 occasions with personas and real marketing angles. Content, not code. Months of thought. |
| **`src/brandVoice.js`** | Transcribed from the brand guide; the `' ai '` padding trick is subtle. Just committed, tested. |
| **`src/shopify/orders.js`** | Encodes the API quirks that cost the most to discover: no `type` field, `ACCESS_DENIED` on `customer{}`/`variant{}`, `Rozvržení` (not the variant) as the layout signal. |
| **`src/shopify/safeFetch.js`** | Security-critical and well built. Don't rewrite security code for fun. |
| **`src/generator/apiDriver.js`** | Reverse-engineered from a spike: the exact call sequence, the GPU-FAILED-resubmit semantics, the EXIF fix. Re-deriving means redoing the spike. |
| **`src/retention.js`** | The four-part gate and the `utimesSync` mtime restore are two separate bugs' worth of learning. |
| **`src/manifest.js`** | The state machine is small, correct, and everything depends on it. |
| **`src/proton/mailbox.js`, `templates.js`** | Pure; the templates are pre-approved customer-facing copy. |
| **All the prompts (§6)** | The single highest-value artefact. Especially `config.generator.*`, which is gitignored and would vanish silently. |
| **The test suite (558 tests)** | Executable documentation of every edge case. Port it *with* the modules — it's the spec. |

### 8.2 Rebuild — messier than it's worth to port

| What | Why rebuild |
|---|---|
| **`src/ui/server.js` (~1438 lines)** | **The god object.** Raw `node:http` with hand-rolled `if`-chain routing, and it simultaneously owns: every subsystem's client, all run-locks, both background timers, an in-memory image cache, the auth gate, static serving, and ~40 routes. Every feature bolted on here. A small framework (Fastify/Hono) plus split route modules is faster to write than to disentangle. **The logic it calls is fine — it's the wiring that's tangled.** |
| **`static/index.html` + `dashboard.html` (~3,500 lines)** | **The biggest liability in the repo.** Inline vanilla JS, zero test coverage, a hand-duplicated copy of `MARKETING_CAL`, a dead search box, and 8 tabs' worth of state in one file. Any component framework with real tests beats porting this. Rebuilding also kills the calendar-duplication bug by construction. |
| **`src/generator/browserDriver.js`** | Delete. Unreachable, untested, throws unconditionally. |
| **Dead config keys** | `autoRunSeconds`, `copyModel`, `manualTouchThreshold` — wire them through or delete them. Right now they lie. |
| **`README.md`, `docs/OPERATOR.md`** | Rewrite from scratch. **Worse than useless — actively misleading.** README claims a feature doesn't exist that does. |
| **`config.example.json`** | Regenerate from the live config's shape. Its stale `describeModel` and `negativePrompt` are footguns. |
| **The scratch scripts** | Delete all except the *capability* in `_gencal.mjs`, which needs a real home (§7.4). |
| **`Marketing Automatization/` etc.** | Don't port. Untrack. |
| **`redactForLog()`** | Rewrite as a deny-by-default redactor. Its current allowlist approach already misses `ai.apiKey` and `mail.pass`. |

### 8.3 The three decisions I'd revisit

**1. Files-as-database — keep, but fix the locking.**
For one operator, JSON-on-disk is genuinely the right call: it's inspectable, debuggable, trivially backed up, and survives a crash mid-write with one order affected. Don't reach for Postgres out of reflex.

**But the per-process locks are a real gap.** The Scheduled-Task autopilot and the server's own timer can race with no mutual exclusion. Either a proper lockfile (`proper-lockfile`) or **SQLite** — which gives real transactions, keeps the single-file inspectability, and needs no server. If you rebuild the data layer at all, SQLite is the move. If not, add a cross-process lock.

**2. WhatsApp delivery — the fragility is structural, not fixable.**
`whatsapp-web.js` automates an **unofficial** interface by driving a headless browser. It will keep breaking: the restore hangs, the session corruption, the datacenter-IP flagging risk, the zero regression coverage. It's the most fragile thing here **and** it's on the critical path to the printer.

Given Jirka just needs a PDF, the question worth asking is whether it needs to be WhatsApp at all. Email with an attachment, or a link to `GET /api/<order>/pdf`, is a fraction of the complexity. If WhatsApp is genuinely required, the **official Business API** is worth pricing. Keep the current client if you must — but keep it **behind the existing clean seam** (`sendDocument()` is one injectable function) so it can be swapped.

**3. Two external services this repo doesn't own.**
The line-art model and the print builder are separate Render apps. The builder in particular is driven by **screen-scraping its DOM** — it has no API. That's a real dependency risk: a CSS-class rename in the builder silently breaks every PDF. If any part of the wider system deserves a real API, it's that one. Worth deciding *during* the migration, not after.

### 8.4 The rebuild checklist — what you cannot cheaply rediscover

Ranked by how expensive it would be to relearn. **This is the section to read if you read nothing else.**

| # | Thing | Why it's expensive |
|---|---|---|
| 1 | `qc.js` solid-fill thresholds (`0.0005`/`0.01`/`0.95`/`128`) | Calibrated on 16 real rasters from order 1523. That set may be gone. |
| 2 | **The 8-step determinism finding + step-count-as-seed** | Only discoverable by running the same request twice and noticing nothing changed. |
| 3 | **"Never name objects in the generator prompt"** | The model invents whatever you name. Counter-intuitive; costs many bad books to learn. |
| 4 | The EXIF re-encode fix | Symptom is "the child came back drawn on their side" — hours to trace to `sharp` not rotating by default. |
| 5 | `deframe()`'s three guards | Each is a distinct production false positive. |
| 6 | **The no-send invariant + where it's enforced** | Enforced by the *absence of an import*. Invisible unless documented. **Getting this wrong emails customers automatically.** |
| 7 | `overrideIntake`'s `confirmCount` + `incompleteBook` | A pure business rule with no technical driver. |
| 8 | `dedication.js`'s rules + `GENERIC_LABELS` | Each learned from a real customer's filename. |
| 9 | Sliding window > hard cursor | The self-lift behaviour breaks *silently* with a cursor. |
| 10 | **`Rozvržení` is the layout signal, not the variant** | The variant *looks* right and is wrong. |
| 11 | `process.exit()` on Windows/Node 24 | 0xC0000409 on every clean run. Pure platform arcana. |
| 12 | `gemini-flash-lite-latest` over `flash-latest` | Sustained 503s that look like an outage. |
| 13 | `imageTimeoutMs` (180s) vs `timeoutMs` (60s) | "This operation was aborted" under load. |
| 14 | The WhatsApp clean-shutdown ↔ QR-rescan link | The most recurring operator pain in the whole project. |
| 15 | `dedications.json` must not live in the outbox | Failure mode is silent and surfaces months later. |
| 16 | `state.json` mtime = the reprint clock (+ `utimesSync` restore) | Two separate bugs (needless reprint; purge-triggers-reprint). |
| 17 | Safety-check-before-cache in `buildOrder` | Ordering-only bug; **silently prints the wrong book.** |
| 18 | `TIGHT_HEADLINE = 34` for `emotivni-darek` | A measured layout fact for exactly one template. |
| 19 | `MARKETING_CAL` (33 occasions + personas + angles) | Marketing content, not code. |
| 20 | **The generator positive/negative prompt pair** | Tuned over many sessions. **Gitignored — will vanish silently.** |
| 21 | `BANNED_STEMS` + the `' ai '` space-padding | Transcribed from the brand guide; the padding is subtle. |
| 22 | The Shopify `ACCESS_DENIED` scope quirk | Requesting `customer{}` fails the *whole* query, not just that field. |
| 23 | The Playwright base-tag ↔ npm-version coupling | Already broke production once. |
| 24 | The two Gemini prepay pools | A top-up into the wrong one looks like it "drains instantly". |

### 8.5 Suggested migration order

1. **Rescue the un-versioned artefacts first** — `config.json`'s generator prompts, the live model/variant values, `dedications.json`. These exist in exactly one place and are gitignored. **Do this before anything else touches the machine.**
2. **Port the pure core with its tests** — `qc`, `inputQc`, `autoCrop`, `dedication`, `manifest`, `brandVoice`, `orders`, `safeFetch`, `retention`, `creatives/studio/*`, `calendar`. These move nearly unchanged and the suite proves it.
3. **Port the seams** — `apiDriver`, `builderDriver`, `aiImage`, `adminClient`. Injectable already; keep them that way.
4. **Rebuild the server** as thin routes over that core. Add a cross-process lock while you're there.
5. **Rebuild the UI** with real tests. Collapse the duplicated `MARKETING_CAL` to one source.
6. **Decide on WhatsApp** (§8.3.2) before porting it — don't port it out of momentum.
7. **Write honest docs last**, from the rebuilt code, not from the old README.

---

*End of extraction. Generated 2026-07-16 at commit `3c5e5fc`. Live secret values: `PROJECT_EXTRACTION.secrets.md` (gitignored).*
