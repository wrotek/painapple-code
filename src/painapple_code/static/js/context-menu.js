/**
 * Custom context menu for file paths and other elements.
 * Provides a native-feeling context menu that works on both desktop and iPad (long-press).
 */

import { $, escapeHtml } from './utils.js';
import S from './strings.js';
import { ICONS } from './widget-system/icons.js';

/**
 * Surfaces that own their own keyboard focus. When a context menu opened from
 * inside one of these is dismissed and nothing else took focus, we restore that
 * surface's own search/filter box rather than stealing focus to the chat input.
 */
const FOCUS_OWNER_SELECTOR = '.qs-overlay, .open-dialog, .widget, [role="dialog"]';

/** Text-entry controls only — never a checkbox/radio/hidden field. */
const TEXT_INPUT_SELECTOR = [
    'input[type="text"]:not([disabled])',
    'input[type="search"]:not([disabled])',
    'input:not([type]):not([disabled])',
    'textarea:not([disabled])',
].join(', ');

export class ContextMenu {
    constructor() {
        this.menu = null;
        this.visible = false;
        this._previousActiveEl = null;
        this._anchorEl = null;
        this._submenus = [];
        this.boundHide = this.hide.bind(this);
        // Click-to-dismiss: ignore clicks on the menu, submenu trigger, or
        // submenu popout (those have their own handlers that hide on action).
        this.boundDismissOnClick = (e) => {
            if (e.target.closest('.context-menu')) return;
            if (e.target.closest('.context-menu-submenu-items')) return;
            this.hide();
        };
        this.boundOnKeyDown = this.onKeyDown.bind(this);
        this.boundOnScroll = () => this.hide();
        this.createMenu();
    }

    createMenu() {
        this.menu = document.createElement('div');
        this.menu.className = 'context-menu';
        this.menu.setAttribute('role', 'menu');
        this.menu.style.display = 'none';
        document.body.appendChild(this.menu);
    }

    /**
     * Fill a menu-item button with an optional leading icon plus its label.
     * The glyph comes from the trusted ICONS registry (inline SVG); the label
     * is always written with textContent so item text can never inject markup.
     * @param {HTMLElement} menuItem
     * @param {{label: string, icon?: string}} item
     * @param {boolean} reserveIconSlot - render an empty slot when this item
     *   has no icon but a sibling does, keeping labels aligned.
     * @private
     */
    _setItemContent(menuItem, item, reserveIconSlot) {
        const iconSvg = item.icon ? ICONS[item.icon] : null;
        if (iconSvg || reserveIconSlot) {
            const iconEl = document.createElement('span');
            iconEl.className = 'context-menu-icon';
            if (iconSvg) iconEl.innerHTML = iconSvg;
            else iconEl.classList.add('is-empty');
            menuItem.appendChild(iconEl);
        }
        const labelEl = document.createElement('span');
        labelEl.className = 'context-menu-label';
        labelEl.textContent = item.label;
        menuItem.appendChild(labelEl);
    }

