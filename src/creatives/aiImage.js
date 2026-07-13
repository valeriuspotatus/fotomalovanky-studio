// The Kreativy AI image seam: Google's Gemini ("Nano Banana Pro" for images). Two operations, both
// thin adapters over fetch and injectable for tests:
//   generateMarketingImage — text (+ optional reference) -> a brand-new synthetic image (base64)
//   describeImage          — a photo -> a short, IDENTITY-FREE scene prompt (text)
//
// The privacy design (David, 2026-07-12): the operator uploads a customer photo, describeImage turns
// it into a generic marketing scene description with NO faces/identity, and generateMarketingImage
// then makes a fresh image from that TEXT ALONE — the customer photo is never sent to the image model,
// so no pixel of it can reach the output. The key is billable and lives only in gitignored config.json.

const ENDPOINT_DEFAULT = 'https://generativelanguage.googleapis.com/v1beta';

export class AiImageError extends Error {
  constructor(message, code = 'unknown') {
    super(message);
    this.name = 'AiImageError';
    this.code = code; // not-configured | bad-input | auth | timeout | network | api | no-image
  }
}

/** The default instruction describeImage sends with the photo. Tuned so the returned prompt can never
 *  reproduce a real person, place, brand, or pet — only the mood/setting/activity. Overridable via
 *  config.ai.describeInstruction. */
export const DESCRIBE_INSTRUCTION = [
  'You are writing a prompt for an AI image generator to create marketing imagery for a company that',
  'turns family photos into printable coloring pages. Look at the attached photo and write ONE vivid',
  'image-generation prompt (2–4 sentences, in English) for a brand-new, synthetic marketing photo',
  'inspired only by the general mood, setting, activity, colours and lighting.',
  '',
  'STRICT PRIVACY RULES — the generated image must never resemble a real person:',
  "- Do NOT describe or reference any individual's face, facial features, hairstyle, skin tone, exact",
  '  age, body, tattoos, clothing logos, visible text, or anything that could identify a real person,',
  '  place, brand, or pet.',
  '- Refer to people only in generic terms ("a parent and a young child", "a small child", "a family")',
  '  with no distinguishing detail.',
  '- Focus on the warm scene, emotion, environment, props, season, and photographic style.',
  '',
  'Return ONLY the prompt text — no preamble, quotes, or explanation.',
].join('\n');

/** Gemini overload (503 "high demand"), rate-limit (429) and transient 500s are the API telling you
 *  to come back in a moment — retryable, unlike a 4xx that will fail identically forever. */
const RETRYABLE_STATUS = new Set([429, 500, 503]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The one low-level POST to Gemini generateContent. Injectable fetch; all HTTP/transport error
 *  classification lives here so both operations share it. Retries transient overload/rate-limit with
 *  exponential backoff so a temporary 503 spike self-heals instead of surfacing to the operator.
 *  Returns the parsed JSON body. */
async function callGemini({ apiKey, endpoint = ENDPOINT_DEFAULT, model, parts, generationConfig = null, timeoutMs = 60000, fetchImpl = fetch, maxRetries = 3, backoffBaseMs = 1500 }) {
  const url = `${String(endpoint).replace(/\/+$/, '')}/models/${encodeURIComponent(model)}:generateContent`;
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents: [{ parts }], ...(generationConfig ? { generationConfig } : {}) }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new AiImageError(`Could not reach the image API: ${err.message}`, err.name === 'AbortError' ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
        await sleep(backoffBaseMs * 2 ** attempt); // 1.5s, 3s, 6s
        continue;
      }
      const code = res.status === 401 || res.status === 403 ? 'auth' : 'api';
      const hint = res.status === 503 ? ' Model je přetížený — zkuste to prosím za chvíli znovu.' : '';
      throw new AiImageError(`Image API returned ${res.status}.${hint} ${detail.slice(0, 300)}`, code);
    }
    try {
      return await res.json();
    } catch (err) {
      throw new AiImageError(`Image API returned an unreadable response: ${err.message}`, 'api');
    }
  }
}

