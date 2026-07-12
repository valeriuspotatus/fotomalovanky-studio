// The Fotomalovánky brand kit for the Creative Studio (pure): the palette, the paper-wash
// backgrounds, and the hand-drawn decoration atoms (crayons, scribble, sun, sparkles) plus the
// drawn logo/wordmark fallback. Templates reference these by name so the app — not the AI — draws
// every brand element, sharp and on-brand, at export resolution. Lifted from the original
// creativeTemplate.js so the look carries over; no IO, no network.

export const BRAND = Object.freeze({
  ink: '#2A2622',
  paper: '#FBF7F0',
  hues: Object.freeze(['#F1543F', '#F5A623', '#22A06B', '#3B82F6']), // coral, amber, green, blue
  accent: '#F1543F',
});

/** Named pastel washes. `accent` tints highlighted words / CTAs sitting on the wash. */
export const THEMES = Object.freeze({
  rainbow: { bg: 'linear-gradient(120deg,#DDF3E3 0%,#FBF2D6 32%,#FDE4D4 64%,#FBD9E7 100%)', accent: '#22A06B' },
  sunset: { bg: 'linear-gradient(120deg,#FCDDEA 0%,#FDE6D6 50%,#FBEFD4 100%)', accent: '#F1543F' },
  sky: { bg: 'linear-gradient(120deg,#E4F0FB 0%,#EAF6EE 52%,#FBE8F0 100%)', accent: '#3B82F6' },
  cream: { bg: 'linear-gradient(160deg,#FDF6EC 0%,#FBEFE0 100%)', accent: '#F5A623' },
  forest: { bg: 'linear-gradient(150deg,#E7F3E9 0%,#F3F7E4 100%)', accent: '#22A06B' },
});

export function themeDef(theme) {
  return THEMES[theme] ?? THEMES.rainbow;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** "FOTOMALOVÁNKY" with each letter cycling the brand hues (the drawn-logo fallback wordmark). */
export function wordmark() {
  return [...'FOTOMALOVÁNKY'].map((ch, i) => `<span style="color:${BRAND.hues[i % BRAND.hues.length]}">${esc(ch)}</span>`).join('');
}

/** A small hand-drawn "photo + pencil" logo mark (fallback when no real logo asset is supplied). */
export function logoMark() {
  return `<svg viewBox="0 0 82 74" fill="none" stroke="#2A2622" stroke-width="3.4" stroke-linejoin="round" stroke-linecap="round" style="width:100%;height:auto">
    <rect x="7" y="10" width="50" height="52" rx="4" transform="rotate(-6 32 36)" fill="#fff"/>
    <circle cx="31" cy="31" r="6.5" fill="none"/><path d="M20 52a12 12 0 0 1 23 0" transform="rotate(-6 32 36)"/>
    <path d="M59 13l15 12-9 12-15-12z" fill="#F5A623"/><path d="M50 25l5 4"/>
  </svg>`;
}

function crayon(color) {
  return `<svg viewBox="0 0 64 210" fill="none" stroke="#2A2622" stroke-width="3" stroke-linejoin="round" style="width:100%;height:auto">
    <path d="M14 66 L32 12 L50 66 Z" fill="#FBE9D6"/>
    <rect x="12" y="64" width="40" height="132" rx="9" fill="${color}"/>
    <path d="M12 86 h40 M12 176 h40" stroke="rgba(0,0,0,.18)" stroke-width="9"/>
    <rect x="16" y="196" width="32" height="9" rx="4" fill="#2A2622" stroke="none"/>
  </svg>`;
}

function scribble(color) {
  return `<svg viewBox="0 0 220 140" fill="none" stroke="${color}" stroke-width="15" stroke-linecap="round" opacity=".65" style="width:100%;height:auto">
    <path d="M12 44 q40 -28 70 4 t70 6 q30 20 56 -6 M18 88 q44 -20 74 8 t72 2"/>
  </svg>`;
}

function sun() {
  return `<svg viewBox="0 0 120 120" fill="none" stroke="#F5A623" stroke-width="7" stroke-linecap="round" style="width:100%;height:auto">
    <circle cx="60" cy="60" r="26"/>
    <path d="M60 12v14M60 94v14M12 60h14M94 60h14M26 26l10 10M84 84l10 10M94 26l-10 10M36 84l-10 10"/>
  </svg>`;
}

function sparkle(color) {
  return `<svg viewBox="0 0 60 60" fill="${color}" style="width:100%;height:auto"><path d="M30 2c3 16 10 23 26 28-16 5-23 12-26 28-3-16-10-23-26-28 16-5 23-12 26-28z"/></svg>`;
}

/** A starburst badge disc (the seasonal "Originální dárek" sticker), text supplied by the renderer. */
export function starburst() {
  return `<svg viewBox="0 0 120 120" style="position:absolute;inset:0;width:100%;height:100%;filter:drop-shadow(0 6px 12px rgba(150,95,60,.22))"><path fill="#fff" stroke="#2A2622" stroke-width="2.5" d="M60 4l10 14 16-8 3 18 18 3-8 16 14 10-14 10 8 16-18 3-3 18-16-8-10 14-10-14-16 8-3-18-18-3 8-16L4 60l14-10-8-16 18-3 3-18 16 8z"/></svg>`;
}

/** Draw a named decoration in a colour. Unknown names render nothing (a template typo degrades to
 *  "no doodle", never a broken image). */
export function decoration(name, color = '#3B82F6') {
  switch (name) {
    case 'crayon':
      return crayon(color);
    case 'scribble':
      return scribble(color);
    case 'sun':
      return sun();
    case 'sparkle':
      return sparkle(color);
    default:
      return '';
  }
}
