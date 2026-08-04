# Blog Creator

A **Blog** module (left nav) that writes SEO-optimized Czech blog posts and pushes each one to Shopify
as an **unpublished draft** for David to review and publish by hand. Nothing ever goes live from here.

## How topics are chosen

`GET /api/blog/topics` returns one ranked list from three sources (`src/blog/topics.js`), in this order:

1. **The curated keyword map** (`src/blog/keywordMap.js`) — the queries we decided to target, written
   down by hand. Each entry carries a `cluster` (the internal-linking group), an `articleType`
   (`printable` / `gift` / `trust`, which picks the draft template), a `priority` and an optional
   `season`. A seasonal entry inside the 8-week window ranks by how close it is; everything else ranks
   by priority. **Priorities are corrected from Search Console, never guessed** — every seed sits on
   the neutral `2` until someone reads the data.
2. **Calendar-anchored** — the upcoming `MARKETING_CAL` occasions within an 8-week window, soonest
   first. Each carries the occasion's `persona`/`angle`/`tone`, so the topics are already on-brand and
   timely. Needs no AI.
3. **AI keyword suggestions** — *opt-in, off by default* (`blog.aiTopics: true`). A Gemini step
   proposes Czech topics for today's date. It has no volume data behind it, so it invents plausible
   keywords nobody types — that's why it moved behind a flag and below the curated map. Best-effort:
   a model failure just drops this third.

The map alone guarantees the picker is never empty. David can also type a **free-text topic**
(+ optional keyword) — same downstream flow.

## The SEO contract (enforced in code, not left to the model)

`src/blog/draft.js` asks the model for **structured JSON** (intro + sections + FAQ), never raw HTML,
then assembles the body HTML deterministically so the heading hierarchy, lists, FAQ block and shop CTA
are consistent. Each field is clamped (SEO title ≤ 60, meta ≤ 155, slug slugified) and a bad model
response falls back to an editable skeleton — a draft always exists.

Every prompt is grounded in `src/blog/productFacts.js` — the real prices, formats, page counts,
process and delivery times, read off the live shop. The model is told those numbers are verified and
that **anything not in the list does not go in the article**. Facts that couldn't be checked live in
`OPEN_FACTS` as `TODO(David):` questions and are deliberately *never* injected into a prompt.

### Article types

`topic.articleType` picks the template:

- **`printable`** — a lead-magnet page for someone who wants pages to print right now: short intro,
  what's in the set (from `topic.setDescription`), how to print (A4, 100 % scale), a paragraph that is
  exactly `{{KLAVIYO_FORM}}` (the download form is gated in Klaviyo/Shopify, not here), then *one*
  bridge paragraph to the personalised book, then FAQ. **Nothing sells above the form.**
- **`gift` / `trust`** — the general SEO-article shape, grounded in the same product facts.

A topic can also carry `placeholder` (e.g. `{{BTS_FOTKY}}`) to reserve a spot for something pasted in
by hand later.

### Internal links

Posts store their `cluster`. The draft step passes up to 3 **real** sibling articles from the same
cluster (`siblingsInCluster`) into the prompt and the model links them in-text as
`[text](/blogs/blog/article)`. Assembly honours **only those URLs** — an invented or external link
loses its markup and renders as plain text, so a hallucinated link can't reach the article.
`internalLinkHint` is only asked for when there are no siblings yet.

A sibling counts once it has been sent to Shopify *and* we know both its blog handle and article
handle. Shopify articles arrive unpublished and it never tells us when David publishes them, so a
link can point at an article still waiting in admin — he sees every link in review.

A non-blocking QC pass (`qcPost`) surfaces warnings: keyword missing from title / first ~100 words,
title or meta over length, body too short (a `printable` is measured against its own 400-word floor —
it is short by design, and a warning that always fires is a warning nobody reads), no FAQ, no internal-link hint (only when there are no
siblings), **no link to existing siblings**, a printable missing `{{KLAVIYO_FORM}}`, **selling above
the form** in a printable, a missing extra placeholder, and the brand's **banned vocabulary**
(AI/algorithm/generování, sleva/akce/výprodej, …). Warnings never block saving.

## Publish flow (draft-only invariant)

`POST /api/blog/publish` → `src/shopify/content.js` `createArticleDraft` → GraphQL `articleCreate`
with **`isPublished: false`, always**. There is no publish-live path on purpose. David reviews the
draft in Shopify admin and hits Publish. A taken slug (or any userError) is surfaced clearly so David
can tweak the handle — it is never silently mangled.

Local drafts live under `config.blog.dataDir` (outside the repo) with a status: `koncept` (local) →
`odesláno` (pushed to Shopify as a draft) → `publikováno` (David published it).

## Setup — David's one manual step: the `write_content` scope

Writing an article draft needs the Admin API **`write_content`** scope, which the read-only orders
token does **not** have. Two options:

1. **Simplest — add `write_content` to the existing custom app.** In Shopify admin → Settings → Apps →
   Develop apps → your app → Configuration → Admin API scopes → add `write_content`, save, then
   **re-install / regenerate the token** and paste it into `config.json` as `shopify.accessToken` (or
   the `FMA_SHOPIFY_TOKEN` env var). The blog reuses it automatically.
2. **Keep the orders token narrow** — set a separate content token in `shopify.contentToken` or the
   `FMA_SHOPIFY_CONTENT_TOKEN` env var. The content seam prefers it and falls back to the orders token.

Then enable the module:

```json
"blog": { "enabled": true, "blogId": null, "author": "Fotomalovánky", "wordCountMin": 800, "wordCountMax": 1500 }
```

`blogId` can stay null — the UI lists the store's blogs (`GET /api/blog/blogs`) and lets David pick the
target per publish. Until `blog.enabled` + a usable content token are set, the tab shows a
"not configured" state and publishing is disabled; topic browsing and drafting still work with AI on.

## Not built yet (follow-ups)

- **Hero image upload.** The model suggests a hero prompt + alt text (shown in the editor for David to
  create/place an image), but generating and *uploading* a hero to Shopify needs a staged upload — the
  article is currently created text-only. `buildArticleInput` will attach an image only if a real
  `http(s)` URL is set.
- **Per-section regenerate** and a richer keyword-density check (P4 polish).

## Files

- `src/blog/keywordMap.js` — the curated keyword map (hand-maintained data, no IO).
- `src/blog/productFacts.js` — the verified product facts injected into every prompt, + open questions.
- `src/blog/topics.js` — topic engine (map + calendar + opt-in AI), pure, injected text fn.
- `src/blog/draft.js` — draft generation, structured-JSON → HTML, clamps, QC, skeleton fallback.
- `src/blog/store.js` — file-based CRUD + `blog-index.json` under `config.blog.dataDir`.
- `src/blog/voice.js` — brand voice + banned vocabulary (shared by topics/draft/QC).
- `src/shopify/content.js` — the write seam (`listBlogs`, `createArticleDraft`, draft-only).
- Server: `GET /api/blog/topics`, `POST /api/blog/draft`, `GET|POST|DELETE /api/blog/posts`,
  `GET /api/blog/blogs`, `POST /api/blog/publish`.
- UI: the **Blog** view in `src/ui/static/dashboard.html`.
- Tests: `test/blog.test.js` (topics window/merge/fallback, draft parse/caps/QC/skeleton, store CRUD,
  content payload incl. the `isPublished:false` invariant + missing-scope error, config).
