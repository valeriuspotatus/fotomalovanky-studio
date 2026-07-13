// Generate Czech ad copy for one calendar occasion, shaped to a template family's bound fields and
// character limits. The imagery is generated elsewhere; this fills the words. Gemini returns strict
// JSON; every field is clamped to its maxChars and falls back to the template's seed copy on any
// failure, so a bad model response degrades to a sensible ad rather than blocking it.
//
// The `reference-zakaznika` (testimonial) family is deliberately NOT auto-generated anywhere — we
// never fabricate a customer review. adCalendar.js excludes it from the auto mix.

import { templateFields, templateFieldLimits, SEED_COPY } from './studio/templates.js';

/** Fotomalovánky brand voice — warm, personal, Czech, a little playful; never salesy-shouty. */
const BRAND_VOICE = [
  'Fotomalovánky.cz proměňuje osobní fotky zákazníků na omalovánky a tištěné omalovánkové knihy na míru.',
  'Tón značky: vřelý, osobní, česky, s lehkou hravostí. Mluvíme k člověku, ne k davu. Žádné klišé, žádné',
  'křičení velkými písmeny, žádné vykřičníky navíc. Emoce a vzpomínka jsou důležitější než sleva.',
].join(' ');

/** Effective character cap for a field. `support` is capped tighter than the template's hard limit so
 *  it stays a punchy ~single line and can't overflow into the CTA in the tighter product layout. */
export function copyCap(field, limits) {
  const base = limits[field];
  return field === 'support' ? Math.min(base || 80, 58) : base;
}

/** Build the copy prompt: brand voice + the occasion + exactly which JSON keys to return with limits. */
export function buildCopyPrompt({ occasion, template }) {
  const fields = templateFields(template);
  const limits = templateFieldLimits(template);
  const spec = fields
    .map((f) => `  "${f}": ${fieldHint(f)}${copyCap(f, limits) ? ` (max ${copyCap(f, limits)} znaků)` : ''}`)
    .join('\n');
  return [
    BRAND_VOICE,
    '',
    `Příležitost: ${occasion.name} (${occasion.m}/${occasion.d}).`,
    `Cílová skupina: ${occasion.persona}.`,
    `Úhel sdělení: ${occasion.angle}`,
    `Šablona reklamy: ${template.family} — ${template.explanation}`,
    '',
    'Napiš text pro tuto konkrétní reklamu. Vrať POUZE platný JSON objekt s přesně těmito klíči,',
    'v češtině, bez uvozovek okolo celého objektu, bez markdown fencí, bez komentářů:',
    '{',
    spec,
    '}',
    '',
    fields.includes('headlineHi')
      ? 'Titulek rozděl na dvě NEPŘEKRÝVAJÍCÍ se části, které dohromady tvoří jednu větu: "headline" = ' +
        'začátek titulku a "headlineHi" = posledních 1–2 slova, která větu dokončí (zvýrazní se). Např. ' +
        'celý titulek „Vzpomínka, která se dá vybarvit“ => "headline":„Vzpomínka, která se dá“, ' +
        '"headlineHi":„vybarvit“. Slova z "headlineHi" se NESMÍ objevit v "headline".'
      : '',
    'Dodrž limity znaků. Text musí být konkrétní k této příležitosti, ne obecný.',
  ].filter(Boolean).join('\n');
}

/** A short human hint per field so the model fills the right thing. */
function fieldHint(field) {
  switch (field) {
    case 'headline':
      return 'začátek titulku (bez zvýrazněného konce)';
    case 'headlineHi':
      return 'posledních 1–2 slova titulku, která na "headline" navazují a zvýrazní se';
    case 'support':
      return 'krátká podpůrná věta na jeden řádek';
    case 'cta':
      return 'výzva k akci (tlačítko)';
    case 'badge':
      return 'krátký odznak/štítek (např. „Dárek na míru“)';
    default:
      return 'text';
  }
}

/** Clamp to maxChars without cutting a word mid-way (drop the trailing partial word). No ellipsis —
 *  an ad reads as finished text, not truncated. */
export function clampChars(s, max) {
  const t = String(s ?? '').trim();
  if (!max || t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

/** The renderer shows `headline` then `headlineHi` as a highlighted tail, so the two must not overlap.
 *  Models sometimes repeat the highlighted phrase inside the headline ("… fotku **fotku**"); strip any
 *  occurrence of headlineHi from headline so it's never shown twice. Pure, mutates + returns copy. */
export function dedupeHighlight(copy) {
  if (!copy?.headline || !copy?.headlineHi) return copy;
  const h = copy.headline;
  const i = h.toLowerCase().indexOf(copy.headlineHi.toLowerCase());
  if (i === -1) return copy; // proper complementary parts — nothing to do
  copy.headline = (h.slice(0, i) + ' ' + h.slice(i + copy.headlineHi.length))
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '')
    .trim();
  return copy;
}

/** Pull a JSON object out of a model response that may be fenced or have prose around it. */
export function parseJsonLoose(raw) {
  const s = String(raw ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Generate copy for one (occasion, template). Returns { copy, source } where source is 'ai' or 'seed'
 * (fallback). Never throws — a failure yields the seed copy so the ad still renders.
 * @param {object} o
 * @param {object} o.occasion        a MARKETING_CAL entry { m, d, name, persona, angle, tone }
 * @param {object} o.template        a TEMPLATES entry
 * @param {function} o.generateTextFn ({config, prompt}) => Promise<string>   (Gemini text; injectable)
 * @param {object} [o.config]        the config.ai block passed through to generateTextFn
 */
export async function generateAdCopy({ occasion, template, generateTextFn, config } = {}) {
  const fields = templateFields(template);
  const limits = templateFieldLimits(template);
  const seed = SEED_COPY[template.id] ?? {};
  try {
    const raw = await generateTextFn({ config, prompt: buildCopyPrompt({ occasion, template }) });
    const parsed = parseJsonLoose(raw);
    if (!parsed) throw new Error('model did not return JSON');
    const copy = {};
    for (const f of fields) {
      const v = typeof parsed[f] === 'string' && parsed[f].trim() ? parsed[f].trim() : seed[f] ?? '';
      const cap = copyCap(f, limits);
      copy[f] = cap ? clampChars(v, cap) : v;
    }
    dedupeHighlight(copy);
    return { copy, source: 'ai' };
  } catch (err) {
    return { copy: { ...seed }, source: 'seed', error: err.message };
  }
}
