import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateOccasionAds, buildAssets, pickTemplates, readIndex } from '../src/creatives/adCalendar.js';
import { generateAdCopy, clampChars, parseJsonLoose, dedupeHighlight, buildCopyPrompt } from '../src/creatives/adCopy.js';
import { bannedHits } from '../src/brandVoice.js';
import { TEMPLATES, SEED_COPY } from '../src/creatives/studio/templates.js';
import { occasionKey } from '../src/creatives/calendar.js';

const OCCASION = { m: 2, d: 14, name: 'Sv. Valentýn', persona: 'Páry', angle: 'Rande s pastelkami.', tone: 'brand' };

// ---- adCopy (pure) ---------------------------------------------------------

test('clampChars drops a trailing partial word and never exceeds max', () => {
  assert.equal(clampChars('Krátký text', 40), 'Krátký text');
  const out = clampChars('Tohle je opravdu hodně dlouhý titulek co přeteče', 20);
  assert.ok(out.length <= 20, `got ${out.length}`);
  assert.ok(!out.endsWith(' '));
});

test('parseJsonLoose extracts a JSON object from fenced / noisy output', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"headline":"Ahoj"}\n```'), { headline: 'Ahoj' });
  assert.equal(parseJsonLoose('no json here'), null);
});

test('dedupeHighlight strips a highlight repeated inside the headline', () => {
  assert.equal(dedupeHighlight({ headline: 'Zvěčni svou legendární fotku z festivalu', headlineHi: 'legendární fotku' }).headline, 'Zvěčni svou z festivalu');
  // proper complementary parts are left alone
  assert.equal(dedupeHighlight({ headline: 'Vzpomínka, která se dá', headlineHi: 'vybarvit' }).headline, 'Vzpomínka, která se dá');
  // trailing repeat + dangling comma cleaned
  assert.equal(dedupeHighlight({ headline: 'Dárek, který potěší', headlineHi: 'potěší' }).headline, 'Dárek, který');
});

test('generateAdCopy clamps AI fields and falls back to seed copy on bad output', async () => {
  const template = TEMPLATES.promena; // headline(<=44), headlineHi, badge(<=26)
  const good = await generateAdCopy({
    occasion: OCCASION,
    template,
    generateTextFn: async () => JSON.stringify({ headline: 'X'.repeat(80), headlineHi: 'vybarvit', badge: 'Dárek' }),
  });
  assert.equal(good.source, 'ai');
  assert.ok(good.copy.headline.length <= 44);
  assert.equal(good.copy.headlineHi, 'vybarvit');

  const bad = await generateAdCopy({ occasion: OCCASION, template, generateTextFn: async () => 'garbage, no json' });
  assert.equal(bad.source, 'seed');
  assert.equal(bad.copy.headline, SEED_COPY.promena.headline); // falls back to the seed headline
});

test('generateAdCopy swaps an off-brand field for its seed and reports it', async () => {
  const template = TEMPLATES['emotivni-darek']; // headline, headlineHi, support, cta
  const seed = SEED_COPY['emotivni-darek'];
  const res = await generateAdCopy({
    occasion: OCCASION,
    template,
    // The brand guide's two cardinal sins: naming the machinery, and inventing a discount.
    generateTextFn: async () =>
      JSON.stringify({ headline: 'Omalovánka od AI', headlineHi: 'vzpomínky', support: 'Sleva 20 % na vše', cta: 'Objednat' }),
  });
  assert.equal(res.copy.headline, seed.headline, 'AI headline replaced by the seed');
  assert.equal(res.copy.support, seed.support, 'invented discount replaced by the seed');
  assert.equal(res.copy.headlineHi, 'vzpomínky', 'a clean field is kept');
  assert.equal(res.copy.cta, 'Objednat', 'a clean field is kept');
  assert.deepEqual(res.blocked, ['headline: ai', 'support: sleva']);
});

test('the ad prompt and the seed copy are themselves on-brand', () => {
  // A seed that broke the rules would be un-fixable: it IS the fallback.
  for (const [id, seed] of Object.entries(SEED_COPY)) {
    const hits = bannedHits(Object.values(seed).join(' '));
    assert.deepEqual(hits, [], `seed copy for ${id} must be clean, got: ${hits.join(', ')}`);
  }
  assert.match(buildCopyPrompt({ occasion: OCCASION, template: TEMPLATES.promena }), /NIKDY nezmiňuj umělou inteligenci/);
});

test('emotivni-darek headline+highlight is capped to the 2-line budget (no support overlap)', async () => {
  const template = TEMPLATES['emotivni-darek'];
  const res = await generateAdCopy({
    occasion: OCCASION,
    template,
    generateTextFn: async () => JSON.stringify({ headline: 'Zapomeňte na lapače prachu. Darujte', headlineHi: 'společné vzpomínky', support: 'x', cta: 'y' }),
  });
  const combined = `${res.copy.headline} ${res.copy.headlineHi}`.length;
  assert.ok(combined <= 34, `combined headline within budget (got ${combined})`);
  assert.ok(res.copy.headlineHi === 'společné vzpomínky', 'highlight kept intact');
});

// ---- buildAssets (stubbed image + line-art) --------------------------------

test('buildAssets makes one scene image, reuses it, and line-arts only the coloring slot', async () => {
  let sceneCalls = 0;
  let lineArtCalls = 0;
  const imageFn = async () => ({ base64: `scene${++sceneCalls}`, mimeType: 'image/png' });
  const lineArtFn = async () => {
    lineArtCalls++;
    return { base64: 'lineart', mimeType: 'image/png' };
  };
  const assets = await buildAssets({ occasion: OCCASION, template: TEMPLATES.promena, imageFn, lineArtFn });
  assert.equal(sceneCalls, 1, 'one scene image generated');
  assert.equal(lineArtCalls, 1, 'coloring slot line-arted');
  assert.equal(assets.original, 'data:image/png;base64,scene1');
  assert.ok(assets.coloring.includes('lineart'));
});

// ---- generateOccasionAds (stubbed render, real store) ----------------------

test('generateOccasionAds renders every concept×format and persists the index', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fma-cal-'));
  try {
    const rendered = [];
    const deps = {
      copyFn: async ({ template }) => ({ copy: { headline: 'H', headlineHi: 'hi', cta: 'C', badge: 'B', support: 'S' }, source: 'ai' }),
      imageFn: async () => ({ base64: 'img', mimeType: 'image/png' }),
      lineArtFn: async () => ({ base64: 'la', mimeType: 'image/png' }),
      renderFn: async ({ html, width, height, outPath }) => {
        assert.ok(html.includes('<'), 'html produced');
        assert.ok(width > 0 && height > 0);
        writeFileSync(outPath, 'PNG');
        rendered.push(outPath);
        return outPath;
      },
      brand: {},
    };
    const entry = await generateOccasionAds({ occasion: OCCASION, dataDir: dir, deps });
    // promena + emotivni-darek (tone brand), each × 2 formats = 4 ads
    assert.equal(entry.ads.length, 4, `got ${entry.ads.length}`);
    assert.equal(entry.key, occasionKey(OCCASION));
    for (const p of rendered) assert.ok(existsSync(p), 'png written');

    const index = readIndex(dir);
    assert.ok(index.generatedAt, 'index stamped');
    assert.equal(index.occasions[entry.key].ads.length, 4);
    assert.deepEqual(pickTemplates(OCCASION), ['promena', 'emotivni-darek']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
