/**
 * Tooltip System — JS-driven position:fixed tooltips
 *
 * Uses event delegation with pointermove/pointerout on document to show
 * tooltips for any element with [data-tooltip]. Position:fixed means
 * tooltips are immune to overflow:hidden/auto clipping.
 *
 * pointermove handling is RAF-throttled and the show/hide is debounced
 * so a fast mouse sweep across many hoverable elements doesn't churn the
 * tooltip element. The previous (debounce-free, synchronous) version
 * caused per-pixel reflow + opacity-transition re-triggers, which on
 * WebKit/iPadOS invalidated the text-cursor caret and the live text
 * selection layer — the "cursor blinks / selection blinks while moving"
 * symptom.
 *
 * Respects data-tooltip-position="top|bottom|left|right" (default: top).
 */

let tooltipEl = null;
let pendingTarget = null;   // [data-tooltip] the pointer is currently over (or null)
let visibleTarget = null;   // [data-tooltip] whose tooltip is currently displayed (or null)
let showTimer = null;
let hideTimer = null;
let rafId = 0;
let pendingEventTarget = null;

const SHOW_DELAY = 120;     // ms — idle-hover before tooltip appears
const HIDE_DELAY = 80;      // ms — grace period before tooltip disappears
const GAP = 6;              // px between element and tooltip

function getTooltipEl() {
    if (!tooltipEl) {
        tooltipEl = document.createElement('div');
        tooltipEl.className = 'tooltip-fixed';
        document.body.appendChild(tooltipEl);
    }
    return tooltipEl;
}

function positionTooltip(el, target) {
    // Single layout read for the target. Tooltip's own size is read from
    // offsetWidth/Height which the browser can serve from the previous
    // layout box if nothing else has invalidated layout — far cheaper
    // than getBoundingClientRect.
    const rect = target.getBoundingClientRect();
    const tipW = el.offsetWidth;
    const tipH = el.offsetHeight;
    const pos = target.getAttribute('data-tooltip-position') || 'top';

    let x, y;
    switch (pos) {
        case 'bottom':
            x = rect.left + rect.width / 2 - tipW / 2;
            y = rect.bottom + GAP;
            if (y + tipH > window.innerHeight - 4) {
                y = rect.top - tipH - GAP;
            }
            break;
        case 'left':
            x = rect.left - tipW - GAP - 2;
            y = rect.top + rect.height / 2 - tipH / 2;
            break;
        case 'right':
            x = rect.right + GAP + 2;
            y = rect.top + rect.height / 2 - tipH / 2;
            break;
        default: // top
            x = rect.left + rect.width / 2 - tipW / 2;
            y = rect.top - tipH - GAP;
            if (y < 4) {
                y = rect.bottom + GAP;
            }
            break;
    }

    x = Math.max(4, Math.min(x, window.innerWidth - tipW - 4));
    y = Math.max(4, Math.min(y, window.innerHeight - tipH - 4));

    // ONE style write via transform. The element stays at top:0/left:0
    // and is moved via translate3d — compositor-only, no paint, no
    // reflow. left/top writes invalidate the WebKit selection layer
    // (cursor + selection repaint storm); transform does not.
    el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
}

function showImmediate(target) {
    // Expanded rail renders its own text labels — a tooltip would only
    // duplicate the label sitting right under the pointer
    if (document.body.classList.contains('rail-labels') && target.closest('#left-rail')) return;

    const text = target.getAttribute('data-tooltip');
    if (!text) return;

    const el = getTooltipEl();
    const wasVisible = el.classList.contains('visible');
    if (el.textContent !== text) el.textContent = text;
    // Multiline opt-in (wrapping + max-width) — must be applied BEFORE
    // positioning, since it changes the tooltip's own size.
    el.classList.toggle('multiline', target.hasAttribute('data-tooltip-multiline'));
    positionTooltip(el, target);

    if (!wasVisible) {
        // Force reflow only on hidden→visible so the opacity transition
        // fires from 0. Repositioning an already-visible tooltip just
        // updates transform — no transition re-trigger.
        void el.offsetHeight;
        el.classList.add('visible');
    }
    visibleTarget = target;
}

function clearTimers() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

function hide() {
    clearTimers();
    pendingTarget = null;
    visibleTarget = null;
    if (tooltipEl) tooltipEl.classList.remove('visible');
}

function processMove(newTarget) {
    if (newTarget === pendingTarget) return;
    pendingTarget = newTarget;
    clearTimers();

    if (!newTarget) {
        if (visibleTarget) {
            hideTimer = setTimeout(() => {
                hideTimer = null;
                visibleTarget = null;
                if (tooltipEl) tooltipEl.classList.remove('visible');
            }, HIDE_DELAY);
        }
        return;
    }

    if (visibleTarget) {
        // Direct switch between tooltips — no fade-out/in
        showImmediate(newTarget);
        return;
    }

    showTimer = setTimeout(() => {
        showTimer = null;
        showImmediate(newTarget);
    }, SHOW_DELAY);
}

/**
 * Initialize global tooltip event delegation
 */
export function initTooltips() {
    document.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch') return;
        pendingEventTarget = e.target;
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
            rafId = 0;
            const target = pendingEventTarget && pendingEventTarget.closest
                ? pendingEventTarget.closest('[data-tooltip]')
                : null;
            processMove(target);
        });
    });

    document.addEventListener('pointerout', (e) => {
        if (e.pointerType === 'touch') return;
        // Pointer left the window entirely — no further pointermove will arrive.
        if (!e.relatedTarget) processMove(null);
    });

    document.addEventListener('scroll', hide, true);
    document.addEventListener('pointerdown', hide);
}

/**
 * TooltipManager — programmatic API (for components that need it)
 */
export const TooltipManager = {
    hideTooltip: hide,

    showTooltip(text, x, y, delay = 0) {
        hide();
        const doShow = () => {
            const el = getTooltipEl();
            el.classList.remove('multiline'); // programmatic path is single-line
            el.textContent = text;
            el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
            void el.offsetHeight;
            el.classList.add('visible');
        };
        if (delay > 0) {
            showTimer = setTimeout(doShow, delay);
        } else {
            doShow();
        }
    }
};
