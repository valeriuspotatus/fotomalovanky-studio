// The deterministic layered renderer (pure): a template + a format + the campaign copy + the chosen
// assets -> ONE self-contained HTML document. renderCreative.js screenshots it to PNG with the same
// headless Chromium the PDF builder uses, so the on-screen preview and the exported file are the same
// pixels. The app places every element from the template's geometry; the AI never assembles the ad.
//
// No IO, no network: images arrive as ready `src` strings (data: URIs or file URLs), the logo as a
// data URI in `brand.logoSrc`. Fonts follow the app's rounded display stack (Fredoka not self-hosted
// yet — a known limitation; Chromium falls back to a rounded system face, identical preview<->export).

import { formatDef } from './formats.js';
import { resolveTemplate, boxToPx, textForElement } from './templateModel.js';
import { BRAND, themeDef, esc, wordmark, logoMark, starburst, decoration } from './brandKit.js';

/** A labelled placeholder for an empty image slot, so an unfinished concept reads clearly rather
 *  than showing a broken image. */
function placeholder(label, kind) {
  const bg = kind === 'coloring' ? '#fff' : 'repeating-linear-gradient(45deg,#F3ECE4,#F3ECE4 14px,#EDE3D8 14px,#EDE3D8 28px)';
  return `<div class="ph" style="background:${bg}"><span>${esc(label)}</span></div>`;
}

function renderImage(el, assets, px) {
  const src = assets[el.slot];
  const fit = el.style?.fit ?? 'cover';
  const focus = el.style?.focus ?? 'center';
  const inner = src
    ? `<img src="${esc(src)}" alt="" style="width:100%;height:100%;object-fit:${esc(fit)};object-position:${esc(focus)};display:block">`
    : placeholder(el.placeholder ?? el.slot, el.slot);
  return inner;
}

function renderText(el, copy, accent) {
  const text = textForElement(el, copy);
  const hi = el.hiField && copy[el.hiField] ? esc(copy[el.hiField]) : el.hi ? esc(el.hi) : '';
  const body = hi ? `${esc(text)} <span class="hi">${hi}</span>` : esc(text);
  return body;
}

/** Build the full ad document. `brand.logoSrc` is the real logo (falls back to the drawn mark);
 *  `brand.accent` overrides the theme accent. */
