// The initial Creative Studio template families (pure data). Each is a real layered composition —
// not the reference ad pasted flat — rebuilt from the Fotomalovánky ad language (paper-wash, crayon
// doodles, wordmark lockup, headline pill with one highlighted word). Boxes are PERCENTAGES of the
// canvas; per-format overrides (`formats.<fmt>.box`) re-lay-out for each ratio so a format change
// preserves hierarchy rather than stretching. renderStudioHtml.js turns one of these + copy + assets
// into the ad; templateModel.js validates it. Adding a family: see docs/creative-studio.md.
//
// Colour themes are a SECONDARY styling option (template.theme), never the primary creative choice —
// the primary axis is the family (angle + composition), per the brief.

// The signature amber washi-tape (brandKit `tape`) that anchors every photo/product card — the flat
// crayon/scribble doodles that read as "AI clip-art" were retired in favour of this one tactile motif.
const TAPE = '#F5C24B';

/** A concept's seed copy — meaningful defaults so a fresh template renders something real, not lorem. */
export const SEED_COPY = Object.freeze({
  promena: { headline: 'Omalovánky z', headlineHi: 'vašich fotek', support: 'Z vaší fotky uděláme omalovánku na míru.', cta: 'Vytvořit omalovánku', badge: 'Originální dárek' },
  'emotivni-darek': { headline: 'Dárek, který', headlineHi: 'potěší', support: 'Osobní omalovánka z vaší nejmilejší fotky.', cta: 'Objednat dárek', badge: 'Dárek na míru' },
  'spolecne-vybarvovani': { headline: 'Společné chvíle u', headlineHi: 'vybarvování', support: 'Zábava pro celou rodinu — vaše vlastní omalovánky.', cta: 'Vyzkoušet', badge: null },
  'produktova-ukazka': { headline: 'Vaše fotky jako', headlineHi: 'kniha', support: 'Tištěná omalovánková kniha z vašich vzpomínek.', cta: 'Prohlédnout', badge: null },
  'reference-zakaznika': { headline: 'Co říkají', headlineHi: 'zákazníci', support: '', cta: 'Objednat také', testimonial: '„Nádherný dárek, babička měla slzy v očích.“', testimonialAuthor: '— Jana N.' },
});

