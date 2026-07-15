// The calendar-of-ads generator: turn one marketing-calendar occasion into a small MIX of finished ad
// PNGs (a couple of template families × a couple of formats), on-brand, and persist them so the
// Kreativy gallery can show them next to the calendar. Every external call (copy, image, line-art,
// render) is an injected dep, so this orchestration is unit-testable with stubs — no network/GPU.
//
// The imagery is generated from TEXT prompts (occasion → scene), never from a customer photo, so
// these brand ads carry no customer identity. `reference-zakaznika` is excluded from the auto mix
// (we never fabricate a testimonial).

import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { TEMPLATES, templateSlots } from './studio/templates.js';
import { formatDef } from './studio/formats.js';
import { renderStudioHtml } from './studio/renderStudioHtml.js';
import { creativeFilename } from './studio/templateModel.js';
import { occasionKey } from './calendar.js';

/** The two formats we auto-produce per concept (the two most-used placements). */
export const AUTO_FORMATS = ['feed', 'story'];

/** Pick the concept mix for an occasion: `promena` always (the clearest before→after ad), plus one
 *  tone-appropriate second family. Two concepts × AUTO_FORMATS = 4 ads — a "mix" in David's 3–5 range. */
export function pickTemplates(occasion) {
  const second = occasion.tone === 'brand' ? 'emotivni-darek' : occasion.tone === 'warm' ? 'spolecne-vybarvovani' : 'produktova-ukazka';
  return ['promena', second];
}

/** The promena "before": a warm, identity-free MEMORY moment — the kind of photo a customer would
 *  send. Its "after" is the line-art coloring page, so the transformation itself is the product; no
 *  book in this frame (a book here would muddy the before→after story). */
export function momentPrompt(occasion) {
  return [
    'A warm, candid, editorial-quality lifestyle photograph — a cherished, un-staged family moment of',
    'the kind a customer would treasure and want turned into a keepsake.',
    `Occasion and mood: ${occasion.name} — ${occasion.angle}`,
    `Subject: ${occasion.persona}, shown only in generic terms with NO identifiable faces (candid angle,`,
    'seen from behind, or soft focus). Cozy Czech home or seasonal outdoor setting, soft natural window',
    'light, gentle shadows, shallow depth of field, muted tasteful colours, authentic and heart-warming.',
    'Photorealistic. No text, no logos, no watermark, no illustration, no UI.',
  ].join(' ');
}

/** A lifestyle scene where the printed personalized coloring book is the HERO — so the ad actually
 *  shows the product in use. Identity-free, premium, uncluttered (deliberately not "AI slop"). */
export function scenePrompt(occasion) {
  return [
    'A warm, editorial-quality lifestyle photograph for a premium brand that turns family photos into',
    'personalized printed coloring books. HERO PRODUCT, clearly visible and in sharp focus: a real',
    'printed coloring book open to a clean black-and-white line-art page, being coloured in with a few',
    'quality coloured pencils — or resting open on a cozy table mid-colouring.',
    `Occasion and mood: ${occasion.name} — ${occasion.angle}`,
    `People (${occasion.persona}) present only as hands or a soft over-the-shoulder view, NO`,
    'identifiable faces. Natural window light, soft shadows, shallow depth of field, tasteful,',
    'uncluttered, high-end and authentic. No text, no logos, no watermark, no UI, no illustration overlays.',
  ].join(' ');
}

/** A premium product shot of the physical printed personalized coloring book (the product itself). */
export function productPrompt(occasion) {
  return [
    'A premium, magazine-quality product photograph of a printed personalized coloring book resting on',
    'a light wooden table, open to reveal a clean, friendly black-and-white line-art page, a few quality',
    `coloured pencils resting neatly beside it. Soft natural daylight, gentle shadows, minimalist and`,
    `tasteful. A subtle seasonal hint of: ${occasion.name}. No readable text, no logos, no watermark, no clutter.`,
  ].join(' ');
}

const dataUri = (img) => `data:${img.mimeType || 'image/png'};base64,${img.base64}`;

/** Generate the image assets one concept needs, keyed by slot. `imageFn`/`lineArtFn` are injected.
 *  The promena "before" (original) is a bookless memory moment; lifestyle/product slots feature the
 *  physical coloring book. `original` and `lifestyle` never co-occur in a template, so at most one
 *  scene image is generated per concept (the buildAssets contract the tests assert). */
