# Fotomalovánky Creative Studio — reference-grounded UPGRADE plan

David's punch-list #9. This is **not a rebuild** — the Creative Studio already exists and is committed
(the earlier `2026-07-12-001` rebuild plan is DONE). This plan grounds a targeted **upgrade** in David's
real reference archive (see [[creatives-reference-material]]) and his 2026-07-14 goals, against what's
actually on disk today.

## What already exists (do NOT rebuild)

Under `src/creatives/studio/`: `formats.js` (feed 1:1, story 9:16, landscape 1.91:1, portrait 4:5
*defined but not yet used by templates*), `templateModel.js` (element/box model, percent boxes +
per-format overrides, QC → pripraveno/varovani/nedokonceno, `creativeFilename`), `brandKit.js`
(themes + crayon/scribble/sun/sparkle + logo/wordmark), `templates.js` (5 families: promena,
emotivni-darek, spolecne-vybarvovani, produktova-ukazka, reference-zakaznika + SEED_COPY),
`renderStudioHtml.js`. Plus the calendar pipeline: `calendar.js` (`MARKETING_CAL`), `adCopy.js`
(Gemini Czech copy per template), `adCalendar.js` (per-occasion ad mix → PNGs in `creatives.dataDir`).
Server `/api/studio/*` + `/api/creatives/calendar`; UI `#v-creatives` (family/format/theme picker +
live preview + QC + export + calendar gallery). 496 tests + 42 smoke green. Renderer is deterministic:
preview iframe == PNG export (one path). AI seam keeps the customer-pixels-never-reach-the-image-model
invariant. **All of this stays** — we upgrade it, we don't replace it.

## David's 4 goals → the concrete gaps

The architecture is right; the gap is fidelity + reach. Reading `templates.js` against the reference
catalogue and the brand docs:

### Goal 1 — Image quality/realism
- **Coloring slot = current generator, not old ComfyUI.** `adCalendar.js` builds the `coloring` asset
  by describing a text scene → line-art. The old ComfyUI look is not the quality bar
  ([[generator-recipe]]). Feed the coloring slot the **current generator's** output (Qwen 2511 +
  universal prompt), and support two line-art **style presets** ("Evans Normal" realistic / "Evans
  Easy" cartoon), each a paired positive+negative prompt with the hard rules (aspect-ratio lock,
  closed/enclosed outlines, enclosed foliage, no shadows/reflections/grayscale, simplified child
  faces, white bg). Scene/`original`/`lifestyle` images stay identity-free via `describeAndGenerate`.

### Goal 2 — Simpler/faster workflow
- Calendar generation runs only via the `_gencal.mjs` CLI → add an **in-UI trigger** (generate / regen
  an occasion, with progress). Add **P2 persistence** (save/reload campaigns — today concepts are
  edit-live only) and **asset uploads** (drop a real photo/product into a slot). Add **ZIP / all-format
  batch export**. These are the studio's known-TODO items, now prioritized by the "less manual" goal.

### Goal 3 — Better copy
- `adCopy.js` writes decent per-template Czech copy but doesn't use the brand playbook or enforce the
  trust rules. Upgrade it into a **copy engine** seeded from the knowledge base and guarded:
  - **Knowledge base:** the **E1–E22** evergreen creatives (real headlines), tagline tiers, 5 headline
    formulas, CTA patterns, personas × the `MARKETING_CAL` occasions, funnel stage. From
    `Fotomalovanky/fotomalovanky md files od lukase/*`.
  - **Hard guards (load-bearing, at the output boundary — not just the prompt):** banned-word filter
    (AI, algoritmus, neuronka, generování, renderování, personalizovaný produkt; levný, sleva, akce,
    výprodej; zabavení dítěte) and **no fabricated proof/offers** (real testimonials only, real numbers
    "2000+ fotek" only, never invent %/stars/deadlines).
  - **Channel formality:** vykání for web/email/B2B, tykání for ads/social — a generator input.
  - Optional two-step brainstorm→generate + JSON output schema (port the Koolman `.ts` skeleton — a
    different brand, architecture only). Keep the seed-copy fallback on a bad response.

### Goal 4 — More formats & templates
- **Enable `portrait` 4:5 (1080×1350) — the brand's PRIORITY ad size.** Add it to each template's
  `supportedFormats` + per-format `box` overrides; add to `DEFAULT_FORMATS`.
