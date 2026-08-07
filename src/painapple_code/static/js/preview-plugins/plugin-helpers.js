/**
 * Shared utilities for file preview plugins
 *
 * Provides panzoom, toolbar HTML builders, and common helpers
 * that plugins can import without depending on the core widget.
 */

import { CONFIG } from '../config.js';
import { escapeHtml } from '../utils.js';
import { getDownloadTooltip } from '../context-menu.js';

// Re-export for plugin convenience
export { CONFIG, escapeHtml };

export const darkDefault = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? true;

// ═══════════════════════════════════════════════════════════════════════════
// TOOLBAR HTML BUILDERS
// ═══════════════════════════════════════════════════════════════════════════

export function downloadBtnHtml() {
    return `<button class="preview-download-btn" data-tooltip="${getDownloadTooltip()}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
    </button>`;
}

export function annotateBtnHtml(tooltip) {
    return `<button class="panzoom-ctrl-btn panzoom-annotate-btn" data-action="pz-annotate" data-tooltip="${escapeHtml(tooltip)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 20h9"/>
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
        </svg>
    </button>`;
}

/**
 * Build panzoom toolbar HTML
 * @param {object} zoomState - { scale, isDark? }
 * @param {object} opts
 * @param {boolean} opts.hasDarkToggle - Show dark/light toggle button
 * @param {boolean} opts.hasDownload - Show download button (default true)
 * @param {boolean} opts.hasAnnotate - Show "open in annotation editor" button
 * @param {string} opts.annotateTooltip - Tooltip for that button
 */
export function panzoomToolbarHtml(zoomState, opts = {}) {
    const { hasDarkToggle = false, hasDownload = true, hasAnnotate = false, annotateTooltip = '' } = opts;
    const darkBtn = hasDarkToggle ? `
        <button class="panzoom-ctrl-btn${zoomState.isDark ? ' active' : ''}" data-action="pz-dark" data-tooltip="Toggle dark mode">${zoomState.isDark ? 'Dark' : 'Light'}</button>
    ` : '';

    return `
        <div class="panzoom-toolbar">
            <button class="panzoom-ctrl-btn" data-action="pz-fit" data-tooltip="Fit to view">Fit</button>
            <button class="panzoom-ctrl-btn" data-action="pz-100" data-tooltip="Original size">1:1</button>
            <button class="panzoom-ctrl-btn" data-action="pz-zoom-out" data-tooltip="Zoom out (Cmd−)">−</button>
            <span class="panzoom-zoom-label">${Math.round(zoomState.scale * 100)}%</span>
            <button class="panzoom-ctrl-btn" data-action="pz-zoom-in" data-tooltip="Zoom in (Cmd+)">+</button>
            <div class="toolbar-spacer"></div>
            ${hasAnnotate ? annotateBtnHtml(annotateTooltip) : ''}
            ${hasDownload ? downloadBtnHtml() : ''}
            ${darkBtn}
        </div>
    `;
}

// ═══════════════════════════════════════════════════════════════════════════
// PAN/ZOOM ENGINE
// ═══════════════════════════════════════════════════════════════════════════

export function panzoomFitToView(canvas, img, zoomState) {
    if (!canvas || !img) return;
    const cr = canvas.getBoundingClientRect();
    if (cr.width === 0 || cr.height === 0 || img.naturalWidth === 0 || img.naturalHeight === 0) return;
    const sx = cr.width / img.naturalWidth;
    const sy = cr.height / img.naturalHeight;
    zoomState.scale = Math.min(sx, sy) * 0.98;
    zoomState.tx = (cr.width - img.naturalWidth * zoomState.scale) / 2;
    zoomState.ty = (cr.height - img.naturalHeight * zoomState.scale) / 2;
    panzoomApplyTransform(img, zoomState, canvas);
}

export function panzoomApplyTransform(img, zoomState, canvas) {
    if (!img) return;
    const { tx, ty, scale } = zoomState;
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    // Update zoom label - toolbar is a sibling of the canvas
    const label = canvas?.parentElement?.querySelector('.panzoom-zoom-label');
    if (label) label.textContent = Math.round(scale * 100) + '%';
}

