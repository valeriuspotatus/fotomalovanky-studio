import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, validateTheme, createMeter, buildSheetHtml, resolveCaps, canReroll, shouldReroll, isPortraitEnough, CAPS } from '../tools/printables.js';
import zvirata from '../tools/printables/zvirata.js';

// The browser half (assemblePdf) is proved by running the tool, the way the other Playwright work in
// this repo is — tools/*.mjs smoke scripts, never a test that launches Chromium. What is unit-tested
// here is everything that decides how much money the run spends, and the sheet it prints.

test('parseArgs reads the theme, the dry-run flag, an output override and cap overrides', () => {
  assert.deepEqual(parseArgs(['--theme', 'zvirata', '--dry-run']), { theme: 'zvirata', dryRun: true, out: null, maxJobs: null, maxImages: null, limit: null });
  assert.deepEqual(parseArgs(['--theme', 'x', '--out', 'D:\\tmp']), { theme: 'x', dryRun: false, out: 'D:\\tmp', maxJobs: null, maxImages: null, limit: null });
  assert.deepEqual(parseArgs(['--max-jobs', '10', '--max-images', '11']).maxJobs, 10);
  assert.equal(parseArgs(['--limit', '2']).limit, 2, 'the probe runs only the first N pages');
  assert.deepEqual(parseArgs([]), { theme: null, dryRun: false, out: null, maxJobs: null, maxImages: null, limit: null });
});

test('a cap override can only ever lower the ceiling, never raise it', () => {
  assert.deepEqual({ ...resolveCaps({ maxJobs: 10, maxImages: 11 }) }, { generatorJobs: 10, geminiImages: 11 });
  assert.deepEqual({ ...resolveCaps({ maxJobs: 999, maxImages: 999 }) }, { generatorJobs: 12, geminiImages: 12 });
  assert.deepEqual({ ...resolveCaps({}) }, { generatorJobs: 12, geminiImages: 12 });
  assert.equal(resolveCaps({ maxJobs: 0 }).generatorJobs, 0, 'zero is a real budget, not a missing one');
});

test('a reroll may never eat a first pass owed to a page behind it', () => {
  // 12 jobs, page 1 of 8: 1 spent, 11 left, 7 pages still owed a first pass -> reroll is affordable.
  assert.equal(canReroll(11, 7), true);
  // The pathological case this guards: budget exactly equals the pages still to draw.
  assert.equal(canReroll(7, 7), false);
  assert.equal(canReroll(1, 0), true, 'the last page may use whatever is left');
  assert.equal(canReroll(0, 0), false, 'but not what is not there');
});

test('the zvirata theme is complete and matches the article draft', () => {
  assert.deepEqual(validateTheme(zvirata), []);
  assert.equal(zvirata.pages.length, 8);
  assert.deepEqual(
    zvirata.pages.map((p) => p.subject),
    ['pes', 'kočka s koťaty', 'kůň s hříbětem', 'liška', 'sova', 'ježek', 'motýl', 'rybičky'],
  );
  for (const p of zvirata.pages) {
    const prompt = p.prompt.toLowerCase();
    assert.ok(prompt.includes('photorealistic'), `${p.subject}: photorealistic source`);
    assert.ok(prompt.includes('no people'), `${p.subject}: no people`);
    assert.ok(/no text, no logos/.test(prompt), `${p.subject}: no text or logos`);
  }
});

test('validateTheme names every reason a theme cannot be run, before anything is spent', () => {
  assert.deepEqual(validateTheme(null), ['theme is not an object']);
  const problems = validateTheme({ name: '', pages: [{ subject: '', prompt: 'short' }] });
  assert.ok(problems.some((p) => p.includes('name')));
  assert.ok(problems.some((p) => p.includes('page 1: subject')));
  assert.ok(problems.some((p) => p.includes('page 1: prompt')));
  const tooMany = validateTheme({ name: 'x', pages: Array(CAPS.geminiImages + 1).fill({ subject: 's', prompt: 'a'.repeat(30) }) });
  assert.ok(tooMany.some((p) => p.includes('cap')), 'a theme bigger than the cap is refused up front');
});

test('the meter is a hard stop, not a suggestion', () => {
  const meter = createMeter({ generatorJobs: 2, geminiImages: 1 });
  meter.spend('geminiImages', 'page 1');
  assert.equal(meter.left('geminiImages'), 0);
  assert.throws(() => meter.spend('geminiImages', 'page 2'), /Cap reached: 1\/1 geminiImages/);
  meter.spend('generatorJobs', 'page 1');
  meter.spend('generatorJobs', 'reroll');
  assert.throws(() => meter.spend('generatorJobs', 'page 2'), /Cap reached: 2\/2 generatorJobs/);
  assert.deepEqual(meter.used, { generatorJobs: 2, geminiImages: 1 });
});