// ---- 1. Proměna (flagship before → after: taped cards + orange arrow) -------
// David's favourite "sourozenci" ad, rebuilt as a layered template: the original photo (a taped,
// tilted polaroid) and the finished omalovánka (a tilted page in a thick black keyline) joined by a
// hand-drawn orange arrow, over a solid brand-violet ground, with a white headline card + logo lockup
// along the bottom. Reflows: feed = photo top-left / coloring bottom-right / arrow between / card band
// bottom; story = vertical stack photo · card · coloring (arrow dropped); landscape = coloring left /
// photo right / arrow between / bottom strip. Photo is ALWAYS the "before", coloring the "after".
const PROMENA = {
  id: 'promena',
  family: 'Proměna',
  name: 'Proměna — fotka → omalovánka',
  explanation: 'Vlajková reklama: nalepená fotka a hotová omalovánka spojené oranžovou šipkou, dole bílá karta s nadpisem a logem.',
  theme: 'grape',
  supportedFormats: ['feed', 'story', 'landscape', 'portrait'],
  requiresCta: false,
  elements: [
    { id: 'bg', type: 'background', layer: 0, box: { x: 0, y: 0, w: 100, h: 100 } },
    // BEFORE — the customer photo, a taped tilted polaroid (white frame + shadow).
    {
      id: 'before',
      type: 'image',
      slot: 'original',
      placeholder: 'původní fotka',
      layer: 4,
      box: { x: 4, y: 6, w: 48, h: 40 },
      style: { frame: true, pad: 20, radius: 12, rotate: -4 },
      constraints: { required: true, allowedAssetType: 'original' },
      formats: {
        story: { box: { x: 13, y: 6, w: 74, h: 30 }, style: { frame: true, pad: 22, radius: 14, rotate: -3 } },
        landscape: { box: { x: 52, y: 10, w: 43, h: 60 }, style: { frame: true, pad: 14, radius: 10, rotate: 3 } },
        portrait: { box: { x: 4, y: 5, w: 52, h: 34 } },
      },
    },
    { id: 'before-tape', type: 'decoration', name: 'tape', color: '#F5C24B', layer: 5, box: { x: 22, y: 0, w: 8, h: 13 }, style: { rotate: -8 }, formats: { story: { box: { x: 45, y: 1, w: 8, h: 8 }, style: { rotate: -4 } }, landscape: { box: { x: 69, y: 2, w: 6, h: 12 }, style: { rotate: 7 } }, portrait: { box: { x: 22, y: 0, w: 9, h: 11 } } } },
    // AFTER — the finished omalovánka, a tilted page in a thick black keyline (printed-page border).
    {
      id: 'after',
      type: 'image',
      slot: 'coloring',
      placeholder: 'omalovánka',
      layer: 6,
      box: { x: 45, y: 22, w: 52, h: 42 },
      style: { border: '12px solid #17171A', radius: 6, rotate: 3 },
      constraints: { required: true, allowedAssetType: 'coloring' },
      formats: {
        story: { box: { x: 13, y: 60, w: 74, h: 32 }, style: { border: '12px solid #17171A', radius: 8, rotate: 2 } },
        landscape: { box: { x: 5, y: 10, w: 42, h: 60 }, style: { border: '11px solid #17171A', radius: 6, rotate: -3 } },
        portrait: { box: { x: 44, y: 20, w: 54, h: 37 } },
      },
    },
    { id: 'after-tape', type: 'decoration', name: 'tape', color: '#F5C24B', layer: 7, box: { x: 66, y: 12, w: 8, h: 13 }, style: { rotate: 7 }, formats: { story: { box: { x: 45, y: 51, w: 8, h: 8 }, style: { rotate: 5 } }, landscape: { box: { x: 23, y: 2, w: 6, h: 12 }, style: { rotate: -6 } }, portrait: { box: { x: 66, y: 11, w: 8, h: 11 } } } },
    // The orange before→after arrow — feed + landscape only (a vertical story stack reads without it).
    { id: 'arrow', type: 'decoration', name: 'arrow', color: '#F59E0B', layer: 8, box: { x: 39, y: 39, w: 23, h: 22 }, formats: { story: { hidden: true }, landscape: { box: { x: 44, y: 28, w: 13, h: 30 }, style: { rotate: 12 } }, portrait: { box: { x: 38, y: 35, w: 24, h: 21 } } } },
    // Bottom white headline card.
    { id: 'card', type: 'panel', layer: 9, box: { x: 8, y: 67, w: 84, h: 26 }, style: { radius: 40 }, formats: { story: { box: { x: 8, y: 40, w: 84, h: 17 }, style: { radius: 44 } }, landscape: { box: { x: 0, y: 74, w: 100, h: 26 }, style: { radius: 0 } }, portrait: { box: { x: 8, y: 63, w: 84, h: 30 } } } },
    { id: 'headline', type: 'text', field: 'headline', hiField: 'headlineHi', layer: 10, box: { x: 12, y: 70, w: 76, h: 12 }, style: { fontSize: 54, align: 'left', valign: 'center', fontWeight: 700 }, constraints: { maxChars: 44, maxLines: 2 }, formats: { story: { box: { x: 11, y: 41, w: 78, h: 9 }, style: { fontSize: 64, align: 'center' } }, landscape: { box: { x: 5, y: 79, w: 56, h: 9 }, style: { fontSize: 36, align: 'left' } }, portrait: { box: { x: 12, y: 66, w: 76, h: 11 }, style: { fontSize: 50 } } } },
    { id: 'logo', type: 'logo', layer: 11, box: { x: 12, y: 82, w: 34, h: 9 }, style: { align: 'flex-start' }, constraints: { minW: 20 }, formats: { story: { box: { x: 33, y: 50, w: 34, h: 5 }, style: { align: 'center' } }, landscape: { box: { x: 64, y: 78, w: 30, h: 14 }, style: { align: 'flex-start' } }, portrait: { box: { x: 12, y: 79, w: 34, h: 9 } } } },
  ],
};

