import { mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, redactForLog } from './config.js';
import { createGeneratorDriver } from './generator/factory.js';
import { BuilderDriver } from './builder/builderDriver.js';
import { outputPaths } from './organize.js';

// Phase-0 walking skeleton: prove one photo end-to-end.
//   photo -> generator.generate() -> organize into the builder triple
//            (<base>.jpg + <base>_bw.png + <base>.svg)
//         -> builder.buildPdf() -> print-ready PDF.
// Both live calls sit behind interfaces and are now implemented: the generator seam is
// the scripted HTTP ApiGeneratorDriver (U2, live-validated), and the builder seam is the
// Playwright headless-print BuilderDriver (U5). A full run needs the generator token in
// config.json and a one-time `npx playwright install chromium` for the builder.
export async function runWalkingSkeleton({ config, photoPath, orderDir, onStage, onProgress }) {
  const stage = (m) => (typeof onStage === 'function' ? onStage(m) : undefined);
  const generator = createGeneratorDriver(config);
  const builder = new BuilderDriver(config);

  mkdirSync(orderDir, { recursive: true });
  const out = outputPaths(photoPath, orderDir);

  // 1. Generate the coloring-book outputs for this one photo.
  stage('1/3 generate — running the photo through the generator (diffusion + vectorize)…');
  const result = await generator.generate(photoPath, { ...config.generator, onProgress });

  // 2. Organize into the builder's expected pair naming.
  stage('2/3 organize — writing the builder triple (<base>.jpg + <base>_bw.png + <base>.svg)…');
  copyFileSync(result.originalPath, out.original);
  copyFileSync(result.coloringSvgPath, out.coloringSvg);
  if (result.coloringPngPath) copyFileSync(result.coloringPngPath, out.coloringPng);

  // 3. Drive the builder to a print-ready PDF for this single-photo order.
  stage('3/3 build — driving the builder to the print-ready A4 PDF…');
  const outPdfPath = join(orderDir, `${out.base}.pdf`);
  const { pdfPath } = await builder.buildPdf(orderDir, { title: out.base, outPdfPath });

  return { pdfPath, pair: { photo: out.original, coloringSvg: out.coloringSvg } };
}

// CLI: node src/skeleton.js <photoPath> [orderDir]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [photoPath, orderDir = './outbox/skeleton'] = process.argv.slice(2);
  if (!photoPath) {
    console.error('Usage: node src/skeleton.js <photoPath> [orderDir]');
    process.exit(2);
  }
  const config = loadConfig();
  console.log('Config loaded (redacted):', JSON.stringify(redactForLog(config).generator));
  runWalkingSkeleton({
    config,
    photoPath,
    orderDir,
    onStage: (m) => console.log(m),
    onProgress: ({ step, message }) => console.log(`   [${step}] ${message}`),
  })
    .then((r) => console.log('Walking skeleton produced PDF:', r.pdfPath))
    .catch((err) => {
      console.error(`Skeleton stopped at the ${err.seam ?? 'unknown'} seam${err.step ? ` (${err.step})` : ''}: ${err.message}`);
      process.exit(1);
    });
}
