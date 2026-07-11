# Content Roadmap (Content Studio v1)

Local planning document only. Not a publishing instruction. Nothing here is
published, no Shopify API is used, and no original source document is changed.
Source of priorities: `SEO_ACTION_LIST.md.txt` (priorities 1, 4, 6).

Scope of this roadmap: **priorities 1, 4, and 6 only.** The other items in the
SEO action list (2 product-page text, 3 image filenames/alt, 5 structured data /
Merchant Center, 7 About page, 8 canonicalization, 9 FAQ expansion, 10 Slovak
content) are acknowledged but out of scope for this blog-content roadmap. Several
of them are dev or Merchant Center tasks rather than article writing. They are
listed at the bottom as "Not in this roadmap" so nothing is silently dropped.

All planned articles follow the same rules as article #1: CZ only, friendly
vykání, no em dash, no invented reviews/numbers/prices/delivery/guarantees/paper
specs/quotes, `[OVĚŘIT]` for anything not in source material, author David,
CTA embedded in `bodyHtml`, full BlogPackage incl. `funnelStage` and
`seasonalFitScore`.

---

## Priority 1 - "Jak vybrat fotky" guide

**Status: DONE** (hidden Shopify draft).

- Draft: `drafts/jak-vybrat-fotky-na-omalovanky.md`
- Paste-ready: `shopify-copy/jak-vybrat-fotky-na-omalovanky-*`
- Blog: Tipy pro fotky (`tipy-pro-fotky`)
- Target keyword: jak vybrat fotky na omalovánky
- Funnel: THINK / DO | seasonalFitScore: not_applicable (evergreen)

This guide is also the SEO hub for the help cluster below. New help articles
should link back to it where photo selection is relevant.

---

## Priority 4 - 5 to 8 strong behind-the-scenes / help articles

A planned cluster of help, process (behind-the-scenes), and gift-guide articles.
Article #1 already anchors the cluster. Target 6 more so the published set is
7-8 total. Internal links cross-link the cluster and point to the homepage and
to `Ze zákulisí`.

Legend: B = behind-the-scenes, H = help, G = gift-guide.

| # | Working title | Type | Blog | Target keyword | Persona | Funnel | Event | Status |
|---|---|---|---|---|---|---|---|---|
| A1 | Jak vybrat fotky na omalovánky, aby výsledek vypadal krásně | H | Tipy pro fotky | jak vybrat fotky na omalovánky | maminky + dárci | THINK / DO | evergreen | DONE |
| A2 | Originální dárek pro babičku a dědečka: vzpomínka, kterou si vybarví | G | Inspirace na dárky | originální dárek pro babičku a dědečka | dárci + prarodiče + maminky | THINK / DO | evergreen | DRAFT_CREATED |
| A3 | Jak u nás vzniká omalovánka z vaší fotky | B | Ze zákulisí | jak vzniká omalovánka z fotky | maminky + dárci | THINK | evergreen | DRAFT_CREATED |
| A4 | Co všechno můžete proměnit v omalovánku | H | Inspirace na dárky | omalovánky z fotek nápady | maminky + dárci + mazlíčkáři | SEE / THINK | evergreen | PLANNED |
| A5 | Časté otázky o omalovánkách z fotek | H | Ze zákulisí | omalovánky z fotek časté otázky | dárci + maminky | THINK / DO | evergreen | PLANNED |
| A6 | Dárek na poslední chvíli: osobní omalovánky z fotek | G/H | Inspirace na dárky | dárek na poslední chvíli z fotek | dárci | DO | evergreen | PLANNED |
| A7 | Kreativní čas bez obrazovky: omalovánky pro celou rodinu | H | Tipy pro fotky | kreativní zábava bez obrazovky | maminky | SEE / THINK | evergreen | PLANNED |

Notes per article (so each is one step from `buildGenerateBlogPrompt`):

- **A2 (next):** Gift guide for grandparents. Source material already supplied by
  David in the article brief. Strong photos: vnoučata, společné rodinné momenty,
  výlety, oslavy, Vánoce, dovolené, obyčejné dny. Internal links: homepage,
  product/order page, Ze zákulisí, and A1. No numbers/prices/delivery/quotes.
- **A3 (behind-the-scenes):** Explain the journey from photo to physical sešit in
  human terms, no technical wording. Anything about specific timing, materials,
  or paper must be `[OVĚŘIT]`. Links to A1 (photo selection) and product page.
- **A4 (help/inspiration):** Use-case breadth: děti, mazlíčci, páry, dovolená,
  prarodiče. Pulls readers who do not yet know the product range. Links to A2, A1.
