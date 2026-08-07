/**
 * ImagePreviewWidget - Fullscreen image preview with navigation
 *
 * Lightbox-style overlay for viewing images. Collects all images from
 * the current chat DOM and provides prev/next navigation within turns
 * and between turns.
 */

import { WidgetManager } from '../widget-system/index.js';
import S from '../strings.js';
import { escapeHtml } from '../utils.js';
import { panzoomToolbarHtml, setupPanZoom, panzoomFitToView } from '../preview-plugins/plugin-helpers.js';
import { ContextMenu, copyToClipboard, copyImageToClipboard, showToast, filePathFromSrc, lastInputWasTouch } from '../context-menu.js';

// Shared context menu for the main image + thumb strip
const contextMenu = new ContextMenu();

/** Absolute URL for a (possibly root-relative) src. */
function absoluteSrc(src) {
    if (!src || src.startsWith('data:')) return src;
    try { return new URL(src, location.origin).href; }
    catch { return src; }
}

/**
 * Copy an image to the clipboard, falling back to its path/link when the
 * platform refuses image bytes (iPad PWA, older Safari).
 * @returns {Promise<boolean>} true if anything at all made it to the clipboard
 */
async function copyImageWithFallback(src, path, abs) {
    if (await copyImageToClipboard(src)) { showToast(S.toast.image_copied); return true; }
    const fallback = path || (abs && !abs.startsWith('data:') ? abs : null);
    const ok = !!fallback && await copyToClipboard(fallback);
    showToast(ok ? S.toast.image_copy_fell_back : S.toast.image_copy_failed);
    return ok;
}

/** Build context-menu items for a gallery image src. */
function imageMenuItems(src) {
    if (!src) return [];
    const path = filePathFromSrc(src);
    const abs = absoluteSrc(src);
    const items = [
        {
            label: S.context_menus.image.copy_image,
            action: () => copyImageWithFallback(src, path, abs),
        },
        {
            label: S.context_menus.image.copy_image_close,
            action: async () => {
                await copyImageWithFallback(src, path, abs);
                WidgetManager.close('image-preview');
            },
        },
    ];
    if (path) {
        items.push({
            label: S.context_menus.image.copy_path,
            action: async () => { if (await copyToClipboard(path)) showToast(S.toast.path_copied); },
        });
    }
    if (abs && !abs.startsWith('data:')) {
        items.push({
            label: S.context_menus.image.copy_link,
            action: async () => { if (await copyToClipboard(abs)) showToast(S.toast.link_copied); },
        });
    }
    items.push({ separator: true });
    items.push({ label: S.context_menus.image.annotate, action: () => openInAnnotator(src) });
    if (abs && !abs.startsWith('data:')) {
        items.push({ label: S.context_menus.image.open_new_tab, action: () => window.open(abs, '_blank') });
    }
    return items;
}

/**
 * Open the current gallery image in the annotation editor.
 *
 * The editor was built for the paste flow and takes a Blob, so a gallery src
 * (a server file, a blob: URL, or a data: URI) is fetched into one first.
 * The gallery closes on the way in: both are modals, and the gallery's arrow
 * keys would otherwise swap the image out from under an in-progress drawing.
 *
 * On save the annotated PNG is attached to the chat as a pending image — the
 * same destination as paste-to-annotate. It does NOT overwrite the file on
 * disk (there's no binary write endpoint, and the editor downsamples above
 * 3000px, so an in-place save would silently degrade the original).
 */
async function openInAnnotator(src) {
    if (!src) return;
    const name = basenameFromSrc(src) || 'image.png';
    try {
        const blob = await fetch(src).then(r => {
            if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
            return r.blob();
        });
        // GIFs would be flattened to a single frame by the canvas export —
        // the paste flow skips them for the same reason.
        if (blob.type === 'image/gif') { showToast(S.toast.annotate_gif_unsupported); return; }

        const { openImageAnnotator } = await import('./image-annotate-widget.js');
        WidgetManager.close('image-preview');
        openImageAnnotator(new File([blob], name, { type: blob.type || 'image/png' }), {
            onDone: (out, markers) => window.app?.uploadManager?.attachAnnotated(out, name, markers),
        });
    } catch (err) {
        console.error('[ImagePreview] Failed to open annotator:', err);
        showToast(S.toast.annotate_open_failed);
    }
}