- **Rework templates to match the strongest reference compositions** (the current families are sound
  architecture but generic-looking vs the real ads):
  - **A — `promena` → the flagship taped diptych.** Today it's a card with two side-by-side images +
    a headline pill. Upgrade to the sourozenci look: **tilted photo + coloring cards with yellow
    washi-tape strips, a hand-drawn orange before→after arrow, white headline card w/ logo lockup.**
    Reflow: feed = photo TL / coloring BR / arrow center / card bottom; story = vertical stack
    photo·card·coloring (arrow dropped, logo below headline); wide = coloring L / photo R / arrow /
    bottom strip — **consistent photo→coloring reading order across formats** (catalogue flagged the
    square↔wide flip as a bug to fix).
  - **B — NEW `odhaleni` (split-reveal).** Single square panel split by a black line: colour photo |
    line-art of the **same** shot, a photoreal teal-pencil hand over the line-art half. Panel stays
    square in every format; text card moves to a bottom strip. **Constraint:** one source image split
    in the renderer (never two slots) so the halves always match — mismatched halves read as a bug.
  - **C — `produktova-ukazka` → real flatlay.** Make it the "printed page on a desk, real pencils,
    hand mid-colour, page partly coloured" social-proof shot (composes over a supplied/generated
    flatlay asset), not just a framed product image.
  - **D — NEW `kampan` (promo + CTA).** The Frame-209 arrangement: top headline + subhead, diagonal
    photo/line-art split, logo bottom-left, **red CTA button** bottom-right (real deadline only when
    one exists). Most conversion-ready; hosts seasonal skins + a REAL-testimonial variant.
- **Brand kit alignment:** map themes to the 5 exact brand palettes (warm `#F5A623`/`#FFF5E6` main;
  peach; purple `#6C5CE7` pop; blue `#4A90D9`; off-white) — warm=family, cool=couples/modern. Add the
  **washi-tape**, **orange-arrow**, and faint **art-supply doodle-pattern** decorations to `brandKit.js`
  (today it has crayon/scribble/sun/sparkle only). Keep text ≤20%, ≤2 fonts, logo present-not-dominant.
  Self-host the display font (Fredoka/Baloo) as a data URI so preview==export stays exact.

## Element-box specs (starting point, from the visual catalogue)

Boxes as % of canvas [x,y,w,h]; tune during P-render. (Full table in
[[creatives-reference-material]] / the catalogue.)
- **A feed:** photo 3,5,49,42 (tilt -4°); coloring 44,22,53,41 (tilt +3°, black keyline); arrow
  42,44,10,14; text card 8,66,84,27 (headline top-left, logo bottom-left); tape at each card's top.
- **A story:** photo 14,6,73,34 / card 9,42,84,15 (logo below headline) / coloring 14,60,72,33; no arrow.
- **A wide:** coloring 5,8,42,48 / photo 53,12,41,48 / arrow 47,30,8,10 / bottom strip 0,62,100,38.
- **B:** square split panel (feed 14,7,66,46; story 7,19,80,39; wide 30,6,40,56), pencil hand enters
  from the right onto the line-art half, text card as bottom strip.
- **C:** text card overlaps top 10,2,80,20; flatlay photo 0,22,100,60; brand band bleeds top/bottom.
- **D:** headline 6,4,88,7; subhead 10,11,80,5; diagonal split panel 9,19,82,63; logo 5,87,35,9;
  red CTA 58,87,35,9.

## Build sequence (each phase shippable + tested, on the working base)

- **U1 — 4:5 format + brand-kit alignment.** Add `portrait` to `DEFAULT_FORMATS` and every template's
  overrides; map the 5 exact palettes; add tape/arrow/doodle-pattern decorations + self-hosted font.
  Tests: each existing template renders valid in portrait; palette/decoration snapshots.
- **U2 — Template A flagship upgrade.** Rebuild `promena`'s composition (tape + arrow + tilt + headline
  card) with consistent cross-format order. Regen a sample calendar occasion to confirm the whole
  calendar lifts. Tests: render in 4 formats, safe-area, overflow.
- **U3 — New templates B (odhaleni) + D (kampan) + C flatlay.** Add the two families + rework C.
  Tests: same-subject split invariant (B), CTA/deadline only-when-real (D), render + QC each.
- **U4 — Copy engine.** Upgrade `adCopy.js`: knowledge base (E1–E22, taglines, formulas), banned-word
  + no-fabrication guards at the output boundary, channel vykání/tykání, seed fallback. Tests:
  banned-word rejection, testimonial-must-be-real, channel formality, schema/caps, seed fallback.
- **U5 — Image quality.** Coloring slot from the current generator; two line-art style presets;
  scene-gen tuning. Tests: preset prompt selection, identity-free path preserved, asset-type routing.
- **U6 — Workflow.** In-UI calendar trigger (generate/regen + progress), P2 persistence (save/reload),
  asset uploads into slots, ZIP/all-format export. Tests: persistence CRUD, upload routing, ZIP, filenames.

## Testing

`node --test` extends the existing suite (keep 496 green): portrait render, new templates + invariants,
copy guards, persistence, export. All AI/network seams injected — never hit Gemini. Manual: regen a
calendar occasion end-to-end, confirm preview==export, console clean, no browser-exposed secrets;
extend `tools/studioSmoke.mjs`.

## Risks / notes

- **Don't regress the working studio** — every phase keeps the existing tests green and the
  deterministic preview==export invariant.
- **Reference ads may embed licensed stock** → rebuild *composition*, never ship reference pixels;
  archive stays gitignored.
- **Copy guards are the trust boundary** — enforce banned-word + no-fabrication at the output layer.
- **Template C is photographic** — needs a real/generated flatlay asset; lower priority than A/B/D.
- **Fonts:** self-host Fredoka/Baloo as data URIs before shipping the flagship, or the tape/arrow look
  drifts between preview and export.