    /**
     * Show context menu at position with given items
     * @param {number} x - X coordinate (clientX)
     * @param {number} y - Y coordinate (clientY)
     * @param {Array<{label: string, icon?: string, action?: Function, disabled?: boolean, type?: 'separator', separator?: boolean, submenu?: Array}>} items
     */
    show(x, y, items) {
        // Remember focus so hide() can restore it (e.g. keep the Quick
        // Switcher input focused after dismissing the menu with Escape).
        this._previousActiveEl = document.activeElement;

        // Remember what the menu was opened ON. A right-click blurs the
        // previously focused element first (activeElement becomes <body>), so
        // the anchor is the only reliable signal of which surface the menu
        // belongs to. Captured before the menu is shown, so elementFromPoint
        // still sees the element underneath.
        this._anchorEl = document.elementFromPoint(x, y);

        // Clean up any submenu popouts from a previous show()
        this._removeSubmenus();
        this._submenus = [];

        // Clear existing items
        this.menu.innerHTML = '';

        // If ANY item carries an icon, every plain item gets an icon slot —
        // empty for the iconless ones — so all labels stay left-aligned
        // instead of going ragged around the few that have a glyph.
        const anyIcon = items.some(i => i && i.icon && ICONS[i.icon]);

        // Build menu items
        items.forEach((item) => {
            if (item.type === 'separator' || item.separator) {
                const sep = document.createElement('div');
                sep.className = 'context-menu-separator';
                sep.setAttribute('role', 'separator');
                this.menu.appendChild(sep);
            } else if (item.submenu && item.submenu.length > 0) {
                // Submenu trigger button stays in the parent menu; the popout
                // is appended to <body> so backdrop-filter / transform on
                // .context-menu can't trap its position:fixed descendants.
                const menuItem = document.createElement('button');
                menuItem.className = 'context-menu-item has-submenu';
                menuItem.setAttribute('role', 'menuitem');
                menuItem.innerHTML = `${escapeHtml(item.label)} <span class="submenu-arrow">›</span>`;

                const submenu = document.createElement('div');
                submenu.className = 'context-menu-submenu-items';
                submenu.dataset.submenuFor = item.label;

                item.submenu.forEach(subItem => {
                    const subMenuItem = document.createElement('button');
                    subMenuItem.className = 'context-menu-item';
                    subMenuItem.setAttribute('role', 'menuitem');
                    if (subItem.sublabel) {
                        subMenuItem.innerHTML = `<span class="menu-label">${escapeHtml(subItem.label)}</span><span class="menu-sublabel">${escapeHtml(subItem.sublabel)}</span>`;
                    } else {
                        subMenuItem.textContent = subItem.label;
                    }
                    subMenuItem.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        this.hide();
                        if (subItem.action) subItem.action();
                    });
                    submenu.appendChild(subMenuItem);
                });

                // Track for positioning/cleanup
                this._submenus.push({ trigger: menuItem, popout: submenu });

                // Hover / click both open it (keep last-opened active)
                const openThis = () => {
                    this._submenus.forEach(s => s.popout.classList.toggle('open', s.popout === submenu));
                    menuItem.classList.add('active');
                    this.menu.querySelectorAll('.context-menu-item.has-submenu').forEach(b => {
                        if (b !== menuItem) b.classList.remove('active');
                    });
                };
                // Mouse hover only (pointerType filter) — iOS fires mouseenter as
                // a compatibility event on tap, which would race the click and
                // make the just-opened submenu intercept the same touch.
                menuItem.addEventListener('pointerenter', (e) => {
                    if (e.pointerType !== 'mouse') return;
                    menuItem.classList.add('hover-mouse');
                    openThis();
                });
                menuItem.addEventListener('pointerleave', () => {
                    menuItem.classList.remove('hover-mouse');
                });
                submenu.addEventListener('pointerenter', (e) => {
                    if (e.pointerType === 'mouse') openThis();
                });
                menuItem.addEventListener('focus', openThis);
                menuItem.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openThis();
                });