/** Zoom by factor toward canvas center */
export function panzoomZoomCenter(factor, zoomState, canvas, pzImg) {
    if (!canvas || !pzImg) return;
    const cr = canvas.getBoundingClientRect();
    const mx = cr.width / 2;
    const my = cr.height / 2;
    const newScale = Math.max(0.05, Math.min(20, zoomState.scale * factor));
    zoomState.tx = mx - (mx - zoomState.tx) * (newScale / zoomState.scale);
    zoomState.ty = my - (my - zoomState.ty) * (newScale / zoomState.scale);
    zoomState.scale = newScale;
    panzoomApplyTransform(pzImg, zoomState, canvas);
}

/**
 * Setup pan/zoom on a canvas container with an image element.
 * Supports: pointer drag, wheel, WebKit gestures, touch pinch, toolbar buttons, keyboard.
 * @param {HTMLElement} container - Widget container
 * @param {object} zoomState - State object with {scale, tx, ty}
 * @param {object} opts - Options
 * @param {string} opts.canvasSelector - Selector for the pan/zoom canvas container
 * @param {string} opts.imgSelector - Selector for the transformable image
 * @param {Function} opts.stateCheck - Returns true when this panzoom is active (for keyboard handler)
 * @param {Function} [opts.onDarkToggle] - Called when dark mode button is clicked
 */
