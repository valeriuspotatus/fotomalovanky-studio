# Source classification

How each existing file in this folder is treated by the Content Studio. None of
these files are moved, renamed, or edited by v1. This is a read-only map.

| File | Classification | Used by blog system? | Notes |
|---|---|---|---|
| `BRAND GUIDE.md` | **Source of truth (highest authority)** | Yes (mirrored) | Voice, personas, taglines, forbidden words live in `src/fotomalovanky-brand.ts` as a mirror. Guide always wins. |
| `MARKETING PLAN v2.md` | **Source of truth (CZ strategy)** | Indirect | Seasonal calendar + STDC informed `src/calendar-events.ts` and `src/blog-constants.ts`. |
| `CREATIVE PRODUCTION – Evergreen Ads.md` | **Source of truth (static production)** | Indirect | Weavy/Compositor prompt style informed the image-prompt guidance. |
| `CREATIVE PRODUCTION – Video & Animation.md` | **Source of truth (video production)** | Indirect | Repurpose ideas reference these video formats. |
| `PROJECT.md` | Supporting context | No | Founder intent and priorities. |
| `koolman social.ts.txt` | **Structural reference only** | Architecture | Pattern for prompt builders, strict constraints, typed enums. No skincare content carried over. |
| `koolman marketing calendar.ts.txt` | **Structural reference only** | Schema | Event schema (id, date, relevance, contentAngles, emoji) reused for `CALENDAR_EVENTS`. Content rewritten for CZ Fotomalovánky. |
| `GERMANY_GTM_PLAN.md` | **Future-only context** | No | DE market. Out of scope for v1 (CZ only). |
| `DE LAUNCH – GTM Plan.md` | **Future-only context (older duplicate)** | No | Superseded by `GERMANY_GTM_PLAN.md`. Kept for reference. |

## Facts and claims

No facts from any of these documents are reproduced as truth in generated blog
output unless they are explicitly passed in through `SourceMaterial`. Specific
claims found in the marketing drafts (for example customer counts, review
quotes, prices, delivery times) are treated as **unverified placeholders** and
must be confirmed by David before use. The generator marks anything unconfirmed
as `[OVĚŘIT]`.
