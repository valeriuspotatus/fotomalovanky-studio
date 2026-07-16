/**
 * Fotomalovánky – Pencils cover tuning overlay (hidden operator tool)
 *
 * Summoned with Cmd/Ctrl+Alt+T when a pencils title page is rendered.
 * Lets the operator select the cover decorations on the live page — the
 * four crayons, the four scribble stains, the logo, and the title box —
 * and drag / corner-resize / (pencils only) rotate them with live mm/deg
 * values, plus a slim fixed panel for exact numeric editing and the
 * pair-frame parameters. All tuned state lives in Tuning.sessionLayout
 * (a deep clone of COVER_LAYOUT from cover-layout.js) — app.js's
 * currentCoverLayout() picks it up, so every full re-render (title
 * keystroke, scale slider) uses the tuned values automatically. Element
 * references are never held across renders; targets are re-acquired by
 * data-tune-id in sync(), the hook app.js calls at the end of
 * renderPages().
 *
 * Update paths:
 *  - Pencils: inline mm/deg stamping only (applyPencil) — never re-renders.
 *  - Stains / logo / title box: live inline stamping during a gesture for
 *    feedback, then a scoped title-page re-render (app.js's
 *    rerenderTitlePage()) reconciles, because their geometry is
 *    render-computed (flex flow, fit clamp).
 *  - Frame parameters: scoped title-page re-render, rAF-coalesced — the
 *    gallery pages are never rebuilt by the panel.
 *
 * Inert until the chord fires: the only side effect at load time is one
 * keydown listener. Overlay chrome (layer + panel) mounts on document.body
 * — nothing is ever created inside .a4-page, and @media print rules hide
 * both as belt-and-braces.
 *
 * Alternatives (bottom panel section): three in-memory snapshot slots
 * (A/B/C — letter loads, the small save sub-button snapshots; lost on
 * reload), JSON export (downloads cover-layout.json, paste-adoptable as
 * the COVER_LAYOUT literal in cover-layout.js), and JSON import
 * (validated, deep-merged onto a fresh baked default — a failed import
 * never touches the session).
 */

