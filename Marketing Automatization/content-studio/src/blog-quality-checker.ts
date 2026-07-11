// ============================================================================
// Quality checker - anti-fabrication and brand-safety warnings.
// ----------------------------------------------------------------------------
// Runs over a generated BlogPackage and returns QualityWarning[]. It does NOT
// rewrite anything; it surfaces risks so David can fix them before publishing.
// Cross-checks numeric/review/price/delivery claims against the SourceMaterial:
// anything claimed but NOT backed by source (and not wrapped in [OVĚŘIT]) is a
// warning. Model: Koolman STRICT_CONSTRAINTS, expanded for blog output.
// ============================================================================

import type {
  BlogPackage,
  QualityWarning,
  SourceMaterial,
  WarningSeverity,
} from './blog-types';
import { FORBIDDEN_WORDS } from './fotomalovanky-brand';
import { SEO_RULES } from './blog-constants';

// Over-technical wording that breaks the "emoce > technologie" rule.
const OVER_TECHNICAL = [
  'ai', 'a.i.', 'umělá inteligence', 'algoritmus', 'neuronka', 'neuronová síť',
  'generování', 'vygenerovat', 'vygenerován', 'renderování', 'processing',
  'konverze', 'upload', 'pipeline', 'machine learning', 'model',
];

// Generic holiday fluff phrases (low-value seasonal filler).
const HOLIDAY_FLUFF = [
  'kouzlo vánoc', 'magie svátků', 'svátky plné pohody', 'ten pravý vánoční čas',
  'atmosféra svátků', 'vánoční čas je tu', 'nejkrásnější období roku',
];

// Words that signal a delivery / pricing / paper claim (need source backing).
const DELIVERY_TRIGGERS = [
  'doručíme', 'doručení do', 'pracovních dnů', 'pracovních dní', 'expedice',
  'odešleme do', 'do vánoc', 'garantujeme doručení', 'dodací lhůta',
];
const PRICING_TRIGGERS = ['kč', 'czk', 'korun', 'zdarma', 'sleva', 'akce', 'výprodej', '% off'];
const PAPER_TRIGGERS = ['g/m²', 'gsm', 'gramáž', 'gramů', 'gramová', 'síla papíru'];

// Review-like signals.
const REVIEW_SIGNALS = ['⭐', '★', 'recenze', 'hodnocení', 'zákaznice', 'zákazník napsal'];

function gatherText(pkg: BlogPackage): { field: string; text: string }[] {
  return [
    { field: 'title', text: pkg.title || '' },
    { field: 'seoTitle', text: pkg.seoTitle || '' },
    { field: 'metaDescription', text: pkg.metaDescription || '' },
    { field: 'excerpt', text: pkg.excerpt || '' },
    { field: 'bodyHtml', text: pkg.bodyHtml || '' },
    { field: 'campaignAngle', text: pkg.campaignAngle || '' },
    { field: 'socialPostCZ', text: pkg.socialPostCZ || '' },
    { field: 'newsletterTeaserCZ', text: pkg.newsletterTeaserCZ || '' },
    { field: 'ctaBlock', text: `${pkg.ctaBlock?.heading || ''} ${pkg.ctaBlock?.body || ''}` },
  ];
}

function fullText(pkg: BlogPackage): string {
  return gatherText(pkg).map((t) => t.text).join('\n').toLowerCase();
}

// strip [OVĚŘIT ...] placeholders so they are not themselves flagged as claims
function stripPlaceholders(text: string): string {
  return text.replace(/\[ovĕřit[^\]]*\]/gi, ' ').replace(/\[oveřit[^\]]*\]/gi, ' ').replace(/\[overit[^\]]*\]/gi, ' ');
}

function warn(
  code: string,
  severity: WarningSeverity,
  message: string,
  field?: string,
  evidence?: string
): QualityWarning {
  return { code, severity, message, field, evidence };
}

// Collect the verified values we are allowed to state.
function verifiedHaystack(source?: SourceMaterial): string {
  if (!source) return '';
  const parts: string[] = [];
  source.verifiedFacts?.forEach((f) => parts.push(f));
  source.verifiedNumbers?.forEach((n) => parts.push(`${n.label} ${n.value}`));
  source.verifiedPricing?.forEach((p) => parts.push(p));
  source.verifiedDeliveryClaims?.forEach((d) => parts.push(d));
  source.verifiedReviews?.forEach((r) => parts.push(`${r.quote} ${r.author}`));
  return parts.join(' \n ').toLowerCase();
}

