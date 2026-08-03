/**
 * Fotomalovánky A4 Gallery Builder
 * 
 * Calculates optimal sizing for photo + coloring book pairs on A4 pages.
 * Both images are placed side by side, filling the page as much as possible.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Constants - A4 dimensions in mm
// ═══════════════════════════════════════════════════════════════════════════

// KEEP IN SYNC WITH styles.css :root — --page-margin, --gap and --svg-border are the same three
// numbers. app.js does the fitting maths, the CSS paints the result; if they drift, pages are laid
// out to one size and drawn at another.
const A4 = {
    width: 210,  // mm
    height: 297, // mm
    margin: 5,   // mm — white edge of the sheet. Was 10mm, which printed a wide white band around
                 //      every colouring page. 5mm is about as tight as a home printer goes; below
                 //      that most start clipping. Raise it again if Jirka's printer cuts anything off.
    gap: 6,      // mm between images
    border: 0    // mm border on SVG — was 1mm, which drew a black keyline around every colouring
                 //      page. The drawing frames itself; the line only ever boxed it in.
};

// Printable area (before rotation)
const PRINTABLE_RAW = {
    width: A4.width - 2 * A4.margin,   // 200mm
    height: A4.height - 2 * A4.margin  // 287mm
};

// After rotation, dimensions are swapped
const PRINTABLE = {
    width: PRINTABLE_RAW.height,   // 287mm
    height: PRINTABLE_RAW.width    // 200mm
};

// ═══════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════

const state = {
    pairs: [],
    objectUrls: [],
    mode: 'gallery',  // 'gallery' or 'fullpage'
    title: '',
    selectedCoverIndexes: [],
    rotationMin: -8,
    rotationMax: 8,
    printPdfMode: true,  // When true, adds empty pages for print layout
    coverScale: 100,     // Manual scale for cover images (50-100%)
    coverVariant: 'classic',  // 'classic' (SVG grid) or 'pencils' (photo + coloring pairs)
    language: 'cz'  // 'cz' or 'de' — branding on generated pages; UI-only, resets to CZ on load
};

/**
 * Max number of selectable cover images for the current variant.
 * Pencils variant shows photo + coloring pairs, so it fits fewer.
 */
function getCoverSelectionLimit() {
    return state.coverVariant === 'pencils' ? 2 : 8;
}

/**
 * Pencils-cover layout accessor. Returns the baked default from
 * cover-layout.js unless the tuning overlay (tuning.js) has swapped in a
 * session copy — the seam the overlay uses without app.js knowing about it.
 */
function currentCoverLayout() {
    return (window.Tuning && window.Tuning.sessionLayout) || COVER_LAYOUT;
}

/**
 * Logo asset for the current output language. DE has only a vertical logo,
 * so DE mode always resolves to it — including on the pencils cover, where
 * it overrides the horizontal variant option (see createTitlePage).
 */
function logoSrc() {
    return state.language === 'de' ? './logo-de.svg' : './logo.svg';
}

/**
 * Effective pencils-cover logo config for the current language. The DE logo
 * is wider per unit height, so DE scales the stamped width up so the logo
 * renders at the same HEIGHT as the CZ vertical logo in the tuned layout.
 */
function pencilsLogoConfig(layout) {
    if (state.language !== 'de') return layout.logo;
    const scale = LOGO_DE_ASPECT_RATIO / layout.logo.aspectRatio.vertical;
    return { ...layout.logo, width: layout.logo.width * scale };
}

/** Tuning-overlay sync hook (tuning.js) — no-op when the overlay is absent. */
function syncTuning() {
    if (window.Tuning && Tuning.sync) Tuning.sync();
}

/**
 * Post-append passes shared by renderPages() and rerenderTitlePage():
 * clamp pencils-cover pairs if logo + title overflow the printable height
 * (inert with the baked defaults, which fit), then sync the tuning overlay.
 */
function finishPencilCoverRender() {
    adjustPencilCoverFit();
    syncTuning();
}

// ═══════════════════════════════════════════════════════════════════════════
// DOM Elements
// ═══════════════════════════════════════════════════════════════════════════

const folderInput = document.getElementById('folderInput');
const printBtn = document.getElementById('printBtn');
const statusEl = document.getElementById('status');
const pagesContainer = document.getElementById('pagesContainer');
const emptyState = document.getElementById('emptyState');
const modeButtons = document.querySelectorAll('.mode-btn');
const titleInput = document.getElementById('titleInput');
const coverSelection = document.getElementById('coverSelection');
const titleConfig = document.getElementById('titleConfig');
const rotationMinInput = document.getElementById('rotationMin');
const rotationMaxInput = document.getElementById('rotationMax');
const rotationControls = document.getElementById('rotationControls');
const printPdfModeInput = document.getElementById('printPdfMode');
const pdfToggle = document.getElementById('pdfToggle');
const coverScaleInput = document.getElementById('coverScale');
const coverScaleValue = document.getElementById('coverScaleValue');
const coverScaleRow = document.getElementById('coverScaleRow');
const addAllCoverBtn = document.getElementById('addAllCoverBtn');
const coverVariantButtons = document.querySelectorAll('.cover-variant-btn');
const coverVariantHint = document.getElementById('coverVariantHint');
const langToggle = document.getElementById('langToggle');
const langButtons = document.querySelectorAll('.lang-btn');

// Initially hide title config, rotation controls, pdf toggle, and language toggle
titleConfig.classList.add('hidden');
rotationControls.classList.add('hidden');
pdfToggle.classList.add('hidden');
langToggle.classList.add('hidden');

// ═══════════════════════════════════════════════════════════════════════════
// Event Listeners
// ═══════════════════════════════════════════════════════════════════════════

folderInput.addEventListener('change', handleFolderSelect);
printBtn.addEventListener('click', () => window.print());
modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const newMode = btn.dataset.mode;
        if (newMode === state.mode) return;
        
        state.mode = newMode;
        modeButtons.forEach(b => b.classList.toggle('active', b.dataset.mode === newMode));
        
        // Show rotation controls only in fullpage mode when we have images
        updateRotationControlsVisibility();
        
        renderPages();
    });
});

// Title input
titleInput.addEventListener('input', (e) => {
    state.title = e.target.value;
    renderPages();
});

// Rotation inputs
rotationMinInput.addEventListener('change', (e) => {
    state.rotationMin = parseInt(e.target.value, 10) || -8;
    renderPages();
});

rotationMaxInput.addEventListener('change', (e) => {
    state.rotationMax = parseInt(e.target.value, 10) || 8;
    renderPages();
});

// Randomize button - regenerates the collage layout
document.getElementById('randomizeBtn').addEventListener('click', () => {
    renderPages();
});

// Print PDF mode toggle
printPdfModeInput.addEventListener('change', (e) => {
    state.printPdfMode = e.target.checked;
    renderPages();
});

// Cover scale input
coverScaleInput.addEventListener('input', (e) => {
    state.coverScale = parseInt(e.target.value, 10);
    coverScaleValue.textContent = `${state.coverScale}%`;
    renderPages();
});

// Cover layout variant toggle (classic grid vs pencils pairs)
coverVariantButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const variant = btn.dataset.coverVariant;
        if (variant === state.coverVariant) return;

        state.coverVariant = variant;
        coverVariantButtons.forEach(b => b.classList.toggle('active', b.dataset.coverVariant === variant));
        updateCoverVariantHint();

        // Trim selection if it exceeds the new variant's limit
        const limit = getCoverSelectionLimit();
        if (state.selectedCoverIndexes.length > limit) {
            state.selectedCoverIndexes = state.selectedCoverIndexes.slice(0, limit);
        }

        // Rebuild the grid so thumbnails match the variant (photos vs colorings)
        if (state.pairs.length > 0) {
            generateCoverSelection({ preserveSelection: true });
        }

        renderPages();
    });
});

// Output language toggle (CZ vs DE branding on generated pages)
langButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const lang = btn.dataset.lang;
        if (lang === state.language) return;

        state.language = lang;
        langButtons.forEach(b => b.classList.toggle('active', b.dataset.lang === lang));

        renderPages();
    });
});