(function () {
    // The summon chord: Cmd/Ctrl + Alt + T. e.code is used because Alt
    // remaps e.key on macOS (Alt+T types '†').
    const TUNING_CHORD = { code: 'KeyT', altKey: true, metaOrCtrlKey: true };

    const NUDGE_MM = 0.5;           // arrow-key nudge step (mm)
    const NUDGE_SHIFT_MM = 2;       // with Shift held
    const MIN_PENCIL_WIDTH_MM = 5;  // resize floors
    const MIN_LOGO_WIDTH_MM = 20;
    const MIN_STAIN_WIDTH_MM = 10;
    const MAX_STAIN_WIDTH_MM = 120;  // panel bound — resize gesture is unclamped above the floor
    // Panel bounds for stain dxMm/dyMm — deliberately wide: stains are
    // free-positioned anywhere relative to their image, the corner is only
    // the reference frame the offsets are measured from (drag/nudge paths
    // are unclamped; drag end re-anchors to the nearest corner)
    const STAIN_OFFSET_MIN_MM = -150;
    const STAIN_OFFSET_MAX_MM = 150;
    const MIN_TITLE_MAXW_PCT = 10;
    const STAIN_CORNERS = [
        ['top-left', 'TL'], ['top-right', 'TR'],
        ['bottom-left', 'BL'], ['bottom-right', 'BR']
    ];

    // Overlay chrome, created lazily on first open
    let layer = null;    // fixed layer aligned to the .a4-page rect
    let selBox = null;   // dashed selection box (rotated with the element)
    let readout = null;  // live value label under the selection

    // Slim value panel, fixed to the right edge, sibling of the layer
    let panel = null;
    let selFields = null;        // Selection section body, rebuilt per target
    let panelSelId;              // selectedId the Selection fields were built for
    let staticRefreshers = [];   // field/value refreshers for always-on sections
    let selRefreshers = [];      // refreshers for the current Selection fields

    let gesture = null;  // active drag/resize/rotate state, null when idle
    let gestureMoveRaf = 0;      // rAF handle throttling gesture mousemoves
    let pendingMoveEvent = null; // latest unprocessed mousemove during a gesture
    let viewportRaf = 0; // rAF handle throttling scroll/resize realignment
    let rerenderRaf = 0; // rAF handle coalescing scoped title-page re-renders

    // Alternatives state — snapshot slots are in-memory only (lost on
    // reload); each filled slot holds a deep clone of sessionLayout taken
    // at save time. activeSlot is indicated only while the session still
    // deep-equals the slot's stored clone (see slotIndicated).
    const SLOT_KEYS = ['A', 'B', 'C'];
    const slots = { A: null, B: null, C: null };
    let activeSlot = null;
    let importInput = null;  // hidden <input type=file> behind the Import button
    let statusEl = null;     // brief status line in the Alternatives section
    let statusTimer = 0;     // auto-clear timeout for statusEl

    // ═══════════════════════════════════════════════════════════════════════
    // Public API (window.Tuning)
    // ═══════════════════════════════════════════════════════════════════════

    const Tuning = {
        // Deep clone of COVER_LAYOUT, created on first open and kept for the
        // whole session (also while the overlay is closed) — the tuned state.
        // app.js reads it via currentCoverLayout().
        sessionLayout: null,

        isOpen: false,
        selectedId: null,  // data-tune-id of the selected element, or null

        // Called after selection changes, after every gesture/nudge value
        // change, and at the end of every sync. The panel wires this to its
        // field refresh (see ensurePanel).
        onChange: null,

        toggle() {
            if (this.isOpen) this.close();
            else this.open();
        },

        open() {
            if (this.isOpen) return;
            if (!getContent()) {
                console.info('Tuning: no rendered pencils title page — overlay not opened');
                return;
            }
            if (!this.sessionLayout) this.sessionLayout = structuredClone(COVER_LAYOUT);
            ensureLayer();
            ensurePanel();
            this.isOpen = true;
            this.selectedId = null;
            layer.style.display = 'block';
            panel.style.display = 'flex';
            window.addEventListener('scroll', onViewportChange, true);
            window.addEventListener('resize', onViewportChange);
            window.addEventListener('blur', onWindowBlur);
            this.sync();
        },

        close() {
            if (!this.isOpen) return;
            this.isOpen = false;
            cancelGestureMove(); // mid-gesture close discards the pending move
            endGesture();
            window.removeEventListener('scroll', onViewportChange, true);
            window.removeEventListener('resize', onViewportChange);
            window.removeEventListener('blur', onWindowBlur);
            if (viewportRaf) {
                cancelAnimationFrame(viewportRaf);
                viewportRaf = 0;
            }
            this.deselect();
            if (layer) layer.style.display = 'none';
            if (panel) panel.style.display = 'none';
            // Flush (not cancel) a pending scoped re-render: a mid-gesture
            // close relies on it to reconcile live-stamped inline styles
            // (flow position and the fit clamp are render-computed), and a
            // just-made panel edit's re-render must still reach the page.
            // sync() inside it no-ops now that isOpen is false.
            if (rerenderRaf) {
                cancelAnimationFrame(rerenderRaf);
                rerenderRaf = 0;
                if (typeof window.rerenderTitlePage === 'function') window.rerenderTitlePage();
            }
            // sessionLayout intentionally survives — tuned state persists
            // until page reload; reopening resumes where the operator left off
        },

        /**
         * Post-render hook, called by app.js at the end of renderPages()
         * (including its empty-state early return) and rerenderTitlePage().
         * No-op while closed. Auto-closes when the pencils title page
         * disappeared (variant switch, photos removed); otherwise realigns
         * the layer, re-acquires the selected target by data-tune-id, and
         * refreshes the panel (title presence may have changed).
         */
        sync() {
            if (!this.isOpen) return;
            // A render replaced the page nodes, so an active gesture's cached
            // geometry (el, rects, px-per-mm) is stale — abort it cleanly
            // before targets are re-acquired (a disconnected gesture.el makes
            // the flush discard its pending move, see handleGestureMove)
            if (gesture) endGesture();
            if (!getContent()) {
                this.close();
                return;
            }
            this.refreshSelection();
            notify();
        },

        select(tuneId) {
            this.selectedId = tuneId;
            this.refreshSelection();
            notify();
        },

        deselect() {
            if (this.selectedId === null) return;
            this.selectedId = null;
            this.refreshSelection();
            notify();
        },

        /**
         * Stamp any target's sessionLayout values onto its rendered element.
         * For pencils this IS the render path; for stains/logo/title box it
         * is live feedback only — a scoped re-render reconciles afterwards
         * (scheduleRerender), because flow position and the fit clamp are
         * render-computed.
         */
        applyElement(tuneId) {
            const kind = targetKind(tuneId);
            if (kind === 'pencil') applyPencil(pencilColorOf(tuneId));
            else if (kind === 'stain') applyStain(tuneId);
            else if (kind === 'logo') applyLogo();
            else if (kind === 'titleBox') applyTitleBox();
        },

        /**
         * Realign the layer to the page rect and reposition the selection
         * chrome from sessionLayout / live rects. Everything is recomputed
         * from getBoundingClientRect() — nothing cached across calls.
         */
        refreshSelection() {
            if (!layer) return;
            const g = geometry();
            if (!g) return;
            alignLayer(g);
            const id = this.selectedId;
            const r = id ? targetRect(id, g) : null;
            if (!r) {
                if (this.selectedId) this.selectedId = null; // target vanished
                selBox.style.display = 'none';
                readout.style.display = 'none';
                return;
            }
            const kind = targetKind(id);
            selBox.style.display = 'block';
            // Only pencils rotate — hide the rotate handle elsewhere
            selBox.classList.toggle('tuning-no-rotate', kind !== 'pencil');
            selBox.style.left = `${r.left - g.pageRect.left}px`;
            selBox.style.top = `${r.top - g.pageRect.top}px`;
            selBox.style.width = `${r.w}px`;
            selBox.style.height = `${r.h}px`;
            selBox.style.transform = `rotate(${r.angle}deg)`;

            // Readout sits below the rotated bounding circle, unrotated
            const halfDiag = Math.hypot(r.w, r.h) / 2;
            readout.style.display = 'block';
            readout.style.left = `${r.cx - g.pageRect.left}px`;
            readout.style.top = `${r.cy - g.pageRect.top + halfDiag + 8}px`;
            readout.textContent = readoutText(id, kind);
        }
    };

    // ═══════════════════════════════════════════════════════════════════════
    // Geometry — all client-space, all derived fresh from live rects
    // ═══════════════════════════════════════════════════════════════════════

    function getContent() {
        return pagesContainer.querySelector('.title-page-pencils');
    }

    function getTarget(tuneId) {
        // During a gesture the target element is a per-gesture invariant
        // (gestures never trigger a render, so it can't be replaced);
        // outside one, targets are always re-acquired by data-tune-id.
        if (gesture && gesture.id === tuneId && gesture.el && gesture.el.isConnected) {
            return gesture.el;
        }
        return pagesContainer.querySelector(`[data-tune-id="${tuneId}"]`);
    }

    function geometry() {
        const content = getContent();
        if (!content) return null;
        const page = content.closest('.a4-page');
        if (!page) return null;
        const pageRect = page.getBoundingClientRect();
        if (pageRect.width <= 0) return null;
        return {
            content,
            pageRect,
            contentRect: content.getBoundingClientRect(),
            s: pageRect.width / A4.width // px-per-mm
        };
    }

    function alignLayer(g) {
        layer.style.left = `${g.pageRect.left}px`;
        layer.style.top = `${g.pageRect.top}px`;
        layer.style.width = `${g.pageRect.width}px`;
        layer.style.height = `${g.pageRect.height}px`;
    }

    /** Target kind from a data-tune-id, or null for unknown ids. */
    function targetKind(id) {
        if (!id) return null;
        if (id.startsWith('pencil-')) return 'pencil';
        if (id.startsWith('stain-')) return 'stain';
        if (id === 'logo') return 'logo';
        if (id === 'title-box') return 'titleBox';
        return null;
    }

    /** Pencil color from its tune-id ('pencil-blue' → 'blue'). */
    function pencilColorOf(id) {
        return id.slice('pencil-'.length);
    }

    /** Stain key from its tune-id ('stain-0-photo' → '0-photo'). */
    function stainKeyOf(id) {
        return id.slice('stain-'.length);
    }

    /** The sessionLayout entry a tune-id edits, or null. */
    function layoutEntry(id) {
        const L = Tuning.sessionLayout;
        if (!L) return null;
        const kind = targetKind(id);
        if (kind === 'pencil') return L.pencils[pencilColorOf(id)] || null;
        if (kind === 'stain') return L.stains[stainKeyOf(id)] || null;
        if (kind === 'logo') return L.logo;
        if (kind === 'titleBox') return L.titleBox;
        return null;
    }

    /**
     * Unrotated client-space rect of a pencil, computed from sessionLayout
     * mm values × live px-per-mm. Height derives from the element's layout
     * aspect ratio (offsetWidth/offsetHeight ignore transforms). `angle` is
     * the visual rotation: scaleX(-1) rotate(θ) renders like rotate(-θ) on
     * a mirrored (visually identical) rectangle, so flipX negates it.
     */
    function pencilRect(color, g) {
        const p = Tuning.sessionLayout.pencils[color];
        const el = getTarget(`pencil-${color}`);
        if (!p || !el) return null;
        const w = p.width * g.s;
        // The layout aspect ratio is a per-gesture invariant, cached at
        // gesture start; outside a gesture it is re-read from the element
        const aspect = (gesture && gesture.id === `pencil-${color}` && gesture.aspect != null)
            ? gesture.aspect
            : (el.offsetWidth > 0 ? el.offsetHeight / el.offsetWidth : 1);
        const h = w * aspect;
        const left = p.side === 'right'
            ? g.contentRect.right - (p.offset + p.width) * g.s
            : g.contentRect.left + p.offset * g.s;
        const top = g.contentRect.top + p.top * g.s;
        return {
            left, top, w, h,
            cx: left + w / 2,
            cy: top + h / 2,
            angle: (p.flipX ? -1 : 1) * p.rotation
        };
    }

    /**
     * Client-space rect of any target. Pencils get the mm-derived rotated
     * rect; stains, logo, and title box are render-computed, so their live
     * getBoundingClientRect() is authoritative (the title box's -2deg CSS
     * tilt is folded into its AABB — angle stays 0 for the chrome).
     */
    function targetRect(id, g) {
        const kind = targetKind(id);
        if (kind === 'pencil') return pencilRect(pencilColorOf(id), g);
        if (!layoutEntry(id)) return null;
        const el = getTarget(id);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        if (b.width <= 0) return null;
        return {
            left: b.left, top: b.top, w: b.width, h: b.height,
            cx: b.left + b.width / 2,
            cy: b.top + b.height / 2,
            angle: 0
        };
    }

    /** Selection as {id, kind, entry}, or null when nothing valid selected. */
    function selectedTarget() {
        const id = Tuning.selectedId;
        if (!id) return null;
        const entry = layoutEntry(id);
        return entry ? { id, kind: targetKind(id), entry } : null;
    }

    function pointInRect(x, y, r) {
        return x >= r.left && x <= r.left + r.w && y >= r.top && y <= r.top + r.h;
    }

    /**
     * Paint order key for stains. All stains share z-index 0 in one
     * stacking context (they sit beneath every photo/lineart), so among
     * themselves they paint in DOM order: row by row, the coloring-side
     * stain after the photo-side one within a row.
     */
    function stainPaintOrder(el) {
        const [row, type] = stainKeyOf(el.dataset.tuneId).split('-');
        return Number(row) * 2 + (type === 'svg' ? 1 : 0);
    }

    /**
     * Topmost-first hit test. Pencils first (z-index 3, rotated rects — the
     * pointer is transformed into each pencil's unrotated local frame),
     * then the small flow elements (title box, logo) so the oversized
     * stains can't swallow their clicks, then the stains in paint order.
     */
    function hitTest(x, y) {
        const g = geometry();
        if (!g) return null;
        const pencils = Array.from(
            g.content.querySelectorAll('.cover-pencil[data-tune-id]')
        ).reverse(); // later DOM siblings paint on top
        for (const el of pencils) {
            const color = pencilColorOf(el.dataset.tuneId);
            const r = pencilRect(color, g);
            if (!r) continue;
            const a = -r.angle * Math.PI / 180;
            const dx = x - r.cx;
            const dy = y - r.cy;
            const lx = dx * Math.cos(a) - dy * Math.sin(a);
            const ly = dx * Math.sin(a) + dy * Math.cos(a);
            if (Math.abs(lx) <= r.w / 2 && Math.abs(ly) <= r.h / 2) {
                return el.dataset.tuneId;
            }
        }
        for (const id of ['title-box', 'logo']) {
            const r = targetRect(id, g);
            if (r && pointInRect(x, y, r)) return id;
        }
        const stains = Array.from(
            g.content.querySelectorAll('.pencil-scribble[data-tune-id]')
        ).sort((a, b) => stainPaintOrder(b) - stainPaintOrder(a));
        for (const el of stains) {
            const r = targetRect(el.dataset.tuneId, g);
            if (r && pointInRect(x, y, r)) return el.dataset.tuneId;
        }
        return null;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Live inline stamping — via the shared stamp* helpers in cover-layout.js,
    // the same formulas app.js's create path uses, so tuned = printed by
    // construction
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Stamp one pencil's sessionLayout values onto its rendered element
     * as inline mm/deg styles — the scoped update path, no re-render.
     */
    function applyPencil(color) {
        const p = Tuning.sessionLayout && Tuning.sessionLayout.pencils[color];
        const el = getTarget(`pencil-${color}`);
        if (!p || !el) return;
        stampPencil(el, p);
    }

    /** Stain: corner-anchored mm geometry on the scribble img (fixed aspect). */
    function applyStain(id) {
        const s = layoutEntry(id);
        const el = getTarget(id);
        if (!s || !el) return;
        stampStain(el, s);
    }

    /** Logo: width/margins only — a variant (src) swap needs the re-render. */
    function applyLogo() {
        const l = Tuning.sessionLayout && Tuning.sessionLayout.logo;
        const el = getTarget('logo');
        if (!l || !el) return;
        stampLogo(el, l);
    }

    function applyTitleBox() {
        const tb = Tuning.sessionLayout && Tuning.sessionLayout.titleBox;
        const el = getTarget('title-box');
        if (!tb || !el) return;
        stampTitleBox(el, tb);
    }

    /**
     * Retarget a stain's anchor corner while preserving its exact rendered
     * position: dxMm/dyMm are recomputed against the new corner from the
     * live rects (stain + its anchor box, px→mm via the page rect), so the
     * stain does not move — only the reference frame its offsets are
     * measured from changes. Returns true when the entry changed.
     */
    function retargetStainCorner(entry, corner, stainRect, boxRect, s) {
        if (entry.corner === corner) return false;
        const [vSide, hSide] = corner.split('-');
        const dxPx = hSide === 'left'
            ? stainRect.left - boxRect.left
            : boxRect.right - stainRect.right;
        const dyPx = vSide === 'top'
            ? stainRect.top - boxRect.top
            : boxRect.bottom - stainRect.bottom;
        entry.corner = corner;
        entry.dxMm = round01(dxPx / s);
        entry.dyMm = round01(dyPx / s);
        return true;
    }

    /** A stain's live rects: its own bounding rect plus its anchor box's
     *  (.pencil-pair-item — the positioned parent stampStain insets
     *  against). Null when either is missing or not laid out. */
    function stainRects(id) {
        const el = getTarget(id);
        const box = el && el.isConnected ? el.parentElement : null;
        if (!box) return null;
        const stainRect = el.getBoundingClientRect();
        const boxRect = box.getBoundingClientRect();
        if (stainRect.width <= 0 || boxRect.width <= 0) return null;
        return { stainRect, boxRect };
    }

    /**
     * Re-anchor a freshly dragged stain to the image-box corner nearest its
     * rendered CENTER (the box quadrant it sits in), preserving the exact
     * rendered position. Offsets measured from the nearest corner stay
     * small, which is what makes a placement generalize to other books'
     * image sizes — the corner is the reference, not a position cage.
     */
    function reanchorStain(id) {
        const entry = layoutEntry(id);
        const g = geometry();
        const rects = entry && g ? stainRects(id) : null;
        if (!rects) return;
        const { stainRect, boxRect } = rects;
        const hSide = stainRect.left + stainRect.width / 2
            < boxRect.left + boxRect.width / 2 ? 'left' : 'right';
        const vSide = stainRect.top + stainRect.height / 2
            < boxRect.top + boxRect.height / 2 ? 'top' : 'bottom';
        if (retargetStainCorner(entry, `${vSide}-${hSide}`, stainRect, boxRect, g.s)) {
            applyStain(id); // re-stamp: same position, new-corner insets
            Tuning.refreshSelection();
        }
    }

    /**
     * Scoped title-page re-render, rAF-coalesced: reconciles stain/logo/
     * title-box edits (their geometry is render-computed) and applies frame
     * parameter changes. Rebuilds exactly one page — never the gallery.
     */
    function scheduleRerender() {
        if (rerenderRaf) return;
        rerenderRaf = requestAnimationFrame(() => {
            rerenderRaf = 0;
            if (typeof window.rerenderTitlePage === 'function') window.rerenderTitlePage();
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Overlay chrome
    // ═══════════════════════════════════════════════════════════════════════

    function ensureLayer() {
        if (layer) return;
        layer = document.createElement('div');
        layer.className = 'tuning-layer';

        selBox = document.createElement('div');
        selBox.className = 'tuning-selection';
        ['nw', 'ne', 'sw', 'se'].forEach(pos => {
            const handle = document.createElement('div');
            handle.className = `tuning-handle tuning-handle-${pos}`;
            handle.dataset.handle = pos;
            selBox.appendChild(handle);
        });
        const stem = document.createElement('div');
        stem.className = 'tuning-rotate-stem';
        selBox.appendChild(stem);
        const rotate = document.createElement('div');
        rotate.className = 'tuning-rotate-handle';
        rotate.dataset.handle = 'rotate';
        selBox.appendChild(rotate);

        readout = document.createElement('div');
        readout.className = 'tuning-readout';

        layer.appendChild(selBox);
        layer.appendChild(readout);
        layer.addEventListener('mousedown', onLayerMouseDown);
        document.body.appendChild(layer);
    }

    function readoutText(id, kind) {
        const e = layoutEntry(id);
        if (!e) return '';
        if (kind === 'pencil') {
            return `${pencilColorOf(id)} · ${e.side} ${e.offset}mm · top ${e.top}mm` +
                ` · w ${e.width}mm · ${e.rotation}°${e.flipX ? ' · flipX' : ''}`;
        }
        if (kind === 'stain') {
            return `stain ${stainKeyOf(id)} · ${e.corner} · w ${e.widthMm}mm` +
                ` · dx ${e.dxMm}mm · dy ${e.dyMm}mm`;
        }
        if (kind === 'logo') {
            return `logo ${e.variant} · w ${e.width}mm · mt ${e.marginTop}mm · mb ${e.marginBottom}mm`;
        }
        return `title · mt ${e.marginTop}mm · mb ${e.marginBottom}mm · maxW ${e.maxWidth}%`;
    }

    function notify() {
        if (typeof Tuning.onChange === 'function') Tuning.onChange();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Gestures — drag / resize / rotate
    // ═══════════════════════════════════════════════════════════════════════

    function onLayerMouseDown(e) {
        if (e.button !== 0 || !Tuning.isOpen) return;
        const handle = e.target.dataset ? e.target.dataset.handle : null;
        if (handle && Tuning.selectedId) {
            e.preventDefault();
            if (handle === 'rotate') startRotate(e);
            else startResize(e);
            return;
        }
        const hitId = hitTest(e.clientX, e.clientY);
        if (hitId) {
            e.preventDefault();
            Tuning.select(hitId);
            startDrag(e);
            return;
        }
        Tuning.deselect(); // click on empty layer space
    }

    function startGesture(type, e, data) {
        // A gesture stuck open (mouseup lost outside the window) must not
        // leak its listeners or stale state into the new one
        if (gesture) endGesture();
        gesture = Object.assign(
            { type, startX: e.clientX, startY: e.clientY, changed: false },
            data
        );
        document.addEventListener('mousemove', onGestureMove);
        document.addEventListener('mouseup', onGestureEnd);
    }

    function startDrag(e) {
        const sel = selectedTarget();
        const g = geometry();
        if (!sel || !g) return;
        const el = getTarget(sel.id);
        // el (and, for pencils, the layout aspect ratio) are per-gesture
        // invariants — gestures never trigger a render — like px-per-mm (s)
        const data = { id: sel.id, kind: sel.kind, s: g.s, el };
        if (sel.kind === 'pencil') {
            data.aspect = el && el.offsetWidth > 0 ? el.offsetHeight / el.offsetWidth : 1;
            data.start = { offset: sel.entry.offset, top: sel.entry.top };
        } else if (sel.kind === 'stain') {
            // The anchor corner stays fixed during a drag — only the mm
            // offsets move, unclamped, so the stain goes anywhere (px→mm
            // via the page rect, exactly like pencils); drag end re-anchors
            // to the nearest corner with the position preserved
            data.start = { dxMm: sel.entry.dxMm, dyMm: sel.entry.dyMm };
        } else {
            // logo / title box sit centered in flex flow — vertical drag
            // adjusts marginTop, horizontal movement is meaningless
            data.start = { marginTop: sel.entry.marginTop != null ? sel.entry.marginTop : 0 };
        }
        startGesture('drag', e, data);
    }

    function startResize(e) {
        const sel = selectedTarget();
        const g = geometry();
        const r = sel && g ? targetRect(sel.id, g) : null;
        if (!r) return;
        const data = {
            id: sel.id,
            kind: sel.kind,
            el: getTarget(sel.id), // per-gesture invariant, see startDrag
            cx: r.cx,
            cy: r.cy,
            startDist: Math.max(1, Math.hypot(e.clientX - r.cx, e.clientY - r.cy)),
            startDistX: Math.max(1, Math.abs(e.clientX - r.cx))
        };
        if (sel.kind === 'pencil') {
            data.startWidth = sel.entry.width;
            data.startOffset = sel.entry.offset;
            data.startTop = sel.entry.top;
            data.aspect = r.h / r.w;
        } else if (sel.kind === 'stain') {
            data.startWidthMm = sel.entry.widthMm;
        } else if (sel.kind === 'logo') {
            data.startWidth = sel.entry.width;
        } else { // titleBox — horizontal resize adjusts maxWidth %
            data.startMaxWidth = sel.entry.maxWidth != null ? sel.entry.maxWidth : 80;
        }
        startGesture('resize', e, data);
    }

    function startRotate(e) {
        const sel = selectedTarget();
        if (!sel || sel.kind !== 'pencil') return; // rotate is pencils-only
        const g = geometry();
        const r = g ? targetRect(sel.id, g) : null;
        if (!r) return;
        startGesture('rotate', e, {
            id: sel.id,
            kind: sel.kind,
            el: getTarget(sel.id), // per-gesture invariant, see startDrag
            aspect: r.h / r.w,
            cx: r.cx,
            cy: r.cy,
            lastAngle: Math.atan2(e.clientY - r.cy, e.clientX - r.cx) * 180 / Math.PI,
            acc: 0, // accumulated pointer angle, wrap-safe across ±180°
            startRotation: sel.entry.rotation
        });
    }

    /**
     * Apply a positional delta to a layout entry in mm (call sites convert
     * px→mm first). Encapsulates the anchor-dependent signs: right-anchored
     * pencil offsets move inversely to the pointer, and a stain's dxMm/dyMm
     * flip per its anchor corner (right-anchored dx and bottom-anchored dy
     * are offsets away from the pointer direction); logo/title box take
     * vertical only.
     */
    function applyKindDelta(entry, kind, dxU, dyU) {
        if (kind === 'pencil') {
            entry.offset = round01(entry.offset + (entry.side === 'right' ? -dxU : dxU));
            entry.top = round01(entry.top + dyU);
        } else if (kind === 'stain') {
            const right = entry.corner === 'top-right' || entry.corner === 'bottom-right';
            const bottom = entry.corner === 'bottom-left' || entry.corner === 'bottom-right';
            entry.dxMm = round01(entry.dxMm + (right ? -dxU : dxU));
            entry.dyMm = round01(entry.dyMm + (bottom ? -dyU : dyU));
        } else { // logo / titleBox — marginTop only
            entry.marginTop = round01((entry.marginTop || 0) + dyU);
        }
    }

    /** rAF-throttled mousemove: keep only the latest event per frame. */
    function onGestureMove(e) {
        pendingMoveEvent = e;
        if (gestureMoveRaf) return;
        gestureMoveRaf = requestAnimationFrame(() => {
            gestureMoveRaf = 0;
            const ev = pendingMoveEvent;
            pendingMoveEvent = null;
            if (ev) handleGestureMove(ev);
        });
    }

    /** Cancel the throttle frame and take the unprocessed move, if any. */
    function cancelGestureMove() {
        if (gestureMoveRaf) {
            cancelAnimationFrame(gestureMoveRaf);
            gestureMoveRaf = 0;
        }
        const ev = pendingMoveEvent;
        pendingMoveEvent = null;
        return ev;
    }

    /** Process the pending throttled move now — the final position at
     *  gesture end must not be lost to a cancelled frame. */
    function flushGestureMove() {
        const ev = cancelGestureMove();
        if (ev) handleGestureMove(ev);
    }

    function handleGestureMove(e) {
        if (!gesture || !Tuning.sessionLayout) return;
        // The cached target lost its node (a render replaced it): the whole
        // gesture geometry is stale — discard the move rather than stamping
        // wrong values onto the replacement node
        if (gesture.el && !gesture.el.isConnected) return;
        const entry = layoutEntry(gesture.id);
        if (!entry) return;
        gesture.changed = true;
        const dx = e.clientX - gesture.startX;
        const dy = e.clientY - gesture.startY;

        if (gesture.type === 'drag') {
            // Drag deltas are cumulative from the gesture start: reset the
            // entry to its start snapshot, then apply the total delta
            Object.assign(entry, gesture.start);
            if (gesture.kind === 'pencil') {
                applyKindDelta(entry, 'pencil', dx / gesture.s, dy / gesture.s);
            } else if (gesture.kind === 'stain') {
                applyKindDelta(entry, 'stain', dx / gesture.s, dy / gesture.s);
            } else { // logo / titleBox — vertical only
                applyKindDelta(entry, gesture.kind, 0, dy / gesture.s);
            }
        } else if (gesture.type === 'resize') {
            const dist = Math.hypot(e.clientX - gesture.cx, e.clientY - gesture.cy);
            if (gesture.kind === 'pencil') {
                // Center-anchored: width scales with pointer distance from the
                // element center; offset/top shift so the center stays put
                const w = clamp(
                    round01(gesture.startWidth * dist / gesture.startDist),
                    MIN_PENCIL_WIDTH_MM
                );
                entry.width = w;
                entry.offset = round01(gesture.startOffset + (gesture.startWidth - w) / 2);
                entry.top = round01(gesture.startTop + gesture.aspect * (gesture.startWidth - w) / 2);
            } else if (gesture.kind === 'stain') {
                // Width only — height follows via the fixed intrinsic aspect
                entry.widthMm = clamp(
                    round01(gesture.startWidthMm * dist / gesture.startDist),
                    MIN_STAIN_WIDTH_MM
                );
            } else if (gesture.kind === 'logo') {
                entry.width = clamp(
                    round01(gesture.startWidth * dist / gesture.startDist),
                    MIN_LOGO_WIDTH_MM
                );
            } else { // titleBox — horizontal distance drives maxWidth %
                const fx = Math.max(1, Math.abs(e.clientX - gesture.cx)) / gesture.startDistX;
                entry.maxWidth = clamp(
                    round01(gesture.startMaxWidth * fx),
                    MIN_TITLE_MAXW_PCT, 100
                );
            }
        } else if (gesture.type === 'rotate') {
            const angle = Math.atan2(e.clientY - gesture.cy, e.clientX - gesture.cx) * 180 / Math.PI;
            gesture.acc += normalize180(angle - gesture.lastAngle);
            gesture.lastAngle = angle;
            // flipX mirrors the visual rotation direction: stored θ renders
            // as -θ, so subtract the pointer delta to follow the pointer
            entry.rotation = round05(gesture.startRotation + (entry.flipX ? -gesture.acc : gesture.acc));
        }

        Tuning.applyElement(gesture.id); // live inline stamp, no re-render
        Tuning.refreshSelection();
        notify();
    }

    function onGestureEnd() {
        endGesture();
    }

    function endGesture() {
        if (!gesture) return;
        flushGestureMove(); // trailing throttled move — final position counts
        // A finished stain drag re-anchors to the nearest image-box corner
        // (position preserved) so the stored offsets stay small and
        // generalize; getTarget still resolves gesture.el here
        if (gesture.type === 'drag' && gesture.kind === 'stain' && gesture.changed) {
            reanchorStain(gesture.id);
        }
        // Stain/logo/title-box geometry is render-computed (flex flow, fit
        // clamp) — reconcile the live-stamped styles with a scoped re-render
        const needsRerender = gesture.changed && gesture.kind !== 'pencil';
        gesture = null;
        document.removeEventListener('mousemove', onGestureMove);
        document.removeEventListener('mouseup', onGestureEnd);
        if (needsRerender) scheduleRerender();
        notify(); // full panel refresh now that the gesture is over
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Keyboard — chord toggle, Esc deselect, arrow nudge
    // ═══════════════════════════════════════════════════════════════════════

    function matchesChord(e) {
        return e.code === TUNING_CHORD.code
            && e.altKey === TUNING_CHORD.altKey
            && (e.metaKey || e.ctrlKey) === TUNING_CHORD.metaOrCtrlKey;
    }

    function isEditableTarget(el) {
        return !!el && (
            el.tagName === 'INPUT'
            || el.tagName === 'TEXTAREA'
            || el.tagName === 'SELECT'
            || el.isContentEditable
        );
    }

    function onKeydown(e) {
        // The summon chord fires even from the title textarea — it requires
        // meta-or-ctrl + Alt (see matchesChord), so it can never insert text
        if (matchesChord(e)) {
            e.preventDefault();
            Tuning.toggle();
            return;
        }
        if (isEditableTarget(document.activeElement)) return;
        if (!Tuning.isOpen) return;
        if (e.key === 'Escape') {
            endGesture();
            Tuning.deselect();
            return;
        }
        const sel = selectedTarget();
        if (!sel) return;
        // A drag resets the entry to its start snapshot on every move, so a
        // mid-gesture nudge would be silently reverted — ignore it
        if (gesture) return;
        const step = e.shiftKey ? NUDGE_SHIFT_MM : NUDGE_MM;
        let dx = 0;
        let dy = 0;
        if (e.key === 'ArrowLeft') dx = -step;
        else if (e.key === 'ArrowRight') dx = step;
        else if (e.key === 'ArrowUp') dy = -step;
        else if (e.key === 'ArrowDown') dy = step;
        else return;
        e.preventDefault();
        // logo / title box: only vertical nudges apply (centered flow)
        if (sel.kind !== 'pencil' && sel.kind !== 'stain' && dy === 0) return;
        // Steps are mm for every kind
        applyKindDelta(sel.entry, sel.kind, dx, dy);
        Tuning.applyElement(sel.id);
        if (sel.kind !== 'pencil') scheduleRerender();
        Tuning.refreshSelection();
        notify();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Viewport tracking (attached on open, removed on close)
    // ═══════════════════════════════════════════════════════════════════════

    /** A mouseup outside the window never reaches the document listener —
     *  losing focus mid-gesture ends the gesture instead of sticking it. */
    function onWindowBlur() {
        endGesture();
    }

    function onViewportChange() {
        if (viewportRaf) return;
        viewportRaf = requestAnimationFrame(() => {
            viewportRaf = 0;
            if (Tuning.isOpen) Tuning.refreshSelection();
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Panel — slim fixed value editor (Selection / Frame / Stains / Logo /
    // Title box). Two-way bound: gestures refresh fields via onChange;
    // typing/sliding writes sessionLayout and applies (pencils inline,
    // everything else via the scoped re-render).
    // ═══════════════════════════════════════════════════════════════════════

    function ensurePanel() {
        if (panel) return;
        panel = document.createElement('div');
        panel.className = 'tuning-panel';

        const title = document.createElement('div');
        title.className = 'tuning-panel-title';
        title.textContent = 'Cover tuning';
        panel.appendChild(title);

        selFields = document.createElement('div');
        selFields.className = 'tuning-fields';
        panel.appendChild(panelSection('Selection', selFields));
        buildSelectionFields();

        panel.appendChild(panelSection('Frame', buildFrameControls()));
        panel.appendChild(panelSection('Stains', buildStainControls()));
        panel.appendChild(panelSection('Logo', buildLogoControls()));
        panel.appendChild(panelSection('Title box', buildTitleBoxControls()));
        panel.appendChild(panelSection('Alternatives', buildAlternativesControls()));

        document.body.appendChild(panel);
        Tuning.onChange = refreshPanel;
    }

    function refreshPanel() {
        if (!panel || !Tuning.isOpen) return;
        if (panelSelId !== Tuning.selectedId) buildSelectionFields();
        // During a gesture only the Selection fields track the live values;
        // the static sections (incl. the slot deep-equal check) catch up at
        // gesture end, selection change, and sync()
        if (!gesture) staticRefreshers.forEach(fn => fn());
        selRefreshers.forEach(fn => fn());
    }

    function panelSection(titleText, body) {
        const section = document.createElement('section');
        section.className = 'tuning-section';
        const h = document.createElement('div');
        h.className = 'tuning-section-title';
        h.textContent = titleText;
        section.appendChild(h);
        section.appendChild(body);
        return section;
    }

    /** Register a value refresher that never fights the focused input. */
    function bindValue(refreshers, input, get) {
        refreshers.push(() => {
            if (document.activeElement === input) return;
            if (input.type === 'checkbox') input.checked = !!get();
            else input.value = String(get());
        });
    }

    /** Clamp a typed value to opts.min/opts.max when either is provided —
     *  fields without bounds pass through unclamped. */
    function clampToOpts(v, opts) {
        if (opts.min == null && opts.max == null) return v;
        return clamp(v,
            opts.min != null ? opts.min : -Infinity,
            opts.max != null ? opts.max : Infinity);
    }

    /** Label + number input row. */
    function numRow(refreshers, labelText, get, set, opts = {}) {
        const row = document.createElement('label');
        row.className = 'tuning-row';
        const span = document.createElement('span');
        span.textContent = labelText;
        const input = document.createElement('input');
        input.type = 'number';
        if (opts.step != null) input.step = String(opts.step);
        if (opts.min != null) input.min = String(opts.min);
        if (opts.max != null) input.max = String(opts.max);
        input.addEventListener('input', () => {
            let v = parseFloat(input.value);
            if (!Number.isFinite(v)) return;
            const clamped = clampToOpts(v, opts);
            if (clamped !== v) {
                v = clamped;
                input.value = String(v); // the UI reflects the enforced bound
            }
            set(v);
        });
        row.appendChild(span);
        row.appendChild(input);
        bindValue(refreshers, input, get);
        return row;
    }

    /** Label + checkbox row. */
    function checkRow(refreshers, labelText, get, set) {
        const row = document.createElement('label');
        row.className = 'tuning-row';
        const span = document.createElement('span');
        span.textContent = labelText;
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.addEventListener('change', () => set(input.checked));
        row.appendChild(span);
        row.appendChild(input);
        bindValue(refreshers, input, get);
        return row;
    }

    /** Label on its own line + range slider + synced number input. */
    function sliderRow(refreshers, labelText, get, set, opts = {}) {
        const wrap = document.createElement('div');
        wrap.className = 'tuning-row tuning-slider-row';
        const span = document.createElement('span');
        span.textContent = labelText;
        const slider = document.createElement('input');
        slider.type = 'range';
        const num = document.createElement('input');
        num.type = 'number';
        [slider, num].forEach(input => {
            if (opts.min != null) input.min = String(opts.min);
            if (opts.max != null) input.max = String(opts.max);
            if (opts.step != null) input.step = String(opts.step);
        });
        slider.addEventListener('input', () => {
            let v = parseFloat(slider.value);
            if (!Number.isFinite(v)) return;
            const clamped = clampToOpts(v, opts);
            if (clamped !== v) {
                v = clamped;
                slider.value = String(v);
            }
            num.value = String(v);
            set(v);
        });
        num.addEventListener('input', () => {
            let v = parseFloat(num.value);
            if (!Number.isFinite(v)) return;
            const clamped = clampToOpts(v, opts);
            if (clamped !== v) {
                v = clamped;
                num.value = String(v); // the UI reflects the enforced bound
            }
            slider.value = String(v);
            set(v);
        });
        wrap.appendChild(span);
        wrap.appendChild(slider);
        wrap.appendChild(num);
        bindValue(refreshers, slider, get);
        bindValue(refreshers, num, get);
        return { wrap, span };
    }

    function selHeading(text) {
        const el = document.createElement('div');
        el.className = 'tuning-sel-heading';
        el.textContent = text;
        return el;
    }

    /**
     * Does the rendered cover currently show a title box? Decides which
     * frame base height (areaHTitled vs areaHUntitled) the panel edits.
     */
    function hasTitleBox() {
        return !!getTarget('title-box');
    }

    /** Rebuild the Selection section for the current target kind. */
    function buildSelectionFields() {
        panelSelId = Tuning.selectedId;
        selRefreshers = [];
        selFields.innerHTML = '';
        const sel = selectedTarget();
        if (!sel) {
            const p = document.createElement('p');
            p.className = 'tuning-placeholder';
            p.textContent = 'Click an element to edit';
            selFields.appendChild(p);
            return;
        }
        const entry = sel.entry;
        // Pencils stamp inline and never re-render; everything else needs
        // the scoped re-render to reconcile render-computed geometry
        const apply = () => {
            Tuning.applyElement(sel.id);
            if (sel.kind !== 'pencil') scheduleRerender();
            Tuning.refreshSelection();
        };
        if (sel.kind === 'pencil') {
            selFields.appendChild(selHeading(`${pencilColorOf(sel.id)} pencil`));
            selFields.appendChild(numRow(selRefreshers, `${entry.side} (mm)`,
                () => entry.offset,
                v => { entry.offset = v; apply(); }, { step: 0.5 }));
            selFields.appendChild(numRow(selRefreshers, 'top (mm)',
                () => entry.top,
                v => { entry.top = v; apply(); }, { step: 0.5 }));
            selFields.appendChild(numRow(selRefreshers, 'width (mm)',
                () => entry.width,
                v => { entry.width = clamp(v, MIN_PENCIL_WIDTH_MM); apply(); },
                { step: 0.5, min: MIN_PENCIL_WIDTH_MM }));
            selFields.appendChild(numRow(selRefreshers, 'rotation (deg)',
                () => entry.rotation,
                v => { entry.rotation = v; apply(); }, { step: 0.5 }));
            selFields.appendChild(checkRow(selRefreshers, 'flip X',
                () => entry.flipX,
                v => { entry.flipX = v; apply(); }));
        } else if (sel.kind === 'stain') {
            // aspect is deliberately not editable — it's the PNG's intrinsic
            // ratio (an asset property), not a layout tunable
            selFields.appendChild(selHeading(`stain ${stainKeyOf(sel.id)}`));
            selFields.appendChild(buildCornerToggle(selRefreshers, sel.id, entry, apply));
            const cornerHint = document.createElement('p');
            cornerHint.className = 'tuning-hint';
            cornerHint.textContent = 'anchor — offsets are measured from this corner';
            selFields.appendChild(cornerHint);
            selFields.appendChild(numRow(selRefreshers, 'width (mm)',
                () => entry.widthMm,
                v => { entry.widthMm = clamp(v, MIN_STAIN_WIDTH_MM, MAX_STAIN_WIDTH_MM); apply(); },
                { step: 0.5, min: MIN_STAIN_WIDTH_MM, max: MAX_STAIN_WIDTH_MM }));
            selFields.appendChild(numRow(selRefreshers, 'dx (mm)',
                () => entry.dxMm,
                v => { entry.dxMm = v; apply(); },
                { step: 0.5, min: STAIN_OFFSET_MIN_MM, max: STAIN_OFFSET_MAX_MM }));
            selFields.appendChild(numRow(selRefreshers, 'dy (mm)',
                () => entry.dyMm,
                v => { entry.dyMm = v; apply(); },
                { step: 0.5, min: STAIN_OFFSET_MIN_MM, max: STAIN_OFFSET_MAX_MM }));
        } else if (sel.kind === 'logo') {
            selFields.appendChild(selHeading('logo'));
            selFields.appendChild(numRow(selRefreshers, 'width (mm)',
                () => entry.width,
                v => { entry.width = clamp(v, MIN_LOGO_WIDTH_MM); apply(); },
                { step: 1, min: MIN_LOGO_WIDTH_MM }));
            selFields.appendChild(buildVariantToggle(selRefreshers));
        } else { // titleBox
            selFields.appendChild(selHeading('title box'));
            selFields.appendChild(numRow(selRefreshers, 'margin top (mm)',
                () => entry.marginTop,
                v => { entry.marginTop = v; apply(); }, { step: 0.5 }));
            selFields.appendChild(numRow(selRefreshers, 'margin bottom (mm)',
                () => entry.marginBottom,
                v => { entry.marginBottom = v; apply(); }, { step: 0.5 }));
            selFields.appendChild(numRow(selRefreshers, 'max width (%)',
                () => entry.maxWidth,
                v => { entry.maxWidth = clamp(v, MIN_TITLE_MAXW_PCT, 100); apply(); },
                { step: 1, min: MIN_TITLE_MAXW_PCT, max: 100 }));
        }
    }

    function buildFrameControls() {
        const box = document.createElement('div');
        box.className = 'tuning-fields';
        const F = () => Tuning.sessionLayout.frame;
        const setF = key => v => {
            F()[key] = v;
            scheduleRerender();
        };
        const areaHKey = () => hasTitleBox() ? 'areaHTitled' : 'areaHUntitled';

        box.appendChild(sliderRow(staticRefreshers, 'Area width (mm)',
            () => F().areaW, setF('areaW'), { min: 100, max: 190, step: 1 }).wrap);

        // Edits the base height matching the current book's title presence;
        // the label names which one so the operator always knows
        const areaH = sliderRow(staticRefreshers, 'Area height (mm)',
            () => F()[areaHKey()],
            v => { F()[areaHKey()] = v; scheduleRerender(); },
            { min: 100, max: 200, step: 1 });
        staticRefreshers.push(() => {
            areaH.span.textContent = hasTitleBox()
                ? 'Area height — titled (mm)'
                : 'Area height — untitled (mm)';
        });
        box.appendChild(areaH.wrap);

        box.appendChild(sliderRow(staticRefreshers, 'Title line reduction (mm)',
            () => F().titleLineReduction, setF('titleLineReduction'),
            { min: 0, max: 20, step: 1 }).wrap);
        box.appendChild(sliderRow(staticRefreshers, 'Row gap (mm)',
            () => F().rowGap, setF('rowGap'), { min: 0, max: 30, step: 1 }).wrap);
        box.appendChild(sliderRow(staticRefreshers, 'Overlap (frac)',
            () => F().overlapFrac, setF('overlapFrac'), { min: 0, max: 0.5, step: 0.01 }).wrap);
        box.appendChild(sliderRow(staticRefreshers, 'Lineart shift (frac)',
            () => F().dyFrac, setF('dyFrac'), { min: 0, max: 0.3, step: 0.01 }).wrap);
        box.appendChild(sliderRow(staticRefreshers, 'Default scale (%)',
            () => F().scale, setF('scale'), { min: 50, max: 200, step: 1 }).wrap);
        return box;
    }

    /** Quick stain pickers — exact values live in the Selection section. */
    function buildStainControls() {
        const box = document.createElement('div');
        box.className = 'tuning-btn-grid';
        ['0-photo', '0-svg', '1-photo', '1-svg'].forEach(key => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'tuning-variant-btn';
            btn.dataset.stain = key;
            btn.textContent = key.replace('-', ' · ');
            btn.addEventListener('click', () => {
                if (getTarget(`stain-${key}`)) Tuning.select(`stain-${key}`);
            });
            staticRefreshers.push(() => {
                btn.classList.toggle('active', Tuning.selectedId === `stain-${key}`);
                btn.disabled = !getTarget(`stain-${key}`);
            });
            box.appendChild(btn);
        });
        return box;
    }

    /** Corner-anchor segmented toggle for a selected stain, styled like the
     *  logo variant toggle. Switching the corner RETARGETS the anchor while
     *  preserving the current visual position — dxMm/dyMm are recomputed
     *  against the new corner from the live rects, so the stain never
     *  jumps; only the reference frame changes. */
    function buildCornerToggle(refreshers, id, entry, apply) {
        const wrap = document.createElement('div');
        wrap.className = 'tuning-variant-toggle';
        STAIN_CORNERS.forEach(([value, labelText]) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'tuning-variant-btn';
            btn.dataset.corner = value;
            btn.textContent = labelText;
            btn.title = value;
            btn.addEventListener('click', () => {
                if (entry.corner === value) return;
                const g = geometry();
                const rects = g ? stainRects(id) : null;
                if (rects) {
                    retargetStainCorner(entry, value, rects.stainRect, rects.boxRect, g.s);
                } else {
                    entry.corner = value; // not rendered — plain re-anchor
                }
                apply();
                refreshPanel();
            });
            refreshers.push(() => {
                btn.classList.toggle('active', entry.corner === value);
            });
            wrap.appendChild(btn);
        });
        return wrap;
    }

    /** Vertical/horizontal segmented toggle, data-attribute driven like the
     *  app's .cover-variant-btn convention. Variant swaps the logo src, so
     *  it always goes through the scoped re-render. */
    function buildVariantToggle(refreshers) {
        const wrap = document.createElement('div');
        wrap.className = 'tuning-variant-toggle';
        [['vertical', 'Vertical'], ['horizontal', 'Horizontal']].forEach(([value, labelText]) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'tuning-variant-btn';
            btn.dataset.logoVariant = value;
            btn.textContent = labelText;
            btn.addEventListener('click', () => {
                const l = Tuning.sessionLayout && Tuning.sessionLayout.logo;
                if (!l || l.variant === value) return;
                l.variant = value;
                scheduleRerender();
                refreshPanel();
            });
            refreshers.push(() => {
                const l = Tuning.sessionLayout && Tuning.sessionLayout.logo;
                btn.classList.toggle('active', !!l && l.variant === value);
            });
            wrap.appendChild(btn);
        });
        return wrap;
    }

    function buildLogoControls() {
        const box = document.createElement('div');
        box.className = 'tuning-fields';
        const L = () => Tuning.sessionLayout.logo;
        box.appendChild(buildVariantToggle(staticRefreshers));
        box.appendChild(sliderRow(staticRefreshers, 'Width (mm)',
            () => L().width,
            v => { L().width = v; scheduleRerender(); },
            { min: 40, max: 140, step: 1 }).wrap);
        return box;
    }

    function buildTitleBoxControls() {
        const box = document.createElement('div');
        box.className = 'tuning-fields';
        const TB = () => Tuning.sessionLayout.titleBox;
        const setTB = key => v => {
            TB()[key] = v;
            scheduleRerender();
        };
        box.appendChild(numRow(staticRefreshers, 'Margin top (mm)',
            () => TB().marginTop, setTB('marginTop'), { step: 0.5 }));
        box.appendChild(numRow(staticRefreshers, 'Margin bottom (mm)',
            () => TB().marginBottom, setTB('marginBottom'), { step: 0.5 }));
        box.appendChild(numRow(staticRefreshers, 'Max width (%)',
            () => TB().maxWidth, setTB('maxWidth'),
            { step: 1, min: MIN_TITLE_MAXW_PCT, max: 100 }));
        return box;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Alternatives — snapshot slots A/B/C, JSON export, JSON import.
    // Slot interaction: clicking the letter LOADS the slot (inert while
    // empty), clicking the small 💾 sub-button SAVES the current layout
    // into it (silent overwrite) — the hint line under the slots says so.
    // ═══════════════════════════════════════════════════════════════════════

    function buildAlternativesControls() {
        const box = document.createElement('div');
        box.className = 'tuning-fields';

        const grid = document.createElement('div');
        grid.className = 'tuning-slot-grid';
        SLOT_KEYS.forEach(key => {
            const slot = document.createElement('div');
            slot.className = 'tuning-slot';

            const load = document.createElement('button');
            load.type = 'button';
            load.className = 'tuning-slot-load';
            load.textContent = key;
            load.title = `Load slot ${key}`;
            load.addEventListener('click', () => activateSlot(key));

            const save = document.createElement('button');
            save.type = 'button';
            save.className = 'tuning-slot-save';
            save.textContent = '💾';
            save.title = `Save current layout to slot ${key}`;
            save.addEventListener('click', () => saveSlot(key));

            slot.appendChild(load);
            slot.appendChild(save);
            staticRefreshers.push(() => {
                const filled = !!slots[key];
                slot.classList.toggle('tuning-slot-empty', !filled);
                slot.classList.toggle('active', slotIndicated(key));
                load.disabled = !filled; // empty slots are inert on activate
            });
            grid.appendChild(slot);
        });
        box.appendChild(grid);

        const hint = document.createElement('p');
        hint.className = 'tuning-hint';
        hint.textContent = 'Letter loads the slot · 💾 saves over it';
        box.appendChild(hint);

        const actions = document.createElement('div');
        actions.className = 'tuning-btn-grid';
        const exportBtn = document.createElement('button');
        exportBtn.type = 'button';
        exportBtn.className = 'tuning-variant-btn';
        exportBtn.textContent = 'Export JSON';
        exportBtn.addEventListener('click', exportLayout);
        actions.appendChild(exportBtn);
        const importBtn = document.createElement('button');
        importBtn.type = 'button';
        importBtn.className = 'tuning-variant-btn';
        importBtn.textContent = 'Import';
        importBtn.addEventListener('click', () => importInput.click());
        actions.appendChild(importBtn);
        box.appendChild(actions);

        importInput = document.createElement('input');
        importInput.type = 'file';
        importInput.accept = 'application/json,.json';
        importInput.hidden = true;
        importInput.addEventListener('change', onImportFile);
        box.appendChild(importInput);

        statusEl = document.createElement('div');
        statusEl.className = 'tuning-status';
        box.appendChild(statusEl);

        return box;
    }

    /** Save = deep-clone sessionLayout into the slot; overwrites silently. */
    function saveSlot(key) {
        if (!Tuning.sessionLayout) return;
        slots[key] = structuredClone(Tuning.sessionLayout);
        activeSlot = key;
        showStatus(`Saved to slot ${key}`, false);
        refreshPanel();
    }

    /** Activate = deep-clone the slot back into the session. Empty: no-op. */
    function activateSlot(key) {
        if (!slots[key]) return;
        activeSlot = key;
        adoptLayout(structuredClone(slots[key]));
    }

    /**
     * Active indication: the slot last saved/loaded, but only while the
     * session still deep-equals its stored clone — any manual edit diverges
     * and the highlight drops (the slot keeps its stored layout). Cheap:
     * only the activeSlot candidate ever reaches the stringify compare.
     */
    function slotIndicated(key) {
        return activeSlot === key
            && !!slots[key]
            && !!Tuning.sessionLayout
            && JSON.stringify(Tuning.sessionLayout) === JSON.stringify(slots[key]);
    }

    /**
     * Swap in a replacement sessionLayout (slot activation, import) and
     * reconcile everything that referenced the old object: the Selection
     * fields hold entry closures into the old layout, so rebuild them;
     * then a scoped title-page re-render, chrome + panel refresh.
     */
    function adoptLayout(newLayout) {
        Tuning.sessionLayout = newLayout;
        buildSelectionFields();
        scheduleRerender();
        Tuning.refreshSelection();
        notify();
    }

    /**
     * Download sessionLayout as cover-layout.json (Blob + temporary anchor,
     * no server round-trip). The pretty-printed JSON pastes verbatim as the
     * COVER_LAYOUT object literal in cover-layout.js — the adoption path.
     */
    function exportLayout() {
        if (!Tuning.sessionLayout) return;
        const json = JSON.stringify(Tuning.sessionLayout, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'cover-layout.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function onImportFile() {
        const file = importInput.files && importInput.files[0];
        importInput.value = ''; // so re-picking the same file fires change
        if (!file) return;
        const reader = new FileReader();
        reader.onerror = () => showStatus('Could not read the file', true);
        reader.onload = () => {
            try {
                importLayout(String(reader.result));
            } catch (err) {
                console.warn('Tuning: import rejected —', err);
                showStatus('Not a layout JSON — nothing imported', true);
            }
        };
        reader.readAsText(file);
    }

    /**
     * Parse, validate, deep-merge onto a fresh baked default, adopt. Throws
     * on parse errors and non-object payloads; sessionLayout is replaced
     * only after the merged object is fully built, so a failed import never
     * touches the session. A version other than 1 imports best-effort.
     */
    function importLayout(text) {
        const parsed = JSON.parse(text);
        if (!isPlainObject(parsed)) throw new Error('parsed value is not an object');
        if (parsed.version !== undefined && parsed.version !== 1) {
            console.warn(`Tuning: layout version ${parsed.version} (expected 1) — importing best-effort`);
        }
        const merged = mergeIntoBase(structuredClone(COVER_LAYOUT), parsed);
        activeSlot = null; // an imported session matches no slot
        adoptLayout(merged);
        showStatus('Layout imported', false);
    }

    // titleBox margins/maxWidth are applied "only when set (non-null)" —
    // see cover-layout.js — so null is a meaningful imported value for them
    const MERGE_NULLABLE_PATHS = new Set([
        'titleBox.marginTop',
        'titleBox.marginBottom',
        'titleBox.maxWidth'
    ]);

    /**
     * Recursive schema-directed merge of `patch` onto `base`: only keys that
     * exist in base are copied (unknown keys ignored), keys missing from
     * patch keep the baked default, nested plain objects merge recursively,
     * and a kind mismatch (object vs scalar) keeps the baked value. A scalar
     * replaces the baked value only when its type matches the base value's
     * (numbers must also be finite); null is accepted only for the allow-null
     * keys above. A rejected value warns with its key path and keeps the
     * baked default. Mutates and returns base.
     */
    function mergeIntoBase(base, patch, path = '') {
        Object.keys(base).forEach(key => {
            if (!Object.prototype.hasOwnProperty.call(patch, key)) return;
            const b = base[key];
            const p = patch[key];
            const keyPath = path ? `${path}.${key}` : key;
            if (isPlainObject(b)) {
                if (isPlainObject(p)) mergeIntoBase(b, p, keyPath);
                return;
            }
            const accepted = (p === null && MERGE_NULLABLE_PATHS.has(keyPath))
                || (typeof p === typeof b && (typeof p !== 'number' || Number.isFinite(p)));
            if (accepted) {
                base[key] = p;
            } else {
                console.warn(`Tuning: import value for "${keyPath}" rejected (expected ${typeof b}) — keeping default`);
            }
        });
        return base;
    }

    function isPlainObject(v) {
        return typeof v === 'object' && v !== null && !Array.isArray(v);
    }

    /** Brief status line in the Alternatives section; auto-clears after 4s. */
    function showStatus(message, isError) {
        if (!statusEl) return;
        statusEl.textContent = message;
        statusEl.classList.toggle('tuning-status-error', !!isError);
        statusEl.classList.toggle('tuning-status-ok', !isError);
        statusEl.style.display = 'block';
        if (statusTimer) clearTimeout(statusTimer);
        statusTimer = setTimeout(() => {
            statusTimer = 0;
            statusEl.textContent = '';
            statusEl.style.display = 'none';
        }, 4000);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Numeric rounding / clamping — layout stays in clean mm / deg / % values
    // ═══════════════════════════════════════════════════════════════════════

    function round01(v) {
        return Math.round(v * 10) / 10;
    }

    function round05(v) {
        return Math.round(v * 2) / 2;
    }

    function clamp(v, min, max = Infinity) {
        return Math.min(max, Math.max(min, v));
    }

    /** Wrap an angle delta into [-180, 180) — keeps rotation drag continuous. */
    function normalize180(d) {
        return ((d % 360) + 540) % 360 - 180;
    }

    window.Tuning = Tuning;
    document.addEventListener('keydown', onKeydown);
})();
