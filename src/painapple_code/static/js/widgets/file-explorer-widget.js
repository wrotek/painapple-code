/**
 * FileExplorerWidget - File browser
 *
 * Features:
 * - Tree list with expansion + inline filter (recursive via /api/files/list)
 * - Session-aware navigation via breadcrumbs
 * - File type filtering and sort
 * - Keyboard navigation
 * - Context menu (preview, open, copy path, insert to chat, compare)
 *
 * Scope history: tree/bookmarks/recent views + back/forward history +
 * full-screen tab mode were cut 2026-04-19. Separate "search view" mode was
 * cut 2026-04-21 — the inline filter now handles subtree search.
 */

import S from '../strings.js';
import { escapeHtml, formatDate } from '../utils.js';
import { CONFIG } from '../config.js';
import { WidgetManager, WidgetBus, ICONS } from '../widget-system/index.js';
import { BrowserWidget } from './browser-widget.js';

const GIT_STATUS_LABELS = {
    M: S.widgets.git.statuses.modified,
    A: S.widgets.git.statuses.added,
    D: S.widgets.git.statuses.deleted,
    U: S.widgets.git.statuses.untracked,
    S: S.widgets.git.statuses.staged,
};

// Compact SVG glyphs for the per-file git badge. Stroke=current so they pick
// up the per-status color from .fe-git-{M,A,D,U,S} in CSS.
const GIT_STATUS_ICONS = {
    // Modified — pencil
    M: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>',
    // Added — plus
    A: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    // Deleted — minus
    D: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    // Untracked — dotted/open circle (question-mark feel)
    U: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="8" stroke-dasharray="2 3"/></svg>',
    // Staged — check
    S: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
};

// Grouping icons: folder-over-file / file-over-folder / mixed stack
const GROUP_ICONS = {
    'dirs-first':  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v3H3V7z"/><rect x="5" y="14" width="14" height="6" rx="1"/></svg>',
    'files-first': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="4" width="14" height="6" rx="1"/><path d="M3 14a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v3H3v-5z"/></svg>',
    'mixed':       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4"  width="16" height="4" rx="1"/><rect x="4" y="10" width="16" height="4" rx="1"/><rect x="4" y="16" width="16" height="4" rx="1"/></svg>',
};

// Types worth rendering in the browser widget (vs. plain-text Preview):
// HTML gets the full render pipeline; the rest are iframe-native formats
const BROWSER_RENDERABLE = /\.(html?|svg|pdf|png|jpe?g|gif|webp|ico)$/i;

// ============================================================================
// State Management (Singleton - persists across widget transforms)
// ============================================================================

class FileExplorerState {
    constructor() {
        this.reset();
    }

    reset() {
        this.sessionId = null;
        this.cwd = null;
        this.currentPath = null;
        this.files = [];
        this.loading = false;
        this.error = null;
        // Structured error for the current top-level listing: { status, detail, path }
        this.errorInfo = null;
        // Per-subtree expansion errors: Map<absPath, { status, detail }>
        this.childrenError = new Map();

        // Selection — absPath of the keyboard-selected item
        this.selectedPath = null;

        // Filters
        this.showHidden = false;
        this.filter = 'all'; // 'all' | 'code' | 'images' | 'docs' | 'folders'

        // Inline filter (becomes a recursive search once query is ≥2 chars)
        this.filterBarOpen = false;
        this.filterQuery = '';

        // Recursive tree index for subtree search (populated lazily per-cwd).
        // Holds absolute paths of every file under the cwd (from /api/files/list).
        this.treeIndex = null;
        this.treeIndexCwd = null;
        this.treeIndexLoading = false;
        this.treeIndexError = null;
        this.treeIndexTruncated = false;
        // Cache key fragment that captures the index-affecting query params, so
        // toggling "include ignored" forces a refetch instead of reusing stale.
        this.treeIndexKey = null;

        // Search behavior toggles (filter bar)
        this.searchSubdirs = true;        // false = only direct children of cwd
        this.searchIncludeIgnored = false; // true = include .gitignore'd + hidden

        // Breadcrumb path editor — typed path input swaps in for the segments
        this.pathEditing = false;

        // Git status — Map<absPath, 'M' | 'A' | 'D' | 'U' | 'S'> (modified/added/deleted/untracked/staged)
        this.gitStatus = new Map();
        this.gitBranch = null;
        this.gitFetchedForCwd = null;

        // Tree expansion — Set<absPath> for expanded dirs, Map<absPath, Files[]> for cached children
        this.expanded = new Set();
        this.childrenCache = new Map();
        this.loadingChildren = new Set();

        // Widget reference
        this.widget = null;
        this.currentContainer = null;
    }

    // Navigation — breadcrumbs only (back/forward history removed 2026-04-19)
    navigateTo(path) {
        this.currentPath = path;
        this.selectedPath = null;
    }
}

// Per-session state map
const states = new Map();

function getState(sessionId) {
    if (!sessionId) sessionId = WidgetManager.currentSessionId;
    if (!states.has(sessionId)) {
        const s = new FileExplorerState();
        states.set(sessionId, s);
    }
    return states.get(sessionId);
}

function destroyState(sessionId) {
    states.delete(sessionId);
}

// ============================================================================
// Global Sort Preferences (persisted across sessions and reloads)
// ============================================================================

const SORT_PREFS_KEY = 'file-explorer-sort';
const SORT_FIELDS = ['name', 'modified', 'size', 'kind'];
const GROUP_MODES = ['dirs-first', 'files-first', 'mixed'];

function loadSortPrefs() {
    try {
        const raw = localStorage.getItem(SORT_PREFS_KEY);
        if (raw) {
            const p = JSON.parse(raw);
            const hasField = SORT_FIELDS.includes(p.sortBy);
            const hasDir = typeof p.sortAsc === 'boolean';
            const group = GROUP_MODES.includes(p.groupDirs) ? p.groupDirs : 'dirs-first';
            if (hasField && hasDir) {
                return { sortBy: p.sortBy, sortAsc: p.sortAsc, groupDirs: group };
            }
        }
    } catch {}
    return { sortBy: 'name', sortAsc: true, groupDirs: 'dirs-first' };
}

let sortPrefs = loadSortPrefs();

function setSortPrefs(next) {
    sortPrefs = { ...sortPrefs, ...next };
    try {
        localStorage.setItem(SORT_PREFS_KEY, JSON.stringify(sortPrefs));
    } catch {}
    renderContent();
}

// ============================================================================
// File Type Utilities
// ============================================================================

const FILE_TYPES = {
    code: {
        extensions: ['.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.swift', '.kt', '.scala', '.vue', '.svelte', '.css', '.scss', '.sass', '.less', '.html', '.xml', '.json', '.yaml', '.yml', '.toml', '.sh', '.bash', '.zsh', '.fish', '.sql', '.graphql', '.proto'],
        icon: 'code',
        color: 'var(--accent-blue)',
        label: 'Code'
    },
    images: {
        extensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tiff', '.heic', '.avif'],
        icon: 'image',
        color: 'var(--accent-purple)',
        label: 'Image'
    },
    docs: {
        extensions: ['.md', '.markdown', '.mdx', '.txt', '.doc', '.docx', '.pdf', '.rtf', '.tex', '.org', '.rst'],
        icon: 'file-text',
        color: 'var(--accent-green)',
        label: 'Doc'
    },
    data: {
        extensions: ['.csv', '.tsv', '.xls', '.xlsx', '.db', '.sqlite', '.parquet', '.arrow'],
        icon: 'table',
        color: 'var(--accent-orange)',
        label: 'Data'
    },
    config: {
        extensions: ['.env', '.gitignore', '.dockerignore', '.editorconfig', '.eslintrc', '.prettierrc', '.babelrc', 'Makefile', 'Dockerfile', '.npmrc', '.nvmrc'],
        icon: 'settings',
        color: 'var(--text-tertiary)',
        label: 'Config'
    },
    archive: {
        extensions: ['.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar'],
        icon: 'archive',
        color: 'var(--accent-yellow)',
        label: 'Archive'
    }
};

function getFileType(filename) {
    const lower = filename.toLowerCase();
    for (const [type, config] of Object.entries(FILE_TYPES)) {
        if (config.extensions.some(ext => lower.endsWith(ext) || lower === ext.slice(1))) {
            return { type, ...config };
        }
    }
    return { type: 'other', icon: 'file', color: 'var(--text-secondary)', label: 'File' };
}

