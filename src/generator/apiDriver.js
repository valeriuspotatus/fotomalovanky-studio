import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { GeneratorDriver, GeneratorError } from './driver.js';
import { analyzeFraming, cropToPixels, trimFlatBorders, NO_CORRECTION } from '../photoFraming.js';

// Scripted HTTP driver — reproduces the exact calls the generator's web UI makes,
// reverse-engineered from the U2 HAR spike + the live compare page and app.js
// (see docs/spikes/2026-07-09-u2-generator-api.md). The generator is a token-in-
// the-path service with no cookies/auth, backed by RunPod serverless GPUs.
//
// One photo's flow:
//   POST /upload (multipart files[])                          -> { job_id }
//   GET  /status/{job}                                        -> { files:[{filename}] }  (server adds a hash prefix)
//   POST /process/{job}/{file} {model,megapixels,steps,...}   -> { success, variant_key }
//   GET  /process-status/{job}/{file}/{variantKey}            -> { status: IN_QUEUE|IN_PROGRESS|COMPLETED|FAILED }
//   POST /vectorize/{job}/{file} {variant_key}               -> { success, jpg_filename, png_filename, svg_filename }
//   GET  /download/{job}/{filename}                           -> bytes (jpg / _bw.png / .svg)

const MAX_DIMENSION = 2500; // web UI downscales anything larger before upload
const JPEG_QUALITY = 92; //    (matches resizeImageFile's 0.92)
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

/** Bytes ready to upload.
 *
 *  Phones store a portrait photo as landscape pixels plus an EXIF "orientation" flag that says
 *  "rotate me". Browsers honour that flag when they draw the image to a canvas, so the generator's
 *  own web UI uploads an upright photo without trying. sharp does NOT rotate unless asked, and
 *  re-encoding drops the flag — so a portrait photo was being sent as a landscape one, and the
 *  child came back drawn on their side, limbs cut off by the wrong-shaped frame.
 *
 *  `.rotate()` with no angle bakes the EXIF orientation into the pixels (and resets the flag). We
 *  only re-encode when there is something to do — a photo that is already small and upright is
 *  passed through untouched, so a good original is never needlessly recompressed.
 *
 *  THIS BUFFER BECOMES THE STORED ORIGINAL TOO, which is why the content-level correction belongs
 *  here and nowhere else. The generator echoes the uploaded file back as `jpg_filename`, organize.js
 *  writes that echo to `<base>.jpg`, and the review grid, the PDF's cover and the order .zip all read
 *  it. Correct the bytes once on the way up and the colouring page, the photo beside it and the
 *  printed cover agree; correct them anywhere else and they do not.
 *
 *  `correction` comes from photoFraming.js — a rotation the EXIF block never recorded, and the crop
 *  box of a real photo inside a screenshot. It is applied AFTER the EXIF rotate, because that is the
 *  frame the model was shown and the frame its crop coordinates refer to. */
