// ============================================================================
// Fotomalovánky Content Studio v1 - Blog Creation System
// Core type definitions (CZ only, local, draft-only)
// ----------------------------------------------------------------------------
// Brand authority:      ../BRAND GUIDE.md  (source of truth - never overridden)
// Structural reference: ../koolman social.ts.txt  (architecture only, no content)
// Scope:                Czech market only. DE docs are future-only context.
// No Shopify API. No publishing. No external credentials. No fabrication.
// ============================================================================

export type Season = 'jaro' | 'leto' | 'podzim' | 'zima';

export type JourneyStage = 'see' | 'think' | 'do' | 'care';

// Human-readable funnel stage label stored on the BlogPackage. Unlike
// JourneyStage (used as an input enum), this records the editorial intent of the
// finished article and may span stages, e.g. "THINK / DO".
export type FunnelStage =
  | 'SEE'
  | 'THINK'
  | 'DO'
  | 'CARE'
  | 'SEE / THINK'
  | 'THINK / DO'
  | 'DO / CARE';

// Seasonal fit is a 0-100 score for event/seasonal articles, or the literal
// 'not_applicable' for evergreen articles that are not tied to any event.
export type SeasonalFitScore = number | 'not_applicable';

export type SearchIntent =
  | 'informational'
  | 'commercial'
  | 'transactional'
  | 'navigational';

export type PersonaId =
  | 'maminky'
  | 'prarodice'
  | 'darci'
  | 'pary'
  | 'mazlickari'
  | 'dospeli-antistres';

export type EventCategory =
  | 'holiday'
  | 'gift'
  | 'seasonal'
  | 'lifestyle'
  | 'brand';

export type WarningSeverity = 'block' | 'warn' | 'info';

export type RiskLevel = 'low' | 'medium' | 'high';

// ----------------------------------------------------------------------------
// Source material - the ONLY place verified facts may come from.
// ----------------------------------------------------------------------------
// Anything not present here must NEVER be invented by the generator. Missing
// facts must surface as a literal [OVĚŘIT] placeholder in the output so David
// can confirm or fill them in before publishing.

export interface InternalLink {
  label: string; // anchor text (CZ)
  url: string;   // relative path on fotomalovanky.cz, e.g. "/products/..."
  note?: string;
}

export interface VerifiedReview {
  quote: string;
  author: string;  // only as literally provided in source material
  source?: string; // screenshot, e-mail, etc.
}

export interface VerifiedNumber {
  label: string; // what it measures, e.g. "počet proměněných fotek"
  value: string; // exact value as provided, e.g. "2 000+"
  source?: string;
}

export interface SourceMaterial {
  verifiedFacts?: string[];
  verifiedReviews?: VerifiedReview[];
  verifiedNumbers?: VerifiedNumber[];
  verifiedPricing?: string[];
  verifiedDeliveryClaims?: string[];
  internalLinks?: InternalLink[];
  notes?: string;
}

// ----------------------------------------------------------------------------
// Calendar / event-relevance (schema ported from Koolman calendar structure)
// ----------------------------------------------------------------------------

export interface CalendarEvent {
  id: string;
  name: string;            // CZ
  date: string;            // 'MM-DD'
  approximate?: boolean;   // movable feast or nth-weekday-of-month
  evergreen?: boolean;     // relevant all year (birthdays, anniversaries)
  recurring: boolean;
  category: EventCategory;
  relevance: string;       // why it matters for Fotomalovánky
  contentAngles: string[];
  personas: PersonaId[];
  recommendedTaglines?: string[]; // pulled from the verified tagline library
  leadTimeDays: number;    // publish this many days before the event
  bestPublishWindow: string;
  emoji: string;
}

export interface RelevantEvent {
  event: CalendarEvent;
  daysUntil: number;     // days from the given date to the next occurrence
  withinLeadTime: boolean; // true if inside the event's recommended publish lead time
}

// ----------------------------------------------------------------------------
// Inputs
// ----------------------------------------------------------------------------

export interface BlogBrainstormInput {
  topic?: string;
  targetKeyword?: string;
  searchIntent?: SearchIntent;
  persona?: PersonaId;
  journeyStage?: JourneyStage;
  eventId?: string;
  season?: Season;
  sourceMaterial?: SourceMaterial;
  customPrompt?: string;
}

export interface BlogIdea {
  id: string;
  title: string;
  angle: string;
  targetKeyword: string;
  searchIntent: SearchIntent;
  persona: PersonaId | string;
  journeyFit: string;
  outline: string[];
}

export interface BrainstormBlogResponse {
  ideas: BlogIdea[];
  prompt: string;
}

export interface GenerateBlogInput extends BlogBrainstormInput {
  selectedIdea: BlogIdea;
}

// ----------------------------------------------------------------------------
// Output building blocks
// ----------------------------------------------------------------------------

export interface CtaBlock {
  heading: string;
  body: string;
  buttonLabel: string;
  buttonUrl: string; // relative path on fotomalovanky.cz
}

export interface RepurposeIdea {
  channel: 'instagram' | 'facebook' | 'tiktok' | 'pinterest' | 'email';
  format: string;
  idea: string;
}

export interface QualityWarning {
  code: string;
  severity: WarningSeverity;
  message: string;
  field?: string;
  evidence?: string;
}

// ----------------------------------------------------------------------------
// The complete BlogPackage - everything needed for one manual Shopify draft.
// ----------------------------------------------------------------------------

export interface BlogPackage {
  // Shopify article metadata
  blogName: string;        // which Shopify blog this belongs to, e.g. "Inspirace"
  blogHandle: string;      // blog handle/slug
  author: 'David';         // fixed per project rule

  // Content + SEO
  title: string;
  seoTitle: string;        // <title> / SEO title, ~50-60 chars
  metaDescription: string; // ~140-160 chars
  handle: string;          // article URL slug
  excerpt: string;         // summary / Shopify excerpt
  tags: string[];

  // Search strategy
  targetKeyword: string;
  searchIntent: SearchIntent;
  funnelStage: FunnelStage; // editorial funnel intent, e.g. "THINK / DO"

  // Event / seasonal logic
  selectedEvent: string | null;        // event id or null for evergreen
  eventRelevanceReason: string;
  seasonalFitScore: SeasonalFitScore;  // 0-100, or 'not_applicable' for evergreen
  bestPublishWindow: string;
  riskOfForcedSeasonality: RiskLevel;
  campaignAngle: string;

  // Body + linking
  bodyHtml: string;
  internalLinksUsed: InternalLink[];
  ctaBlock: CtaBlock;

  // Image prompts (English for model performance, per Creative Production docs)
  weavyCoverPrompt: string;
  weavyInlineImagePrompt: string;

  // Repurposing (CZ)
  socialPostCZ: string;
  newsletterTeaserCZ: string;
  repurposeIdeas: RepurposeIdea[];

  // Safety + handoff
  qualityWarnings: QualityWarning[];
  manualShopifyChecklist: string[];
}
