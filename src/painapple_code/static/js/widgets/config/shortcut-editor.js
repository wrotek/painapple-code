/**
 * ShortcutEditor — the keyboard-shortcut customization UI for the Settings
 * widget. Stateful enough to deserve its own class (capture mode, search
 * filters, conflict detection); a single instance is constructed once at
 * widget registration and stored on `state.shortcutEditor`.
 *
 * Reads/writes the user shortcut overrides via the shared ConfigState
 * singleton, then asks the global shortcut manager to reload bindings.
 */

import S from '../../strings.js';
import { escapeHtml } from '../../utils.js';
import { SHORTCUTS, CATEGORIES, resolveKeys, formatKeyForDisplay } from '../../shortcuts.js';
import { state } from './state.js';

export class ShortcutEditor {
    constructor() {
        this.capturing = false;
        this.captureTarget = null;
        this.captureSlot = 0;
        this.captureElement = null;
        this.captureHandler = null;

        // Search/filter state
        this.searchQuery = '';
        this.categoryFilter = null; // null = all
        this.showCustomizedOnly = false;
        this.showConflictsOnly = false;
    }

    /**
     * Detect if search query looks like a key combo (e.g., "ctrl+k", "alt")
     */
    isKeySearch(query) {
        if (!query) return false;
        const q = query.toLowerCase();
        // Contains + or starts with modifier
        return q.includes('+') ||
               /^(ctrl|alt|shift|cmd|meta|f[0-9]|escape|enter|tab|space|backspace)/.test(q);
    }

    /**
     * Find all conflicting shortcuts (same normalized key assigned to multiple actions)
     */
    findAllConflicts() {
        const overrides = state.getShortcutOverrides();
        const keyToShortcuts = new Map();
        const normalize = k => k.toLowerCase().split('+').sort().join('+');

        for (const shortcut of SHORTCUTS) {
            if (shortcut.hidden) continue;
            const hasOverride = !!overrides[shortcut.id];
            const keys = hasOverride ? overrides[shortcut.id] : resolveKeys(shortcut);
            for (const key of keys) {
                const normalized = normalize(key);
                if (!keyToShortcuts.has(normalized)) keyToShortcuts.set(normalized, []);
                keyToShortcuts.get(normalized).push(shortcut.id);
            }
        }

        // Return set of shortcut IDs that have conflicts
        const conflictingIds = new Set();
        for (const [, ids] of keyToShortcuts) {
            if (ids.length > 1) {
                ids.forEach(id => conflictingIds.add(id));
            }
        }
        return conflictingIds;
    }

    /**
     * Filter shortcuts based on current search/filter state
     */
    filterShortcuts(shortcuts) {
        const overrides = state.getShortcutOverrides();
        const query = this.searchQuery.toLowerCase().trim();
        const isKeySearch = this.isKeySearch(query);
        const conflictingIds = this.showConflictsOnly ? this.findAllConflicts() : null;

        return shortcuts.filter(shortcut => {
            // Category filter
            if (this.categoryFilter && shortcut.category !== this.categoryFilter) {
                return false;
            }

            // Customized only filter
            if (this.showCustomizedOnly && !overrides[shortcut.id]) {
                return false;
            }

            // Conflicts only filter
            if (this.showConflictsOnly && !conflictingIds?.has(shortcut.id)) {
                return false;
            }

            // Text search
            if (query) {
                const currentKeys = overrides[shortcut.id] || resolveKeys(shortcut);

                if (isKeySearch) {
                    // Search in keys - normalize and match
                    const keysStr = currentKeys.map(k => k.toLowerCase()).join(' ');
                    // Also try matching the raw query against normalized keys
                    const normalizedQuery = query.split('+').sort().join('+');
                    const anyKeyMatches = currentKeys.some(k => {
                        const normalizedKey = k.toLowerCase().split('+').sort().join('+');
                        return normalizedKey.includes(normalizedQuery) || k.toLowerCase().includes(query);
                    });
                    if (!anyKeyMatches && !keysStr.includes(query)) {
                        return false;
                    }
                } else {
                    // Search in label
                    if (!shortcut.label.toLowerCase().includes(query)) {
                        return false;
                    }
                }
            }

            return true;
        });
    }

    /**
     * Highlight matching text in a string
     */
    highlightMatch(text, query) {
        if (!query) return escapeHtml(text);
        const escaped = escapeHtml(text);
        const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        return escaped.replace(regex, '<mark class="shortcut-match">$1</mark>');
    }