// Per-extension Kind labels — Finder-style. The bucket in FILE_TYPES still
// drives the row icon and color (so all source files share the "code" icon),
// but the *label* in the Kind column is specific. Anything not listed falls
// back to the uppercased extension (e.g. ".log" → "LOG"), which handles the
// long tail gracefully.
const EXTENSION_LABELS = {
    // Markup / config / data
    '.html': 'HTML', '.htm': 'HTML',
    '.xml': 'XML',
    '.json': 'JSON', '.jsonl': 'JSONL',
    '.yaml': 'YAML', '.yml': 'YAML',
    '.toml': 'TOML',
    '.csv': 'CSV', '.tsv': 'TSV',
    '.md': 'Markdown', '.markdown': 'Markdown', '.mdx': 'MDX',
    '.txt': 'Text', '.rtf': 'Rich Text',
    '.pdf': 'PDF',
    // Source code
    '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
    '.ts': 'TypeScript',
    '.jsx': 'JSX', '.tsx': 'TSX',
    '.py': 'Python',
    '.rb': 'Ruby',
    '.go': 'Go',
    '.rs': 'Rust',
    '.java': 'Java',
    '.c': 'C', '.h': 'C Header',
    '.cpp': 'C++', '.hpp': 'C++ Header',
    '.cs': 'C#',
    '.php': 'PHP',
    '.swift': 'Swift',
    '.kt': 'Kotlin',
    '.scala': 'Scala',
    '.vue': 'Vue', '.svelte': 'Svelte',
    '.css': 'CSS', '.scss': 'SCSS', '.sass': 'Sass', '.less': 'Less',
    '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell', '.fish': 'Shell',
    '.sql': 'SQL',
    '.graphql': 'GraphQL', '.proto': 'Protobuf',
    // Images
    '.png': 'PNG',
    '.jpg': 'JPEG', '.jpeg': 'JPEG',
    '.gif': 'GIF',
    '.webp': 'WebP',
    '.svg': 'SVG',
    '.ico': 'Icon',
    '.bmp': 'Bitmap',
    '.tiff': 'TIFF',
    '.heic': 'HEIC',
    '.avif': 'AVIF',
    // Data / archive
    '.xls': 'Excel', '.xlsx': 'Excel',
    '.db': 'Database', '.sqlite': 'SQLite',
    '.parquet': 'Parquet', '.arrow': 'Arrow',
    '.zip': 'ZIP', '.tar': 'TAR',
    '.gz': 'Gzip', '.bz2': 'Bzip2', '.xz': 'XZ',
    '.7z': '7-Zip', '.rar': 'RAR',
};

// User-facing label for the Kind column. Folders get "Folder"; otherwise try
// per-extension first, then the uppercased extension, then the bucket label
// for no-extension files like "Makefile" / "Dockerfile" (which match the
// config bucket via full-name extensions).
function getKindLabel(file) {
    if (file.is_dir) return 'Folder';
    const name = file.name;
    const dot = name.lastIndexOf('.');
    if (dot > 0 && dot < name.length - 1) {
        const ext = name.slice(dot).toLowerCase();
        if (EXTENSION_LABELS[ext]) return EXTENSION_LABELS[ext];
        return name.slice(dot + 1).toUpperCase();
    }
    return getFileType(name).label;
}

