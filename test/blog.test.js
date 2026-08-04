import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { suggestTopics, upcomingOccasions, daysUntil, rankKeywordEntries } from '../src/blog/topics.js';
import { KEYWORD_MAP, ARTICLE_TYPES } from '../src/blog/keywordMap.js';
import { generatePost, buildBodyHtml, buildDraftPrompt, qcPost, SEO_TITLE_MAX, META_MAX, FORM_PLACEHOLDER } from '../src/blog/draft.js';
import { PRODUCT_FACTS, OPEN_FACTS } from '../src/blog/productFacts.js';
import { savePost, readPost, listPosts, deletePost, isValidId, siblingsInCluster } from '../src/blog/store.js';
import { buildArticleInput, createContentClient, ShopifyContentError } from '../src/shopify/content.js';
import { validateConfig, ConfigError } from '../src/config.js';

const NOW = new Date(2026, 4, 1); // 1 May 2026, fixed for deterministic windows

// ---- topics ----------------------------------------------------------------

test('daysUntil wraps past occasions to next year', () => {
  assert.equal(daysUntil({ m: 5, d: 1 }, NOW), 0);
  assert.equal(daysUntil({ m: 5, d: 10 }, NOW), 9);
  assert.equal(daysUntil({ m: 1, d: 1 }, NOW), 245); // already past this year -> next Jan
});

test('upcomingOccasions selects the calendar window soonest-first', () => {
  const up = upcomingOccasions(NOW, 8); // 56 days: 1.máj .. ~26.6
  assert.ok(up.length >= 4);
  assert.equal(up[0].occasion.name, '1. máj (lásky čas)');
  assert.ok(up.every((u) => u.days >= 0 && u.days <= 56));
  for (let i = 1; i < up.length; i++) assert.ok(up[i].days >= up[i - 1].days, 'sorted by proximity');
});

// ---- keyword map -----------------------------------------------------------

const FAKE_MAP = [
  { keyword: 'evergreen prvni', cluster: 'c', articleType: 'gift', priority: 1, season: null, notes: 'n' },
  { keyword: 'evergreen treti', cluster: 'c', articleType: 'gift', priority: 3, season: null, notes: 'n' },
  { keyword: 'blizka sezona', cluster: 'c', articleType: 'printable', priority: 3, season: { m: 5, d: 20 }, notes: 'n' },
  { keyword: 'vzdalena sezona', cluster: 'c', articleType: 'printable', priority: 1, season: { m: 11, d: 15 }, notes: 'n' },
];

test('the seed keyword map is well-formed and priced at the neutral priority', () => {
  assert.ok(KEYWORD_MAP.length >= 11);
  for (const e of KEYWORD_MAP) {
    assert.ok(e.keyword.trim() && e.cluster.trim() && e.notes.trim(), `${e.keyword} is fully filled in`);
    assert.ok(ARTICLE_TYPES.includes(e.articleType), `${e.keyword} has a known articleType`);
    assert.equal(e.priority, 2, 'seed priorities stay neutral until Search Console says otherwise');
    if (e.season) assert.ok(e.season.m >= 1 && e.season.m <= 12 && e.season.d >= 1 && e.season.d <= 31);
  }
  const dupes = KEYWORD_MAP.length - new Set(KEYWORD_MAP.map((e) => e.keyword.toLowerCase())).size;
  assert.equal(dupes, 0, 'no duplicate keywords');
});

test('rankKeywordEntries: a near season outranks priority, a far season does not', () => {
  const ranked = rankKeywordEntries(FAKE_MAP, NOW, 56); // NOW = 1 May 2026
  assert.deepEqual(
    ranked.map((t) => t.keyword),
    ['blizka sezona', 'evergreen prvni', 'vzdalena sezona', 'evergreen treti'],
  );
  assert.equal(ranked[0].days, 19, 'a near-season topic carries its countdown');
  assert.equal(ranked[1].days, null, 'an evergreen topic has no countdown');
});

test('rankKeywordEntries sorts several near seasons soonest-first', () => {
  const map = [
    { keyword: 'pozdeji', cluster: 'c', articleType: 'printable', priority: 1, season: { m: 6, d: 20 }, notes: '' },
    { keyword: 'driv', cluster: 'c', articleType: 'printable', priority: 3, season: { m: 5, d: 3 }, notes: '' },
  ];
  assert.deepEqual(rankKeywordEntries(map, NOW, 56).map((t) => t.keyword), ['driv', 'pozdeji']);
});

