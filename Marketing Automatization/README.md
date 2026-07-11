# Fotomalovánky — Marketing Content Factory

Turns Meta ad performance into the next batch of ad copy, social posts, and video briefs,
grouped by **what the ad claimed** rather than by ad ID.

This is not a full-automation system, and pretending otherwise would waste your time.
Read [§ The manual seams](#the-manual-seams) before anything else.

---

## Why it exists

For eight months every ad ran nearly identical copy. The spend bought reach and taught nothing,
because there was nothing to compare. An experiment with one condition has no result.

Every creative here declares a single **angle** — the claim it makes about why someone buys —
and carries that angle in its ad name. `analyze.mjs` then groups eight weeks of spend by claim,
and `generate.mjs` points the next batch at whatever won.

---

## The loop

```
  ┌──────────────┐     ┌──────────────┐     ┌───────────────┐
  │ pull-meta    │───▶ │ analyze      │───▶ │ generate      │
  │ Graph API    │     │ verdict per  │     │ prompt with   │
  │ → data/      │     │ angle        │     │ winners baked │
  └──────────────┘     │ → reports/   │     │ in            │
         ▲             └──────────────┘     └───────┬───────┘
         │                                          │
         │                                          ▼
         │                                  ┌───────────────┐
         │                                  │ an LLM writes │
         │                                  │ the copy      │
         │                                  └───────┬───────┘
         │                                          │
         │                                          ▼
         │                                  ┌───────────────┐
         │                                  │ lint-copy     │
         │                                  │ blocks fabri- │
         │                                  │ cation        │
         │                                  └───────┬───────┘
         │                                          │
         │              ✂ MANUAL SEAM               ▼
         │        ┌──────────────────────────────────────┐
         └────────│ you shoot it, build it in Meta,      │
                  │ and publish it by hand               │
                  └──────────────────────────────────────┘
```

The loop closes only because a human walks the last stretch. There is no publishing API here.

---

## Quick start

Requires **Node 24+** (native `fetch` and `process.loadEnvFile`). Zero dependencies.

```bash
cp .env.example .env      # then fill in META_ACCESS_TOKEN and META_AD_ACCOUNT_ID

node factory/pull-meta.mjs                  # last 30 days → data/latest.json
node factory/analyze.mjs                    # → reports/angle-report-*.md + reports/winners.json
node factory/generate.mjs --pack ad-copy-variants > prompt.md
                                            # paste prompt.md into Claude, save the JSON it returns
node factory/lint-copy.mjs generated.json   # exit 1 means do not publish
```

`--pack` is one of `social-batch`, `ad-copy-variants`, `video-briefs`.

The token only needs **`ads_read`**. `ads_management` would be required to create or pause ads
programmatically, which nothing here does.

If your first pull returns zeros, `META_ACTION_TYPE` probably doesn't match your pixel.
Both scripts print the purchase-like action types they actually found in your data.

---

## The manual seams

Only the Meta Ads API is available. Everything below is a human step, by necessity, not oversight.

| Step | Status | Why |
|---|---|---|
| Pull ad performance | **automated** | Meta Graph API, read-only |
| Decide which angle wins | **automated** | `analyze.mjs`, with a stated verdict rule |
| Write the copy | **assisted** | `generate.mjs` builds the prompt; an LLM writes; `lint-copy.mjs` checks |
| **Shoot the photo or video** | ✂ manual | No production automation exists or should |
| **Build the ad in Meta** | ✂ manual | Needs `ads_management`, which we don't have |
| **Publish social posts** | ✂ manual | No Buffer token |
| **Collect reviews and UGC** | ✂ manual | Out of the agreed scope |
| Email flows, Shopify, PostHog | ✂ not built | Out of the agreed scope |

If a Buffer token ever appears, publishing is the one place to extend. Nothing else changes.

---

## Layout

```
brand/
  brand-guide.md       Source of truth. v3, merged. Parsed at runtime — see below.
  angles.md            The angle taxonomy, the naming convention, the E-code mapping.
calendar/
  2026-h2.md           July→December, with the creative gaps and the Christmas cutoff.
factory/
  pull-meta.mjs        Graph API → data/
  analyze.mjs          data/ → reports/  (verdicts per angle)
  generate.mjs         brand + angles + winners → a prompt
  lint-copy.mjs        generated JSON → BLOCK / WARN
  prompts/             the three packs
  lib/
    config.mjs         env, economics, verdict thresholds
    meta.mjs           Graph client, pagination, retry
    naming.mjs         the closed vocabulary + the full creative map
    brand.mjs          parses brand-guide.md
content-studio/        Lukáš's blog system. TypeScript, CZ-only, draft-only. Separate.
extracted/             Text pulled out of the original PDF.
Extra files/           Read-only archive. Do not edit anything in here.
```

`data/` and `reports/` are machine-generated. **Never hand-write `reports/winners.json`** —
`generate.mjs` treats it as real performance data and will happily build a batch around a fiction.

---

## Two systems, one brand guide

`content-studio/` is a separate, older project: blog drafts, Shopify copy, a quality checker.
It is CZ-only, draft-only, publishes nowhere.

The factory is the ads side. They share exactly one thing: **`brand/brand-guide.md`**.

`factory/lib/brand.mjs` parses that file at runtime for banned vocabulary, tagline tiers,
content-pillar weights, channel formality, hashtags, and the claims register. There is no
second copy of the rules to drift out of sync. If the guide's structure changes, the parser
throws and names itself — fix the parser, don't work around it.

`content-studio/src/fotomalovanky-brand.ts` is a hand-maintained TypeScript mirror of the same
sections, read by its `blog-quality-checker.ts`. It does not currently disagree with the guide.
If you edit guide sections 1–13, check it.

---

## The rules that are actually enforced

**No fabrication.** `brand-guide.md` § 14 lists what may be asserted, what must be verified,
and what is forbidden. `lint-copy.mjs` blocks invented numbers, star ratings, prices, discounts,
delivery promises, and paper specs. Anything unbacked must appear as a literal `[OVĚŘIT: …]`.

Two traps worth knowing. `"4 726 fotek"` is the number of photos on the *viewer's* phone in
creative `E18` — it is not our statistic, and the linter blocks it. And `"Babička u toho brečela"`
describes the review-screenshot *format*, not a real customer quote.

**One asset, one claim.** Copy arguing both `SCREEN` and `GIFT` is two assets.

**A killed angle stays dead.** If `analyze.mjs` returns `KILL`, `generate.mjs` forbids that
angle in the next batch and `lint-copy.mjs` blocks it if it slips through under another subject.

**Address form is correctness, not style.** Web and email take vykání. Social takes tykání.

**No em dashes** in generated Czech copy (`content-studio/RULES.md`).

---

## The statistics, briefly

An angle gets a verdict at **25 conversions**. At ~180 orders/month, seven live angles yield
roughly 26 conversions each per month — one clean read.

This is why the vocabulary has 8 angles but only ~7 run at once, and why the calendar tests
July through October and freezes on 1 November. An angle first deployed in November cannot
produce a verdict before the Christmas budget is spent.

`analyze.mjs` warns when more angles are live than the conversion volume can resolve, and when
an angle in the vocabulary has no creative at all. Right now `TOGETHER` has none, across all
38 creatives.

Verdict rules, all configurable in `.env`:

- `SCALE` — PNO at or under the 35% target, or beating the `LEGACY` baseline by more than 20%.
- `KILL` — PNO 1.3× the baseline, or zero conversions past 3× target CPA.
- `WATCH` — enough data, not enough separation.
- `INSUFFICIENT` — under 25 conversions. Never a verdict.

`LEGACY` is every ad predating the naming convention. It is excluded from angle verdicts
because it carries no tags, and included in the baseline because it is what a new angle
must beat. Those eight untagged months are the control group.

---

## What is not verified

Said plainly, so nobody mistakes intent for evidence:

- **`factory/lib/meta.mjs` has never made a real API call.** The analyzer is exercised
  end-to-end against fixtures; the Graph client is not. First real pull is task #7.
- **AOV is unknown.** So `analyze.mjs` cannot compute a target CPA and **suppresses
  spend-based `KILL` verdicts** rather than judge against an invented number. Set
  `FM_AOV_FALLBACK` to re-enable them, but only with a real figure. The "~250 CZK" in the
  German plan is the digital PDF product, not blended AOV.
- **Five claims are unresolved** and gate real work: the `R1 "Ivana z Loun"` review, the German
  five-star review, `S5`'s "od 249 Kč" price, whether a gift voucher exists as a product, and
  the production plus shipping lead time that determines the real Christmas cutoff.

---

## Conventions

Documents that a copywriter reads are Czech: `brand-guide.md`, `calendar/2026-h2.md`.
Documents that a developer reads are English: `angles.md`, this file, the code.

Their production docs use `V1`–`V3` for split-screen visual variants and `V1`–`V9` for video
concepts, in different files. To keep references unambiguous we write `VID1`–`VID9` for videos,
`SV1`–`SV3` for split-screen variants, `E1`–`E22` for statics, `R1`–`R2` for review creatives,
`S1`–`S5` for seasonal, and lowercase `v01` only as the copy-variant suffix inside an ad name.

Ad names: `FM_{market}_{angle}_{subject}_{format}_v{NN}`
Campaigns: `FM_{market}_{objective}_{season}`

`.env` holds a live ad-account token. Do not commit or share it.
