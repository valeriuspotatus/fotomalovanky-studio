import { existsSync, readdirSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Drives the print builder (fotomalovanky-service). The U5 spike found the builder is a
// CLIENT-SIDE app (no HTTP API): a webkitdirectory folder input pairs "<base>.jpg/.jpeg/.png"
// with "<base>.svg" (it ignores "_bw.png"), lays them out under an "@media print / @page A4"
// stylesheet, and exports by calling window.print(). So the driver loads the folder with
// Playwright and renders the PDF via headless Chromium's print pipeline (page.pdf(), which
// uses print media by default) — reproducing the builder's exact output without the print
// dialog. See docs/spikes/2026-07-09-u5-builder.md.
//
// Playwright is imported lazily inside buildPdf so importing this module stays cheap and
// doesn't require the browser binary until an actual build runs.

export class BuilderNotImplementedError extends Error {}

/** A builder-seam failure phrased for the operator; `step` names where it broke. */
export class BuilderError extends Error {
  constructor(message, { step, cause } = {}) {
    super(message);
    this.name = 'BuilderError';
    this.seam = 'builder';
    this.step = step ?? null;
    if (cause !== undefined) this.cause = cause;
  }
}

// An original may be .jpg/.jpeg or .png: customer uploads are usually JPEG, but the
// generator echoes back whatever was uploaded, and the reference orders in the operator's
// fixture pack are PNG throughout. The live builder pairs those PNGs happily.
const PHOTO = /\.(jpe?g|png)$/i;
// "<base>_bw.png" is the generator's raster line-art, NOT an input photo. It must be
// skipped before PHOTO is applied, or it registers as a photo with base "<base>_bw".
const COLORING_PNG = /_bw\.png$/i;
const SVG = /\.svg$/i;
const svgBase = (n) => n.replace(/_bw\.svg$/i, '').replace(/\.svg$/i, '');

// The builder caps the title-page collage at 8 thumbnails, and its "add all" button always
// selects that many. The operator's books use four, so the driver clicks the first N cover
// tiles instead of pressing the button — `addAllCovers` stays as the old spelling of "8".
const MAX_COVERS = 8;

/** How many cover thumbnails belong on the title page, given the options and the pairs on hand. */
export function coverCountFor({ coverCount, addAllCovers } = {}, pairs = 0) {
  const wanted = Number.isInteger(coverCount) ? coverCount : addAllCovers ? MAX_COVERS : 0;
  return Math.max(0, Math.min(wanted, pairs, MAX_COVERS));
}

/** Find the builder's photo+SVG pairs in an order folder (mirrors its own pairing rules). */
export function collectPairs(orderDir) {
  const names = readdirSync(orderDir);
  const photos = new Map(); // base -> filename
  const svgs = new Map();
  for (const n of names) {
    if (COLORING_PNG.test(n)) continue;
    if (PHOTO.test(n)) photos.set(n.replace(PHOTO, ''), n);
    else if (SVG.test(n)) svgs.set(svgBase(n), n);
  }
  const pairs = [];
  for (const [base, photo] of photos) if (svgs.has(base)) pairs.push({ base, photo, svg: svgs.get(base) });
  return pairs;
}

export class BuilderDriver {
  constructor(config) {
    this.config = config;
    const t = config?.builder?.timeouts ?? {};
    this.navTimeoutMs = t.navMs ?? 90_000; // Render cold start
    this.loadTimeoutMs = t.loadMs ?? 30_000; // client-side pairing + SVG measuring
    this.renderTimeoutMs = t.renderMs ?? 60_000; // all photos + SVGs finish loading
  }

  /**
   * @param {string} orderDir  folder of <base>.{jpg,jpeg,png} + <base>.svg pairs (the "_bw.png" is ignored by the builder)
   * @param {object} options   { title|dedication, outPdfPath, mode:'gallery'|'fullpage',
   *                             coverCount, addAllCovers, rotationMin, rotationMax }
   * @returns {Promise<{ pdfPath: string, pairs: number }>}
   */
  async buildPdf(orderDir, options = {}) {
    if (!existsSync(orderDir)) throw new BuilderError(`Order folder not found: ${orderDir}`, { step: 'load' });
    const pairs = collectPairs(orderDir);
    if (pairs.length === 0) {
      throw new BuilderError(
        `No "<base>.jpg|.jpeg|.png + <base>.svg" pairs found in ${orderDir} — the builder needs each photo paired with its SVG coloring page.`,
        { step: 'load' },
      );
    }
    const outPdfPath = options.outPdfPath ?? join(orderDir, `${options.title ?? 'order'}.pdf`);
    mkdirSync(dirname(outPdfPath), { recursive: true });

    const { chromium } = await import('playwright');
    let browser;
    try {
      browser = await chromium.launch();
    } catch (err) {
      throw new BuilderError(
        `Could not launch the headless browser — run "npx playwright install chromium" once. (${err.message})`,
        { step: 'launch', cause: err },
      );
    }
    try {
      const page = await browser.newPage();

      await page.goto(String(this.config.builder.baseUrl), { waitUntil: 'domcontentloaded', timeout: this.navTimeoutMs })
        .catch((err) => { throw new BuilderError(`Could not open the builder page: ${err.message}`, { step: 'load', cause: err }); });
      await page.waitForSelector('#folderInput', { timeout: this.navTimeoutMs });

      // 1. Load the order folder into the webkitdirectory input. A webkitdirectory input
      //    requires a directory PATH (Playwright uploads its contents with webkitRelativePath);
      //    the app filters to jpg/jpeg/png + svg and skips _bw.png itself.
      await page.setInputFiles('#folderInput', resolve(orderDir));

      // 2. Pairing is done when the Print button enables (it does so only when pairs > 0).
      await page.waitForSelector('#printBtn:not([disabled])', { timeout: this.loadTimeoutMs })
        .catch(() => { throw new BuilderError('Builder never enabled Print — it found no usable photo+SVG pairs.', { step: 'load' }); });

      // 3. Apply layout options (all controls are visible on screen; do NOT emulate print here,
      //    the print stylesheet hides them).
      if (options.mode === 'fullpage') await page.click('.mode-btn[data-mode="fullpage"]');
      const title = options.dedication ?? options.title ?? '';
      if (title) await page.fill('#titleInput', title);

      // Each tile toggles one thumbnail onto the title page. Clicking the first N reproduces the
      // operator's four-up collage, which the "add all" button (always 8) cannot.
      const covers = coverCountFor(options, pairs.length);
      if (covers > 0) {
        await page.waitForSelector('.cover-grid-item', { timeout: this.loadTimeoutMs })
          .catch(() => { throw new BuilderError('Builder never offered cover thumbnails to choose from.', { step: 'load' }); });
        const tiles = page.locator('.cover-grid-item');
        for (let i = 0; i < covers; i++) await tiles.nth(i).click();
      }

      if (Number.isFinite(options.rotationMin)) await page.fill('#rotationMin', String(options.rotationMin));
      if (Number.isFinite(options.rotationMax)) await page.fill('#rotationMax', String(options.rotationMax));

      // 4. Wait for every page image (photos + SVGs, loaded as <img> from object URLs) to finish.
      await page.waitForFunction(
        () => {
          const imgs = Array.from(document.querySelectorAll('#pagesContainer img'));
          return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
        },
        { timeout: this.renderTimeoutMs },
      ).catch(() => { throw new BuilderError('Page images did not finish rendering before the timeout.', { step: 'render' }); });
      await page.waitForTimeout(500); // small settle for fonts/layout

      // 5. Render via the print pipeline. page.pdf() uses print media, so @media print + @page A4 apply.
      await page.pdf({ path: outPdfPath, preferCSSPageSize: true, printBackground: true });
    } finally {
      await browser.close();
    }

    // 6. Validate the PDF is genuine.
    if (!existsSync(outPdfPath) || statSync(outPdfPath).size === 0) {
      throw new BuilderError(`Builder produced no PDF at ${outPdfPath}.`, { step: 'export' });
    }
    if (!readFileSync(outPdfPath).subarray(0, 5).toString('latin1').startsWith('%PDF')) {
      throw new BuilderError(`Builder output at ${outPdfPath} is not a valid PDF.`, { step: 'export' });
    }
    return { pdfPath: outPdfPath, pairs: pairs.length };
  }
}

// CLI: node src/builder/builderDriver.js <orderDir> [outPdfPath]  — direct seam test (U5).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadConfig } = await import('../config.js');
  const [orderDir, outPdfPath] = process.argv.slice(2);
  if (!orderDir) {
    console.error('Usage: node src/builder/builderDriver.js <orderDir> [outPdfPath]');
    process.exit(2);
  }
  const config = loadConfig();
  const driver = new BuilderDriver(config);
  driver
    // Matches the operator's confirmed routine: gallery mode + a title page (dedication text),
    // Print-PDF on (default). Add `addAllCovers: true` only if you want cover images too.
    .buildPdf(orderDir, { title: 'skeleton', outPdfPath })
    .then((r) => console.log(`Built PDF from ${r.pairs} pair(s): ${r.pdfPath}`))
    .catch((err) => {
      console.error(`Builder seam failed${err.step ? ` at "${err.step}"` : ''}: ${err.message}`);
      process.exit(1);
    });
}
