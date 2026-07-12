# Creative Studio rebuild — changelog

Rebuild of the `Kreativy` module per `Revamped generator.txt`. The old module was "a basic form
controlling one hard-coded graphic"; the new one is a deterministic layered template engine where the
app assembles the ad and the AI only makes the images.

## Added

- `src/creatives/studio/formats.js` — output formats + safe zones.
- `src/creatives/studio/brandKit.js` — palette, paper-wash themes, hand-drawn decoration atoms, logo
  fallback, starburst badge.
- `src/creatives/studio/templateModel.js` — element/template model, per-format geometry, QC
  (`validateConcept`), `creativeFilename` + `slugify`.
- `src/creatives/studio/templates.js` — 5 real template families (Proměna, Emotivní dárek, Společné
  vybarvování, Produktová ukázka, Reference zákazníka) + seed copy.
- `src/creatives/studio/renderStudioHtml.js` — the layered HTML renderer.
- Server: `GET /api/studio/templates`, `GET /studio/preview`, `GET /api/studio/validate`,
  `GET /studio/render`.
- UI: `#v-creatives` rebuilt — template family picker, format tabs, theme chips, dynamic structured
  copy fields with live character counters, live layered preview, Kontrola (QC) pill with clickable
  findings, PNG + all-formats export.
- Tests: `test/creativeStudio.test.js` (engine + endpoints); browser checks in `tools/studioSmoke.mjs`.
- Docs: `docs/creative-studio.md`.

## Replaced

- The single hard-coded ad composition → 5 layered template families, each laid out per format.
- The `Kampaň` dropdown + `Rainbow`/`Sunset`/`Sky` as the primary controls → a **template family** as
  the primary axis, with colour themes demoted to secondary styling.
- Two generic text inputs → a structured copy model (headline, highlight, support, CTA, badge,
  testimonial, …) bound per template, with character limits.
- `test/creativeServer.test.js` now covers the kept AI-image seam against the new studio preview.

## Removed

- `src/creatives/creativeTemplate.js` — the hard-coded template engine (`CAMPAIGNS`, `PALETTES`,
  `renderCreativeHtml`, `creativeFromCampaign`).
- Server endpoints `GET /api/creatives`, `GET /creative/preview`, `GET /creative/render` and the
  `creativeFieldsFrom` helper.
- `generateCreative` from `src/creatives/renderCreative.js` (the multi-format helper over the old
  template); `renderCreativePng` stays.
- `tools/creativeSample.mjs` and `test/creativeTemplate.test.js`.

## Kept

- `src/creatives/renderCreative.js` (`renderCreativePng`) — the Playwright HTML→PNG seam.
- `src/creatives/aiImage.js`, `src/creatives/adImages.js`, `POST /api/creative/ai-image` — the AI image
  seam and its identity-free describe→generate privacy invariant.
- The real brand logo (`static/creatives/logo.png` → `CREATIVE_LOGO_URI`).

## Not yet built (next phases)

Campaign persistence + list, asset library + uploads, multi-concept campaign generation, AI copy
actions, ZIP/batch export, self-hosted fonts. See "Known limitations" in `docs/creative-studio.md`.
