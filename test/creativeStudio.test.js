import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STUDIO_FORMATS, DEFAULT_FORMATS, formatDef, isFormat } from '../src/creatives/studio/formats.js';
import {
  resolveElement,
  resolveTemplate,
  boxToPx,
  textForElement,
  estimateLines,
  validateConcept,
  slugify,
  creativeFilename,
} from '../src/creatives/studio/templateModel.js';
import { renderStudioHtml } from '../src/creatives/studio/renderStudioHtml.js';
import { TEMPLATES, listTemplates, getTemplate, templateSlots, templateFields, SEED_COPY } from '../src/creatives/studio/templates.js';

// ---- formats ---------------------------------------------------------------

test('formats are square/tall/wide with sane sizes and safe zones', () => {
  assert.equal(STUDIO_FORMATS.feed.w, STUDIO_FORMATS.feed.h, 'feed is 1:1');
  assert.ok(STUDIO_FORMATS.story.h > STUDIO_FORMATS.story.w, 'story is tall');
  assert.ok(STUDIO_FORMATS.landscape.w > STUDIO_FORMATS.landscape.h, 'landscape is wide');
  for (const f of Object.values(STUDIO_FORMATS)) assert.ok(f.safe > 0 && f.safe < f.w / 2);
  assert.deepEqual(DEFAULT_FORMATS, ['feed', 'story', 'landscape']);
  assert.equal(isFormat('feed'), true);
  assert.equal(isFormat('nope'), false);
  assert.throws(() => formatDef('nope'), /Unknown format/);
});

// ---- element / template resolution -----------------------------------------

test('resolveElement merges the per-format override without mutating the base', () => {
  const el = { id: 'h', type: 'text', box: { x: 10, y: 10, w: 50, h: 10 }, style: { fontSize: 40 }, formats: { story: { box: { x: 5, w: 90 }, style: { fontSize: 70 } } } };
  const feed = resolveElement(el, 'feed');
  assert.deepEqual(feed.box, { x: 10, y: 10, w: 50, h: 10 });
  assert.equal(feed.style.fontSize, 40);
  const story = resolveElement(el, 'story');
  assert.deepEqual(story.box, { x: 5, y: 10, w: 90, h: 10 }, 'override merges x+w, keeps y+h');
  assert.equal(story.style.fontSize, 70);
  assert.equal(el.box.x, 10, 'the base element is untouched');
});

test('resolveTemplate drops hidden elements and orders back-to-front by layer', () => {
  const tpl = {
    id: 't',
    supportedFormats: ['feed'],
    elements: [
      { id: 'top', type: 'text', layer: 10, box: {} },
      { id: 'bg', type: 'background', layer: 0, box: {} },
      { id: 'gone', type: 'text', layer: 5, box: {}, hidden: true },
      { id: 'mid', type: 'image', layer: 5, box: {} },
    ],
  };
  const out = resolveTemplate(tpl, 'feed');
  assert.deepEqual(out.map((e) => e.id), ['bg', 'mid', 'top']);
});

test('resolveTemplate refuses a format the template does not declare', () => {
  assert.throws(() => resolveTemplate({ id: 'x', supportedFormats: ['feed'], elements: [] }, 'story'), /does not support/);
});

test('boxToPx converts percentages to pixels for the format', () => {
  assert.deepEqual(boxToPx({ x: 50, y: 50, w: 50, h: 50 }, 'feed'), { x: 540, y: 540, w: 540, h: 540 });
  assert.deepEqual(boxToPx({ x: 0, y: 0, w: 100, h: 100 }, 'story'), { x: 0, y: 0, w: 1080, h: 1920 });
});

// ---- copy binding + overflow -----------------------------------------------

test('textForElement prefers the campaign copy for its field, else the literal text', () => {
  assert.equal(textForElement({ field: 'headline', text: 'fallback' }, { headline: 'Ahoj' }), 'Ahoj');
  assert.equal(textForElement({ field: 'headline', text: 'fallback' }, {}), 'fallback');
  assert.equal(textForElement({ text: 'lit' }, {}), 'lit');
});

test('estimateLines grows with text length and shrinks with box width', () => {
  const narrow = { box: { x: 0, y: 0, w: 20, h: 10 }, style: { fontSize: 40 } };
  const wide = { box: { x: 0, y: 0, w: 90, h: 10 }, style: { fontSize: 40 } };
  const text = 'Vzpomínka která se dá vybarvit a potěší celou rodinu';
  assert.ok(estimateLines(text, narrow, 'feed') > estimateLines(text, wide, 'feed'));
  assert.equal(estimateLines('', narrow, 'feed'), 0);
});

// ---- validateConcept -------------------------------------------------------

const MINI = {
  id: 'mini',
  supportedFormats: ['feed'],
  elements: [
    { id: 'bg', type: 'background', layer: 0, box: { x: 0, y: 0, w: 100, h: 100 } },
    { id: 'img', type: 'image', slot: 'original', layer: 1, box: { x: 10, y: 10, w: 40, h: 40 }, constraints: { required: true } },
    { id: 'h', type: 'text', field: 'headline', layer: 2, box: { x: 10, y: 60, w: 80, h: 12 }, style: { fontSize: 44 }, constraints: { required: true, maxChars: 20 } },
    { id: 'logo', type: 'logo', layer: 3, box: { x: 40, y: 2, w: 20, h: 8 }, constraints: { minW: 20 } },
  ],
};