export async function prepareImageForUpload(input, { maxDimension = MAX_DIMENSION, quality = JPEG_QUALITY, correction = null } = {}) {
  const meta = await sharp(input).metadata();
  const tooBig = Math.max(meta.width ?? 0, meta.height ?? 0) > maxDimension;
  const sideways = (meta.orientation ?? 1) > 1; // 1 = upright; 2..8 = the camera flipped or turned it
  const turn = correction?.rotate ?? 0;
  const cropBox = correction?.crop ?? null;
  if (!tooBig && !sideways && !turn && !cropBox) return { buffer: input, changed: false, tooBig, sideways, meta };

  // Bake the camera's orientation into real bytes FIRST, on its own.
  //
  // sharp treats rotation as one setting rather than a queue: `.rotate()` (auto-orient from EXIF)
  // followed by `.rotate(90)` does not do both, the calls collide and the picture comes out
  // untouched. So the EXIF pass is materialised here and the explicit angle is applied to a fresh
  // pipeline over the result. On a photo with no orientation flag — 230 of 248 in the live archive —
  // this pass is a no-op that costs one decode.
  const upright = await sharp(input).rotate().toBuffer({ resolveWithObject: true });

  // The crop is measured on that EXIF-corrected frame, so it is cut before the picture is turned.
  // Cutting afterwards would apply screen-capture coordinates to a frame whose axes had swapped.
  let working = upright.data;
  let cropped = false;
  if (cropBox) {
    const box = cropToPixels(cropBox, upright.info.width, upright.info.height);
    if (box) {
      working = await sharp(working).extract(box).toBuffer();
      cropped = true;
      // The model finds the card, not the photograph — it leaves a border, a caption row and the
      // viewer's buttons behind. Finish the edges by measurement (see trimFlatBorders); only ever on
      // something already identified as a screen capture.
      const tight = await trimFlatBorders(working);
      if (tight) working = await sharp(working).extract(tight).toBuffer();
    }
  }

  let pipeline = sharp(working);
  if (turn) pipeline = pipeline.rotate(turn); // the content rotation EXIF never recorded
  if (tooBig) pipeline = pipeline.resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true });
  const buffer = await pipeline.jpeg({ quality }).toBuffer();
  return { buffer, changed: true, tooBig, sideways, meta, turned: turn, cropped };
}

/** "2509_1.5" -> { model: "2509", megapixels: 1.5 } */
function parseVariant(variant) {
  const i = String(variant).lastIndexOf('_');
  const megapixels = i > 0 ? Number.parseFloat(variant.slice(i + 1)) : NaN;
  if (i <= 0 || Number.isNaN(megapixels)) {
    throw new GeneratorError(
      `Invalid generator variant ${JSON.stringify(variant)} — expected "<model>_<megapixels>", e.g. "2509_1.5".`,
      { step: 'config' },
    );
  }
  return { model: variant.slice(0, i), megapixels };
}

async function safeText(res) {
  try {
    return (await res.text()).trim();
  } catch {
    return '';
  }
}

export class ApiGeneratorDriver extends GeneratorDriver {
  constructor(config) {
    super();
    this.config = config;
    this.prefix = String(config.generator.baseUrl).replace(/\/+$/, '');
    const t = config.generator?.timeouts ?? {};
    this.requestTimeoutMs = t.requestMs ?? 60_000; // Render cold starts can be slow
    this.vectorizeTimeoutMs = t.vectorizeMs ?? 180_000; // tracing a full image takes a while
    this.pollIntervalMs = t.pollIntervalMs ?? 4_000; // matches the web UI's cadence
    this.maxPollMs = t.maxPollMs ?? 20 * 60_000; // diffusion + GPU cold-start headroom
    this.maxRetries = t.retries ?? 4; // transport-level (network / 5xx) retries
    this.gpuRetries = t.gpuRetries ?? 2; // resubmits after the GPU accepts a job and then FAILs it
    this.backoffBaseMs = t.backoffBaseMs ?? 1_000;
    this.onProgress = null; // optional (step, message) sink; set per-call from settings
  }