function updateCoverVariantHint() {
    if (!coverVariantHint) return;
    coverVariantHint.textContent = state.coverVariant === 'pencils'
        ? 'Photo + coloring pairs with crayon decorations (max 2 images).'
        : 'Coloring images arranged in a grid (max 8).';
}

// Add all cover images button
addAllCoverBtn.addEventListener('click', () => {
    if (state.pairs.length === 0) return;

    // Select all images (up to the variant's limit)
    const maxImages = Math.min(state.pairs.length, getCoverSelectionLimit());
    state.selectedCoverIndexes = [];
    for (let i = 0; i < maxImages; i++) {
        state.selectedCoverIndexes.push(i);
    }
    
    // Update UI to show all as selected
    const items = coverSelection.querySelectorAll('.cover-grid-item');
    items.forEach((item, i) => {
        item.classList.toggle('selected', i < maxImages);
    });
    
    updateCoverScaleVisibility();
    renderPages();
});

/**
 * Show/hide cover scale control based on selected images
 */
function updateCoverScaleVisibility() {
    const show = state.selectedCoverIndexes.length > 0;
    coverScaleRow.classList.toggle('visible', show);
}

/**
 * Show/hide rotation controls based on mode and image count
 */
function updateRotationControlsVisibility() {
    const show = state.mode === 'fullpage' && state.pairs.length > 0;
    rotationControls.classList.toggle('hidden', !show);
}

// ═══════════════════════════════════════════════════════════════════════════
// File Handling
// ═══════════════════════════════════════════════════════════════════════════

async function handleFolderSelect(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    
    // Cleanup previous URLs
    state.objectUrls.forEach(url => URL.revokeObjectURL(url));
    state.objectUrls = [];
    state.pairs = [];
    
    updateStatus('Processing files...', false);
    
    // Group files by base name
    const grouped = groupFilesByBaseName(files);
    
    // Build pairs (photo + svg)
    const pairs = [];
    
    for (const [baseName, assets] of grouped.entries()) {
        // Skip if no original photo
        if (!assets.photo) continue;
        
        // Need either SVG with _bw or without
        const svg = assets.svg;
        if (!svg) continue;
        
        // Create object URLs
        const photoUrl = URL.createObjectURL(assets.photo);
        const svgUrl = URL.createObjectURL(svg);
        state.objectUrls.push(photoUrl, svgUrl);
        
        // Check if photo is JPEG (for collage filtering)
        const photoName = assets.photo.name.toLowerCase();
        const isJpeg = photoName.endsWith('.jpg') || photoName.endsWith('.jpeg');
        
        // Get image dimensions
        const [photoDims, svgDims] = await Promise.all([
            getImageDimensions(photoUrl),
            getImageDimensions(svgUrl)
        ]);
        
        pairs.push({
            name: baseName,
            photo: { url: photoUrl, isJpeg, ...photoDims },
            svg: { url: svgUrl, ...svgDims }
        });
    }
    
    state.pairs = pairs;
    
    if (pairs.length === 0) {
        updateStatus('No matching photo + SVG pairs found. Make sure you have .jpg/.jpeg photos with matching .svg or _bw.svg files.', false);
        renderPages();
        return;
    }
    
    const folderName = files[0].webkitRelativePath?.split('/')[0] || 'folder';
    updateStatus(`Loaded ${pairs.length} pair${pairs.length !== 1 ? 's' : ''} from "${folderName}"`, true);
    printBtn.disabled = false;
    
    // Show title config, PDF toggle, and language toggle, generate cover selection grid
    titleConfig.classList.remove('hidden');
    pdfToggle.classList.remove('hidden');
    langToggle.classList.remove('hidden');
    updateRotationControlsVisibility();
    generateCoverSelection();
    renderPages();
}

/**
 * Generate the cover selection grid with all loaded images.
 * Thumbnails show what leads the cover: original photos in pencils mode,
 * coloring SVGs in classic mode.
 */
function generateCoverSelection({ preserveSelection = false } = {}) {
    coverSelection.innerHTML = '';
    if (!preserveSelection) {
        state.selectedCoverIndexes = [];
    }
    updateCoverScaleVisibility();

    if (state.pairs.length === 0) {
        coverSelection.innerHTML = '<div class="cover-grid-empty">Load a folder first to select cover images</div>';
        return;
    }

    state.pairs.forEach((pair, i) => {
        const item = document.createElement('div');
        item.className = 'cover-grid-item';
        item.dataset.index = i;
        if (state.selectedCoverIndexes.includes(i)) {
            item.classList.add('selected');
        }

        const img = document.createElement('img');
        img.src = state.coverVariant === 'pencils' ? pair.photo.url : pair.svg.url;
        img.alt = pair.name;
        item.appendChild(img);

        item.addEventListener('click', () => toggleCoverSelection(i, item));

        coverSelection.appendChild(item);
    });
}

/**
 * Toggle a cover image selection. When the variant's limit is reached,
 * picking a new image replaces the oldest pick instead of being ignored,
 * so the user can always choose the ones they like.
 */
function toggleCoverSelection(index, item) {
    const selectedIndex = state.selectedCoverIndexes.indexOf(index);

    if (selectedIndex > -1) {
        // Deselect
        state.selectedCoverIndexes.splice(selectedIndex, 1);
        item.classList.remove('selected');
    } else {
        if (state.selectedCoverIndexes.length >= getCoverSelectionLimit()) {
            // Swap out the oldest selection
            const removed = state.selectedCoverIndexes.shift();
            const removedItem = coverSelection.querySelector(`.cover-grid-item[data-index="${removed}"]`);
            if (removedItem) removedItem.classList.remove('selected');
        }
        state.selectedCoverIndexes.push(index);
        item.classList.add('selected');
    }

    updateCoverScaleVisibility();
    renderPages();
}

/**
 * Group files by their base name (without _bw suffix and extension)
 */
function groupFilesByBaseName(files) {
    const grouped = new Map();
    
    for (const file of files) {
        const name = file.name;
        const lowerName = name.toLowerCase();
        
        // Skip _bw.png files
        if (lowerName.endsWith('_bw.png')) continue;
        
        // Determine file type and base name
        let baseName, type;
        
        if (lowerName.endsWith('.svg')) {
            // SVG file - remove _bw if present and extension
            baseName = name.replace(/_bw\.svg$/i, '').replace(/\.svg$/i, '');
            type = 'svg';
        } else if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) {
            // Photo - skip if it has _bw
            if (lowerName.includes('_bw')) continue;
            baseName = name.replace(/\.(jpg|jpeg)$/i, '');
            type = 'photo';
        } else if (lowerName.endsWith('.png') && !lowerName.includes('_bw')) {
            // Regular PNG (original photo, not _bw)
            baseName = name.replace(/\.png$/i, '');
            type = 'photo';
        } else {
            continue;
        }
        
        // Normalize base name for matching
        const normalizedBase = baseName.toLowerCase();
        
        if (!grouped.has(normalizedBase)) {
            grouped.set(normalizedBase, { baseName, photo: null, svg: null });
        }
        
        const entry = grouped.get(normalizedBase);
        if (type === 'photo') {
            // Prioritize JPEG over PNG - only set if no photo exists or current is PNG and new is JPEG
            const isJpeg = lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg');
            const currentIsJpeg = entry.photo && (entry.photo.name.toLowerCase().endsWith('.jpg') || entry.photo.name.toLowerCase().endsWith('.jpeg'));
            if (!entry.photo || (!currentIsJpeg && isJpeg)) {
                entry.photo = file;
            }
        } else if (type === 'svg' && !entry.svg) {
            entry.svg = file;
        }
    }
    
    return grouped;
}

/**
 * Get image dimensions by loading it
 */
