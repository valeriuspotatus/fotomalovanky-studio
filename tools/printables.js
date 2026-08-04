#!/usr/bin/env node
// Printables production line: a theme definition in, one downloadable A4 PDF out.
//
//   node tools/printables.js --theme zvirata --dry-run   # print the plan, generate nothing
//   node tools/printables.js --theme zvirata             # the real, capped run
//
// Per page: Gemini paints a source photo from the theme's English prompt → the SAME generator seam
// and the SAME configured coloring prompt that customer orders use turns it into line art → qc.js
// judges it → the pages are laid out as A4 portrait and printed to PDF through Chromium, exactly the
// way the order builder makes its PDFs. No new dependencies: Playwright and sharp are already here.
//
// THIS SPENDS MONEY, so both meters are hard. It stops and reports rather than exceed a cap, and it
// never touches an order, a state.json, or the autopilot's folders — everything it writes lands in
// printables/<theme>/, which is gitignored.
//
// A reroll re-runs the GENERATOR on the same source photo with more diffusion steps. That is the
// house recipe for a bad page (docs: never fix a page by adding prompt detail) and it means a reroll
// costs a generator job and no Gemini image.

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { loadConfig } from '../src/config.js';
import { createGeneratorDriver } from '../src/generator/factory.js';
import { generateMarketingImage } from '../src/creatives/aiImage.js';
import { assessOutputFiles } from '../src/qcFiles.js';
import { deblob } from '../src/deblob.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const LOGO = join(REPO, 'src', 'ui', 'static', 'creatives', 'logo.png');

/** Hard ceilings for one run. Reaching either stops the run — it never trims a page silently. */
export const CAPS = Object.freeze({ generatorJobs: 12, geminiImages: 12 });
/** How many pages get a web preview for the article. */
const PREVIEW_PAGES = 3;
const PREVIEW_WIDTH = 1200;

/** Minimal argv parsing: --theme <name>, --dry-run, --out <dir>, --max-jobs/--max-images <n>.
 *  The two cap overrides exist so a resumed run can be given only the budget the first run left —
 *  the ceiling is per *task*, not per invocation. They can only ever lower a cap. */
export function parseArgs(argv) {
  const args = { theme: null, dryRun: false, out: null, maxJobs: null, maxImages: null, limit: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--theme') args.theme = argv[++i] ?? null;
    else if (argv[i] === '--out') args.out = argv[++i] ?? null;
    else if (argv[i] === '--max-jobs') args.maxJobs = Number(argv[++i]);
    else if (argv[i] === '--max-images') args.maxImages = Number(argv[++i]);
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
  }
  return args;
}

/** The caps for this invocation: the defaults, or lower if the command line says so. Never higher. */
export function resolveCaps({ maxJobs, maxImages } = {}) {
  return Object.freeze({
    generatorJobs: Number.isInteger(maxJobs) && maxJobs >= 0 ? Math.min(maxJobs, CAPS.generatorJobs) : CAPS.generatorJobs,
    geminiImages: Number.isInteger(maxImages) && maxImages >= 0 ? Math.min(maxImages, CAPS.geminiImages) : CAPS.geminiImages,
  });
}

/** A theme is only usable when every page has a subject and a prompt — say so before spending. */
export function validateTheme(theme) {
  const problems = [];
  if (!theme || typeof theme !== 'object') return ['theme is not an object'];
  if (!theme.name) problems.push('theme.name is missing');
  if (!Array.isArray(theme.pages) || !theme.pages.length) problems.push('theme.pages is empty');
  for (const [i, p] of (theme.pages ?? []).entries()) {
    if (!p?.subject) problems.push(`page ${i + 1}: subject is missing`);
    if (!p?.prompt || String(p.prompt).trim().length < 20) problems.push(`page ${i + 1}: prompt is missing or too short`);
  }
  if ((theme.pages ?? []).length > CAPS.geminiImages) {
    problems.push(`theme has ${theme.pages.length} pages but the Gemini cap is ${CAPS.geminiImages}`);
  }
  return problems;
}