export function runQualityChecks(
  pkg: BlogPackage,
  source?: SourceMaterial
): QualityWarning[] {
  const warnings: QualityWarning[] = [];
  const fields = gatherText(pkg);
  const lower = fullText(pkg);
  const lowerNoPlaceholders = stripPlaceholders(lower);
  const verified = verifiedHaystack(source);

  // 1) Forbidden words (brand vocabulary)
  for (const fw of FORBIDDEN_WORDS) {
    const re = new RegExp(`\\b${escapeRegExp(fw.word.toLowerCase())}\\b`, 'i');
    if (re.test(lowerNoPlaceholders)) {
      warnings.push(
        warn('forbidden_word', 'block',
          `Zakázané slovo "${fw.word}" (${fw.reason}). Místo toho: ${fw.insteadUse}.`,
          undefined, fw.word)
      );
    }
  }

  // 2) Over-technical wording
  for (const term of OVER_TECHNICAL) {
    if (lowerNoPlaceholders.includes(term)) {
      warnings.push(
        warn('over_technical', 'warn',
          `Příliš technické slovo "${term}". Prodáváme emoce, ne technologii - přepiš na "kouzlo/proměna".`,
          undefined, term)
      );
    }
  }

  // 3) Fake review risk
  const hasVerifiedReviews = (source?.verifiedReviews?.length ?? 0) > 0;
  const reviewSignalFound = REVIEW_SIGNALS.some((s) => lower.includes(s.toLowerCase()));
  if (reviewSignalFound && !hasVerifiedReviews) {
    warnings.push(
      warn('fake_review_risk', 'block',
        'Text obsahuje recenzi/hodnocení, ale v source material nejsou žádné ověřené recenze. Odstraň, nebo doplň ověřenou recenzi a označ zdroj.',
        undefined, REVIEW_SIGNALS.find((s) => lower.includes(s.toLowerCase())))
    );
  }

  // 4) Invented numbers (digits/percentages not backed by source, not in [OVĚŘIT])
  const numberMatches = lowerNoPlaceholders.match(/\b\d[\d\s.,]*\s?(%|procent|fotek|fotografií|zákazník\w*|rodin|let|dnů|dní)?/g) || [];
  for (const raw of numberMatches) {
    const token = raw.trim();
    // ignore trivial small ordinals like "1.", "2.", "3 kroky" structure words
    if (/^\d{1,2}[.)]?$/.test(token)) continue;
    const digitsOnly = token.replace(/[^\d]/g, '');
    if (!digitsOnly) continue;
    if (verified.includes(digitsOnly) || verified.includes(token)) continue;
    warnings.push(
      warn('invented_number', 'warn',
        `Číslo "${token}" není podloženo source material. Doplň ověřený údaj nebo nahraď [OVĚŘIT].`,
        undefined, token)
    );
  }

  // 5) Invented delivery / pricing / paper claims
  checkTriggers(DELIVERY_TRIGGERS, lowerNoPlaceholders, verified, 'invented_delivery_claim',
    'Tvrzení o dodací lhůtě bez opory v source material.', warnings);
  checkTriggers(PRICING_TRIGGERS, lowerNoPlaceholders, verified, 'invented_pricing_claim',
    'Cenové tvrzení/sleva bez opory v source material.', warnings);
  checkTriggers(PAPER_TRIGGERS, lowerNoPlaceholders, verified, 'invented_paper_claim',
    'Tvrzení o gramáži/vlastnostech papíru bez opory v source material.', warnings);

  // 6) Generic unsupported claims (superlatives) not in [OVĚŘIT]
  const SUPERLATIVES = ['nejlepší', 'nejlevnější', 'č. 1', 'číslo jedna', '100 %', 'nejrychlejší', 'zaručeně'];
  for (const s of SUPERLATIVES) {
    if (lowerNoPlaceholders.includes(s.toLowerCase()) && !verified.includes(s.toLowerCase())) {
      warnings.push(
        warn('unsupported_claim', 'warn',
          `Nepodložené superlativum "${s}". Buď doplň důkaz ze source material, nebo zmírni formulaci.`,
          undefined, s)
      );
    }
  }

  // 7) Missing CTA
  if (!pkg.ctaBlock || !pkg.ctaBlock.buttonLabel || !pkg.ctaBlock.buttonUrl) {
    warnings.push(warn('missing_cta', 'block', 'Chybí kompletní CTA blok (buttonLabel + buttonUrl).', 'ctaBlock'));
  }

  // 8) Missing internal links
  if (!pkg.internalLinksUsed || pkg.internalLinksUsed.length === 0) {
    warnings.push(warn('missing_internal_links', 'warn', 'Článek nepoužívá žádné interní odkazy. Přidej alespoň jeden relevantní z source material.', 'internalLinksUsed'));
  }

  // 9) Generic / weak SEO title
  const seo = (pkg.seoTitle || '').trim();
  if (seo.length < SEO_RULES.seoTitleMin || seo.length > SEO_RULES.seoTitleMax) {
    warnings.push(warn('seo_title_length', 'warn',
      `SEO titulek má ${seo.length} znaků (doporučeno ${SEO_RULES.seoTitleMin}-${SEO_RULES.seoTitleMax}).`, 'seoTitle'));
  }
  if (pkg.targetKeyword && !seo.toLowerCase().includes(pkg.targetKeyword.toLowerCase().split(' ')[0])) {
    warnings.push(warn('seo_title_keyword', 'warn', 'SEO titulek zřejmě neobsahuje cílové klíčové slovo.', 'seoTitle'));
  }
  for (const phrase of SEO_RULES.genericTitlePhrases) {
    if (seo.toLowerCase().includes(phrase)) {
      warnings.push(warn('generic_seo_title', 'warn', `SEO titulek obsahuje generickou frázi "${phrase}".`, 'seoTitle', phrase));
    }
  }

  // 10) Meta description length
  const meta = (pkg.metaDescription || '').trim();
  if (meta.length < SEO_RULES.metaDescriptionMin || meta.length > SEO_RULES.metaDescriptionMax) {
    warnings.push(warn('meta_description_length', 'info',
      `Meta description má ${meta.length} znaků (doporučeno ${SEO_RULES.metaDescriptionMin}-${SEO_RULES.metaDescriptionMax}).`, 'metaDescription'));
  }

  // 11) Generic holiday fluff
  for (const phrase of HOLIDAY_FLUFF) {
    if (lower.includes(phrase)) {
      warnings.push(warn('holiday_fluff', 'info', `Generická sváteční vata "${phrase}". Nahraď konkrétním, osobním momentem.`, undefined, phrase));
    }
  }

  // 12) Forced seasonality
  if (pkg.riskOfForcedSeasonality === 'high') {
    warnings.push(warn('forced_seasonality', 'warn', 'riskOfForcedSeasonality = high: evergreen téma je násilně tlačeno do svátku. Zvaž evergreen rámec.', 'riskOfForcedSeasonality'));
  }
  // Evergreen articles use seasonalFitScore === 'not_applicable' and must NOT be
  // flagged. Only warn on a genuinely weak numeric score WITH a selected event.
  if (
    pkg.seasonalFitScore !== 'not_applicable' &&
    typeof pkg.seasonalFitScore === 'number' &&
    pkg.seasonalFitScore < 40 &&
    pkg.selectedEvent
  ) {
    warnings.push(warn('weak_seasonal_fit', 'info', `Nízký seasonalFitScore (${pkg.seasonalFitScore}) při zvolené příležitosti. Téma možná není sezónní.`, 'seasonalFitScore'));
  }

  // 13) Em dash usage
  for (const f of fields) {
    if (f.text.includes('—')) {
      warnings.push(warn('em_dash', 'warn', `Použit em dash (—) v poli ${f.field}. Nahraď pomlčkou nebo přeformuluj.`, f.field));
    }
  }

  // 14) Overuse of exclamation marks
  const exclamations = (lower.match(/!/g) || []).length;
  if (exclamations > 3) {
    warnings.push(warn('exclamation_overuse', 'warn', `Příliš mnoho vykřičníků (${exclamations}). Drž je střídmě (max ~3).`));
  }

  // 15) Author guard
  if (pkg.author !== 'David') {
    warnings.push(warn('wrong_author', 'block', 'Autor musí být "David".', 'author'));
  }

  return warnings;
}

function checkTriggers(
  triggers: string[],
  haystack: string,
  verified: string,
  code: string,
  message: string,
  warnings: QualityWarning[]
): void {
  for (const t of triggers) {
    if (haystack.includes(t) && !verified.includes(t)) {
      warnings.push(warn(code, 'warn', `${message} Spouštěč: "${t}".`, undefined, t));
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Convenience: split warnings by severity for a quick gate.
export function summarizeWarnings(warnings: QualityWarning[]): {
  blockers: QualityWarning[];
  warns: QualityWarning[];
  infos: QualityWarning[];
  passed: boolean;
} {
  const blockers = warnings.filter((w) => w.severity === 'block');
  const warns = warnings.filter((w) => w.severity === 'warn');
  const infos = warnings.filter((w) => w.severity === 'info');
  return { blockers, warns, infos, passed: blockers.length === 0 };
}