export function setupPanZoom(container, zoomState, opts) {
    const canvas = container.querySelector(opts.canvasSelector);
    const pzImg = container.querySelector(opts.imgSelector);
    if (!canvas || !pzImg) return;

    // Fit on load — keep retrying for ~500ms to handle widget open animations
    // (getBoundingClientRect returns intermediate sizes during CSS transitions)
    let fitRetries = 0;
    const fitWhenReady = () => {
        const cr = canvas.getBoundingClientRect();
        if (cr.width > 0 && cr.height > 0 && pzImg.naturalWidth > 0) {
            panzoomFitToView(canvas, pzImg, zoomState);
            // Don't upscale on initial open — show at 1:1 if image fits
            if (zoomState.scale > 1) {
                zoomState.scale = 1;
                zoomState.tx = (cr.width - pzImg.naturalWidth) / 2;
                zoomState.ty = (cr.height - pzImg.naturalHeight) / 2;
                panzoomApplyTransform(pzImg, zoomState, canvas);
            }
        }
        // Always keep retrying — canvas may still be animating to final size
        if (fitRetries++ < 30) {
            requestAnimationFrame(fitWhenReady);
        }
    };
    if (pzImg.naturalWidth > 0) {
        fitWhenReady();
    } else {
        pzImg.addEventListener('load', fitWhenReady);
    }

    // Layer 1: Pointer events (drag to pan)
    let dragging = false, lastX = 0, lastY = 0;
    canvas.addEventListener('pointerdown', (e) => {
        // Only the primary (left) button pans. Capturing the pointer on a
        // secondary/right press swallows the native `contextmenu` event, which
        // would break right-click menus on the panned element.
        if (e.button !== 0) return;
        dragging = true; lastX = e.clientX; lastY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        zoomState.tx += e.clientX - lastX;
        zoomState.ty += e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        panzoomApplyTransform(pzImg, zoomState, canvas);
    });
    canvas.addEventListener('pointerup', () => { dragging = false; });
    canvas.addEventListener('pointercancel', () => { dragging = false; });

    // Layer 2: Wheel events (trackpad pan + Ctrl+wheel zoom)
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        e.stopPropagation(); // Prevent gesture manager from triggering tab switch
        if (e.ctrlKey) {
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            const newScale = Math.max(0.05, Math.min(20, zoomState.scale * factor));
            zoomState.tx = mx - (mx - zoomState.tx) * (newScale / zoomState.scale);
            zoomState.ty = my - (my - zoomState.ty) * (newScale / zoomState.scale);
            zoomState.scale = newScale;
        } else {
            zoomState.tx -= e.deltaX;
            zoomState.ty -= e.deltaY;
        }
        panzoomApplyTransform(pzImg, zoomState, canvas);
    }, { passive: false });

    // Layer 3: Safari/WebKit gesture events (trackpad pinch on iPadOS/macOS Safari)
    let gestureStartScale = 1;
    canvas.addEventListener('gesturestart', (e) => {
        e.preventDefault();
        gestureStartScale = zoomState.scale;
    });
    canvas.addEventListener('gesturechange', (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const newScale = Math.max(0.05, Math.min(20, gestureStartScale * e.scale));
        zoomState.tx = mx - (mx - zoomState.tx) * (newScale / zoomState.scale);
        zoomState.ty = my - (my - zoomState.ty) * (newScale / zoomState.scale);
        zoomState.scale = newScale;
        panzoomApplyTransform(pzImg, zoomState, canvas);
    });
    canvas.addEventListener('gestureend', (e) => { e.preventDefault(); });

    // Layer 4: Touch events (pinch-to-zoom + block gesture manager for single-finger)
    let lastDist = 0;
    canvas.addEventListener('touchstart', (e) => {
        e.stopPropagation(); // Prevent gesture manager from triggering tab switch
        if (e.touches.length === 2) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            lastDist = Math.hypot(dx, dy);
        }
    });
    canvas.addEventListener('touchmove', (e) => {
        e.stopPropagation(); // Prevent gesture manager from triggering tab switch
        if (e.touches.length === 2) {
            e.preventDefault();
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const dist = Math.hypot(dx, dy);
            if (lastDist > 0) {
                const factor = dist / lastDist;
                const rect = canvas.getBoundingClientRect();
                const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
                const my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
                const newScale = Math.max(0.05, Math.min(20, zoomState.scale * factor));
                zoomState.tx = mx - (mx - zoomState.tx) * (newScale / zoomState.scale);
                zoomState.ty = my - (my - zoomState.ty) * (newScale / zoomState.scale);
                zoomState.scale = newScale;
                panzoomApplyTransform(pzImg, zoomState, canvas);
            }
            lastDist = dist;
        }
    }, { passive: false });

    // Toolbar buttons
    container.querySelectorAll('.panzoom-ctrl-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            if (action === 'pz-fit') {
                panzoomFitToView(canvas, pzImg, zoomState);
            } else if (action === 'pz-100') {
                const cr = canvas.getBoundingClientRect();
                zoomState.scale = 1;
                zoomState.tx = (cr.width - pzImg.naturalWidth) / 2;
                zoomState.ty = (cr.height - pzImg.naturalHeight) / 2;
                panzoomApplyTransform(pzImg, zoomState, canvas);
            } else if (action === 'pz-zoom-in') {
                panzoomZoomCenter(1.25, zoomState, canvas, pzImg);
            } else if (action === 'pz-zoom-out') {
                panzoomZoomCenter(0.8, zoomState, canvas, pzImg);
            } else if (action === 'pz-dark' && opts.onDarkToggle) {
                opts.onDarkToggle();
            } else if (action === 'pz-annotate' && opts.onAnnotate) {
                opts.onAnnotate();
            }
        });
    });

    // Keyboard: Cmd+/-/0 to zoom (gated by stateCheck)
    const keyHandler = (e) => {
        if (!opts.stateCheck()) return;
        if (!(e.metaKey || e.ctrlKey)) return;
        if (e.key === '=' || e.key === '+') {
            e.preventDefault();
            panzoomZoomCenter(1.25, zoomState, canvas, pzImg);
        } else if (e.key === '-') {
            e.preventDefault();
            panzoomZoomCenter(0.8, zoomState, canvas, pzImg);
        } else if (e.key === '0') {
            e.preventDefault();
            panzoomFitToView(canvas, pzImg, zoomState);
        }
    };
    document.addEventListener('keydown', keyHandler);
    canvas._panzoomKeyHandler = keyHandler;
}