/** Show the image context menu at (x, y) for a given src. */
function showImageMenu(x, y, src) {
    const items = imageMenuItems(src);
    if (items.length) contextMenu.show(x, y, items);
}

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════

const state = {
    images: [],       // [{src, turnIndex, turnLabel?, label?}] in DOM or directory order
    currentIndex: -1,
    mode: 'chat',     // 'chat' = session images grouped by turn, 'dir' = directory siblings
    zoom: { scale: 1, tx: 0, ty: 0 },
};

let _keyHandler = null;

// ═══════════════════════════════════════════════════════════════════════════
// IMAGE COLLECTION
// ═══════════════════════════════════════════════════════════════════════════

const IMAGE_EXT_RE = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i;

const IMG_SELECTOR = [
    '.turn-summary-bar',
    '.message-image-thumb',
    '.read-image-content img',
    '.write-image-content img',
    '.tt-image-thumb img',
    '.turn-file-pill[data-file-path]',
    'a.file-path-link[data-resolved]',
].join(', ');

/**
 * Scan the messages container for all images, grouped by turn.
 * Includes: user uploads, Read/Write tool images, thinking tool images,
 * file pills / image thumbs in turn bars, and linkified image paths in
 * message text (server-verified file-path-links).
 *
 * Turn attribution: a turn's inline images sit BEFORE its summary bar in the
 * DOM, so inline images belong to the bar that FOLLOWS them, while a bar's
 * own pills belong to that bar itself. `turnIndex` is a monotonic segment
 * counter used for ordering and turn-jump; `turnLabel` is the bar's displayed
 * turn number, used only for labels (turn numbers can restart mid-session
 * when the server restarts, so they aren't safe for ordering).
 *
 * Returns [{src, turnIndex, turnLabel}] in DOM order.
 */
function collectImages() {
    // Scope to the ACTIVE session's message container — #messages-container
    // holds a pool of .session-messages elements (one per open tab, inactive
    // ones just hidden), so scanning it directly would sweep in every open
    // session's images. (Not getActiveScrollContainer() — that returns the
    // welcome container while the welcome view is up.)
    const container = window.app?.chatCtrl?._containerPool?.getActiveContainer()
        || document.getElementById('messages-container');
    if (!container) return [];

    const nodes = container.querySelectorAll(IMG_SELECTOR);
    const entries = [];
    const barLabels = [];   // barLabels[i] = displayed number of the i-th bar
    const seen = new Set();  // dedupe by src
    let bars = 0;

    for (const el of nodes) {
        // Turn boundary — record its displayed number (partial bars have none)
        if (el.classList.contains('turn-summary-bar')) {
            barLabels[bars] = parseInt(el.dataset.turnNumber, 10) || null;
            bars++;
            continue;
        }

        // Extract src + filename label based on element type
        let src, label;
        if (el.classList.contains('message-image-thumb')) {
            // User upload — alt is generic, derive the name from the URL
            src = el.dataset.src || el.querySelector('img')?.src;
            label = basenameFromSrc(src);
        } else if (el.classList.contains('turn-file-pill')) {
            // File pill / image thumb in a turn bar — include if it's an image
            const filePath = el.dataset.filePath;
            if (!filePath || !IMAGE_EXT_RE.test(filePath)) continue;
            src = `/api/file-raw?path=${encodeURIComponent(filePath)}`;
            label = filePath.split('/').pop();
        } else if (el.classList.contains('file-path-link')) {
            // Linkified file path in message text — include if resolved to an image
            const filePath = el.dataset.resolved;
            if (!filePath || !IMAGE_EXT_RE.test(filePath)) continue;
            src = `/api/file-raw?path=${encodeURIComponent(filePath)}`;
            label = filePath.split('/').pop();
        } else {
            // Read/Write/thinking tool <img> — alt carries the filename
            src = el.src;
            label = el.alt || basenameFromSrc(src);
        }

        if (!src || seen.has(src)) continue;
        seen.add(src);
        const seg = el.closest('.turn-summary-bar') ? bars - 1 : bars;
        entries.push({ src, seg: Math.max(0, seg), label: label || null });
    }

    // Resolve display labels per segment. Bars without a number (partial
    // bars) and the trailing in-flight segment synthesize previous + 1.
    const segLabels = [];
    let lastLabel = 0;
    for (let i = 0; i <= bars; i++) {
        segLabels[i] = (i < bars && barLabels[i]) ? barLabels[i] : lastLabel + 1;
        lastLabel = segLabels[i];
    }

    return entries.map(e => ({ src: e.src, turnIndex: e.seg, turnLabel: segLabels[e.seg], label: e.label }));
}

