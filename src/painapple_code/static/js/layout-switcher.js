/**
 * Layout Density Switcher
 * Popup opened from the left-rail density button. Lets the user flip
 * compact/normal/spacious and watch the UI reflow live — selecting an
 * option keeps the popup open; outside click / Escape dismisses.
 *
 * Exposes the same isOpen/close() contract as permissionSettings /
 * effortSettings so app.handleEscape() can close it in its priority chain.
 */

import S from './strings.js';
import { state as configState } from './widgets/config/state.js';

class LayoutSwitcher {
    constructor() {
        this.popup = null;
        this.anchor = null;
        this._outsideClick = (e) => {
            if (!this.popup) return;
            if (this.popup.contains(e.target)) return;
            if (this.anchor && this.anchor.contains(e.target)) return;
            this.close();
        };
        // Keep the selected row in sync if the mode changes elsewhere
        // (config widget radios) while the popup is open.
        window.addEventListener('layout-changed', () => {
            if (this.popup) this._render();
        });
    }

    get isOpen() {
        return !!this.popup;
    }

    toggle(anchor) {
        if (this.isOpen) {
            this.close();
        } else {
            this.open(anchor);
        }
    }

    open(anchor) {
        this.close();
        this.anchor = anchor || null;

        const popup = document.createElement('div');
        popup.className = 'density-popup';
        this.popup = popup;
        this._render();

        popup.addEventListener('click', (e) => {
            // Don't bubble to the outside-click handler: the re-render
            // below detaches e.target, so popup.contains() would read it
            // as an outside click and close the popup.
            e.stopPropagation();
            const opt = e.target.closest('.density-option');
            if (!opt) return;
            configState.setLayout(opt.dataset.layoutMode);
            // Stay open — the whole point is flipping modes and watching
            // the UI reflow live.
        });

        document.body.appendChild(popup);

        // Anchored to the right of the rail button, bottom-aligned with it;
        // clamped into the viewport (rail collapses to a drawer on narrow
        // screens, where the button can sit anywhere).
        if (anchor) {
            const rect = anchor.getBoundingClientRect();
            const width = popup.offsetWidth || 230;
            popup.style.left = `${Math.max(8, Math.min(rect.right + 8, window.innerWidth - width - 8))}px`;
            popup.style.bottom = `${Math.max(8, window.innerHeight - rect.bottom)}px`;
            anchor.classList.add('active');
        } else {
            popup.style.left = '56px';
            popup.style.bottom = '16px';
        }

        requestAnimationFrame(() => popup.classList.add('open'));
        // Defer so the click that opened the popup can't immediately close it.
        setTimeout(() => document.addEventListener('click', this._outsideClick), 0);
    }

    _render() {
        if (!this.popup) return;
        const current = configState.config.layout || 'normal';
        this.popup.innerHTML = Object.entries(S.settings.layout_modes).map(([mode, m]) =>
            `<div class="density-option${mode === current ? ' selected' : ''}" data-layout-mode="${mode}">
                <span class="density-option-label">${m.label}</span>
                <span class="density-option-desc">${m.desc}</span>
            </div>`
        ).join('');
    }

    close() {
        document.removeEventListener('click', this._outsideClick);
        if (this.popup) {
            this.popup.remove();
            this.popup = null;
        }
        if (this.anchor) {
            this.anchor.classList.remove('active');
            this.anchor = null;
        }
    }
}

export const layoutSwitcher = new LayoutSwitcher();
