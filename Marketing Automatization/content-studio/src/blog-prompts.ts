// ============================================================================
// Prompt builders for the blog system.
// ----------------------------------------------------------------------------
// These assemble the full CZ prompt strings you paste into your LLM of choice.
// They embed: brand voice, strict anti-fabrication constraints, event context,
// SEO requirements, and the exact JSON output schema expected back.
// Structural reference: koolman social.ts.txt (buildBrainstormSocialPrompt /
// buildGenerateSocialPrompt). No skincare content carried over.
// ============================================================================

import type {
  BlogBrainstormInput,
  GenerateBlogInput,
  SourceMaterial,
} from './blog-types';
import {
  BRAND,
  FORBIDDEN_WORDS,
  NO_FABRICATION_NOTE,
  PERSONAS,
  TAGLINES,
  VOICE_PILLARS,
} from './fotomalovanky-brand';
import {
  BLOG_STRUCTURE,
  CTA_GUIDANCE,
  INTERNAL_LINK_GUIDANCE,
  JOURNEY_STAGES,
  REPURPOSE_FORMATS,
  SEARCH_INTENTS,
  SEO_RULES,
  SEASONS,
  STRICT_CONSTRAINTS,
  WEAVY_PROMPT_GUIDANCE,
} from './blog-constants';
import { formatEventContext, getEventById } from './calendar-events';

function voiceBlock(): string {
  const pillars = VOICE_PILLARS.map((p) => `- ${p.label}: ${p.meaning}`).join('\n');
  const banned = FORBIDDEN_WORDS.map((w) => w.word).join(', ');
  return `## TONE OF VOICE (${BRAND.name})
${BRAND.oneLiner}

Pilíře tónu:
${pillars}

Zakázaná slova (nikdy nepoužívej): ${banned}.
Místo "AI/algoritmus" piš "kouzlo/proměna". Žádný em dash. Vykřičníky střídmě.

${NO_FABRICATION_NOTE}`;
}

function sourceMaterialBlock(source?: SourceMaterial): string {
  if (!source) {
    return `## SOURCE MATERIAL
Žádný source material nebyl dodán. Veškerá fakta, čísla, ceny, recenze a dodací
lhůty proto MUSÍ být v textu označeny jako [OVĚŘIT]. Nevymýšlej nic.`;
  }

  const lines: string[] = ['## SOURCE MATERIAL (jediný zdroj ověřených faktů)'];

  if (source.verifiedFacts?.length) {
    lines.push('### Ověřená fakta:');
    lines.push(source.verifiedFacts.map((f) => `- ${f}`).join('\n'));
  }
  if (source.verifiedReviews?.length) {
    lines.push('### Ověřené recenze (cituj doslovně, jen tyto):');
    lines.push(
      source.verifiedReviews
        .map((r) => `- "${r.quote}" - ${r.author}${r.source ? ` (${r.source})` : ''}`)
        .join('\n')
    );
  }
  if (source.verifiedNumbers?.length) {
    lines.push('### Ověřená čísla (použij přesně, jinak [OVĚŘIT]):');
    lines.push(source.verifiedNumbers.map((n) => `- ${n.label}: ${n.value}`).join('\n'));
  }
  if (source.verifiedPricing?.length) {
    lines.push('### Ověřené ceny:');
    lines.push(source.verifiedPricing.map((p) => `- ${p}`).join('\n'));
  }
  if (source.verifiedDeliveryClaims?.length) {
    lines.push('### Ověřené dodací lhůty:');
    lines.push(source.verifiedDeliveryClaims.map((d) => `- ${d}`).join('\n'));
  }
  if (source.internalLinks?.length) {
    lines.push('### Interní odkazy (použij jen tyto, nevymýšlej URL):');
    lines.push(
      source.internalLinks.map((l) => `- [${l.label}](${l.url})${l.note ? ` - ${l.note}` : ''}`).join('\n')
    );
  }
  if (source.notes) {
    lines.push(`### Poznámky: ${source.notes}`);
  }

  return lines.join('\n');
}

