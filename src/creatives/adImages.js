// Orchestrate the two images an ad's reveal needs, keeping the two external calls behind injectable
// seams so this stays unit-testable:
//   before  = a NEW marketing photo from Nano Banana Pro (reimagined from an uploaded reference —
//             the output is AI-generated, never the customer's actual photo)
//   after   = that photo turned into a coloring-page line drawing by the existing RunPod generator
//
// The server binds `aiFn` to src/creatives/aiImage.js and `lineArtFn` to the RunPod driver; tests
// pass stubs so no network or GPU is touched.

export class AdImageError extends Error {
  constructor(message, code = 'unknown') {
    super(message);
    this.name = 'AdImageError';
    this.code = code;
  }
}

/**
 * @param {object} o
 * @param {?string} o.referenceBase64  the uploaded reference photo (base64, no data: prefix)
 * @param {string}  o.referenceMime    its MIME type
 * @param {string}  o.prompt           the scene to generate
 * @param {function} o.aiFn            ({referenceBase64, referenceMime, prompt}) => {base64, mimeType}
 * @param {function} o.lineArtFn       (image {base64, mimeType}) => {base64, mimeType}
 * @returns {Promise<{ before: {base64,mimeType}, after: {base64,mimeType} }>}
 */
export async function generateAdImages({ referenceBase64 = null, referenceMime = 'image/jpeg', prompt, aiFn, lineArtFn } = {}) {
  if (!prompt || !String(prompt).trim()) throw new AdImageError('A prompt is required.', 'bad-input');
  if (typeof aiFn !== 'function' || typeof lineArtFn !== 'function') {
    throw new AdImageError('Both an image generator and a line-art step are required.', 'bad-input');
  }
  const before = await aiFn({ referenceBase64, referenceMime, prompt });
  if (!before?.base64) throw new AdImageError('The image step returned no image.', 'no-image');
  const after = await lineArtFn(before);
  if (!after?.base64) throw new AdImageError('The line-art step returned no image.', 'no-image');
  return { before, after };
}

/** Format an {base64, mimeType} image as a data: URI for the browser / template. */
export function toDataUri(image) {
  return `data:${image.mimeType || 'image/png'};base64,${image.base64}`;
}