test('the default caps leave room for the 8 pages plus 4 rerolls', () => {
  assert.equal(CAPS.geminiImages, 12);
  assert.equal(CAPS.generatorJobs, zvirata.pages.length + 4);
});

test('a landscape source is rejected before it can cost a generator job', () => {
  assert.equal(isPortraitEnough(1408, 768), false, '16:9 — what run 1 kept getting');
  assert.equal(isPortraitEnough(1024, 1024), false, 'a square still wastes a third of A4');
  assert.equal(isPortraitEnough(768, 1024), true, '3:4 is what we ask for');
  assert.equal(isPortraitEnough(900, 1600), true, 'taller than 3:4 is fine too');
  assert.equal(isPortraitEnough(0, 100), false);
  assert.equal(isPortraitEnough(undefined, undefined), false, 'unreadable metadata is not a pass');
});

test('solid fill is never re-rolled, because more steps measurably made it worse', () => {
  assert.equal(shouldReroll('flagged', 'solid-fill'), false);
  assert.equal(shouldReroll('flagged', 'near-solid'), true);
  assert.equal(shouldReroll('flagged', 'near-blank'), true);
  assert.equal(shouldReroll('flagged', 'unreadable-image'), true);
  assert.equal(shouldReroll('ok', 'ok'), false, 'a good page is never re-rolled');
});

test('every zvirata page is a fully named composition — nothing unnamed may appear', () => {
  assert.equal(zvirata.aspectRatio, '3:4');
  for (const p of zvirata.pages) {
    const { subject, elements, ground } = p.composition;
    assert.ok(subject && subject.length > 10, `${p.subject}: has a described subject`);
    assert.ok(elements.length >= 2 && elements.length <= 4, `${p.subject}: 2-4 supporting elements, got ${elements.length}`);
    assert.ok(ground.includes('line'), `${p.subject}: a simple ground line`);
    const prompt = p.prompt.toLowerCase();
    for (const e of elements) assert.ok(p.prompt.includes(e), `${p.subject}: "${e}" is named in the prompt`);
    assert.ok(prompt.includes('nothing else'), `${p.subject}: the closed inventory is stated`);
    assert.ok(prompt.includes('not named above'), `${p.subject}: and stated again as a prohibition`);
    assert.ok(prompt.includes('only the top third of the picture is empty'), `${p.subject}: empty upper third, and only that`);
    assert.ok(prompt.includes('fill the lower two thirds'), `${p.subject}: subject is large, middle not empty`);
    assert.ok(prompt.includes('nothing is cropped'), `${p.subject}: nothing cropped at the edges`);
    assert.ok(prompt.includes('no cast shadows'), `${p.subject}: no shadow to trace as black`);
    assert.ok(prompt.includes('no large dark patches'), `${p.subject}: pale markings, the v1 solid-fill fix`);
    assert.ok(prompt.includes('no people'), `${p.subject}: no people`);
  }
});

test('the set includes parent-and-young pages, not only lone animals', () => {
  const subjects = zvirata.pages.map((p) => p.subject);
  assert.ok(subjects.includes('kočka s koťaty'));
  assert.ok(subjects.includes('kůň s hříbětem'));
  const groupy = zvirata.pages.filter((p) => /kittens|foal|three fish/.test(p.composition.subject));
  assert.ok(groupy.length >= 3, `at least three pages show more than one animal, got ${groupy.length}`);
  assert.ok(zvirata.setDescription.includes('kočka s koťaty'), 'the article set description tracks the pages');
});

test('the sheet is A4 portrait, one page per image, with the footer on each', () => {
  const html = buildSheetHtml(['file:///a.svg', 'file:///b.svg'], { logoDataUri: 'data:image/png;base64,AAA' });
  assert.equal((html.match(/class="page"/g) ?? []).length, 2);
  assert.equal((html.match(/fotomalovanky\.cz/g) ?? []).length, 2, 'a footer on every page');
  assert.ok(html.includes('size: A4 portrait'));
  assert.ok(html.includes('page-break-after: always'));
  assert.ok(html.includes('src="file:///a.svg"') && html.includes('src="file:///b.svg"'));
  assert.equal((html.match(/data:image\/png;base64,AAA/g) ?? []).length, 2, 'the logo rides along on every page');
});

test('the sheet drops the logo rather than the run when the asset is missing', () => {
  const html = buildSheetHtml(['file:///a.svg'], { logoDataUri: null });
  assert.ok(!html.includes('class="mark"'));
  assert.ok(html.includes('fotomalovanky.cz'), 'the wordmark still prints');
});
