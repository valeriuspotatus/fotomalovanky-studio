/**
 * Fotomalovánky – Pencils cover layout (baked default + shared stamp helpers)
 *
 * Single source of truth for every pencils-cover layout value. The render
 * code in app.js reads this object (via currentCoverLayout()) and stamps
 * inline mm/deg styles at DOM creation — only for the pencils cover variant.
 * The classic variant is driven purely by styles.css and never reads this.
 *
 * The stamp* helpers at the bottom of this file (outside the literal) are
 * the single definition of those inline-style formulas, shared by app.js's
 * create path and tuning.js's live-apply path — this file loads before both
 * (see index.html script order).
 *
 * Adoption path: an exported layout JSON from the tuning overlay pastes
 * verbatim as the object literal below (after `const COVER_LAYOUT =`) —
 * the helpers live outside the const, so pasting is unaffected.
 */

const COVER_LAYOUT = {
    version: 1,

    // Baked default = the operator's tuned layout, adopted verbatim from
    // FEEDBACK/cover-layout-4.json (mm schema, 4th tuning iteration).

    // Crayon decorations around the page edges.
    // side: horizontal anchor edge ('left' | 'right'); offset: mm from that
    // edge; top: mm; width: mm; rotation: deg; flipX mirrors horizontally
    // (composes as `scaleX(-1) rotate(...)`, mirror first).
    pencils: {
        blue:   { side: 'left',  offset: 23,   top: 66.7,  width: 30,   rotation: 15.5, flipX: false },
        red:    { side: 'right', offset: 24.6, top: 28.1,  width: 23.6, rotation: -20,  flipX: false },
        green:  { side: 'left',  offset: 28.3, top: 242.5, width: 31.2, rotation: 99.5, flipX: true },
        yellow: { side: 'right', offset: 14.1, top: 240.3, width: 29.1, rotation: -8.5, flipX: false }
    },

    // Scribble stains behind each pair image, keyed "<pairRow>-<side>"
    // (rows 0/1, sides photo/svg). Single-pair books use row 0's two entries.
    //  - corner:  which corner of the OWN image box the stain's offsets are
    //             measured from (relative placement tracks the image wherever
    //             it lands). Stains are free-positioned — the corner is a
    //             reference frame, not a cage; the tuning overlay re-anchors
    //             to the nearest corner on drag end so offsets stay small,
    //             which is what generalizes across books' image sizes.
    //  - widthMm: stain width in mm — ABSOLUTE, so a stain prints the same
    //             physical size no matter how large the auto-fitted image
    //             box came out (a % of a wide landscape box used to explode)
    //  - dxMm/dyMm: offset of the stain's anchored corner from the image's
    //             same corner, in mm — NEGATIVE bleeds outward beyond the
    //             image edge onto the white page
    //  - aspect:  the PNG's intrinsic width/height ratio (asset property, not
    //             a tunable) — height always derives as width / aspect, so the
    //             artwork can never deform
    // Converted from the operator's tuned % export against the rendered
    // boxes of his reference order (untitled, 2 pairs): row 0 photo
    // 48.6×86.5mm / svg 49.4×86.5mm, row 1 photo 81.5×61.1mm / svg
    // 78.5×61.1mm (mm = % × box dimension, rounded to 0.1).
    stains: {
        '0-photo': { corner: 'top-left',     widthMm: 67.6, dxMm: -17,   dyMm: -13,   aspect: 1.031 },
        '0-svg':   { corner: 'top-right',    widthMm: 63.4, dxMm: -14,   dyMm: -9.2,  aspect: 0.943 },
        '1-photo': { corner: 'bottom-left',  widthMm: 59.9, dxMm: -11,   dyMm: -21,   aspect: 0.930 },
        '1-svg':   { corner: 'bottom-right', widthMm: 63.7, dxMm: -11.6, dyMm: -14.7, aspect: 0.966 }
    },

    // Photo + coloring pair frame parameters.
    frame: {
        areaW: 149,              // mm — available width (leaves room for the
                                 //     crayons and the stains' outward bleed)
        areaHTitled: 170,        // mm — available height when a title is present
        areaHUntitled: 200,      // mm — available height with no title
        titleLineReduction: 10,  // mm removed from areaHTitled per extra title line
        rowGap: 8,               // mm between pair rows
        overlapFrac: 0.14,       // svg overlaps photo by this fraction of svg width
        dyFrac: 0.11,            // svg shifted down by this fraction of image height
        scale: 100               // % — default pair scale; the cover-scale slider
                                 //     multiplies on top of this
    },

    // Logo. width/margins in mm; height always derives as
    // width / aspectRatio[variant] (never measured from the image).
    logo: {
        variant: 'vertical',     // 'vertical' (logo.svg) | 'horizontal' (logo-horizontal.svg)
        width: 73.9,
        marginTop: 9.1,
        marginBottom: 7,
        aspectRatio: {
            vertical: 403 / 200,   // logo.svg viewBox 0 0 403 200
            horizontal: 605 / 143  // logo-horizontal.svg viewBox 0 0 605 143
        }
    },

    // Dashed dedication/title box. marginTop/marginBottom in mm, maxWidth in %.
    // Applied as inline styles only when set (non-null).
    titleBox: {
        marginTop: 0.3,
        marginBottom: 1,
        maxWidth: 82.3
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// Shared inline-stamp helpers — the single definition of the pencils-cover
// style formulas. app.js calls them at DOM creation (createTitlePage /
// createPencilPairItem); tuning.js calls them from its live-apply path
// (applyPencil / applyStain / applyLogo / applyTitleBox), which for pencils
// IS the render path (pencil edits never re-render). The removeProperty
// calls only matter when re-stamping an existing element whose anchor side
// changed; on freshly created elements they are no-ops.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pencil: mm geometry anchored to one horizontal edge (left XOR right),
 * plus rotation. Mirror composes before rotation — matches the original
 * CSS `scaleX(-1) rotate(...)` order.
 */
function stampPencil(el, p) {
    el.style.removeProperty(p.side === 'right' ? 'left' : 'right');
    el.style[p.side === 'right' ? 'right' : 'left'] = `${p.offset}mm`;
    el.style.top = `${p.top}mm`;
    el.style.width = `${p.width}mm`;
    el.style.transform = `${p.flipX ? 'scaleX(-1) ' : ''}rotate(${p.rotation}deg)`;
}

/**
 * Stain: absolute mm width (universal — the same physical size on every
 * cover, like the pencils); height always derives from the PNG's intrinsic
 * aspect ratio (CSS aspect-ratio, height auto) so the artwork never deforms.
 * Anchored to one corner of the item box via the two matching inset
 * properties (dxMm/dyMm in mm, negative bleeds outward); the opposite two
 * are removed for corner re-stamps.
 */
function stampStain(el, s) {
    const corner = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
        .includes(s.corner) ? s.corner : 'top-left';
    const [vSide, hSide] = corner.split('-');
    el.style.width = `${s.widthMm}mm`;
    el.style.removeProperty('height');
    el.style.aspectRatio = String(s.aspect);
    el.style.removeProperty(hSide === 'left' ? 'right' : 'left');
    el.style.removeProperty(vSide === 'top' ? 'bottom' : 'top');
    el.style[hSide] = `${s.dxMm}mm`;
    el.style[vSide] = `${s.dyMm}mm`;
}

/**
 * Logo: width/margins in mm. The variant (src) swap is create-path-only —
 * tuning.js's live path deliberately leaves src alone (needs a re-render).
 */
function stampLogo(el, l) {
    el.style.width = `${l.width}mm`;
    el.style.marginTop = `${l.marginTop}mm`;
    el.style.marginBottom = `${l.marginBottom}mm`;
}

/**
 * Title box: optional overrides of the shared .title-dedication CSS —
 * applied only when set (non-null); seeds match the CSS values.
 */
function stampTitleBox(el, tb) {
    if (tb.marginTop != null) el.style.marginTop = `${tb.marginTop}mm`;
    if (tb.marginBottom != null) el.style.marginBottom = `${tb.marginBottom}mm`;
    if (tb.maxWidth != null) el.style.maxWidth = `${tb.maxWidth}%`;
}
