// The initial Creative Studio template families (pure data). Each is a real layered composition —
// not the reference ad pasted flat — rebuilt from the Fotomalovánky ad language (paper-wash, crayon
// doodles, wordmark lockup, headline pill with one highlighted word). Boxes are PERCENTAGES of the
// canvas; per-format overrides (`formats.<fmt>.box`) re-lay-out for each ratio so a format change
// preserves hierarchy rather than stretching. renderStudioHtml.js turns one of these + copy + assets
// into the ad; templateModel.js validates it. Adding a family: see docs/creative-studio.md.
//
// Colour themes are a SECONDARY styling option (template.theme), never the primary creative choice —
// the primary axis is the family (angle + composition), per the brief.

const CRAYON_TL = { id: 'deco-tl', type: 'decoration', name: 'crayon', color: '#3B82F6', layer: 2, box: { x: 2, y: -2, w: 7, h: 22 }, style: { rotate: -16 } };
const CRAYON_TR = { id: 'deco-tr', type: 'decoration', name: 'crayon', color: '#F1543F', layer: 2, box: { x: 88, y: -1, w: 7, h: 22 }, style: { rotate: 20 } };
const SCRIBBLE_BL = { id: 'deco-bl', type: 'decoration', name: 'scribble', color: '#3B82F6', layer: 2, box: { x: -2, y: 82, w: 22, h: 15 } };

/** A concept's seed copy — meaningful defaults so a fresh template renders something real, not lorem. */
export const SEED_COPY = Object.freeze({
  promena: { headline: 'Vzpomínka, která se dá', headlineHi: 'vybarvit', support: 'Z vaší fotky uděláme omalovánku na míru.', cta: 'Vytvořit omalovánku', badge: 'Originální dárek' },
  'emotivni-darek': { headline: 'Dárek, který', headlineHi: 'potěší', support: 'Osobní omalovánka z vaší nejmilejší fotky.', cta: 'Objednat dárek', badge: 'Dárek na míru' },
  'spolecne-vybarvovani': { headline: 'Společné chvíle u', headlineHi: 'vybarvování', support: 'Zábava pro celou rodinu — vaše vlastní omalovánky.', cta: 'Vyzkoušet', badge: null },
  'produktova-ukazka': { headline: 'Vaše fotky jako', headlineHi: 'kniha', support: 'Tištěná omalovánková kniha z vašich vzpomínek.', cta: 'Prohlédnout', badge: null },
  'reference-zakaznika': { headline: 'Co říkají', headlineHi: 'zákazníci', support: '', cta: 'Objednat také', testimonial: '„Nádherný dárek, babička měla slzy v očích.“', testimonialAuthor: '— Jana N.' },
});

// ---- 1. Proměna (before → after transformation) ----------------------------
const PROMENA = {
  id: 'promena',
  family: 'Proměna',
  name: 'Proměna — fotka → omalovánka',
  explanation: 'Jasná proměna: původní fotka vedle hotové omalovánky. Okamžitě vysvětlí, co produkt dělá.',
  theme: 'rainbow',
  supportedFormats: ['feed', 'story', 'landscape'],
  requiresCta: false,
  elements: [
    { id: 'bg', type: 'background', layer: 0, box: { x: 0, y: 0, w: 100, h: 100 } },
    CRAYON_TL,
    CRAYON_TR,
    SCRIBBLE_BL,
    { id: 'logo', type: 'logo', layer: 5, box: { x: 28, y: 6, w: 44, h: 9 }, constraints: { minW: 20 }, formats: { story: { box: { x: 25, y: 5, w: 50, h: 6 } }, landscape: { box: { x: 4, y: 10, w: 32, h: 15 }, style: { align: 'flex-start' } } } },
    { id: 'card', type: 'panel', layer: 6, box: { x: 12, y: 27, w: 76, h: 38 }, formats: { story: { box: { x: 10, y: 24, w: 80, h: 44 } }, landscape: { box: { x: 50, y: 15, w: 46, h: 70 } } } },
    { id: 'before', type: 'image', slot: 'original', placeholder: 'původní fotka', layer: 7, box: { x: 14, y: 29, w: 35, h: 34 }, style: { radius: 18 }, constraints: { required: true, allowedAssetType: 'original' }, formats: { story: { box: { x: 12, y: 26, w: 76, h: 20 } }, landscape: { box: { x: 51.5, y: 18, w: 21.5, h: 64 } } } },
    { id: 'after', type: 'image', slot: 'coloring', placeholder: 'omalovánka', layer: 7, box: { x: 51, y: 29, w: 35, h: 34 }, style: { radius: 18 }, constraints: { required: true, allowedAssetType: 'coloring' }, formats: { story: { box: { x: 12, y: 47, w: 76, h: 20 } }, landscape: { box: { x: 74, y: 18, w: 21.5, h: 64 } } } },
    { id: 'badge', type: 'badge', field: 'badge', layer: 9, box: { x: 71, y: 19, w: 20, h: 20 }, style: { rotate: 8, fontSize: 18 }, constraints: { maxChars: 26 }, formats: { story: { box: { x: 70, y: 17, w: 22, h: 12 } }, landscape: { hidden: true } } },
    { id: 'headline', type: 'text', field: 'headline', hiField: 'headlineHi', layer: 10, box: { x: 13, y: 72, w: 74, h: 16 }, style: { pill: true, fontSize: 58, align: 'center' }, constraints: { maxChars: 44, maxLines: 2 }, formats: { story: { box: { x: 8, y: 73, w: 84, h: 13 }, style: { pill: true, fontSize: 74, align: 'center' } }, landscape: { box: { x: 3, y: 38, w: 42, h: 40 }, style: { pill: true, fontSize: 40, align: 'left' } } } },
  ],
};