/**
 * Best-effort filename for an image src — /api/file-raw?path=… URLs use the
 * path param's basename, other URLs their pathname basename (only when it
 * looks like an image file); data: URIs have none.
 */
function basenameFromSrc(src) {
    if (!src || src.startsWith('data:')) return null;
    try {
        const u = new URL(src, location.origin);
        const p = u.searchParams.get('path');
        if (p) return p.split('/').pop();
        const name = decodeURIComponent(u.pathname.split('/').pop() || '');
        return IMAGE_EXT_RE.test(name) ? name : null;
    } catch { return null; }
}

/**
 * Find image index by matching src URL. Handles both exact match
 * and path-only match (ignoring query params) for API URLs.
 */
function findImageIndex(images, src) {
    // Exact match first
    let idx = images.findIndex(img => img.src === src);
    if (idx >= 0) return idx;

    // Try matching by pathname (for /api/file-raw?path=... URLs with different params)
    try {
        const srcUrl = new URL(src, location.origin);
        idx = images.findIndex(img => {
            try {
                const u = new URL(img.src, location.origin);
                return u.pathname === srcUrl.pathname && u.searchParams.get('path') === srcUrl.searchParams.get('path');
            } catch { return false; }
        });
    } catch { /* not a URL, skip */ }

    return idx;
}

// ═══════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════

function navigate(delta) {
    const total = state.images.length;
    if (total <= 1) return;
    // Wrap around: prev at the first image lands on the last and vice versa
    state.currentIndex = (state.currentIndex + delta + total) % total;
    updateDisplay();
}

function navigateTurn(direction) {
    const cur = state.images[state.currentIndex];
    if (!cur) return;

    if (direction < 0) {
        // Find first image of previous turn
        for (let i = state.currentIndex - 1; i >= 0; i--) {
            if (state.images[i].turnIndex < cur.turnIndex) {
                // Found a different turn — now find its first image
                const targetTurn = state.images[i].turnIndex;
                let first = i;
                while (first > 0 && state.images[first - 1].turnIndex === targetTurn) first--;
                state.currentIndex = first;
                updateDisplay();
                return;
            }
        }
    } else {
        // Find first image of next turn
        for (let i = state.currentIndex + 1; i < state.images.length; i++) {
            if (state.images[i].turnIndex > cur.turnIndex) {
                state.currentIndex = i;
                updateDisplay();
                return;
            }
        }
    }
}

function hasPrevTurn() {
    const cur = state.images[state.currentIndex];
    if (!cur) return false;
    return state.images.some((img, i) => i < state.currentIndex && img.turnIndex < cur.turnIndex);
}

function hasNextTurn() {
    const cur = state.images[state.currentIndex];
    if (!cur) return false;
    return state.images.some((img, i) => i > state.currentIndex && img.turnIndex > cur.turnIndex);
}

// ═══════════════════════════════════════════════════════════════════════════
// DISPLAY UPDATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Display label for an image: dir mode is filename-only (no turns exist);
 * chat mode is "T4 · name.png", degrading to just the turn when no
 * filename could be derived (e.g. data-URI uploads).
 */
function imageLabel(im) {
    const turn = `T${im.turnLabel || im.turnIndex || 0}`;
    if (state.mode === 'dir') return im.label || turn;
    return im.label ? `${turn} · ${im.label}` : turn;
}

