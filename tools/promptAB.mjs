// Prompt / diffusion-steps A/B harness for the U8 follow-up.
//
// The generator exposes no seed, so every generation is stochastic — a single sample
// per config proves nothing. This runs a 2x2 factorial (prompt x steps) with repeats
// and interleaves the repeats so a cold RunPod worker biases timing, not any one config.
//
//   node tools/promptAB.mjs <photo...> --fix edge|glasses [--out DIR]
//                           [--repeats-low N] [--repeats-high N] [--steps-high N]
//
// Repeats are asymmetric on purpose: the generator is deterministic at 8 steps and
// stochastic at 4 (measured — see docs/spikes/2026-07-09-u8-value-gate.md), so the
// high-steps cells need exactly one sample and the low-steps cells need several.
//
// Outputs <out>/results.json plus one <out>/<config>-r<rep>/ dir per generation.
// Everything lands under outbox/ which is gitignored (customer photos).

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import sharp from 'sharp';
import { loadConfig, redactForLog } from '../src/config.js';
import { ApiGeneratorDriver } from '../src/generator/apiDriver.js';
import { assessColoringPixels, assessColoringSvg } from '../src/qc.js';

// ---- prompt variants -------------------------------------------------------

// The control prompts come from the live config, so this stays in sync with what the
// operator actually runs. Each revision is expressed as a *transform* of the control
// and asserts its anchor matched, rather than duplicating 1100 chars of prose.
const ANCHOR_POS =
  'Keep foreground and background clearly separated using clean outlines while preserving the original background scene.';
const ANCHOR_NEG = ', invented background elements';

const EDGE_SENTENCE =
  ' Draw the complete scene from edge to edge: every part of the frame, including the corners and borders, must contain outlined content from the original photo. Do not leave regions of the frame blank or unfinished, and never draw lines that trail off into empty space.';
const EDGE_NEG_ADD = ', stray lines, unconnected lines, incomplete outlines, unfinished edges, empty corners';

function mustReplace(text, needle, replacement, what) {
  if (!text.includes(needle)) {
    throw new Error(`Prompt anchor not found (${what}) — the live config drifted from the A/B assumptions.`);
  }
  return text.replace(needle, replacement);
}

/** Edge-fix revision: instruct edge-to-edge coverage; stop penalising background linework. */
function edgePrompts({ positivePrompt, negativePrompt }) {
  return {
    positivePrompt: mustReplace(positivePrompt, ANCHOR_POS, ANCHOR_POS + EDGE_SENTENCE, 'positive'),
    // Removing "invented background elements" tests whether it suppresses legitimate background.
    negativePrompt: mustReplace(negativePrompt, ANCHOR_NEG, '', 'negative') + EDGE_NEG_ADD,
  };
}

// The control prompt commands eyes unconditionally, in BOTH the positive and the negative:
//   positive: "Both eyes must include visible irises and enclosed pupils."
//   negative: "missing pupils, blank eyes"
// The model complies even when the eyes are not there to draw — inventing them behind opaque
// sunglass lenses, and prising open eyes that are closed in the photo (which also re-poses the
// head). The operator deletes them by hand in Figma. Three symptoms, one cause.
const EYES_POS_OLD = ' Both eyes must include visible irises and enclosed pupils.';
const EYES_NEG_OLD = ', missing pupils, blank eyes';

// v1 "neutral": simply stop demanding eyes. No negation, nothing added. This is the clean test
// of the causal claim — a diffusion model handles "never draw X" poorly, because naming X in the
// positive prompt raises its salience regardless of the "never". An earlier attempt that put
// "never draw eyes, irises, or pupils behind a lens" in the positive made the bug WORSE.
function eyesNeutralPrompts({ positivePrompt, negativePrompt }) {
  return {
    positivePrompt: mustReplace(positivePrompt, EYES_POS_OLD, '', 'positive/eyes'),
    negativePrompt: mustReplace(negativePrompt, EYES_NEG_OLD, '', 'negative/eyes'),
  };
}

// v2 "negative": v1, plus push the unwanted concepts into the NEGATIVE prompt where they belong.
const EYES_NEG_ADD =
  ', eyes behind sunglasses, pupils through lenses, opened eyes, changed gaze direction, altered head pose';
function eyesNegativePrompts(base) {
  const v1 = eyesNeutralPrompts(base);
  return { positivePrompt: v1.positivePrompt, negativePrompt: v1.negativePrompt + EYES_NEG_ADD };
}