    /**
     * Render search bar and filters
     */
    renderSearchUI() {
        const customizedCount = Object.keys(state.getShortcutOverrides()).length;
        const conflictCount = this.findAllConflicts().size;

        return `
            <div class="shortcuts-search">
                <div class="shortcuts-search-input-wrapper">
                    <svg class="shortcuts-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="11" cy="11" r="8"/>
                        <path d="M21 21l-4.35-4.35"/>
                    </svg>
                    <input type="text"
                           class="shortcuts-search-input"
                           placeholder="${S.settings.shortcuts_tab.search_placeholder}"
                           value="${escapeHtml(this.searchQuery)}">
                    ${this.searchQuery ? `
                        <button class="shortcuts-search-clear" data-tooltip="Clear search">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    ` : ''}
                </div>
                <div class="shortcuts-filters">
                    <div class="shortcuts-filter-group shortcuts-category-chips">
                        <button class="shortcuts-chip ${!this.categoryFilter ? 'active' : ''}" data-category="">All</button>
                        ${Object.entries(CATEGORIES).map(([cat, label]) => `
                            <button class="shortcuts-chip ${this.categoryFilter === cat ? 'active' : ''}" data-category="${cat}">
                                ${escapeHtml(label.replace(' & ', '/'))}
                            </button>
                        `).join('')}
                    </div>
                    <div class="shortcuts-filter-group shortcuts-toggle-filters">
                        <button class="shortcuts-chip shortcuts-chip-toggle ${this.showCustomizedOnly ? 'active' : ''}"
                                data-toggle="customized"
                                ${customizedCount === 0 ? 'disabled' : ''}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                            Customized${customizedCount > 0 ? ` (${customizedCount})` : ''}
                        </button>
                        <button class="shortcuts-chip shortcuts-chip-toggle ${this.showConflictsOnly ? 'active' : ''}"
                                data-toggle="conflicts"
                                ${conflictCount === 0 ? 'disabled' : ''}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                            </svg>
                            Conflicts${conflictCount > 0 ? ` (${conflictCount})` : ''}
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    render(container) {
        const overrides = state.getShortcutOverrides();
        const query = this.searchQuery.toLowerCase().trim();
        const isKeySearch = this.isKeySearch(query);
        const conflictingIds = this.findAllConflicts();

        let html = this.renderSearchUI();

        // Get all non-hidden shortcuts
        const allShortcuts = SHORTCUTS.filter(s => !s.hidden);
        const filtered = this.filterShortcuts(allShortcuts);

        // Group filtered shortcuts by category
        const byCategory = {};
        for (const shortcut of filtered) {
            const cat = shortcut.category;
            if (!byCategory[cat]) byCategory[cat] = [];
            byCategory[cat].push(shortcut);
        }

        // Check if we have any results
        const hasResults = filtered.length > 0;

        if (!hasResults) {
            html += `
                <div class="shortcuts-no-results">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="11" cy="11" r="8"/>
                        <path d="M21 21l-4.35-4.35"/>
                    </svg>
                    <p>No shortcuts match your search</p>
                    <button class="shortcuts-clear-filters">Clear filters</button>
                </div>
            `;
        } else {
            // Show result count when filtering
            if (this.searchQuery || this.categoryFilter || this.showCustomizedOnly || this.showConflictsOnly) {
                html += `<div class="shortcuts-result-count">${filtered.length} of ${allShortcuts.length} shortcuts</div>`;
            }

            // Render each category that has results
            for (const [category, label] of Object.entries(CATEGORIES)) {
                const shortcuts = byCategory[category];
                if (!shortcuts || shortcuts.length === 0) continue;

                html += `<div class="shortcuts-category">
                    <h3 class="shortcuts-category-title">${escapeHtml(label)}</h3>
                    <div class="shortcuts-category-list">`;

                for (const shortcut of shortcuts) {
                    const hasOverride = overrides[shortcut.id];
                    const currentKeys = hasOverride || resolveKeys(shortcut);
                    const primaryKey = currentKeys[0] || null;
                    const secondaryKey = currentKeys[1] || null;
                    const defaultKeys = this.formatKeysForDisplay(resolveKeys(shortcut));
                    const hasConflict = conflictingIds.has(shortcut.id);

                    // Determine what to highlight
                    const labelHtml = (!isKeySearch && query)
                        ? this.highlightMatch(shortcut.label, query)
                        : escapeHtml(shortcut.label);

                    html += `
                        <div class="shortcut-item ${hasOverride ? 'customized' : ''} ${hasConflict ? 'has-conflict' : ''}" data-shortcut-id="${shortcut.id}">
                            <div class="shortcut-info">
                                <span class="shortcut-label">${labelHtml}</span>
                                ${hasOverride ? `<span class="shortcut-default" data-tooltip="Default: ${escapeHtml(defaultKeys)}">(custom)</span>` : ''}
                                ${hasConflict ? `<span class="shortcut-conflict-badge" data-tooltip="Conflicting shortcut">⚠</span>` : ''}
                            </div>
                            <div class="shortcut-keys">
                                <button class="shortcut-key-btn ${isKeySearch && query && primaryKey?.toLowerCase().includes(query) ? 'key-match' : ''}" data-slot="0" data-tooltip="Primary shortcut">
                                    ${primaryKey ? this.formatSingleKey(primaryKey) : '<span class="key-empty">None</span>'}
                                </button>
                                <button class="shortcut-key-btn shortcut-key-secondary ${isKeySearch && query && secondaryKey?.toLowerCase().includes(query) ? 'key-match' : ''}" data-slot="1" data-tooltip="${secondaryKey ? 'Secondary shortcut' : 'Add secondary shortcut'}">
                                    ${secondaryKey ? this.formatSingleKey(secondaryKey) : '<span class="key-add">+</span>'}
                                </button>
                                ${secondaryKey ? `<button class="shortcut-remove-secondary-btn" data-tooltip="Remove secondary shortcut">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M18 6L6 18M6 6l12 12"/>
                                    </svg>
                                </button>` : ''}
                                ${hasOverride ? `<button class="shortcut-reset-btn" data-tooltip="Reset to default">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                                        <path d="M3 3v5h5"/>
                                    </svg>
                                </button>` : ''}
                            </div>
                        </div>
                    `;
                }

                html += '</div></div>';
            }
        }

        container.innerHTML = html;
        this.attachEventHandlers(container);
        this.attachSearchHandlers(container);
    }

    /**
     * Attach search and filter event handlers
     */
    attachSearchHandlers(container) {
        // Search input
        const searchInput = container.querySelector('.shortcuts-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.searchQuery = e.target.value;
                this.render(container);
                // Refocus and restore cursor position
                const newInput = container.querySelector('.shortcuts-search-input');
                if (newInput) {
                    newInput.focus();
                    newInput.setSelectionRange(e.target.selectionStart, e.target.selectionEnd);
                }
            });

            // Handle Escape to clear search
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    if (this.searchQuery) {
                        e.preventDefault();
                        e.stopPropagation();
                        this.searchQuery = '';
                        this.render(container);
                    }
                }
            });
        }

        // Clear search button
        const clearBtn = container.querySelector('.shortcuts-search-clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                this.searchQuery = '';
                this.render(container);
                container.querySelector('.shortcuts-search-input')?.focus();
            });
        }

        // Category chips
        container.querySelectorAll('.shortcuts-chip[data-category]').forEach(chip => {
            chip.addEventListener('click', () => {
                const category = chip.dataset.category;
                this.categoryFilter = category || null;
                this.render(container);
            });
        });

        // Toggle filters (customized, conflicts)
        container.querySelectorAll('.shortcuts-chip-toggle').forEach(chip => {
            chip.addEventListener('click', () => {
                if (chip.disabled) return;
                const toggle = chip.dataset.toggle;
                if (toggle === 'customized') {
                    this.showCustomizedOnly = !this.showCustomizedOnly;
                    if (this.showCustomizedOnly) this.showConflictsOnly = false;
                } else if (toggle === 'conflicts') {
                    this.showConflictsOnly = !this.showConflictsOnly;
                    if (this.showConflictsOnly) this.showCustomizedOnly = false;
                }
                this.render(container);
            });
        });

        // Clear filters button (in no results state)
        const clearFiltersBtn = container.querySelector('.shortcuts-clear-filters');
        if (clearFiltersBtn) {
            clearFiltersBtn.addEventListener('click', () => {
                this.searchQuery = '';
                this.categoryFilter = null;
                this.showCustomizedOnly = false;
                this.showConflictsOnly = false;
                this.render(container);
            });
        }
    }

    attachEventHandlers(container) {
        // Key buttons (primary and secondary)
        container.querySelectorAll('.shortcut-key-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const item = btn.closest('.shortcut-item');
                const id = item.dataset.shortcutId;
                const slot = parseInt(btn.dataset.slot, 10);
                this.startCapture(id, slot, btn);
            });
        });

        // Remove secondary shortcut
        container.querySelectorAll('.shortcut-remove-secondary-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const item = btn.closest('.shortcut-item');
                const id = item.dataset.shortcutId;
                this.removeSecondaryShortcut(id, container);
            });
        });

        // Reset to defaults
        container.querySelectorAll('.shortcut-reset-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const item = btn.closest('.shortcut-item');
                const id = item.dataset.shortcutId;
                this.resetShortcut(id, container);
            });
        });
    }

    formatKeysForDisplay(keys) {
        if (!keys || keys.length === 0) return S.settings.shortcut_none;
        return keys.map(k => formatKeyForDisplay(k)).join(' / ');
    }

    formatSingleKey(key) {
        if (!key) return '';
        return escapeHtml(formatKeyForDisplay(key));
    }

    startCapture(shortcutId, slot, buttonElement) {
        this.cancelCapture();

        this.capturing = true;
        this.captureTarget = shortcutId;
        this.captureSlot = slot;
        this.captureElement = buttonElement;

        buttonElement.classList.add('capturing');
        buttonElement.innerHTML = S.settings.shortcut_capture;
        buttonElement.focus();

        this.captureHandler = (e) => this.handleCapture(e);
        document.addEventListener('keydown', this.captureHandler, true);
    }

    handleCapture(e) {
        // Ignore modifier-only presses
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
            return;
        }

        e.preventDefault();
        e.stopImmediatePropagation();

        // Escape cancels capture rather than getting bound as a shortcut.
        if (e.key === 'Escape') {
            this.cancelCapture();
            return;
        }

        // Build the key string
        const parts = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.metaKey) parts.push('Cmd');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');

        // Normalize the key
        let key = e.key;
        if (key === ' ') key = 'Space';
        if (key.length === 1) key = key.toUpperCase();
        if (e.code === 'Backquote') key = '`';

        // Special keys
        const specialKeys = {
            'Escape': 'Escape',
            'Enter': 'Enter',
            'Tab': 'Tab',
            'Backspace': 'Backspace',
            'Delete': 'Delete',
            'ArrowUp': 'Up',
            'ArrowDown': 'Down',
            'ArrowLeft': 'Left',
            'ArrowRight': 'Right',
            'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4',
            'F5': 'F5', 'F6': 'F6', 'F7': 'F7', 'F8': 'F8',
            'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
        };
        if (specialKeys[e.key]) key = specialKeys[e.key];

        parts.push(key);
        const keyString = parts.join('+');

        // Check for conflicts
        const conflict = this.findConflict(keyString, this.captureTarget);
        if (conflict) {
            this.captureElement.innerHTML = `Conflict: ${escapeHtml(conflict.label)}`;
            this.captureElement.classList.add('conflict');
            setTimeout(() => {
                this.captureElement.classList.remove('conflict');
                this.captureElement.innerHTML = S.settings.shortcut_capture;
            }, 1500);
            return;
        }

        // Build new keys array
        const overrides = state.getShortcutOverrides();
        const shortcut = SHORTCUTS.find(s => s.id === this.captureTarget);
        const currentKeys = overrides[this.captureTarget] || shortcut?.keys || [];

        let newKeys;
        if (this.captureSlot === 0) {
            newKeys = [keyString];
            if (currentKeys[1]) {
                newKeys.push(currentKeys[1]);
            }
        } else {
            newKeys = [currentKeys[0] || '', keyString].filter(Boolean);
        }

        state.saveShortcutOverride(this.captureTarget, newKeys);

        // Re-render
        this.cancelCapture();
        const container = state.container?.querySelector('.shortcuts-list');
        if (container) {
            this.render(container);
        }
    }