// ---- 2. Emotivní dárek (lifestyle gift moment + product) --------------------
// Solid terracotta ground; the lifestyle photo fills the top (or the right, in landscape) and a white
// card carries the headline/support/CTA below — a magazine gift page, not a gradient stock ad. The
// product sits on the seam, held by a strip of the signature tape.
const EMOTIVNI = {
  id: 'emotivni-darek',
  family: 'Emotivní dárek',
  name: 'Emotivní dárek — lifestyle + produkt',
  explanation: 'Emoce obdarování: lifestyle fotka příjemce/okamžiku, podpořená produktem a osobním sdělením.',
  theme: 'terracotta',
  supportedFormats: ['feed', 'story', 'landscape'],
  requiresCta: true,
  elements: [
    { id: 'bg', type: 'background', layer: 0, box: { x: 0, y: 0, w: 100, h: 100 } },
    { id: 'hero', type: 'image', slot: 'lifestyle', placeholder: 'lifestyle fotka', layer: 1, box: { x: 0, y: 0, w: 100, h: 58 }, style: { radius: 0 }, constraints: { required: true, allowedAssetType: 'lifestyle' }, formats: { story: { box: { x: 0, y: 0, w: 100, h: 52 } }, landscape: { box: { x: 46, y: 0, w: 54, h: 100 } } } },
    // White card that carries the text block (so it reads on the solid ground).
    { id: 'textcard', type: 'panel', layer: 2, box: { x: 4, y: 57, w: 92, h: 41 }, style: { radius: 40 }, formats: { story: { box: { x: 4, y: 54, w: 92, h: 35 }, style: { radius: 44 } }, landscape: { box: { x: 0, y: 0, w: 46, h: 100 }, style: { radius: 0 } } } },
    { id: 'logo', type: 'logo', layer: 5, box: { x: 6, y: 4, w: 36, h: 8 }, style: { align: 'flex-start' }, constraints: { minW: 20 }, formats: { story: { box: { x: 9, y: 4, w: 36, h: 8 } }, landscape: { box: { x: 5, y: 8, w: 30, h: 13 } } } },
    { id: 'product', type: 'image', slot: 'product', placeholder: 'produkt', layer: 8, box: { x: 62, y: 44, w: 30, h: 30 }, style: { frame: true, rotate: 6 }, formats: { story: { box: { x: 62, y: 40, w: 32, h: 22 } }, landscape: { box: { x: 6, y: 62, w: 20, h: 32 }, style: { frame: true, rotate: -4 } } } },
    { id: 'product-tape', type: 'decoration', name: 'tape', color: TAPE, layer: 9, box: { x: 64, y: 41, w: 9, h: 12 }, style: { rotate: -8 }, formats: { story: { box: { x: 64, y: 37, w: 9, h: 9 }, style: { rotate: -5 } }, landscape: { box: { x: 7, y: 59, w: 7, h: 11 }, style: { rotate: 6 } } } },
    { id: 'headline', type: 'text', field: 'headline', hiField: 'headlineHi', layer: 10, box: { x: 6, y: 62, w: 60, h: 16 }, style: { fontSize: 60, align: 'left', valign: 'top' }, constraints: { maxChars: 40, maxLines: 2 }, formats: { story: { box: { x: 9, y: 58, w: 70, h: 14 }, style: { fontSize: 72, align: 'left' } }, landscape: { box: { x: 5, y: 24, w: 40, h: 26 }, style: { fontSize: 44, align: 'left' } } } },
    { id: 'support', type: 'text', field: 'support', layer: 10, box: { x: 6, y: 78, w: 56, h: 10 }, style: { fontSize: 27, align: 'left', color: '#5C534B', valign: 'top' }, constraints: { maxChars: 90, maxLines: 2 }, formats: { story: { box: { x: 9, y: 72, w: 70, h: 9 }, style: { fontSize: 32, align: 'left', color: '#5C534B' } }, landscape: { box: { x: 5, y: 50, w: 40, h: 14 }, style: { fontSize: 26, align: 'left', color: '#5C534B' } } } },
    { id: 'cta', type: 'cta', field: 'cta', layer: 11, box: { x: 6, y: 88, w: 40, h: 6 }, style: { align: 'left', fontSize: 28 }, constraints: { maxChars: 28 }, formats: { story: { box: { x: 9, y: 82, w: 50, h: 6 }, style: { align: 'left', fontSize: 32 } }, landscape: { box: { x: 5, y: 79, w: 30, h: 12 }, style: { align: 'left', fontSize: 26 } } } },
  ],
};

