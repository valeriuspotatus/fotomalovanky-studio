# Architecture - Fotomalovánky Blog Creation System (v1)

A local, CZ-only system that turns a topic or calendar event into a complete,
Shopify-ready blog draft for manual copy-paste. No Shopify API. No publishing.
No external credentials. No fabrication.

## Design goals

1. **Brand-safe by construction.** Voice rules and a hard "no invented facts"
   policy are baked into the prompts and re-checked after generation.
2. **Event-aware.** Blog ideas can be anchored to a Czech calendar event, with
   relevance logic that knows when it is time to publish for that event.
3. **Manual handoff.** Output is a structured `BlogPackage` you paste into
   Shopify as a hidden/draft article. David publishes manually after review.

## Data flow

```
            (you pick a date / topic / event)
                          |
                          v
   calendar-events.ts  -> getRelevantEvents(date)          # what is coming up
                       -> recommendBlogIdeasForEvent(id)   # seed ideas (no LLM)
                          |
                          v
   blog-prompts.ts     -> buildBrainstormBlogPrompt(input) # -> paste into LLM
                          |   (LLM returns ideas JSON)
                          v
                       pick one BlogIdea
                          |
                          v
   blog-prompts.ts     -> buildGenerateBlogPrompt(input)   # -> paste into LLM
                          |   (LLM returns BlogPackage JSON)
                          v
   blog-quality-checker.ts -> runQualityChecks(pkg, source) # warnings + gate
                          |
                          v
   drafts/  ->  replace every [OVĚŘIT]  ->  MANUAL_SHOPIFY_WORKFLOW.md
```

The LLM step is manual on purpose: you copy the prompt into ChatGPT / Claude /
Gemini, paste the JSON back, and save it locally. Nothing here calls a network.

## Modules (`src/`)

| File | Responsibility |
|---|---|
| `blog-types.ts` | All TypeScript types, incl. `SourceMaterial` and `BlogPackage`. |
| `fotomalovanky-brand.ts` | Machine-usable mirror of BRAND GUIDE.md: voice, personas, taglines, forbidden words. |
| `blog-constants.ts` | Journey stages, search intents, seasons, SEO rules, `STRICT_CONSTRAINTS`. |
| `calendar-events.ts` | CZ event array + `getRelevantEvents`, `recommendBlogIdeasForEvent`. |
| `blog-prompts.ts` | `buildBrainstormBlogPrompt`, `buildGenerateBlogPrompt`. |
| `blog-quality-checker.ts` | `runQualityChecks`, `summarizeWarnings`. |
| `example-inputs.ts` | Demo inputs (placeholder source material). |
| `index.ts` | Barrel exports + local `demo()` and `validateBlogPackage()`. |

## Anti-fabrication design

The single most important rule: **the generator may only state facts present in
`SourceMaterial`.** Everything else becomes a literal `[OVĚŘIT]` placeholder.

Two layers enforce this:

1. **Prompt layer** - `STRICT_CONSTRAINTS` + the source-material block tell the
   model exactly which facts exist and to mark the rest `[OVĚŘIT]`.
2. **Checker layer** - `runQualityChecks` strips `[OVĚŘIT]` placeholders, then
   scans for numbers, reviews, prices, delivery claims, and paper claims that
   are NOT backed by `SourceMaterial`, and flags forbidden words, em dashes,
   exclamation overuse, weak SEO, missing CTA/links, and forced seasonality.

Severity gate: any `block`-level warning means do not publish until fixed.

## Relationship to existing files (read-only)

- **BRAND GUIDE.md** is the source of truth. `fotomalovanky-brand.ts` mirrors it;
  if they ever disagree, the guide wins and the mirror is corrected.
- **koolman social.ts.txt** and **koolman marketing calendar.ts.txt** are
  STRUCTURAL references only. We reused their architecture (prompt builders,
  strict constraints, event schema), not their skincare content.
- **DE docs** are future-only context and are not used by v1.

See [SOURCE_CLASSIFICATION.md](SOURCE_CLASSIFICATION.md) for the full map.