// ---- 2. Emotivní dárek (lifestyle gift moment + product) --------------------
const EMOTIVNI = {
  id: 'emotivni-darek',
  family: 'Emotivní dárek',
  name: 'Emotivní dárek — lifestyle + produkt',
  explanation: 'Emoce obdarování: lifestyle fotka příjemce/okamžiku, podpořená produktem a osobním sdělením.',
  theme: 'sunset',
  supportedFormats: ['feed', 'story', 'landscape'],
  requiresCta: true,
  elements: [
    { id: 'bg', type: 'background', layer: 0, box: { x: 0, y: 0, w: 100, h: 100 } },
    { id: 'hero', type: 'image', slot: 'lifestyle', placeholder: 'lifestyle fotka', layer: 1, box: { x: 0, y: 0, w: 100, h: 58 }, style: { radius: 0 }, constraints: { required: true, allowedAssetType: 'lifestyle' }, formats: { story: { box: { x: 0, y: 0, w: 100, h: 52 } }, landscape: { box: { x: 46, y: 0, w: 54, h: 100 } } } },
    { id: 'logo', type: 'logo', layer: 5, box: { x: 6, y: 4, w: 36, h: 8 }, style: { align: 'flex-start' }, constraints: { minW: 20 }, formats: { landscape: { box: { x: 4, y: 8, w: 32, h: 13 } } } },
    { id: 'product', type: 'image', slot: 'product', placeholder: 'produkt', layer: 8, box: { x: 62, y: 44, w: 30, h: 30 }, style: { frame: true, rotate: 6 }, formats: { story: { box: { x: 62, y: 40, w: 32, h: 22 } }, landscape: { box: { x: 4, y: 60, w: 20, h: 34 }, style: { frame: true, rotate: -4 } } } },
    { id: 'headline', type: 'text', field: 'headline', hiField: 'headlineHi', layer: 10, box: { x: 6, y: 62, w: 60, h: 16 }, style: { fontSize: 60, align: 'left', valign: 'top' }, constraints: { maxChars: 40, maxLines: 2 }, formats: { story: { box: { x: 6, y: 58, w: 70, h: 14 }, style: { fontSize: 72, align: 'left' } }, landscape: { box: { x: 4, y: 24, w: 40, h: 26 }, style: { fontSize: 44, align: 'left' } } } },
    { id: 'support', type: 'text', field: 'support', layer: 10, box: { x: 6, y: 78, w: 56, h: 10 }, style: { fontSize: 27, align: 'left', color: '#5C534B', valign: 'top' }, constraints: { maxChars: 90, maxLines: 2 }, formats: { story: { box: { x: 6, y: 72, w: 70, h: 9 }, style: { fontSize: 32, align: 'left', color: '#5C534B' } }, landscape: { box: { x: 4, y: 50, w: 40, h: 14 }, style: { fontSize: 26, align: 'left', color: '#5C534B' } } } },
    { id: 'cta', type: 'cta', field: 'cta', layer: 11, box: { x: 6, y: 89, w: 40, h: 8 }, style: { align: 'left', fontSize: 28 }, constraints: { maxChars: 28 }, formats: { story: { box: { x: 6, y: 88, w: 50, h: 6 }, style: { align: 'left', fontSize: 32 } }, landscape: { box: { x: 4, y: 82, w: 30, h: 12 }, style: { align: 'left', fontSize: 26 } } } },
  ],
};

