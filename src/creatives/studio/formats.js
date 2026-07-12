// The Creative Studio output formats. Each is a real ad canvas with its own pixel size, aspect
// label, and a safe-zone inset (px) that text/logo/CTA should stay inside. A format change is NOT a
// stretch of one canvas: templates carry per-format layout overrides (see templateModel.js), so the
// same concept re-lays-out for each ratio while preserving hierarchy, readability and safe zones.
//
// Pure data, no IO — imported by the model, the renderer, the validator and the server alike.

export const STUDIO_FORMATS = Object.freeze({
  feed: { key: 'feed', w: 1080, h: 1080, label: 'Feed 1:1', ratio: '1:1', safe: 64 },
  story: { key: 'story', w: 1080, h: 1920, label: 'Story 9:16', ratio: '9:16', safe: 96 },
  landscape: { key: 'landscape', w: 1200, h: 628, label: 'Landscape 1.91:1', ratio: '1.91:1', safe: 56 },
  portrait: { key: 'portrait', w: 1080, h: 1350, label: 'Feed 4:5', ratio: '4:5', safe: 64 },
});

/** The formats we ship layout for today. `portrait` (4:5) is defined above so the architecture is
 *  ready for it, but templates aren't required to support it yet. */
export const DEFAULT_FORMATS = Object.freeze(['feed', 'story', 'landscape']);

export function formatDef(format) {
  const F = STUDIO_FORMATS[format];
  if (!F) throw new Error(`Unknown format "${format}". Known: ${Object.keys(STUDIO_FORMATS).join(', ')}.`);
  return F;
}

export function isFormat(format) {
  return Object.prototype.hasOwnProperty.call(STUDIO_FORMATS, format);
}
