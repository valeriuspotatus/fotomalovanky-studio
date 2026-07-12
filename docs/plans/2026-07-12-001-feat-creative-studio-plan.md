# Fotomalovánky Creative Studio — rebuild plan

Rebuild the `Kreativy` module into a production-grade **Creative Studio**: a campaign
workflow, a reusable asset library, a **deterministic layered template renderer** (AI makes
*assets*; the app assembles the *ad*), 5+ real template families, secure Gemini integration,
QC validation, and batch/ZIP export — integrated into the existing Fotomalovánky OS shell,
Czech UI, English code. Source brief: `Revamped generator.txt`.

## Phase 1 — Audit (done)

**Current implementation (all in `src/creatives/` + `src/ui/`):**
- `creativeTemplate.js` — ONE hard-coded HTML/CSS ad (pastel wash, crayons, logo, before/after
  reveal, headline). `CAMPAIGNS`/`PALETTES`/`FORMATS` are flat presets. This is the "basic form
  over one graphic" the brief rejects.
- `renderCreative.js` — thin Playwright HTML→PNG seam (reused by builder). **Keep** — this is the
  right rendering primitive (deterministic, matches the PDF builder).
- `aiImage.js` — Gemini `callGemini` + `describeImage` (identity-free describe→generate). **Keep** —
  this is the AI seam; wrap it in a job system.
- `adImages.js` — `describeAndGenerate` (customer pixels never reach the image model). **Keep** —
  the privacy invariant is load-bearing.
- Server: `/api/creatives`, `/creative/preview` (iframe HTML), `/creative/render` (PNG download),
  `POST /api/creative/ai-image` (in-memory `creativeImages` map, id→{before,after}). **No
  persistence, no campaigns, no asset library, no editor, no QC, no ZIP.**
- Frontend: `#v-creatives` — a left form + scaled iframe preview. Disposable per the brief.

**Reusable:** `renderCreative.js`, `aiImage.js`/`adImages.js` (as the AI-job seam), the OS design
system (CSS vars in `dashboard.html`), the logo asset (`static/creatives/logo.png`), the Playwright
pattern, the file-based persistence pattern (`autopilotState.js` — JSON in a data dir).

**Disposable:** the single hard-coded template, `CAMPAIGNS`/`PALETTES` as the primary choice axis,
`Rainbow`/`Sunset`/`Sky` as top-level controls, the current `#v-creatives` form.

**Reference ads:** `Our ads/Ad_{1,2,3}_{square,story,wide}.png` (gitignored, may embed licensed
stock). Shared brand language: paper-texture pastel wash · logo lockup top-left · crayons + scribble
strokes · headline bar with one highlighted word. Compositions vary (Ad_1 = seamed before/after;
Ad_2 = scattered tilted photo + coloring-page cards). These drive the template families.

**Marketing briefs already on disk:** `Marketing Automatization/creatives/*-brief.md` +
`*-concepts.json` (christmas, blackfriday, backtoschool, mikulas, together) — reuse as seed campaign
concepts.

## Architecture decisions

1. **Deterministic layered renderer.** A template = ordered list of typed elements (background,
   decoration, logo, image-slot, text, badge, cta) each with a box (x/y/w/h in canvas units),
   constraints (min/max size, safe area, layer, locked, allowed asset type, text-length cap), and
   per-format layout overrides. Rendered to self-contained HTML/CSS → `renderCreative.js` → PNG.
   Preview (iframe) and export share ONE render path so they always match. **Never** an AI-flattened
   final ad.
2. **Data model** (file-based JSON under a configurable `creatives.dataDir`, default outside repo
   like the autopilot — reference photos can be PII): `Campaign`, `Asset`, `Template` (code-defined,
   not user data), `CreativeConcept`, `CreativeFormat`, `GenerationJob`, `GeneratedAssetVersion`.
   Original files preserved; generated versions stored separately; thumbnails cached.
3. **AI seam.** Wrap `describeAndGenerate`/`generateMarketingImage` in a `GenerationJob` runner
   (status/progress/retry/version history). Key stays server-side (already: `config.ai`, never in the
   browser). Add a settings surface: connection status + test request + model + key-config help.
4. **Security invariants preserved:** API key server-only; customer pixels never reach the image
   model (describe→generate); no fabricated discounts/reviews/deadlines (copy AI is constrained +
   warned); `config.json` stays gitignored.
5. **Integration, not a standalone demo.** New view replaces `#v-creatives` in the same shell/nav;
   reuses the OS chrome, toasts, routing. No other module touched.

## Build sequence (each phase = a shippable, tested increment)

- **P2 Foundation** — data model + JSON persistence (`src/creatives/studio/{campaigns,assets,store}.js`)
  + server CRUD endpoints + new `#v-creatives` shell (step rail: Zadání·Podklady·Šablona·Texty·
  Varianty·Export; canvas; contextual right panel; variants strip) + campaign list + save states +
  empty/error states. Tests: persistence, save/reload, deletion, filename gen.
- **P3 Deterministic renderer** — element/template model + HTML/CSS layout engine + per-format
  layout + accurate PNG export + text-overflow detection. Must work with zero AI. Tests: render
  dimensions, format conversion, overflow, element overrides.
- **P4 Template families** — 5 real families rebuilt from the reference ads: Proměna, Emotivní
  dárek, Společné vybarvování, Produktová ukázka, Reference zákazníka (+ seasonal styling as an
  extension). Colour themes demoted to secondary styling within a template.
- **P5 Gemini integration** — `GenerationJob` runner, image variation/background/reframe, progress,
  retry, version history, secure settings + connection test.
- **P6 Campaign generator** — brief → strategically different concepts (angle/layout/visual/copy),
  multi-concept + multi-format output, per-concept rationale. Copy model (headline/support/CTA/
  badge/offer/testimonial) + constrained AI copy actions.
- **P7 QC + export** — validation (overflow, safe zone, logo size, missing asset, low-res, cropped
  face/product…), Připraveno/Varování/Nedokončeno status, PNG/JPG, all-formats, ZIP, useful
  filenames (`fotomalovanky_<occasion>_<angle>_<format>_NN.png`).

## MVP priority (per brief)

Reliability first: campaign workflow → asset management → deterministic renderer → 5 excellent
templates → accurate export → editing → secure Gemini → multi-concept → QC → batch export. Do not
trade renderer/editor reliability for shallow AI features.

## Testing

`node --test` for: persistence + save/reload, template rendering, format conversion, overflow
detection, asset replacement, export dimensions, API-key security boundary, Gemini error handling,
variant duplication, campaign deletion, filename generation. Manual: 1920×1080 + 1366×768, console
clean. Extend `tools/studioSmoke.mjs` for the new view. Do not declare done with broken buttons,
placeholder controls, console errors, missing empty states, export mismatches, or browser-exposed
secrets.

## Cleanup / docs (final)

Remove the old single-template module + dead Rainbow/Sunset/Sky controls once the replacement works;
no two competing implementations. Add `docs/creative-studio.md` (architecture, how to add a template,
asset storage, Gemini key config, export) + a changelog of removed/replaced/added.

## Risks / notes

- Scope is large (mini design tool) — delivered as phased, independently-useful increments; P3
  renderer is the backbone and lands before AI.
- Reference ads may embed licensed stock → rebuild *composition*, never ship the reference pixels.
- Fonts: the ads use a rounded display face (Fredoka not self-hosted). Self-host the display + body
  fonts as data URIs so export is deterministic and preview==export.