function updateDisplay() {
    const modal = document.querySelector('#widget-image-preview .image-preview-modal');
    if (!modal) return;

    const img = modal.querySelector('.img-preview-main');
    const counter = modal.querySelector('.img-nav-counter');
    const prevBtn = modal.querySelector('.img-nav-prev');
    const nextBtn = modal.querySelector('.img-nav-next');
    const prevTurnBtn = modal.querySelector('.img-nav-turn-prev');
    const nextTurnBtn = modal.querySelector('.img-nav-turn-next');

    const cur = state.images[state.currentIndex];
    if (!cur) return;

    // Reset zoom and refit when switching images so each picture starts fitted.
    if (img && img.src !== cur.src) {
        state.zoom.scale = 1;
        state.zoom.tx = 0;
        state.zoom.ty = 0;
        img.style.transform = '';
        img.src = cur.src;
        const canvas = modal.querySelector('.img-preview-canvas');
        const refit = () => panzoomFitToView(canvas, img, state.zoom);
        if (img.complete && img.naturalWidth > 0) {
            requestAnimationFrame(refit);
        } else {
            img.addEventListener('load', refit, { once: true });
        }
    }

    const total = state.images.length;

    if (counter) {
        counter.textContent = total > 1
            ? `${state.currentIndex + 1} / ${total}  ·  ${imageLabel(cur)}`
            : '';
    }

    if (prevBtn) prevBtn.disabled = total <= 1;
    if (nextBtn) nextBtn.disabled = total <= 1;
    if (prevTurnBtn) prevTurnBtn.disabled = !hasPrevTurn();
    if (nextTurnBtn) nextTurnBtn.disabled = !hasNextTurn();

    updateThumbActive(modal);
}

/**
 * Build the thumb-strip HTML for the current state.images.
 * Inserts an .img-turn-sep between consecutive thumbs from different turns.
 */
function renderThumbStripHtml() {
    if (state.images.length <= 1) return '';
    let html = '';
    let prevTurn = null;
    for (let i = 0; i < state.images.length; i++) {
        const im = state.images[i];
        if (prevTurn !== null && im.turnIndex !== prevTurn) {
            html += `<div class="img-turn-sep" data-tooltip="T${im.turnLabel || im.turnIndex}"></div>`;
        }
        const tip = escapeHtml(imageLabel(im));
        html += `<button class="img-thumb" data-index="${i}" data-tooltip="${tip}"><img src="${im.src}" alt="" loading="lazy"></button>`;
        prevTurn = im.turnIndex;
    }
    return html;
}

/**
 * Mark the active thumb and scroll it into view.
 */