// Sort key for the Kind column. Folders bucket together regardless of name
// (independent of the dirs-first grouping toggle). Files sort by their Kind
// *label* so HTML rows cluster with HTML, JSON with JSON, etc., instead of
// the previous coarse "all code together" behavior.
function getKindSortKey(file) {
    if (file.is_dir) return ' folder'; // sort dirs first within same kind
    return getKindLabel(file).toLowerCase();
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    if (bytes === undefined || bytes === null) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

// Friendly user-facing description of a fetchDirectory error. Falls back to
// the raw detail or status when the server didn't send a recognized string.
function describeDirError(errInfo) {
    if (!errInfo) return null;
    const { status, detail } = errInfo;
    if (status === 403 || detail === 'Path not allowed') {
        return {
            icon: 'warning',
            title: 'Access denied',
            body: detail === 'Path not allowed'
                ? 'This path is outside the allowed roots for this session.'
                : (detail || 'You don\'t have permission to view this folder.'),
        };
    }
    if (status === 404 || detail === 'Path not found') {
        return {
            icon: 'alert',
            title: 'Folder not found',
            body: 'The path no longer exists.',
        };
    }
    if (status === 400 && detail === 'Not a directory') {
        return {
            icon: 'file',
            title: 'Not a folder',
            body: 'This path points to a file, not a directory — try previewing it instead.',
        };
    }
    return {
        icon: 'alert',
        title: 'Couldn\'t load folder',
        body: detail || `Server returned HTTP ${status || '?'}`,
    };
}

function matchesFilter(file, filter) {
    if (filter === 'all') return true;
    if (filter === 'folders') return file.is_dir;
    const fileType = getFileType(file.name);
    return fileType.type === filter;
}

// ============================================================================
// API Functions
// ============================================================================

async function fetchDirectory(path) {
    const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
    if (!response.ok) {
        let detail;
        try { detail = (await response.json())?.detail; } catch {}
        const err = new Error(detail || `HTTP ${response.status}`);
        err.status = response.status;
        err.detail = detail;
        err.path = path;
        throw err;
    }
    const data = await response.json();
    return data.files || [];
}

async function fetchFileContent(path) {
    try {
        const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return data.content;
    } catch (err) {
        console.error('Failed to fetch file:', err);
        throw err;
    }
}

async function fetchGitStatus(cwd) {
    try {
        const response = await fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`);
        if (!response.ok) return null;
        const data = await response.json();
        if (data.error === 'not_a_repo') return null;
        return data;
    } catch {
        return null;
    }
}

async function refreshGitStatus(force = false) {
    const state = getState();
    if (!state.cwd) return;
    if (!force && state.gitFetchedForCwd === state.cwd) return;
    const data = await fetchGitStatus(state.cwd);
    state.gitFetchedForCwd = state.cwd;
    state.gitStatus = new Map();
    state.gitBranch = null;
    if (!data) return;
    state.gitBranch = data.branch || null;
    const root = data.root || state.cwd;
    const join = (rel) => `${root.replace(/\/$/, '')}/${rel}`;
    // Precedence: staged > modified > untracked (staged+modified both flagged as 'M' is fine)
    (data.untracked || []).forEach(f => state.gitStatus.set(join(f.path), 'U'));
    (data.modified || []).forEach(f => state.gitStatus.set(join(f.path), f.status === 'deleted' ? 'D' : 'M'));
    (data.staged || []).forEach(f => {
        const map = { added: 'A', deleted: 'D', renamed: 'M', copied: 'M' };
        state.gitStatus.set(join(f.path), map[f.status] || 'S');
    });
}

// Roll up child statuses into a single label for the directory.
//   - any A/M/D/S child → 'M' (the dir contains real changes)
//   - only U children    → 'U' (the dir is purely untracked content)
// Untracked-only dirs render in default color so the user spec
// ("white = untracked") propagates up to the parent.
function dirHasGitChanges(dirPath) {
    const state = getState();
    if (state.gitStatus.size === 0) return null;
    const prefix = dirPath.replace(/\/$/, '') + '/';
    let sawAny = false;
    for (const [p, s] of state.gitStatus) {
        if (!p.startsWith(prefix)) continue;
        if (s !== 'U') return 'M';
        sawAny = true;
    }
    return sawAny ? 'U' : null;
}

// Lazy-fetch a flat list of every file under the cwd. Used by the inline filter
// to find matches anywhere in the subtree (not just the loaded/expanded nodes).
// Cached per-cwd; invalidated on Refresh and on cwd change.
async function ensureTreeIndex() {
    const state = getState();
    const cwd = state.cwd;
    if (!cwd) return;
    const key = `${cwd}|ignored=${state.searchIncludeIgnored ? 1 : 0}`;
    if (state.treeIndexKey === key && state.treeIndex !== null) return;
    if (state.treeIndexLoading && state.treeIndexKey === key) return;

    state.treeIndexLoading = true;
    state.treeIndexCwd = cwd;
    state.treeIndexKey = key;
    state.treeIndexError = null;
    renderList();

    try {
        const url = `/api/files/list?cwd=${encodeURIComponent(cwd)}`
            + (state.searchIncludeIgnored ? '&include_ignored=true' : '');
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        // `files` entries are either relative to cwd or already absolute (from extra_dirs)
        const base = (data.cwd || cwd).replace(/\/$/, '');
        state.treeIndex = (data.files || []).map(f =>
            f.startsWith('/') ? f : `${base}/${f}`
        );
        state.treeIndexTruncated = !!data.truncated;
    } catch (err) {
        console.error('Failed to fetch tree index:', err);
        state.treeIndex = [];
        state.treeIndexError = err.message || 'Failed to load file index';
    } finally {
        state.treeIndexLoading = false;
        renderList();
    }
}

function invalidateTreeIndex() {
    const state = getState();
    state.treeIndex = null;
    state.treeIndexCwd = null;
    state.treeIndexKey = null;
    state.treeIndexError = null;
    state.treeIndexTruncated = false;
}

const FLAT_MATCH_LIMIT = 300;

// Score a path against the lowercased query. Higher is better.
// Combines: filename-vs-path bucket, exact/stem/prefix bonuses, and a depth
// penalty so root-level files outrank equivalents buried deep in the tree.
// `cwdPrefix` lets us measure depth relative to the project root, not the FS root.
function scoreMatch(path, q, cwdPrefix) {
    const lower = path.toLowerCase();
    const lastSlash = lower.lastIndexOf('/');
    const name = lastSlash >= 0 ? lower.slice(lastSlash + 1) : lower;
    // Stem = filename without extension (e.g. "readme" from "readme.md").
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;

    let score;
    if (name === q || stem === q) score = 1000;          // exact filename or stem
    else if (name.startsWith(q)) score = 500;            // filename starts-with
    else if (name.includes(q)) score = 200;              // filename contains
    else if (lower.includes(q)) score = 50;              // path-only match
    else return -Infinity;                               // shouldn't happen (already filtered)

    // Depth penalty — count slashes in the *relative* path (so paths inside
    // the project root are favored over paths from extra_dirs / nested deep).
    const rel = cwdPrefix && lower.startsWith(cwdPrefix) ? lower.slice(cwdPrefix.length) : lower;
    const depth = (rel.match(/\//g) || []).length;
    score -= depth * 10;

    return score;
}

function filterTreeIndex(query) {
    const state = getState();
    if (!state.treeIndex) return null;
    const q = query.toLowerCase();
    const cwd = (state.cwd || state.currentPath || '').toLowerCase();
    const cwdPrefix = cwd.endsWith('/') ? cwd : cwd + '/';
    const subdirsOff = !state.searchSubdirs;

    const matches = [];
    for (const p of state.treeIndex) {
        const lower = p.toLowerCase();
        if (!lower.includes(q)) continue;
        if (subdirsOff) {
            // Only direct children of cwd: relative path must contain no '/'
            const rel = lower.startsWith(cwdPrefix) ? lower.slice(cwdPrefix.length) : null;
            if (rel === null || rel.includes('/')) continue;
        }
        matches.push(p);
    }
    matches.sort((a, b) => {
        const sa = scoreMatch(a, q, cwdPrefix);
        const sb = scoreMatch(b, q, cwdPrefix);
        if (sa !== sb) return sb - sa;          // higher score first
        if (a.length !== b.length) return a.length - b.length;  // shorter path wins ties
        return a.localeCompare(b);
    });
    return matches.slice(0, FLAT_MATCH_LIMIT);
}

// ============================================================================
// Rendering Functions
// ============================================================================

function renderToolbar(container) {
    const state = getState();
    const toolbar = document.createElement('div');
    toolbar.className = 'fe-toolbar';

    // File-type filter dropdown
    const filterSelect = document.createElement('select');
    filterSelect.className = 'fe-filter';
    filterSelect.innerHTML = `
        <option value="all" ${state.filter === 'all' ? 'selected' : ''}>All Files</option>
        <option value="code" ${state.filter === 'code' ? 'selected' : ''}>Code</option>
        <option value="images" ${state.filter === 'images' ? 'selected' : ''}>Images</option>
        <option value="docs" ${state.filter === 'docs' ? 'selected' : ''}>Docs</option>
        <option value="folders" ${state.filter === 'folders' ? 'selected' : ''}>Folders</option>
    `;
    filterSelect.onchange = () => {
        state.filter = filterSelect.value;
        renderContent();
    };
    toolbar.appendChild(filterSelect);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'fe-actions';

    // Grouping: dirs-first / files-first / mixed — cycles on click
    const groupBtn = document.createElement('button');
    groupBtn.className = 'fe-action-btn fe-group-btn';
    const modeLabels = { 'dirs-first': 'Dirs first', 'files-first': 'Files first', 'mixed': 'Mixed' };
    groupBtn.setAttribute('data-tooltip', `Grouping: ${modeLabels[sortPrefs.groupDirs]} (click to cycle)`);
    groupBtn.innerHTML = GROUP_ICONS[sortPrefs.groupDirs];
    groupBtn.onclick = () => {
        const idx = GROUP_MODES.indexOf(sortPrefs.groupDirs);
        const next = GROUP_MODES[(idx + 1) % GROUP_MODES.length];
        setSortPrefs({ groupDirs: next });
    };
    actions.appendChild(groupBtn);

    // Hidden files toggle
    const hiddenBtn = document.createElement('button');
    hiddenBtn.className = `fe-action-btn ${state.showHidden ? 'active' : ''}`;
    hiddenBtn.setAttribute('data-tooltip', 'Show Hidden Files');
    hiddenBtn.innerHTML = ICONS.eye || '👁';
    hiddenBtn.onclick = () => {
        state.showHidden = !state.showHidden;
        renderContent();
    };
    actions.appendChild(hiddenBtn);

    // Refresh — in-place so selection/expansion/scroll are preserved, and
    // expanded subtrees also refetch (not just the top level).
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'fe-action-btn';
    refreshBtn.setAttribute('data-tooltip', 'Refresh');
    refreshBtn.innerHTML = ICONS.refresh || '↻';
    refreshBtn.onclick = () => refreshInPlace({ force: true });
    actions.appendChild(refreshBtn);

    toolbar.appendChild(actions);
    container.appendChild(toolbar);
}

function renderBreadcrumb(container) {
    const state = getState();

    const breadcrumb = document.createElement('div');
    breadcrumb.className = 'fe-breadcrumb';

    if (state.pathEditing) {
        renderPathEditor(breadcrumb);
    } else {
        renderPathSegments(breadcrumb);
        renderEditPathButton(breadcrumb);
    }

    container.appendChild(breadcrumb);
}

function renderPathSegments(parent) {
    const state = getState();
    const pathContainer = document.createElement('div');
    pathContainer.className = 'fe-path';

    if (state.currentPath) {
        const parts = state.currentPath.split('/').filter(Boolean);
        let accumulated = '';

        const homeBtn = document.createElement('button');
        homeBtn.className = 'fe-path-segment fe-home';
        homeBtn.innerHTML = ICONS.home || '🏠';
        homeBtn.setAttribute('data-tooltip', state.cwd || '/');
        homeBtn.onclick = () => loadDirectory(state.cwd || '/');
        pathContainer.appendChild(homeBtn);

        parts.forEach(part => {
            accumulated += '/' + part;
            const path = accumulated;

            const sep = document.createElement('span');
            sep.className = 'fe-path-sep';
            sep.textContent = '/';
            pathContainer.appendChild(sep);

            const segment = document.createElement('button');
            segment.className = 'fe-path-segment';
            segment.textContent = part;
            segment.onclick = () => loadDirectory(path);
            pathContainer.appendChild(segment);
        });
    }

    parent.appendChild(pathContainer);
}

function renderEditPathButton(parent) {
    const btn = document.createElement('button');
    btn.className = 'fe-path-edit-btn';
    btn.setAttribute('data-tooltip', 'Edit path');
    btn.innerHTML = ICONS.edit || '✎';
    btn.onclick = startPathEdit;
    parent.appendChild(btn);
}

function renderPathEditor(parent) {
    const state = getState();
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'fe-path-input';
    input.value = state.currentPath || state.cwd || '/';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Type a path and press Enter');

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            commitPath(input.value);
        } else if (e.key === 'Escape') {
            // Stop here so the widget-level Escape doesn't also fire (which
            // would try to close the filter bar or the widget itself).
            e.preventDefault();
            e.stopPropagation();
            cancelPathEdit();
        }
    });

    input.addEventListener('blur', () => {
        // If we're still editing, the user clicked away → cancel.
        // commit / cancel flip pathEditing off first so this is a no-op in
        // those paths.
        if (getState().pathEditing) cancelPathEdit();
    });

    parent.appendChild(input);

    // Focus after it's in the DOM; select-all so a quick retype replaces it.
    setTimeout(() => {
        input.focus();
        input.select();
    }, 0);
}

function startPathEdit() {
    const state = getState();
    state.pathEditing = true;
    renderContent();
}

function cancelPathEdit() {
    const state = getState();
    state.pathEditing = false;
    renderContent();
    state.currentContainer?.focus({ preventScroll: true });
}

function commitPath(raw) {
    const state = getState();
    state.pathEditing = false;
    const trimmed = (raw || '').trim();
    if (!trimmed) { renderContent(); return; }

    let resolved = trimmed;
    if (resolved.startsWith('~')) {
        // "~" or "~/path" — expand to the real server-reported HOME that
        // arrives with the "connected" WebSocket message. Falls back to the
        // first two segments of the session cwd (/home/<user>) if HOME
        // hasn't been populated yet.
        const home = CONFIG.HOME && CONFIG.HOME !== '/home'
            ? CONFIG.HOME
            : (state.cwd ? state.cwd.split('/').slice(0, 3).join('/') : '/');
        resolved = home + resolved.slice(1);
    } else if (!resolved.startsWith('/')) {
        // Treat bare input as relative to the current directory.
        const base = state.currentPath || state.cwd || '/';
        resolved = `${base.replace(/\/$/, '')}/${resolved}`;
    }
    // Trim trailing slash unless it's the root.
    if (resolved.length > 1 && resolved.endsWith('/')) {
        resolved = resolved.replace(/\/+$/, '');
    }

    loadDirectory(resolved);
}

function sortFiles(files) {
    const sorted = [...files];
    sorted.sort((a, b) => {
        // Group dirs and files before applying field sort
        if (sortPrefs.groupDirs === 'dirs-first') {
            if (a.is_dir && !b.is_dir) return -1;
            if (!a.is_dir && b.is_dir) return 1;
        } else if (sortPrefs.groupDirs === 'files-first') {
            if (a.is_dir && !b.is_dir) return 1;
            if (!a.is_dir && b.is_dir) return -1;
        }
        // else 'mixed' — no grouping, fall through

        let cmp = 0;
        switch (sortPrefs.sortBy) {
            case 'modified':
                cmp = (a.mtime || 0) - (b.mtime || 0);
                break;
            case 'size':
                cmp = (a.size || 0) - (b.size || 0);
                break;
            case 'kind':
                cmp = getKindSortKey(a).localeCompare(getKindSortKey(b));
                break;
            default:
                cmp = a.name.localeCompare(b.name);
        }
        if (cmp === 0) cmp = a.name.localeCompare(b.name);
        return sortPrefs.sortAsc ? cmp : -cmp;
    });
    return sorted;
}

function filterFiles(files) {
    const state = getState();
    return files
        .filter(f => matchesFilter(f, state.filter))
        .filter(f => state.showHidden || !f.name.startsWith('.'));
}

// Inline filter: does this branch contain a match for the query?
// Recurses through expanded children (we can only filter what's loaded).
function branchMatches(file, absPath, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    if (file.name.toLowerCase().includes(q)) return true;
    if (!file.is_dir) return false;
    const state = getState();
    if (!state.expanded.has(absPath)) return false;
    const children = state.childrenCache.get(absPath) || [];
    for (const c of children) {
        const childPath = c.path || `${absPath}/${c.name}`;
        if (branchMatches(c, childPath, query)) return true;
    }
    return false;
}

function renderFilterBar(container) {
    const state = getState();
    if (!state.filterBarOpen) return;
    const bar = document.createElement('div');
    bar.className = 'fe-filter-bar';
    const subdirsActive = state.searchSubdirs;
    const ignoredActive = state.searchIncludeIgnored;
    const subdirsTip = subdirsActive
        ? (S.file_explorer?.search_subdirs_on || 'Searching subfolders (click to limit to current folder)')
        : (S.file_explorer?.search_subdirs_off || 'Limited to current folder (click to search subfolders)');
    const ignoredTip = ignoredActive
        ? (S.file_explorer?.include_ignored_on || 'Including .gitignore\'d files (click to respect .gitignore)')
        : (S.file_explorer?.include_ignored_off || 'Respecting .gitignore (click to include ignored files)');
    bar.innerHTML = `
        <span class="fe-filter-icon">${ICONS.search || '🔍'}</span>
        <input type="text" class="fe-filter-input" placeholder="Filter tree…" />
        <button class="fe-filter-toggle ${subdirsActive ? 'active' : ''}" data-toggle="subdirs" data-tooltip="${subdirsTip}">
            ${ICONS.folderTree || '🌳'}
        </button>
        <button class="fe-filter-toggle ${ignoredActive ? 'active' : ''}" data-toggle="ignored" data-tooltip="${ignoredTip}">
            ${ignoredActive ? (ICONS.eye || '👁') : (ICONS.eyeOff || '🚫')}
        </button>
        <button class="fe-filter-clear" data-tooltip="Clear filter (Esc)">✕</button>
    `;
    const input = bar.querySelector('.fe-filter-input');
    input.value = state.filterQuery;
    input.addEventListener('input', (e) => {
        state.filterQuery = e.target.value;
        // Re-render just the list (keeps the filter input focused and caret stable)
        renderList();
    });
    bar.querySelector('[data-toggle="subdirs"]').addEventListener('click', (e) => {
        e.preventDefault();
        state.searchSubdirs = !state.searchSubdirs;
        renderContent();
        // Refocus the input so typing continues without an extra click
        state.currentContainer?.querySelector('.fe-filter-input')?.focus();
    });
    bar.querySelector('[data-toggle="ignored"]').addEventListener('click', (e) => {
        e.preventDefault();
        state.searchIncludeIgnored = !state.searchIncludeIgnored;
        // Index params changed — drop the cache so the next ensureTreeIndex refetches
        invalidateTreeIndex();
        ensureTreeIndex();
        renderContent();
        state.currentContainer?.querySelector('.fe-filter-input')?.focus();
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeFilterBar();
            return;
        }
        // ArrowDown from the filter input jumps to the first visible result.
        // ArrowUp jumps to the last. Enter acts on the first match.
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
            const items = getVisibleItems();
            if (items.length === 0) return;
            e.preventDefault();
            const state = getState();
            state.currentContainer?.focus({ preventScroll: true });
            const target = e.key === 'ArrowUp' ? items[items.length - 1] : items[0];
            setSelection(target.dataset.path);
            if (e.key === 'Enter') activateSelection();
        }
    });
    bar.querySelector('.fe-filter-clear').onclick = () => closeFilterBar();
    container.appendChild(bar);
}

function closeFilterBar() {
    const state = getState();
    state.filterBarOpen = false;
    state.filterQuery = '';
    renderContent();
    state.currentContainer?.focus({ preventScroll: true });
}

function openFilterBar(initialChar = '') {
    const state = getState();
    state.filterBarOpen = true;
    if (initialChar) state.filterQuery = initialChar;
    // Kick off the recursive index fetch early so the second keystroke has
    // results to match against — /api/files/list is cached server-side per-cwd.
    ensureTreeIndex();
    renderContent();
    const input = state.currentContainer?.querySelector('.fe-filter-input');
    if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }
}

function renderHeaderRow(list) {
    const header = document.createElement('div');
    header.className = 'fe-header-row';
    const cols = [
        { field: 'name',     label: 'Name',     cls: 'fe-header-name' },
        { field: 'kind',     label: 'Kind',     cls: 'fe-header-kind' },
        { field: 'modified', label: 'Modified', cls: 'fe-header-modified' },
        { field: 'size',     label: 'Size',     cls: 'fe-header-size' },
    ];
    cols.forEach(c => {
        const btn = document.createElement('button');
        const active = sortPrefs.sortBy === c.field;
        btn.className = `fe-header-col ${c.cls} ${active ? 'active' : ''}`;
        const indicator = active
            ? (sortPrefs.sortAsc ? '<span class="fe-header-caret">▲</span>' : '<span class="fe-header-caret">▼</span>')
            : '';
        btn.innerHTML = `<span class="fe-header-label">${c.label}</span>${indicator}`;
        btn.onclick = () => {
            if (sortPrefs.sortBy === c.field) {
                setSortPrefs({ sortAsc: !sortPrefs.sortAsc });
            } else {
                setSortPrefs({ sortBy: c.field });
            }
        };
        header.appendChild(btn);
    });
    list.appendChild(header);
}

function renderTreeNode(list, file, depth) {
    const state = getState();
    const absPath = file.path || `${state.currentPath}/${file.name}`;
    const query = state.filterBarOpen ? state.filterQuery : '';
    if (query && !branchMatches(file, absPath, query)) return;

    const item = renderFileItem(file, depth);
    list.appendChild(item);

    if (!file.is_dir) return;
    if (!state.expanded.has(absPath)) return;

    const children = state.childrenCache.get(absPath);
    if (children === undefined) {
        // Fetch in progress — placeholder
        if (state.loadingChildren.has(absPath)) {
            const loader = document.createElement('div');
            loader.className = 'fe-item fe-tree-loading';
            loader.style.paddingLeft = `${16 + (depth + 1) * 18}px`;
            loader.textContent = 'Loading…';
            list.appendChild(loader);
        }
        return;
    }
    // Subtree fetch errored — show a concise inline notice instead of an
    // empty dir, so the user understands why it won't open.
    const childErr = state.childrenError.get(absPath);
    if (childErr) {
        const desc = describeDirError(childErr);
        const row = document.createElement('div');
        row.className = 'fe-item fe-tree-error';
        row.style.paddingLeft = `${16 + (depth + 1) * 18}px`;
        row.textContent = desc?.title || 'Can\'t open';
        row.setAttribute('data-tooltip', desc?.body || childErr.detail || '');
        list.appendChild(row);
        return;
    }
    const rendered = sortFiles(filterFiles(children));
    const anyMatching = query
        ? rendered.filter(c => branchMatches(c, c.path || `${absPath}/${c.name}`, query))
        : rendered;
    if (anyMatching.length === 0 && !query) {
        const empty = document.createElement('div');
        empty.className = 'fe-item fe-tree-empty';
        empty.style.paddingLeft = `${16 + (depth + 1) * 18}px`;
        empty.textContent = 'Empty';
        list.appendChild(empty);
    }
    rendered.forEach(c => renderTreeNode(list, c, depth + 1));
}

function renderFileList(container) {
    const state = getState();
    const query = state.filterBarOpen ? state.filterQuery : '';

    // Recursive-search mode: ≥2 chars flips from in-memory tree filter to the
    // flat match list backed by /api/files/list. Kicks off a fetch on demand;
    // while loading, show a loader. Column headers are suppressed because the
    // results are flat (not tree-aligned with sortable columns).
    if (query && query.length >= 2) {
        ensureTreeIndex();
        const matches = filterTreeIndex(query);
        renderFlatMatches(container, matches);
        return;
    }

    // Column headers: outside the scroll area so they never scroll away
    renderHeaderRow(container);

    const list = document.createElement('div');
    list.className = 'fe-list';

    // Top-level error block: listing itself couldn't be fetched (403/404/etc).
    // Rendered inside .fe-list so it gets the same layout/scroll container.
    if (state.errorInfo) {
        renderErrorBlock(list, state.errorInfo);
        container.appendChild(list);
        return;
    }

    const files = sortFiles(filterFiles(state.files));

    // Parent directory (always visible, never filtered)
    if (state.currentPath && state.currentPath !== '/' && state.currentPath !== state.cwd) {
        const parentPath = state.currentPath.split('/').slice(0, -1).join('/') || '/';
        const parent = document.createElement('div');
        parent.className = 'fe-item fe-parent';
        parent.innerHTML = `
            <span class="fe-tree-spacer"></span>
            <span class="fe-icon">${ICONS.folderUp || '📁'}</span>
            <span class="fe-name">..</span>
        `;
        parent.onclick = () => loadDirectory(parentPath);
        list.appendChild(parent);
    }

    // Files (possibly with expanded subtrees; renderTreeNode applies filter)
    files.forEach(file => renderTreeNode(list, file, 0));

    // Empty states
    const hasItems = list.querySelector('.fe-item:not(.fe-parent)');
    if (!hasItems) {
        const empty = document.createElement('div');
        empty.className = 'fe-empty';
        if (query) {
            empty.innerHTML = `
                <span class="fe-empty-icon">${ICONS.search || '🔍'}</span>
                <span class="fe-empty-text">No matches for "${escapeHtml(query)}"</span>
            `;
        } else {
            empty.innerHTML = `
                <span class="fe-empty-icon">${ICONS.folder || '📂'}</span>
                <span class="fe-empty-text">${state.filter !== 'all' ? 'No matching files' : 'Empty directory'}</span>
            `;
        }
        list.appendChild(empty);
    }

    container.appendChild(list);
}

function renderErrorBlock(list, errInfo) {
    const state = getState();
    const desc = describeDirError(errInfo);
    const block = document.createElement('div');
    block.className = 'fe-error';

    const iconSvg = ICONS[desc.icon] || ICONS.alert || '⚠';
    const pathText = errInfo.path ? escapeHtml(errInfo.path) : '';

    block.innerHTML = `
        <div class="fe-error-icon">${iconSvg}</div>
        <div class="fe-error-title">${escapeHtml(desc.title)}</div>
        <div class="fe-error-body">${escapeHtml(desc.body)}</div>
        ${pathText ? `<div class="fe-error-path">${pathText}</div>` : ''}
        <div class="fe-error-actions"></div>
    `;

    const actions = block.querySelector('.fe-error-actions');
    const isFilePath = errInfo.status === 400 && errInfo.detail === 'Not a directory';

    if (isFilePath && errInfo.path) {
        const previewBtn = document.createElement('button');
        previewBtn.className = 'fe-error-btn fe-error-btn-primary';
        previewBtn.textContent = 'Preview file';
        previewBtn.onclick = () => {
            const parent = errInfo.path.split('/').slice(0, -1).join('/') || '/';
            loadDirectory(parent);
            window.app?.previewFile(errInfo.path, { imageGallery: 'dir' });
        };
        actions.appendChild(previewBtn);
    }

    const parentPath = errInfo.path
        ? errInfo.path.split('/').slice(0, -1).join('/')
        : '';
    if (parentPath && parentPath !== errInfo.path && parentPath !== '') {
        const parentBtn = document.createElement('button');
        parentBtn.className = 'fe-error-btn';
        parentBtn.textContent = 'Go to parent';
        parentBtn.onclick = () => loadDirectory(parentPath || '/');
        actions.appendChild(parentBtn);
    }

    if (state.cwd && errInfo.path !== state.cwd) {
        const homeBtn = document.createElement('button');
        homeBtn.className = `fe-error-btn ${isFilePath ? '' : 'fe-error-btn-primary'}`;
        homeBtn.textContent = 'Go to project root';
        homeBtn.onclick = () => loadDirectory(state.cwd);
        actions.appendChild(homeBtn);
    }

    const retryBtn = document.createElement('button');
    retryBtn.className = 'fe-error-btn';
    retryBtn.textContent = 'Retry';
    retryBtn.onclick = () => loadDirectory(errInfo.path || state.currentPath);
    actions.appendChild(retryBtn);

    list.appendChild(block);
}

function renderFileItem(file, depth = 0) {
    const state = getState();
    const item = document.createElement('div');
    item.className = `fe-item ${file.is_dir ? 'fe-dir' : ''}`;
    item.dataset.path = file.path || `${state.currentPath}/${file.name}`;
    item.dataset.depth = depth;

    const fileType = file.is_dir ? { icon: 'folder', color: 'var(--accent-yellow)' } : getFileType(file.name);
    const sizeText = file.is_dir ? '' : (file.size !== undefined ? formatFileSize(file.size) : '');
    const modText = formatDate(file.mtime);
    const kindText = getKindLabel(file);
    const absPath = item.dataset.path;
    const gitStatus = file.is_dir ? dirHasGitChanges(absPath) : state.gitStatus.get(absPath);
    const gitGlyph = gitStatus ? (GIT_STATUS_ICONS[gitStatus] || gitStatus) : '';
    const gitBadge = gitStatus
        ? `<span class="fe-git fe-git-${gitStatus}" data-tooltip="${GIT_STATUS_LABELS[gitStatus] || gitStatus}">${gitGlyph}</span>`
        : '';

    if (gitStatus) {
        item.classList.add('fe-has-git-change');
        item.classList.add(`fe-git-status-${gitStatus}`);
    }
    if (state.selectedPath === absPath) item.classList.add('selected');

    // Tree indent — reserve one slot per depth level, plus chevron for dirs / spacer for files
    const indentPx = depth * 18;
    let chevron = '<span class="fe-tree-spacer"></span>';
    if (file.is_dir) {
        const isExpanded = state.expanded.has(absPath);
        chevron = `<button class="fe-tree-chevron ${isExpanded ? 'expanded' : ''}" data-tooltip="${isExpanded ? 'Collapse' : 'Expand'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"/></svg>
        </button>`;
    }

    item.innerHTML = `
        <span class="fe-tree-indent" style="width:${indentPx}px"></span>
        ${chevron}
        <span class="fe-icon" style="color: ${fileType.color}">${ICONS[fileType.icon] || '📄'}</span>
        <span class="fe-name">${escapeHtml(file.name)}</span>
        ${gitBadge}
        <span class="fe-kind">${escapeHtml(kindText)}</span>
        <span class="fe-modified">${modText}</span>
        <span class="fe-size">${sizeText}</span>
    `;

    // Chevron click → toggle expand (don't navigate)
    const chevronEl = item.querySelector('.fe-tree-chevron');
    if (chevronEl) {
        chevronEl.onclick = (e) => {
            e.stopPropagation();
            toggleExpanded(absPath);
        };
    }

    // Row click: dir toggles expansion (like the chevron), file previews.
    // Double-click on a dir enters it (navigates in). Context menu has "Enter".
    item.onclick = (e) => {
        if (chevronEl && chevronEl.contains(e.target)) return; // chevron handled above
        state.selectedPath = absPath;
        if (file.is_dir) {
            toggleExpanded(absPath); // renders internally
            return;
        }
        window.app?.previewFile(absPath, { imageGallery: 'dir' });
        renderContent();
    };

    item.ondblclick = () => {
        if (file.is_dir) {
            loadDirectory(absPath);
        } else {
            window.app?.openFileInEditor(absPath, state.cwd);
        }
    };

    item.oncontextmenu = (e) => {
        e.preventDefault();
        showContextMenu(e, file, absPath);
    };

    // Long press for touch
    let pressTimer;
    item.ontouchstart = () => {
        pressTimer = setTimeout(() => {
            showContextMenu({ clientX: 100, clientY: item.getBoundingClientRect().top }, file, absPath);
        }, 500);
    };
    item.ontouchend = () => clearTimeout(pressTimer);
    item.ontouchmove = () => clearTimeout(pressTimer);

    return item;
}

async function toggleExpanded(absPath) {
    const state = getState();
    if (state.expanded.has(absPath)) {
        state.expanded.delete(absPath);
        renderContent();
        return;
    }
    state.expanded.add(absPath);
    state.childrenError.delete(absPath);
    if (!state.childrenCache.has(absPath)) {
        state.loadingChildren.add(absPath);
        renderContent();
        try {
            const children = await fetchDirectory(absPath);
            state.childrenCache.set(absPath, children);
        } catch (err) {
            state.childrenCache.set(absPath, []);
            state.childrenError.set(absPath, { status: err.status, detail: err.detail });
        } finally {
            state.loadingChildren.delete(absPath);
        }
    }
    renderContent();
}

// Flat results list rendered when the inline filter triggers a recursive
// search. Replaces the tree for the duration of the active query.
function renderFlatMatches(container, matches) {
    const state = getState();
    const list = document.createElement('div');
    list.className = 'fe-list fe-flat-matches';

    if (state.treeIndexLoading && matches === null) {
        list.innerHTML = `<div class="fe-loading">Scanning subtree…</div>`;
        container.appendChild(list);
        return;
    }

    if (state.treeIndexError) {
        list.innerHTML = `<div class="fe-empty">Couldn't scan subtree: ${escapeHtml(state.treeIndexError)}</div>`;
        container.appendChild(list);
        return;
    }

    const cwd = state.cwd || state.currentPath || '';
    const cwdPrefix = cwd.endsWith('/') ? cwd : cwd + '/';
    const query = state.filterQuery;

    const visible = (matches || []).filter(p => {
        const name = p.slice(p.lastIndexOf('/') + 1);
        if (!state.showHidden && name.startsWith('.')) return false;
        return matchesFilter({ name, is_dir: false }, state.filter);
    });

    if (visible.length === 0) {
        list.innerHTML = `
            <div class="fe-empty">
                <span class="fe-empty-icon">${ICONS.search || '🔍'}</span>
                <span class="fe-empty-text">No matches for "${escapeHtml(query)}"</span>
            </div>
        `;
        container.appendChild(list);
        return;
    }

    visible.forEach(path => {
        const item = document.createElement('div');
        item.className = 'fe-item fe-flat-match';
        item.dataset.path = path;

        const name = path.slice(path.lastIndexOf('/') + 1);
        const fileType = getFileType(name);
        const relative = path.startsWith(cwdPrefix) ? path.slice(cwdPrefix.length) : path;
        const parent = relative.slice(0, relative.length - name.length).replace(/\/$/, '');

        if (state.selectedPath === path) item.classList.add('selected');

        item.innerHTML = `
            <span class="fe-icon" style="color: ${fileType.color}">${ICONS[fileType.icon] || '📄'}</span>
            <div class="fe-match-info">
                <span class="fe-name">${escapeHtml(name)}</span>
                <span class="fe-match-path">${escapeHtml(parent || '.')}</span>
            </div>
        `;

        item.onclick = () => {
            state.selectedPath = path;
            window.app?.previewFile(path, { imageGallery: 'dir' });
            renderList();
        };
        item.ondblclick = () => window.app?.openFileInEditor(path, cwd);
        item.oncontextmenu = (e) => {
            e.preventDefault();
            showContextMenu(e, { name, is_dir: false, path }, path);
        };

        list.appendChild(item);
    });

    if (matches.length >= FLAT_MATCH_LIMIT) {
        const more = document.createElement('div');
        more.className = 'fe-flat-more';
        more.textContent = `Showing first ${FLAT_MATCH_LIMIT} matches — narrow the query for more`;
        list.appendChild(more);
    } else if (state.treeIndexTruncated) {
        const truncated = document.createElement('div');
        truncated.className = 'fe-flat-more';
        truncated.textContent = 'Index truncated at 20,000 files — deep results may be missing';
        list.appendChild(truncated);
    }

    container.appendChild(list);
}

// ============================================================================
// Main Render Function
// ============================================================================

function renderContent() {
    const state = getState();
    const container = state.currentContainer;
    if (!container) return;

    // Preserve scroll position across full re-renders (expand/collapse/sort
    // rebuild the DOM; without this the list jumps back to the top).
    const prevList = container.querySelector('.fe-list');
    const prevScrollTop = prevList ? prevList.scrollTop : 0;

    container.innerHTML = '';
    container.className = 'fe-container';

    renderToolbar(container);

    const content = document.createElement('div');
    content.className = 'fe-content';
    renderBreadcrumb(content);
    renderFilterBar(content);
    renderFileList(content);

    container.appendChild(content);

    // Restore scroll on the new .fe-list after it's in the DOM
    if (prevScrollTop > 0) {
        const newList = container.querySelector('.fe-list');
        if (newList) newList.scrollTop = prevScrollTop;
    }

    // Update widget summary
    if (state.widget) {
        const count = state.files.length;
        const path = state.currentPath?.split('/').pop() || 'Files';
        state.widget.setSummary?.(`${path} (${count})`);
    }
}

// Partial re-render: rebuilds only the header + list, leaving toolbar,
// breadcrumb, and filter bar (and its focus/caret) intact. Called on every
// filter keystroke so typing stays responsive.
function renderList() {
    const state = getState();
    const container = state.currentContainer;
    if (!container) return;
    const content = container.querySelector('.fe-content');
    if (!content) { renderContent(); return; }
    const prevList = content.querySelector('.fe-list');
    const prevHeader = content.querySelector('.fe-header-row');
    const prevScrollTop = prevList ? prevList.scrollTop : 0;
    if (prevList) prevList.remove();
    if (prevHeader) prevHeader.remove();
    renderFileList(content);
    const newList = content.querySelector('.fe-list');
    if (newList && prevScrollTop > 0) newList.scrollTop = prevScrollTop;
}

// ============================================================================
// Actions & Helpers
// ============================================================================

async function loadDirectory(path) {
    const state = getState();
    state.loading = true;
    state.error = null;
    state.errorInfo = null;
    state.navigateTo(path);
    renderContent();

    try {
        // Fetch files and git status in parallel — git status is one-shot per cwd
        const [files] = await Promise.all([
            fetchDirectory(path),
            refreshGitStatus(false),
        ]);
        state.files = files;
        state.loading = false;
        renderContent();
    } catch (err) {
        state.loading = false;
        state.error = err.message;
        state.errorInfo = { status: err.status, detail: err.detail, path: err.path || path };
        state.files = [];
        renderContent();
    }
}

// Refresh the current listing in place — re-fetches the current dir and every
// expanded subtree plus git status, then re-renders. Preserves scroll position
// (renderContent handles that) and expansion state (state.expanded /
// childrenCache are not cleared). Used on window focus / widget open so
// external file system changes (e.g. Claude wrote a new file via the terminal)
// show up without requiring a manual refresh.
//
// Concurrent calls are coalesced; calls within 500ms of each other are skipped
// unless force=true. The manual refresh button passes force.
let _refreshing = null;
let _lastRefreshAt = 0;
async function refreshInPlace({ force = false } = {}) {
    const state = getState();
    if (!state.currentPath) return;
    if (_refreshing) return _refreshing;
    if (!force && Date.now() - _lastRefreshAt < 500) return;

    _refreshing = (async () => {
        const paths = [state.currentPath, ...Array.from(state.expanded)];
        state.gitFetchedForCwd = null; // force git re-fetch
        invalidateTreeIndex(); // recursive search index gets rebuilt on next query
        // We catch into a shape that preserves the error so we can surface it;
        // a plain null would lose 403 vs 404.
        const results = await Promise.all([
            ...paths.map(p => fetchDirectory(p).then(
                files => ({ ok: true, files }),
                err  => ({ ok: false, err }),
            )),
            refreshGitStatus(true),
        ]);
        const topResult = results[0];
        if (topResult.ok) {
            state.files = topResult.files;
            state.errorInfo = null;
        } else {
            // The top-level dir itself became inaccessible (perms changed,
            // deleted, etc.). Show it to the user instead of silently keeping
            // stale data.
            state.errorInfo = {
                status: topResult.err.status,
                detail: topResult.err.detail,
                path: state.currentPath,
            };
            state.files = [];
        }
        for (let i = 1; i < paths.length; i++) {
            const r = results[i];
            if (r.ok) {
                state.childrenCache.set(paths[i], r.files);
                state.childrenError.delete(paths[i]);
            } else {
                // Fetch failed for an expanded subtree — drop from cache and
                // collapse so stale rows don't linger.
                state.childrenCache.delete(paths[i]);
                state.expanded.delete(paths[i]);
                state.childrenError.delete(paths[i]);
            }
        }
        renderContent();
    })();

    try { await _refreshing; }
    finally {
        _refreshing = null;
        _lastRefreshAt = Date.now();
    }
}

/**
 * Resolve a path against the session's CWD if relative
 * @param {string} path - The path (might be relative or absolute)
 * @returns {string} - Absolute path
 */
function resolvePath(path) {
    if (!path) return path;

    // Already absolute
    if (path.startsWith('/')) return path;

    // Get CWD from state or active session (activeSession is a property, not a method)
    const state = getState();
    const cwd = state.cwd || window.app?.activeSession?.cwd;
    if (!cwd) return path; // Can't resolve without CWD

    // Remove leading ./ if present
    const cleanPath = path.replace(/^\.\//, '');

    // Join with CWD
    return `${cwd.replace(/\/$/, '')}/${cleanPath}`;
}

function showContextMenu(e, file, path) {
    const state = getState();
    // Remove existing context menu
    document.querySelectorAll('.fe-context-menu').forEach(m => m.remove());

    const menu = document.createElement('div');
    menu.className = 'fe-context-menu';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    menu.tabIndex = -1;

    const actions = file.is_dir ? [
        { label: S.widgets.file_explorer.context_menu.enter, icon: 'folder', action: () => loadDirectory(path) },
        { label: S.widgets.file_explorer.context_menu.copy_path, icon: 'copy', action: () => { navigator.clipboard.writeText(path); showToast(S.toast.copied); } },
        { label: S.widgets.file_explorer.context_menu.open_terminal, icon: 'terminal', action: () => openInTerminal(path) }
    ] : [
        { label: S.widgets.file_explorer.context_menu.open_editor, icon: 'edit', action: () => window.app?.openFileInEditor(path, state.cwd) },
        { label: S.widgets.file_explorer.context_menu.preview, icon: 'eye', action: () => window.app?.previewFile(path, { imageGallery: 'dir' }) },
        // Only for types /api/browser/render serves with a real MIME — anything
        // else downloads instead of rendering inside the browser widget's iframe
        ...(BROWSER_RENDERABLE.test(file.name) ? [
            { label: S.widgets.file_explorer.context_menu.open_browser, icon: 'globe', action: () => BrowserWidget.navigate(path) }
        ] : []),
        { label: S.widgets.file_explorer.context_menu.copy_path, icon: 'copy', action: () => { navigator.clipboard.writeText(path); showToast(S.toast.copied); } },
        { label: S.widgets.file_explorer.context_menu.insert_chat, icon: 'message', action: () => insertToChat(`\`${path}\``) },
        { label: S.widgets.file_explorer.context_menu.copy_content, icon: 'clipboard', action: () => copyFileContent(path) },
        // Compare wizard
        { label: S.widgets.file_explorer.context_menu.compare, icon: 'columns', action: () => window.DiffViewerWidget?.openCompareWizard(path, state.cwd) }
    ];

    const itemEls = [];
    let selectedIndex = 0;

    const updateSelection = () => {
        itemEls.forEach((el, i) => {
            el.classList.toggle('selected', i === selectedIndex);
        });
        itemEls[selectedIndex]?.scrollIntoView({ block: 'nearest' });
    };

    actions.forEach(({ label, icon, action }, i) => {
        const item = document.createElement('div');
        item.className = 'fe-context-item';
        item.innerHTML = `<span class="fe-context-icon">${ICONS[icon] || ''}</span>${label}`;
        item.onclick = () => {
            closeOwnContextMenu();
            action();
        };
        item.onmouseenter = () => {
            selectedIndex = i;
            updateSelection();
        };
        itemEls.push(item);
        menu.appendChild(item);
    });

    document.body.appendChild(menu);
    // Grab focus so the widget's own keydown listener returns early — type-ahead
    // and arrow nav on the list shouldn't fire while the menu is open.
    menu.focus({ preventScroll: true });
    updateSelection();

    // Keyboard navigation for the menu itself. Listening in the capture phase
    // ensures we beat both the widget's document-level keydown handler and the
    // global ShortcutManager for these keys while the menu is open.
    const handleMenuKey = (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();
            selectedIndex = (selectedIndex + 1) % itemEls.length;
            updateSelection();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            selectedIndex = (selectedIndex - 1 + itemEls.length) % itemEls.length;
            updateSelection();
        } else if (e.key === 'Home') {
            e.preventDefault();
            e.stopPropagation();
            selectedIndex = 0;
            updateSelection();
        } else if (e.key === 'End') {
            e.preventDefault();
            e.stopPropagation();
            selectedIndex = itemEls.length - 1;
            updateSelection();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            itemEls[selectedIndex]?.click();
        }
    };
    document.addEventListener('keydown', handleMenuKey, true);

    // Close on click outside
    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            closeOwnContextMenu();
        }
    };
    const cleanup = () => {
        document.removeEventListener('click', closeMenu);
        document.removeEventListener('keydown', handleMenuKey, true);
        menu.__cleanup = null;
    };
    menu.__cleanup = cleanup;
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

