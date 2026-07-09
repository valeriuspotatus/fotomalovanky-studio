// Stable contract every generator driver implements. The rest of the pipeline
// depends on this interface, not on whether the seam is scripted HTTP or a
// browser-driven UI. The U2 HAR spike resolved this to the scripted HTTP API
// (see docs/spikes/2026-07-09-u2-generator-api.md), so ApiGeneratorDriver is
// the live implementation; browserDriver stays as the documented fallback.
export class GeneratorDriver {
  /**
   * Convert one photo to its coloring-book outputs.
   *
   * @param {string} photoPath  absolute path to the input photo
   * @param {object} settings   generation settings, shaped like config.generator:
   *   - variant {string}         variant key "<model>_<megapixels>", e.g. "2509_1.5"
   *   - diffusionSteps {number}  diffusion steps (default 4)
   *   - positivePrompt {string}  positive prompt ("" → let the server use its default)
   *   - negativePrompt {string}  negative prompt ("" → let the server use its default)
   * @returns {Promise<{ originalPath: string, coloringPngPath: string, coloringSvgPath: string }>}
   *   Local paths to the three downloaded outputs. Naming mirrors the generator's
   *   own bundle: original photo, raster "_bw.png" line-art, and vector ".svg".
   */
  async generate(photoPath, settings) {
    throw new Error('GeneratorDriver.generate is abstract');
  }
}

/** Thrown when a driver is selected but its seam isn't wired up yet. */
export class GeneratorNotImplementedError extends Error {}

/**
 * A generator-seam failure phrased for the operator (no stack traces in the UI).
 * `step` names where in the flow it broke (upload/process/poll/vectorize/download)
 * so the orchestrator's run report can say which seam gave way.
 *
 * `retryable` marks a failure the driver may recover from by resubmitting the work —
 * as opposed to one the operator has to act on. A GPU job that comes back FAILED is
 * retryable (RunPod workers die, OOM, and cold-start badly); a rejected upload is not.
 */
export class GeneratorError extends Error {
  constructor(message, { step, cause, retryable = false } = {}) {
    super(message);
    this.name = 'GeneratorError';
    this.seam = 'generator';
    this.step = step ?? null;
    this.retryable = retryable;
    if (cause !== undefined) this.cause = cause;
  }
}
