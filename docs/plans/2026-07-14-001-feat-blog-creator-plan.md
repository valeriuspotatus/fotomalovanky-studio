# Fotomalovánky Blog Creator — plan

A new left-nav **Blog** module that writes SEO-optimized Czech blog posts for the Shopify store
and pushes each one to Shopify **as an unpublished draft** for David to review and publish. Topics
come from the **marketing calendar** (upcoming occasions) plus **AI SEO suggestions tuned to the
current moment** (season / what's coming up). Reuses the existing `config.ai` Gemini seam (text +
identity-free image) and the file-based persistence pattern; English code, Czech UI.

Source: David's punch-list #8 (2026-07-14). Decisions locked with David:
- **Publish path:** draft into Shopify (a `write_content` token; the post is created *unpublished*;
  David reviews in Shopify admin and hits Publish). Never auto-publish live.
- **Topics:** marketing-calendar occasions **and** hot SEO suggestions that depend on where we are
  right now (current date → upcoming occasions/season → concrete keyword-led topics).

## What it does (requirements)

1. **Topic engine — two sources, one ranked list.**
   - *Calendar-anchored:* the next N `MARKETING_CAL` occasions (default window ~8 weeks) become
     candidate angles (each already carries `persona` + `angle` + `tone`).
   - *SEO suggestions:* a Gemini text step seeded with today's date, the upcoming occasions, and the
     niche (personalized coloring pages / photo gifts) proposes concrete, high-intent Czech blog
     topics, each with a **target keyword** and a one-line search-intent rationale, ranked by
     timeliness. This is the "hot right now" half.
   - David can also type his own topic/keyword (free-text box) — same downstream flow.
2. **Draft generation.** From a chosen topic the app writes a full, SEO-structured Czech post:
   - SEO title (≤60 chars), meta description (≤155), URL handle/slug (keyword in it), tags.
   - H1 + structured body: intro with the keyword in the first ~100 words, H2/H3 sections, short
     paragraphs, at least one bullet list, a short **FAQ** block, and a CTA linking to the shop.
   - One **internal-link suggestion** (to a product/collection) surfaced for David to place.
   - ~800–1500 words (configurable). Optional **hero image** via the existing identity-free Gemini
     image generator, with alt text.
3. **Review + edit.** The generated post renders in the UI; David can edit title/meta/slug/body/tags,
   regenerate a single section, or regenerate the hero image before saving.
4. **Publish → Shopify draft.** "Uložit do Shopify jako koncept" creates the article in the chosen
   Shopify blog **unpublished** (title, body HTML, SEO title/description, handle, tags, author, hero
   image + alt). David reviews and publishes from Shopify admin. If the send fails (missing scope,
   network), the post stays local with a visible error + retry — never silently lost.
5. **Persistence + status.** Posts are stored file-based under a data dir (outside the repo, same as
   creatives/autopilot), each with a status: `koncept` (local) → `odesláno` (pushed to Shopify as
   draft) → `publikováno` (David published it). David can resume any draft.

## SEO baked in (not an afterthought)

Target keyword in title + H1 + first 100 words + meta + slug; scannable structure (H2/H3, short
paras, lists); a FAQ block (rich-result friendly); descriptive alt text; one internal link; natural
Czech, no keyword stuffing. A lightweight QC pass flags: missing keyword in title/H1/meta, title or
meta over length, body too short, no internal link, no alt text — shown as warnings, non-blocking.

## Architecture

- **`src/blog/topics.js`** — `suggestTopics({ now, calendar, generateTextFn, config })`: merges the
  calendar window with the AI SEO suggestions into a ranked `[{ title, keyword, intent, source,
  occasionKey? }]`. Pure orchestration over the injected Gemini text fn (testable with a fake).
