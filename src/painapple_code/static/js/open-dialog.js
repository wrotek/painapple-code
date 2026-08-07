/**
 * OpenDialog — fish-style path picker for "Open" flows.
 *
 * The input is a literal path being typed. As the user types, a dim ghost
 * suggestion extends inline showing the best prefix completion of the
 * current segment. Tab or Right-arrow accepts the ghost and continues.
 *
 * Three input shapes, all prefix-based (no fuzzy scoring):
 *   - Empty                          → list cwd's contents
 *   - Plain text (no `/`)            → prefix-match basenames across the project
 *   - Path-ish (has `/`, `~`, `.`)   → strict directory listing + prefix filter
 *
 * Enter/click on a folder → drill into it (browse its contents). The
 *   auto-selected "Open this folder" row starts a session at the current dir.
 * Enter on a file → preview (or new tab with Cmd/Ctrl+Enter).
 *
 * Works anywhere on the filesystem: `/etc/`, `~/Documents/`, `../`,
 * absolute paths. OS file permissions still apply (the bridge can only
 * read what its user can read); `/proc`, `/sys`, `/dev` are blocked.
 */

import S from './strings.js';
import { CONFIG } from './config.js';
import { ICONS } from './widget-system/index.js';
import { escapeHtml, extractApiError } from './utils.js';
import { ContextMenu, copyToClipboard, showToast } from './context-menu.js';

const DEBOUNCE_MS = 80;
const PROJECT_CACHE_TTL = 60_000;
const PATH_CACHE_TTL = 5_000;
const RECENT_TTL = 30_000;
const MAX_LIST = 100;
const MAX_BASENAME_LIST = 50;

class OpenDialogClass {
    constructor() {
        this._projectCache = new Map();
        this._pathCache = new Map();
        this._recentCache = new Map();
        this._reqToken = 0;
        this._items = [];
        this._selectedIndex = 0;
        this._ghost = '';
        this._debounceTimer = null;
        this._previousActiveEl = null;
        this._ctxMenu = null;
        this._built = false;
        this._missingDir = null;
    }