export async function buildAssets({ occasion, template, imageFn, lineArtFn }) {
  const slots = templateSlots(template);
  const assets = {};
  let sceneForLineArt = null;
  if (slots.includes('original')) {
    const img = await imageFn({ prompt: momentPrompt(occasion) });
    assets.original = dataUri(img);
    sceneForLineArt = img;
  }
  if (slots.includes('lifestyle')) {
    assets.lifestyle = dataUri(await imageFn({ prompt: scenePrompt(occasion) }));
  }
  if (slots.includes('coloring')) {
    if (typeof lineArtFn !== 'function') throw new Error('coloring slot needs a lineArtFn');
    if (!sceneForLineArt) sceneForLineArt = await imageFn({ prompt: momentPrompt(occasion) });
    assets.coloring = dataUri(await lineArtFn(sceneForLineArt));
  }
  if (slots.includes('product')) {
    assets.product = dataUri(await imageFn({ prompt: productPrompt(occasion) }));
  }
  return assets;
}

// ---- store -----------------------------------------------------------------

export const INDEX_FILE = 'creatives-index.json';

/** Read the whole creatives index ({ generatedAt, occasions: { key: {occasion, ads[]} } }). */
export function readIndex(dataDir) {
  const path = join(dataDir, INDEX_FILE);
  if (!existsSync(path)) return { generatedAt: null, occasions: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && parsed.occasions ? parsed : { generatedAt: null, occasions: {} };
  } catch {
    return { generatedAt: null, occasions: {} };
  }
}

/** Merge one occasion's entry into the index and persist. Last write wins for that occasion. */
export function writeOccasionToIndex(dataDir, entry) {
  mkdirSync(dataDir, { recursive: true });
  const index = readIndex(dataDir);
  index.occasions[entry.key] = entry;
  index.generatedAt = new Date().toISOString();
  writeFileSync(join(dataDir, INDEX_FILE), JSON.stringify(index, null, 2));
  return index;
}

// ---- orchestration ---------------------------------------------------------

/**
 * Generate + persist the ad mix for one occasion. Renders each concept×format to a PNG under
 * `<dataDir>/ads/<key>/` and returns the index entry (also merged into creatives-index.json).
 * @param {object} o
 * @param {object} o.occasion    a MARKETING_CAL entry
 * @param {string} o.dataDir     where to write (config.creatives.dataDir)
 * @param {object} o.deps        { copyFn, imageFn, lineArtFn, renderFn, brand }
 * @param {string[]} [o.templates] override the concept mix
 * @param {string[]} [o.formats]   override the formats
 * @param {function} [o.onProgress] (msg) => void
 */
export async function generateOccasionAds({ occasion, dataDir, deps, templates = pickTemplates(occasion), formats = AUTO_FORMATS, onProgress = () => {} } = {}) {
  const key = occasionKey(occasion);
  const outDir = join(dataDir, 'ads', key);
  mkdirSync(outDir, { recursive: true });
  const ads = [];
  for (const tid of templates) {
    const template = TEMPLATES[tid];
    if (!template) continue;
    onProgress(`  ${key} · ${template.family}: copy`);
    const { copy, source } = await deps.copyFn({ occasion, template });
    onProgress(`  ${key} · ${template.family}: images`);
    const assets = await buildAssets({ occasion, template, imageFn: deps.imageFn, lineArtFn: deps.lineArtFn });
    for (const format of formats) {
      if (!template.supportedFormats.includes(format)) continue;
      const F = formatDef(format);
      const file = creativeFilename({ occasion: occasion.name, angle: template.family, format, index: ads.length + 1 });
      const html = renderStudioHtml({ template, format, copy, assets, brand: deps.brand ?? {} });
      await deps.renderFn({ html, width: F.w, height: F.h, outPath: join(outDir, file) });
      ads.push({ id: `${key}/${file}`, template: tid, family: template.family, format, file, copy, copySource: source });
      onProgress(`  ${key} · ${template.family} · ${format} ✓`);
    }
  }
  const entry = { key, occasion, ads, generatedAt: new Date().toISOString() };
  writeOccasionToIndex(dataDir, entry);
  return entry;
}
