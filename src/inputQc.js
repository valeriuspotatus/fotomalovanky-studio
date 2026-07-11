// Pure input-QC heuristics: they judge the customer's *photos*, before any generation, from
// already-decoded pixels and dimensions — so they are testable without an image library, exactly
// like qc.js. A thin sharp adapter (inputQcFiles.js) decodes each photo and feeds these.
//
// The stance is qcFiles.js's: a tripwire for photos that are wrong on their face — too small to
// print, too blurry to use, too dark to see, a duplicate of another, or a file that will not open
// — not a judge of whether a photo makes a good coloring page. That judgement stays with the
// operator's review grid. Defaults are deliberately loose: a marginal photo let through costs one
// review; a good order held on a false alarm costs trust. Calibrate the numbers on the real
// archive before tightening them — the same way qc.js's solid-fill limits were tuned on order 1523.

export const DEFAULT_INTAKE = Object.freeze({
  // resolution
  hardMinMegapixels: 0.15, // below this a photo cannot print at A4 — a hold
  minMegapixels: 0.5, // below this it is small enough to mention — a warn
  minShortSidePx: 600, // a long thin strip can clear the MP bar yet still be unprintable

  // blur — variance of the Laplacian on the normalised grey. Sharp photos run into the hundreds
  // and up, a soft phone photo into the tens. CALIBRATE before trusting this number.
  blurVarianceMin: 60,

  // exposure — mean luminance (0-255) and the fraction of pixels crushed to black / blown to white
  darkMeanMax: 40,
  brightMeanMin: 225,
  clipFractionMax: 0.35,

  // duplicates — Hamming distance between 64-bit dHashes; <= this reads as "the same shot".
  // Never a hold on its own: a burst of the same child is genuinely similar but not a duplicate,
  // so the operator confirms. An exact byte-for-byte repeat is caught upstream (file hash) and is
  // the one that holds, because it means a distinct photo is actually missing.
  dupHammingMax: 5,
});

/** Verdict from a photo's true pixel dimensions. Zero/absent dimensions mean the decoder gave us
 *  nothing — treated as unreadable, which the adapter also reaches when sharp throws. */
export function assessResolution(width, height, opts = {}) {
  const { hardMinMegapixels, minMegapixels, minShortSidePx } = { ...DEFAULT_INTAKE, ...opts };
  if (!(width > 0) || !(height > 0)) return { verdict: 'hold', reason: 'unreadable', mp: 0, shortSide: 0 };
  const mp = (width * height) / 1e6;
  const shortSide = Math.min(width, height);
  if (mp < hardMinMegapixels || shortSide < minShortSidePx) {
    return { verdict: 'hold', reason: 'low-resolution', mp, shortSide };
  }
  if (mp < minMegapixels) return { verdict: 'warn', reason: 'smallish', mp, shortSide };
  return { verdict: 'ok', reason: 'ok', mp, shortSide };
}

/** Variance of the Laplacian — the standard cheap focus measure. A flat or blurred image has
 *  little high-frequency energy, so its Laplacian is near-zero everywhere and the variance is low;
 *  a crisp one has strong edges and a high variance. Interior pixels only (the border has no
 *  4-neighbourhood). Returns 0 for a buffer too small or too short to measure. */
export function laplacianVariance(gray, width, height) {
  if (!(width > 2) || !(height > 2) || gray.length < width * height) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export function assessBlur(gray, width, height, opts = {}) {
  const { blurVarianceMin } = { ...DEFAULT_INTAKE, ...opts };
  const variance = laplacianVariance(gray, width, height);
  const verdict = variance < blurVarianceMin ? 'warn' : 'ok';
  return { verdict, reason: verdict === 'ok' ? 'ok' : 'blurry', variance };
}

/** Mean luminance and clipping. A dark or blown photo still often generates acceptably, so these
 *  are warns the operator weighs, not holds. */
export function assessExposure(gray, opts = {}) {
  const { darkMeanMax, brightMeanMin, clipFractionMax } = { ...DEFAULT_INTAKE, ...opts };
  const total = gray.length;
  if (total === 0) return { verdict: 'warn', reason: 'empty', mean: 0, clip: 0 };
  let sum = 0;
  let clipped = 0;
  for (let i = 0; i < total; i++) {
    const v = gray[i];
    sum += v;
    if (v <= 4 || v >= 251) clipped++;
  }
  const mean = sum / total;
  const clip = clipped / total;
  if (mean < darkMeanMax) return { verdict: 'warn', reason: 'dark', mean, clip };
  if (mean > brightMeanMin) return { verdict: 'warn', reason: 'overexposed', mean, clip };
  if (clip > clipFractionMax) return { verdict: 'warn', reason: 'clipped', mean, clip };
  return { verdict: 'ok', reason: 'ok', mean, clip };
}

/** Difference hash: a 9x8 grey grid, one bit per adjacent-column comparison, 64 bits in an 8-row
 *  by 8-comparison layout. Sampled by nearest neighbour so it needs no separate resize step and
 *  stays pure. Two photos of the same moment produce hashes a few bits apart; unrelated photos are
 *  far apart. Returns an all-zero hash for an unusable buffer (which then matches nothing but
 *  another empty). */
export function dHash(gray, width, height) {
  const COLS = 9;
  const ROWS = 8;
  const bits = new Uint8Array(64);
  if (!(width > 0) || !(height > 0) || gray.length < width * height) return bits;
  const sample = (gx, gy) => {
    const sx = Math.min(width - 1, Math.floor(((gx + 0.5) / COLS) * width));
    const sy = Math.min(height - 1, Math.floor(((gy + 0.5) / ROWS) * height));
    return gray[sy * width + sx];
  };
  let b = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS - 1; c++) {
      bits[b++] = sample(c, r) < sample(c + 1, r) ? 1 : 0;
    }
  }
  return bits;
}

/** Bits that differ between two 64-bit dHashes. */
export function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < 64; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** Index pairs [i, j] whose hashes are within dupHammingMax — the near-duplicate candidates. */
export function nearDuplicatePairs(hashes, opts = {}) {
  const { dupHammingMax } = { ...DEFAULT_INTAKE, ...opts };
  const pairs = [];
  for (let i = 0; i < hashes.length; i++) {
    for (let j = i + 1; j < hashes.length; j++) {
      if (hamming(hashes[i], hashes[j]) <= dupHammingMax) pairs.push([i, j]);
    }
  }
  return pairs;
}

/** Count of distinct photos against what the product includes. Unknown expected is not a failure —
 *  the count simply goes unjudged (info), never a hold on a guess. `unique` is the upload count
 *  minus exact-duplicate extras, computed by the caller. */
export function assessCount({ expected, unique }) {
  if (expected == null) return { verdict: 'info', reason: 'expected-unknown', expected: null, unique };
  if (unique < expected) return { verdict: 'hold', reason: 'missing-photos', expected, unique };
  if (unique > expected) return { verdict: 'warn', reason: 'extra-photos', expected, unique };
  return { verdict: 'ok', reason: 'ok', expected, unique };
}

const RANK = Object.freeze({ ok: 0, info: 0, warn: 1, hold: 2 });

/** The order's gating verdict: the worst any finding reached. info and ok both mean "proceed". */
export function worstVerdict(verdicts) {
  return verdicts.reduce((w, v) => (RANK[v] > RANK[w] ? v : w), 'ok');
}
