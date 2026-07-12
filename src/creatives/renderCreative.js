// Render a creative's HTML to PNG with the same headless Chromium the PDF builder uses
// (src/builder/builderDriver.js). The HTML is produced by the Creative Studio's layered renderer
// (src/creatives/studio/renderStudioHtml.js); this is the one seam that touches Playwright and the
// filesystem, so it stays thin and injectable for tests.

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export class CreativeRenderError extends Error {}

/** Render one creative's HTML to a PNG, sized exactly to the format. With `outPath` it writes the
 *  file and returns the path; without it, it returns the PNG bytes as a Buffer (for streaming a
 *  download straight to the browser). `launcher` returns a Playwright browser; it defaults to
 *  headless Chromium and is overridden in tests. */
export async function renderCreativePng({ html, width, height, outPath, launcher }) {
  const launch = launcher ?? (async () => (await import('playwright')).chromium.launch());
  let browser;
  try {
    browser = await launch();
  } catch (err) {
    throw new CreativeRenderError(`Could not launch the headless browser — run "npx playwright install chromium" once. (${err.message})`);
  }
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle' });
    const clip = { x: 0, y: 0, width, height };
    if (outPath) {
      await mkdir(dirname(outPath), { recursive: true });
      await page.screenshot({ path: outPath, clip });
      return outPath;
    }
    return await page.screenshot({ clip });
  } finally {
    await browser.close();
  }
}