function getImageDimensions(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            resolve({
                width: img.naturalWidth,
                height: img.naturalHeight,
                aspect: img.naturalWidth / img.naturalHeight
            });
        };
        img.onerror = () => {
            resolve({ width: 100, height: 100, aspect: 1 });
        };
        img.src = url;
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Layout Calculation - The Core Algorithm
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Determine if images are portrait or landscape orientation
 */
function isPortrait(photo, svg) {
    // Use average aspect ratio to determine orientation
    const avgAspect = (photo.width / photo.height + svg.width / svg.height) / 2;
    return avgAspect < 1; // Portrait if taller than wide
}

/**
 * Calculate layout for PORTRAIT images (side by side, rotated counter-clockwise -90°)
 * When printed and rotated to view, images are side by side filling the page
 */
function calculatePortraitLayout(photo, svg) {
    const border = A4.border;
    const borderTotal = border * 2;
    
    // After -90° rotation: width=287mm, height=200mm
    const availW = PRINTABLE.width;   // 287mm
    const availH = PRINTABLE.height;  // 200mm
    
    const photoAR = photo.width / photo.height;
    const svgAR = svg.width / svg.height;
    
    // Side by side: find max height where both fit horizontally
    const maxHForWidth = (availW - A4.gap - borderTotal) / (photoAR + svgAR);
    const maxHForHeight = availH - borderTotal;
    const h = Math.min(maxHForWidth, maxHForHeight);
    
    const photoW = h * photoAR;
    const photoH = h;
    const svgContentW = h * svgAR;
    const svgContentH = h;
    const svgOuterW = svgContentW + borderTotal;
    const svgOuterH = svgContentH + borderTotal;
    
    const totalW = photoW + A4.gap + svgOuterW;
    const totalH = Math.max(photoH, svgOuterH);
    
    return {
        layout: 'side-by-side',
        rotation: -90,  // Counter-clockwise (as before)
        photo: { width: photoW, height: photoH },
        svg: { contentWidth: svgContentW, contentHeight: svgContentH, outerWidth: svgOuterW, outerHeight: svgOuterH },
        totalWidth: totalW,
        totalHeight: totalH
    };
}

/**
 * Calculate STACKED layout (no rotation, vertical stack)
 */
function calculateStackedLayout(photo, svg) {
    const border = A4.border;
    const borderTotal = border * 2;
    
    // No rotation: use normal A4 portrait dimensions
    const availW = PRINTABLE_RAW.width;   // 200mm
    const availH = PRINTABLE_RAW.height;  // 287mm
    
    const photoAR = photo.width / photo.height;
    const svgAR = svg.width / svg.height;
    
    // Stacked vertically: images share the width, split the height
    const maxWForWidth = availW - borderTotal;
    const maxWForHeight = (availH - A4.gap - borderTotal) / (1/photoAR + 1/svgAR);
    const w = Math.min(maxWForWidth, maxWForHeight);
    
    const photoW = w;
    const photoH = w / photoAR;
    const svgContentW = w;
    const svgContentH = w / svgAR;
    const svgOuterW = svgContentW + borderTotal;
    const svgOuterH = svgContentH + borderTotal;
    
    const totalW = Math.max(photoW, svgOuterW);
    const totalH = photoH + A4.gap + svgOuterH;
    
    // Calculate total image area for comparison
    const totalArea = (photoW * photoH) + (svgContentW * svgContentH);
    
    return {
        layout: 'stacked',
        rotation: 0,
        photo: { width: photoW, height: photoH },
        svg: { contentWidth: svgContentW, contentHeight: svgContentH, outerWidth: svgOuterW, outerHeight: svgOuterH },
        totalWidth: totalW,
        totalHeight: totalH,
        totalArea
    };
}

/**
 * Calculate SIDE-BY-SIDE layout (rotated -90°, horizontal)
 */
function calculateSideBySideLayout(photo, svg) {
    const border = A4.border;
    const borderTotal = border * 2;
    
    // After -90° rotation: width=287mm, height=200mm
    const availW = PRINTABLE.width;   // 287mm
    const availH = PRINTABLE.height;  // 200mm
    
    const photoAR = photo.width / photo.height;
    const svgAR = svg.width / svg.height;
    
    // Side by side: find max height where both fit horizontally
    const maxHForWidth = (availW - A4.gap - borderTotal) / (photoAR + svgAR);
    const maxHForHeight = availH - borderTotal;
    const h = Math.min(maxHForWidth, maxHForHeight);
    
    const photoW = h * photoAR;
    const photoH = h;
    const svgContentW = h * svgAR;
    const svgContentH = h;
    const svgOuterW = svgContentW + borderTotal;
    const svgOuterH = svgContentH + borderTotal;
    
    const totalW = photoW + A4.gap + svgOuterW;
    const totalH = Math.max(photoH, svgOuterH);
    
    // Calculate total image area for comparison
    const totalArea = (photoW * photoH) + (svgContentW * svgContentH);
    
    return {
        layout: 'side-by-side',
        rotation: -90,
        photo: { width: photoW, height: photoH },
        svg: { contentWidth: svgContentW, contentHeight: svgContentH, outerWidth: svgOuterW, outerHeight: svgOuterH },
        totalWidth: totalW,
        totalHeight: totalH,
        totalArea
    };
}

/**
 * Calculate layout for LANDSCAPE images
 * Default to stacked (no rotation), but use side-by-side if it results in larger images
 */
function calculateLandscapeLayout(photo, svg) {
    const stacked = calculateStackedLayout(photo, svg);
    const sideBySide = calculateSideBySideLayout(photo, svg);
    
    // Pick the layout that results in larger total image area
    if (sideBySide.totalArea > stacked.totalArea) {
        return sideBySide;
    }
    return stacked;
}

/**
 * Calculate optimal layout based on image orientation
 */
