# Fotomalovánky Content Studio v1 - Blog Creation System

A local, Czech-only system that turns a topic or calendar event into a complete,
Shopify-ready **blog draft** you paste in by hand. It is built **additively**
around the existing marketing documents in this folder. It does not move, rename,
or edit any of them.

> No Shopify API. No publishing. No external credentials. No fabrication.
> CZ only. Author is always **David**. Output is a hidden/draft article.

## What it does

1. **Suggests timely topics** from a Czech calendar (event-relevance logic).
2. **Brainstorms blog ideas** via a ready-to-paste LLM prompt.
3. **Generates a full `BlogPackage`** (title, SEO fields, HTML body, internal
   links, CTA, Weavy image prompts, social + newsletter repurposing) via a
   second prompt.
4. **Checks quality** with anti-fabrication and brand-voice warnings.
5. **Hands off** to a manual Shopify paste workflow.

It never invents facts. Anything not supplied as verified source material is
written as a literal `[OVĚŘIT]` placeholder for you to confirm.

## Folder layout (added by v1)

```
README.md                  <- this file
RULES.md                   <- non-negotiables
src/                       <- the system (TypeScript)
  blog-types.ts
  fotomalovanky-brand.ts   <- mirror of BRAND GUIDE.md
  blog-constants.ts
  calendar-events.ts       <- CZ events + relevance logic
  blog-prompts.ts          <- the two prompt builders
  blog-quality-checker.ts  <- anti-fabrication warnings
  example-inputs.ts
  index.ts                 <- barrel + local demo()
examples/                  <- example input + outputs (JSON)
drafts/                    <- your generated drafts land here
docs/                      <- architecture, source map, Shopify workflow
```

Your existing source documents (BRAND GUIDE.md, MARKETING PLAN v2.md, the
CREATIVE PRODUCTION files, the DE plans, and the Koolman references) stay exactly
where they are and are untouched.

## How I (David) use it

### Step 1 - See what is coming up
Decide a date and look at relevant events. In `src/index.ts`:

```ts
import { getRelevantEvents } from './src';
getRelevantEvents('2026-04-20', 45); // events within 45 days, sorted by soonest
```

Events flagged "within lead time" are the ones it is time to publish for.

### Step 2 - Brainstorm ideas
Fill a `BlogBrainstormInput` (topic, target keyword, persona, journey stage,
optional `eventId`, and **verified** `sourceMaterial`). Build the prompt:

```ts
import { buildBrainstormBlogPrompt, EXAMPLE_BRAINSTORM_INPUT } from './src';
const prompt = buildBrainstormBlogPrompt(EXAMPLE_BRAINSTORM_INPUT);
// paste `prompt` into ChatGPT / Claude / Gemini -> get 8 ideas as JSON
```

See `examples/example-brainstorm-output.json` for the expected shape.

### Step 3 - Generate the full package
Pick one idea, add it as `selectedIdea`, build the generate prompt:

```ts
import { buildGenerateBlogPrompt, EXAMPLE_GENERATE_INPUT } from './src';
const prompt = buildGenerateBlogPrompt(EXAMPLE_GENERATE_INPUT);
// paste into the LLM -> get a BlogPackage as JSON
```

See `examples/example-blog-package-output.json` for a compliant sample.

### Step 4 - Check quality
Paste the returned JSON back as an object and validate:

```ts
import { validateBlogPackage } from './src';
const { passed, blockers, warns } = validateBlogPackage(pkg, sourceMaterial);
// passed === false means there is a blocker to fix (e.g. fabricated claim)
```

The checker warns on: forbidden words, fake-review risk, unsupported claims,
invented numbers, invented delivery/pricing/paper claims, missing CTA, missing
internal links, generic/weak SEO title, over-technical wording, generic holiday
fluff, forced seasonality, em dashes, and exclamation-mark overuse.

