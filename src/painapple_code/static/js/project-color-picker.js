/**
 * Reusable swatch popup for assigning a custom project color.
 *
 * Shared by the welcome-screen project context menu and the session tab
 * strip context menu. Palette swatches + an "Auto" chip that clears the
 * override (revert to the deterministic hash color).
 *
 * The popup persists the choice itself (via `saveProjectColor`, which also
 * updates the in-memory override map) and then invokes the caller's
 * `onChange` callback so each surface can re-render however it needs
 * (welcome re-render, tab strip re-render, …).
 */

import S from './strings.js';
import {
    PROJECT_PALETTE,
    getProjectColor,
    hasCustomProjectColor,
    saveProjectColor,
} from './project-colors.js';

// Tracks the currently-open popup's teardown so the central Escape chain
// (app.js handleEscape) can dismiss it — the global shortcut dispatcher
// calls stopImmediatePropagation() on Escape, which would otherwise starve
// a popup-local key listener.
let activeClose = null;

/**
 * Close the open project-color picker, if any. Wired into handleEscape().
 * @returns {boolean} true if a popup was open and closed
 */
export function closeProjectColorPicker() {
    if (!activeClose) return false;
    activeClose();
    return true;
}

/**
 * @param {string} projectPath - project cwd whose color is being edited
 * @param {number} x - viewport x for the popup
 * @param {number} y - viewport y for the popup
 * @param {() => void} [onChange] - called after a successful save/clear
 */
export function showProjectColorPicker(projectPath, x, y, onChange) {
    // Close any existing popup first (also detaches its listeners).
    closeProjectColorPicker();

    const current = getProjectColor(projectPath);
    const isCustom = hasCustomProjectColor(projectPath);

    const swatches = PROJECT_PALETTE.map(hex => {
        const active = isCustom && hex.toLowerCase() === (current || '').toLowerCase();
        return `<button type="button" class="project-swatch${active ? ' is-active' : ''}"
            data-color="${hex}" style="--swatch: ${hex}"
            data-tooltip="${hex}" aria-label="${hex}"></button>`;
    }).join('');

    const popup = document.createElement('div');
    popup.className = 'project-color-picker';
    popup.innerHTML = `
        <div class="project-color-picker-swatches">${swatches}</div>
        <button type="button" class="project-swatch-auto${isCustom ? '' : ' is-active'}" data-color="">
            ${S.ui.welcome.context.color_auto}
        </button>
    `;

    popup.style.position = 'fixed';
    popup.style.left = `${x}px`;
    popup.style.top = `${y}px`;
    popup.style.zIndex = '9999';
    document.body.appendChild(popup);

    // Keep the popup on-screen.
    requestAnimationFrame(() => {
        const rect = popup.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            popup.style.left = `${window.innerWidth - rect.width - 8}px`;
        }
        if (rect.bottom > window.innerHeight) {
            popup.style.top = `${window.innerHeight - rect.height - 8}px`;
        }
    });

    const outside = (e) => {
        if (!popup.contains(e.target)) close();
    };
    const close = () => {
        popup.remove();
        document.removeEventListener('click', outside);
        activeClose = null;
    };
    activeClose = close;

    popup.querySelectorAll('[data-color]').forEach(btn => {
        btn.addEventListener('click', async () => {
            close();
            try {
                await saveProjectColor(projectPath, btn.dataset.color || null);
                onChange?.();
            } catch (e) {
                console.error('Failed to set project color:', e);
            }
        });
    });

    // Dismiss on outside click. Escape is handled centrally via
    // handleEscape() → closeProjectColorPicker() (the global shortcut
    // dispatcher swallows Escape before a local listener would see it).
    setTimeout(() => document.addEventListener('click', outside), 0);
}
