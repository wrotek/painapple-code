/**
 * File Autocomplete Module
 * Provides fuzzy file path suggestions when user types @ in chat input
 */

import { CONFIG } from './config.js';
import { escapeHtml } from './utils.js';
import { anchorAbove } from './caret-position.js';

/**
 * Get file extension for display
 */
function getFileExtension(path) {
    const parts = path.split('.');
    if (parts.length > 1) {
        return parts.pop().toLowerCase();
    }
    return '';
}

/**
 * FileAutocomplete - Fuzzy file path suggestions on @ trigger
 */
export class FileAutocomplete {
    /**
     * @param {HTMLTextAreaElement} input - The message input element
     * @param {Object} options - Configuration options
     * @param {string} options.apiBase - API base URL
     * @param {Object} callbacks - Callback functions
     * @param {Function} callbacks.getCwd - Returns current working directory
     * @param {Function} callbacks.getChangedFiles - Returns recently changed files
     */
    constructor(input, options = {}, callbacks = {}) {
        this.input = input;
        this.apiBase = options.apiBase || CONFIG.API_BASE;

        // Callbacks
        this.getCwd = callbacks.getCwd || (() => null);
        this.getChangedFiles = callbacks.getChangedFiles || (() => []);

        // State
        this.visible = false;
        this.items = [];
        this.selectedIndex = 0;
        this.triggerPos = -1;  // Position of @ in input
        this.query = '';

        // File cache per CWD
        this.cache = new Map();  // cwd -> {files, directories, timestamp}
        this.cacheTTL = 30000;   // 30 seconds

        // Mentioned files tracking (for smart ranking)
        this.mentionedFiles = new Map();  // path -> count

        // Create container
        this.container = document.createElement('div');
        this.container.id = 'file-autocomplete';
        this.container.className = 'file-autocomplete';

        // Insert before input (will be positioned absolutely)
        this.input.parentElement.insertBefore(this.container, this.input);

        // Debounce timer
        this._debounceTimer = null;

        // Bind click handler
        this._handleClick = this._handleClick.bind(this);
        this.container.addEventListener('click', this._handleClick);
    }

    /**
     * Check if files are cached for the current CWD
     */
    _isCacheValid(cwd) {
        const cached = this.cache.get(cwd);
        if (!cached) return false;
        return Date.now() - cached.timestamp < this.cacheTTL;
    }

    /**
     * Load files from server (with caching)
     */
    async loadFiles(cwd, force = false) {
        if (!cwd) return;

        if (!force && this._isCacheValid(cwd)) {
            return;  // Use cached data
        }

        try {
            const response = await fetch(
                `${this.apiBase}/api/files/list?cwd=${encodeURIComponent(cwd)}`
            );
            if (!response.ok) {
                console.warn('[FileAutocomplete] Failed to load files:', response.status);
                return;
            }

            const data = await response.json();
            this.cache.set(cwd, {
                files: data.files || [],
                directories: data.directories || [],
                timestamp: Date.now()
            });
        } catch (err) {
            console.warn('[FileAutocomplete] Failed to load files:', err);
        }
    }

    /**
     * Fuzzy match score between query and path
     * Returns 0 for no match, positive score otherwise
     */
    _fuzzyScore(path, query) {
        if (!query) return 1;  // Empty query matches everything

        const pathLower = path.toLowerCase();
        const queryLower = query.toLowerCase();

        let score = 0;
        let pathIdx = 0;
        let prevMatchIdx = -1;
        let consecutiveBonus = 0;

        for (const char of queryLower) {
            const idx = pathLower.indexOf(char, pathIdx);
            if (idx === -1) return 0;  // No match

            // Word boundary bonus (after / . - _)
            if (idx === 0 || '/._-'.includes(pathLower[idx - 1])) {
                score += 10;
            }

            // Consecutive character bonus (grows for longer streaks)
            if (prevMatchIdx !== -1 && idx === prevMatchIdx + 1) {
                consecutiveBonus += 2;
                score += 5 + consecutiveBonus;
            } else {
                consecutiveBonus = 0;
            }

            // Filename match bonus (matching in filename, not directories)
            const lastSlash = pathLower.lastIndexOf('/');
            if (idx > lastSlash) {
                score += 2;
            }

            score += 1;  // Base match score
            prevMatchIdx = idx;
            pathIdx = idx + 1;
        }

        // Substring-in-basename boost: the greedy scorer above takes the first
        // occurrence of each query char, which can miss the real match when the
        // same word appears earlier in the path (e.g. `src/monitoring/MonitoringData.php`
        // matches the dir's `monitoring`, then can't streak through `Data`).
        const lastSlashEnd = pathLower.lastIndexOf('/');
        const basename = lastSlashEnd >= 0 ? pathLower.slice(lastSlashEnd + 1) : pathLower;
        if (basename.includes(queryLower)) {
            score += 200;
            if (basename.startsWith(queryLower)) score += 100;
        }

        return score;
    }

