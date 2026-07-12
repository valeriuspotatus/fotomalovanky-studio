// The deterministic template model (pure). A template is an ordered list of typed, boxed elements;
// the app — never the AI — places them. This module owns the geometry and the quality checks:
//   - resolveTemplate(template, format): merge each element's base box/style with its per-format
//     override, drop hidden elements, order back-to-front by layer.
//   - boxToPx: percent box (0..100 of the canvas) -> pixel box for a format.
//   - validateConcept: the QC pass — missing copy/asset, text overflow, logo too small, safe-zone
//     breaches -> findings + an overall status (pripraveno / varovani / nedokonceno).
//   - creativeFilename: the export naming scheme.
//
// Boxes are PERCENTAGES of the format canvas so a base layout already adapts across ratios; per-format
// overrides (element.formats[format]) handle the cases where a straight percentage would break
// hierarchy. No IO, no rendering — renderStudioHtml.js turns a resolved template into HTML.

import { formatDef } from './formats.js';

export const ELEMENT_TYPES = Object.freeze(['background', 'panel', 'image', 'text', 'badge', 'cta', 'logo', 'decoration']);
export const IMAGE_SLOTS = Object.freeze(['original', 'coloring', 'lifestyle', 'product']);
/** Structured copy fields (the brief's copy model). A text/cta/badge element binds to one via `field`. */
export const COPY_FIELDS = Object.freeze(['headline', 'support', 'cta', 'badge', 'offer', 'deadline', 'testimonial', 'testimonialAuthor', 'legal']);

const SLOT_LABELS = { original: 'původní fotka', coloring: 'omalovánka', lifestyle: 'lifestyle fotka', product: 'produkt' };
export const slotLabel = (slot) => SLOT_LABELS[slot] ?? slot ?? 'obrázek';

const FIELD_LABELS = { headline: 'nadpis', support: 'popisek', cta: 'výzva (CTA)', badge: 'odznak', offer: 'nabídka', deadline: 'termín', testimonial: 'recenze', testimonialAuthor: 'autor recenze', legal: 'poznámka' };
export const fieldLabel = (field) => FIELD_LABELS[field] ?? field ?? 'text';

/** Merge one element with its per-format override. Never mutates the input. */
export function resolveElement(el, format) {
  const o = (el.formats && el.formats[format]) || {};
  return {
    ...el,
    box: { ...el.box, ...(o.box || {}) },
    style: { ...(el.style || {}), ...(o.style || {}) },
    text: o.text ?? el.text,
    hidden: o.hidden ?? el.hidden ?? false,
    layer: o.layer ?? el.layer ?? 0,
  };
}

/** All visible elements of a template for a format, back-to-front by layer. Throws if the template
 *  doesn't declare support for the format (a format change must be an intentional layout, not a guess). */
export function resolveTemplate(template, format) {
  if (!template || !Array.isArray(template.elements)) throw new Error('A template must have an elements array.');
  if (Array.isArray(template.supportedFormats) && !template.supportedFormats.includes(format)) {
    throw new Error(`Template "${template.id}" does not support format "${format}".`);
  }
  return template.elements
    .map((el) => resolveElement(el, format))
    .filter((el) => !el.hidden)
    .sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0));
}

/** Percent box {x,y,w,h in 0..100} -> integer pixel box for a format. */
export function boxToPx(box, format) {
  const F = formatDef(format);
  return {
    x: Math.round(((box?.x ?? 0) / 100) * F.w),
    y: Math.round(((box?.y ?? 0) / 100) * F.h),
    w: Math.round(((box?.w ?? 0) / 100) * F.w),
    h: Math.round(((box?.h ?? 0) / 100) * F.h),
  };
}

/** The text a text-ish element shows: the campaign copy for its `field`, else its literal `text`. */
export function textForElement(el, copy = {}) {
  if (el.field && copy[el.field] != null && copy[el.field] !== '') return String(copy[el.field]);
  return el.text != null ? String(el.text) : '';
}

/** Rough line estimate: chars that fit per line ≈ box width / (fontSize * average glyph ratio).
 *  Approximate on purpose — it drives a soft overflow WARNING, never a hard block. */
