/**
 * Extra directories + path autocomplete — both the project and the global
 * "extra dirs" sections render the same kind of list (paths that get
 * passed through to Claude as `--add-dir`), and the add-input gets a
 * fish/bash-style directory completion dropdown driven by `/api/files`.
 *
 * The autocomplete state is module-level (`_dirAutocompleteTimer`,
 * `_activeDirDropdown`) since at most one dropdown is visible at a time
 * and both inputs share the same lifecycle.
 */

import { CONFIG } from '../../config.js';
import S from '../../strings.js';
import { escapeHtml } from '../../utils.js';
import { isAbsolutePath } from '../../path-utils.js';

// ═══════════════════════════════════════════════════════════════════════════
// Extra Directories - In-place update helpers
// ═══════════════════════════════════════════════════════════════════════════

export function renderExtraDirsListHTML(dirs, removeClass) {
    if (!dirs || dirs.length === 0) {
        return `<p class="config-hint" style="margin:0;opacity:0.5">${removeClass === 'extra-dir-remove' ? S.settings.hints.no_extra_dirs : S.settings.hints.no_global_extra_dirs}</p>`;
    }
    return dirs.map((dir, i) => `
        <div class="extra-dir-item" data-index="${i}">
            <span class="extra-dir-path">${escapeHtml(dir)}</span>
            <button class="${removeClass}" data-index="${i}" data-tooltip="Remove">×</button>
        </div>
    `).join('');
}

/**
 * Update extra dirs list in-place without full re-render (preserves scroll).
 * Also re-attaches remove handlers.
 */
export function updateExtraDirsInPlace(container, { listId, dirs, removeClass, getDirsFn, saveFn }) {
    const list = container.querySelector(`#${listId}`);
    if (!list) return;
    list.innerHTML = renderExtraDirsListHTML(dirs, removeClass);

    // Re-attach remove handlers
    list.querySelectorAll(`.${removeClass}`).forEach(btn => {
        btn.addEventListener('click', async () => {
            const index = parseInt(btn.dataset.index, 10);
            const current = [...getDirsFn()];
            current.splice(index, 1);
            await saveFn(current);
            updateExtraDirsInPlace(container, { listId, dirs: current, removeClass, getDirsFn, saveFn });
        });
    });
}

/**
 * Setup extra dir add handlers (input + button) with in-place update.
 */
export function setupExtraDirAddHandler(container, { inputId, btnId, listId, removeClass, getDirsFn, saveFn }) {
    const input = container.querySelector(`#${inputId}`);
    const btn = container.querySelector(`#${btnId}`);
    if (!input || !btn) return;

    const addDir = async () => {
        const dir = input.value.trim();
        if (!dir) return;
        const current = getDirsFn();
        if (current.includes(dir)) {
            input.value = '';
            return;
        }
        const updated = [...current, dir];
        await saveFn(updated);
        input.value = '';
        updateExtraDirsInPlace(container, { listId, dirs: updated, removeClass, getDirsFn, saveFn });
        // Dismiss autocomplete
        dismissDirAutocomplete(input);
    };

    btn.addEventListener('click', addDir);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addDir(); }
    });

    // Setup autocomplete
    setupDirAutocomplete(input);
}

// ═══════════════════════════════════════════════════════════════════════════
// Directory Path Autocomplete (fish/bash-style)
// ═══════════════════════════════════════════════════════════════════════════

let _dirAutocompleteTimer = null;
let _activeDirDropdown = null;

function setupDirAutocomplete(input) {
    // Create dropdown container
    const wrapper = input.closest('.extra-dir-add-row');
    if (!wrapper) return;
    wrapper.style.position = 'relative';

    let dropdown = wrapper.querySelector('.dir-autocomplete-dropdown');
    if (!dropdown) {
        dropdown = document.createElement('div');
        dropdown.className = 'dir-autocomplete-dropdown';
        wrapper.appendChild(dropdown);
    }

    let selectedIndex = -1;

    input.addEventListener('input', () => {
        clearTimeout(_dirAutocompleteTimer);
        _dirAutocompleteTimer = setTimeout(() => fetchDirSuggestions(input, dropdown), 200);
    });

    input.addEventListener('keydown', (e) => {
        if (!dropdown.classList.contains('visible')) return;
        const items = dropdown.querySelectorAll('.dir-autocomplete-item');
        if (!items.length) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
            highlightItem(items, selectedIndex);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, 0);
            highlightItem(items, selectedIndex);
        } else if (e.key === 'Tab' || (e.key === 'Enter' && selectedIndex >= 0)) {
            e.preventDefault();
            if (selectedIndex >= 0 && items[selectedIndex]) {
                applyDirSuggestion(input, items[selectedIndex].dataset.path, dropdown);
                selectedIndex = -1;
            }
        } else if (e.key === 'Escape') {
            dismissDirAutocomplete(input);
            selectedIndex = -1;
        }
    });

    input.addEventListener('blur', () => {
        // Delay to allow click on dropdown item
        setTimeout(() => dismissDirAutocomplete(input), 200);
    });
}

function highlightItem(items, index) {
    items.forEach((item, i) => item.classList.toggle('highlighted', i === index));
}

async function fetchDirSuggestions(input, dropdown) {
    const value = input.value.trim();
    if (!value || !isAbsolutePath(value)) {
        dropdown.classList.remove('visible');
        dropdown.innerHTML = '';
        return;
    }

    // Determine parent directory and prefix to filter
    let parentDir, prefix;
    if (value.endsWith('/')) {
        parentDir = value;
        prefix = '';
    } else {
        const lastSlash = value.lastIndexOf('/');
        parentDir = value.substring(0, lastSlash + 1) || '/';
        prefix = value.substring(lastSlash + 1).toLowerCase();
    }

    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/files?path=${encodeURIComponent(parentDir)}`);
        if (!response.ok) {
            dropdown.classList.remove('visible');
            return;
        }
        const data = await response.json();
        const dirs = data.files
            .filter(f => f.is_dir && !f.name.startsWith('.'))
            .filter(f => !prefix || f.name.toLowerCase().startsWith(prefix))
            .slice(0, 12);

        if (dirs.length === 0) {
            dropdown.classList.remove('visible');
            dropdown.innerHTML = '';
            return;
        }

        dropdown.innerHTML = dirs.map(d => `
            <div class="dir-autocomplete-item" data-path="${escapeHtml(d.path)}">
                <svg class="dir-autocomplete-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <span class="dir-autocomplete-name">${escapeHtml(d.name)}/</span>
            </div>
        `).join('');

        dropdown.querySelectorAll('.dir-autocomplete-item').forEach(item => {
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                applyDirSuggestion(input, item.dataset.path, dropdown);
            });
        });

        dropdown.classList.add('visible');
        _activeDirDropdown = dropdown;
    } catch (e) {
        dropdown.classList.remove('visible');
    }
}

function applyDirSuggestion(input, path, dropdown) {
    input.value = path + '/';
    dropdown.classList.remove('visible');
    input.focus();
    // Trigger another fetch for the next level
    clearTimeout(_dirAutocompleteTimer);
    _dirAutocompleteTimer = setTimeout(() => fetchDirSuggestions(input, dropdown), 100);
}

function dismissDirAutocomplete(input) {
    const wrapper = input.closest('.extra-dir-add-row');
    const dropdown = wrapper?.querySelector('.dir-autocomplete-dropdown');
    if (dropdown) {
        dropdown.classList.remove('visible');
    }
}