// Alt+Enter on a selected item: open the same context menu the right-click
// gesture would, anchored to the item's rect (since we have no mouse event).
function openContextMenuForSelection() {
    const state = getState();
    const items = getVisibleItems();
    if (items.length === 0) return;
    const el = items.find(i => i.dataset.path === state.selectedPath) || items[0];
    if (!state.selectedPath) setSelection(el.dataset.path, false);
    const rect = el.getBoundingClientRect();
    const pseudoEvent = {
        clientX: rect.left + 24,
        clientY: rect.bottom,
        preventDefault() {}
    };
    const absPath = el.dataset.path;
    const file = { name: absPath.split('/').pop(), is_dir: el.classList.contains('fe-dir'), path: absPath };
    showContextMenu(pseudoEvent, file, absPath);
}

// Close the file-explorer-owned context menu. Returns true if one was found.
// Restores focus to the widget so arrow keys keep working after the menu closes.
function closeOwnContextMenu() {
    const menu = document.querySelector('.fe-context-menu');
    if (!menu) return false;
    menu.__cleanup?.();
    menu.remove();
    const state = getState();
    state.currentContainer?.focus({ preventScroll: true });
    return true;
}

async function copyFileContent(path) {
    try {
        const content = await fetchFileContent(path);
        await navigator.clipboard.writeText(content);
        showToast(S.toast.content_copied);
    } catch (err) {
        showToast(S.errors.copy_failed);
    }
}