test('validateConcept is pripraveno when copy + assets are present and within limits', () => {
  const { status, findings } = validateConcept({ template: MINI, format: 'feed', copy: { headline: 'Krátký' }, assets: { original: 'data:img' } });
  assert.equal(status, 'pripraveno');
  assert.deepEqual(findings, []);
});

test('validateConcept flags a missing required asset and missing required copy as errors', () => {
  const { status, findings } = validateConcept({ template: MINI, format: 'feed', copy: {}, assets: {} });
  assert.equal(status, 'nedokonceno');
  assert.ok(findings.some((f) => f.code === 'missing-asset' && f.severity === 'error'));
  assert.ok(findings.some((f) => f.code === 'missing-copy' && f.severity === 'error'));
});

test('validateConcept warns (not errors) on text overflow and keeps status varovani', () => {
  const { status, findings } = validateConcept({ template: MINI, format: 'feed', copy: { headline: 'Tohle je mnohem delší nadpis než limit' }, assets: { original: 'x' } });
  assert.equal(status, 'varovani');
  assert.ok(findings.some((f) => f.code === 'overflow-chars' && f.severity === 'warn'));
  assert.ok(!findings.some((f) => f.severity === 'error'));
});

test('validateConcept warns when the logo box is below its minimum width', () => {
  const tpl = { ...MINI, elements: MINI.elements.map((e) => (e.id === 'logo' ? { ...e, box: { x: 40, y: 2, w: 5, h: 8 } } : e)) };
  const { findings } = validateConcept({ template: tpl, format: 'feed', copy: { headline: 'ok' }, assets: { original: 'x' } });
  assert.ok(findings.some((f) => f.code === 'logo-small'));
});

// ---- slugify / filename ----------------------------------------------------

test('slugify folds Czech diacritics and creativeFilename builds the export name', () => {
  assert.equal(slugify('Vánoce'), 'vanoce');
  assert.equal(slugify('Emotivní dárek'), 'emotivni-darek');
  assert.equal(slugify('  '), 'x');
  assert.equal(creativeFilename({ occasion: 'Vánoce', angle: 'Emotivní dárek', format: 'feed', index: 1 }), 'fotomalovanky_vanoce_emotivni-darek_feed_01.png');
  assert.equal(creativeFilename({ occasion: 'Vánoce', angle: 'Produkt', format: 'story', index: 12, ext: 'jpg' }), 'fotomalovanky_vanoce_produkt_story_12.jpg');
});

// ---- template families -----------------------------------------------------

test('there are 5 template families, each with id/family/name and >= 3 formats', () => {
  const list = listTemplates();
  assert.equal(list.length, 5);
  for (const t of list) {
    assert.ok(t.id && t.family && t.name);
    assert.ok(t.supportedFormats.length >= 3, `${t.id} supports feed/story/landscape`);
    assert.ok(Array.isArray(t.slots) && Array.isArray(t.fields));
  }
  assert.ok(getTemplate('promena'));
  assert.equal(getTemplate('nope'), null);
});

test('templateSlots and templateFields report what each template uses', () => {
  const promena = getTemplate('promena');
  assert.deepEqual(templateSlots(promena), ['original', 'coloring']);
  assert.ok(templateFields(promena).includes('headline'));
  assert.ok(templateFields(promena).includes('headlineHi'));
});

test('every template has seed copy for its bound text fields', () => {
  for (const t of Object.values(TEMPLATES)) {
    const seed = SEED_COPY[t.id];
    assert.ok(seed, `${t.id} has seed copy`);
  }
});

// ---- renderStudioHtml ------------------------------------------------------

test('renderStudioHtml renders every template in every supported format without throwing', () => {
  for (const t of Object.values(TEMPLATES)) {
    for (const fmt of t.supportedFormats) {
      const html = renderStudioHtml({ template: t, format: fmt, copy: SEED_COPY[t.id], assets: {} });
      assert.ok(html.startsWith('<!doctype html>'), `${t.id}/${fmt} is a document`);
      const F = STUDIO_FORMATS[fmt];
      assert.ok(html.includes(`width:${F.w}px`), `${t.id}/${fmt} is sized to the format`);
      assert.ok(!/\$\{/.test(html), `${t.id}/${fmt} has no unresolved template literals`);
    }
  }
});

test('renderStudioHtml places asset images and escapes copy text', () => {
  const html = renderStudioHtml({
    template: getTemplate('promena'),
    format: 'feed',
    copy: { headline: 'A & B <script>', headlineHi: 'x' },
    assets: { original: 'https://x/a.png', coloring: 'https://x/b.png' },
  });
  assert.ok(html.includes('src="https://x/a.png"'));
  assert.ok(html.includes('src="https://x/b.png"'));
  assert.ok(html.includes('A &amp; B &lt;script&gt;'), 'copy is HTML-escaped');
  assert.ok(!html.includes('<script>'), 'no raw script tag from copy');
});

test('an empty image slot renders a labelled placeholder, not a broken image', () => {
  const html = renderStudioHtml({ template: getTemplate('promena'), format: 'feed', copy: SEED_COPY.promena, assets: {} });
  assert.ok(html.includes('původní fotka'));
  assert.ok(html.includes('omalovánka'));
  assert.ok(!html.includes('<img'), 'no img tags when no assets and no real logo');
});

test('a text element with no CTA copy renders nothing for it (no empty pill)', () => {
  const html = renderStudioHtml({ template: getTemplate('emotivni-darek'), format: 'feed', copy: { headline: 'H', support: 'S' }, assets: {} });
  // cta field is empty -> the cta branch returns '' so no accent button leaks in
  assert.ok(!/border-radius:999px/.test(html), 'empty CTA is not rendered');
});