// ---- 3. Společné vybarvování (family/couple using the book) -----------------
const SPOLECNE = {
  id: 'spolecne-vybarvovani',
  family: 'Společné vybarvování',
  name: 'Společné vybarvování — rodinná aktivita',
  explanation: 'Rodina, pár nebo rodič s dítětem u společného vybarvování — produkt jako sdílený zážitek.',
  theme: 'forest',
  supportedFormats: ['feed', 'story', 'landscape'],
  requiresCta: true,
  elements: [
    { id: 'bg', type: 'background', layer: 0, box: { x: 0, y: 0, w: 100, h: 100 } },
    CRAYON_TR,
    { id: 'card', type: 'panel', layer: 4, box: { x: 8, y: 20, w: 84, h: 52 }, formats: { story: { box: { x: 8, y: 16, w: 84, h: 56 } }, landscape: { box: { x: 44, y: 10, w: 52, h: 80 } } } },
    { id: 'hero', type: 'image', slot: 'lifestyle', placeholder: 'společná fotka', layer: 5, box: { x: 10, y: 22, w: 80, h: 48 }, style: { radius: 20 }, constraints: { required: true, allowedAssetType: 'lifestyle' }, formats: { story: { box: { x: 10, y: 18, w: 80, h: 52 } }, landscape: { box: { x: 46, y: 12, w: 48, h: 76 } } } },
    { id: 'logo', type: 'logo', layer: 6, box: { x: 30, y: 6, w: 40, h: 8 }, constraints: { minW: 20 }, formats: { landscape: { box: { x: 4, y: 10, w: 32, h: 14 }, style: { align: 'flex-start' } } } },
    { id: 'headline', type: 'text', field: 'headline', hiField: 'headlineHi', layer: 10, box: { x: 8, y: 75, w: 84, h: 13 }, style: { pill: true, fontSize: 52, align: 'center' }, constraints: { maxChars: 42, maxLines: 2 }, formats: { story: { box: { x: 8, y: 76, w: 84, h: 12 }, style: { pill: true, fontSize: 66 } }, landscape: { box: { x: 3, y: 30, w: 40, h: 34 }, style: { pill: true, fontSize: 38, align: 'left' } } } },
    { id: 'cta', type: 'cta', field: 'cta', layer: 11, box: { x: 33, y: 90, w: 34, h: 7 }, style: { fontSize: 27 }, constraints: { maxChars: 26 }, formats: { story: { box: { x: 30, y: 90, w: 40, h: 5 } }, landscape: { box: { x: 3, y: 70, w: 26, h: 12 }, style: { align: 'left' } } } },
  ],
};

