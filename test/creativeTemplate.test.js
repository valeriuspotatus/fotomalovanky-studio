import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMATS, PALETTES, CAMPAIGNS, renderCreativeHtml, creativeFromCampaign } from '../src/creatives/creativeTemplate.js';

// The template is pure HTML/CSS generation, so every fact about the ad is provable by inspecting
// the returned string — no browser needed. renderCreative.js owns the one Playwright seam and is
// exercised by tools/creativeSample.mjs, not here.

// ---- catalogue exports ------------------------------------------------------

test('FORMATS carries the three ad canvases with pixel dimensions', () => {
  assert.deepEqual(Object.keys(FORMATS).sort(), ['square', 'story', 'wide']);
  assert.deepEqual({ w: FORMATS.square.w, h: FORMATS.square.h }, { w: 1080, h: 1080 });
  assert.deepEqual({ w: FORMATS.story.w, h: FORMATS.story.h }, { w: 1080, h: 1920 });
  assert.deepEqual({ w: FORMATS.wide.w, h: FORMATS.wide.h }, { w: 1200, h: 630 });
});

test('every palette defines a background wash and an accent colour', () => {
  for (const [key, pal] of Object.entries(PALETTES)) {
    assert.ok(pal.bg, `${key} has a background`);
    assert.match(pal.accent, /^#[0-9A-Fa-f]{6}$/, `${key} accent is a hex colour`);
  }
});

test('every campaign names a headline, a highlight word, and a known palette', () => {
  for (const [key, c] of Object.entries(CAMPAIGNS)) {
    assert.ok(c.headline && c.highlight, `${key} has copy`);
    assert.ok(PALETTES[c.palette], `${key} references a real palette`);
  }
});

// ---- renderCreativeHtml ------------------------------------------------------

test('renders a self-contained HTML document sized to the format', () => {
  const html = renderCreativeHtml({ format: 'square', headline: 'Vzpomínka', highlight: 'vybarvit' });
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes('width:1080px'), 'square is 1080 wide');
  assert.ok(html.includes('height:1080px'), 'square is 1080 tall');
  // No external references — the CSP-equivalent constraint for these assets.
  assert.ok(!/https?:\/\//.test(html), 'no external URLs are pulled in');
});

test('story is the tall canvas with the vertically stacked reveal', () => {
  const html = renderCreativeHtml({ format: 'story', headline: 'a', highlight: 'b' });
  assert.ok(html.includes('height:1920px'), 'story is 1920 tall');
  assert.ok(html.includes('reveal stack'), 'story stacks the before/after pair');
});

test('the headline and its highlighted word both render', () => {
  const html = renderCreativeHtml({ headline: 'Dárek, který se dá', highlight: 'vybarvit' });
  assert.ok(html.includes('Dárek, který se dá'), 'headline text is present');
  assert.match(html, /class="hi">vybarvit</, 'highlight word gets the marker span');
});

test('the palette accent tints the highlight', () => {
  const html = renderCreativeHtml({ palette: 'sunset', headline: 'a', highlight: 'b' });
  assert.ok(html.includes(PALETTES.sunset.accent), 'the sunset accent colour appears in the CSS');
});

test('user copy is HTML-escaped, so it cannot inject markup', () => {
  const html = renderCreativeHtml({ headline: '<script>alert(1)</script>', highlight: 'x & y' });
  assert.ok(!html.includes('<script>alert(1)'), 'raw script tag never reaches the document');
  assert.ok(html.includes('&lt;script&gt;'), 'angle brackets are escaped');
  assert.ok(html.includes('x &amp; y'), 'ampersands are escaped');
});

test('the real logo image is used when a logoSrc is supplied, with a drawn fallback otherwise', () => {
  const withLogo = renderCreativeHtml({ headline: 'a', highlight: 'b', logoSrc: 'data:image/png;base64,ZZ' });
  assert.ok(withLogo.includes('class="logo-img"'), 'logo image element present');
  assert.ok(withLogo.includes('src="data:image/png;base64,ZZ"'), 'the supplied logo is embedded');
  const noLogo = renderCreativeHtml({ headline: 'a', highlight: 'b' });
  assert.ok(!noLogo.includes('class="logo-img"'), 'no logo image element without a source');
  assert.ok(noLogo.includes('class="word"'), 'falls back to the drawn wordmark');
});

test('a badge renders only when supplied', () => {
  const withBadge = renderCreativeHtml({ headline: 'a', highlight: 'b', badge: 'Vánoční dárek' });
  assert.ok(withBadge.includes('class="badge"'), 'badge element present');
  assert.ok(withBadge.includes('Vánoční dárek'), 'badge text present');
  const noBadge = renderCreativeHtml({ headline: 'a', highlight: 'b', badge: null });
  assert.ok(!noBadge.includes('class="badge"'), 'no badge element when none is given');
});

test('photos embed when given, and fall back to labelled placeholders when not', () => {
  const withPhotos = renderCreativeHtml({
    headline: 'a', highlight: 'b',
    beforeSrc: 'data:image/jpeg;base64,BEFORE', afterSrc: 'file:///after.png',
  });
  assert.ok(withPhotos.includes('src="data:image/jpeg;base64,BEFORE"'), 'before photo embedded');
  assert.ok(withPhotos.includes('src="file:///after.png"'), 'after art embedded');
  assert.ok(!withPhotos.includes('class="ph ph-before"'), 'no placeholder div when a real photo exists');

  const noPhotos = renderCreativeHtml({ headline: 'a', highlight: 'b' });
  assert.ok(noPhotos.includes('class="ph ph-before"') && noPhotos.includes('class="ph ph-after"'), 'both placeholders shown');
  assert.ok(!noPhotos.includes('<img'), 'no image tags without sources');
});

test('an unknown format or palette falls back to the safe defaults', () => {
  const html = renderCreativeHtml({ format: 'billboard', palette: 'neon', headline: 'a', highlight: 'b' });
  assert.ok(html.includes('width:1080px'), 'unknown format falls back to square');
  assert.ok(html.includes(PALETTES.rainbow.accent), 'unknown palette falls back to rainbow');
});

// ---- creativeFromCampaign ----------------------------------------------------

test('creativeFromCampaign expands a preset into template fields', () => {
  const fields = creativeFromCampaign('vanoce');
  assert.equal(fields.headline, CAMPAIGNS.vanoce.headline);
  assert.equal(fields.badge, CAMPAIGNS.vanoce.badge);
  assert.equal(fields.palette, CAMPAIGNS.vanoce.palette);
  assert.equal(fields.format, 'square', 'defaults to the square feed format');
});

test('creativeFromCampaign lets overrides win (photos, format)', () => {
  const fields = creativeFromCampaign('dendeti', { format: 'story', beforeSrc: 'data:1', afterSrc: 'data:2' });
  assert.equal(fields.format, 'story');
  assert.equal(fields.beforeSrc, 'data:1');
  assert.equal(fields.highlight, CAMPAIGNS.dendeti.highlight, 'un-overridden fields keep the preset');
});

test('an unknown campaign key falls back to the generic preset', () => {
  assert.deepEqual(creativeFromCampaign('nonexistent'), creativeFromCampaign('obecny'));
});