test('map topics carry the cluster + articleType the draft step needs', async () => {
  const { topics } = await suggestTopics({ now: NOW });
  const first = topics.find((t) => t.source === 'map');
  assert.ok(first.cluster, 'cluster travels to the draft step');
  assert.ok(ARTICLE_TYPES.includes(first.articleType));
  assert.ok(first.intent, 'notes become the intent line');
});

// ---- topic ranking ---------------------------------------------------------

test('suggestTopics ranks the curated map first, calendar second', async () => {
  const { topics, aiUsed } = await suggestTopics({ now: NOW });
  assert.equal(aiUsed, false);
  const firstCalendar = topics.findIndex((t) => t.source === 'calendar');
  const lastMap = topics.map((t) => t.source).lastIndexOf('map');
  assert.ok(lastMap >= 0 && firstCalendar > lastMap, 'every map topic outranks every calendar topic');
  assert.equal(topics.filter((t) => t.source === 'map').length, KEYWORD_MAP.length);
  assert.ok(topics[firstCalendar].occasionKey, 'calendar topics still carry the occasion key');
});

test('the AI keyword step is OFF unless asked for, even when a model is available', async () => {
  let called = false;
  const fakeAi = async () => {
    called = true;
    return JSON.stringify({ topics: [{ title: 'X', keyword: 'x', intent: 'y' }] });
  };
  const { topics, aiUsed } = await suggestTopics({ now: NOW, generateTextFn: fakeAi });
  assert.equal(called, false, 'no model call without useSeo');
  assert.equal(aiUsed, false);
  assert.ok(!topics.some((t) => t.source === 'seo'));
});

test('useSeo merges AI topics last and dedupes against map + calendar keywords', async () => {
  const fakeAi = async () =>
    JSON.stringify({
      topics: [
        { title: 'Omalovánky pro seniory', keyword: 'omalovánky pro seniory', intent: 'aktivizace' },
        { title: 'Dup kalendář', keyword: '1. máj (lásky čas)', intent: 'x' }, // duplicates a calendar keyword
        { title: 'Dup mapa', keyword: 'omalovánky dinosauři', intent: 'x' }, // duplicates a map keyword
      ],
    });
  const { topics, aiUsed } = await suggestTopics({ now: NOW, generateTextFn: fakeAi, useSeo: true });
  assert.equal(aiUsed, true);
  const seo = topics.filter((t) => t.source === 'seo');
  assert.equal(seo.length, 1, 'both duplicate-keyword SEO topics are dropped');
  assert.equal(seo[0].keyword, 'omalovánky pro seniory');
  assert.equal(topics[topics.length - 1].source, 'seo', 'invented keywords rank last');
});

test('suggestTopics never throws on a broken AI response', async () => {
  const { topics, aiUsed } = await suggestTopics({ now: NOW, generateTextFn: async () => 'not json at all', useSeo: true });
  assert.equal(aiUsed, false);
  assert.ok(topics.length >= 4); // map + calendar still there
});

test('an empty keyword map still yields a full calendar list (never empty)', async () => {
  const { topics } = await suggestTopics({ now: NOW, map: [] });
  assert.ok(topics.length >= 4);
  assert.ok(topics.every((t) => t.source === 'calendar'));
});

// ---- draft -----------------------------------------------------------------

const GOOD_TOPIC = { title: 'Dárek ke Dni matek', keyword: 'dárek ke dni matek', intent: 'lidé hledají osobní dárek', source: 'calendar', occasionKey: '05-10-den-matek' };

