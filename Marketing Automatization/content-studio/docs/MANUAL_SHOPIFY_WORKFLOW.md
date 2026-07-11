# Manual Shopify workflow (hidden / draft article)

This system never touches Shopify directly. You paste the generated content in
by hand and keep it hidden until you decide to publish. Author is always David.

## Before you paste: verify and check

1. Open the generated `BlogPackage` JSON from `drafts/`.
2. Run the quality checker (`validateBlogPackage`) or read its `qualityWarnings`.
   - Any `block`-severity warning: fix before continuing.
3. Search the whole package for `[OVĚŘIT]` and replace every one with real,
   verified data (reviews, numbers, prices, delivery times, paper specs). If you
   cannot verify a claim, delete it rather than guess.

## Field mapping: BlogPackage -> Shopify

| Shopify field (Admin > Content > Blog posts) | BlogPackage field |
|---|---|
| Title | `title` |
| Content (body, use the HTML `<>` editor) | `bodyHtml` |
| Excerpt | `excerpt` |
| Author | `author` (always **David**) |
| Blog | `blogName` / `blogHandle` |
| Tags | `tags` |
| Search engine listing > Page title | `seoTitle` |
| Search engine listing > Meta description | `metaDescription` |
| Search engine listing > URL handle | `handle` |
| Featured image | image created from `weavyCoverPrompt` |
| Inline image (inside body) | image created from `weavyInlineImagePrompt` |
| Visibility | **Hidden / draft** (do not set a publish date) |

## Step by step

1. Shopify Admin > **Content** > **Blog posts** > **Add blog post**.
2. Set **Blog** to the target blog (e.g. Inspirace) and **Author** to David.
3. Paste `title`.
4. In the content editor, switch to HTML view (`<>`) and paste `bodyHtml`.
5. Insert the cover and inline images (generate them in Weave/Compositor from the
   English prompts, then upload).
6. Fill **Excerpt** with `excerpt` and add **Tags**.
7. Open **Edit website SEO**: set page title = `seoTitle`, meta description =
   `metaDescription`, URL handle = `handle`.
8. Confirm every internal link in `internalLinksUsed` points to a real page.
9. Place the `ctaBlock` near the end of the body (heading, body, button -> link
   the button to `ctaBlock.buttonUrl`).
10. Set **Visibility** to **Hidden** (draft). Do **not** schedule publishing.
11. Preview on mobile.
12. Save. Publication is a separate, deliberate manual step by David after review.

## Repurposing (after the post is ready)

Use `socialPostCZ`, `newsletterTeaserCZ`, and `repurposeIdeas` as starting drafts
for Instagram, Facebook, TikTok, Pinterest, and the newsletter. Same rules apply:
CZ only, brand voice, no invented facts, copy-paste by hand.

## Hard limits (v1)

- No Shopify API integration, no app, no automation.
- No external credentials required anywhere.
- Nothing is published automatically.
- No fake reviews, numbers, prices, delivery promises, or guarantees.
