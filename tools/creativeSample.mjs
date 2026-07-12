// Render a sample Kreativy creative in all three formats, to eyeball the template.
//   node tools/creativeSample.mjs [outDir] [campaign]
// Needs a real Chromium (npx playwright install chromium). Not part of `npm test`.
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { creativeFromCampaign, CAMPAIGNS } from '../src/creatives/creativeTemplate.js';
import { generateCreative } from '../src/creatives/renderCreative.js';

const outDir = process.argv[2] || join(tmpdir(), 'fma-creatives');
const campaign = process.argv[3] || 'dendeti';
if (!CAMPAIGNS[campaign]) {
  console.error(`Unknown campaign "${campaign}". Try: ${Object.keys(CAMPAIGNS).join(', ')}`);
  process.exit(1);
}

// Embed the real brand logo so the sample matches what the studio renders.
const logoPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'static', 'creatives', 'logo.png');
const logoSrc = `data:image/png;base64,${readFileSync(logoPath).toString('base64')}`;

const fields = creativeFromCampaign(campaign, { logoSrc });
const written = await generateCreative({ fields, outDir, slug: campaign });
console.log(`Rendered "${campaign}" (${CAMPAIGNS[campaign].title}):`);
for (const w of written) console.log(`  ${w.format.padEnd(6)} ${w.path}`);
