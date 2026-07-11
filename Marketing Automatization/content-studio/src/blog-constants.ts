// ============================================================================
// Blog system constants: journey stages, intents, seasons, SEO rules,
// structure guidance, strict anti-fabrication constraints, image-prompt rules.
// ----------------------------------------------------------------------------
// Structural reference: koolman social.ts.txt (JOURNEY_STAGES, STRICT_CONSTRAINTS,
// CONTENT patterns). Brand specifics come from BRAND GUIDE.md.
// ============================================================================

import type { JourneyStage, SearchIntent, Season } from './blog-types';

export const SEARCH_INTENTS: Record<SearchIntent, { cs: string; goal: string }> = {
  informational: { cs: 'Informační', goal: 'Čtenář hledá informace nebo inspiraci (např. "nápady na dárek pro babičku").' },
  commercial: { cs: 'Komerční (zvažuje)', goal: 'Čtenář porovnává možnosti, zvažuje nákup (např. "originální dárek k výročí").' },
  transactional: { cs: 'Transakční', goal: 'Čtenář je připraven jednat (např. "omalovánky z fotek objednat").' },
  navigational: { cs: 'Navigační', goal: 'Čtenář hledá konkrétně Fotomalovánky.' },
};

export const JOURNEY_STAGES: Record<JourneyStage, { cs: string; goal: string; tone: string; cta: string[] }> = {
  see: {
    cs: 'See (Zastavit scroll / zaujmout)',
    goal: 'Vzbudit zájem, "wow, to existuje?". Neprodáváme, budíme zájem.',
    tone: 'Hravý, emocionální, lehce provokativní.',
    cta: ['Přečíst další tipy', 'Uložit na později', 'Sdílet'],
  },
  think: {
    cs: 'Think (Budovat důvěru)',
    goal: 'Vysvětlit, jak to funguje, ukázat kvalitu a sociální důkaz.',
    tone: 'Přívětivý průvodce, hodnota first.',
    cta: ['Podívat se jak to funguje', 'Prohlédnout ukázky'],
  },
  do: {
    cs: 'Do (Konvertovat)',
    goal: 'Odstranit poslední bariéry, usnadnit rozhodnutí.',
    tone: 'Jasný, jednoduchý, přesvědčivý (ne agresivní).',
    cta: ['Vytvořit omalovánku', 'Objednat', 'Nahrát fotku'],
  },
  care: {
    cs: 'Care (Udržovat vztah)',
    goal: 'Motivovat k návratu, sdílení a opakovanému nákupu.',
    tone: 'Vděčný, osobní, komunitní.',
    cta: ['Pošlete nám fotku díla', 'Překvapte dalšího člena rodiny'],
  },
};

export const SEASONS: Record<Season, { cs: string; months: string; context: string }> = {
  jaro: { cs: 'Jaro', months: 'březen-květen', context: 'Velikonoce, Den matek, svatební sezóna start, jarní fotky.' },
  leto: { cs: 'Léto', months: 'červen-srpen', context: 'Den dětí, prázdniny, dovolená, cestování, svatby.' },
  podzim: { cs: 'Podzim', months: 'září-listopad', context: 'Zpátky do školy, dýně/Halloween, předvánoční buildup.' },
  zima: { cs: 'Zima', months: 'prosinec-únor', context: 'Vánoce (hlavní peak), Valentýn, novoroční klid, antistres.' },
};

// SEO field rules (used by generator + quality checker)
export const SEO_RULES = {
  seoTitleMin: 40,
  seoTitleMax: 60,
  metaDescriptionMin: 120,
  metaDescriptionMax: 160,
  handleMaxWords: 7,
  // SEO title is "generic" if it contains none of these signals beyond the keyword
  genericTitlePhrases: [
    'vše, co potřebujete vědět',
    'kompletní průvodce',
    'nejlepší tipy',
    'úvod do',
    'blog',
    'článek',
  ],
};