    /**
     * Search files with fuzzy matching and smart ranking
     */
    search(query, cwd) {
        const cached = this.cache.get(cwd);
        if (!cached) return [];

        const { files, directories } = cached;
        const changedFiles = this.getChangedFiles();
        const changedSet = new Set(changedFiles.map(f => f.path || f));

        // If query ends with /, show directory contents
        if (query.endsWith('/')) {
            const prefix = query.slice(0, -1);
            const filtered = files
                .filter(f => f.startsWith(prefix + '/'))
                .map(f => {
                    // Get next segment after prefix
                    const rest = f.slice(prefix.length + 1);
                    const nextSlash = rest.indexOf('/');
                    if (nextSlash > 0) {
                        // It's a subdirectory
                        return { path: prefix + '/' + rest.slice(0, nextSlash + 1), isDir: true };
                    }
                    return { path: f, isDir: false };
                });

            // Deduplicate directories
            const seen = new Set();
            const unique = filtered.filter(item => {
                if (seen.has(item.path)) return false;
                seen.add(item.path);
                return true;
            });

            return unique.slice(0, 15).map(item => ({
                ...item,
                score: 100,
                isRecent: changedSet.has(item.path)
            }));
        }

        // Fuzzy match all files
        const scored = files
            .map(path => {
                let score = this._fuzzyScore(path, query);
                if (score === 0) return null;

                // Bonuses
                if (changedSet.has(path)) score += 50;  // Recently changed
                if (this.mentionedFiles.has(path)) {
                    score += Math.min(this.mentionedFiles.get(path) * 10, 50);
                }

                // Depth penalty (prefer shallower paths)
                const depth = (path.match(/\//g) || []).length;
                score -= depth * 2;

                // Extra-dirs files come back as absolute paths; rank them
                // strictly below project files regardless of score.
                const isExtra = path.startsWith('/');

                return { path, score, isDir: false, isRecent: changedSet.has(path), isExtra };
            })
            .filter(Boolean);

        // Project files first, then extras; within each tier by score, then path.
        scored.sort((a, b) => {
            if (a.isExtra !== b.isExtra) return a.isExtra ? 1 : -1;
            if (b.score !== a.score) return b.score - a.score;
            return a.path.localeCompare(b.path);
        });

        // Return top results
        return scored.slice(0, 12);
    }

    /**
     * Get default suggestions (when @ is typed with no query)
     */
    getDefaultSuggestions(cwd) {
        const cached = this.cache.get(cwd);
        if (!cached) return [];

        const changedFiles = this.getChangedFiles();
        const results = [];

        // Add recently changed files first
        for (const f of changedFiles.slice(0, 5)) {
            const path = f.path || f;
            results.push({ path, score: 100, isDir: false, isRecent: true });
        }

        // Add frequently mentioned files
        const mentioned = Array.from(this.mentionedFiles.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);

        for (const [path, count] of mentioned) {
            if (!results.find(r => r.path === path)) {
                results.push({ path, score: 50 + count * 10, isDir: false, isRecent: false });
            }
        }

        // Fill with shallow files sampled across the whole tree
        const seenPaths = new Set(results.map(r => r.path));
        const shallow = [];
        for (const path of cached.files) {
            if (seenPaths.has(path)) continue;
            const depth = (path.match(/\//g) || []).length;
            if (depth <= 1) {
                shallow.push({ path, score: 10 - depth, isDir: false, isRecent: false });
            }
        }
        // Sort by path so root files come first, then depth-1 files
        shallow.sort((a, b) => a.path.localeCompare(b.path));
        for (const item of shallow) {
            results.push(item);
            if (results.length >= 10) break;
        }

        return results.slice(0, 10);
    }

    /**
     * Show the autocomplete dropdown
     */
    async show(query, triggerPos) {
        this.triggerPos = triggerPos;
        this.query = query;

        const cwd = this.getCwd();
        if (!cwd) {
            this.hide();
            return;
        }

        // Lazy-load files on first @
        if (!this._isCacheValid(cwd)) {
            await this.loadFiles(cwd);
        }

        // Search or get defaults
        if (query) {
            this.items = this.search(query, cwd);
        } else {
            this.items = this.getDefaultSuggestions(cwd);
        }

        if (this.items.length === 0) {
            this.hide();
            return;
        }

        this.selectedIndex = this.noPreselectOnce ? -1 : 0;
        this.noPreselectOnce = false;
        this.visible = true;
        this.render();
        this.container.classList.add('visible');
        this._detachAnchor?.();
        this._detachAnchor = anchorAbove(this.container, this.input, triggerPos);
    }

    /**
     * Hide the autocomplete dropdown
     */
    hide() {
        this.visible = false;
        this.container.classList.remove('visible');
        this.items = [];
        this.selectedIndex = 0;
        this.triggerPos = -1;
        this.query = '';
        this._detachAnchor?.();
        this._detachAnchor = null;
    }

    /**
     * Render the dropdown
     */
    render() {
        const sectionTitle = this.query ? 'Files' : 'Recent Files';

        const parts = [`<div class="file-autocomplete-section">${sectionTitle}</div>`];
        let extraHeaderEmitted = false;
        this.items.forEach((item, i) => {
            if (item.isExtra && !extraHeaderEmitted) {
                parts.push(`<div class="file-autocomplete-section">Extra Directories</div>`);
                extraHeaderEmitted = true;
            }
            const ext = item.isDir ? 'dir' : getFileExtension(item.path);
            const highlighted = this.highlightMatch(item.path, this.query);
            const recentBadge = item.isRecent ? '<span class="file-recent-badge">\u2022</span>' : '';
            parts.push(`
                <div class="file-autocomplete-item ${i === this.selectedIndex ? 'selected' : ''}"
                     data-index="${i}">
                    <span class="file-path">${highlighted}</span>
                    ${recentBadge}
                    ${ext ? `<span class="file-ext">${ext}</span>` : ''}
                </div>
            `);
        });
        this.container.innerHTML = parts.join('');
    }

    /**
     * Highlight matching characters in the path
     */
    highlightMatch(path, query) {
        if (!query) return escapeHtml(path);

        const pathLower = path.toLowerCase();
        const queryLower = query.toLowerCase();

        // Exact-substring match in the basename: highlight that contiguous run
        // rather than scattering marks (mirrors the substring boost in _fuzzyScore).
        const basenameStart = pathLower.lastIndexOf('/') + 1;
        const idx = pathLower.indexOf(queryLower, basenameStart);
        if (idx !== -1) {
            return escapeHtml(path.slice(0, idx)) +
                `<mark>${escapeHtml(path.slice(idx, idx + queryLower.length))}</mark>` +
                escapeHtml(path.slice(idx + queryLower.length));
        }

        let result = '';
        let pathIdx = 0;
        let queryIdx = 0;

        while (pathIdx < path.length) {
            if (queryIdx < queryLower.length && pathLower[pathIdx] === queryLower[queryIdx]) {
                result += `<mark>${escapeHtml(path[pathIdx])}</mark>`;
                queryIdx++;
            } else {
                result += escapeHtml(path[pathIdx]);
            }
            pathIdx++;
        }

        return result;
    }

    /**
     * Move selection up or down
     */
    moveSelection(delta) {
        if (!this.visible || this.items.length === 0) return;

        this.selectedIndex += delta;
        if (this.selectedIndex < 0) this.selectedIndex = this.items.length - 1;
        if (this.selectedIndex >= this.items.length) this.selectedIndex = 0;

        this.render();

        // Scroll selected item into view after render completes
        requestAnimationFrame(() => {
            const selectedEl = this.container.querySelector('.file-autocomplete-item.selected');
            if (selectedEl) {
                selectedEl.scrollIntoView({ block: 'nearest', behavior: 'auto' });
            }
        });
    }

    /**
     * Select the current item
     */
    select(index = this.selectedIndex) {
        if (index < 0 || index >= this.items.length) return;

        const item = this.items[index];
        const path = item.path;

        // Track mentioned file
        const count = this.mentionedFiles.get(path) || 0;
        this.mentionedFiles.set(path, count + 1);

        // Replace @query with selected path
        const value = this.input.value;
        const before = value.slice(0, this.triggerPos);
        const after = value.slice(this.triggerPos + 1 + this.query.length);

        // If selecting a directory, append / for drilling
        let insertPath = path;
        if (item.isDir && !insertPath.endsWith('/')) {
            // Show contents instead of inserting
            this.show(insertPath, this.triggerPos);
            // Update input to show the directory path
            this.input.value = before + '@' + insertPath;
            this.input.selectionStart = this.input.selectionEnd = this.input.value.length;
            return;
        }

        this.input.value = before + insertPath + after;
        this.input.focus();

        // Position cursor after inserted path
        const cursorPos = before.length + insertPath.length;
        this.input.selectionStart = this.input.selectionEnd = cursorPos;

        this.hide();

        // Trigger input event so other handlers update
        this.input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /**
     * Handle click on item
     */
    _handleClick(e) {
        const item = e.target.closest('.file-autocomplete-item');
        if (item) {
            const index = parseInt(item.dataset.index, 10);
            this.select(index);
        }
    }

    /**
     * Check if there's a valid selection
     */
    hasSelection() {
        return this.selectedIndex >= 0 && this.selectedIndex < this.items.length;
    }

    /**
     * Get the currently selected file path (for preview functionality)
     * @returns {string|null} - Selected file path or null if no selection
     */
    getSelectedPath() {
        if (!this.hasSelection()) return null;
        const item = this.items[this.selectedIndex];
        return item?.path || null;
    }

    /**
     * Refresh the file cache for current CWD
     */
    async refresh() {
        const cwd = this.getCwd();
        if (cwd) {
            await this.loadFiles(cwd, true);
        }
    }

    /**
     * Clear the cache (call when CWD changes)
     */
    clearCache() {
        this.cache.clear();
    }
}