    findConflict(keyString, excludeId) {
        const normalize = k => k.toLowerCase().split('+').sort().join('+');
        const normalized = normalize(keyString);
        const overrides = state.getShortcutOverrides();

        for (const shortcut of SHORTCUTS) {
            if (shortcut.id === excludeId) continue;

            const hasOverride = !!overrides[shortcut.id];
            const keys = hasOverride ? overrides[shortcut.id] : resolveKeys(shortcut);
            for (const key of keys) {
                if (normalize(key) === normalized) {
                    return shortcut;
                }
            }
        }

        return null;
    }

    cancelCapture() {
        if (!this.capturing) return;

        this.capturing = false;

        if (this.captureElement) {
            this.captureElement.classList.remove('capturing');
            const id = this.captureTarget;
            const shortcut = SHORTCUTS.find(s => s.id === id);
            const overrides = state.getShortcutOverrides();
            const keys = overrides[id] || shortcut?.keys || [];
            const key = keys[this.captureSlot];

            if (this.captureSlot === 0) {
                this.captureElement.innerHTML = key ? this.formatSingleKey(key) : '<span class="key-empty">None</span>';
            } else {
                this.captureElement.innerHTML = key ? this.formatSingleKey(key) : '<span class="key-add">+</span>';
            }
        }

        if (this.captureHandler) {
            document.removeEventListener('keydown', this.captureHandler, true);
            this.captureHandler = null;
        }

        this.captureTarget = null;
        this.captureSlot = 0;
        this.captureElement = null;
    }

    removeSecondaryShortcut(shortcutId, container) {
        const overrides = state.getShortcutOverrides();
        const shortcut = SHORTCUTS.find(s => s.id === shortcutId);
        const currentKeys = overrides[shortcutId] || shortcut?.keys || [];

        if (currentKeys.length > 0) {
            state.saveShortcutOverride(shortcutId, [currentKeys[0]]);
        }

        this.render(container);
    }

    resetShortcut(shortcutId, container) {
        state.removeShortcutOverride(shortcutId);
        this.render(container);
    }

    resetAll(container) {
        state.resetAllShortcuts();
        this.render(container);
    }
}