// v3 "posonly": drop the positive *demand* for eyes, but KEEP "missing pupils, blank eyes" in the
// negative. The operator added the eye instruction because the generator used to omit pupils — but
// at 4 steps the negative prompt is inert (measured), so that positive sentence was the only thing
// protecting pupils. At 8 steps the negative wakes up and can do that job without the positive
// demand forcing eyes onto closed lids and sunglass lenses.
function eyesPosOnlyPrompts({ positivePrompt, negativePrompt }) {
  return { positivePrompt: mustReplace(positivePrompt, EYES_POS_OLD, '', 'positive/eyes'), negativePrompt };
}

// "edge-neg": the corrected edge fix. Discourage stray/unfinished lines via the NEGATIVE prompt
// (live at 8 steps) while KEEPING `invented background elements` — the guard whose removal made the
// model hallucinate curtains and floorboards into a blown-out white room (order 1510). Adds no
// positive instruction to fill the frame, because "fill every part of the frame" is an invitation
// to invent. Note `empty corners` is deliberately omitted for the same reason.
const EDGE_NEG_ONLY = ', stray lines, unconnected lines, incomplete outlines, unfinished edges';
function edgeNegPrompts({ positivePrompt, negativePrompt }) {
  if (!negativePrompt.includes('invented background elements')) {
    throw new Error('edge-neg expects the anti-hallucination guard to still be present');
  }
  return { positivePrompt, negativePrompt: negativePrompt + EDGE_NEG_ONLY };
}

const FIXES = {
  edge: edgePrompts,
  'edge-neg': edgeNegPrompts,
  'eyes-neutral': eyesNeutralPrompts,
  'eyes-negative': eyesNegativePrompts,
  'eyes-posonly': eyesPosOnlyPrompts,
};

/** "edge+eyes-posonly" -> apply each transform in turn. Transforms touch disjoint substrings. */
function resolveFix(name, base) {
  return name.split('+').reduce((prompts, f) => FIXES[f](prompts), base);
}
const isKnownFix = (name) => name.split('+').every((f) => FIXES[f]);

// ---- metrics ---------------------------------------------------------------

const GRID = 6; // 6x6 tiles
const BLANK_TILE = 0.005; // < 0.5% ink in a tile => effectively empty

/** Global + per-tile ink coverage of a line-art raster. Tile stats expose the
 *  "blank corner / unfinished edge" failure that a global average hides. */
async function inkMetrics(pngPath) {
  const { data, info } = await sharp(pngPath).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const global = assessColoringPixels(data);

  const tiles = [];
  for (let ty = 0; ty < GRID; ty++) {
    for (let tx = 0; tx < GRID; tx++) {
      const x0 = Math.floor((tx * width) / GRID);
      const x1 = Math.floor(((tx + 1) * width) / GRID);
      const y0 = Math.floor((ty * height) / GRID);
      const y1 = Math.floor(((ty + 1) * height) / GRID);
      let ink = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * width;
        for (let x = x0; x < x1; x++, n++) if (data[row + x] < 128) ink++;
      }
      const isBorder = tx === 0 || ty === 0 || tx === GRID - 1 || ty === GRID - 1;
      const isCorner = (tx === 0 || tx === GRID - 1) && (ty === 0 || ty === GRID - 1);
      tiles.push({ tx, ty, coverage: n ? ink / n : 0, isBorder, isCorner });
    }
  }
  const blank = tiles.filter((t) => t.coverage < BLANK_TILE);
  return {
    coverage: global.coverage ?? 0,
    qcVerdict: global.verdict,
    blankTiles: blank.length,
    blankBorderTiles: blank.filter((t) => t.isBorder).length,
    blankCornerTiles: blank.filter((t) => t.isCorner).length,
    minTileCoverage: Math.min(...tiles.map((t) => t.coverage)),
    tiles: tiles.map((t) => +t.coverage.toFixed(5)),
  };
}

function svgMetrics(svgPath) {
  const svg = readFileSync(svgPath, 'utf8');
  const verdict = assessColoringSvg(svg);
  return { svgVerdict: verdict.verdict, svgReason: verdict.reason, svgPaths: (svg.match(/<path\b/gi) ?? []).length };
}

// ---- run -------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const photos = argv.filter((a) => !a.startsWith('--') && /\.(jpe?g|png)$/i.test(a));
const outDir = resolve(flag('--out', 'outbox/ab1'));
const fixNames = flag('--fix', 'edge').split(',').filter(Boolean);
const repeatsLow = Number(flag('--repeats-low', flag('--repeats', '2')));
const repeatsHigh = Number(flag('--repeats-high', flag('--repeats', '2')));
const repsControlLow = Number(flag('--reps-control-low', String(repeatsLow)));
const repsControlHigh = Number(flag('--reps-control-high', String(repeatsHigh)));
const stepsHigh = Number(flag('--steps-high', '8'));