function goodModelJson() {
  return JSON.stringify({
    seoTitle: 'Dárek ke Dni matek: omalovánka z vaší fotky',
    metaDescription: 'Hledáte dárek ke Dni matek? Proměňte oblíbenou fotku v omalovánku, kterou máma vybarví a zarámuje.',
    handle: 'darek-ke-dni-matek',
    tags: ['den matek', 'dárek', 'omalovánky'],
    intro: 'Dárek ke Dni matek nemusí být květina. Osobní omalovánka z vaší fotky potěší a zůstane.',
    sections: [
      { h2: 'Proč omalovánka', paragraphs: ['Je osobní a trvalá.'], bullets: ['Osobní', 'Trvalé', 'Kreativní'] },
      { h2: 'Jak na to', paragraphs: ['Vyberte fotku a objednejte.'] },
    ],
    faq: [{ q: 'Jak dlouho to trvá?', a: 'Pár dní.' }],
    internalLinkHint: 'Odkaz na kolekci Pro maminky',
    heroPrompt: 'Máma a dítě u stolu, bez tváří',
    heroAlt: 'Dárek ke Dni matek — omalovánka',
  });
}

test('generatePost parses the model JSON, clamps fields, assembles body HTML', async () => {
  const post = await generatePost({ topic: GOOD_TOPIC, generateTextFn: async () => goodModelJson(), wordCountMin: 10 });
  assert.equal(post.copySource, 'ai');
  assert.equal(post.status, 'koncept');
  assert.ok(post.seoTitle.length <= SEO_TITLE_MAX);
  assert.ok(post.metaDescription.length <= META_MAX);
  assert.equal(post.handle, 'darek-ke-dni-matek');
  assert.equal(post.id, 'darek-ke-dni-matek');
  assert.ok(post.bodyHtml.includes('<h2>Proč omalovánka</h2>'));
  assert.ok(post.bodyHtml.includes('<ul><li>Osobní</li>'));
  assert.ok(post.bodyHtml.includes('Časté dotazy'));
  assert.ok(post.bodyHtml.includes('fotomalovanky.cz'), 'body ends with a shop CTA link');
  assert.deepEqual(post.qc.warnings, [], 'a well-formed post is QC-clean');
});

test('generatePost falls back to an editable skeleton on a bad model response', async () => {
  const post = await generatePost({ topic: GOOD_TOPIC, generateTextFn: async () => 'garbage' });
  assert.equal(post.copySource, 'seed');
  assert.ok(post.seoTitle);
  assert.ok(post.bodyHtml.length > 0, 'there is always something to edit');
  assert.equal(post.id, 'darek-ke-dni-matek');
});

test('generatePost escapes HTML in model text (no injection into bodyHtml)', async () => {
  const evil = JSON.stringify({ seoTitle: 'X', metaDescription: 'Y', handle: 'x', intro: 'Ahoj <script>alert(1)</script>', sections: [], faq: [] });
  const post = await generatePost({ topic: { title: 'X', keyword: 'x' }, generateTextFn: async () => evil });
  assert.ok(!post.bodyHtml.includes('<script>'));
  assert.ok(post.bodyHtml.includes('&lt;script&gt;'));
});

test('qcPost flags the SEO contract violations', () => {
  const post = {
    topic: { keyword: 'den matek' },
    seoTitle: 'Úplně jiný titulek', // no keyword
    metaDescription: '',
    intro: 'Text bez klíčového slova.',
    plainText: 'krátký text',
    sections: [],
    faq: [],
    internalLinkHint: '',
  };
  const codes = qcPost(post, { wordCountMin: 800 }).warnings.map((w) => w.code);
  assert.ok(codes.includes('keyword-title'));
  assert.ok(codes.includes('keyword-intro'));
  assert.ok(codes.includes('meta-missing'));
  assert.ok(codes.includes('body-short'));
  assert.ok(codes.includes('no-internal-link'));
  assert.ok(codes.includes('no-faq'));
});

test('qcPost flags banned brand vocabulary', () => {
  const post = { topic: { keyword: 'x' }, seoTitle: 'x', metaDescription: 'm', intro: '', plainText: 'Náš algoritmus vygeneruje obrázek se slevou.', sections: [], faq: [{ q: 'a', a: 'b' }], internalLinkHint: 'y' };
  const codes = qcPost(post).warnings.map((w) => w.code);
  assert.ok(codes.includes('banned'));
});

test('buildBodyHtml is deterministic and omits empty blocks', () => {
  const html = buildBodyHtml({ intro: 'Úvod.', sections: [{ h2: 'A', paragraphs: ['p'], bullets: [] }], faq: [] });
  assert.ok(html.includes('<p>Úvod.</p>'));
  assert.ok(html.includes('<h2>A</h2>'));
  assert.ok(!html.includes('<ul>'), 'no empty list');
  assert.ok(!html.includes('Časté dotazy'), 'no empty FAQ block');
});