                document.body.appendChild(submenu);
                this.menu.appendChild(menuItem);
            } else {
                const menuItem = document.createElement('button');
                menuItem.className = 'context-menu-item';
                menuItem.setAttribute('role', 'menuitem');
                this._setItemContent(menuItem, item, anyIcon);
                if (item.disabled) {
                    menuItem.disabled = true;
                }
                // Trackpad/mouse hover: highlight + close any open submenu.
                // The hover-mouse class is needed because iPadOS reports
                // pointer:coarse even with a Magic Trackpad, so the CSS
                // :hover suppression for touch devices also kills trackpad
                // hover. JS pointerType disambiguates.
                menuItem.addEventListener('pointerenter', (e) => {
                    if (e.pointerType !== 'mouse') return;
                    menuItem.classList.add('hover-mouse');
                    this._closeSubmenus();
                });
                menuItem.addEventListener('pointerleave', () => {
                    menuItem.classList.remove('hover-mouse');
                });
                menuItem.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.hide();
                    if (item.action) item.action();
                });
                this.menu.appendChild(menuItem);
            }
        });

        // Position menu (make visible first to measure)
        this.menu.style.display = 'block';
        this.menu.style.visibility = 'hidden';

        // Force reflow to get accurate dimensions
        const rect = this.menu.getBoundingClientRect();

        this.positionMenu(x, y, rect.width, rect.height);
        this.menu.style.visibility = 'visible';
        this.visible = true;

        // Pre-position submenus next to their triggers (needed because submenu
        // uses position: fixed to escape the menu's overflow:hidden clip).
        this._positionSubmenus();

        // Add event listeners for dismissal
        // Use setTimeout to avoid immediate dismissal from the same event
        setTimeout(() => {
            document.addEventListener('click', this.boundDismissOnClick, true);
            document.addEventListener('contextmenu', this.boundHide, true);
            document.addEventListener('keydown', this.boundOnKeyDown, true);
            window.addEventListener('scroll', this.boundOnScroll, true);
            window.addEventListener('resize', this.boundHide);
        }, 10);

        // Don't auto-focus the first item: `:focus-visible` matches the
        // programmatic focus on Safari/iPadOS, painting the accent stripe
        // under the user's pointer immediately on open. Arrow-key nav still
        // works — `navigateItems` handles the no-focus case (Down → first
        // item, Up → last). Escape is on document, focus-independent.
    }

    /**
     * Position each submenu popout next to its trigger button using
     * viewport coords (position: fixed). Popouts live on document.body
     * so transform/backdrop-filter on .context-menu can't trap them.
     *
     * Placement order (first that fits):
     *   1. right of the parent menu, vertically aligned with trigger
     *   2. left of the parent menu, vertically aligned with trigger
     *   3. below the parent menu (full width)
     *   4. above the parent menu (full width)
     * Anchoring against the parent MENU's rect (not just the trigger)
     * ensures the submenu never overlaps the trigger button — otherwise
     * a tap on the trigger could land on a freshly-shown submenu item.
     */
    _positionSubmenus() {
        if (!this._submenus || !this._submenus.length) return;
        const padding = 8;
        const gap = 4;
        const menuRect = this.menu.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        for (const { trigger, popout } of this._submenus) {
            const prevDisplay = popout.style.display;
            const prevVis = popout.style.visibility;
            popout.style.display = 'block';
            popout.style.visibility = 'hidden';
            const triggerRect = trigger.getBoundingClientRect();
            const subRect = popout.getBoundingClientRect();
            popout.style.display = prevDisplay;
            popout.style.visibility = prevVis;

            let left, top;
            // 1. Right of menu
            if (menuRect.right + gap + subRect.width <= vw - padding) {
                left = menuRect.right + gap;
                top = triggerRect.top;
            // 2. Left of menu
            } else if (menuRect.left - gap - subRect.width >= padding) {
                left = menuRect.left - subRect.width - gap;
                top = triggerRect.top;
            // 3. Below menu
            } else if (menuRect.bottom + gap + subRect.height <= vh - padding) {
                left = Math.max(padding, Math.min(menuRect.left, vw - subRect.width - padding));
                top = menuRect.bottom + gap;
            // 4. Above menu
            } else {
                left = Math.max(padding, Math.min(menuRect.left, vw - subRect.width - padding));
                top = Math.max(padding, menuRect.top - gap - subRect.height);
            }

            // Vertical clamp for cases 1–2 in case trigger sits near viewport edge
            if (top + subRect.height > vh - padding) top = vh - subRect.height - padding;
            if (top < padding) top = padding;

            popout.style.left = `${left}px`;
            popout.style.top = `${top}px`;
        }
    }

    /** Close any open submenu popouts (kept in DOM, ready to re-open). */
    _closeSubmenus() {
        if (!this._submenus) return;
        for (const { trigger, popout } of this._submenus) {
            popout.classList.remove('open');
            trigger.classList.remove('active');
        }
    }

    /** Remove all submenu popouts from document.body. */
    _removeSubmenus() {
        if (!this._submenus) return;
        for (const { popout } of this._submenus) {
            popout.remove();
        }
        this._submenus = [];
    }

    positionMenu(x, y, menuWidth, menuHeight) {
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const padding = 10;

        // Adjust if menu goes off right edge
        if (x + menuWidth > viewportWidth - padding) {
            x = viewportWidth - menuWidth - padding;
        }

        // Adjust if menu goes off bottom edge
        if (y + menuHeight > viewportHeight - padding) {
            // Try positioning above the click point
            if (y - menuHeight > padding) {
                y = y - menuHeight;
            } else {
                // Not enough space above either, just position at bottom
                y = viewportHeight - menuHeight - padding;
            }
        }

        // Ensure not negative
        x = Math.max(padding, x);
        y = Math.max(padding, y);

        this.menu.style.left = `${x}px`;
        this.menu.style.top = `${y}px`;
    }

    hide() {
        if (!this.visible) return;

        this.menu.style.display = 'none';
        this.visible = false;

        // Submenu popouts live on body — clear them so they don't linger
        this._removeSubmenus();

        document.removeEventListener('click', this.boundDismissOnClick, true);
        document.removeEventListener('contextmenu', this.boundHide, true);
        document.removeEventListener('keydown', this.boundOnKeyDown, true);
        window.removeEventListener('scroll', this.boundOnScroll, true);
        window.removeEventListener('resize', this.boundHide);

        // Restore focus to whatever was focused before the menu opened.
        // Menu actions call hide() before running; if an action moves focus
        // afterwards, it wins — this restore only matters for Escape / click
        // dismissals where no action fires.
        const prev = this._previousActiveEl;
        this._previousActiveEl = null;
        if (prev && document.contains(prev) && typeof prev.focus === 'function') {
            prev.focus();
        }

        // If nothing meaningful ended up focused — the menu was opened from a
        // non-focusable element (a turn-summary file pill, a message thumb, a
        // list row), so the restore above was a no-op — put focus somewhere
        // useful so typing resumes immediately. A real previous focus target
        // still wins, since it's the active element by now and this is skipped.
        const anchor = this._anchorEl;
        this._anchorEl = null;
        const active = document.activeElement;
        if (!active || active === document.body || active === document.documentElement) {
            // Prefer the search/filter box of the surface the menu was opened
            // from — a right-click inside the Quick Switcher blurs its input,
            // so without this the chat input would steal focus while the
            // switcher is still up. Falls through to the chat input otherwise.
            const host = anchor?.closest?.(FOCUS_OWNER_SELECTOR);
            const ownInput = host?.querySelector(TEXT_INPUT_SELECTOR);
            if (ownInput) ownInput.focus();
            else window.app?.focusInput?.();
        }
    }

    onKeyDown(e) {
        if (!this.visible) return;

        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this.hide();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            // stopPropagation so arrows don't also move the underlying
            // list/switcher selection.
            e.preventDefault();
            e.stopPropagation();
            this.navigateItems(e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'Enter') {
            // Let the focused button handle it naturally
        }
    }

    navigateItems(direction) {
        const items = Array.from(this.menu.querySelectorAll('.context-menu-item:not(:disabled)'));
        if (items.length === 0) return;

        const currentIndex = items.indexOf(document.activeElement);
        let nextIndex;

        if (currentIndex === -1) {
            nextIndex = direction === 1 ? 0 : items.length - 1;
        } else {
            nextIndex = (currentIndex + direction + items.length) % items.length;
        }

        items[nextIndex].focus();
    }

    /**
     * Destroy the context menu element
     */
    destroy() {
        this.hide();
        if (this.menu && this.menu.parentNode) {
            this.menu.parentNode.removeChild(this.menu);
        }
        this.menu = null;
    }
}

