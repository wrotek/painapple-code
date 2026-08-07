/**
 * QuickPicker — the modal UI: overlay + input + list + footer.
 *
 * Construction is idempotent (one DOM tree, reused across show/hide).
 * The controller wires callbacks via constructor options.
 */

import S from '../../strings.js';
import { escapeHtml } from '../../utils.js';
import { renderItem, renderSection, renderEmpty } from './item.js';

/** A key hint: keycap glyph + label. */
function hintHtml(key, label, cls = '') {
    return `<span class="qs-hint${cls ? ' ' + cls : ''}">`
        + `<kbd class="qs-kbd">${escapeHtml(key)}</kbd>`
        + `<span class="qs-hint-label">${escapeHtml(label)}</span></span>`;
}

/** A prefix legend chip: accent keycap glyph + what it opens. */
function prefixHint({ glyph, label }) {
    return `<span class="qs-prefix-hint">`
        + `<kbd class="qs-kbd qs-kbd-prefix">${escapeHtml(glyph)}</kbd>`
        + `<span class="qs-hint-label">${escapeHtml(label)}</span></span>`;
}

const DEBOUNCE_MS = 100;
const LONG_PRESS_MS = 500;

export class QuickPicker {
    constructor({ onValueChange, onSubmit, onCancel, onContextMenu, onBackspaceEmpty, onDrillIn, onDrillOut }) {
        this.onValueChange = onValueChange;
        this.onSubmit = onSubmit;
        this.onCancel = onCancel;
        this.onContextMenu = onContextMenu;
        this.onBackspaceEmpty = onBackspaceEmpty;
        this.onDrillIn = onDrillIn;
        this.onDrillOut = onDrillOut;

        this.items = [];
        this.selectedIndex = 0;
        this._sectionTitle = null;
        this._debounceTimer = null;
        this._previousActiveEl = null;
        this._longPressTimer = null;

        this._build();
    }