function contextBlock(input: BlogBrainstormInput): string {
  const sections: string[] = [];

  if (input.topic) sections.push(`### Téma: ${input.topic}`);
  if (input.targetKeyword) sections.push(`### Cílové klíčové slovo: ${input.targetKeyword}`);
  if (input.searchIntent) {
    const si = SEARCH_INTENTS[input.searchIntent];
    sections.push(`### Search intent: ${si.cs} - ${si.goal}`);
  }
  if (input.persona) {
    const p = PERSONAS[input.persona];
    sections.push(`### Persona: ${p.label}\n- Řeší: ${p.solves}\n- Message: ${p.message}\n- Tón: ${p.tone}`);
  }
  if (input.journeyStage) {
    const j = JOURNEY_STAGES[input.journeyStage];
    sections.push(`### Fáze funnelu: ${j.cs}\n- Cíl: ${j.goal}\n- Tón: ${j.tone}\n- CTA: ${j.cta.join(', ')}`);
  }
  if (input.season) {
    const s = SEASONS[input.season];
    sections.push(`### Sezóna: ${s.cs} (${s.months}) - ${s.context}`);
  }
  if (input.eventId) {
    const ev = getEventById(input.eventId);
    if (ev) sections.push(formatEventContext(ev));
  }
  if (input.customPrompt) sections.push(`### Dodatečné zadání: ${input.customPrompt}`);

  return sections.length ? sections.join('\n\n') : '_(Žádný dodatečný kontext.)_';
}

// ----------------------------------------------------------------------------
// 1) Brainstorm prompt - returns 8 blog ideas as JSON.
// ----------------------------------------------------------------------------
export function buildBrainstormBlogPrompt(input: BlogBrainstormInput): string {
  return `Jsi SEO a obsahový stratég pro ${BRAND.name} (${BRAND.domain}, český trh).
Tvým úkolem je vymyslet nápady na blogové články pro Shopify blog.

${voiceBlock()}

${STRICT_CONSTRAINTS}

## KONTEXT
${contextBlock(input)}

${sourceMaterialBlock(input.sourceMaterial)}

## ÚKOL
Vymysli 8 nápadů na blogové články, které:
1. Sedí na český trh a na cílovou personu.
2. Mají reálný vyhledávací potenciál (jasné cílové klíčové slovo a search intent).
3. Spadají do obsahových pilířů značky a respektují tone of voice.
4. Nevymýšlejí žádná fakta - pokud by článek potřeboval číslo/recenzi/cenu, počítej s [OVĚŘIT].
5. Nejsou násilně sezónní, pokud je téma evergreen.

Pro každý nápad vrať:
- "id": krátký identifikátor
- "title": pracovní titulek (CZ)
- "angle": úhel/příběh v 1-2 větách
- "targetKeyword": cílové klíčové slovo
- "searchIntent": informational | commercial | transactional | navigational
- "persona": komu článek mluví
- "journeyFit": proč sedí do dané fáze funnelu (1 věta)
- "outline": 4-7 bodů osnovy

Odpověz POUZE validním JSON ve tvaru:
{
  "ideas": [
    { "id": "...", "title": "...", "angle": "...", "targetKeyword": "...", "searchIntent": "...", "persona": "...", "journeyFit": "...", "outline": ["..."] }
  ]
}`;
}

