// Stable contract every generator driver implements. The rest of the pipeline
// depends on this interface, not on whether the seam is scripted HTTP or a
// browser-driven UI — that choice is made by the U2 spike from a HAR capture.
export class GeneratorDriver {
  /**
   * @param {string} photoPath  absolute path to the input photo
   * @param {object} settings   { variant, diffusionSteps, positivePrompt, negativePrompt }
   * @returns {Promise<{ originalPath: string, coloringPngPath: string, coloringSvgPath: string }>}
   */
  async generate(photoPath, settings) {
    throw new Error('GeneratorDriver.generate is abstract');
  }
}

export class GeneratorNotImplementedError extends Error {}