### Step 5 - Verify and publish manually
Save to `drafts/`, replace every `[OVĚŘIT]` with real data, then follow
[docs/MANUAL_SHOPIFY_WORKFLOW.md](docs/MANUAL_SHOPIFY_WORKFLOW.md) to paste it
into Shopify as a **hidden/draft** article. You publish manually after review.

## Setup and run on Windows

Everything is local. The only tool you need is Node.js (for running the demo and
prompt builders). Nothing connects to the internet at runtime and no credentials
are required.

### 1. Install Node.js (only if you do not have it)

Check first. Open **PowerShell** or **Command Prompt** and run:

```
node -v
```

If you see a version like `v20.x` or `v22.x`, you are set, skip to step 2.

If you see "not recognized", install Node.js:

- Go to https://nodejs.org and download the **LTS** installer for Windows (.msi).
- Run it, accept the defaults (this also installs `npm`).
- Close and reopen PowerShell, then run `node -v` again to confirm.

### 2. Install project dependencies (one time)

In PowerShell, change into this folder and install:

```
cd "C:\Users\David\Desktop\Fotomalovanky Content Studio"
npm install
```

This downloads `tsx` and `typescript` into a local `node_modules` folder. It does
not touch anything outside this folder.

### 3. Run the demo

```
npm run demo
```

This prints, in the terminal:
- the calendar events relevant to the reference date (event-relevance logic),
- seed blog ideas for Den matek,
- the full **brainstorm prompt**, and
- the full **generate prompt**.

Copy a prompt from the terminal into ChatGPT / Claude / Gemini, then paste the
JSON it returns back into a file under `drafts/`.

Optional: `npm run typecheck` checks the TypeScript types without running anything.

### 4. Where generated drafts are saved

You save them yourself into the **`drafts/`** folder (the system does not write
files for you during the demo). Naming convention:

```
drafts\YYYY-MM-DD_<handle>.md      (human-readable draft)
drafts\YYYY-MM-DD_<handle>.json    (optional raw BlogPackage)
```

There is already one real example draft in `drafts/` to copy the format from.
See [drafts/README.md](drafts/README.md).

## Manually copying a BlogPackage into Shopify

> For Shopify, copy from the ready-made files in **`shopify-copy/`**, not directly
> from `drafts/`. Each article has three clean files there: a `-body.html` (raw
> bodyHtml, no markdown fences), a `-fields.txt` (title, blog, author, excerpt,
> tags, SEO title, meta description, handle, visibility), and an
> `-image-prompts.txt` (Weavy prompts + alt text). The `drafts/` files stay as the
> full working record; `shopify-copy/` is the paste-ready version.

No automation, no API. You paste each field by hand and keep the article hidden
until you decide to publish. Author is always **David**.

| Shopify field (Admin > Content > Blog posts) | BlogPackage field |
|---|---|
| Title | `title` |
| Content (use the HTML `<>` editor) | `bodyHtml` |
| Excerpt | `excerpt` |
| Author | `author` (David) |
| Blog | `blogName` / `blogHandle` |
| Tags | `tags` |
| SEO > Page title | `seoTitle` |
| SEO > Meta description | `metaDescription` |
| SEO > URL handle | `handle` |
| Featured image | image made from `weavyCoverPrompt` |
| In-body image | image made from `weavyInlineImagePrompt` |
| Visibility | **Hidden / draft** (do not schedule) |

Before pasting: replace every `[OVĚŘIT]` with real, verified data, and read the
`qualityWarnings`. Full step-by-step is in
[docs/MANUAL_SHOPIFY_WORKFLOW.md](docs/MANUAL_SHOPIFY_WORKFLOW.md). The CTA block,
internal links, and the CZ social/newsletter snippets are reused as repurposing
drafts after the post is ready.

## Read next

- [RULES.md](RULES.md) - the non-negotiables.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - how it fits together.
- [docs/SOURCE_CLASSIFICATION.md](docs/SOURCE_CLASSIFICATION.md) - how existing files are treated.
- [docs/MANUAL_SHOPIFY_WORKFLOW.md](docs/MANUAL_SHOPIFY_WORKFLOW.md) - the paste workflow.