function insertToChat(text) {
    const app = window.app;
    const input = app?.els?.messageInput;
    if (!input) return;

    // In full-tab mode the chat input is hidden — jump back to the session view
    if (app.tabCtrl?.activeWidgetTabId && app.tabCtrl.activeSession) {
        app.tabCtrl.switchToSession(app.tabCtrl.activeSession);
    }

    // Insert at cursor, padding with spaces so paths don't glue to existing text
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const needsSpace = before.length > 0 && !/\s$/.test(before);
    const insert = (needsSpace ? ' ' : '') + text + ' ';
    input.value = before + insert + after;
    const pos = before.length + insert.length;
    input.setSelectionRange(pos, pos);
    input.focus();
    app.autoResizeInput?.();
}

function openInTerminal(path) {
    // New terminal tab already cd'd into the directory
    window.app?.tabCtrl?.openTerminalWidgetTab({ cwd: path });
}

function showToast(message) {
    // Simple toast notification
    const toast = document.createElement('div');
    toast.className = 'fe-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
}

// ============================================================================
// Utilities
// ============================================================================

// ============================================================================
// Widget Registration
// ============================================================================

export function registerFileExplorerWidget() {
    WidgetManager.register('file-explorer', {
        type: 'top-sheet',
        title: S.widgets.titles.files,
        icon: 'folder',
        shortcut: 'Alt+F',

        deviceTypes: {
            default: 'top-sheet',
            phone: 'top-sheet',
            tablet: 'top-sheet',
            desktop: 'floating'
        },

        heights: { half: '45vh', full: '85vh' },
        width: '320px',
        minWidth: '280px',
        maxWidth: '500px',

        sessionAware: true,
        persistState: true,
        allowTransform: true,
        allowedTypes: ['top-sheet', 'bottom-sheet', 'sidebar-left', 'sidebar-right', 'floating', 'tab'],

        headerActions: [
            {
                icon: 'home',
                title: S.widgets.header_actions.go_home,
                onClick: () => {
                    const state = getState();
                    loadDirectory(state.cwd || '/');
                }
            },
            {
                icon: 'search',
                title: S.widgets.header_actions.search_files,
                onClick: () => {
                    openFilterBar();
                }
            }
        ],

        render: (container, context) => {
            const state = getState(context.sessionId);
            state.currentContainer = container;
            state.widget = WidgetManager.get('file-explorer');

            // Focusable so type-ahead / Ctrl+F can target the widget without
            // the user having to click into it first.
            container.tabIndex = -1;

            // Update CWD if session context changed
            if (context.cwd && context.cwd !== state.cwd) {
                state.cwd = context.cwd;
                invalidateTreeIndex();
            }

            // Determine if we need to load
            const needsLoad = !state.loading && (
                // No path set - use session CWD
                (!state.currentPath && state.cwd) ||
                // Path is set but no files loaded
                (state.currentPath && state.files.length === 0)
            );

            if (needsLoad) {
                const pathToLoad = state.currentPath || state.cwd;
                if (pathToLoad) {
                    state.currentPath = pathToLoad;
                    loadDirectory(pathToLoad);
                } else {
                    renderContent();
                }
            } else {
                renderContent();
            }
        },

        onOpen: () => {
            const state = getState();
            if (!state.currentPath && state.cwd) {
                loadDirectory(state.cwd);
            } else if (state.currentPath) {
                // Re-opened after being closed: pull latest listing so files
                // created/deleted while the widget was hidden show up.
                refreshInPlace();
            }
            // Move focus into the widget so keyboard shortcuts (Ctrl+F) and
            // type-ahead target it instead of the underlying chat input.
            if (state.currentContainer) {
                state.currentContainer.focus({ preventScroll: true });
            }
        },

        onRefresh: () => refreshInPlace({ force: true }),

        onDestroy: (sessionId) => {
            destroyState(sessionId);
        }
    });

    // Set up event subscriptions
    setupEventSubscriptions();
    setupKeyboardNavigation();
}