// ---- product facts + article types -----------------------------------------

const PRINTABLE_TOPIC = {
  title: 'Omalovánky zvířata k vytisknutí',
  keyword: 'omalovánky zvířata k vytisknutí',
  intent: 'Rodič chce omalovánky hned.',
  source: 'map',
  cluster: 'omalovanky-k-vytisknuti',
  articleType: 'printable',
  setDescription: '8 stran zvířat: pes, kočka, kůň',
};

test('every draft prompt carries the verified product facts and no TODOs', () => {
  const prompt = buildDraftPrompt({ topic: GOOD_TOPIC, wordCountMin: 800, wordCountMax: 1500 });
  assert.ok(prompt.includes(PRODUCT_FACTS), 'the whole facts block is injected');
  assert.ok(prompt.includes('399 Kč') && prompt.includes('1–3 dny'), 'real numbers reach the model');
  assert.ok(!prompt.includes('TODO'), 'unverified facts never reach the model');
  assert.ok(/nevymýšlej/i.test(prompt), 'and it is told not to go beyond them');
  assert.ok(OPEN_FACTS.every((f) => f.startsWith('TODO(David):')), 'open questions stay addressed to David');
});

test('the printable prompt asks for the set, the print how-to, the form and no selling above it', () => {
  const prompt = buildDraftPrompt({ topic: PRINTABLE_TOPIC, wordCountMin: 700, wordCountMax: 1100 });
  assert.ok(prompt.includes('8 stran zvířat: pes, kočka, kůň'), 'the set description is quoted');
  assert.ok(prompt.includes('A4') && prompt.includes('100 %'), 'how to print');
  assert.ok(prompt.includes(FORM_PLACEHOLDER));
  assert.ok(prompt.includes('NEPRODÁVÁ'), 'the no-selling-above-the-form rule');
  assert.ok(/JEDEN odstavec/.test(prompt), 'exactly one bridge paragraph to the book');
});

test('a gift topic keeps the general article structure, without printable rules', () => {
  const prompt = buildDraftPrompt({ topic: GOOD_TOPIC, wordCountMin: 800, wordCountMax: 1500 });
  assert.ok(prompt.includes('úvod, 3–5 sekcí s podnadpisy'));
  assert.ok(!prompt.includes(FORM_PLACEHOLDER));
  assert.ok(!prompt.includes('NEPRODÁVÁ'));
});

test('an extra placeholder (behind-the-scenes photos) reaches the prompt and the QC', async () => {
  const topic = { ...GOOD_TOPIC, articleType: 'trust', placeholder: '{{BTS_FOTKY}}' };
  assert.ok(buildDraftPrompt({ topic, wordCountMin: 800, wordCountMax: 1500 }).includes('{{BTS_FOTKY}}'));
  const post = await generatePost({ topic, generateTextFn: async () => goodModelJson(), wordCountMin: 10 });
  assert.ok(post.qc.warnings.some((w) => w.code === 'no-placeholder'), 'a dropped placeholder is caught');
});

test('a printable draft is QC-clean only when the form placeholder is there', async () => {
  const withForm = () =>
    JSON.stringify({
      seoTitle: 'Omalovánky zvířata k vytisknutí zdarma',
      metaDescription: 'Omalovánky zvířata k vytisknutí: osm stran ke stažení a tisku doma na A4.',
      handle: 'omalovanky-zvirata-k-vytisknuti',
      intro: 'Omalovánky zvířata k vytisknutí máte za chvíli na stole.',
      sections: [
        { h2: 'Co je v sadě', paragraphs: ['Osm stran zvířat.'] },
        { h2: 'Jak vytisknout', paragraphs: ['A4, sto procent velikosti.'] },
        { h2: 'Stáhnout', paragraphs: [FORM_PLACEHOLDER] },
        { h2: 'A když chcete něco navíc', paragraphs: ['Kniha z vlastních fotek je hezký další krok.'] },
      ],
      faq: [{ q: 'Na jaký papír?', a: 'Stačí běžný.' }],
      internalLinkHint: 'kolekce omalovánek',
    });
  const ok = await generatePost({ topic: PRINTABLE_TOPIC, generateTextFn: withForm, wordCountMin: 10 });
  assert.deepEqual(ok.qc.warnings, []);
  assert.ok(ok.bodyHtml.includes(FORM_PLACEHOLDER), 'the placeholder survives into the body HTML');

  const noForm = async () => JSON.stringify({ ...JSON.parse(withForm()), sections: [{ h2: 'Co je v sadě', paragraphs: ['Osm stran zvířat.'] }] });
  const bad = await generatePost({ topic: PRINTABLE_TOPIC, generateTextFn: noForm, wordCountMin: 10 });
  assert.ok(bad.qc.warnings.some((w) => w.code === 'no-form-placeholder'));
});

