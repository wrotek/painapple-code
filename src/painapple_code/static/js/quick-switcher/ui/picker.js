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

/**
 * A mode tab. `prefix` doubles as the identity key (the registry prefix the
 * tab activates), so the active tab can be resolved from controller state
 * without a parallel id lookup.
 */
function tabHtml({ prefix, glyph, label }, index) {
    const glyphHtml = glyph
        ? `<span class="qs-tab-glyph">${escapeHtml(glyph)}</span>`
        : '';
    return `<button type="button" class="qs-tab" role="tab" aria-selected="false"`
        + ` data-index="${index}" data-prefix="${escapeHtml(prefix)}" tabindex="-1">`
        + glyphHtml
        + `<span class="qs-tab-label">${escapeHtml(label)}</span>`
        + `</button>`;
}

const DEBOUNCE_MS = 100;
const LONG_PRESS_MS = 500;

export class QuickPicker {
    constructor({ onValueChange, onSubmit, onCancel, onContextMenu, onBackspaceEmpty, onDrillIn, onDrillOut, onTabSelect }) {
        this.onValueChange = onValueChange;
        this.onSubmit = onSubmit;
        this.onCancel = onCancel;
        this.onContextMenu = onContextMenu;
        this.onBackspaceEmpty = onBackspaceEmpty;
        this.onDrillIn = onDrillIn;
        this.onDrillOut = onDrillOut;
        this.onTabSelect = onTabSelect;

        this.items = [];
        this.selectedIndex = 0;
        this._sectionTitle = null;
        this._debounceTimer = null;
        this._previousActiveEl = null;
        this._longPressTimer = null;
        this._tabs = S.quick_switcher.tabs || [];
        this._activePrefix = '';

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
            hintHtml(H.keys.tabs, H.labels.tabs, 'qs-hint-tabs'),
            hintHtml(H.keys.close, H.labels.close),
            `<span class="qs-hint qs-hint-drill" hidden></span>`,
        ].join('');
        const tabsHtml = this._tabs.map(tabHtml).join('');
        overlay.innerHTML = `
            <div class="qs-modal" role="combobox" aria-expanded="true" aria-haspopup="listbox" aria-owns="qs-list">
                <div class="qs-input-wrap">
                    <input type="text" class="qs-input" autocomplete="off" autocapitalize="off"
                           autocorrect="off" spellcheck="false"
                           data-shortcuts-disabled="true"
                           aria-controls="qs-list" aria-activedescendant=""
                           placeholder="${S.quick_switcher.placeholders.default}">
                    <span class="qs-result-count" aria-live="polite" hidden></span>
                </div>
                <div class="qs-tabs" role="tablist" aria-label="${escapeHtml(H.labels.tabs || 'switch mode')}">${tabsHtml}</div>
                <div class="qs-list" id="qs-list" role="listbox"></div>
                <div class="qs-footer">
                    <div class="qs-footer-row qs-footer-actions">${actionsHtml}</div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        this.overlay = overlay;
        this.modal = overlay.querySelector('.qs-modal');
        this.input = overlay.querySelector('.qs-input');
        this.list = overlay.querySelector('.qs-list');
        this.resultCount = overlay.querySelector('.qs-result-count');
        this.tabsEl = overlay.querySelector('.qs-tabs');
        this.tabEls = Array.from(this.tabsEl.querySelectorAll('.qs-tab'));
        this.drillHint = overlay.querySelector('.qs-hint-drill');

        // mousedown, not click: the input must never lose focus to the button,
        // or the picker closes/blurs between press and release on iPadOS.
        this.tabsEl.addEventListener('mousedown', (e) => this._onTabPointer(e));
        this.tabsEl.addEventListener('touchstart', (e) => this._onTabPointer(e), { passive: false });

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

    _onTabPointer(e) {
        const btn = e.target.closest('.qs-tab');
        if (!btn) return;
        // Keep focus in the input — a focused <button> would swallow the
        // arrow keys the list navigation depends on.
        e.preventDefault();
        const tab = this._tabs[parseInt(btn.dataset.index, 10)];
        if (tab) this.onTabSelect?.(tab);
    }

    /** Step to the next/previous non-action tab (Ctrl/Cmd + ←/→). */
    _cycleTab(delta) {
        const selectable = this._tabs.filter(t => !t.action);
        if (!selectable.length) return;
        const cur = selectable.findIndex(t => t.prefix === this._activePrefix);
        const next = selectable[((cur < 0 ? 0 : cur) + delta + selectable.length) % selectable.length];
        if (next) this.onTabSelect?.(next);
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
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    this._cycleTab(1);
                    break;
                }
                // Drill into the selected item — only meaningful at the end of
                // the input so we don't steal cursor-movement inside a query.
                if (this.input.selectionStart === this.input.value.length) {
                    const item = this.getSelectedItem();
                    if (item) this.onDrillIn?.(item);
                }
                break;
            case 'ArrowLeft':
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    this._cycleTab(-1);
                    break;
                }
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

    /**
     * Reflect the controller's active prefix on the tab strip. Named
     * setPrefix because the prefix remains the mode's identity — the tabs
     * are just its rendering.
     */
    setPrefix(prefix) {
        this._activePrefix = prefix || '';
        let active = null;
        for (const el of this.tabEls) {
            const on = el.dataset.prefix === this._activePrefix;
            el.classList.toggle('active', on);
            el.setAttribute('aria-selected', on ? 'true' : 'false');
            if (on) active = el;
        }
        // The strip scrolls horizontally on narrow screens; a mode reached by
        // typing its prefix must still bring its own tab into view.
        active?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    }

    /**
     * Result count for the current list — the number the old "FILES 15"
     * header carried. It lives at the end of the input row, not on the
     * active tab: a tab sized by its own count would resize on every mode
     * switch and shuffle every tab after it.
     */
    _setActiveCount(count) {
        this.resultCount.textContent = count > 0 ? String(count) : '';
        this.resultCount.hidden = !(count > 0);
    }

    setItems(items, sectionTitle = null) {
        this.items = items || [];
        // A provider can pre-select one item (e.g. the current project in
        // the ~ list); otherwise selection starts at the top as usual.
        this.selectedIndex = Math.max(0, this.items.findIndex(it => it.preselected));
        this._sectionTitle = sectionTitle;
        this._setActiveCount(this.items.length);
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
            this._setActiveCount(0);
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
            // A flat list gets no header — the active tab already names the
            // mode and carries the count. The controller passes a title only
            // for the one list a tab can't name: a project's sessions.
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