// ---- 3. Společné vybarvování (family/couple using the book) -----------------
// Solid meadow ground; the shared photo sits on a white card held by a tape strip, headline on a white
// pill below — the togetherness moment framed like a kept photo, not floated on a wash.
const SPOLECNE = {
  id: 'spolecne-vybarvovani',
  family: 'Společné vybarvování',
  name: 'Společné vybarvování — rodinná aktivita',
  explanation: 'Rodina, pár nebo rodič s dítětem u společného vybarvování — produkt jako sdílený zážitek.',
  theme: 'meadow',
  supportedFormats: ['feed', 'story', 'landscape'],
  requiresCta: true,
  elements: [
    { id: 'bg', type: 'background', layer: 0, box: { x: 0, y: 0, w: 100, h: 100 } },
    { id: 'card', type: 'panel', layer: 4, box: { x: 8, y: 20, w: 84, h: 52 }, formats: { story: { box: { x: 8, y: 16, w: 84, h: 56 } }, landscape: { box: { x: 44, y: 10, w: 52, h: 80 } } } },
    { id: 'hero', type: 'image', slot: 'lifestyle', placeholder: 'společná fotka', layer: 5, box: { x: 10, y: 22, w: 80, h: 48 }, style: { radius: 20 }, constraints: { required: true, allowedAssetType: 'lifestyle' }, formats: { story: { box: { x: 10, y: 18, w: 80, h: 52 } }, landscape: { box: { x: 46, y: 12, w: 48, h: 76 } } } },
    { id: 'hero-tape', type: 'decoration', name: 'tape', color: TAPE, layer: 6, box: { x: 46, y: 17, w: 9, h: 12 }, style: { rotate: -6 }, formats: { story: { box: { x: 46, y: 13, w: 9, h: 11 } }, landscape: { box: { x: 66, y: 8, w: 7, h: 12 }, style: { rotate: 5 } } } },
    { id: 'logo', type: 'logo', layer: 6, box: { x: 30, y: 6, w: 40, h: 8 }, constraints: { minW: 20 }, formats: { landscape: { box: { x: 5, y: 10, w: 32, h: 14 }, style: { align: 'flex-start' } } } },
    { id: 'headline', type: 'text', field: 'headline', hiField: 'headlineHi', layer: 10, box: { x: 8, y: 75, w: 84, h: 13 }, style: { pill: true, fontSize: 52, align: 'center' }, constraints: { maxChars: 42, maxLines: 2 }, formats: { story: { box: { x: 9, y: 76, w: 82, h: 12 }, style: { pill: true, fontSize: 66 } }, landscape: { box: { x: 5, y: 30, w: 40, h: 34 }, style: { pill: true, fontSize: 38, align: 'left' } } } },
    { id: 'cta', type: 'cta', field: 'cta', layer: 11, box: { x: 33, y: 88, w: 34, h: 6 }, style: { fontSize: 27 }, constraints: { maxChars: 26 }, formats: { story: { box: { x: 30, y: 90, w: 40, h: 5 } }, landscape: { box: { x: 5, y: 70, w: 26, h: 12 }, style: { align: 'left' } } } },
  ],
};