// ============================================================================
// Event Bus Subscriptions
// ============================================================================

function setupEventSubscriptions() {
    // Listen for file open requests from other widgets
    WidgetBus.on('navigate:directory', ({ path }) => {
        loadDirectory(path);
        WidgetManager.open('file-explorer');
    });

    // Listen for chat insert requests from other widgets
    WidgetBus.on('chat:insert', ({ text }) => insertToChat(text));

    // When the file preview closes, hand focus back to the explorer so the
    // user can keep arrow-navigating — otherwise the preview's Escape leaves
    // focus on body, which breaks our keydown listener.
    WidgetBus.on('widget:closed', ({ widgetId }) => {
        if (widgetId !== 'file-preview') return;
        const widget = WidgetManager.get('file-explorer');
        if (!widget?.isVisible) return;
        const state = getState();
        state.currentContainer?.focus({ preventScroll: true });
    });

    // Smart refresh: when the user switches back to the app (focus or
    // visibilitychange), pull a fresh listing. Catches the "I just created a
    // file in the terminal and swapped back" case without requiring a manual
    // click. Debounce inside refreshInPlace prevents spam.
    const refreshIfVisible = () => {
        const widget = WidgetManager.get('file-explorer');
        if (widget?.isVisible) refreshInPlace();
    };
    window.addEventListener('focus', refreshIfVisible);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refreshIfVisible();
    });
}