    _build() {
        const overlay = document.createElement('div');
        overlay.id = 'quick-switcher-overlay';
        overlay.className = 'qs-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Quick Switcher');
        overlay.hidden = true;
        const H = S.quick_switcher.hints;
        const actionsHtml = [
            hintHtml(H.keys.nav, H.labels.navigate),
            hintHtml(H.keys.open, H.labels.open),
            hintHtml(H.keys.menu, H.labels.menu),
            hintHtml(H.keys.close, H.labels.close),
            `<span class="qs-hint qs-hint-drill" hidden></span>`,
        ].join('');
        const prefixesHtml = (H.prefixes || []).map(prefixHint).join('');
        overlay.innerHTML = `
            <div class="qs-modal" role="combobox" aria-expanded="true" aria-haspopup="listbox" aria-owns="qs-list">
                <div class="qs-input-wrap">
                    <span class="qs-prefix-badge" hidden></span>
                    <input type="text" class="qs-input" autocomplete="off" autocapitalize="off"
                           autocorrect="off" spellcheck="false"
                           data-shortcuts-disabled="true"
                           aria-controls="qs-list" aria-activedescendant=""
                           placeholder="${S.quick_switcher.placeholders.default}">
                </div>
                <div class="qs-list" id="qs-list" role="listbox"></div>
                <div class="qs-footer">
                    <div class="qs-footer-row qs-footer-actions">${actionsHtml}</div>
                    <div class="qs-footer-row qs-footer-prefixes">${prefixesHtml}</div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        this.overlay = overlay;
        this.modal = overlay.querySelector('.qs-modal');
        this.input = overlay.querySelector('.qs-input');
        this.prefixBadge = overlay.querySelector('.qs-prefix-badge');
        this.list = overlay.querySelector('.qs-list');
        this.drillHint = overlay.querySelector('.qs-hint-drill');

        this.input.addEventListener('input', () => this._scheduleChange());
        this.input.addEventListener('keydown', (e) => this._onKey(e));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this.onCancel?.();
        });
        this.list.addEventListener('click', (e) => {
            const it = e.target.closest('.qs-item');
            if (!it) return;
            this.selectedIndex = parseInt(it.dataset.index, 10);
            this._render();
            this.onSubmit?.(this._optsFromEvent(e));
        });
        this.list.addEventListener('auxclick', (e) => {
            if (e.button !== 1) return;
            const it = e.target.closest('.qs-item');
            if (!it) return;
            e.preventDefault();
            this.selectedIndex = parseInt(it.dataset.index, 10);
            this._render();
            this.onSubmit?.({ background: true });
        });
        this.list.addEventListener('contextmenu', (e) => {
            const it = e.target.closest('.qs-item');
            if (!it) return;
            e.preventDefault();
            e.stopPropagation();
            this.selectedIndex = parseInt(it.dataset.index, 10);
            this._render();
            this.onContextMenu?.({ item: this.getSelectedItem(), x: e.clientX, y: e.clientY });
        });
        // Also swallow contextmenu on the overlay itself so the FAB radial
        // doesn't fire when right-clicking the padding around the list.
        overlay.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        this.list.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: true });
        this.list.addEventListener('touchend', () => this._cancelLongPress());
        this.list.addEventListener('touchmove', () => this._cancelLongPress(), { passive: true });
        this.list.addEventListener('scroll', () => this._cancelLongPress(), { passive: true });
    }

    _optsFromEvent(e) {
        const mod = e.metaKey || e.ctrlKey;
        if (mod && e.shiftKey) return { newTab: true };
        if (mod) return { background: true };
        return {};
    }

    _onTouchStart(e) {
        const it = e.target.closest('.qs-item');
        if (!it) return;
        const touch = e.touches[0];
        const x = touch.clientX, y = touch.clientY;
        this._cancelLongPress();
        this._longPressTimer = setTimeout(() => {
            this._longPressTimer = null;
            this.selectedIndex = parseInt(it.dataset.index, 10);
            this._render();
            this.onContextMenu?.({ item: this.getSelectedItem(), x, y });
        }, LONG_PRESS_MS);
    }

    _openContextMenuForSelection() {
        const sel = this.list.querySelector('.qs-item.selected');
        const rect = sel?.getBoundingClientRect();
        const x = rect ? rect.right - 8 : window.innerWidth / 2;
        const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
        this.onContextMenu?.({ item: this.getSelectedItem(), x, y });
    }

    _cancelLongPress() {
        if (this._longPressTimer) {
            clearTimeout(this._longPressTimer);
            this._longPressTimer = null;
        }
    }

    _scheduleChange() {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => this.onValueChange?.(this.input.value), DEBOUNCE_MS);
    }

    _onKey(e) {
        switch (e.key) {
            case 'Tab':
                // Trap focus inside the picker. Tab cycles items like ↓/↑ —
                // matches common autocomplete behaviour and stops the browser
                // from walking focus out to the page behind the overlay.
                e.preventDefault();
                this._move(e.shiftKey ? -1 : 1);
                break;
            case 'ArrowDown':
                e.preventDefault();
                this._move(1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                this._move(-1);
                break;
            case 'ArrowRight':
                // Drill into the selected item — only meaningful at the end of
                // the input so we don't steal cursor-movement inside a query.
                if (this.input.selectionStart === this.input.value.length) {
                    const item = this.getSelectedItem();
                    if (item) this.onDrillIn?.(item);
                }
                break;
            case 'ArrowLeft':
                // Drill out only when the cursor is at the very start of an
                // empty input — leaves normal text editing untouched.
                if (this.input.value === '' && this.input.selectionStart === 0) {
                    this.onDrillOut?.();
                }
                break;
            case 'Enter':
                e.preventDefault();
                if (!this.items.length) break;
                if (e.altKey) {
                    this._openContextMenuForSelection();
                } else {
                    this.onSubmit?.(this._optsFromEvent(e));
                }
                break;
            case 'F10':
                if (e.shiftKey) {
                    e.preventDefault();
                    if (this.items.length) this._openContextMenuForSelection();
                }
                break;
            case 'Escape':
                e.preventDefault();
                this.onCancel?.();
                break;
            case 'Backspace':
                // Backspace on empty input while a prefix is active —
                // controller clears the prefix state and reverts to default.
                if (this.input.value === '') this.onBackspaceEmpty?.();
                break;
            case 'Home':
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    this.selectedIndex = 0;
                    this._render();
                }
                break;
            case 'End':
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    this.selectedIndex = this.items.length - 1;
                    this._render();
                }
                break;
        }
    }

    _move(delta) {
        if (!this.items.length) return;
        const n = this.items.length;
        this.selectedIndex = (this.selectedIndex + delta + n) % n;
        this._render();
        const sel = this.list.querySelector('.qs-item.selected');
        if (!sel) return;
        // If a section header sits directly above, scroll it into view too —
        // otherwise {block:'nearest'} clips the header when wrapping to the
        // first item of a group.
        const prev = sel.previousElementSibling;
        const target = prev?.classList.contains('qs-section') ? prev : sel;
        target.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }

    show(initialValue = '') {
        if (!this.overlay.hidden) {
            this.input.focus();
            this.input.select();
            return;
        }
        this._previousActiveEl = document.activeElement;
        this.overlay.hidden = false;
        this.input.value = initialValue;
        this.setPrefix('');
        this.setDrillHint(null);
        this.items = [];
        this.selectedIndex = 0;
        this._sectionTitle = null;
        this._render();
        requestAnimationFrame(() => {
            this.input.focus();
            // Initial value flows through onValueChange so the controller's
            // prefix detection runs the same way as if the user had typed it.
            // The picker then peels the prefix off into the badge.
            this.onValueChange?.(initialValue);
        });
    }

    hide() {
        if (this.overlay.hidden) return;
        this.overlay.hidden = true;
        clearTimeout(this._debounceTimer);
        this._cancelLongPress();
        if (this._previousActiveEl && document.contains(this._previousActiveEl)) {
            this._previousActiveEl.focus?.();
        }
        this._previousActiveEl = null;
    }

    focusInput() {
        this.input?.focus();
    }

    isOpen() {
        return !this.overlay.hidden;
    }

    setPlaceholder(text) {
        this.input.placeholder = text;
    }

    setDrillHint(hint) {
        if (hint && hint.key) {
            this.drillHint.innerHTML =
                `<kbd class="qs-kbd">${escapeHtml(hint.key)}</kbd>`
                + `<span class="qs-hint-label">${escapeHtml(hint.label || '')}</span>`;
            this.drillHint.hidden = false;
        } else {
            this.drillHint.hidden = true;
        }
    }

    setPrefix(prefix) {
        if (prefix) {
            this.prefixBadge.textContent = prefix.trim() || prefix;
            this.prefixBadge.hidden = false;
        } else {
            this.prefixBadge.hidden = true;
        }
    }

    setItems(items, sectionTitle = null) {
        this.items = items || [];
        // A provider can pre-select one item (e.g. the current project in
        // the ~ list); otherwise selection starts at the top as usual.
        this.selectedIndex = Math.max(0, this.items.findIndex(it => it.preselected));
        this._sectionTitle = sectionTitle;
        this._render();
        if (this.selectedIndex > 0) {
            this.list.querySelector('.qs-item.selected')
                ?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
        }
    }

    _render() {
        if (!this.items.length) {
            const text = this.input.value.trim()
                ? S.quick_switcher.empty.no_results
                : ' ';
            this.list.innerHTML = renderEmpty(text);
            this.input.setAttribute('aria-activedescendant', '');
            return;
        }

        const parts = [];
        const hasGroups = this.items.some(it => it.group);
        if (hasGroups) {
            let currentGroup = null;
            for (let i = 0; i < this.items.length; i++) {
                const g = this.items[i].group || null;
                if (g !== currentGroup) {
                    currentGroup = g;
                    if (g) parts.push(renderSection(g));
                }
                parts.push(renderItem(this.items[i], i, i === this.selectedIndex));
            }
        } else {
            if (this._sectionTitle) parts.push(renderSection(this._sectionTitle, this.items.length));
            for (let i = 0; i < this.items.length; i++) {
                parts.push(renderItem(this.items[i], i, i === this.selectedIndex));
            }
        }
        this.list.innerHTML = parts.join('');
        this.input.setAttribute('aria-activedescendant', `qs-item-${this.selectedIndex}`);
    }

    getValue() {
        return this.input.value;
    }

    setValue(value) {
        // Programmatic — does not fire the 'input' event, so no re-entrant
        // onValueChange. Callers that need the provider re-run must do it
        // themselves.
        this.input.value = value;
    }

    getSelectedItem() {
        return this.items[this.selectedIndex] || null;
    }
}