// ---- 4. Produktová ukázka (clean product showcase) -------------------------
const PRODUKT = {
  id: 'produktova-ukazka',
  family: 'Produktová ukázka',
  name: 'Produktová ukázka — kniha a stránky',
  explanation: 'Čistá prezentace produktu: obálka / otevřená kniha / stránky, bez odvádění pozornosti.',
  theme: 'cream',
  supportedFormats: ['feed', 'story', 'landscape'],
  requiresCta: true,
  elements: [
    { id: 'bg', type: 'background', layer: 0, box: { x: 0, y: 0, w: 100, h: 100 } },
    SCRIBBLE_BL,
    { id: 'logo', type: 'logo', layer: 5, box: { x: 30, y: 7, w: 40, h: 8 }, constraints: { minW: 20 }, formats: { landscape: { box: { x: 4, y: 10, w: 32, h: 14 }, style: { align: 'flex-start' } } } },
    { id: 'product', type: 'image', slot: 'product', placeholder: 'produkt (kniha)', layer: 6, box: { x: 16, y: 22, w: 68, h: 46 }, style: { frame: true }, constraints: { required: true, allowedAssetType: 'product' }, formats: { story: { box: { x: 12, y: 20, w: 76, h: 46 } }, landscape: { box: { x: 48, y: 12, w: 48, h: 76 }, style: { frame: true } } } },
    { id: 'headline', type: 'text', field: 'headline', hiField: 'headlineHi', layer: 10, box: { x: 10, y: 72, w: 80, h: 12 }, style: { fontSize: 54, align: 'center' }, constraints: { maxChars: 40, maxLines: 2 }, formats: { story: { box: { x: 8, y: 70, w: 84, h: 12 }, style: { fontSize: 68 } }, landscape: { box: { x: 4, y: 30, w: 40, h: 30 }, style: { fontSize: 42, align: 'left' } } } },
    { id: 'support', type: 'text', field: 'support', layer: 10, box: { x: 12, y: 83, w: 76, h: 7 }, style: { fontSize: 26, align: 'center', color: '#5C534B' }, constraints: { maxChars: 80, maxLines: 2 }, formats: { landscape: { box: { x: 4, y: 55, w: 40, h: 12 }, style: { fontSize: 24, align: 'left', color: '#5C534B' } } } },
    { id: 'cta', type: 'cta', field: 'cta', layer: 11, box: { x: 33, y: 90, w: 34, h: 7 }, style: { fontSize: 27 }, constraints: { maxChars: 26 }, formats: { landscape: { box: { x: 4, y: 72, w: 26, h: 12 }, style: { align: 'left' } } } },
  ],
};

// ---- 5. Reference zákazníka (testimonial) ----------------------------------
const REFERENCE = {
  id: 'reference-zakaznika',
  family: 'Reference zákazníka',
  name: 'Reference zákazníka — recenze + produkt',
  explanation: 'Skutečná recenze zákazníka s produktem a podpůrnou fotkou. Recenzi nikdy nevymýšlíme.',
  theme: 'sky',
  supportedFormats: ['feed', 'story', 'landscape'],
  requiresCta: false,
  elements: [
    { id: 'bg', type: 'background', layer: 0, box: { x: 0, y: 0, w: 100, h: 100 } },
    CRAYON_TL,
    { id: 'logo', type: 'logo', layer: 5, box: { x: 30, y: 6, w: 40, h: 8 }, constraints: { minW: 20 }, formats: { landscape: { box: { x: 4, y: 9, w: 30, h: 13 }, style: { align: 'flex-start' } } } },
    { id: 'photo', type: 'image', slot: 'lifestyle', placeholder: 'fotka zákazníka', layer: 6, box: { x: 12, y: 20, w: 40, h: 36 }, style: { frame: true, rotate: -4 }, constraints: { allowedAssetType: 'lifestyle' }, formats: { story: { box: { x: 10, y: 16, w: 44, h: 30 } }, landscape: { box: { x: 4, y: 26, w: 26, h: 60 }, style: { frame: true } } } },
    { id: 'product', type: 'image', slot: 'product', placeholder: 'produkt', layer: 7, box: { x: 52, y: 24, w: 36, h: 30 }, style: { frame: true, rotate: 5 }, formats: { story: { box: { x: 52, y: 18, w: 38, h: 26 } }, landscape: { box: { x: 68, y: 26, w: 28, h: 60 }, style: { frame: true, rotate: 4 } } } },
    { id: 'quote', type: 'text', field: 'testimonial', layer: 10, box: { x: 10, y: 60, w: 80, h: 20 }, style: { pill: true, fontSize: 40, align: 'center' }, constraints: { required: true, maxChars: 140, maxLines: 4 }, formats: { story: { box: { x: 8, y: 52, w: 84, h: 20 }, style: { pill: true, fontSize: 48 } }, landscape: { box: { x: 32, y: 30, w: 34, h: 40 }, style: { pill: true, fontSize: 34 } } } },
    { id: 'author', type: 'text', field: 'testimonialAuthor', layer: 10, box: { x: 10, y: 82, w: 80, h: 6 }, style: { fontSize: 26, align: 'center', color: '#5C534B' }, constraints: { maxChars: 40 }, formats: { landscape: { box: { x: 32, y: 72, w: 34, h: 8 }, style: { fontSize: 24, align: 'center', color: '#5C534B' } } } },
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