/**
 * Generate one marketing image.
 * @param {object} o
 * @param {object} o.config          the resolved config.ai block { apiKey, model, endpoint, timeoutMs }
 * @param {string} o.prompt          what to make (campaign-seeded or auto-described copy)
 * @param {?string} [o.referenceBase64] optional reference photo, base64 (no data: prefix)
 * @param {string} [o.referenceMime]  the reference's MIME type
 * @param {function} [o.fetchImpl]    injected for tests; defaults to global fetch
 * @returns {Promise<{ base64: string, mimeType: string }>} the generated image
 */
export async function generateMarketingImage({ config, prompt, referenceBase64 = null, referenceMime = 'image/jpeg', fetchImpl = fetch } = {}) {
  // Image gen is the slow call — use imageTimeoutMs (longer) when present, not the shared describe timeout.
  const { apiKey, model = 'gemini-3-pro-image-preview', endpoint = ENDPOINT_DEFAULT, timeoutMs = 60000, imageTimeoutMs, maxRetries = 3, backoffBaseMs = 1500 } = config ?? {};
  const imageTimeout = Number.isInteger(imageTimeoutMs) && imageTimeoutMs > 0 ? imageTimeoutMs : timeoutMs;
  if (!apiKey) throw new AiImageError('No AI API key is configured (set ai.apiKey in config.json).', 'not-configured');
  if (!prompt || !String(prompt).trim()) throw new AiImageError('A prompt is required to generate an image.', 'bad-input');

  // A reference image is optional at the adapter level (text-to-image also works); the describe->generate
  // flow deliberately passes none, so the customer photo never reaches the image model.
  const parts = [{ text: String(prompt) }];
  if (referenceBase64) parts.push({ inlineData: { mimeType: referenceMime, data: referenceBase64 } });

  const body = await callGemini({ apiKey, endpoint, model, parts, generationConfig: { responseModalities: ['IMAGE'] }, timeoutMs: imageTimeout, fetchImpl, maxRetries, backoffBaseMs });
  const part = body?.candidates?.[0]?.content?.parts?.find((p) => p?.inlineData?.data);
  if (!part) {
    const note = body?.candidates?.[0]?.content?.parts?.find((p) => p?.text)?.text || body?.promptFeedback?.blockReason || '';
    throw new AiImageError(`The image API returned no image.${note ? ` (${String(note).slice(0, 200)})` : ''}`, 'no-image');
  }
  return { base64: part.inlineData.data, mimeType: part.inlineData.mimeType || 'image/png' };
}

/**
 * Describe a photo into a short, identity-free marketing scene prompt (text). The photo IS sent to
 * Gemini here (the vision step), but only text comes back — the caller then generates from that text.
 * @param {object} o
 * @param {object} o.config           the resolved config.ai block { apiKey, describeModel, endpoint, timeoutMs, describeInstruction }
 * @param {string} o.referenceBase64  the photo to describe, base64 (no data: prefix)
 * @param {string} [o.referenceMime]  its MIME type
 * @param {string} [o.instruction]    override the default privacy instruction
 * @param {function} [o.fetchImpl]    injected for tests
 * @returns {Promise<string>} the generated identity-free prompt
 */
export async function describeImage({ config, referenceBase64, referenceMime = 'image/jpeg', instruction, fetchImpl = fetch } = {}) {
  const { apiKey, describeModel = 'gemini-flash-latest', endpoint = ENDPOINT_DEFAULT, timeoutMs = 60000, describeInstruction, maxRetries = 3, backoffBaseMs = 1500 } = config ?? {};
  if (!apiKey) throw new AiImageError('No AI API key is configured (set ai.apiKey in config.json).', 'not-configured');
  if (!referenceBase64) throw new AiImageError('A reference photo is required to describe.', 'bad-input');

  const parts = [
    { text: instruction || describeInstruction || DESCRIBE_INSTRUCTION },
    { inlineData: { mimeType: referenceMime, data: referenceBase64 } },
  ];
  const body = await callGemini({ apiKey, endpoint, model: describeModel, parts, generationConfig: null, timeoutMs, fetchImpl, maxRetries, backoffBaseMs });
  const text = (body?.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p?.text)
    .filter(Boolean)
    .join(' ')
    .trim();
  if (!text) {
    const note = body?.promptFeedback?.blockReason || '';
    throw new AiImageError(`The description step returned no text.${note ? ` (${String(note).slice(0, 200)})` : ''}`, 'no-image');
  }
  return text;
}