/** `01-pes` — the page's file stem, index-prefixed so the set keeps its order on disk. */
function stem(page, i) {
  const slug = String(page.subject)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${String(i + 1).padStart(2, '0')}-${slug || 'strana'}`;
}

/** Two meters, both hard. `spend` throws rather than let a run drift past what was authorised. */
export function createMeter(caps = CAPS) {
  const used = { generatorJobs: 0, geminiImages: 0 };
  return {
    used,
    left: (kind) => caps[kind] - used[kind],
    spend(kind, what) {
      if (used[kind] >= caps[kind]) {
        throw new Error(`Cap reached: ${used[kind]}/${caps[kind]} ${kind}. Stopping before ${what}.`);
      }
      used[kind]++;
      return used[kind];
    },
  };
}

/** Uniform printable margin on all four sides. */
export const PAGE_MARGIN_MM = 8;

/** The print sheet: one A4 portrait page per image, the drawing FILLING the printable area, a quiet
 *  footer with the logo and the domain. preferCSSPageSize makes @page the authority.
 *
 *  The art covers its box rather than fitting inside it. Fitting a 3:4 drawing into a taller box left
 *  uneven white bands above and below, which read as a mistake on a printed page; covering trims about
 *  3% off each side instead, and the sources are composed with their objects clear of the edges.
 *
 *  `fontDataUri` embeds Fredoka as bytes, so the footer renders identically on a machine that has
 *  never heard of the font — a PDF that depends on a locally installed font is a PDF that silently
 *  changes when it travels. */
export function buildSheetHtml(imageUrls, { logoDataUri = null, title = 'Fotomalovánky', fontDataUri = null } = {}) {
  const footer = `<footer>${logoDataUri ? `<img class="mark" src="${logoDataUri}" alt="">` : ''}<span>fotomalovanky.cz</span></footer>`;
  const pages = imageUrls
    .map((url) => `<section class="page"><div class="art"><img src="${url}" alt=""></div>${footer}</section>`)
    .join('\n');
  const face = fontDataUri
    ? `@font-face { font-family: 'Fredoka'; font-style: normal; font-weight: 300 600;
       src: url(${fontDataUri}) format('truetype'); font-display: block; }`
    : '';
  return `<!doctype html>
<html lang="cs"><head><meta charset="utf-8"><title>${title}</title><style>
  ${face}
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .page {
    width: 210mm; height: 297mm; padding: ${PAGE_MARGIN_MM}mm;
    display: flex; flex-direction: column; align-items: center;
    break-after: page; page-break-after: always; overflow: hidden;
  }
  .page:last-child { break-after: auto; page-break-after: auto; }
  .art { flex: 1 1 auto; width: 100%; min-height: 0; overflow: hidden; }
  /* cover + centred = fill the printable area, trimming evenly from both sides */
  .art img { width: 100%; height: 100%; object-fit: cover; object-position: center; display: block; }
  footer {
    flex: 0 0 auto; display: flex; align-items: center; justify-content: center; gap: 2.5mm;
    padding-top: 3mm; font: 400 9pt/1 'Fredoka', system-ui, -apple-system, "Segoe UI", Arial, sans-serif; color: #444;
  }
  footer .mark { height: 5mm; width: auto; }
</style></head><body>
${pages}
</body></html>`;
}

const FONT_CACHE = join(REPO, 'printables', '.fonts', 'Fredoka.ttf');
// Google serves whatever format it thinks the caller can read, decided purely from the User-Agent:
// woff2 to a modern browser, woff to Firefox 3 / Safari 5, EOT to MSIE, and plain TTF to an old
// Android. Measured, not guessed — MSIE returned font/eot and the css2 endpoint no format at all.
// This is the one that yields an sfnt, and the magic bytes are checked below rather than trusting
// the Content-Type, because the format is the whole requirement here.
const TTF_UA =
  'Mozilla/5.0 (Linux; U; Android 2.2; en-us; Nexus One Build/FRF91) ' +
  'AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1';

/** True for a real sfnt container (TrueType / OpenType), false for woff, woff2, eot or an error page. */
export function isSfnt(buf) {
  if (!buf || buf.length < 4) return false;
  const hex = buf.subarray(0, 4).toString('hex');
  const ascii = buf.subarray(0, 4).toString('latin1');
  return hex === '00010000' || ascii === 'true' || ascii === 'ttcf' || ascii === 'OTTO';
}

/**
 * Fredoka as a base64 data URI, downloaded once and cached on disk.
 *
 * Embedded rather than referenced on purpose: a PDF that names a font renders in whatever the reading
 * machine happens to have, so the same file looks different on David's laptop and at a print shop.
 * Embedding the bytes makes the footer identical everywhere. Returns null if the download fails —
 * that costs the typeface, not the build, and the footer falls back to the system stack.
 */
export async function loadFredoka({ fetchImpl = fetch } = {}) {
  if (existsSync(FONT_CACHE)) {
    return `data:font/ttf;base64,${readFileSync(FONT_CACHE).toString('base64')}`;
  }
  // A STATIC ttf on purpose. google/fonts only ships Fredoka as a variable font, and Chromium will
  // not embed one into a PDF: it writes a FontDescriptor naming the family and no FontFile at all, so
  // the file silently depends on the reader having Fredoka installed — exactly what embedding is meant
  // to prevent. Measured both ways; the static instance from the CSS API embeds as FontFile2. That
  // instance is the Light weight, which is the price of a self-contained PDF and worth paying.
  try {
    const cssRes = await fetchImpl('https://fonts.googleapis.com/css?family=Fredoka', {
      headers: { 'User-Agent': TTF_UA },
    });
    if (!cssRes.ok) throw new Error(`Google Fonts CSS returned ${cssRes.status}`);
    const css = await cssRes.text();
    // The url has no .ttf extension (it is a /l/font?kit=… delivery link), so the format is proved
    // from the bytes, not from the filename.
    const url = (css.match(/url\((https:[^)]+)\)/) ?? [])[1];
    if (!url) throw new Error('no font url in the Google Fonts CSS response');
    const fontRes = await fetchImpl(url, { headers: { 'User-Agent': TTF_UA } });
    if (!fontRes.ok) throw new Error(`font download returned ${fontRes.status}`);
    const bytes = Buffer.from(await fontRes.arrayBuffer());
    if (!isSfnt(bytes)) {
      throw new Error(`downloaded ${bytes.length} bytes but they are not a TTF (magic ${bytes.subarray(0, 4).toString('hex')})`);
    }
    mkdirSync(dirname(FONT_CACHE), { recursive: true });
    writeFileSync(FONT_CACHE, bytes);
    console.log(`    Fredoka downloaded and cached (${Math.round(bytes.length / 1024)} KB): ${FONT_CACHE}`);
    return `data:font/ttf;base64,${bytes.toString('base64')}`;
  } catch (err) {
    console.log(`    Fredoka unavailable (${err.message}) — the footer falls back to the system font.`);
    return null;
  }
}

/** The logo as a data URI, or null when it isn't there — a missing asset costs the mark, not the run. */
function logoDataUri() {
  try {
    if (!existsSync(LOGO)) return null;
    return `data:image/png;base64,${readFileSync(LOGO).toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * Lay the finished line art out as A4 and print it to one PDF. Exported so the assembly step can be
 * proved with placeholder images without spending anything.
 * @param {string[]} imagePaths  absolute paths to the page images, in order
 * @param {string} outPdfPath
 */
export async function assemblePdf(imagePaths, outPdfPath, { title } = {}) {
  if (!imagePaths.length) throw new Error('assemblePdf needs at least one page image.');
  mkdirSync(dirname(outPdfPath), { recursive: true });
  const html = buildSheetHtml(imagePaths.map((p) => pathToFileURL(resolve(p)).href), { logoDataUri: logoDataUri(), title, fontDataUri: await loadFredoka() });
  const htmlPath = `${outPdfPath.replace(/\.pdf$/i, '')}.html`;
  writeFileSync(htmlPath, html);

  const { chromium } = await import('playwright');
  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    throw new Error(`Could not launch headless Chromium — run "npx playwright install chromium" once. (${err.message})`);
  }
  try {
    const page = await browser.newPage();
    // file:// so the page images load off disk, the same way the order builder renders its PDFs.
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });
    await page.pdf({ path: outPdfPath, preferCSSPageSize: true, printBackground: true });
  } finally {
    await browser.close().catch(() => {});
  }
  return { pdfPath: outPdfPath, htmlPath };
}