    _build() {
        if (this._built) return;
        this._built = true;

        const overlay = document.createElement('div');
        overlay.id = 'open-dialog-overlay';
        overlay.className = 'qs-overlay od-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', S.open_dialog.aria_label);
        overlay.hidden = true;
        overlay.innerHTML = `
            <div class="qs-modal od-modal" role="combobox" aria-expanded="true" aria-haspopup="listbox" aria-owns="od-list">
                <div class="qs-input-wrap od-input-wrap">
                    <span class="od-ghost" aria-hidden="true"
                        ><span class="od-ghost-typed"></span
                        ><span class="od-ghost-rest"></span
                    ></span>
                    <input type="text" class="qs-input od-input" autocomplete="off" autocapitalize="off"
                           autocorrect="off" spellcheck="false"
                           data-shortcuts-disabled="true"
                           aria-controls="od-list"
                           placeholder="${escapeHtml(S.open_dialog.placeholder)}">
                </div>
                <div class="od-path" aria-live="polite"></div>
                <div class="qs-list od-list" id="od-list" role="listbox"></div>
                <div class="qs-footer od-footer">
                    <div class="qs-footer-row">
                        <span class="qs-hint">${S.open_dialog.hints.nav}</span>
                        <span class="qs-hint">${S.open_dialog.hints.parent}</span>
                        <span class="qs-hint od-hint-tab">${S.open_dialog.hints.complete}</span>
                        <span class="qs-hint od-hint-file">${S.open_dialog.hints.preview}</span>
                        <span class="qs-hint od-hint-dir-nav">${S.open_dialog.hints.enter_folder}</span>
                        <span class="qs-hint od-hint-dir-create">${S.open_dialog.hints.create_folder}</span>
                        <span class="qs-hint od-hint-dir-open">${S.open_dialog.hints.open_session}</span>
                        <span class="qs-hint">${S.open_dialog.hints.switcher}</span>
                        <span class="qs-hint">${S.open_dialog.hints.close}</span>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        this.overlay = overlay;
        this.input = overlay.querySelector('.od-input');
        this.list = overlay.querySelector('.od-list');
        this.footer = overlay.querySelector('.od-footer');
        this.ghostTyped = overlay.querySelector('.od-ghost-typed');
        this.ghostRest = overlay.querySelector('.od-ghost-rest');
        this.pathEl = overlay.querySelector('.od-path');

        this.input.addEventListener('input', () => this._scheduleChange());
        this.input.addEventListener('keydown', (e) => this._onKey(e));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) this.hide(); });

        this.list.addEventListener('click', (e) => {
            const it = e.target.closest('.qs-item');
            if (!it) return;
            this._selectedIndex = parseInt(it.dataset.index, 10);
            this._renderList();
            this._submit(this._optsFromEvent(e));
            // If the click drilled into a folder (dialog still open), pull focus
            // back to the input so the user can keep typing / arrowing.
            if (!this.overlay.hidden) this.input.focus();
        });
        this.list.addEventListener('contextmenu', (e) => {
            const it = e.target.closest('.qs-item');
            if (!it) return;
            e.preventDefault();
            this._selectedIndex = parseInt(it.dataset.index, 10);
            this._renderList();
            this._showContextMenu(e.clientX, e.clientY);
        });
        // Swallow contextmenu on the overlay backdrop so the FAB radial doesn't fire.
        overlay.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
    }

    show() {
        this._build();
        if (!this.overlay.hidden) {
            this.input.focus();
            this.input.select();
            return;
        }
        this._previousActiveEl = document.activeElement;
        this.overlay.hidden = false;
        this.input.value = '';
        this._ghost = '';
        this._items = [];
        this._selectedIndex = 0;
        const { mode, dir } = this._parse('');
        this._renderCurrentPath(mode, dir);
        this._renderGhost();
        this._renderList();
        requestAnimationFrame(() => {
            this.input.focus();
            this._refresh();
        });
    }

    hide() {
        if (!this._built || this.overlay.hidden) return;
        this.overlay.hidden = true;
        clearTimeout(this._debounceTimer);
        if (this._previousActiveEl && document.contains(this._previousActiveEl)) {
            this._previousActiveEl.focus?.();
        }
        this._previousActiveEl = null;
    }

    toggle() {
        this._build();
        if (this.overlay.hidden) this.show();
        else this.hide();
    }

    isOpen() {
        return !!this._built && !this.overlay.hidden;
    }

    _scheduleChange() {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => this._refresh(), DEBOUNCE_MS);
    }

    _onKey(e) {
        switch (e.key) {
            case 'Escape':
                e.preventDefault();
                this.hide();
                break;
            case 'Backspace':
                // Nothing left to delete → hand back to the fuzzy quick
                // switcher (mirror of the switcher's `@` → Open dialog handoff).
                // With text present, fall through to native character delete.
                if (this.input.value === '') {
                    e.preventDefault();
                    this.hide();
                    window.QuickSwitcher?.show();
                }
                break;
            case 'Enter':
                e.preventDefault();
                if (this._items.length) this._submit(this._optsFromEvent(e));
                break;
            case 'ArrowDown':
                e.preventDefault();
                this._move(1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                this._move(-1);
                break;
            case 'Tab':
                e.preventDefault();
                // Tab: accept the ghost if present, otherwise cycle the list
                // so the user can still navigate when nothing's ahead of them.
                if (this._ghost) this._acceptGhost();
                else this._move(e.shiftKey ? -1 : 1);
                break;
            case 'ArrowRight':
                // Modifier held (shift/alt/ctrl/meta) → user is selecting or
                // word-jumping; let the input handle it natively.
                if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) break;
                // Only intercept at end-of-input — otherwise the user is moving
                // the caret inside the path and we shouldn't steal it.
                // Priority: accept ghost → drill into selected dir.
                if (this.input.selectionStart === this.input.value.length) {
                    if (this._ghost) {
                        e.preventDefault();
                        this._acceptGhost();
                    } else {
                        const item = this._items[this._selectedIndex];
                        // `is_open_here` is an action, not a deeper dir —
                        // skip it. `..` is fine (drill-in == go up).
                        if (item?.is_dir && !item.is_open_here) {
                            e.preventDefault();
                            this._drillInto(item);
                        }
                    }
                }
                break;
            case 'ArrowLeft': {
                if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) break;
                // Intercept when the caret is at position 0 (anywhere in the
                // input) OR at the very end of a path that already ends with
                // `/` (i.e. we're "in" a directory rather than editing a
                // basename). Otherwise the caret belongs to the user.
                const val = this.input.value;
                const start = this.input.selectionStart;
                const end = this.input.selectionEnd;
                const noSelection = start === end;
                const atStart = noSelection && start === 0;
                const atEnd = noSelection && start === val.length;
                if (atStart || (atEnd && val.endsWith('/'))) {
                    e.preventDefault();
                    this._goUp();
                }
                break;
            }
            case 'End':
                // Shift+End / Cmd+Shift+End etc are text-selection — leave alone.
                if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) break;
                if (this._ghost) {
                    e.preventDefault();
                    this._acceptGhost();
                }
                break;
        }
    }

    _goUp() {
        const { dir } = this._parse(this.input.value);
        const parent = this._parentOf(dir);
        if (!parent) return;
        const display = this._displayFor(parent, true);
        this.input.value = display;
        this.input.selectionStart = this.input.selectionEnd = display.length;
        this._ghost = '';
        this._refresh();
    }

    _parentOf(dir) {
        if (!dir || dir === '/') return null;
        const trimmed = dir.replace(/\/+$/, '');
        return trimmed.split('/').slice(0, -1).join('/') || '/';
    }

    _move(delta) {
        if (!this._items.length) return;
        const n = this._items.length;
        this._selectedIndex = (this._selectedIndex + delta + n) % n;
        // Ghost follows the selected item when it's a real entry, but stays
        // pinned to the first real item when the user lands on a synthetic
        // row (`..` or "Open this folder") — so Tab still autocompletes
        // their typing instead of going silent.
        this._setGhostFromItem(this._ghostItemFor());
        this._renderGhost();
        this._renderList();
        this.list.querySelector('.qs-item.selected')
            ?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }

    _ghostItemFor() {
        const synthetic = it => it.is_parent || it.is_open_here || it.is_create_here;
        const selected = this._items[this._selectedIndex];
        if (selected && !synthetic(selected)) return selected;
        return this._items.find(it => !synthetic(it));
    }

    _setGhostFromItem(item) {
        // Fish-style: no input → no ghost (placeholder owns that space).
        // Never suggest the synthetic navigation rows (`..`, "Open this folder").
        const val = this.input.value;
        if (!item || !val || item.is_parent || item.is_open_here || item.is_create_here) { this._ghost = ''; return; }
        const filter = this._currentFilter();
        const target = item.is_dir ? item.name + '/' : item.name;
        if (target.toLowerCase().startsWith(filter.toLowerCase())) {
            // Preserve target's case for the remainder.
            let rest = target.slice(filter.length);
            // Bare path tokens (`~`, `.`, `..`) are missing the separator
            // slash before the next segment — without this fix, Tab on `~`
            // would yield `~dev/` instead of `~/dev/`.
            if (val === '~' || val === '.' || val === '..') {
                rest = '/' + rest;
            }
            this._ghost = rest;
        } else {
            this._ghost = '';
        }
    }

    _currentFilter() {
        const { filter } = this._parse(this.input.value);
        return filter;
    }

    _optsFromEvent(e) {
        const mod = e.metaKey || e.ctrlKey;
        if (mod && e.shiftKey) return { newTab: true };
        if (mod) return { background: true };
        return {};
    }

    /**
     * Parse the input into a mode + (dir, filter) pair.
     *
     * Modes:
     *   - 'empty':    "" → show cwd contents
     *   - 'basename': "app" → prefix-match basenames across the project tree
     *   - 'path':     "src/", "~/dev/", "/etc/p", "../tests" → strict dir mode
     */
    _parse(input) {
        const cwd = this._getCwd();
        if (!input) return { mode: 'empty', dir: cwd, filter: '' };

        const startsWithTilde = input === '~' || input.startsWith('~/');
        const isAbsolute = input.startsWith('/');
        const isRelative =
            input === '.' || input === '..' ||
            input.startsWith('./') || input.startsWith('../');
        const hasSlash = input.includes('/');

        const pathMode = startsWithTilde || isAbsolute || isRelative || hasSlash;
        if (!pathMode) return { mode: 'basename', dir: cwd, filter: input };

        // Split into (head) + (filter being typed after the last '/').
        const lastSlash = input.lastIndexOf('/');
        let head, filter;
        if (lastSlash === -1) {
            // Input is `~`, `.`, or `..` — treat as if it had a trailing slash.
            head = input + '/';
            filter = '';
        } else {
            head = input.slice(0, lastSlash + 1);
            filter = input.slice(lastSlash + 1);
        }

        let dir;
        if (head.startsWith('~/')) {
            dir = (CONFIG.HOME || '') + head.slice(1);
        } else if (head.startsWith('/')) {
            dir = head;
        } else {
            // ./foo/  ../foo/  foo/bar/  (relative to cwd)
            dir = this._resolveRelative(cwd, head);
        }
        dir = dir.replace(/\/+$/, '') || '/';
        return { mode: 'path', dir, filter };
    }

    _resolveRelative(cwd, relPath) {
        const combined = (cwd || '') + '/' + relPath;
        const parts = combined.split('/').filter(p => p !== '');
        const out = [];
        for (const p of parts) {
            if (p === '.') continue;
            if (p === '..') out.pop();
            else out.push(p);
        }
        return '/' + out.join('/');
    }

    _getCwd() {
        // Prefer the active session's cwd; on the welcome screen there's none
        // yet, so fall back to the bridge's --workspace dir (mirrors the file
        // explorer anchor; CONFIG.WORKSPACE itself falls back to the OS home
        // when --workspace isn't set).
        const sessionCwd = window.app?.activeSession?.cwd;
        if (sessionCwd) return sessionCwd;
        return window.app?.lastCwd || CONFIG.WORKSPACE;
    }

    async _refresh() {
        const value = this.input.value;
        const { mode, dir, filter } = this._parse(value);
        this._renderCurrentPath(mode, dir);
        this._missingDir = null;

        const token = ++this._reqToken;
        let items = [];
        try {
            if (mode === 'empty') {
                items = await this._listDir(dir, '');
            } else if (mode === 'basename') {
                items = await this._projectBasenameMatches(dir, filter);
            } else {
                items = await this._listDir(dir, filter);
            }
        } catch (err) {
            console.error('[OpenDialog]', err);
        }
        if (token !== this._reqToken) return;

        // Typed a path that doesn't exist → offer to create it. Covers a
        // fully-typed missing dir (`~/dev/newproj/`, listing 404s), a new
        // name typed inside an existing dir (`~/dev/newproj`, prefix filter
        // matches nothing), and a bare name with no slash at all
        // (`newproj`, basename search over the project comes up empty —
        // created relative to cwd). mkdir -p on the server also handles
        // missing intermediate dirs.
        const offerCreate = items.length === 0 && (
            (mode === 'path' && (filter || this._missingDir === dir)) ||
            (mode === 'basename' && filter)
        );
        if (offerCreate) {
            const target = filter ? (dir === '/' ? '/' + filter : dir + '/' + filter) : dir;
            const pretty = this._formatPathForDisplay(target).replace(/\/$/, '') || '/';
            items = [{
                type: 'action',
                is_dir: true,
                is_create_here: true,
                name: '__create_here__',
                label: S.open_dialog.create_here.label,
                description: S.open_dialog.create_here.desc.replace('{dir}', pretty),
                absPath: target,
            }];
        }

        this._items = items;
        // Default-select the "Open this folder" action when it's present
        // (so plain Enter opens the listed dir as a session). With `..`
        // also added it sits at index 1; without `..` it's at index 0.
        // Falls back to 0 when neither synthetic row exists (filter mode).
        const ohIdx = items.findIndex(it => it.is_open_here);
        this._selectedIndex = ohIdx >= 0 ? ohIdx : 0;
        this._setGhostFromItem(this._ghostItemFor());
        this._renderGhost();
        this._renderList();
    }

    async _listDir(dir, filter) {
        if (!dir) return [];

        const cached = this._pathCache.get(dir);
        let entries;
        if (cached && Date.now() - cached.t < PATH_CACHE_TTL) {
            entries = cached.entries;
        } else {
            const r = await fetch(`${CONFIG.API_BASE}/api/files?path=${encodeURIComponent(dir)}`);
            if (!r.ok) {
                // 404 → the dir doesn't exist yet; _refresh offers to create it.
                // Other errors (403/timeout) just yield an empty listing.
                if (r.status === 404) this._missingDir = dir;
                return [];
            }
            const data = await r.json();
            entries = data.files || [];
            this._pathCache.set(dir, { t: Date.now(), entries });
        }

        const fLower = filter.toLowerCase();
        const filtered = filter
            ? entries.filter(e => e.name.toLowerCase().startsWith(fLower))
            // Hide dotfiles by default; user can type `.` to opt in.
            : entries.filter(e => !e.name.startsWith('.'));

        filtered.sort((a, b) => {
            if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        const mapped = filtered.slice(0, MAX_LIST).map(e => ({
            type: e.is_dir ? 'dir' : 'file',
            is_dir: e.is_dir,
            name: e.name,
            label: e.is_dir ? e.name + '/' : e.name,
            description: '',
            absPath: e.path,
        }));

        // Synthetic rows: `..` (parent) at the very top so it matches the
        // typical file-manager mental model, then "Open this folder" which
        // becomes the default-selected action (Enter opens the listed dir
        // as a new session). Only added when no filter is active — prefix-
        // match would hide them anyway and they'd be confusing alongside
        // filtered file results.
        if (!filter) {
            // Unshift order is reverse of final order — push the action
            // first so it ends up at index 1 (or 0 when there's no parent).
            mapped.unshift({
                type: 'action',
                is_dir: true,
                is_open_here: true,
                name: '__open_here__',
                label: S.open_dialog.open_here.label,
                description: S.open_dialog.open_here.desc,
                absPath: dir,
            });
            const parent = this._parentOf(dir);
            if (parent) {
                mapped.unshift({
                    type: 'dir',
                    is_dir: true,
                    is_parent: true,
                    name: '..',
                    label: '../',
                    description: '',
                    absPath: parent,
                });
            }
        }
        return mapped;
    }

    async _projectBasenameMatches(cwd, filter) {
        if (!cwd || !filter) return [];

        const cached = this._projectCache.get(cwd);
        let payload;
        if (cached && Date.now() - cached.t < PROJECT_CACHE_TTL) {
            payload = cached.payload;
        } else {
            // include_ignored=true: the user is picking a file to open, so
            // .gitignore'd files (CLAUDE.md, .env, local notes) must be reachable
            // — otherwise typing the exact basename returns "No matches" even
            // though the file is right there on disk.
            const r = await fetch(`${CONFIG.API_BASE}/api/files/list?cwd=${encodeURIComponent(cwd)}&include_ignored=true`);
            if (!r.ok) return [];
            payload = await r.json();
            this._projectCache.set(cwd, { t: Date.now(), payload });
        }

        const recent = await this._loadRecent(cwd);
        const fLower = filter.toLowerCase();
        const files = payload.files || [];
        const dirs = payload.directories || [];

        const matches = [];
        for (const d of dirs) {
            const name = d.replace(/\/$/, '');
            if (!name.toLowerCase().startsWith(fLower)) continue;
            const abs = this._joinAbs(cwd, name);
            matches.push({
                type: 'dir',
                is_dir: true,
                name,
                label: name + '/',
                description: cwd,
                absPath: abs,
                recentRank: recent.get(abs) ?? Infinity,
            });
        }
        for (const path of files) {
            const slash = path.lastIndexOf('/');
            const basename = slash >= 0 ? path.slice(slash + 1) : path;
            if (!basename.toLowerCase().startsWith(fLower)) continue;
            const abs = this._joinAbs(cwd, path);
            const dirPart = slash >= 0 ? path.slice(0, slash) : '';
            matches.push({
                type: 'file',
                is_dir: false,
                name: basename,
                label: basename,
                description: dirPart,
                absPath: abs,
                recentRank: recent.get(abs) ?? Infinity,
            });
        }

        // Recent first, then dirs over files, then shallower paths, then alpha.
        matches.sort((a, b) => {
            if (a.recentRank !== b.recentRank) return a.recentRank - b.recentRank;
            if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
            const ad = (a.description.match(/\//g) || []).length;
            const bd = (b.description.match(/\//g) || []).length;
            if (ad !== bd) return ad - bd;
            return a.name.localeCompare(b.name);
        });

        return matches.slice(0, MAX_BASENAME_LIST);
    }

    async _loadRecent(cwd) {
        const cached = this._recentCache.get(cwd);
        if (cached && Date.now() - cached.t < RECENT_TTL) return cached.map;
        const map = new Map();
        try {
            const r = await fetch(
                `${CONFIG.API_BASE}/api/shadow-db/recent-files?cwd=${encodeURIComponent(cwd)}&limit=100`
            );
            if (r.ok) {
                const data = await r.json();
                (data.files || []).forEach((f, i) => {
                    const abs = this._joinAbs(cwd, f.path);
                    map.set(abs, i);
                });
            }
        } catch {
            // best-effort; ghost still works without recency data
        }
        this._recentCache.set(cwd, { t: Date.now(), map });
        return map;
    }

    _joinAbs(cwd, rel) {
        if (rel.startsWith('/')) return rel;
        const base = (cwd || '').replace(/\/$/, '');
        return base + '/' + rel;
    }

    _renderGhost() {
        this.ghostTyped.textContent = this.input.value;
        this.ghostRest.textContent = this._ghost || '';
        this._updateFooterForSelection();
    }

    _renderCurrentPath(mode, dir) {
        if (!this.pathEl) return;
        const pretty = this._formatPathForDisplay(dir);
        if (mode === 'basename') {
            this.pathEl.innerHTML =
                `<span class="od-path-label">${escapeHtml(S.open_dialog.section.project)}</span>` +
                `<span class="od-path-text">${escapeHtml(pretty)}</span>`;
        } else {
            this.pathEl.innerHTML = `<span class="od-path-text">${escapeHtml(pretty)}</span>`;
        }
    }

    _formatPathForDisplay(dir) {
        if (!dir) return '';
        const home = CONFIG.HOME || '';
        let out = dir;
        if (home && (dir === home || dir.startsWith(home + '/'))) {
            out = '~' + dir.slice(home.length);
        }
        return out.endsWith('/') ? out : out + '/';
    }

    _renderList() {
        if (!this._items.length) {
            const txt = this.input.value.trim() ? S.open_dialog.empty.no_results : ' ';
            this.list.innerHTML = `<div class="qs-empty">${escapeHtml(txt)}</div>`;
            this._updateFooterForSelection();
            return;
        }
        const parts = [];
        for (let i = 0; i < this._items.length; i++) {
            parts.push(this._renderItem(this._items[i], i, i === this._selectedIndex));
        }
        this.list.innerHTML = parts.join('');
        this.input.setAttribute('aria-activedescendant', `od-item-${this._selectedIndex}`);
        this._updateFooterForSelection();
    }

    _renderItem(item, index, isSelected) {
        const filter = this._currentFilter();
        const label = item.label;
        let labelHtml = escapeHtml(label);
        if (filter && label.toLowerCase().startsWith(filter.toLowerCase())) {
            labelHtml =
                `<mark>${escapeHtml(label.slice(0, filter.length))}</mark>` +
                escapeHtml(label.slice(filter.length));
        }
        const icon = (item.is_open_here || item.is_create_here)
            ? ICONS.plus
            : (item.is_dir ? ICONS.folder : ICONS.file);
        const desc = item.description
            ? `<span class="qs-item-desc">${escapeHtml(item.description)}</span>`
            : '';
        const extraCls = (item.is_open_here || item.is_create_here) ? ' qs-item-open-here'
            : (item.is_parent ? ' qs-item-parent' : '');
        const cls = `qs-item qs-item-${item.type}${extraCls}${isSelected ? ' selected' : ''}`;
        return `
            <div class="${cls}" role="option" data-index="${index}" id="od-item-${index}" aria-selected="${isSelected}">
                <span class="qs-item-icon">${icon}</span>
                <span class="qs-item-text">
                    <span class="qs-item-label">${labelHtml}</span>
                    ${desc}
                </span>
            </div>
        `;
    }

    _updateFooterForSelection() {
        if (!this.footer) return;
        const item = this._items[this._selectedIndex];
        const isDir = !!item?.is_dir;
        // "Open this folder" commits a session on Enter; "Create this folder"
        // mkdirs + drills in; every other dir (regular folders + `..`) drills
        // in. Footer hint follows suit.
        const isOpenAction = !!item?.is_open_here;
        const isCreateAction = !!item?.is_create_here;
        this.footer.classList.toggle('od-state-file', !!(item && !isDir));
        this.footer.classList.toggle('od-state-dir-nav', isDir && !isOpenAction && !isCreateAction);
        this.footer.classList.toggle('od-state-dir-create', isCreateAction);
        this.footer.classList.toggle('od-state-dir-open', isDir && isOpenAction);
        this.footer.classList.toggle('od-state-ghost', !!this._ghost);
    }

    _acceptGhost() {
        if (!this._ghost) return;
        const newValue = this.input.value + this._ghost;
        this.input.value = newValue;
        this.input.selectionStart = this.input.selectionEnd = newValue.length;
        this._ghost = '';
        this._renderGhost();
        // After accepting, if the new value ends with '/', _refresh will fetch
        // the new directory's contents and pick a fresh ghost.
        this._refresh();
    }

    async _submit(opts = {}) {
        const item = this._items[this._selectedIndex];
        if (!item) return;
        // The synthetic `..` is a navigation row, not a destination. Walk up
        // and keep the dialog open instead of opening a session.
        if (item.is_parent) { this._goUp(); return; }
        // "Create this folder" → mkdir then drill into it, keeping the dialog
        // open. The freshly-listed dir offers "Open this folder" as the
        // default-selected row, so a session is still just one Enter away.
        if (item.is_create_here) {
            await this._createAndEnter(item.absPath);
            return;
        }
        // A regular folder → drill into it (browse), keeping the dialog open.
        // Opening as a session is reserved for the explicit "Open this folder"
        // row, which is auto-selected after every drill-in (one Enter away).
        if (item.is_dir && !item.is_open_here) {
            this._drillInto(item);
            return;
        }
        this.hide();
        try {
            if (item.is_dir) this._openSessionAt(item.absPath);
            else this._openFile(item.absPath, opts);
        } catch (err) {
            console.error('[OpenDialog] submit:', err);
        }
    }

    async _createAndEnter(dir) {
        try {
            const r = await fetch(
                `${CONFIG.API_BASE}/api/mkdir`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: dir }),
                }
            );
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
                // `detail` is a *list* of dicts on a 422 (Pydantic) — stringifying
                // it raw is what turned this toast into "[object Object]".
                showToast(S.open_dialog.create_failed.replace(
                    '{error}', extractApiError(data, `HTTP ${r.status}`)));
                return;
            }
            // Bust the cached listings (the dir itself + its parent, whose
            // cached entry list is now missing the new child).
            this._pathCache.delete(dir);
            const parent = this._parentOf(dir);
            if (parent) this._pathCache.delete(parent);
            this._drillInto({ is_dir: true, absPath: data.path || dir });
            this.input.focus();
        } catch (err) {
            console.error('[OpenDialog] create:', err);
            showToast(S.open_dialog.create_failed.replace('{error}', err.message));
        }
    }

    _openFile(absPath, opts = {}) {
        const tabCtrl = window.app?.tabCtrl;
        if (opts.background && tabCtrl?.openFilePreviewTab) {
            tabCtrl.openFilePreviewTab(absPath, null, { background: true });
            return;
        }
        if (opts.newTab && tabCtrl?.openFilePreviewTab) {
            tabCtrl.openFilePreviewTab(absPath, null, { newTab: true });
            return;
        }
        window.app?.previewFile?.(absPath);
    }

    _openSessionAt(cwd) {
        const app = window.app;
        if (!app?.sessionManager) return;
        const name = cwd.split('/').pop() || 'New Session';
        const session = app.sessionManager.create({ name });
        if (!session) return;
        session.cwd = cwd;
        if (app.tabCtrl?.switchToSession) app.tabCtrl.switchToSession(session);
        else app.switchSession?.(session);
        app.renderTabs?.();
        session.connect();
        app.sessionManager.saveSessions?.();
        app.addToHistory?.(cwd);
        app.fileExplorer?.setHomePath?.(cwd);
        app.fetchProjectCommands?.(cwd);
        app.els?.connectionBar?.classList.remove('visible');
        // If the user typed a message on the welcome screen before picking
        // a project, send it now on the new session.
        if (app._pendingWelcomeMessage) {
            const msg = app._pendingWelcomeMessage;
            app._pendingWelcomeMessage = null;
            if (app.els?.messageInput) app.els.messageInput.value = '';
            app.syncInputHighlightBackdrop?.();
            app._sendMessageDirect?.(msg);
        }
    }

    _showContextMenu(x, y) {
        const item = this._items[this._selectedIndex];
        if (!item) return;
        const menu = window.app?.contextMenu || (this._ctxMenu ||= new ContextMenu());
        const tabCtrl = window.app?.tabCtrl;
        const close = (fn) => { this.hide(); fn?.(); };
        const items = item.is_dir
            ? [
                { label: S.open_dialog.menu.open_session, action: () => close(() => this._openSessionAt(item.absPath)) },
                { label: S.open_dialog.menu.drill_in, action: () => { this._drillInto(item); this.input.focus(); } },
                { type: 'separator' },
                { label: S.context_menus.file.copy_path, action: async () => { if (await copyToClipboard(item.absPath)) showToast(S.toast.copied); } },
            ]
            : [
                { label: S.context_menus.file.preview, action: () => close(() => window.app?.previewFile?.(item.absPath)) },
                { label: S.context_menus.file.open_in_new_tab, action: () => close(() => tabCtrl?.openFilePreviewTab?.(item.absPath, null, { newTab: true })) },
                { label: S.context_menus.file.open_in_background, action: () => close(() => tabCtrl?.openFilePreviewTab?.(item.absPath, null, { background: true })) },
                { type: 'separator' },
                { label: S.context_menus.file.copy_full_path, action: async () => { if (await copyToClipboard(item.absPath)) showToast(S.toast.copied); } },
            ];
        menu.show(x, y, items);
    }

    _drillInto(item) {
        if (!item?.is_dir) return;
        const display = this._displayFor(item.absPath, true);
        this.input.value = display;
        this.input.selectionStart = this.input.selectionEnd = display.length;
        this._ghost = '';
        this._refresh();
    }

    _displayFor(absPath, isDir) {
        const cwd = this._getCwd();
        const home = CONFIG.HOME || '';
        const original = this.input.value;
        let out;
        if (home && absPath === home) {
            out = '~';
        } else if (original.startsWith('~/') && home && absPath.startsWith(home + '/')) {
            out = '~' + absPath.slice(home.length);
        } else if (original.startsWith('/') || !cwd) {
            out = absPath;
        } else if (absPath === cwd) {
            out = './';
        } else if (absPath.startsWith(cwd + '/')) {
            out = absPath.slice(cwd.length + 1);
        } else if (home && absPath.startsWith(home + '/')) {
            out = '~' + absPath.slice(home.length);
        } else {
            out = absPath;
        }
        if (isDir && !out.endsWith('/')) out += '/';
        return out;
    }
}

export const OpenDialog = new OpenDialogClass();