// ── File download helpers ────────────────────────────────────────────────

/**
 * Detect if running on iOS/iPadOS (including iPadOS 13+ which reports as Mac)
 */
function isIOSDevice() {
    return /(iPad|iPhone|iPod)/.test(navigator.userAgent) ||
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * Resolve effective download mode from user config.
 * 'auto' → 'copy' on iOS/iPadOS, 'download' elsewhere.
 * @returns {'copy' | 'download'}
 */
export function getEffectiveDownloadMode() {
    try {
        const saved = localStorage.getItem('claude-code-user-config');
        if (saved) {
            const mode = JSON.parse(saved).downloadMode;
            if (mode === 'copy' || mode === 'download') return mode;
        }
    } catch (_) {}
    // 'auto' or unset — detect platform
    return isIOSDevice() ? 'copy' : 'download';
}

/**
 * Get label for download action in context menus
 */
export function getDownloadLabel() {
    return getEffectiveDownloadMode() === 'copy' ? 'Copy Download Link' : 'Download';
}

/**
 * Get tooltip for download button in toolbars
 */
export function getDownloadTooltip() {
    return getEffectiveDownloadMode() === 'copy' ? 'Copy download link' : 'Download file';
}

/**
 * Build the raw file URL for a given path
 */
export function buildFileRawUrl(path) {
    return `${location.origin}/api/file-raw?path=${encodeURIComponent(path)}`;
}

/**
 * Build a copy-safe download URL: mints a short-lived auth token (?dl=) so
 * the link works when opened outside the authed browser context (e.g. copied
 * from the iPad PWA and pasted into Safari, which has no auth cookie).
 * Falls back to the bare URL if minting fails.
 * @param {string} path - Absolute file path
 * @returns {Promise<string>}
 */
async function buildTokenizedFileRawUrl(path) {
    const localUrl = `/api/file-raw?path=${encodeURIComponent(path)}`;
    try {
        const res = await fetch('/api/auth/download-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: localUrl }),
        });
        if (res.ok) {
            const data = await res.json();
            if (data && typeof data.url === 'string') return `${location.origin}${data.url}`;
        }
    } catch (_) {}
    return `${location.origin}${localUrl}`;
}