export function estimateLines(text, el, format) {
  const px = boxToPx(el.box, format);
  const fontSize = el.style?.fontSize ?? 40;
  const glyph = fontSize * 0.52; // average advance width for the rounded display face
  const perLine = Math.max(1, Math.floor(px.w / glyph));
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  let lines = 1;
  let len = 0;
  for (const w of words) {
    const add = (len ? 1 : 0) + w.length;
    if (len + add > perLine && len > 0) {
      lines += 1;
      len = w.length;
    } else {
      len += add;
    }
  }
  return lines;
}

/** The QC pass over one concept-in-a-format. Returns { status, findings }. Findings carry a
 *  severity ('error'|'warn'), the offending elementId (so a warning is clickable), a code and a
 *  Czech message. Errors → 'nedokonceno', warnings only → 'varovani', clean → 'pripraveno'. */
export function validateConcept({ template, format, copy = {}, assets = {} } = {}) {
  const F = formatDef(format);
  const findings = [];
  const add = (severity, elementId, code, message) => findings.push({ severity, elementId, code, message });

  const elements = resolveTemplate(template, format);
  let hasCta = false;

  for (const el of elements) {
    const px = boxToPx(el.box, format);
    const c = el.constraints || {};

    if (el.type === 'text' || el.type === 'cta' || el.type === 'badge') {
      if (el.type === 'cta') hasCta = true;
      const text = textForElement(el, copy);
      const trimmed = text.trim();
      if (c.required && !trimmed) {
        add('error', el.id, 'missing-copy', `Chybí ${fieldLabel(el.field)}.`);
      }
      if (c.maxChars && trimmed.length > c.maxChars) {
        add('warn', el.id, 'overflow-chars', `Text „${fieldLabel(el.field)}" má ${trimmed.length} znaků (limit ${c.maxChars}).`);
      }
      if (c.maxLines && trimmed && estimateLines(trimmed, el, format) > c.maxLines) {
        add('warn', el.id, 'overflow-lines', `Text „${fieldLabel(el.field)}" se nevejde na ${c.maxLines} řádky.`);
      }
      if (!c.allowBleed && trimmed && (px.x < F.safe || px.y < F.safe || px.x + px.w > F.w - F.safe || px.y + px.h > F.h - F.safe)) {
        add('warn', el.id, 'safe-zone', `Prvek „${fieldLabel(el.field)}" zasahuje do okraje (bezpečná zóna ${F.safe}px).`);
      }
    }

    if (el.type === 'image') {
      const src = assets[el.slot];
      if (c.required && !src) add('error', el.id, 'missing-asset', `Chybí obrázek: ${slotLabel(el.slot)}.`);
    }

    if (el.type === 'logo') {
      const minW = c.minW != null ? (c.minW / 100) * F.w : 96;
      if (px.w < minW) add('warn', el.id, 'logo-small', `Logo je menší než ${Math.round(minW)}px — hůř čitelné.`);
      if (px.x < F.safe || px.x + px.w > F.w - F.safe) add('warn', el.id, 'logo-safe', 'Logo zasahuje do okraje.');
    }
  }

  // A template that declares it needs a CTA but resolves without one (all hidden) is incomplete.
  if (template.requiresCta && !hasCta) add('warn', null, 'missing-cta', 'Kreativa nemá výzvu k akci (CTA).');

  const status = findings.some((f) => f.severity === 'error') ? 'nedokonceno' : findings.some((f) => f.severity === 'warn') ? 'varovani' : 'pripraveno';
  return { status, findings };
}

/** Accent-folding slug for filenames: "Vánoce" -> "vanoce", "Emotivní dárek" -> "emotivni-darek". */
export function slugify(s) {
  return (
    String(s ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'x'
  );
}

/** Export filename, e.g. fotomalovanky_vanoce_emotivni-darek_feed_01.png. */
export function creativeFilename({ occasion = '', angle = '', format = 'feed', index = 1, ext = 'png' } = {}) {
  const nn = String(Math.max(1, Math.floor(index))).padStart(2, '0');
  return `fotomalovanky_${slugify(occasion)}_${slugify(angle)}_${slugify(format)}_${nn}.${ext}`;
}