test('QC flags selling above the download form, and only above it', () => {
  const above = qcPost(
    {
      topic: { keyword: 'k', articleType: 'printable' },
      seoTitle: 'k',
      metaDescription: 'm',
      plainText: 'k',
      faq: [{ q: 'a', a: 'b' }],
      internalLinkHint: 'x',
      bodyHtml: `<p>Objednejte si knihu za 399 Kč.</p><p>${FORM_PLACEHOLDER}</p>`,
    },
    { wordCountMin: 1 },
  );
  assert.ok(above.warnings.some((w) => w.code === 'sell-before-form'));

  const below = qcPost(
    {
      topic: { keyword: 'k', articleType: 'printable' },
      seoTitle: 'k',
      metaDescription: 'm',
      plainText: 'k',
      faq: [{ q: 'a', a: 'b' }],
      internalLinkHint: 'x',
      bodyHtml: `<p>Vytiskněte na A4.</p><p>${FORM_PLACEHOLDER}</p><p>Objednejte si knihu za 399 Kč.</p>`,
    },
    { wordCountMin: 1 },
  );
  assert.ok(!below.warnings.some((w) => w.code === 'sell-before-form'), 'selling after the form is the point');
});

test('the model may only link to the siblings it was handed', async () => {
  const siblings = [{ title: 'Starší článek', url: '/blogs/ze-zakulisi/starsi-clanek' }];
  const prompt = buildDraftPrompt({ topic: GOOD_TOPIC, wordCountMin: 800, wordCountMax: 1500, siblings });
  assert.ok(prompt.includes('/blogs/ze-zakulisi/starsi-clanek'));
  assert.ok(!prompt.includes('"internalLinkHint"'), 'the hint field is dropped when real links exist');

  const linked = async () =>
    JSON.stringify({
      seoTitle: 'Dárek ke Dni matek: omalovánka z vaší fotky',
      metaDescription: 'm',
      handle: 'x',
      intro: 'Dárek ke dni matek. Psali jsme o tom ve [starším článku](/blogs/ze-zakulisi/starsi-clanek).',
      sections: [{ h2: 'A', paragraphs: ['Viz [vymyšlený odkaz](/blogs/podvod/neexistuje) a [externí](https://zlo.example/x).'] }],
      faq: [{ q: 'a', a: 'b' }],
    });
  const post = await generatePost({ topic: GOOD_TOPIC, generateTextFn: linked, siblings, wordCountMin: 5 });
  assert.ok(post.bodyHtml.includes('<a href="/blogs/ze-zakulisi/starsi-clanek">starším článku</a>'));
  assert.ok(!post.bodyHtml.includes('/blogs/podvod/neexistuje'), 'an invented internal link is dropped');
  assert.ok(post.bodyHtml.includes('vymyšlený odkaz'), 'its anchor text survives as plain text');
  assert.ok(!post.bodyHtml.includes('zlo.example'), 'an external link never becomes an anchor');
  assert.ok(!post.qc.warnings.some((w) => w.code === 'no-internal-links'));
});

test('QC warns when siblings exist but the article links to none, and asks for a hint otherwise', async () => {
  const siblings = [{ title: 'S', url: '/blogs/news/s' }];
  const post = await generatePost({ topic: GOOD_TOPIC, generateTextFn: async () => goodModelJson(), siblings, wordCountMin: 10 });
  const codes = post.qc.warnings.map((w) => w.code);
  assert.ok(codes.includes('no-internal-links'));
  assert.ok(!codes.includes('no-internal-link'), 'the hint warning stands down when there are real links to make');

  const alone = await generatePost({ topic: GOOD_TOPIC, generateTextFn: async () => goodModelJson(), wordCountMin: 10 });
  assert.ok(!alone.qc.warnings.some((w) => w.code === 'no-internal-links'));
});