/**
 * Perform download action on a file — either copy link or trigger download,
 * based on user config (auto-detects iOS for copy mode).
 * @param {string} path - Absolute file path
 */
export async function fileDownloadAction(path) {
    if (getEffectiveDownloadMode() === 'copy') {
        const urlPromise = buildTokenizedFileRawUrl(path);
        let copied = false;
        // Promise-based ClipboardItem keeps the copy inside the user-gesture
        // window on Safari, which otherwise rejects clipboard writes after
        // the token fetch's await.
        if (navigator.clipboard && window.ClipboardItem) {
            try {
                await navigator.clipboard.write([new ClipboardItem({
                    'text/plain': urlPromise.then(u => new Blob([u], { type: 'text/plain' })),
                })]);
                copied = true;
            } catch (_) {}
        }
        if (!copied) copied = await copyToClipboard(await urlPromise);
        if (copied) showToast(S.toast.link_copied);
    } else {
        const url = buildFileRawUrl(path);
        const a = document.createElement('a');
        a.href = url;
        a.download = path.split('/').pop();
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }
}

// ── Input-type detection ────────────────────────────────────────────────

/**
 * Last pointer type seen anywhere in the document ('mouse' | 'touch' | 'pen').
 *
 * Media queries can't answer this on iPadOS — it reports `hover: none` even
 * with a Magic Keyboard trackpad attached — so the only reliable signal is
 * what the user actually touched last.
 */
let _lastPointerType = 'mouse';
document.addEventListener('pointerdown', (e) => {
    if (e.pointerType) _lastPointerType = e.pointerType;
}, true);

/**
 * True when the last input was a finger. Used to stand down custom
 * long-press menus on touch so WebKit can show its own callout instead —
 * iOS's native image menu can copy image bytes, which `navigator.clipboard`
 * cannot do inside an iPad PWA.
 * @returns {boolean}
 */
export function lastInputWasTouch() {
    return _lastPointerType === 'touch';
}

// ── Image clipboard helpers ─────────────────────────────────────────────

/**
 * Extract the underlying filesystem path from an image src, if it carries
 * one. Our image URLs encode the real path as a `path` query param
 * (`/api/file-raw?path=…`, `/api/sessions/…/uploads/…` do not). Returns
 * null when the src is a data-URI or has no path param.
 * @param {string} src
 * @returns {string|null}
 */
export function filePathFromSrc(src) {
    if (!src || src.startsWith('data:')) return null;
    try {
        const u = new URL(src, location.origin);
        return u.searchParams.get('path');
    } catch {
        return null;
    }
}

/**
 * Re-encode an arbitrary image blob to PNG via a canvas. Safari/iPadOS only
 * accept `image/png` on the clipboard, so non-PNG sources must be converted.
 * @param {Blob} blob
 * @returns {Promise<Blob>}
 */