- **A5 (help/FAQ):** Real buyer objections, but ONLY answered from source
  material. Questions whose answers are not yet supplied (photo quality limits,
  what exactly arrives, timing) get `[OVĚŘIT]` placeholders. Overlaps with SEO
  priority 9 (FAQ) but here as an article, not the on-site FAQ block.
- **A6 (gift/help):** Last-minute angle. The natural answer is a gift option that
  does not depend on shipping speed. Do NOT promise any delivery time or invent a
  voucher product. If a dárkový poukaz exists, confirm via source material; else
  `[OVĚŘIT]`. Links to A2, homepage.
- **A7 (help/value):** Screen-free creative time, parents persona. Brand-aligned
  (kreativní zábava, ne "zabavení dítěte"). Links to A1, A4.

Suggested production order: A2 (next) -> A3 -> A5 -> A4 -> A6 -> A7. Reasoning:
A2 is briefed and ready; A3/A5 build trust (process + objections) and feed the
videos in priority 6; A4/A6/A7 widen reach afterward.

Internal-link map for the cluster:
- A1 <-> A2, A3, A7
- A2 <-> A4, A6, homepage, product/order page
- A3 <-> A1, A5, product/order page
- A5 <-> A2, A3
- All articles link to homepage and to `Ze zákulisí`.

---

## Priority 6 - Videos for product / homepage

Plan short video assets derived from existing blog and product content. These are
planning briefs only. No production, no editing, no publishing happens here.

Structural reference (read-only, not edited): `CREATIVE PRODUCTION - Video &
Animation.md` (concepts V1 Transformation, V2 Time-lapse, V7 Full process) and
`MARKETING PLAN v2.md` (video section). Reuse those concepts; do not copy any
unverified claim into a video.

| ID | Concept | Derived from | Length | Placement | Format | Status |
|---|---|---|---|---|---|---|
| V-A | Transformace: fotka -> omalovánka | A1 + A3 | 10-15 s | Homepage hero, product page | 9:16 + 1:1 | PLANNED |
| V-B | Jak vybrat fotku (rychlé tipy) | A1 | 15-20 s | Product page, Tipy pro fotky | 9:16 | PLANNED |
| V-C | Time-lapse vybarvování | A4 / A7 | 15-20 s | Homepage, product page | 9:16 + 1:1 | PLANNED |
| V-D | Dárek pro babičku a dědečka (emoce) | A2 | 15-20 s | Product page, gift section | 9:16 | PLANNED |

Rules for these video briefs when we write them:
- Titulky vždy (CZ). Většina lidí sleduje bez zvuku.
- Žádné vymyšlené číslo, recenze, cena, dodací lhůta, gramáž ani záruka.
  Cokoli neověřené = `[OVĚŘIT]`, ne výmysl.
- Žádné rozpoznatelné tváře reálných zákazníků bez souhlasu.
- Žádné slovo "AI"/"algoritmus" ve scénáři ani v overlay textu.
- Each video brief lists: hook (0-3 s), shot list, on-screen CZ text, suggested
  music type, CTA, and the blog/product source it is derived from.

Dependency: V-A, V-B, V-D lean on articles A1, A3, A2, so they come after those
drafts exist. V-C can be planned anytime.

---

## How this roadmap is used

1. Pick the next item (currently A2).
2. Fill a `BlogBrainstormInput` / `GenerateBlogInput` (or video brief) using the
   row above plus David's source material.
3. Generate, run the quality checker, save to `drafts/`, replace every `[OVĚŘIT]`.
4. Create the paste-ready files in `shopify-copy/`.
5. David reviews and manually pastes into Shopify as a hidden/draft article.

Status values: PLANNED, QUEUED, DRAFT_CREATED, DONE. Update this file as items
progress. (DRAFT_CREATED = local draft + shopify-copy files exist, awaiting David's
review; DONE = reviewed and pasted into Shopify as a hidden draft.)

---

## Not in this roadmap (acknowledged, from SEO_ACTION_LIST.md)

These are real priorities from the SEO list but are not blog-content work, so they
are tracked elsewhere, not here:

- Priority 2: Fix product page variant/crawl text (dev).
- Priority 3: Image filenames + alt texts (the Content Studio already emits alt
  text suggestions per article; site-wide image work is dev/SEO).
- Priority 5: Product structured data + Merchant Center (dev).
- Priority 7: "O nás / Kdo za tím stojí" page (page content, can be added later).
- Priority 8: Canonicalization for srsltd URLs (dev/SEO).
- Priority 9: Expand on-site FAQ with real buyer objections (overlaps A5, but the
  on-site FAQ block itself is a site task).
- Priority 10: Slovak-specific content (only if Slovakia matters; out of CZ v1 scope).