// ============================================================================
// Keyboard Navigation
// ============================================================================

// Flat list of currently visible (rendered) items with a resolvable path.
// Skips the ".." parent row and placeholder rows (loading/empty).
function getVisibleItems() {
    const state = getState();
    const container = state.currentContainer;
    if (!container) return [];
    return Array.from(container.querySelectorAll('.fe-list .fe-item[data-path]'));
}

// Move the keyboard-selection highlight to `path`. Updates DOM directly so we
// don't pay for a full re-render on every arrow keypress.
function setSelection(path, scroll = true) {
    const state = getState();
    state.selectedPath = path;
    const container = state.currentContainer;
    if (!container) return;
    container.querySelectorAll('.fe-item.selected').forEach(i => i.classList.remove('selected'));
    if (!path) return;
    const el = container.querySelector(`.fe-item[data-path="${CSS.escape(path)}"]`);
    if (el) {
        el.classList.add('selected');
        if (scroll) el.scrollIntoView({ block: 'nearest' });
    }
}

// ArrowUp/Down traversal across visible items. ArrowUp past the first item
// returns focus to the filter input (if open), so ArrowDown-into-tree-and-back
// feels symmetric.
function navigateSelection(delta) {
    const state = getState();
    const items = getVisibleItems();
    if (items.length === 0) return;

    let idx = items.findIndex(el => el.dataset.path === state.selectedPath);
    if (idx < 0) idx = delta > 0 ? -1 : items.length;
    const nextIdx = idx + delta;

    if (nextIdx < 0 && state.filterBarOpen) {
        const input = state.currentContainer?.querySelector('.fe-filter-input');
        if (input) {
            setSelection(null);
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
            return;
        }
    }

    const clamped = Math.max(0, Math.min(items.length - 1, nextIdx));
    setSelection(items[clamped].dataset.path);
}

