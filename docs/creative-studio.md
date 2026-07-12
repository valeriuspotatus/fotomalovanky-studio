# Creative Studio

The **Kreativy** tab is a local-first tool for producing Fotomalovánky advertising creatives.
Its one architectural rule (from `Revamped generator.txt`):

> **AI generates or modifies the visual assets. A deterministic design engine assembles the final
> advertisement.**

Gemini / Nano Banana Pro makes *images* (lifestyle photos, the "before" marketing shot). The app —
never the AI — places the logo, the images, the Czech copy, the badge and the CTA from a layered
template. The finished ad is therefore deterministic: the on-screen preview and the exported PNG are
the exact same pixels, and text stays editable.

## Architecture

```
src/creatives/studio/
  formats.js          Output formats (Feed 1:1, Story 9:16, Landscape 1.91:1, + Portrait 4:5 ready),
                      each with a pixel size and a safe-zone inset.
  brandKit.js         The brand palette, paper-wash themes, and the hand-drawn decoration atoms
                      (crayon / scribble / sun / sparkle), the drawn logo/wordmark fallback, and the
                      starburst badge. Pure SVG strings.
  templateModel.js    The element/template model + geometry + QC. Boxes are PERCENTAGES of the canvas
                      with per-format overrides. resolveTemplate / boxToPx / validateConcept /
                      creativeFilename. No IO.
  templates.js        The 5 template families (data) + SEED_COPY + listTemplates() for the UI.
  renderStudioHtml.js A template + copy + assets -> one self-contained HTML document.

src/creatives/renderCreative.js   The one Playwright seam: HTML -> PNG (shared with the PDF builder).
src/creatives/aiImage.js          Gemini call + identity-free describe.
src/creatives/adImages.js         describeAndGenerate: the "before" marketing photo + "after" line-art.
```

Server endpoints (in `src/ui/server.js`):

| Route | Purpose |
|-------|---------|
| `GET /api/studio/templates` | families (+ slots, fields, char limits, seed copy), themes, formats, `aiEnabled` |
| `GET /studio/preview?…` | the layered concept as HTML for the `<iframe>`; `X-Studio-Status` header carries the QC verdict |
| `GET /api/studio/validate?…` | QC findings for the current concept |
| `GET /studio/render?…` | the concept rasterised to a PNG download, named per the export scheme |
| `POST /api/creative/ai-image` | generate the before/after image pair (the only route that spends money) |

The whole engine is pure and unit-tested (`test/creativeStudio.test.js`); the AI seam and the preview
integration are tested with an injected fake (`test/creativeServer.test.js`); the browser flow is in
`tools/studioSmoke.mjs`.

## How a template works

A template is an ordered list of typed, boxed elements:

```js
{
  id: 'promena', family: 'Proměna', theme: 'rainbow',
  supportedFormats: ['feed', 'story', 'landscape'],
  elements: [
    { id: 'bg', type: 'background', layer: 0, box: { x: 0, y: 0, w: 100, h: 100 } },
    { id: 'headline', type: 'text', field: 'headline', hiField: 'headlineHi', layer: 10,
      box: { x: 13, y: 72, w: 74, h: 16 },        // PERCENT of the canvas
      style: { pill: true, fontSize: 58, align: 'center' },
      constraints: { maxChars: 44, maxLines: 2 },
      formats: { story: { box: { x: 8, y: 73, w: 84, h: 13 }, style: { fontSize: 74 } },
                 landscape: { box: { x: 3, y: 38, w: 42, h: 40 }, style: { align: 'left' } } } },
    // …
  ],
}
```

- **Element types:** `background`, `panel` (a rounded card), `image` (bound to a `slot`), `text`
  (bound to a copy `field`, optional `hiField` for the highlighted word), `cta`, `badge`, `logo`,
  `decoration` (a named brandKit doodle).
- **Boxes are percentages** so a base layout already adapts across ratios; `formats.<fmt>` overrides
  the box/style/visibility where a straight percentage would break hierarchy. A format change is a
  re-layout, never a stretch.
- **Constraints** drive QC: `required`, `maxChars`, `maxLines`, `minW` (logo), `allowBleed`.

### Adding a new template family

1. Add a template object to `TEMPLATES` in `src/creatives/studio/templates.js`, with `feed`/`story`/
   `landscape` layouts (base box + per-format overrides).
2. Add its `SEED_COPY` entry (meaningful default copy for every bound field).
3. Render it to check the layout: `node _renderStudioSamples.mjs <outdir>` (or add a case there).
4. It appears in the picker automatically (via `listTemplates()`); no UI change needed.

Keep it to a few excellent families rather than many weak ones. Colour themes are a **secondary**
styling option (`template.theme` + the theme chips), never the primary creative choice.

## Assets

Marketing imagery comes from the AI seam, **never from customer orders** (the studio ignores any
`order`/`before` query params). Today the AI "before" marketing photo fills the `original` and
`lifestyle` slots and the "after" line-art fills the `coloring` slot. Uploaded product/lifestyle
assets and a persisted asset library are a planned extension (see below).

## Gemini key configuration

The key is **server-side only** — it lives in `config.json` under `ai` and is never sent to the
browser:

```json
"ai": {
  "enabled": true,
  "apiKey": "…",
  "model": "gemini-3-pro-image-preview",
  "describeModel": "gemini-flash-latest",
  "endpoint": "https://generativelanguage.googleapis.com/v1beta",
  "timeoutMs": 60000
}
```

`config.json` is gitignored. When `ai.enabled` is false the AI button reports "not configured" and the
rest of the studio still works with placeholders. The customer's pixels never reach the image model:
in auto mode the photo is first described into an identity-free prompt, and the image is generated from
that text alone.

## Export

`GET /studio/render` screenshots the concept HTML to a PNG sized exactly to the format, named
`fotomalovanky_<occasion>_<angle>_<format>_NN.png`. "Všechny formáty" downloads each selected format.

## Quality control

`validateConcept` returns a status (`pripraveno` / `varovani` / `nedokonceno`) and clickable findings:
missing required copy or asset (error), text overflow, safe-zone breach, logo too small (warning). The
studio shows this as the **Kontrola** pill; warnings jump to the field they concern.

## Known limitations / next improvements

- **No persistence yet.** Concepts are edited live; there is no saved campaign list, autosave, or
  reopen. The data model in the brief (Campaign / Asset / Concept / GenerationJob) is the next phase.
- **No asset library.** Uploads aren't stored; product/lifestyle slots rely on the AI "before" image.
- **Single concept at a time.** The "generate a whole campaign of strategically different concepts"
  and the AI copy actions (Zkrátit / Více emotivní / …) are not built yet.
- **No ZIP / batch approval.** "Všechny formáty" downloads separate PNGs.
- **Fonts** use the rounded system fallback (Fredoka not self-hosted); preview == export, but not the
  exact display face. Self-hosting the display + body fonts as data URIs is a small follow-up.