function calculateGalleryLayout(photo, svg) {
    if (isPortrait(photo, svg)) {
        return calculatePortraitLayout(photo, svg);
    } else {
        return calculateLandscapeLayout(photo, svg);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create an empty page (for print PDF layout)
 */
function createEmptyPage() {
    const page = document.createElement('article');
    page.className = 'a4-page empty-page';
    return page;
}

function renderPages() {
    // Clear existing pages
    pagesContainer.innerHTML = '';

    if (state.pairs.length === 0) {
        pagesContainer.appendChild(createEmptyState());
        syncTuning();
        return;
    }

    // Always render title page first (if there's a title or selected cover images)
    if (state.title || state.selectedCoverIndexes.length > 0) {
        const titlePage = createTitlePage();
        pagesContainer.appendChild(titlePage);

        // In print PDF mode, add empty page after title
        if (state.printPdfMode) {
            pagesContainer.appendChild(createEmptyPage());
        }
    }

    if (state.mode === 'gallery') {
        renderGalleryMode();
    } else {
        renderFullPageMode();
    }

    finishPencilCoverRender();
}

/**
 * Post-append fit pass for the pencils cover.
 *
 * The pair sizes are stamped from the frame config at creation; this pass
 * only shrinks them (proportionally, at base scale — the cover-scale slider
 * stays a free multiplier on top) when logo + margins + measured title box
 * + pairs + gaps would overflow the printable height, e.g. after tuning the
 * logo to the taller-at-width horizontal variant. The title box is the only
 * measured element; the logo height derives from the config aspect ratio.
 * With today's baked defaults nothing overflows, so this never changes sizes.
 */
function adjustPencilCoverFit() {
    if (state.coverVariant !== 'pencils') return;
    const content = pagesContainer.querySelector('.title-page-pencils');
    if (!content) return;
    const container = content.querySelector('.pencil-pairs-container');
    if (!container) return;

    const layout = currentCoverLayout();
    const contentH = A4.height - 2 * A4.margin; // printable height, 287mm

    // Logo block: height from config aspect ratio, never measured. DE mode
    // renders the DE logo (always vertical) at a width scaled to match the
    // CZ logo's height — pencilsLogoConfig carries the scaled width, and the
    // DE ratio lives outside the tunable layout config (see
    // LOGO_DE_ASPECT_RATIO in cover-layout.js).
    const logoCfg = pencilsLogoConfig(layout);
    const logoAR = state.language === 'de'
        ? LOGO_DE_ASPECT_RATIO
        : (layout.logo.aspectRatio[layout.logo.variant] || layout.logo.aspectRatio.vertical);
    const logoH = logoCfg.width / logoAR;
    let usedMm = logoCfg.marginTop + logoH + logoCfg.marginBottom;

    // Title box: the only measured element (px converted via the page rect)
    const titleBox = content.querySelector('[data-tune-id="title-box"]');
    if (titleBox) {
        const pxPerMm = content.getBoundingClientRect().width / A4.width;
        if (pxPerMm <= 0) return; // not laid out — nothing to measure against
        usedMm += titleBox.getBoundingClientRect().height / pxPerMm;
        if (layout.titleBox.marginTop != null) usedMm += layout.titleBox.marginTop;
        usedMm += layout.titleBox.marginBottom != null ? layout.titleBox.marginBottom : 3;
    }

    // Chrome around the pairs (.pencil-pairs-container CSS: padding 3mm 0,
    // margin-bottom 18mm)
    const containerChromeMm = 6 + 18;

    const numRows = container.querySelectorAll('.pencil-pair').length;
    const gapsMm = layout.frame.rowGap * Math.max(0, numRows - 1);
    const availForRowsMm = contentH - usedMm - containerChromeMm - gapsMm;

    // Base (pre-slider) height the stamped rows need, recorded at creation
    const baseNeededMm = parseFloat(container.dataset.pairsBaseHeightMm);
    if (!(baseNeededMm > 0) || availForRowsMm <= 0) return;
    if (baseNeededMm <= availForRowsMm) return; // fits — clamp stays inert

    const factor = availForRowsMm / baseNeededMm;
    container.querySelectorAll('.pencil-pair-item').forEach(item => {
        ['width', 'height', 'marginLeft', 'marginTop'].forEach(prop => {
            const value = parseFloat(item.style[prop]);
            if (!Number.isNaN(value)) item.style[prop] = `${value * factor}mm`;
        });
    });
}

/**
 * Scoped re-render for the tuning overlay (tuning.js): rebuild only the
 * title page, replacing its node in place — gallery pages are untouched.
 * Frame, stain, logo, and title-box geometry is render-computed, so panel
 * edits to those rebuild this one page instead of the whole book. No-op
 * when no title page is rendered.
 */
function rerenderTitlePage() {
    const content = pagesContainer.querySelector('.title-page-content');
    const oldPage = content ? content.closest('.a4-page') : null;
    if (!oldPage) return;
    oldPage.replaceWith(createTitlePage());
    // Same post-append passes renderPages() runs, scoped to the fresh page
    finishPencilCoverRender();
}

/**
 * Gallery mode: photo + coloring side by side or stacked
 */
function renderGalleryMode() {
    for (const pair of state.pairs) {
        const page = createA4Page(pair);
        pagesContainer.appendChild(page);
        
        // In print PDF mode, add empty page after each gallery page
        if (state.printPdfMode) {
            pagesContainer.appendChild(createEmptyPage());
        }
    }
    
    // In print PDF mode, add 2 empty pages before the last page
    if (state.printPdfMode) {
        pagesContainer.appendChild(createEmptyPage());
    }
    
    // Add last page with border and logo
    const lastPage = createLastPage();
    pagesContainer.appendChild(lastPage);
}

/**
 * Create the last page (Gallery mode) - just border and logo at bottom
 */
function createLastPage() {
    const page = document.createElement('article');
    page.className = 'a4-page';
    
    const content = document.createElement('div');
    content.className = 'last-page-content';
    
    const logo = document.createElement('img');
    logo.src = logoSrc();
    logo.alt = 'Fotomalovánky';
    logo.className = 'last-page-logo';
    content.appendChild(logo);
    
    page.appendChild(content);
    return page;
}

/**
 * Full page mode: each coloring on its own page, photos in collage at end
 */
function renderFullPageMode() {
    // Render each coloring page full size
    for (let i = 0; i < state.pairs.length; i++) {
        const pair = state.pairs[i];
        const page = createFullColoringPage(pair);
        pagesContainer.appendChild(page);
        
        // In print PDF mode, add empty page after each coloring page
        if (state.printPdfMode) {
            pagesContainer.appendChild(createEmptyPage());
        }
    }
    
    // Render collage pages with photos using CollageLayout
    // Only include JPEG photos (filter out PNG)
    const photos = state.pairs.map(p => p.photo).filter(p => p && p.isJpeg);
    
    // Shuffle photos for random distribution across pages
    shuffleArray(photos);
    
    const totalPhotos = photos.length;
    
    if (totalPhotos === 0) return;
    
    // Determine how many pages we need (max ~8 photos per page for good sizing)
    let photosPerPage, collagePages;
    if (totalPhotos <= 8) {
        photosPerPage = totalPhotos;
        collagePages = 1;
    } else {
        // Split evenly across 2 pages
        collagePages = 2;
        photosPerPage = Math.ceil(totalPhotos / 2);
    }
    
    // In print PDF mode with only 1 collage page, add extra empty page
    // So layout is: LastColoring, Empty, Empty, Collage
    if (state.printPdfMode && collagePages === 1) {
        pagesContainer.appendChild(createEmptyPage());
    }
    
    for (let i = 0; i < collagePages; i++) {
        const startIdx = i * photosPerPage;
        const endIdx = i === collagePages - 1 ? totalPhotos : startIdx + photosPerPage;
        const pagePhotos = photos.slice(startIdx, endIdx);
        const collagePage = createCollagePage(pagePhotos);
        pagesContainer.appendChild(collagePage);
    }
}

function createEmptyState() {
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.innerHTML = `
        <div class="empty-icon">🎨</div>
        <p>No pages yet. Load a folder to start building your gallery.</p>
    `;
    return div;
}

/**
 * Create the title/cover page with logo, title, and selected images
 */
function createTitlePage() {
    const page = document.createElement('article');
    page.className = 'a4-page';

    const content = document.createElement('div');
    content.className = 'title-page-content';

    const isPencils = state.coverVariant === 'pencils';
    const layout = isPencils ? currentCoverLayout() : null;
    if (isPencils) {
        content.classList.add('title-page-pencils');

        // Crayon decorations around the page edges — geometry from the layout
        // config, stamped inline in mm/deg (shared helper in cover-layout.js)
        ['blue', 'red', 'green', 'yellow'].forEach(color => {
            const pencil = document.createElement('img');
            pencil.src = `./cover-pencil-${color}.png`;
            pencil.alt = '';
            pencil.className = `cover-pencil cover-pencil-${color}`;
            pencil.dataset.tuneId = `pencil-${color}`;
            stampPencil(pencil, layout.pencils[color]);
            content.appendChild(pencil);
        });
    }

    // Logo
    const logo = document.createElement('img');
    logo.src = logoSrc();
    logo.alt = 'Fotomalovánky';
    logo.className = 'title-logo';
    // DE logo is wider per unit height — the class scales the classic cover's
    // CSS width up so the rendered height matches the CZ logo (the pencils
    // path does the same via pencilsLogoConfig's inline width, which wins
    // over this class).
    if (state.language === 'de') logo.classList.add('logo-de');
    if (isPencils) {
        // Pencils variant: size/margins from the layout config (inline styles
        // override the shared .title-logo CSS, which stays authoritative for
        // the classic variant). DE always uses the vertical DE logo — no
        // horizontal DE asset exists, so the variant option applies to CZ only.
        logo.src = state.language === 'de'
            ? logoSrc()
            : (layout.logo.variant === 'horizontal' ? './logo-horizontal.svg' : './logo.svg');
        logo.dataset.tuneId = 'logo';
        stampLogo(logo, pencilsLogoConfig(layout));
    }
    content.appendChild(logo);

    // Title/dedication (only if provided)
    if (state.title) {
        const dedication = document.createElement('div');
        dedication.className = 'title-dedication';
        // Support newlines and <br> for line breaks
        dedication.innerHTML = state.title.replace(/\n/g, '<br>');
        if (isPencils) {
            dedication.dataset.tuneId = 'title-box';
            // Optional overrides of the shared .title-dedication CSS
            // (shared helper in cover-layout.js)
            stampTitleBox(dedication, layout.titleBox);
        }
        content.appendChild(dedication);
    }

    // Selected cover images
    if (isPencils && state.selectedCoverIndexes.length > 0) {
        content.appendChild(createPencilCoverPairs());
    } else if (state.selectedCoverIndexes.length > 0) {
        const imagesContainer = document.createElement('div');
        imagesContainer.className = 'title-images-container';
        
        // Get selected SVGs
        const selectedSvgs = state.selectedCoverIndexes.map(i => state.pairs[i].svg);
        
        // Calculate optimal sizes for cover images
        const coverLayout = calculateCoverLayout(selectedSvgs);
        const preferredLayout = coverLayout.layout; // e.g., [2, 2] for 4 images
        
        // Render images in explicit rows to enforce the layout
        let imageIndex = 0;
        preferredLayout.forEach((imagesInRow) => {
            const rowContainer = document.createElement('div');
            rowContainer.className = 'title-images-row';
            
            for (let i = 0; i < imagesInRow && imageIndex < selectedSvgs.length; i++) {
                const svg = selectedSvgs[imageIndex];
                const size = coverLayout.sizes[imageIndex];
                const rotation = coverLayout.rotations[imageIndex];
                
                const imgContainer = document.createElement('div');
                imgContainer.className = 'title-cover-image';
                imgContainer.style.width = `${size.width}mm`;
                imgContainer.style.height = `${size.height}mm`;
                imgContainer.style.transform = `rotate(${rotation}deg)`;
                
                const img = document.createElement('img');
                img.src = svg.url;
                img.alt = 'Cover image';
                imgContainer.appendChild(img);
                
                rowContainer.appendChild(imgContainer);
                imageIndex++;
            }
            
            imagesContainer.appendChild(rowContainer);
        });
        
        content.appendChild(imagesContainer);
    }
    
    // Footer — Czech only; the DE cover bottom stays empty for now
    if (state.language !== 'de') {
        const footer = document.createElement('div');
        footer.className = 'title-footer';
        footer.innerHTML = `Vyrobeno s <img src="./icon-heart.svg" alt="❤️"> v <img src="./icon-cz-flag.svg" alt="🇨🇿">`;
        content.appendChild(footer);
    }
    
    page.appendChild(content);
    return page;
}

/**
 * Pencils cover variant: each selected image renders as a pair of
 * original photo + coloring version, overlapping slightly, each sitting
 * on a colored crayon-scribble background.
 */
function createPencilCoverPairs() {
    const container = document.createElement('div');
    container.className = 'pencil-pairs-container';

    const selectedPairs = state.selectedCoverIndexes.map(i => state.pairs[i]);

    // Scribble colors per pair: [photo color, svg color]
    const pairColors = [['blue', 'red'], ['green', 'yellow']];

    // Frame parameters (mm / fractions) from the layout config
    const frame = currentCoverLayout().frame;
    const hasTitle = state.title && state.title.trim().length > 0;
    const newlineCount = hasTitle ? (state.title.match(/\n/g) || []).length : 0;
    const availW = frame.areaW;
    const availH = hasTitle
        ? frame.areaHTitled - (newlineCount * frame.titleLineReduction)
        : frame.areaHUntitled;
    const rowGap = frame.rowGap;
    const overlapFrac = frame.overlapFrac;
    const dyFrac = frame.dyFrac;

    container.style.gap = `${rowGap}mm`;

    const numRows = selectedPairs.length;

    // Per-row width-capped image height and the vertical space that height
    // needs (the lineart's dyFrac shift rides below the images)
    const rowSpecs = selectedPairs.map(pair => {
        const photoAR = pair.photo.width / pair.photo.height;
        const svgAR = pair.svg.width / pair.svg.height;
        const widthCapH = availW / (photoAR + svgAR * (1 - overlapFrac));
        return { photoAR, svgAR, needMm: widthCapH * (1 + dyFrac) };
    });

    // Waterfill the vertical budget instead of an equal split: a row whose
    // width cap needs less than its fair share (e.g. a landscape pair) keeps
    // only what it needs, and the freed space grows the other rows (e.g. a
    // portrait pair). Equal needs degrade to the old equal split exactly.
    const budgetMm = availH - rowGap * (numRows - 1);
    const rowAllocsMm = waterfillRowAllocations(rowSpecs.map(r => r.needMm), budgetMm);

    // Total base-scale row height, recorded for the post-append fit clamp
    let baseRowsHeightMm = 0;

    selectedPairs.forEach((pair, rowIndex) => {
        const { photoAR, svgAR } = rowSpecs[rowIndex];

        // Image height from this row's allocated vertical space — already
        // width-capped by the waterfill (alloc never exceeds the need)
        let h = rowAllocsMm[rowIndex] / (1 + dyFrac);
        h *= frame.scale / 100;
        baseRowsHeightMm += h * (1 + dyFrac);
        h *= state.coverScale / 100;

        const photoW = h * photoAR;
        const svgW = h * svgAR;
        const overlapX = svgW * overlapFrac;
        const dy = h * dyFrac;

        const row = document.createElement('div');
        row.className = 'pencil-pair';

        const [photoColor, svgColor] = pairColors[rowIndex % pairColors.length];

        const photoItem = createPencilPairItem(pair.photo.url, photoColor, photoW, h, 'photo', rowIndex);
        const svgItem = createPencilPairItem(pair.svg.url, svgColor, svgW, h, 'svg', rowIndex);
        svgItem.style.marginLeft = `${-overlapX}mm`;
        svgItem.style.marginTop = `${dy}mm`;

        row.appendChild(photoItem);
        row.appendChild(svgItem);
        container.appendChild(row);
    });

    container.dataset.pairsBaseHeightMm = String(baseRowsHeightMm);

    return container;
}

/**
 * Waterfill a vertical budget (mm) across per-row needs (mm).
 *
 * Every row would like its width-capped vertical need. If the needs all fit
 * the budget, each row gets exactly its need (all rows width-bound). If not,
 * rows needing no more than their fair share of the remaining budget keep
 * their full need, and the leftover is split evenly among the rest —
 * iterated until stable, because satisfying a cheap row raises the fair
 * share for the others. Degenerate cases match the old equal split: equal
 * needs give equal shares, and a single row gets min(budget, need).
 *
 * Returns the allocation array (same order as needs); alloc_i <= need_i
 * always, so a row can never be stretched past its width cap.
 */
function waterfillRowAllocations(needs, budget) {
    const totalNeed = needs.reduce((sum, v) => sum + v, 0);
    if (totalNeed <= budget) return needs.slice(); // everything width-bound

    const alloc = new Array(needs.length).fill(0);
    const remaining = needs.map((_, i) => i); // indexes still competing
    let left = budget;
    for (;;) {
        const fair = left / remaining.length;
        const satisfied = remaining.filter(i => needs[i] <= fair);
        if (satisfied.length === 0) {
            // Nobody fits inside the fair share — split it evenly
            remaining.forEach(i => { alloc[i] = fair; });
            return alloc;
        }
        satisfied.forEach(i => {
            alloc[i] = needs[i];
            left -= needs[i];
        });
        satisfied.forEach(i => remaining.splice(remaining.indexOf(i), 1));
        if (remaining.length === 0) return alloc; // float-edge: all satisfied
    }
}

/**
 * One image of a pencils-cover pair: scribble background + framed image
 */
function createPencilPairItem(url, scribbleColor, widthMm, heightMm, type, rowIndex) {
    const item = document.createElement('div');
    item.className = `pencil-pair-item pencil-pair-${type}`;
    item.style.width = `${widthMm}mm`;
    item.style.height = `${heightMm}mm`;

    const scribble = document.createElement('img');
    scribble.src = `./cover-bg-${scribbleColor}.png`;
    scribble.alt = '';
    scribble.className = 'pencil-scribble';
    scribble.dataset.tuneId = `stain-${rowIndex}-${type}`;
    // Stain geometry (corner-anchored, absolute mm) from the layout config;
    // falls back to row 0's entry if a row has no entry of its own (shared
    // helper in cover-layout.js)
    const stains = currentCoverLayout().stains;
    stampStain(scribble, stains[`${rowIndex}-${type}`] || stains[`0-${type}`]);
    item.appendChild(scribble);

    const frame = document.createElement('div');
    frame.className = 'pencil-frame';

    const img = document.createElement('img');
    img.src = url;
    img.alt = type === 'photo' ? 'Cover photo' : 'Cover coloring image';
    frame.appendChild(img);
    item.appendChild(frame);

    return item;
}

/**
 * Calculate optimal layout for cover images
 * Similar to photo grid but for the title page
 * Prefers balanced row layouts (e.g., 2+2 for 4 images)
 */
function calculateCoverLayout(svgs) {
    const hasTitle = state.title && state.title.trim().length > 0;
    const newlineCount = hasTitle ? (state.title.match(/\n/g) || []).length : 0;
    
    let availableWidth, availableHeight;
    
    if (hasTitle) {
        // With dedication: leave room for title + footer
        availableWidth = 188;
        availableHeight = 155 - (newlineCount * 12); // Deduct per extra line
    } else {
        // Without dedication: use maximum space
        availableWidth = 190;
        availableHeight = 180;
    }
    const gap = 6; // mm
    const maxRotation = 4; // degrees
    
    const numImages = svgs.length;
    
    // Determine preferred row configuration for balanced layouts
    const preferredLayout = getPreferredRowLayout(numImages);
    
    // Calculate sizes and rotations for each image
    const sizes = [];
    const rotations = [];
    
    // Calculate per-row sizing for balanced layout
    const { rowHeights, rowWidths } = calculateRowSizes(svgs, preferredLayout, availableWidth, availableHeight, gap);
    
    let imageIndex = 0;
    preferredLayout.forEach((imagesInRow, rowIndex) => {
        const rowWidth = rowWidths[rowIndex];
        const rowHeight = rowHeights[rowIndex];
        
        for (let i = 0; i < imagesInRow; i++) {
            const svg = svgs[imageIndex];
            const ar = svg.width / svg.height;
            
            // Calculate width based on row distribution
            let h = rowHeight;
            let w = h * ar;
            
            // Alternating rotation
            const direction = imageIndex % 2 === 0 ? 1 : -1;
            const rotation = direction * seededRandom(imageIndex + 100) * maxRotation;
            
            sizes.push({ width: w, height: h });
            rotations.push(rotation);
            imageIndex++;
        }
    });
    
    // Scale down to fit using the preferred layout
    let scale = 1;
    let bestScale = 0.1;
    
    for (let attempt = 0; attempt < 25; attempt++) {
        const testScale = (bestScale + scale) / 2;
        if (canFitCoverImagesBalanced(sizes, rotations, testScale, availableWidth, availableHeight, gap, preferredLayout)) {
            bestScale = testScale;
        } else {
            scale = testScale;
        }
    }
    
    // Apply manual scale from user control (state.coverScale is 50-200%)
    const manualScale = state.coverScale / 100;
    bestScale *= manualScale;
    
    // Apply scale
    const scaledSizes = sizes.map(s => ({
        width: s.width * bestScale,
        height: s.height * bestScale
    }));
    
    return { sizes: scaledSizes, rotations, layout: preferredLayout };
}

/**
 * Get preferred row layout for balanced image distribution
 * e.g., 4 images -> [2, 2], 5 images -> [3, 2], 6 images -> [3, 3]
 */
function getPreferredRowLayout(count) {
    switch (count) {
        case 1: return [1];
        case 2: return [2];
        case 3: return [2, 1]; // 2 top, 1 centered bottom
        case 4: return [2, 2]; // Balanced 2+2
        case 5: return [3, 2]; // 3 top, 2 bottom
        case 6: return [3, 3]; // Balanced 3+3
        case 7: return [4, 3]; // 4 top, 3 bottom
        case 8: return [4, 4]; // Balanced 4+4
        default: return [Math.ceil(count / 2), Math.floor(count / 2)];
    }
}

/**
 * Calculate row sizes for balanced layout
 */
function calculateRowSizes(svgs, layout, availableWidth, availableHeight, gap) {
    const numRows = layout.length;
    const totalGapHeight = gap * (numRows - 1);
    const rowHeight = (availableHeight - totalGapHeight) / numRows;
    
    const rowHeights = layout.map(() => rowHeight);
    const rowWidths = layout.map((count) => {
        const totalGapWidth = gap * (count - 1);
        return (availableWidth - totalGapWidth) / count;
    });
    
    return { rowHeights, rowWidths };
}

/**
 * Check if cover images fit at given scale with balanced layout
 */
function canFitCoverImagesBalanced(sizes, rotations, scale, maxWidth, maxHeight, gap, layout) {
    let imageIndex = 0;
    let totalHeight = 0;
    
    for (let rowIndex = 0; rowIndex < layout.length; rowIndex++) {
        const imagesInRow = layout[rowIndex];
        let rowWidth = 0;
        let rowHeight = 0;
        
        for (let i = 0; i < imagesInRow; i++) {
            const s = sizes[imageIndex];
            const rotation = rotations[imageIndex];
            const scaledW = s.width * scale;
            const scaledH = s.height * scale;
            
            const bbox = getRotatedBoundingBox(scaledW, scaledH, rotation);
            
            rowWidth += bbox.width + (i > 0 ? gap : 0);
            rowHeight = Math.max(rowHeight, bbox.height);
            imageIndex++;
        }
        
        // Check if row fits in width
        if (rowWidth > maxWidth) {
            return false;
        }
        
        totalHeight += rowHeight + (rowIndex > 0 ? gap : 0);
    }
    
    return totalHeight <= maxHeight;
}

/**
 * Legacy: Check if cover images fit at given scale (simple row-packing)
 */
function canFitCoverImages(sizes, rotations, scale, maxWidth, maxHeight, gap) {
    let currentRowWidth = 0;
    let currentRowHeight = 0;
    let totalHeight = 0;
    
    for (let i = 0; i < sizes.length; i++) {
        const s = sizes[i];
        const rotation = rotations[i];
        const scaledW = s.width * scale;
        const scaledH = s.height * scale;
        
        const bbox = getRotatedBoundingBox(scaledW, scaledH, rotation);
        
        if (currentRowWidth + bbox.width + (currentRowWidth > 0 ? gap : 0) <= maxWidth) {
            currentRowWidth += bbox.width + (currentRowWidth > 0 ? gap : 0);
            currentRowHeight = Math.max(currentRowHeight, bbox.height);
        } else {
            totalHeight += currentRowHeight + (totalHeight > 0 ? gap : 0);
            currentRowWidth = bbox.width;
            currentRowHeight = bbox.height;
        }
    }
    
    totalHeight += currentRowHeight;
    return totalHeight <= maxHeight;
}

function createA4Page(pair) {
    const layout = calculateGalleryLayout(pair.photo, pair.svg);
    
    const page = document.createElement('article');
    page.className = 'a4-page';
    
    const content = document.createElement('div');
    content.className = 'page-content';
    // Apply rotation and dimensions based on layout type
    content.dataset.rotation = layout.rotation;
    
    // Set dimensions based on rotation
    if (layout.rotation === 0) {
        // No rotation: normal portrait dimensions
        content.style.width = `${PRINTABLE_RAW.width}mm`;
        content.style.height = `${PRINTABLE_RAW.height}mm`;
        content.style.transform = `translate(-50%, -50%)`;
    } else {
        // Rotated: swapped dimensions
        content.style.width = `${PRINTABLE.width}mm`;
        content.style.height = `${PRINTABLE.height}mm`;
        content.style.transform = `translate(-50%, -50%) rotate(${layout.rotation}deg)`;
    }
    
    // Container for the pair - sized and centered
    const galleryPair = document.createElement('div');
    galleryPair.className = `gallery-pair ${layout.layout}`;
    galleryPair.style.cssText = `
        width: ${layout.totalWidth}mm;
        height: ${layout.totalHeight}mm;
    `;
    
    // Photo slot - no border
    const photoSlot = document.createElement('div');
    photoSlot.className = 'image-slot photo';
    photoSlot.style.cssText = `
        width: ${layout.photo.width}mm;
        height: ${layout.photo.height}mm;
    `;
    
    const photoImg = document.createElement('img');
    photoImg.src = pair.photo.url;
    photoImg.alt = `Photo: ${pair.name}`;
    photoSlot.appendChild(photoImg);
    
    // SVG slot - with 1mm black border
    // Using content-box so border adds to dimensions
    const svgSlot = document.createElement('div');
    svgSlot.className = 'image-slot coloring';
    svgSlot.style.cssText = `
        width: ${layout.svg.contentWidth}mm;
        height: ${layout.svg.contentHeight}mm;
        box-sizing: content-box;
        padding: 0;
    `;
    
    const svgImg = document.createElement('img');
    svgImg.src = pair.svg.url;
    svgImg.alt = `Coloring: ${pair.name}`;
    svgSlot.appendChild(svgImg);
    
    galleryPair.appendChild(photoSlot);
    galleryPair.appendChild(svgSlot);
    content.appendChild(galleryPair);
    
    page.appendChild(content);
    
    return page;
}

/**
 * Create a full page coloring page (SVG only, maximized with border)
 * Landscape images are rotated counter-clockwise to fill more space
 */
function createFullColoringPage(pair) {
    const page = document.createElement('article');
    page.className = 'a4-page';
    
    const content = document.createElement('div');
    content.className = 'full-page-content';
    
    // Calculate optimal size for the SVG
    const svg = pair.svg;
    const border = A4.border;
    const borderTotal = border * 2;
    
    const svgAR = svg.width / svg.height;
    const isLandscape = svgAR > 1;
    
    // Available area depends on rotation
    // Portrait: normal dimensions (190×277)
    // Landscape: rotated, so we use swapped dimensions (277×190)
    const availW = isLandscape 
        ? PRINTABLE_RAW.height - borderTotal  // 275mm (rotated width)
        : PRINTABLE_RAW.width - borderTotal;  // 188mm
    const availH = isLandscape
        ? PRINTABLE_RAW.width - borderTotal   // 188mm (rotated height)
        : PRINTABLE_RAW.height - borderTotal; // 275mm
    
    // Fit to available area maintaining aspect ratio
    let w, h;
    if (availW / availH > svgAR) {
        // Height constrained
        h = availH;
        w = h * svgAR;
    } else {
        // Width constrained
        w = availW;
        h = w / svgAR;
    }
    
    // Create the coloring container
    const coloringDiv = document.createElement('div');
    coloringDiv.className = 'full-coloring';
    coloringDiv.style.cssText = `
        width: ${w}mm;
        height: ${h}mm;
    `;
    
    // Apply rotation and proper centering for landscape images
    if (isLandscape) {
        // Override CSS positioning for rotated layout
        content.style.top = '50%';
        content.style.left = '50%';
        content.style.right = 'auto';
        content.style.bottom = 'auto';
        content.style.width = `${PRINTABLE_RAW.height}mm`;
        content.style.height = `${PRINTABLE_RAW.width}mm`;
        content.style.transform = 'translate(-50%, -50%) rotate(-90deg)';
    }
    
    const img = document.createElement('img');
    img.src = svg.url;
    img.alt = `Coloring: ${pair.name}`;
    coloringDiv.appendChild(img);
    
    content.appendChild(coloringDiv);
    page.appendChild(content);
    
    return page;
}

/**
 * Create a photo grid page (organic Pinterest layout with random rotations)
 * Images are balanced, slightly rotated, and fill the page
 */
function createPhotoGridPage(photos, pageNum, totalPages) {
    const page = document.createElement('article');
    page.className = 'a4-page';
    
    const content = document.createElement('div');
    content.className = 'photo-grid-content';
    
    const grid = document.createElement('div');
    grid.className = 'photo-grid';
    
    const gap = 5; // mm - ensure no overlap
    const maxRotation = 6; // degrees - random within this range
    // Leave room for logo at bottom and extra padding inside border
    const availableHeight = PRINTABLE_RAW.height - 45; // ~232mm (leaving space for logo + padding)
    const availableWidth = PRINTABLE_RAW.width - 16;   // ~174mm (extra padding inside border)
    const totalArea = availableWidth * availableHeight;
    
    // Calculate target area per image
    const numPhotos = photos.length;
    const gapArea = gap * gap * numPhotos * 2;
    const targetAreaPerImage = (totalArea - gapArea) / numPhotos;
    
    // Generate alternating rotations (left/right) with random amount
    const photoData = photos.map((photo, i) => {
        const ar = photo.width / photo.height;
        let w = Math.sqrt(targetAreaPerImage * ar);
        let h = Math.sqrt(targetAreaPerImage / ar);
        // Alternate direction: even = right (+), odd = left (-)
        const direction = i % 2 === 0 ? 1 : -1;
        // Random rotation from 0 to maxRotation
        const rotation = direction * seededRandom(i) * maxRotation;
        return { photo, w, h, ar, rotation };
    });
    
    // Binary search for optimal scale (account for rotation in bounding box)
    let scale = 1;
    let bestScale = 0.1;
    
    for (let attempt = 0; attempt < 20; attempt++) {
        const testScale = (bestScale + scale) / 2;
        if (canFitRotatedPhotos(photoData, testScale, availableWidth, availableHeight, gap)) {
            bestScale = testScale;
        } else {
            scale = testScale;
        }
    }
    
    // No extra safety margin - trust the bounding box calculation
    
    // Apply layout
    grid.style.gap = `${gap}mm`;
    grid.style.width = `${availableWidth}mm`;
    grid.style.height = `${availableHeight}mm`;
    
    for (const { photo, w, h, rotation } of photoData) {
        const scaledW = w * bestScale;
        const scaledH = h * bestScale;
        
        const item = document.createElement('div');
        item.className = 'photo-grid-item';
        item.style.width = `${scaledW}mm`;
        item.style.height = `${scaledH}mm`;
        item.style.transform = `rotate(${rotation.toFixed(1)}deg)`;
        
        const img = document.createElement('img');
        img.src = photo.url;
        img.alt = 'Original photo';
        item.appendChild(img);
        grid.appendChild(item);
    }
    
    content.appendChild(grid);
    page.appendChild(content);
    
    return page;
}

/**
 * Create a collage page using CollageLayout library
 * Photos are artistically arranged with rotation within the bordered area
 */
function createCollagePage(photos) {
    const page = document.createElement('article');
    page.className = 'a4-page collage-page';
    
    // Add border background
    const branding = document.createElement('div');
    branding.className = 'collage-branding';
    page.appendChild(branding);
    
    // The inner content area (inside the decorative border)
    // Margins: 16mm sides, 16mm top, ~35mm bottom (for logo)
    // A4 is 210x297mm, so inner area is 178mm x 246mm
    
    // CollageLayout dimensions (in arbitrary units, we'll scale for display)
    const COLLAGE_WIDTH = 2100;
    const COLLAGE_HEIGHT = 2900; // Leave room for logo
    const PADDING = 40;
    
    // Scale to convert collage units to mm for display
    const scaleMM = 178 / COLLAGE_WIDTH;
    
    // Create CollageLayout instance (accessed via window since it's a UMD module)
    const collage = new window.CollageLayout({
        width: COLLAGE_WIDTH,
        height: COLLAGE_HEIGHT,
        padding: PADDING,
        gap: 60,
        edgeGap: 60,
        rotationGap: 30,
        rotationMin: state.rotationMin,
        rotationMax: state.rotationMax,
        iterations: 300
    });
    
    // Add images to collage
    photos.forEach(photo => {
        collage.addImage({
            width: photo.width,
            height: photo.height,
            data: photo
        });
    });
    
    // Calculate layout
    const result = collage.calculate();
    
    // Create content container
    const content = document.createElement('div');
    content.className = 'collage-content';
    
    // Render each item
    result.items.forEach(item => {
        const photoData = item.image.data;
        
        const imgContainer = document.createElement('div');
        imgContainer.className = 'collage-item';
        
        // Convert from collage units to mm
        const x = item.x * scaleMM;
        const y = item.y * scaleMM;
        const w = item.width * scaleMM;
        const h = item.height * scaleMM;
        
        imgContainer.style.cssText = `
            position: absolute;
            left: ${x}mm;
            top: ${y}mm;
            width: ${w}mm;
            height: ${h}mm;
            transform: rotate(${item.rotation.toFixed(1)}deg);
            transform-origin: center center;
        `;
        
        const img = document.createElement('img');
        img.src = photoData.url;
        img.alt = 'Photo';
        imgContainer.appendChild(img);
        
        content.appendChild(imgContainer);
    });
    
    page.appendChild(content);
    
    // Add small logo at bottom
    const logo = document.createElement('img');
    logo.src = logoSrc();
    logo.alt = 'Fotomalovánky';
    logo.className = 'collage-logo';
    page.appendChild(logo);
    
    return page;
}

/**
 * Seeded random number generator for consistent rotations
 */
function seededRandom(seed) {
    const x = Math.sin(seed * 9999 + 1) * 10000;
    return x - Math.floor(x);
}

/**
 * Shuffle array in place using Fisher-Yates algorithm
 */
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

/**
 * Calculate bounding box of rotated rectangle
 */
function getRotatedBoundingBox(w, h, angleDeg) {
    const angle = angleDeg * Math.PI / 180;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    return {
        width: w * cos + h * sin,
        height: w * sin + h * cos
    };
}

/**
 * Check if rotated photos can fit using row-packing
 */
function canFitRotatedPhotos(photoData, scale, maxWidth, maxHeight, gap) {
    let currentRowWidth = 0;
    let currentRowHeight = 0;
    let totalHeight = 0;
    
    for (const { w, h, rotation } of photoData) {
        const scaledW = w * scale;
        const scaledH = h * scale;
        
        // Get bounding box after rotation
        const bbox = getRotatedBoundingBox(scaledW, scaledH, rotation);
        
        if (currentRowWidth + bbox.width + (currentRowWidth > 0 ? gap : 0) <= maxWidth) {
            // Fits in current row
            currentRowWidth += bbox.width + (currentRowWidth > 0 ? gap : 0);
            currentRowHeight = Math.max(currentRowHeight, bbox.height);
        } else {
            // Start new row
            totalHeight += currentRowHeight + (totalHeight > 0 ? gap : 0);
            currentRowWidth = bbox.width;
            currentRowHeight = bbox.height;
        }
    }
    
    // Add last row
    totalHeight += currentRowHeight;
    
    return totalHeight <= maxHeight;
}

function updateStatus(message, success = false) {
    statusEl.innerHTML = `<p>${message}</p>`;
    statusEl.classList.toggle('success', success);
}

// ═══════════════════════════════════════════════════════════════════════════
// Session Loading (for server mode)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if we're in a session URL and load session data
 */
async function checkForSession() {
    // Check URL pattern: /session/{sessionId}
    const match = window.location.pathname.match(/^\/session\/([a-f0-9-]+)$/i);
    if (!match) return;

    const sessionId = match[1];
    console.log(`Loading session: ${sessionId}`);

    try {
        await loadFromSession(sessionId);
    } catch (error) {
        console.error('Failed to load session:', error);
        updateStatus(`Failed to load session: ${error.message}`, false);
    }
}

/**
 * Load files and settings from a session
 */
async function loadFromSession(sessionId) {
    updateStatus('Loading session...', false);

    // Fetch session metadata
    const response = await fetch(`/api/session/${sessionId}`);
    if (!response.ok) {
        throw new Error('Session not found');
    }

    const session = await response.json();
    console.log('Session data:', session);

    // Cleanup previous URLs
    state.objectUrls.forEach(url => URL.revokeObjectURL(url));
    state.objectUrls = [];
    state.pairs = [];

    // Apply settings
    if (session.settings.dedication) {
        state.title = session.settings.dedication;
        titleInput.value = session.settings.dedication;
    }

    if (session.settings.format === 'fullpage') {
        state.mode = 'fullpage';
        modeButtons.forEach(b => b.classList.toggle('active', b.dataset.mode === 'fullpage'));
    }

    // Group files by base name (similar to handleFolderSelect)
    const grouped = new Map();

    for (const file of session.files) {
        const name = file.name;
        const lowerName = name.toLowerCase();

        // Skip _bw.png files
        if (lowerName.endsWith('_bw.png')) continue;

        let baseName, type;

        if (lowerName.endsWith('.svg')) {
            baseName = name.replace(/_bw\.svg$/i, '').replace(/\.svg$/i, '');
            type = 'svg';
        } else if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) {
            if (lowerName.includes('_bw')) continue;
            baseName = name.replace(/\.(jpg|jpeg)$/i, '');
            type = 'photo';
        } else if (lowerName.endsWith('.png') && !lowerName.includes('_bw')) {
            baseName = name.replace(/\.png$/i, '');
            type = 'photo';
        } else {
            continue;
        }

        const normalizedBase = baseName.toLowerCase();

        if (!grouped.has(normalizedBase)) {
            grouped.set(normalizedBase, { baseName, photo: null, svg: null });
        }

        const entry = grouped.get(normalizedBase);
        if (type === 'photo') {
            const isJpeg = lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg');
            const currentIsJpeg = entry.photo && (entry.photo.name.toLowerCase().endsWith('.jpg') || entry.photo.name.toLowerCase().endsWith('.jpeg'));
            if (!entry.photo || (!currentIsJpeg && isJpeg)) {
                entry.photo = { name, sessionId };
            }
        } else if (type === 'svg' && !entry.svg) {
            entry.svg = { name, sessionId };
        }
    }

    // Build pairs (photo + svg)
    const pairs = [];

    for (const [baseName, assets] of grouped.entries()) {
        if (!assets.photo || !assets.svg) continue;

        // Create URLs pointing to session files
        const photoUrl = `/api/session/${sessionId}/files/${encodeURIComponent(assets.photo.name)}`;
        const svgUrl = `/api/session/${sessionId}/files/${encodeURIComponent(assets.svg.name)}`;

        // Check if photo is JPEG
        const photoName = assets.photo.name.toLowerCase();
        const isJpeg = photoName.endsWith('.jpg') || photoName.endsWith('.jpeg');

        // Get image dimensions
        const [photoDims, svgDims] = await Promise.all([
            getImageDimensions(photoUrl),
            getImageDimensions(svgUrl)
        ]);

        pairs.push({
            name: baseName,
            photo: { url: photoUrl, isJpeg, ...photoDims },
            svg: { url: svgUrl, ...svgDims }
        });
    }

    state.pairs = pairs;

    if (pairs.length === 0) {
        updateStatus('No matching photo + SVG pairs found in session.', false);
        renderPages();
        return;
    }

    updateStatus(`Loaded ${pairs.length} pair${pairs.length !== 1 ? 's' : ''} from session`, true);
    printBtn.disabled = false;

    // Show title config, PDF toggle, and language toggle, generate cover selection grid
    titleConfig.classList.remove('hidden');
    pdfToggle.classList.remove('hidden');
    langToggle.classList.remove('hidden');
    updateRotationControlsVisibility();
    generateCoverSelection();
    renderPages();

    // Hide the folder input in session mode (files already loaded)
    const folderBtn = document.querySelector('.folder-btn');
    if (folderBtn) {
        folderBtn.style.display = 'none';
    }
}

// Check for session on page load
checkForSession();

// ═══════════════════════════════════════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════════════════════════════════════

window.addEventListener('beforeunload', () => {
    state.objectUrls.forEach(url => URL.revokeObjectURL(url));
});