export const BLOG_STRUCTURE = `
**Doporučená struktura blog postu (HTML body):**
1. Úvodní odstavec - hook v prvních dvou větách (zastaví scroll, vyvolá emoci).
2. 3-6 sekcí s <h2> (a případně <h3>), každá řeší jednu myšlenku.
3. Konkrétní, obrazné příklady (Alík, babička u komody, fotka z dovolené).
4. Přirozeně vetkané interní odkazy (viz internalLinks v source material).
5. Místo pro jeden inline obrázek (popsané ve weavyInlineImagePrompt).
6. Závěr + jeden jasný CTA blok.
Formát: čistý HTML (<h2>, <h3>, <p>, <ul>, <li>, <strong>, <a>). Žádné <script>.
Délka: 700-1200 slov pro informační/komerční záměr.
`.trim();

export const CTA_GUIDANCE = `
CTA blok je povinný. Jeden jasný cíl. Tlačítko vede na relativní URL na
fotomalovanky.cz (např. /products/...). Tón dle journey stage. Nepoužívej
falešnou urgenci ani slevy, pokud nejsou v source material.
`.trim();

export const INTERNAL_LINK_GUIDANCE = `
Použij pouze interní odkazy uvedené v source material (internalLinks). Pokud
žádné nejsou, vrať prázdné pole a přidej qualityWarning. Nevymýšlej URL.
`.trim();

export const REPURPOSE_FORMATS = `
Z každého blogu navrhni repurpose nápady pro: Instagram (post/reel/carousel),
Facebook (post), TikTok (krátké video), Pinterest (pin), e-mail (teaser).
Vše v češtině, v duchu Brand Guide, bez vymyšlených faktů.
`.trim();

// Weavy/Compositor image prompt guidance (anglicky pro výkon modelů,
// dle CREATIVE PRODUCTION dokumentů).
export const WEAVY_PROMPT_GUIDANCE = `
Image prompts in ENGLISH. Style: authentic UGC / lifestyle, warm natural light,
shot-on-iPhone feel, real home environment, coloring book + colored pencils on a
table, optional smartphone showing the source photo. No text baked into the image.
No brand logos invented. Avoid studio-perfect or overly produced looks.
`.trim();

// ----------------------------------------------------------------------------
// STRICT CONSTRAINTS - anti-fabrication core (model: Koolman STRICT_CONSTRAINTS)
// ----------------------------------------------------------------------------
export const STRICT_CONSTRAINTS = `
## KRITICKÁ PRAVIDLA - MUSÍŠ JE DODRŽET

### 1. POUZE OVĚŘENÉ INFORMACE
- Fakta, čísla, recenze, ceny, dodací lhůty a vlastnosti papíru použij POUZE tehdy,
  jsou-li EXPLICITNĚ v poskytnutém source material.
- Pokud údaj chybí, napiš literál [OVĚŘIT] a stručně popiš, co doplnit. NEVYMÝŠLEJ.

### 2. ŽÁDNÉ FALEŠNÉ RECENZE
- Cituj jen recenze uvedené v source material (verifiedReviews), doslovně, se jménem
  tak, jak je zadáno. Nevymýšlej hvězdičky, jména ani citáty.

### 3. ŽÁDNÁ VYMYŠLENÁ ČÍSLA A SLIBY
- Žádné "přes 2 000 fotek", "97 % zákazníků", "doručíme do 5 dnů", "od 249 Kč",
  gramáž papíru ani záruky, pokud nejsou v source material. Jinak [OVĚŘIT].

### 4. JAZYK ZNAČKY
- Nikdy nepoužívej: AI, algoritmus, neuronka, generování, renderování,
  personalizovaný produkt, processing, konverze, zabavení dítěte.
- Místo toho: kouzlo, proměna, vytvoření, osobní omalovánka.

### 5. STYL
- Nepoužívej pomlčku em dash. Nepřeháněj vykřičníky. Žádný korporátní žargon.
- Drž tón dle Brand Guide: srdečný, nadšený (autenticky), hravý, důvěryhodný.

### 6. SEZÓNNOST
- Sezónní rámec nasazuj jen tam, kde dává smysl. Pokud je téma evergreen,
  netlač ho násilně do svátku (forced seasonality). Označ riskOfForcedSeasonality.
`.trim();