// ---- 4. Produktová ukázka (clean product showcase) -------------------------
// Deliberately the calmest layout: a light sand ground (dark text reads directly on it, no card), the
// product held by one tape strip, minimal copy. Editorial, uncluttered — lets the product be the ad.
const PRODUKT = {
  id: 'produktova-ukazka',
  family: 'Produktová ukázka',
  name: 'Produktová ukázka — kniha a stránky',
  explanation: 'Čistá prezentace produktu: obálka / otevřená kniha / stránky, bez odvádění pozornosti.',
  theme: 'sand',
  supportedFormats: ['feed', 'story', 'landscape'],
  requiresCta: true,
  elements: [
    { id: 'bg', type: 'background', layer: 0, box: { x: 0, y: 0, w: 100, h: 100 } },
    { id: 'logo', type: 'logo', layer: 5, box: { x: 30, y: 7, w: 40, h: 8 }, constraints: { minW: 20 }, formats: { landscape: { box: { x: 5, y: 10, w: 32, h: 14 }, style: { align: 'flex-start' } } } },
    { id: 'product', type: 'image', slot: 'product', placeholder: 'produkt (kniha)', layer: 6, box: { x: 16, y: 22, w: 68, h: 46 }, style: { frame: true }, constraints: { required: true, allowedAssetType: 'product' }, formats: { story: { box: { x: 12, y: 20, w: 76, h: 46 } }, landscape: { box: { x: 48, y: 12, w: 48, h: 76 }, style: { frame: true } } } },
    { id: 'product-tape', type: 'decoration', name: 'tape', color: TAPE, layer: 7, box: { x: 47, y: 18, w: 9, h: 12 }, style: { rotate: 6 }, formats: { story: { box: { x: 49, y: 16, w: 9, h: 11 } }, landscape: { box: { x: 68, y: 8, w: 7, h: 12 }, style: { rotate: -5 } } } },
    { id: 'headline', type: 'text', field: 'headline', hiField: 'headlineHi', layer: 10, box: { x: 10, y: 72, w: 80, h: 12 }, style: { fontSize: 54, align: 'center' }, constraints: { maxChars: 40, maxLines: 2 }, formats: { story: { box: { x: 9, y: 70, w: 82, h: 12 }, style: { fontSize: 68 } }, landscape: { box: { x: 5, y: 30, w: 40, h: 30 }, style: { fontSize: 42, align: 'left' } } } },
    { id: 'support', type: 'text', field: 'support', layer: 10, box: { x: 12, y: 82, w: 76, h: 7 }, style: { fontSize: 26, align: 'center', color: '#5C534B' }, constraints: { maxChars: 80, maxLines: 2 }, formats: { landscape: { box: { x: 5, y: 55, w: 40, h: 12 }, style: { fontSize: 24, align: 'left', color: '#5C534B' } } } },
    { id: 'cta', type: 'cta', field: 'cta', layer: 11, box: { x: 33, y: 89, w: 34, h: 5 }, style: { fontSize: 27 }, constraints: { maxChars: 26 }, formats: { landscape: { box: { x: 5, y: 72, w: 26, h: 12 }, style: { align: 'left' } } } },
  ],
};