function reencodeToPng(blob) {
    return new Promise((resolve, reject) => {
        const objUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth || img.width;
                canvas.height = img.naturalHeight || img.height;
                canvas.getContext('2d').drawImage(img, 0, 0);
                canvas.toBlob((out) => {
                    URL.revokeObjectURL(objUrl);
                    out ? resolve(out) : reject(new Error('toBlob returned null'));
                }, 'image/png');
            } catch (e) {
                URL.revokeObjectURL(objUrl);
                reject(e);
            }
        };
        img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error('image decode failed')); };
        img.src = objUrl;
    });
}

/**
 * Copy an image (by URL or data-URI) to the clipboard as PNG.
 * @param {string} src - Image source (same-origin URL or data URI)
 * @returns {Promise<boolean>} success
 */
export async function copyImageToClipboard(src) {
    if (!src || !navigator.clipboard || !window.ClipboardItem) return false;
    try {
        // Promise-based ClipboardItem keeps the write inside the user-gesture
        // window on Safari, which otherwise rejects clipboard writes after the
        // fetch/decode await chain resolves.
        const pngPromise = fetch(src)
            .then(r => r.blob())
            .then(blob => (blob.type === 'image/png' ? blob : reencodeToPng(blob)));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngPromise })]);
        return true;
    } catch (_) {
        return false;
    }
}

// ── Clipboard / toast utilities ─────────────────────────────────────────

/**
 * Copy text to clipboard with fallback for older browsers
 * @param {string} text - Text to copy
 * @returns {Promise<boolean>} - Success status
 */
export async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (err) {
        // Fallback for older browsers or when clipboard API fails
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        textArea.style.top = '-9999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        try {
            document.execCommand('copy');
            return true;
        } catch (err2) {
            console.error('Failed to copy to clipboard:', err2);
            return false;
        } finally {
            document.body.removeChild(textArea);
        }
    }
}

/**
 * Show a toast notification.
 * @param {string} message - Text or HTML to display
 * @param {number|object} options - Duration in ms OR options object:
 *   {number}   duration     - Auto-dismiss time in ms (default 1500)
 *   {boolean}  html         - Render message as innerHTML (default false)
 *   {boolean}  pauseOnHover - Pause dismiss timer on hover/touch (default false)
 *   {boolean}  interactive  - Enable pointer-events for click handlers (default false)
 *   {string}   className    - Additional CSS class(es) on the toast element
 *   {function} onMount      - Callback(toastEl) after toast is added to DOM
 */
// Track last typing time for toast positioning
let _lastTypingTime = 0;
document.addEventListener('input', (e) => {
    if (e.target.matches('textarea, input[type="text"], [contenteditable]')) {
        _lastTypingTime = Date.now();
    }
}, true);

export function showToast(message, options = {}) {
    if (typeof options === 'number') options = { duration: options };
    const { duration = 1500, html = false, pauseOnHover = false,
            interactive = false, className = '', onMount = null } = options;

    const existing = $('.context-menu-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'context-menu-toast' + (className ? ' ' + className : '');
    // Position top if user hasn't typed in last 5s
    if (Date.now() - _lastTypingTime > 5000) toast.classList.add('toast-top');
    if (interactive) toast.style.pointerEvents = 'auto';
    if (html) toast.innerHTML = message; else toast.textContent = message;
    document.body.appendChild(toast);

    if (onMount) onMount(toast);

    requestAnimationFrame(() => toast.classList.add('visible'));

    const dismiss = () => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 200);
    };

    if (interactive || pauseOnHover) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'toast-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });
        toast.prepend(closeBtn);
    }

    if (pauseOnHover) {
        let timer = null;
        const start = () => { timer = setTimeout(dismiss, duration); };
        const pause = () => { if (timer) { clearTimeout(timer); timer = null; } };
        toast.addEventListener('mouseenter', pause);
        toast.addEventListener('mouseleave', start);
        toast.addEventListener('touchstart', pause, { passive: true });
        toast.addEventListener('touchend', () => setTimeout(start, 500), { passive: true });
        start();
    } else {
        setTimeout(dismiss, duration);
    }
}