// Enter: on a dir, toggle expansion; on a file, preview.
function activateSelection() {
    const state = getState();
    const items = getVisibleItems();
    if (items.length === 0) return;
    let el = items.find(i => i.dataset.path === state.selectedPath);
    if (!el) {
        el = items[0];
        setSelection(el.dataset.path);
    }
    const absPath = el.dataset.path;
    if (el.classList.contains('fe-dir')) {
        toggleExpanded(absPath);
    } else {
        window.app?.previewFile(absPath, { imageGallery: 'dir' });
    }
}

// ArrowRight: expand a collapsed dir; on an expanded dir, step into first child.
function handleArrowRight() {
    const state = getState();
    if (!state.selectedPath) return;
    const container = state.currentContainer;
    const el = container?.querySelector(`.fe-item[data-path="${CSS.escape(state.selectedPath)}"]`);
    if (!el || !el.classList.contains('fe-dir')) return;
    if (!state.expanded.has(state.selectedPath)) {
        toggleExpanded(state.selectedPath);
    } else {
        navigateSelection(1);
    }
}

// ArrowLeft: collapse expanded dir; otherwise jump to parent dir row.
function handleArrowLeft() {
    const state = getState();
    if (!state.selectedPath) return;
    const container = state.currentContainer;
    const el = container?.querySelector(`.fe-item[data-path="${CSS.escape(state.selectedPath)}"]`);
    if (!el) return;
    const isDir = el.classList.contains('fe-dir');
    if (isDir && state.expanded.has(state.selectedPath)) {
        toggleExpanded(state.selectedPath);
        return;
    }
    const parent = state.selectedPath.split('/').slice(0, -1).join('/');
    if (!parent) return;
    const parentEl = container?.querySelector(`.fe-item[data-path="${CSS.escape(parent)}"]`);
    if (parentEl) setSelection(parent);
}

function setupKeyboardNavigation() {
    // Note: Ctrl/Cmd+F and Escape are handled by app.openSearch() and
    // app.handleEscape() — the global ShortcutManager intercepts those keys in
    // the capture phase with stopImmediatePropagation, so we can't catch them
    // here. Type-ahead (printable keys) and list nav (arrows, Backspace, Enter)
    // aren't registered shortcuts, so they fall through to this bubble listener.
    document.addEventListener('keydown', (e) => {
        const widget = WidgetManager.get('file-explorer');
        if (!widget?.isVisible) return;

        const state = getState();
        const container = state.currentContainer;
        if (!container?.contains(document.activeElement) && document.activeElement !== document.body) return;

        const inInput = document.activeElement?.matches('input, textarea');

        // Type-ahead: printable char in list view opens the inline filter bar
        // and pre-populates it. '/' opens the bar empty (classic "start search").
        // If the filter bar is already open (but focus is on the tree), append
        // to the existing query and return focus to the input.
        const isPrintable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
        if (isPrintable && !inInput) {
            e.preventDefault();
            if (state.filterBarOpen) {
                const input = container.querySelector('.fe-filter-input');
                if (input) {
                    state.filterQuery = (state.filterQuery || '') + e.key;
                    input.value = state.filterQuery;
                    input.focus();
                    input.setSelectionRange(input.value.length, input.value.length);
                    renderList();
                }
            } else {
                openFilterBar(e.key === '/' ? '' : e.key);
            }
            return;
        }

        // Filter input owns its own ArrowUp/Down/Enter (see renderFilterBar).
        if (inInput) return;

        switch (e.key) {
            case 'ArrowUp':
                e.preventDefault();
                navigateSelection(-1);
                break;
            case 'ArrowDown':
                e.preventDefault();
                navigateSelection(1);
                break;
            case 'ArrowRight':
                e.preventDefault();
                handleArrowRight();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                handleArrowLeft();
                break;
            case 'Enter':
                e.preventDefault();
                if (e.altKey) {
                    openContextMenuForSelection();
                } else {
                    activateSelection();
                }
                break;
            case 'Backspace': {
                e.preventDefault();
                // If filtering, Backspace pops the last char (rather than
                // navigating up a directory — which is surprising mid-filter).
                if (state.filterBarOpen && state.filterQuery) {
                    state.filterQuery = state.filterQuery.slice(0, -1);
                    const input = container.querySelector('.fe-filter-input');
                    if (input) input.value = state.filterQuery;
                    renderList();
                    break;
                }
                const parentPath = state.currentPath.split('/').slice(0, -1).join('/') || '/';
                if (parentPath !== state.currentPath) {
                    loadDirectory(parentPath);
                }
                break;
            }
        }
    });
}

// ============================================================================
// External API (for backward compatibility with app.js)
// ============================================================================

/**
 * FileExplorerWidget API - provides methods for external control
 */
export const FileExplorerWidget = {
    /** Open the file explorer */
    open() {
        WidgetManager.open('file-explorer');
    },

    /** Close the file explorer */
    close() {
        WidgetManager.close('file-explorer');
    },

    /** Toggle the file explorer */
    toggle() {
        WidgetManager.toggle('file-explorer');
    },

    /** Get current state */
    get state() {
        const widget = WidgetManager.get('file-explorer');
        return widget?.state || 'collapsed';
    },

    /** Check if visible */
    get isVisible() {
        const widget = WidgetManager.get('file-explorer');
        return widget?.isVisible || false;
    },

    /** Is focus inside the widget (or on body while widget is open)? */
    isFocused() {
        const widget = WidgetManager.get('file-explorer');
        if (!widget?.isVisible) return false;
        const state = getState();
        const container = state.currentContainer;
        if (!container) return false;
        return container.contains(document.activeElement) || document.activeElement === document.body;
    },

    /** Open the inline filter bar and focus its input. Returns true if applied. */
    openSearch() {
        const widget = WidgetManager.get('file-explorer');
        if (!widget?.isVisible) return false;
        openFilterBar();
        return true;
    },

    /**
     * Escape handler. Priority (highest first):
     *   1. Close the file-explorer context menu if open
     *   2. Cancel the breadcrumb path editor if active
     *   3. Close the inline filter bar if open
     * Returns true if any of these was handled.
     */
    handleEscape() {
        const widget = WidgetManager.get('file-explorer');
        if (!widget?.isVisible) return false;
        if (closeOwnContextMenu()) return true;
        const state = getState();
        if (state.pathEditing) { cancelPathEdit(); return true; }
        if (!state.filterBarOpen) return false;
        closeFilterBar();
        return true;
    },

    /** Set home path (CWD) */
    setHomePath(path) {
        const state = getState();
        state.cwd = path;
        if (!state.currentPath) {
            state.currentPath = path;
        }
    },

    /** Navigate to directory */
    navigateTo(path) {
        loadDirectory(path);
        WidgetManager.open('file-explorer');
    },

    /**
     * Reveal a file: open the explorer at its parent directory, select the
     * row, scroll it into view, and flash it. PWA-friendly alternative to a
     * host-OS file manager — works on iPad and headless servers alike.
     */
    async revealFile(path) {
        if (!path) return;
        const parentDir = path.substring(0, path.lastIndexOf('/')) || '/';

        // Open the widget first so state.currentContainer is set before
        // loadDirectory's renderContent runs. Wait one frame for the render
        // callback to commit the container reference.
        WidgetManager.open('file-explorer');
        await new Promise(r => requestAnimationFrame(r));

        await loadDirectory(parentDir);

        // Wait one more frame so the row DOM is in place before selecting.
        await new Promise(r => requestAnimationFrame(r));

        setSelection(path, true);
        const container = getState().currentContainer;
        const el = container?.querySelector(`.fe-item[data-path="${CSS.escape(path)}"]`);
        if (el) {
            el.classList.add('flash');
            setTimeout(() => el.classList.remove('flash'), 1500);
        }
    },

    /** Force an in-place refresh (re-fetches current dir + expanded subtrees + git) */
    refresh() {
        return refreshInPlace({ force: true });
    },

    /** Get internal state for debugging */
    getState() {
        return getState();
    },

    /** Destroy state for a session */
    destroyState
};