// ---- 5. Reference zákazníka (testimonial) ----------------------------------
// Solid denim ground; the customer photo and the product sit as two taped cards, the real review on a
// white pill, author in a light tint that reads on the ground. No fabricated review — excluded from
// the auto-mix — and no clip-art crayon.
const REFERENCE = {
  id: 'reference-zakaznika',
  family: 'Reference zákazníka',
  name: 'Reference zákazníka — recenze + produkt',
  explanation: 'Skutečná recenze zákazníka s produktem a podpůrnou fotkou. Recenzi nikdy nevymýšlíme.',
  theme: 'denim',
  supportedFormats: ['feed', 'story', 'landscape'],
  requiresCta: false,
  elements: [
    { id: 'bg', type: 'background', layer: 0, box: { x: 0, y: 0, w: 100, h: 100 } },
    { id: 'logo', type: 'logo', layer: 5, box: { x: 30, y: 6, w: 40, h: 8 }, constraints: { minW: 20 }, formats: { landscape: { box: { x: 5, y: 9, w: 30, h: 13 }, style: { align: 'flex-start' } } } },
    { id: 'photo', type: 'image', slot: 'lifestyle', placeholder: 'fotka zákazníka', layer: 6, box: { x: 12, y: 20, w: 40, h: 36 }, style: { frame: true, rotate: -4 }, constraints: { allowedAssetType: 'lifestyle' }, formats: { story: { box: { x: 10, y: 16, w: 44, h: 30 } }, landscape: { box: { x: 4, y: 26, w: 26, h: 60 }, style: { frame: true } } } },
    { id: 'photo-tape', type: 'decoration', name: 'tape', color: TAPE, layer: 8, box: { x: 26, y: 16, w: 8, h: 11 }, style: { rotate: -8 }, formats: { story: { box: { x: 24, y: 12, w: 8, h: 9 } }, landscape: { box: { x: 12, y: 22, w: 6, h: 11 }, style: { rotate: 4 } } } },
    { id: 'product', type: 'image', slot: 'product', placeholder: 'produkt', layer: 7, box: { x: 52, y: 24, w: 36, h: 30 }, style: { frame: true, rotate: 5 }, formats: { story: { box: { x: 52, y: 18, w: 38, h: 26 } }, landscape: { box: { x: 68, y: 26, w: 28, h: 60 }, style: { frame: true, rotate: 4 } } } },
    { id: 'product-tape', type: 'decoration', name: 'tape', color: TAPE, layer: 9, box: { x: 66, y: 20, w: 8, h: 11 }, style: { rotate: 7 }, formats: { story: { box: { x: 66, y: 14, w: 8, h: 9 } }, landscape: { box: { x: 78, y: 22, w: 6, h: 11 }, style: { rotate: -6 } } } },
    { id: 'quote', type: 'text', field: 'testimonial', layer: 10, box: { x: 10, y: 60, w: 80, h: 20 }, style: { pill: true, fontSize: 40, align: 'center' }, constraints: { required: true, maxChars: 140, maxLines: 4 }, formats: { story: { box: { x: 9, y: 52, w: 82, h: 20 }, style: { pill: true, fontSize: 48 } }, landscape: { box: { x: 32, y: 30, w: 34, h: 40 }, style: { pill: true, fontSize: 34 } } } },
    { id: 'author', type: 'text', field: 'testimonialAuthor', layer: 10, box: { x: 10, y: 82, w: 80, h: 6 }, style: { fontSize: 26, align: 'center', color: '#EAF1F8' }, constraints: { maxChars: 40 }, formats: { landscape: { box: { x: 32, y: 72, w: 34, h: 8 }, style: { fontSize: 24, align: 'center', color: '#EAF1F8' } } } },
  ],
};

export const TEMPLATES = Object.freeze({
  [PROMENA.id]: PROMENA,
  [EMOTIVNI.id]: EMOTIVNI,
  [SPOLECNE.id]: SPOLECNE,
  [PRODUKT.id]: PRODUKT,
  [REFERENCE.id]: REFERENCE,
});

/** The image slots a template actually uses (deduped, in first-seen order) — drives the asset picker. */
export function templateSlots(template) {
  const seen = [];
  for (const el of template.elements) if (el.type === 'image' && el.slot && !seen.includes(el.slot)) seen.push(el.slot);
  return seen;
}

/** The copy fields a template actually binds — drives the Texty step. */
export function templateFields(template) {
  const seen = [];
  for (const el of template.elements) {
    for (const f of [el.field, el.hiField]) if (f && !seen.includes(f)) seen.push(f);
  }
  return seen;
}

/** field -> maxChars (from the bound element's constraints), for the editor's live character counter. */
export function templateFieldLimits(template) {
  const limits = {};
  for (const el of template.elements) {
    if (el.field && el.constraints?.maxChars) limits[el.field] = el.constraints.maxChars;
  }
  return limits;
}

export function getTemplate(id) {
  return TEMPLATES[id] ?? null;
}

/** The picker list for the UI: id, family, name, formats, the slots + fields it needs, and its theme. */
export function listTemplates() {
  return Object.values(TEMPLATES).map((t) => ({
    id: t.id,
    family: t.family,
    name: t.name,
    explanation: t.explanation,
    theme: t.theme,
    supportedFormats: t.supportedFormats,
    requiresCta: t.requiresCta,
    slots: templateSlots(t),
    fields: templateFields(t),
    limits: templateFieldLimits(t),
    seedCopy: SEED_COPY[t.id] ?? {},
  }));
}