export function renderStudioHtml({ template, format = 'feed', copy = {}, assets = {}, brand = {} } = {}) {
  const F = formatDef(format);
  const theme = themeDef(template.theme);
  const accent = brand.accent ?? theme.accent;
  const elements = resolveTemplate(template, format);

  const layers = elements
    .map((el, i) => {
      const px = boxToPx(el.box, format);
      const rot = el.style?.rotate ? `transform:rotate(${el.style.rotate}deg);` : '';
      const base = `position:absolute;left:${px.x}px;top:${px.y}px;width:${px.w}px;height:${px.h}px;z-index:${i + 1};${rot}`;

      if (el.type === 'background') {
        const fill = el.style?.fill ?? theme.bg;
        return `<div style="position:absolute;inset:0;z-index:${i + 1};background:${fill}"></div>`;
      }

      if (el.type === 'panel') {
        const s = el.style || {};
        return `<div style="${base}background:${s.fill ?? '#fff'};border-radius:${s.radius ?? 30}px;box-shadow:${s.shadow ?? '0 26px 64px rgba(150,95,60,.20)'};${s.border ? `border:${s.border};` : ''}"></div>`;
      }

      if (el.type === 'image') {
        const s = el.style || {};
        const frame = s.frame
          ? `background:#fff;padding:${s.pad ?? 16}px;border-radius:${s.radius ?? 26}px;box-shadow:${s.shadow ?? '0 24px 60px rgba(150,95,60,.20)'};`
          : `border-radius:${s.radius ?? 0}px;overflow:hidden;`;
        const border = s.border ? `border:${s.border};` : '';
        return `<div style="${base}${frame}${border}box-sizing:border-box"><div style="width:100%;height:100%;overflow:hidden;border-radius:${(el.style?.innerRadius ?? el.style?.radius ?? 14)}px">${renderImage(el, assets, px)}</div></div>`;
      }

      if (el.type === 'text') {
        const s = el.style || {};
        const pill = s.pill ? `background:${s.pillColor ?? '#fff'};border-radius:${s.radius ?? 30}px;box-shadow:${s.shadow ?? '0 18px 44px rgba(150,95,60,.16)'};` : '';
        const pad = s.pad ?? (s.pill ? 26 : 0);
        const align = s.align ?? 'center';
        const justify = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
        const valign = s.valign === 'top' ? 'flex-start' : s.valign === 'bottom' ? 'flex-end' : 'center';
        return `<div style="${base}display:flex;align-items:${valign};justify-content:${justify}">
          <div style="${pill}padding:${pad}px;text-align:${align};font-size:${s.fontSize ?? 44}px;font-weight:${s.fontWeight ?? 600};line-height:${s.lineHeight ?? 1.12};color:${s.color ?? BRAND.ink};max-width:100%">${renderText(el, copy, accent)}</div>
        </div>`;
      }

      if (el.type === 'cta') {
        const s = el.style || {};
        const text = textForElement(el, copy);
        if (!text.trim()) return '';
        return `<div style="${base}display:flex;align-items:center;justify-content:${s.align === 'left' ? 'flex-start' : 'center'}">
          <div style="background:${s.bg ?? accent};color:${s.color ?? '#fff'};font-weight:${s.fontWeight ?? 700};font-size:${s.fontSize ?? 30}px;padding:${s.pad ?? '16px 34px'};border-radius:${s.radius ?? 999}px;box-shadow:0 14px 30px rgba(0,0,0,.14)">${esc(text)}</div>
        </div>`;
      }

      if (el.type === 'badge') {
        const s = el.style || {};
        const text = textForElement(el, copy);
        if (!text.trim()) return '';
        return `<div style="${base}display:flex;align-items:center;justify-content:center;text-align:center">
          ${starburst()}
          <span style="position:relative;font-weight:600;font-size:${s.fontSize ?? 19}px;line-height:1.14;padding:0 ${s.pad ?? 30}px;color:${BRAND.ink}">${esc(text)}</span>
        </div>`;
      }

      if (el.type === 'logo') {
        const inner = brand.logoSrc
          ? `<img src="${esc(brand.logoSrc)}" alt="Fotomalovánky" style="width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 3px 0 rgba(255,255,255,.55))">`
          : `<div style="display:flex;flex-direction:column;align-items:${el.style?.align ?? 'center'};gap:10px;height:100%;justify-content:center">
              <div style="width:38%">${logoMark()}</div>
              <div style="font-weight:600;letter-spacing:.5px;font-size:${el.style?.fontSize ?? 46}px;line-height:1;text-shadow:0 2px 0 rgba(255,255,255,.55)">${wordmark()}</div>
            </div>`;
        return `<div style="${base}">${inner}</div>`;
      }

      if (el.type === 'decoration') {
        return `<div style="${base}pointer-events:none">${decoration(el.name, el.color ?? accent)}</div>`;
      }

      return '';
    })
    .join('\n    ');

  return `<!doctype html><html lang="cs"><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${F.w}px;height:${F.h}px;overflow:hidden}
  .stage{position:relative;width:${F.w}px;height:${F.h}px;overflow:hidden;background:${theme.bg};
    font-family:"Fredoka","Baloo 2",ui-rounded,"Segoe UI",system-ui,sans-serif;color:${BRAND.ink}}
  .hi{color:${accent};background:linear-gradient(180deg,transparent 56%,${accent}30 56%,${accent}30 94%,transparent 94%);border-radius:4px;padding:0 .1em;white-space:nowrap}
  .ph{width:100%;height:100%;display:flex;align-items:flex-end;justify-content:center;padding-bottom:18px;
    font-size:16px;font-weight:600;color:#B8A99A;text-transform:uppercase;letter-spacing:.06em}
</style></head><body>
  <div class="stage">
    ${layers}
  </div>
</body></html>`;
}