test('a printable skeleton still reserves the form paragraph', async () => {
  const post = await generatePost({ topic: PRINTABLE_TOPIC, generateTextFn: async () => 'garbage' });
  assert.equal(post.copySource, 'seed');
  assert.ok(post.bodyHtml.includes(FORM_PLACEHOLDER));
  assert.ok(!post.qc.warnings.some((w) => w.code === 'no-form-placeholder'));
});

// ---- store -----------------------------------------------------------------

function withDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'fma-blog-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('isValidId rejects path traversal and accepts slugs', () => {
  assert.ok(isValidId('darek-ke-dni-matek'));
  assert.ok(!isValidId('../secret'));
  assert.ok(!isValidId('a/b'));
  assert.ok(!isValidId(''));
});

test('store save/reload/list/delete round-trips a post', () => {
  withDir((dir) => {
    const post = { id: 'test-post', seoTitle: 'Test', topic: { keyword: 'test', source: 'seo' }, bodyHtml: '<p>x</p>', status: 'koncept', qc: { warnings: [] } };
    const saved = savePost(dir, post, new Date('2026-05-01T10:00:00Z'));
    assert.equal(saved.createdAt, '2026-05-01T10:00:00.000Z');
    assert.equal(readPost(dir, 'test-post').seoTitle, 'Test');
    const list = listPosts(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'koncept');
    // update keeps createdAt, moves updatedAt
    const again = savePost(dir, { ...post, seoTitle: 'Test 2' }, new Date('2026-05-02T10:00:00Z'));
    assert.equal(again.createdAt, '2026-05-01T10:00:00.000Z');
    assert.equal(again.updatedAt, '2026-05-02T10:00:00.000Z');
    assert.equal(readPost(dir, 'test-post').seoTitle, 'Test 2');
    deletePost(dir, 'test-post');
    assert.equal(readPost(dir, 'test-post'), null);
    assert.equal(listPosts(dir).length, 0);
  });
});

test('siblingsInCluster offers only same-cluster articles that really reached the storefront', () => {
  withDir((dir) => {
    const base = (id, over) => ({ id, seoTitle: id, topic: { keyword: id, cluster: 'darek-z-fotky' }, status: 'koncept', ...over });
    savePost(dir, base('sent-one', { status: 'odeslano', shopifyHandle: 'sent-one', publishedBlogHandle: 'inspirace-na-darky' }), new Date('2026-05-01T10:00:00Z'));
    savePost(dir, base('sent-two', { status: 'odeslano', shopifyHandle: 'sent-two', publishedBlogHandle: 'inspirace-na-darky' }), new Date('2026-05-02T10:00:00Z'));
    savePost(dir, base('still-a-draft'), new Date('2026-05-03T10:00:00Z'));
    savePost(dir, base('no-blog-handle', { status: 'odeslano', shopifyHandle: 'no-blog-handle' }), new Date('2026-05-04T10:00:00Z'));
    savePost(dir, { ...base('other-cluster', { status: 'odeslano', shopifyHandle: 'other', publishedBlogHandle: 'news' }), topic: { keyword: 'o', cluster: 'jak-to-funguje' } }, new Date('2026-05-05T10:00:00Z'));

    const found = siblingsInCluster(dir, 'darek-z-fotky');
    assert.deepEqual(found.map((s) => s.url), ['/blogs/inspirace-na-darky/sent-two', '/blogs/inspirace-na-darky/sent-one']);
    assert.equal(siblingsInCluster(dir, 'darek-z-fotky', { excludeId: 'sent-two' }).length, 1);
    assert.deepEqual(siblingsInCluster(dir, null), [], 'a topic with no cluster has no siblings');
    assert.equal(siblingsInCluster(dir, 'darek-z-fotky', { limit: 1 }).length, 1);
  });
});

// ---- shopify content seam --------------------------------------------------

