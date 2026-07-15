// Generate one SEO-structured Czech blog post from a chosen topic. The model returns STRUCTURED JSON
// (intro + sections + FAQ), never raw HTML — the app assembles the body HTML deterministically so the
// heading hierarchy, lists, FAQ block and CTA are consistent and the SEO contract is enforced in code,
// not left to the model. Every field is clamped to its cap and falls back to a sensible skeleton on any
// model failure, so a draft always exists to edit (mirrors adCopy.js's clamp/loose-JSON/seed pattern).
//
// No fabricated claims: the prompt forbids invented reviews, discounts and deadlines, and QC flags the
// brand's banned vocabulary. Nothing here publishes — draft.js only writes words.

import { slugify } from '../creatives/studio/templateModel.js';
import { parseJsonLoose, clampChars } from '../creatives/adCopy.js';
import { BLOG_VOICE, bannedHits, fold } from './voice.js';

export const SEO_TITLE_MAX = 60;
export const META_MAX = 155;
const SHOP_URL = 'https://www.fotomalovanky.cz/';
const FAQ_HEADING = 'Časté dotazy';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The generation prompt: brand voice + the topic + the exact JSON shape (structured, not HTML). */
export function buildDraftPrompt({ topic, wordCountMin, wordCountMax }) {
  return [
    BLOG_VOICE,
    '',
    `Napiš SEO optimalizovaný český článek na blog na téma: „${topic.title}".`,
    `Cílové klíčové slovo: „${topic.keyword}". Musí být v titulku, v prvním odstavci (do ~100 slov) a přirozeně v textu — bez keyword stuffingu.`,
    topic.intent ? `Kontext / vyhledávací záměr: ${topic.intent}` : '',
    `Rozsah ${wordCountMin}–${wordCountMax} slov. Struktura: úvod, 3–5 sekcí s podnadpisy, aspoň jeden seznam, blok FAQ.`,
    '',
    'Vrať POUZE platný JSON objekt (bez markdown fencí, bez komentářů), přesně v tomto tvaru:',
    '{',
    `  "seoTitle": "SEO titulek s klíčovým slovem (max ${SEO_TITLE_MAX} znaků)",`,
    `  "metaDescription": "meta popis s klíčovým slovem (max ${META_MAX} znaků)",`,
    '  "handle": "url-slug-s-klicovym-slovem",',
    '  "tags": ["štítek1", "štítek2", "štítek3"],',
    '  "intro": "úvodní odstavec, klíčové slovo v prvních ~100 slovech",',
    '  "sections": [ { "h2": "podnadpis", "paragraphs": ["odstavec", "odstavec"], "bullets": ["bod", "bod"] } ],',
    '  "faq": [ { "q": "otázka", "a": "odpověď" } ],',
    '  "internalLinkHint": "návrh, na jaký produkt/kolekci v článku odkázat",',
    '  "heroPrompt": "popis titulní fotky (bez identifikovatelných tváří, bez textu)",',
    '  "heroAlt": "alt text titulní fotky s klíčovým slovem"',
    '}',
    'Text je konkrétní k tématu, ne obecný. "bullets" je volitelné pole (vynech u sekcí bez seznamu).',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Plain-text words in the whole post (for the length QC + the keyword-in-intro check). */
function wordCount(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

/** Deterministically assemble the body HTML from the structured post. H1 is the article title in
 *  Shopify, so the body starts at H2; the CTA links to the shop (internal link is a separate hint). */
export function buildBodyHtml(post) {
  const out = [];
  if (post.intro) out.push(`<p>${esc(post.intro)}</p>`);
  for (const s of post.sections ?? []) {
    if (s.h2) out.push(`<h2>${esc(s.h2)}</h2>`);
    for (const p of s.paragraphs ?? []) if (p && p.trim()) out.push(`<p>${esc(p)}</p>`);
    const bullets = (s.bullets ?? []).filter((b) => b && b.trim());
    if (bullets.length) out.push(`<ul>${bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`);
  }
  const faq = (post.faq ?? []).filter((f) => f && f.q && f.a);
  if (faq.length) {
    out.push(`<h2>${FAQ_HEADING}</h2>`);
    for (const f of faq) out.push(`<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`);
  }
  out.push(`<p><a href="${SHOP_URL}">Vytvořte si omalovánku z vlastní fotky &rarr;</a></p>`);
  return out.join('\n');
}

/** Non-blocking QC: the SEO contract as clickable warnings. Returns { warnings: [{code, message}] }. */
export function qcPost(post, { wordCountMin = 800 } = {}) {
  const warnings = [];
  const w = (code, message) => warnings.push({ code, message });
  const kw = fold(post.topic?.keyword);
  // First ~100 words of the whole post — equals the intro for a fresh draft, and stays correct after
  // David hand-edits the body HTML (plainText is recomputed from bodyHtml on save).
  const intro100 = String(post.plainText ?? post.intro ?? '').split(/\s+/).slice(0, 100).join(' ');
  if (kw && !fold(post.seoTitle).includes(kw)) w('keyword-title', 'Klíčové slovo není v SEO titulku.');
  if (kw && !fold(intro100).includes(kw)) w('keyword-intro', 'Klíčové slovo není v prvních ~100 slovech úvodu.');
  if ((post.seoTitle ?? '').length > SEO_TITLE_MAX) w('title-long', `SEO titulek má ${post.seoTitle.length} znaků (limit ${SEO_TITLE_MAX}).`);
  if (!String(post.metaDescription ?? '').trim()) w('meta-missing', 'Chybí meta popis.');
  else if (post.metaDescription.length > META_MAX) w('meta-long', `Meta popis má ${post.metaDescription.length} znaků (limit ${META_MAX}).`);
  const words = wordCount(post.plainText);
  if (words < wordCountMin) w('body-short', `Článek má ${words} slov (doporučeno aspoň ${wordCountMin}).`);
  if (!String(post.internalLinkHint ?? '').trim()) w('no-internal-link', 'Chybí návrh interního odkazu.');
  if (!(post.faq ?? []).length) w('no-faq', 'Chybí blok FAQ (dobrý pro rich results).');
  if (post.heroPrompt && !String(post.heroAlt ?? '').trim()) w('no-hero-alt', 'Titulní fotka nemá alt text.');
  const banned = bannedHits(`${post.seoTitle} ${post.metaDescription} ${post.plainText}`);
  if (banned.length) w('banned', `Zakázaná slova: ${banned.join(', ')}.`);
  return { warnings };
}

/** Strip tags to plain text (for the QC word count + keyword/banned scan of hand-edited body HTML). */
export function stripHtml(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Re-derive plainText from the (possibly hand-edited) body HTML and re-run QC. Used on editor save so
 *  the warnings track what David actually wrote, not the original generated fields. */
export function recomputePost(post, opts = {}) {
  const plainText = stripHtml(post.bodyHtml);
  const next = { ...post, plainText };
  next.qc = qcPost(next, opts);
  return next;
}

/** Concatenate all human-readable text (for word count + banned-word scan), ignoring HTML. */
function plainTextOf(post) {
  const parts = [post.intro];
  for (const s of post.sections ?? []) {
    parts.push(s.h2, ...(s.paragraphs ?? []), ...(s.bullets ?? []));
  }
  for (const f of post.faq ?? []) parts.push(f.q, f.a);
  return parts.filter(Boolean).join(' ');
}

/** A minimal but valid post so a bad model response still yields something to edit. */
function skeleton(topic) {
  const title = clampChars(topic.title || 'Nový článek', SEO_TITLE_MAX);
  return {
    seoTitle: title,
    metaDescription: clampChars(`${topic.title} — tipy a nápady od Fotomalovánky.cz.`, META_MAX),
    handle: slugify(topic.keyword || topic.title),
    tags: [],
    intro: `${topic.title}. ${topic.intent ?? ''}`.trim(),
    sections: [{ h2: topic.title, paragraphs: ['Doplňte text článku.'], bullets: [] }],
    faq: [],
    internalLinkHint: '',
    heroPrompt: '',
    heroAlt: '',
  };
}

/** Coerce the model's parsed JSON into the clean, clamped structured shape. */
function normalize(parsed, topic) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    seoTitle: clampChars(str(parsed.seoTitle) || topic.title, SEO_TITLE_MAX),
    metaDescription: clampChars(str(parsed.metaDescription), META_MAX),
    handle: slugify(str(parsed.handle) || topic.keyword || topic.title),
    tags: arr(parsed.tags).map(str).filter(Boolean).slice(0, 6),
    intro: str(parsed.intro),
    sections: arr(parsed.sections)
      .map((s) => ({
        h2: str(s?.h2),
        paragraphs: arr(s?.paragraphs).map(str).filter(Boolean),
        bullets: arr(s?.bullets).map(str).filter(Boolean),
      }))
      .filter((s) => s.h2 || s.paragraphs.length),
    faq: arr(parsed.faq)
      .map((f) => ({ q: str(f?.q), a: str(f?.a) }))
      .filter((f) => f.q && f.a),
    internalLinkHint: str(parsed.internalLinkHint),
    heroPrompt: str(parsed.heroPrompt),
    heroAlt: str(parsed.heroAlt),
  };
}

/**
 * Generate a post for a topic. Returns the full post object (structured fields + assembled bodyHtml +
 * QC warnings + status 'koncept'), never throws — a model failure yields the skeleton with source 'seed'.
 * @param {object} o
 * @param {object} o.topic          { title, keyword, intent?, source?, occasionKey? }
 * @param {function} o.generateTextFn ({config, prompt}) => Promise<string>
 * @param {object} [o.config]       the config.ai block passed through
 * @param {number} [o.wordCountMin] / [o.wordCountMax]
 */
export async function generatePost({ topic, generateTextFn, config, wordCountMin = 800, wordCountMax = 1500 } = {}) {
  if (!topic || !topic.title) throw new Error('generatePost needs a topic with a title.');
  let fields;
  let source = 'ai';
  try {
    const raw = await generateTextFn({ config, prompt: buildDraftPrompt({ topic, wordCountMin, wordCountMax }) });
    const parsed = parseJsonLoose(raw);
    if (!parsed) throw new Error('model did not return JSON');
    fields = normalize(parsed, topic);
    if (!fields.intro && !fields.sections.length) throw new Error('model returned an empty post');
  } catch {
    fields = skeleton(topic);
    source = 'seed';
  }
  const post = {
    id: fields.handle,
    topic: { title: topic.title, keyword: topic.keyword, intent: topic.intent ?? '', source: topic.source ?? 'manual', occasionKey: topic.occasionKey ?? null },
    ...fields,
    heroImage: null,
    status: 'koncept',
    shopifyArticleId: null,
    copySource: source,
  };
  post.plainText = plainTextOf(post);
  post.bodyHtml = buildBodyHtml(post);
  post.qc = qcPost(post, { wordCountMin });
  return post;
}