- **`src/blog/draft.js`** — `generatePost({ topic, generateTextFn, config })`: builds the SEO prompt,
  parses the model's strict JSON into `{ seoTitle, metaDescription, handle, tags[], bodyHtml, faq[],
  internalLinkHint, heroPrompt }`, clamps each field to its cap, runs the QC pass. Falls back to a
  sensible skeleton on a bad model response so a draft always exists to edit. Mirrors the
  `adCopy.js` clamp/JSON-loose/seed-fallback pattern.
- **`src/blog/store.js`** — file-based CRUD for local drafts + a `blog-index.json`, under
  `config.blog.dataDir` (outside repo). Same shape as the autopilot/creatives stores.
- **`src/shopify/content.js`** — the write seam. `listBlogs()` and `createArticleDraft({ blogId,
  post })` over the Admin API (GraphQL `articleCreate` on the `2026-07` version; article created
  with `isPublished: false`). Separate file from `orders.js`/`adminClient.js` so the read-only orders
  path is untouched; uses the content token (see config).
- **Server:** `GET /api/blog/topics`, `POST /api/blog/draft`, `GET|POST|DELETE /api/blog/posts`,
  `GET /api/blog/blogs`, `POST /api/blog/publish` — thin handlers over the modules above.
- **UI:** new nav item **Blog** → `#v-blog`: (1) topic list (calendar + SEO, with keyword + intent
  chips) + free-text box; (2) draft editor (title/meta/slug/body/tags/hero, with per-section
  regenerate + QC warnings); (3) "Uložit do Shopify jako koncept" + status chip. Reuses the OS
  shell/toasts/routing — no other module touched.

## Config

New `blog` block (validated like the others in `config.js`), plus a Shopify content credential:
- `blog.enabled` (default false — the tab shows a "not configured" state until on).
- `blog.dataDir` — absolute, outside repo (guarded like `shopify.dataDir`).
- `blog.blogId` — the target Shopify blog (or picked in the UI from `listBlogs()`; persisted).
- `blog.author` — default article author name.
- `blog.wordCountMin`/`Max`, optional model overrides (else reuse `config.ai`).
- **Content token:** cleanest is to **add the `write_content` scope to the existing custom app** and
  reuse the one token (David re-generates it once). If David prefers to keep the read-only orders
  token narrow, support a separate `shopify.contentToken` / `FMA_SHOPIFY_CONTENT_TOKEN` env var —
  the content seam reads that first, falling back to the orders token. Validation: if `blog.enabled`
  and no usable content token, a clear error (not a silent 403 at publish time).

## Build sequence (each phase shippable + tested)

- **P1 — Topic engine.** `topics.js` + `blog` config block + `GET /api/blog/topics` + the topic-list
  UI (read-only). Tests: calendar window selection around a fixed `now`, merge/rank shape, AI-fail
  fallback to calendar-only.
- **P2 — Draft + editor.** `draft.js` + `store.js` + draft/CRUD endpoints + editor UI + QC warnings +
  optional hero image (reusing `adImages.js` describe→generate is N/A here; use
  `generateMarketingImage` from a text hero prompt). Tests: post JSON parse + field caps, QC flags,
  store save/reload/delete, seed fallback.
- **P3 — Shopify publish.** `src/shopify/content.js` (`listBlogs` + `createArticleDraft`, unpublished
  invariant) + `/api/blog/blogs` + `/api/blog/publish` + publish UI + status transitions + failure
  retry. Tests: article payload shape, `isPublished:false` invariant, missing-scope → clear error,
  status transition local→odesláno.
- **P4 — Polish + docs.** Regenerate-section, internal-link surfacing, alt text, richer QC; a
  `docs/blog-creator.md` (how topics are chosen, the SEO contract, token/scope setup, publish flow).

## Testing

`node --test` for topic selection, post generation + caps + QC, store CRUD, and the Shopify content
payload (esp. the unpublished-draft invariant and the token-missing error path). All network seams
injected — tests never hit Shopify or Gemini. Manual: generate → edit → push a real draft, confirm it
lands **unpublished** in Shopify admin, then publish by hand.

## Risks / notes

- **`write_content` scope is David's one manual step** — until the custom app has it (or a content
  token is set), publish is disabled with a clear message; everything up to publish still works.
- **No fabricated claims** — same guardrail as the ad copy: the post must not invent fake reviews,
  discounts, or deadlines; the prompt forbids it and QC has no way to add them.
- **Draft-only invariant is load-bearing** — the content seam always creates articles unpublished;
  auto-publish is intentionally not built, so nothing goes live without David.
- **Handle/slug collisions** — Shopify rejects a duplicate handle in a blog; on that error, surface it
  and let David tweak the slug (don't silently mangle it).