test('buildArticleInput always marks the article as a draft (isPublished:false)', () => {
  const input = buildArticleInput({ blogId: 'gid://shopify/Blog/1', post: { seoTitle: 'T', bodyHtml: '<p>b</p>', metaDescription: 'm', handle: 'h', tags: ['a'] }, author: 'David' });
  assert.equal(input.isPublished, false);
  assert.equal(input.blogId, 'gid://shopify/Blog/1');
  assert.equal(input.title, 'T');
  assert.equal(input.body, '<p>b</p>');
  assert.equal(input.author.name, 'David');
  assert.ok(input.metafields.some((m) => m.key === 'title_tag' && m.value === 'T'));
});

test('createContentClient requires a store + token', () => {
  assert.throws(() => createContentClient({ storeDomain: '', contentToken: 't' }), ShopifyContentError);
  assert.throws(() => createContentClient({ storeDomain: 's', contentToken: '' }), ShopifyContentError);
});

test('createArticleDraft sends the content token + draft payload and returns the article', async () => {
  let captured = null;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, json: async () => ({ data: { articleCreate: { article: { id: 'gid://shopify/Article/9', handle: 'h', isPublished: false }, userErrors: [] } } }) };
  };
  const client = createContentClient({ storeDomain: 'shop.myshopify.com', contentToken: 'secret-token', fetchImpl });
  const article = await client.createArticleDraft({ blogId: 'gid://shopify/Blog/1', post: { seoTitle: 'T', bodyHtml: '<p>b</p>' }, author: 'David' });
  assert.equal(article.id, 'gid://shopify/Article/9');
  assert.equal(captured.opts.headers['X-Shopify-Access-Token'], 'secret-token');
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.variables.article.isPublished, false);
});

test('createArticleDraft surfaces a taken handle as a clear error, never mangles it', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: { articleCreate: { article: null, userErrors: [{ field: ['handle'], message: 'Handle already taken' }] } } }) });
  const client = createContentClient({ storeDomain: 's.myshopify.com', contentToken: 't', fetchImpl });
  await assert.rejects(() => client.createArticleDraft({ blogId: 'b', post: { seoTitle: 'T', bodyHtml: 'x' } }), (e) => e instanceof ShopifyContentError && e.code === 'handle-taken');
});

test('createArticleDraft maps a missing write_content scope to a clear error', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ errors: [{ message: 'denied', extensions: { code: 'ACCESS_DENIED' } }] }) });
  const client = createContentClient({ storeDomain: 's.myshopify.com', contentToken: 't', fetchImpl });
  await assert.rejects(() => client.createArticleDraft({ blogId: 'b', post: { seoTitle: 'T', bodyHtml: 'x' } }), (e) => e.code === 'scope');
});

// ---- config ----------------------------------------------------------------

const BASE = { generator: { baseUrl: 'https://example.test/tok/' }, builder: { baseUrl: 'https://example.test' } };

test('blog config: disabled by default, dataDir outside repo, defaults applied', () => {
  const cfg = validateConfig({ ...BASE });
  assert.equal(cfg.blog.enabled, false);
  assert.equal(cfg.blog.author, 'Fotomalovánky');
  assert.equal(cfg.blog.wordCountMin, 800);
  assert.ok(cfg.blog.dataDir && cfg.blog.dataDir.includes('fotomalovanky'));
});

test('blog.dataDir inside the repo tree is rejected', () => {
  assert.throws(() => validateConfig({ ...BASE, blog: { dataDir: './blog-drafts' } }), ConfigError);
});

test('blog.enabled without a Shopify content token is a clear error', () => {
  assert.throws(() => validateConfig({ ...BASE, blog: { enabled: true } }), /content token/);
});

test('the content token falls back to the orders token, or uses a dedicated one', () => {
  const shared = validateConfig({ ...BASE, shopify: { enabled: true, storeDomain: 's.myshopify.com', accessToken: 'orders-tok' } });
  assert.equal(shared.shopify.contentToken, 'orders-tok');
  const dedicated = validateConfig({ ...BASE, shopify: { enabled: true, storeDomain: 's.myshopify.com', accessToken: 'orders-tok', contentToken: 'content-tok' } });
  assert.equal(dedicated.shopify.contentToken, 'content-tok');
});