if (photos.length === 0 || fixNames.some((f) => !isKnownFix(f))) {
  console.error(`Usage: node tools/promptAB.mjs <photo.jpg...> --fix ${Object.keys(FIXES).join('|')}[+...][,...] [--out DIR]`);
  console.error('       [--repeats-low N] [--repeats-high N] [--reps-control-low N] [--reps-control-high N] [--steps-high N]');
  process.exit(2);
}

const config = loadConfig();
const base = config.generator;
console.log('Generator (redacted):', JSON.stringify(redactForLog(config).generator.baseUrl));

const stepsLow = base.diffusionSteps ?? 4;
const fixedSets = Object.fromEntries(fixNames.map((f) => [f, resolveFix(f, base)]));

// Cells = {control} ∪ {each fix}, crossed with steps (low|high). Repeats are allocated per cell:
// the high-steps path is deterministic (measured), so one sample there is proof; the low-steps
// path is stochastic, so it needs several before any cell can be believed.
const CONFIGS = [
  { id: 'A', label: `control prompt, ${stepsLow} steps`, prompts: base, steps: stepsLow, reps: repsControlLow },
  { id: 'D', label: `control prompt, ${stepsHigh} steps`, prompts: base, steps: stepsHigh, reps: repsControlHigh },
];
fixNames.forEach((f, i) => {
  CONFIGS.push({ id: `F${i + 1}lo`, label: `${f} prompt, ${stepsLow} steps`, prompts: fixedSets[f], steps: stepsLow, reps: repeatsLow });
  CONFIGS.push({ id: `F${i + 1}hi`, label: `${f} prompt, ${stepsHigh} steps`, prompts: fixedSets[f], steps: stepsHigh, reps: repeatsHigh });
});

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, 'prompts.json'),
  JSON.stringify({ fixes: fixNames, control: { positivePrompt: base.positivePrompt, negativePrompt: base.negativePrompt }, ...fixedSets }, null, 2),
);

const driver = new ApiGeneratorDriver(config);
const results = [];
const maxReps = Math.max(...CONFIGS.map((c) => c.reps));
const total = photos.length * CONFIGS.reduce((s, c) => s + c.reps, 0);
let n = 0;
console.log(`fixes [${fixNames.join(', ')}] — ${total} generations: ` + CONFIGS.filter((c) => c.reps > 0).map((c) => `${c.id}x${c.reps}`).join(' '));

// Interleave repeats so the cold-start penalty lands on one config's timing, not its quality.
for (let rep = 1; rep <= maxReps; rep++) {
  for (const cfg of CONFIGS) {
    if (rep > cfg.reps) continue;
    for (const photo of photos) {
      const photoBase = basename(photo).replace(/\.[^.]+$/, '');
      const workDir = join(outDir, `${photoBase}__${cfg.id}-r${rep}`);
      const tag = `[${++n}/${total}] ${photoBase} ${cfg.id} rep${rep} (${cfg.label})`;
      console.log(`\n=== ${tag}`);
      const t0 = Date.now();
      try {
        const out = await driver.generate(photo, {
          variant: base.variant,
          diffusionSteps: cfg.steps,
          positivePrompt: cfg.prompts.positivePrompt,
          negativePrompt: cfg.prompts.negativePrompt,
          workDir,
          onProgress: ({ step, message }) => process.stdout.write(`  [${step}] ${message}\n`),
        });
        const secs = Math.round((Date.now() - t0) / 1000);
        const ink = await inkMetrics(out.coloringPngPath);
        const svg = svgMetrics(out.coloringSvgPath);
        results.push({ photo: photoBase, config: cfg.id, label: cfg.label, steps: cfg.steps, rep, secs, status: 'ok', ...ink, ...svg, coloringPngPath: out.coloringPngPath });
        console.log(`  -> ok ${secs}s ink ${(ink.coverage * 100).toFixed(2)}% blankTiles ${ink.blankTiles} (border ${ink.blankBorderTiles}, corner ${ink.blankCornerTiles}) svgPaths ${svg.svgPaths}`);
      } catch (err) {
        const secs = Math.round((Date.now() - t0) / 1000);
        console.error(`  -> FAILED after ${secs}s at "${err.step ?? '?'}": ${err.message}`);
        results.push({ photo: photoBase, config: cfg.id, label: cfg.label, steps: cfg.steps, rep, secs, status: 'failed', error: err.message, step: err.step ?? null });
      }
      writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
    }
  }
}

console.log(`\nDone. ${results.filter((r) => r.status === 'ok').length}/${total} ok -> ${join(outDir, 'results.json')}`);
