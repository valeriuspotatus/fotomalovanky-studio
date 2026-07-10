// Fixing a coloring page by hand, without leaving the tool.
//
// The book prints `<base>.svg`. The builder never looks at `<base>_bw.png` — it skips it by name.
// So an editor that paints on the raster would show the operator a fixed page and print the broken
// one. Everything here edits the SVG; the PNG is re-rendered from it afterwards, so the picture
// they review is the picture the customer receives.
//
// A white pencil stroke is a white-filled path laid over the line art, and a crop is a change of
// viewBox. Both keep the page a vector, which is what makes it print at any size.

const SVG_OPEN = /<svg\b[^>]*>/i;
const VIEWBOX = /viewBox\s*=\s*"([^"]*)"/i;

// Bounds, not because an operator would ever draw this much, but because these numbers arrive
// from a browser and end up in a 2 MB file the customer's book is printed from.
const MAX_STROKES = 2000;
const MAX_POINTS = 200_000;
const MIN_CROP = 8; // user units — a crop smaller than this is a misclick, not an intention

export class EditError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditError';
    this.seam = 'editor';
  }
}

const round2 = (v) => Math.round(v * 100) / 100;

function finite(value, what) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new EditError(`${what} is not a number.`);
  return n;
}

/** The page's coordinate system: what a point in the browser means in the file. */
export function svgBox(svg) {
  const open = String(svg).match(SVG_OPEN);
  if (!open) throw new EditError('That coloring page is not an SVG.');

  const vb = open[0].match(VIEWBOX);
  if (vb) {
    const [x, y, w, h] = vb[1].trim().split(/[\s,]+/).map(Number);
    if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) return { x, y, w, h };
  }
  // The generator's pages carry a viewBox and no width/height, but a hand-made SVG may not.
  const attr = (name) => {
    const m = open[0].match(new RegExp(`\\b${name}\\s*=\\s*"([\\d.]+)`, 'i'));
    return m ? Number(m[1]) : NaN;
  };
  const w = attr('width');
  const h = attr('height');
  if (w > 0 && h > 0) return { x: 0, y: 0, w, h };

  throw new EditError('That coloring page has no viewBox and no size, so it cannot be edited.');
}

/** A crop the operator dragged, pinned inside the page they dragged it on. */
export function clampCrop(crop, box) {
  const x = finite(crop.x, 'crop x');
  const y = finite(crop.y, 'crop y');
  const w = finite(crop.w, 'crop width');
  const h = finite(crop.h, 'crop height');
  if (w < MIN_CROP || h < MIN_CROP) throw new EditError('That crop is too small to be a page.');

  const left = Math.max(box.x, Math.min(x, box.x + box.w - MIN_CROP));
  const top = Math.max(box.y, Math.min(y, box.y + box.h - MIN_CROP));
  return {
    x: round2(left),
    y: round2(top),
    w: round2(Math.min(w, box.x + box.w - left)),
    h: round2(Math.min(h, box.y + box.h - top)),
  };
}

function strokePath(stroke, index) {
  const width = finite(stroke?.width, `stroke ${index} width`);
  if (width <= 0) throw new EditError(`Stroke ${index} has no width.`);

  const points = Array.isArray(stroke.points) ? stroke.points : [];
  if (!points.length) return '';

  const xy = points.map((p, i) => [finite(p?.[0], `stroke ${index} point ${i} x`), finite(p?.[1], `stroke ${index} point ${i} y`)]);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'} ${round2(x)} ${round2(y)}`).join(' ');
  // A single click is a dot: a zero-length line with a round cap draws one, an empty path does not.
  const dot = xy.length === 1 ? ` L ${round2(xy[0][0])} ${round2(xy[0][1])}` : '';
  return `<path stroke-width="${round2(width)}" d="${d}${dot}"/>`;
}

function replaceBox(openTag, crop) {
  const vb = `viewBox="${crop.x} ${crop.y} ${crop.w} ${crop.h}"`;
  let tag = VIEWBOX.test(openTag) ? openTag.replace(VIEWBOX, vb) : openTag.replace(/^<svg\b/i, `<svg ${vb}`);
  // Only if they were there to begin with: a width that disagrees with the viewBox squashes the page.
  tag = tag.replace(/\swidth\s*=\s*"[^"]*"/i, ` width="${crop.w}"`);
  tag = tag.replace(/\sheight\s*=\s*"[^"]*"/i, ` height="${crop.h}"`);
  return tag;
}

/** Apply the operator's pencil and crop to the page. Pure: text in, text out.
 *
 *  Strokes are in the coordinate system of the SVG *as given* — the same one the browser measured
 *  them in. Cropping only re-frames that system, so it never moves a stroke off the mark. */
export function applyEdits(svg, { strokes = [], crop = null } = {}) {
  const source = String(svg);
  const box = svgBox(source);

  if (strokes.length > MAX_STROKES) throw new EditError('Too many pencil strokes to save.');
  const points = strokes.reduce((n, s) => n + (Array.isArray(s?.points) ? s.points.length : 0), 0);
  if (points > MAX_POINTS) throw new EditError('Too many pencil strokes to save.');
  if (!strokes.length && !crop) throw new EditError('Nothing was changed.');

  let out = source;

  if (strokes.length) {
    const paths = strokes.map(strokePath).filter(Boolean).join('\n');
    if (paths) {
      // Its own group, with its own paint: dropped at the end of a file whose root <g> says
      // fill="none", an inherited attribute would make every stroke invisible.
      const layer = `<g class="fma-edit" fill="none" stroke="#FFFFFF" stroke-linecap="round" stroke-linejoin="round">\n${paths}\n</g>\n`;
      const close = out.lastIndexOf('</svg>');
      if (close < 0) throw new EditError('That coloring page has no closing </svg>.');
      out = out.slice(0, close) + layer + out.slice(close);
    }
  }

  if (crop) {
    const c = clampCrop(crop, box);
    out = out.replace(SVG_OPEN, (tag) => replaceBox(tag, c));
  }

  return out;
}
