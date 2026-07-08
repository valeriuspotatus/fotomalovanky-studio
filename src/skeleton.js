import { mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, redactForLog } from './config.js';
import { createGeneratorDriver } from './generator/factory.js';
import { BuilderDriver } from './builder/builderDriver.js';
import { outputPaths } from './organize.js';

// Phase-0 walking skeleton: prove one photo end-to-end.
//   photo -> generator.generate() -> organize into <base>.jpg + <base>_bw.svg
//         -> builder.buildPdf() -> print-ready PDF.
// The two live calls sit behind interfaces. Until the drivers are filled in from
// the HAR/observation, this throws the clear pending-observation error at the
// exact seam — which is what proves the WIRING is correct ahead of the seam work.
export async function runWalkingSkeleton({ config, photoPath, orderDir }) {
  const generator = createGeneratorDriver(config);
  const builder = new BuilderDriver(config);

  mkdirSync(orderDir, { recursive: true });
  const out = outputPaths(photoPath, orderDir);

  // 1. Generate the coloring-book outputs for this one photo.
  const result = await generator.generate(photoPath, config.generator);

  // 2. Organize into the builder's expected pair naming.
  copyFileSync(result.originalPath, out.original);
  copyFileSync(result.coloringSvgPath, out.coloringSvg);
  if (result.coloringPngPath) copyFileSync(result.coloringPngPath, out.coloringPng);

  // 3. Drive the builder to a print-ready PDF for this single-photo order.
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
  runWalkingSkeleton({ config, photoPath, orderDir })
    .then((r) => console.log('Walking skeleton produced PDF:', r.pdfPath))
    .catch((err) => {
      console.error('Skeleton stopped at a seam:', err.message);
      process.exit(1);
    });
}
