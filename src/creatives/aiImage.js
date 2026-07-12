// The Kreativy AI image step: generate a marketing image with Google's Gemini image model
// ("Nano Banana Pro") via the Generative Language API. Image-to-image — a reference photo plus a
// prompt go in, a brand-new synthetic image comes back (base64). The reference only steers the
// result; the output is AI-generated, never the original photo, which is what keeps a customer's
// actual face out of the ad.
//
// This is the one seam that calls Google. It's a thin adapter over fetch, injectable for tests, so
// the studio/server code above it never has to know the request shape. The API key is billable and
// lives only in gitignored config.json (config.ai.apiKey) — never in source.

export class AiImageError extends Error {
  constructor(message, code = 'unknown') {
    super(message);
    this.name = 'AiImageError';
    this.code = code; // not-configured | bad-input | auth | timeout | network | api | no-image
  }
}

/**
 * Generate one marketing image.
 * @param {object} o
 * @param {object} o.config          the resolved config.ai block { apiKey, model, endpoint, timeoutMs }
 * @param {string} o.prompt          what to make (campaign-seeded copy describing the scene)
 * @param {?string} [o.referenceBase64] optional reference photo, base64 (no data: prefix)
 * @param {string} [o.referenceMime]  the reference's MIME type
 * @param {function} [o.fetchImpl]    injected for tests; defaults to global fetch
 * @returns {Promise<{ base64: string, mimeType: string }>} the generated image
 */
export async function generateMarketingImage({ config, prompt, referenceBase64 = null, referenceMime = 'image/jpeg', fetchImpl = fetch } = {}) {
  const { apiKey, model = 'gemini-3-pro-image-preview', endpoint = 'https://generativelanguage.googleapis.com/v1beta', timeoutMs = 60000 } = config ?? {};
  if (!apiKey) throw new AiImageError('No AI API key is configured (set ai.apiKey in config.json).', 'not-configured');
  if (!prompt || !String(prompt).trim()) throw new AiImageError('A prompt is required to generate an image.', 'bad-input');

  // A reference image is optional at the adapter level (text-to-image also works), but the studio
  // flow always supplies one — the operator uploads it and Nano Banana reimagines it.
  const parts = [{ text: String(prompt) }];
  if (referenceBase64) parts.push({ inlineData: { mimeType: referenceMime, data: referenceBase64 } });

  const url = `${String(endpoint).replace(/\/+$/, '')}/models/${encodeURIComponent(model)}:generateContent`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE'] } }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new AiImageError(`Could not reach the image API: ${err.message}`, err.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const code = res.status === 401 || res.status === 403 ? 'auth' : 'api';
    throw new AiImageError(`Image API returned ${res.status}. ${detail.slice(0, 300)}`, code);
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new AiImageError(`Image API returned an unreadable response: ${err.message}`, 'api');
  }
  // The generated image comes back as an inlineData part on the first candidate.
  const part = body?.candidates?.[0]?.content?.parts?.find((p) => p?.inlineData?.data);
  if (!part) {
    // A safety block or an all-text response lands here; surface the model's own note when present.
    const note = body?.candidates?.[0]?.content?.parts?.find((p) => p?.text)?.text || body?.promptFeedback?.blockReason || '';
    throw new AiImageError(`The image API returned no image.${note ? ` (${String(note).slice(0, 200)})` : ''}`, 'no-image');
  }
  return { base64: part.inlineData.data, mimeType: part.inlineData.mimeType || 'image/png' };
}