  #emit(step, message) {
    if (typeof this.onProgress === 'function') this.onProgress({ step, message });
  }

  /** @override */
  async generate(photoPath, settings = {}) {
    const g = this.config.generator ?? {};
    this.onProgress = typeof settings.onProgress === 'function' ? settings.onProgress : null;
    const variant = settings.variant ?? g.variant;
    if (!variant) {
      throw new GeneratorError(
        'No generator variant configured — set generator.variant to a variant key like "2509_1.5".',
        { step: 'config' },
      );
    }
    const { model, megapixels } = parseVariant(variant);
    const steps = settings.diffusionSteps ?? g.diffusionSteps ?? 4;
    const positive = (settings.positivePrompt ?? g.positivePrompt ?? '').trim();
    const negative = (settings.negativePrompt ?? g.negativePrompt ?? '').trim();
    this.#emit('start', `variant ${variant}, steps ${steps}`);

    // 1. Mirror the UI's client-side downscale, then upload.
    const { buffer, filename, correction } = await this.#prepareUpload(photoPath, settings);
    const jobId = await this.#upload(buffer, filename);

    // 2. The server stores the file under a hash-prefixed name — learn it.
    const serverName = await this.#resolveServerFilename(jobId, filename);

    // 3 + 4. Submit the diffusion job and wait for the GPU, resubmitting if the job dies.
    const variantKey = await this.#processAndWait(jobId, serverName, { model, megapixels, steps, positive, negative }, variant);

    // 5. Vectorize — this is what mints the final jpg / _bw.png / .svg triple.
    const names = await this.#vectorize(jobId, serverName, variantKey);

    // 6. Download the three outputs into a local work dir.
    const outDir = settings.workDir ?? mkdtempSync(join(tmpdir(), 'fma-gen-'));
    mkdirSync(outDir, { recursive: true });
    const originalPath = await this.#download(jobId, names.jpg_filename, outDir);
    const coloringPngPath = await this.#download(jobId, names.png_filename, outDir);
    const coloringSvgPath = await this.#download(jobId, names.svg_filename, outDir);
    this.#emit('done', `3 outputs in ${outDir}`);

    return { originalPath, coloringPngPath, coloringSvgPath, jobId, variantKey, framing: correction };
  }

  // ---- steps ---------------------------------------------------------------

  async #prepareUpload(photoPath, settings = {}) {
    const filename = basename(photoPath);
    const input = readFileSync(photoPath);
    try {
      // Ask what the EXIF block could not say: is the picture actually upright, and is this a
      // screenshot with a real photo buried in it. Analysed on the EXIF-corrected frame so the crop
      // box it returns lines up with the bytes we are about to cut. Answers NO_CORRECTION on any
      // failure, so a photo is never held up by the analysis being unavailable.
      const correction = await this.#framing(input, settings);

      const { buffer, changed, tooBig, sideways, meta, turned, cropped } = await prepareImageForUpload(input, { correction });
      if (changed) {
        const parts = [];
        if (tooBig) parts.push(`downscaled ${meta.width}x${meta.height} -> max ${MAX_DIMENSION}px`);
        if (sideways) parts.push("applied the camera's rotation");
        if (cropped) parts.push('cropped the photo out of a screenshot');
        if (turned) parts.push(`turned it ${turned}° upright`);
        this.#emit('resize', parts.join(', '));
      }
      return { buffer, filename, correction };
    } catch {
      // Not a sharp-readable image (or metadata failed) — let the server validate the raw bytes.
    }
    return { buffer: input, filename, correction: NO_CORRECTION };
  }

  /** The framing question, on an EXIF-corrected copy. Off unless `ai.enabled` and a key are set, and
   *  silent when `generator.autoFraming` is turned off in config. */
  async #framing(input, settings = {}) {
    const ai = this.config?.ai;
    // `noFraming` is the operator's undo: regenerate this one photo exactly as it arrived.
    if (settings.noFraming === true) return NO_CORRECTION;
    if (this.config?.generator?.autoFraming === false) return NO_CORRECTION;
    if (!ai?.enabled || !ai?.apiKey) return NO_CORRECTION;
    const upright = await sharp(input).rotate().jpeg({ quality: 88 }).toBuffer();
    return analyzeFraming({ config: ai, buffer: upright });
  }

  async #upload(buffer, filename) {
    this.#emit('upload', `uploading ${filename} (${Math.round(buffer.length / 1024)} KB)`);
    const form = new FormData();
    form.append('files[]', new Blob([buffer]), filename); // fetch sets the multipart boundary
    const res = await this.#request(`${this.prefix}/upload`, { method: 'POST', body: form, step: 'upload', label: 'upload' });
    const data = await res.json();
    if (data.error) throw new GeneratorError(`Upload rejected: ${data.error}`, { step: 'upload' });
    if (!data.job_id) throw new GeneratorError('Upload returned no job_id.', { step: 'upload' });
    this.#emit('upload', `job ${data.job_id}`);
    return data.job_id;
  }

  async #resolveServerFilename(jobId, uploadedName) {
    const res = await this.#request(`${this.prefix}/status/${enc(jobId)}`, { step: 'status', label: 'status' });
    const data = await res.json();
    const files = Array.isArray(data.files) ? data.files : [];
    const base = uploadedName.replace(/\.[^.]+$/, '');
    const match =
      files.find((f) => f?.filename === uploadedName) ??
      files.find((f) => f?.filename?.endsWith(uploadedName)) ??
      files.find((f) => f?.filename?.includes(base)) ??
      files[files.length - 1];
    if (!match?.filename) throw new GeneratorError('Job status returned no files after upload.', { step: 'status' });
    this.#emit('status', `server filename ${match.filename}`);
    return match.filename;
  }

  async #process(jobId, serverName, { model, megapixels, steps, positive, negative }, variantFallback) {
    const body = { model, megapixels, steps };
    if (positive) body.positive_prompt = positive; // omit -> server uses its own default
    if (negative) body.negative_prompt = negative;
    const res = await this.#request(`${this.prefix}/process/${enc(jobId)}/${enc(serverName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      step: 'process',
      label: 'process',
    });
    const data = await res.json();
    if (!data.success) throw new GeneratorError(`Generator refused the job: ${data.error ?? 'unknown error'}`, { step: 'process' });
    const key = data.variant_key ?? variantFallback; // server key is authoritative (e.g. "2511_1.0")
    this.#emit('process', `submitted, variant_key=${key}`);
    return key;
  }

  /** Submit the job and wait for it. A GPU-side FAILED is retried by submitting a *new* job —
   *  polling the dead one again would only re-read FAILED. Transport errors are already retried
   *  inside #request; this loop exists solely for jobs the GPU accepted and then lost. */
  async #processAndWait(jobId, serverName, params, variantFallback) {
    for (let attempt = 0; ; attempt++) {
      const variantKey = await this.#process(jobId, serverName, params, variantFallback);
      try {
        await this.#pollUntilDone(jobId, serverName, variantKey);
        return variantKey;
      } catch (err) {
        const canRetry = err instanceof GeneratorError && err.retryable && attempt < this.gpuRetries;
        if (!canRetry) {
          if (err instanceof GeneratorError && err.retryable) {
            throw new GeneratorError(
              `${err.message} — gave up after ${this.gpuRetries + 1} attempts on the GPU.`,
              { step: 'poll', cause: err },
            );
          }
          throw err;
        }
        const waitMs = this.backoffBaseMs * 2 ** attempt;
        this.#emit('poll', `GPU job failed; resubmitting in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 2}/${this.gpuRetries + 1})`);
        await sleep(waitMs);
      }
    }
  }

  async #pollUntilDone(jobId, serverName, variantKey) {
    const started = Date.now();
    const deadline = started + this.maxPollMs;
    while (Date.now() < deadline) {
      const res = await this.#request(
        `${this.prefix}/process-status/${enc(jobId)}/${enc(serverName)}/${enc(variantKey)}`,
        { step: 'poll', label: 'process-status' },
      );
      const data = await res.json();
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (data.status === 'COMPLETED') {
        this.#emit('poll', `COMPLETED after ${elapsed}s`);
        return;
      }
      if (data.status === 'FAILED') {
        // The GPU job died — a fresh job on a fresh worker usually succeeds, so let the
        // caller resubmit rather than losing the photo. ~8% of jobs failed in the operator's
        // recorded session, which is roughly one dropped photo per 16-photo order.
        throw new GeneratorError(`Generation failed on the GPU: ${data.error ?? 'no detail'}`, {
          step: 'poll',
          retryable: true,
        });
      }
      // IN_QUEUE / IN_PROGRESS -> keep waiting
      this.#emit('poll', `${data.status ?? 'waiting'}… ${elapsed}s`);
      await sleep(this.pollIntervalMs);
    }
    throw new GeneratorError(
      `Generation timed out after ${Math.round(this.maxPollMs / 1000)}s (never reached COMPLETED).`,
      { step: 'poll' },
    );
  }

  async #vectorize(jobId, serverName, variantKey) {
    this.#emit('vectorize', 'tracing to SVG…');
    const res = await this.#request(`${this.prefix}/vectorize/${enc(jobId)}/${enc(serverName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variant_key: variantKey }),
      step: 'vectorize',
      label: 'vectorize',
      timeoutMs: this.vectorizeTimeoutMs,
    });
    const data = await res.json();
    if (!data.success) throw new GeneratorError(`Vectorization failed: ${data.error ?? 'unknown error'}`, { step: 'vectorize' });
    if (!data.jpg_filename || !data.png_filename || !data.svg_filename) {
      throw new GeneratorError('Vectorize response missing one of jpg/png/svg filenames.', { step: 'vectorize' });
    }
    this.#emit('vectorize', `svg=${data.svg_filename}`);
    return data;
  }

  async #download(jobId, name, outDir) {
    const res = await this.#request(`${this.prefix}/download/${enc(jobId)}/${enc(name)}`, {
      step: 'download',
      label: `download ${name}`,
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    const dest = join(outDir, name);
    writeFileSync(dest, buffer);
    this.#emit('download', `${name} (${Math.round(buffer.length / 1024)} KB)`);
    return dest;
  }

  // ---- HTTP with cold-start-aware retry ------------------------------------

  async #request(url, { method = 'GET', headers, body, timeoutMs = this.requestTimeoutMs, retries = this.maxRetries, step, label } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { method, headers, body, signal: controller.signal });
        clearTimeout(timer);
        if (res.ok) return res;
        if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
          lastErr = new Error(`HTTP ${res.status}`); // transient (Render/RunPod) — fall through to backoff
        } else {
          const detail = await safeText(res);
          throw new GeneratorError(
            `${label ?? 'request'} failed: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
            { step },
          );
        }
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof GeneratorError) throw err;
        lastErr = err; // network error or timeout (AbortError) — retryable
        if (attempt >= retries) {
          const why = err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message;
          throw new GeneratorError(`${label ?? 'request'} failed after ${retries + 1} attempts: ${why}`, { step, cause: err });
        }
      }
      await sleep(this.backoffBaseMs * 2 ** attempt); // 1s, 2s, 4s, 8s...
    }
    throw new GeneratorError(`${label ?? 'request'} failed: ${lastErr?.message ?? 'unknown'}`, { step, cause: lastErr });
  }
}

// CLI: node src/generator/apiDriver.js <photoPath> [outDir]  — direct seam test (U2/U8).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadConfig, redactForLog } = await import('../config.js');
  const [photoPath, outDir] = process.argv.slice(2);
  if (!photoPath) {
    console.error('Usage: node src/generator/apiDriver.js <photoPath> [outDir]');
    process.exit(2);
  }
  const config = loadConfig();
  console.log('Generator (redacted):', JSON.stringify(redactForLog(config).generator));
  const driver = new ApiGeneratorDriver(config);
  const onProgress = ({ step, message }) => console.log(`  [${step}] ${message}`);
  driver
    .generate(photoPath, { ...config.generator, workDir: outDir || undefined, onProgress })
    .then((r) => console.log('Generated:\n  ' + [r.originalPath, r.coloringPngPath, r.coloringSvgPath].join('\n  ')))
    .catch((err) => {
      console.error(`Generator seam failed${err.step ? ` at "${err.step}"` : ''}: ${err.message}`);
      process.exit(1);
    });
}