/** Web previews for the article: the first N pages at ~1200px wide, webp. */
export async function exportPreviews(pages, dir, limit = PREVIEW_PAGES) {
  mkdirSync(dir, { recursive: true });
  const out = [];
  for (const p of pages.slice(0, limit)) {
    const dest = join(dir, `${p.stem}.webp`);
    await sharp(p.coloringPngPath)
      .flatten({ background: '#ffffff' })
      .resize({ width: PREVIEW_WIDTH, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(dest);
    out.push(dest);
  }
  return out;
}

/** Print what a live run would do, page by page, and spend nothing. */
function printPlan(theme, workDir) {
  console.log(`\nTheme: ${theme.title ?? theme.name} (${theme.pages.length} pages)`);
  if (theme.setDescription) console.log(`Set description: ${theme.setDescription}`);
  console.log(`Work dir: ${workDir}`);
  console.log(`Caps: ${CAPS.geminiImages} Gemini images, ${CAPS.generatorJobs} generator jobs ` +
    `(${theme.pages.length} pages + up to ${CAPS.generatorJobs - theme.pages.length} rerolls)\n`);
  theme.pages.forEach((p, i) => {
    const s = stem(p, i);
    console.log(`--- page ${i + 1}/${theme.pages.length}: ${p.subject}  [${s}]`);
    console.log(`    source image prompt: ${p.prompt}`);
    console.log(`    would write: ${join(workDir, 'source', `${s}.png`)}`);
    console.log(`    then:        generator (configured coloring prompt) -> ${join(workDir, 'pages', s)}\\*_bw.png|.svg`);
  });
  console.log(`\n    then: ${join(workDir, `${theme.name}.pdf`)} (A4 portrait, footer "fotomalovanky.cz")`);
  console.log(`    then: ${PREVIEW_PAGES} previews at ${PREVIEW_WIDTH}px -> ${join(workDir, 'previews')}`);
  console.log('\nDry run: nothing was generated.\n');
}

/** May this page spend a job on a reroll? Only if doing so still leaves a first pass for every page
 *  behind it. Without this, the front of the set rerolls itself and the back never gets drawn. */
export function canReroll(jobsLeft, pagesAfter) {
  return jobsLeft > pagesAfter;
}

/**
 * Is a reroll (more diffusion steps) even the right answer to this defect?
 *
 * NOT for solid fill. Measured over the first Zvířata run, every step reroll made the solid blob
 * BIGGER, never smaller: 0.051→0.073, 0.092→0.095, 0.278→0.300. The darkness is in the source photo
 * and the vectoriser fills it, so grinding more steps at it cannot help — deblob() clears it instead,
 * and it now runs before QC ever sees the page. More steps remains the right lever for a bad face.
 * A page that is blank, near-solid or unreadable is a different failure, and worth one more roll.
 */
export function shouldReroll(verdict, reason) {
  return verdict !== 'ok' && reason !== 'solid-fill';
}

/** Widest width/height a source photo may have and still be worth tracing. 3:4 is 0.75; the gate sits
 *  at 0.9 so a slightly-off portrait passes and a square or landscape does not. */
export const MAX_SOURCE_ASPECT = 0.9;

/** Is this source shaped for a portrait page? A 16:9 photo traced onto A4 wastes two thirds of the
 *  sheet, and we find that out for free here rather than after paying for a generator job. */
export function isPortraitEnough(width, height, max = MAX_SOURCE_ASPECT) {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width / height <= max;
}

/** An earlier run's source image for this page, if it is still on disk. Re-buying what we already
 *  paid for is the one thing a metered tool must never do. */
function existingSource(sourceDir, s) {
  for (const ext of ['png', 'jpg']) {
    const p = join(sourceDir, `${s}.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

/** An earlier run's generator outputs for one attempt directory, if both files are there. */
function existingOutputs(dir) {
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir);
  const png = names.find((n) => n.toLowerCase().endsWith('_bw.png'));
  const svg = names.find((n) => n.toLowerCase().endsWith('.svg'));
  return png && svg ? { coloringPngPath: join(dir, png), coloringSvgPath: join(dir, svg) } : null;
}

/** One page, end to end: paint the source, trace it, judge it, reroll once if the judge says no.
 *  `pagesAfter` is how many pages still need a first pass — a reroll may never eat their budget. */
async function producePage({ page, i, theme, config, driver, meter, workDir, pagesAfter = 0 }) {
  const s = stem(page, i);
  const sourceDir = join(workDir, 'source');
  const pageDir = join(workDir, 'pages', s);
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(pageDir, { recursive: true });
  console.log(`\n--- page ${i + 1}/${theme.pages.length}: ${page.subject} [${s}]`);
  let sourcePath = existingSource(sourceDir, s);
  let sourceShape = null;
  if (sourcePath) {
    const m = await sharp(sourcePath).metadata();
    sourceShape = { width: m.width, height: m.height };
    console.log(`    source: reused ${sourcePath} ${m.width}x${m.height} (no image spent)`);
  } else {
    // Regenerate a landscape source rather than trace it — but only while there is an image to spare
    // over the ones still owed to the pages behind this one, same reserve rule the generator uses.
    for (;;) {
      meter.spend('geminiImages', `the source image for ${page.subject}`);
      const img = await generateMarketingImage({ config: config.ai, prompt: page.prompt, aspectRatio: theme.aspectRatio ?? null });
      // Name the file after what came back, not after what we hoped for — the model answers image/jpeg
      // as often as image/png, and the generator's upload step reads the extension.
      const candidate = join(sourceDir, `${s}.${img.mimeType === 'image/png' ? 'png' : 'jpg'}`);
      writeFileSync(candidate, Buffer.from(img.base64, 'base64'));
      const m = await sharp(candidate).metadata();
      const ratio = (m.width / m.height).toFixed(2);
      if (isPortraitEnough(m.width, m.height)) {
        sourcePath = candidate;
        sourceShape = { width: m.width, height: m.height };
        console.log(`    source: ${candidate} ${m.width}x${m.height} (${ratio})`);
        break;
      }
      console.log(`    source REJECTED: ${m.width}x${m.height} (${ratio}) is not portrait`);
      rmSync(candidate, { force: true });
      if (!canReroll(meter.left('geminiImages'), pagesAfter)) {
        // Spending a generator job on a landscape source buys a page that wastes two thirds of the
        // sheet. Skipping costs nothing and says so plainly.
        console.log('    no image budget to retry — skipping this page rather than tracing a landscape source.');
        return { subject: page.subject, stem: s, sourcePath: null, sourceShape: { width: m.width, height: m.height }, attempts: [], verdict: 'skipped', reason: 'landscape-source', coloringPngPath: null, coloringSvgPath: null };
      }
    }
  }

  const baseSteps = config.generator?.diffusionSteps ?? 8;
  const maxSteps = config.generator?.maxDiffusionSteps ?? baseSteps + 4;
  const attempts = [];
  // The reroll bumps diffusion steps — the tuned recipe's answer to a bad page. Two guards on it:
  // the meter must have a job left, AND that job must not be one of the first passes still owed to
  // the pages behind this one. Rerolling greedily at the front of the set starves the back of it.
  for (const steps of [baseSteps, maxSteps]) {
    const workSub = join(pageDir, `steps-${steps}`);
    let out = existingOutputs(workSub);
    if (out) {
      console.log(`    ${steps} steps -> reusing outputs already on disk (no job spent)`);
    } else {
      meter.spend('generatorJobs', `the ${attempts.length ? 'reroll of' : 'coloring pass for'} ${page.subject}`);
      try {
        out = await driver.generate(sourcePath, { workDir: workSub, diffusionSteps: steps, noFraming: true });
      } catch (err) {
        console.log(`    generator FAILED at ${steps} steps: ${err.message}`);
        attempts.push({ steps, verdict: 'failed', reason: err.message });
        if (!canReroll(meter.left('generatorJobs'), pagesAfter)) break;
        continue;
      }
    }
    // Clear the big black masses BEFORE judging the page. The vectoriser fills genuinely dark areas
    // (a butterfly's wing markings, a shadow) with solid black that no amount of re-rolling removes;
    // deblob whitens those and leaves outline strokes and small fills like eyes alone. Judging after
    // it means QC scores the page the customer actually gets. A deblob failure costs the cleanup,
    // never the page.
    let cleaned = null;
    try {
      cleaned = await deblob({ pngPath: out.coloringPngPath, svgPath: out.coloringSvgPath });
      if (cleaned.cleaned) console.log(`    ${steps} steps -> deblob cleared ${cleaned.blobBlocks} solid blocks`);
    } catch (err) {
      console.log(`    ${steps} steps -> deblob skipped: ${err.message}`);
    }
    const qc = await assessOutputFiles({ coloringPng: out.coloringPngPath, coloringSvg: out.coloringSvgPath });
    const line = `${qc.verdict}${qc.reason ? ` (${qc.reason})` : ''}` +
      (qc.solidFill !== undefined ? ` solidFill=${(qc.solidFill * 100).toFixed(3)}% solidBlob=${(qc.solidBlob * 100).toFixed(3)}% ink=${(qc.coverage * 100).toFixed(1)}%` : '');
    console.log(`    ${steps} steps -> ${line}`);
    attempts.push({ steps, verdict: qc.verdict, reason: qc.reason ?? null, deblobbed: Boolean(cleaned?.cleaned), qc, ...out });
    if (qc.verdict === 'ok') break;
    if (!shouldReroll(qc.verdict, qc.reason)) {
      console.log(`    no reroll: "${qc.reason}" is not a defect more steps can fix.`);
      break;
    }
    if (!canReroll(meter.left('generatorJobs'), pagesAfter)) {
      console.log(`    no reroll: ${meter.left('generatorJobs')} jobs left, ${pagesAfter} pages still need a first pass.`);
      break;
    }
  }

  // A passing attempt wins outright. When they all flag, keep the LEAST bad one by solid-blob area —
  // more diffusion steps can make a page worse, so "the last attempt" is not the same as "the best".
  const done = attempts.filter((a) => a.coloringSvgPath);
  const best =
    done.find((a) => a.verdict === 'ok') ??
    done.slice().sort((a, b) => (a.qc?.solidBlob ?? 1) - (b.qc?.solidBlob ?? 1))[0] ??
    null;
  return {
    subject: page.subject,
    stem: s,
    sourcePath,
    attempts: attempts.map((a) => ({ steps: a.steps, verdict: a.verdict, reason: a.reason })),
    verdict: best?.verdict ?? 'failed',
    reason: best?.reason ?? 'no attempt completed',
    coloringPngPath: best?.coloringPngPath ?? null,
    coloringSvgPath: best?.coloringSvgPath ?? null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.theme) {
    console.error('Usage: node tools/printables.js --theme <name> [--dry-run] [--out <dir>]');
    process.exit(2);
  }
  const themePath = join(HERE, 'printables', `${args.theme}.js`);
  if (!existsSync(themePath)) {
    console.error(`No theme file at ${themePath}`);
    process.exit(2);
  }
  const theme = (await import(pathToFileURL(themePath).href)).default;
  const problems = validateTheme(theme);
  if (problems.length) {
    console.error(`Theme "${args.theme}" is not usable:\n  - ${problems.join('\n  - ')}`);
    process.exit(2);
  }

  const workDir = resolve(args.out ?? join(REPO, 'printables', theme.name));
  if (args.dryRun) return printPlan(theme, workDir);

  const config = loadConfig();
  if (!config.ai?.enabled || !config.ai?.apiKey) {
    console.error('ai.enabled + ai.apiKey are needed to paint the source images.');
    process.exit(1);
  }
  const driver = createGeneratorDriver(config);
  const caps = resolveCaps(args);
  const meter = createMeter(caps);
  mkdirSync(workDir, { recursive: true });
  console.log(`Theme ${theme.title ?? theme.name} -> ${workDir}`);
  console.log(`Caps: ${caps.geminiImages} Gemini images, ${caps.generatorJobs} generator jobs.`);

  // --limit runs only the first N pages, so a cheap probe can prove a new composition style before
  // the whole set is paid for. Everything it produces is reused free by the follow-up full run.
  const todo = Number.isInteger(args.limit) && args.limit > 0 ? theme.pages.slice(0, args.limit) : theme.pages;
  if (todo.length < theme.pages.length) console.log(`Probe: pages 1-${todo.length} of ${theme.pages.length} only.`);

  const results = [];
  let stopped = null;
  for (const [i, page] of todo.entries()) {
    try {
      results.push(await producePage({ page, i, theme, config, driver, meter, workDir, pagesAfter: todo.length - 1 - i }));
    } catch (err) {
      stopped = err.message;
      console.error(`\nSTOPPED: ${err.message}`);
      break;
    }
  }

  const usable = results.filter((r) => r.coloringSvgPath);
  let pdf = null;
  let previews = [];
  if (usable.length) {
    pdf = await assemblePdf(usable.map((r) => r.coloringSvgPath), join(workDir, `${theme.name}.pdf`), { title: theme.title });
    previews = await exportPreviews(usable.filter((r) => r.coloringPngPath), join(workDir, 'previews'));
  }

  console.log('\n==== summary ====');
  for (const r of results) {
    console.log(`${r.stem.padEnd(14)} ${r.verdict.padEnd(8)} ${r.reason ?? ''} [${r.attempts.map((a) => `${a.steps}:${a.verdict}`).join(' -> ')}]`);
  }
  console.log(`\nGemini images: ${meter.used.geminiImages}/${caps.geminiImages}   generator jobs: ${meter.used.generatorJobs}/${caps.generatorJobs}`);
  if (pdf) console.log(`PDF: ${pdf.pdfPath} (${usable.length} pages)`);
  if (previews.length) console.log(`Previews: ${previews.join('\n          ')}`);
  const bad = results.filter((r) => r.verdict !== 'ok');
  if (bad.length) console.log(`\nNeeds a manual redo: ${bad.map((r) => r.subject).join(', ')}`);
  if (stopped) console.log(`\nRun stopped early: ${stopped}`);
  writeFileSync(join(workDir, 'run.json'), JSON.stringify({ theme: theme.name, results, meter: meter.used, stopped }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err?.stack ?? String(err));
    process.exit(1);
  });
}