function updateThumbActive(modal) {
    const strip = modal.querySelector('.img-thumb-strip');
    if (!strip) return;
    const thumbs = strip.querySelectorAll('.img-thumb');
    let active = null;
    thumbs.forEach((t) => {
        const isActive = parseInt(t.dataset.index, 10) === state.currentIndex;
        t.classList.toggle('active', isActive);
        if (isActive) active = t;
    });
    if (active) {
        active.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// KEYBOARD
// ═══════════════════════════════════════════════════════════════════════════

function attachKeyboard() {
    detachKeyboard();
    _keyHandler = (e) => {
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            e.shiftKey ? navigateTurn(-1) : navigate(-1);
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            e.shiftKey ? navigateTurn(1) : navigate(1);
        }
    };
    document.addEventListener('keydown', _keyHandler);
}

function detachKeyboard() {
    if (_keyHandler) {
        document.removeEventListener('keydown', _keyHandler);
        _keyHandler = null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SVG ICONS (inline to avoid widget-system dependency for simple arrows)
// ═══════════════════════════════════════════════════════════════════════════

const CHEVRON_LEFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
const CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>';
const CHEVRONS_LEFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg>';
const CHEVRONS_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 7 18 12 13 17"/><polyline points="6 7 11 12 6 17"/></svg>';

// ═══════════════════════════════════════════════════════════════════════════
// WIDGET REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════

export function registerImagePreviewWidget() {
    WidgetManager.register('image-preview', {
        title: S.widgets.titles.image_preview,
        icon: 'image',
        type: 'modal',
        hideHeader: true,
        closeOnBackdrop: true,
        closeOnEscape: true,
        maxWidth: '95vw',
        maxHeight: '95vh',
        scope: 'global',
        sessionAware: false,
        hiddenInPicker: true,

        onClose() {
            detachKeyboard();
            // Return focus to the chat input so typing can resume immediately.
            window.app?.focusInput?.();
        },

        render(container, ctx) {
            const single = state.images.length <= 1;
            const initialSrc = state.images[state.currentIndex]?.src || '';

            container.innerHTML = `
                <div class="image-preview-modal${single ? ' single-image' : ''}">
                    ${panzoomToolbarHtml(state.zoom, {
                        hasDownload: false,
                        hasAnnotate: true,
                        annotateTooltip: S.context_menus.image.annotate,
                    })}
                    <div class="img-preview-canvas panzoom-canvas">
                        <img class="img-preview-main panzoom-img" src="${initialSrc}" alt="Preview">
                    </div>
                    <button class="img-nav img-nav-prev" data-tooltip="${S.widgets?.image_preview?.prev || 'Previous image'}">${CHEVRON_LEFT}</button>
                    <button class="img-nav img-nav-next" data-tooltip="${S.widgets?.image_preview?.next || 'Next image'}">${CHEVRON_RIGHT}</button>
                    <span class="img-nav-counter"></span>
                    <div class="img-nav-turn">
                        <button class="img-nav-turn-prev" data-tooltip="${S.widgets?.image_preview?.prev_turn || "Previous turn"}">${CHEVRONS_LEFT}</button>
                        <button class="img-nav-turn-next" data-tooltip="${S.widgets?.image_preview?.next_turn || "Next turn"}">${CHEVRONS_RIGHT}</button>
                    </div>
                    <div class="img-thumb-strip">${renderThumbStripHtml()}</div>
                </div>
            `;

            // Wire up pan/zoom (drag, wheel, pinch, gesture, toolbar buttons, Cmd+/-/0)
            setupPanZoom(container, state.zoom, {
                canvasSelector: '.img-preview-canvas',
                imgSelector: '.img-preview-main',
                stateCheck: () => !!document.querySelector('#widget-image-preview .image-preview-modal'),
                onAnnotate: () => openInAnnotator(state.images[state.currentIndex]?.src),
            });

            // Navigation button clicks
            container.querySelector('.img-nav-prev').addEventListener('click', (e) => {
                e.stopPropagation();
                navigate(-1);
            });
            container.querySelector('.img-nav-next').addEventListener('click', (e) => {
                e.stopPropagation();
                navigate(1);
            });
            container.querySelector('.img-nav-turn-prev').addEventListener('click', (e) => {
                e.stopPropagation();
                navigateTurn(-1);
            });
            container.querySelector('.img-nav-turn-next').addEventListener('click', (e) => {
                e.stopPropagation();
                navigateTurn(1);
            });

            // Delegated click on thumb strip — jump to clicked image
            container.querySelector('.img-thumb-strip').addEventListener('click', (e) => {
                const thumb = e.target.closest('.img-thumb');
                if (!thumb) return;
                e.stopPropagation();
                const idx = parseInt(thumb.dataset.index, 10);
                if (Number.isFinite(idx) && idx >= 0 && idx < state.images.length) {
                    state.currentIndex = idx;
                    updateDisplay();
                }
            });

            // Right-click on the main image or a thumb → copy image / link / path.
            // srcAt() resolves the src for whichever element was targeted.
            const srcAt = (target) => {
                const thumb = target.closest('.img-thumb');
                if (thumb) {
                    const idx = parseInt(thumb.dataset.index, 10);
                    return state.images[idx]?.src;
                }
                if (target.closest('.img-preview-main')) {
                    return state.images[state.currentIndex]?.src;
                }
                return null;
            };
            // NOTE: capture phase is required. The pan/zoom canvas calls
            // stopPropagation() on touch events (to stop the tab-switch gesture
            // manager), which would otherwise swallow our bubble-phase
            // long-press. Capture runs before the canvas handler, so it still
            // fires. (Mouse right-click works via contextmenu once pan/zoom
            // stops capturing the secondary button — see plugin-helpers.js.)
            container.addEventListener('contextmenu', (e) => {
                const src = srcAt(e.target);
                if (!src) return;
                // On touch, yield to the native iOS callout. Its "Copy Image"
                // actually works on an iPad PWA, where navigator.clipboard
                // refuses image bytes and our own copy can only fall back to
                // the link. The toolbar pencil + Copy&Close stay reachable.
                if (lastInputWasTouch()) return;
                e.preventDefault();
                e.stopPropagation();
                showImageMenu(e.clientX, e.clientY, src);
            }, true);

            // Click on dark canvas area (not on the image, not on a drag) closes the widget.
            // Use pointer events to distinguish click from pan-drag via distance threshold.
            const canvasEl = container.querySelector('.img-preview-canvas');
            let downAt = null;
            canvasEl.addEventListener('pointerdown', (e) => {
                downAt = { x: e.clientX, y: e.clientY, target: e.target };
            });
            canvasEl.addEventListener('pointerup', (e) => {
                if (!downAt) return;
                const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
                const onBackdrop = downAt.target === canvasEl && e.target === canvasEl;
                downAt = null;
                if (moved < 5 && onBackdrop) WidgetManager.close('image-preview');
            });

            updateDisplay();
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Open the widget for the current state.images/currentIndex/mode.
 * Widget render() only runs on first creation — update DOM directly
 * for subsequent opens.
 */
function openWithState() {
    WidgetManager.open('image-preview');
    attachKeyboard();

    const modal = document.querySelector('#widget-image-preview .image-preview-modal');
    if (modal) {
        modal.classList.toggle('single-image', state.images.length <= 1);
        modal.classList.toggle('dir-mode', state.mode === 'dir');
        // Rebuild thumb strip — collected images may differ between opens
        const strip = modal.querySelector('.img-thumb-strip');
        if (strip) strip.innerHTML = renderThumbStripHtml();
        updateDisplay();
    }
}

/**
 * Show an image in the preview modal with navigation
 * @param {string} src - Image source (URL or data URI)
 */
export function showImagePreview(src) {
    // Collect all session images from DOM
    state.mode = 'chat';
    state.images = collectImages();
    state.currentIndex = findImageIndex(state.images, src);

    // If not found in DOM (e.g., pending upload preview), show as single image
    if (state.currentIndex < 0) {
        state.images = [{ src, turnIndex: 0 }];
        state.currentIndex = 0;
    }

    openWithState();
}

/**
 * Show an image from the filesystem with its directory siblings as the
 * gallery (file-explorer open path). The thumb strip lists every image in
 * the clicked file's directory instead of the session's chat images.
 * @param {string} path - Absolute path of the clicked image
 */
export async function showImagePreviewForFile(path) {
    const src = `/api/file-raw?path=${encodeURIComponent(path)}`;
    const dir = path.replace(/\/[^/]*$/, '') || '/';

    let images = [];
    try {
        const resp = await fetch(`/api/files?path=${encodeURIComponent(dir)}`);
        if (resp.ok) {
            const data = await resp.json();
            images = (data.files || [])
                .filter(f => !f.is_dir && IMAGE_EXT_RE.test(f.name))
                .map(f => ({
                    src: `/api/file-raw?path=${encodeURIComponent(f.path)}`,
                    turnIndex: 0,
                    label: f.name,
                }));
        }
    } catch { /* listing failed — fall through to single image */ }

    state.mode = 'dir';
    state.currentIndex = findImageIndex(images, src);
    if (state.currentIndex >= 0) {
        state.images = images;
    } else {
        state.images = [{ src, turnIndex: 0, label: path.split('/').pop() }];
        state.currentIndex = 0;
    }

    openWithState();
}

/**
 * Close the image preview modal
 */
export function closeImagePreview() {
    WidgetManager.close('image-preview');
}

// Export for external access
export const ImagePreviewWidget = {
    show: showImagePreview,
    showForFile: showImagePreviewForFile,
    close: closeImagePreview
};
