# RULES - non-negotiables for Fotomalovánky Content Studio v1

These apply to every blog draft and every piece of repurposed content produced
here. The quality checker enforces most of them; the rest are on you to honor.

## Scope

- **CZ only.** Czech market and Czech language. DE / Fotoausmalbuch.de material
  is future-only context and is not used.
- **Draft only.** Everything is a draft for review. Nothing is final until David
  approves it.
- **Local only.** No Shopify API, no integrations, no external credentials, no
  automation. Output is for manual copy-paste.
- **Publish nowhere.** The system never posts to Shopify, social, email, or any
  external service.
- **Author is always David.**

## No fabrication (the core rule)

Never invent any of these:

- reviews or testimonials (quotes, names, star ratings)
- customer numbers or statistics ("přes 2 000 fotek", "97 % zákazníků")
- prices, discounts, or sales
- delivery promises or lead times
- paper specs (gramáž / quality claims)
- guarantees

If a fact is not in the provided **source material**, it must appear as a literal
`[OVĚŘIT]` placeholder describing what to confirm. When in doubt, leave it out.

## Brand voice

- Highest authority is **BRAND GUIDE.md**. The mirror in
  `src/fotomalovanky-brand.ts` must stay consistent with it.
- Never use: AI, umělá inteligence, algoritmus, neuronka, generování,
  renderování, personalizovaný produkt, processing, konverze, zabavení dítěte,
  levný, výprodej. Use kouzlo, proměna, vytvoření, osobní omalovánka instead.
- Tone: srdečný, nadšený (authentically), hravý, důvěryhodný.
- Use only verified taglines from the Brand Guide library.

## Style

- **No em dashes.** Use a normal hyphen or rephrase.
- Exclamation marks sparingly (roughly three at most per piece).
- No corporate jargon, no false urgency.

## SEO and structure

- Every post has: a non-generic SEO title containing the target keyword, a meta
  description in range, a clean URL handle, at least one CTA, and at least one
  internal link from source material.
- Do not invent internal URLs. Use only links provided in source material.

## Seasonality

- Anchor to a calendar event only when it genuinely fits. Do not force evergreen
  topics into a holiday. Record `riskOfForcedSeasonality` honestly.

## Existing files

- Do not move, rename, or edit any existing source document in this folder.
- The Koolman files are structural references only.