// ----------------------------------------------------------------------------
// 2) Generate prompt - returns a full BlogPackage as JSON.
// ----------------------------------------------------------------------------
export function buildGenerateBlogPrompt(input: GenerateBlogInput): string {
  const idea = input.selectedIdea;
  const verifiedTaglines = [...TAGLINES.tier1, ...TAGLINES.tier2, ...TAGLINES.tier3];

  return `Jsi seniorní copywriter a SEO specialista pro ${BRAND.name} (${BRAND.domain}, český trh).
Tvým úkolem je napsat KOMPLETNÍ balíček pro jeden blogový článek na Shopify
(ručně se vloží jako SKRYTÝ/DRAFT článek - nic se nepublikuje automaticky).

${voiceBlock()}

${STRICT_CONSTRAINTS}

## VYBRANÝ NÁPAD
- Titulek: ${idea.title}
- Úhel: ${idea.angle}
- Cílové klíčové slovo: ${idea.targetKeyword}
- Search intent: ${idea.searchIntent}
- Persona: ${idea.persona}
- Osnova: ${idea.outline.join(' / ')}

## KONTEXT
${contextBlock(input)}

${sourceMaterialBlock(input.sourceMaterial)}

## PRAVIDLA PRO POLE
- author: vždy "David".
- seoTitle: ${SEO_RULES.seoTitleMin}-${SEO_RULES.seoTitleMax} znaků, obsahuje cílové klíčové slovo, není generický.
- metaDescription: ${SEO_RULES.metaDescriptionMin}-${SEO_RULES.metaDescriptionMax} znaků, láká ke kliku, bez vymyšlených slibů.
- handle: krátký slug (max ${SEO_RULES.handleMaxWords} slov), bez diakritiky, slova spojená pomlčkou.
- bodyHtml: ${BLOG_STRUCTURE}
- internalLinksUsed: ${INTERNAL_LINK_GUIDANCE}
- ctaBlock: ${CTA_GUIDANCE}
- weavyCoverPrompt a weavyInlineImagePrompt: ${WEAVY_PROMPT_GUIDANCE}
- repurposeIdeas: ${REPURPOSE_FORMATS}
- Ověřené taglines, které smíš použít doslovně: ${verifiedTaglines.join(' | ')}.
- funnelStage: editorská fáze funnelu, např. "SEE", "THINK", "DO", "CARE" nebo kombinace "THINK / DO".
- seasonalFitScore: 0-100 pro článek vázaný na příležitost/sezónu; pro evergreen článek (selectedEvent = null) použij literál "not_applicable".
- riskOfForcedSeasonality: low | medium | high (high = evergreen téma násilně tlačené do svátku).
- qualityWarnings: sem zapiš vše, co bys sám označil za riziko (zejména každé [OVĚŘIT]).
- manualShopifyChecklist: kroky pro ruční vložení do Shopiblogu jako skrytý/draft.

Odpověz POUZE validním JSON odpovídajícím tomuto tvaru (typ BlogPackage):
{
  "blogName": "...",
  "blogHandle": "...",
  "author": "David",
  "title": "...",
  "seoTitle": "...",
  "metaDescription": "...",
  "handle": "...",
  "excerpt": "...",
  "tags": ["..."],
  "targetKeyword": "...",
  "searchIntent": "...",
  "funnelStage": "${input.journeyStage ? input.journeyStage.toUpperCase() : 'THINK / DO'}",
  "selectedEvent": ${input.eventId ? `"${input.eventId}"` : 'null'},
  "eventRelevanceReason": "...",
  "seasonalFitScore": ${input.eventId ? '0' : '"not_applicable"'},
  "bestPublishWindow": "...",
  "riskOfForcedSeasonality": "low",
  "campaignAngle": "...",
  "bodyHtml": "<p>...</p>",
  "internalLinksUsed": [{ "label": "...", "url": "/..." }],
  "ctaBlock": { "heading": "...", "body": "...", "buttonLabel": "...", "buttonUrl": "/..." },
  "weavyCoverPrompt": "... (English)",
  "weavyInlineImagePrompt": "... (English)",
  "socialPostCZ": "...",
  "newsletterTeaserCZ": "...",
  "repurposeIdeas": [{ "channel": "instagram", "format": "...", "idea": "..." }],
  "qualityWarnings": [{ "code": "...", "severity": "warn", "message": "..." }],
  "manualShopifyChecklist": ["..."]
}

Po dokončení si projdi celý výstup a sám si zkontroluj: žádné vymyšlené číslo,
recenze, cena ani dodací lhůta; žádné zakázané slovo; žádný em dash; každé
neověřené tvrzení označené jako [OVĚŘIT].`;
}
