/**
 * Diff Viewer Widget - Side-by-side file comparison
 *
 * Provides a two-column diff view using CSS Grid (single scroll container,
 * perfect line alignment). Supports multiple entry points:
 * - Edit tool blocks (automatic old/new)
 * - Changes widget (session file changes)
 * - Git widget (HEAD vs working tree)
 * - Compare Wizard (shadow history, git history, branches, working changes, file picker)
 *
 * Views: split (side-by-side) | unified (classic)
 */

import S from '../strings.js';
import { escapeHtml } from '../utils.js';
import { CONFIG } from '../config.js';
import { WidgetManager, ICONS } from '../widget-system/index.js';
import { generateSmartDiff, renderSmartDiff, renderSideBySideDiff } from '../diff-utils.js';
import { showToast, ContextMenu } from '../context-menu.js';

const PREF_KEY_VIEW_MODE = 'diff-viewer-view-mode';
const PREF_KEY_WRAP_LINES = 'diff-viewer-wrap-lines';

function loadViewMode() {
    try {
        const v = localStorage.getItem(PREF_KEY_VIEW_MODE);
        return v === 'unified' || v === 'split' ? v : null;
    } catch { return null; }
}
function saveViewMode(v) {
    try { localStorage.setItem(PREF_KEY_VIEW_MODE, v); } catch {}
}
function loadWrapLines() {
    try { return localStorage.getItem(PREF_KEY_WRAP_LINES) === '1'; } catch { return false; }
}
function saveWrapLines(v) {
    try { localStorage.setItem(PREF_KEY_WRAP_LINES, v ? '1' : '0'); } catch {}
}

// ═══════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════

class DiffViewerState {
    constructor() { this.reset(); }
    reset() {
        this.files = [];            // [{path, oldContent, newContent, oldLabel, newLabel, additions, deletions}]
        this.currentFileIndex = 0;
        this.viewMode = loadViewMode() || 'split';    // 'split' | 'unified'
        this.wrapLines = loadWrapLines();
        this.source = null;         // 'edit-tool' | 'git' | 'diff' | 'compare' | 'wizard'
        this.loading = false;
        this.error = null;
        this.currentContainer = null;
        this.hunkElements = [];     // cached hunk start elements for keyboard nav
        this.currentHunkIndex = -1;

        // History bar state
        this.historyCommits = null;     // null = not loaded; [] = no history; [...] = loaded
        this.historyLoading = false;
        this.historyKey = null;         // `${cwd}:${path}` of last loaded history
        this.historyIndex = -1;         // -1 = not aligned to a shadow commit; else index into historyCommits

        // Wizard state
        this.wizardActive = false;
        this.wizardStep = 'source'; // 'source' | 'shadow' | 'git' | 'branch' | 'working' | 'file'
        this.wizardFilePath = null;
        this.wizardFileContent = null;
        this.wizardCwd = null;
        this.wizardFocusIndex = -1; // keyboard nav focus within lists/cards
        this.wizardPickerData = []; // loaded commits/branches/files
        this.wizardFileQuery = '';  // search filter for file picker
        this.wizardAllFiles = null; // cached full file list
    }
}

const states = new Map();

function getState(sessionId) {
    sessionId = sessionId || WidgetManager.currentSessionId || '_global';
    if (!states.has(sessionId)) states.set(sessionId, new DiffViewerState());
    return states.get(sessionId);
}

function destroyState(sessionId) {
    states.delete(sessionId);
}

// ═══════════════════════════════════════════════════════════════
// Edit data cache (for tool-renderer onclick passing)
// ═══════════════════════════════════════════════════════════════

const editDataCache = new Map();
let editDataCounter = 0;

function cacheEditData(filePath, oldContent, newContent, startLine) {
    const id = `edit-${++editDataCounter}`;
    editDataCache.set(id, { filePath, oldContent, newContent, startLine });
    // Limit cache size
    if (editDataCache.size > 200) {
        const first = editDataCache.keys().next().value;
        editDataCache.delete(first);
    }
    return id;
}

function openFromCache(cacheId) {
    const data = editDataCache.get(cacheId);
    if (!data) return;
    DiffViewerWidget.openWithContent(data.filePath, data.oldContent, data.newContent, {
        source: 'edit-tool',
        startLine: data.startLine
    });
}

// ═══════════════════════════════════════════════════════════════
// Compare Wizard
// ═══════════════════════════════════════════════════════════════

const WIZARD_SOURCES = [
    { id: 'shadow', icon: 'history',  titleKey: 'source_shadow', descKey: 'source_shadow_desc' },
    { id: 'git',    icon: 'commit',   titleKey: 'source_git',    descKey: 'source_git_desc' },
    { id: 'branch', icon: 'branch',   titleKey: 'source_branch', descKey: 'source_branch_desc' },
    { id: 'working',icon: 'edit',     titleKey: 'source_working', descKey: 'source_working_desc' },
    { id: 'file',   icon: 'file',     titleKey: 'source_file',   descKey: 'source_file_desc' },
];

function renderWizard(sessionId) {
    const state = getState(sessionId);
    const container = state.currentContainer;
    if (!container) return;

    if (state.wizardStep === 'source') {
        renderWizardSourcePicker(state, container, sessionId);
    } else {
        renderWizardPicker(state, container, sessionId);
    }

    // Update widget summary
    const widget = WidgetManager.get('diff-viewer');
    if (widget) {
        const W = S.widgets.diff_viewer.wizard;
        widget.setSummary?.(W.choose_source);
    }

    container.tabIndex = -1;
    container.focus();
}

function renderWizardSourcePicker(state, container, sessionId) {
    const W = S.widgets.diff_viewer.wizard;
    const fileName = basename(state.wizardFilePath);

    let cardsHtml = '';
    WIZARD_SOURCES.forEach((src, i) => {
        const focused = i === state.wizardFocusIndex ? ' cw-focused' : '';
        cardsHtml += `
            <button class="cw-source-card${focused}" data-source="${src.id}" data-idx="${i}">
                <span class="cw-source-icon">${ICONS[src.icon] || ''}<span class="cw-source-title">${W[src.titleKey]}</span></span>
                <span class="cw-source-desc">${W[src.descKey]}</span>
            </button>`;
    });

    container.innerHTML = `
        <div class="cw-wizard">
            <div class="cw-file-header">
                <span class="cw-file-name">${escapeHtml(fileName)}</span>
                <span class="cw-file-hint">${W.choose_source}</span>
            </div>
            <div class="cw-sources">${cardsHtml}</div>
        </div>`;

    container.querySelectorAll('.cw-source-card').forEach(btn => {
        btn.addEventListener('click', () => wizardSelectSource(state, btn.dataset.source, sessionId));
    });
}

async function wizardSelectSource(state, sourceId, sessionId) {
    state.wizardStep = sourceId;
    state.wizardFocusIndex = -1;
    state.wizardPickerData = [];

    // For working changes, render immediately (no data to fetch)
    if (sourceId === 'working') {
        renderWizard(sessionId);
        return;
    }

    // Show loading
    const container = state.currentContainer;
    if (container) {
        container.innerHTML = `<div class="cw-wizard"><div class="cw-loading">${ICONS.loading} ${S.widgets.diff_viewer.wizard.loading_commits}</div></div>`;
    }

    const cwd = state.wizardCwd || WidgetManager.currentCwd || '';
    const filePath = state.wizardFilePath;
    // Relative path for API calls
    const relPath = filePath.startsWith(cwd + '/') ? filePath.slice(cwd.length + 1) : filePath;

    try {
        if (sourceId === 'shadow') {
            const resp = await fetch(`${CONFIG.API_BASE}/api/shadow/files/${encodeURIComponent(relPath)}/history?cwd=${encodeURIComponent(cwd)}&limit=50`);
            if (resp.ok) {
                const data = await resp.json();
                state.wizardPickerData = data.commits || [];
            }
        } else if (sourceId === 'git') {
            const resp = await fetch(`${CONFIG.API_BASE}/api/git/file-log?file=${encodeURIComponent(relPath)}&cwd=${encodeURIComponent(cwd)}&limit=30`);
            if (resp.ok) {
                const data = await resp.json();
                state.wizardPickerData = data.commits || [];
            }
        } else if (sourceId === 'branch') {
            const resp = await fetch(`${CONFIG.API_BASE}/api/git/branches?cwd=${encodeURIComponent(cwd)}`);
            if (resp.ok) {
                const data = await resp.json();
                state.wizardPickerData = (data.branches || []).filter(b => !b.isCurrent);
            }
        } else if (sourceId === 'file') {
            if (!state.wizardAllFiles) {
                const resp = await fetch(`${CONFIG.API_BASE}/api/files/list?cwd=${encodeURIComponent(cwd)}`);
                if (resp.ok) {
                    const data = await resp.json();
                    state.wizardAllFiles = (data.files || []).filter(f => f !== relPath);
                }
            }
            state.wizardPickerData = state.wizardAllFiles || [];
        }
    } catch (err) {
        console.error('[DiffViewer] Wizard fetch error:', err);
    }

    renderWizard(sessionId);
}

function renderWizardPicker(state, container, sessionId) {
    const W = S.widgets.diff_viewer.wizard;
    const fileName = basename(state.wizardFilePath);
    const step = state.wizardStep;

    // Build picker header with back button
    const backHtml = `
        <div class="cw-picker-header">
            <button class="cw-back-btn" data-action="wizard-back">${ICONS.back} ${W.back}</button>
            <span class="cw-picker-title">${getPickerTitle(step, fileName)}</span>
        </div>`;

    let bodyHtml = '';

    if (step === 'working') {
        bodyHtml = renderWorkingPicker(state);
    } else if (step === 'file') {
        bodyHtml = renderFilePicker(state);
    } else {
        bodyHtml = renderCommitList(state, step);
    }

    container.innerHTML = `<div class="cw-wizard">${backHtml}${bodyHtml}</div>`;

    // Wire up back button
    container.querySelector('[data-action="wizard-back"]')?.addEventListener('click', () => {
        state.wizardStep = 'source';
        state.wizardFocusIndex = -1;
        renderWizard(sessionId);
    });

    // Wire up commit/branch clicks
    container.querySelectorAll('.cw-item').forEach(el => {
        el.addEventListener('click', () => {
            wizardPickItem(state, sessionId, el.dataset);
        });
    });

    // Wire up working change buttons
    container.querySelectorAll('.cw-working-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            wizardPickWorking(state, sessionId, btn.dataset.staged === 'true');
        });
    });

    // Wire up file picker search
    const searchInput = container.querySelector('.cw-file-search');
    if (searchInput) {
        searchInput.value = state.wizardFileQuery;
        searchInput.addEventListener('input', (e) => {
            state.wizardFileQuery = e.target.value;
            // Re-render just the file list
            const listEl = container.querySelector('.cw-list');
            if (listEl) listEl.innerHTML = renderFileListItems(state);
            // Re-wire file clicks
            container.querySelectorAll('.cw-file-item').forEach(el => {
                el.addEventListener('click', () => {
                    wizardPickFile(state, sessionId, el.dataset.path);
                });
            });
        });
        searchInput.focus();
    }

    // Wire up file item clicks
    container.querySelectorAll('.cw-file-item').forEach(el => {
        el.addEventListener('click', () => {
            wizardPickFile(state, sessionId, el.dataset.path);
        });
    });
}

function getPickerTitle(step, fileName) {
    const W = S.widgets.diff_viewer.wizard;
    switch (step) {
        case 'shadow': return W.picker_shadow.replace('{file}', fileName);
        case 'git':    return W.picker_git.replace('{file}', fileName);
        case 'branch': return W.picker_branch;
        case 'file':   return W.picker_file;
        case 'working': return W.source_working;
        default: return '';
    }
}

function renderCommitList(state, step) {
    const W = S.widgets.diff_viewer.wizard;
    const items = state.wizardPickerData;

    if (!items.length) {
        const emptyMsg = step === 'shadow' ? W.no_shadow_history :
                         step === 'branch' ? W.no_branches : W.no_git_history;
        return `<div class="cw-empty">${emptyMsg}</div>`;
    }

    let html = '<div class="cw-list">';
    items.forEach((item, i) => {
        const focused = i === state.wizardFocusIndex ? ' cw-focused' : '';
        const time = item.timestamp ? timeAgo(item.timestamp) : '';

        if (step === 'branch') {
            html += `<div class="cw-item${focused}" data-ref="${escapeHtml(item.name)}" data-idx="${i}">
                <span class="cw-item-hash">${escapeHtml(item.name)}</span>
                <span class="cw-item-subject">${escapeHtml(item.subject || '')}</span>
                <span class="cw-item-time">${time}</span>
            </div>`;
        } else {
            const hash = item.hashShort || item.hash?.slice(0, 8) || '';
            const ref = item.hashFull || item.hash || '';
            const statsHtml = (item.additions || item.deletions) ? `
                <span class="cw-item-stats">
                    ${item.additions ? `<span class="added">+${item.additions}</span>` : ''}
                    ${item.deletions ? `<span class="removed">-${item.deletions}</span>` : ''}
                </span>` : '';

            html += `<div class="cw-item${focused}" data-ref="${escapeHtml(ref)}" data-idx="${i}">
                <span class="cw-item-hash">${escapeHtml(hash)}</span>
                <span class="cw-item-subject">${escapeHtml(item.subject || '')}</span>
                ${statsHtml}
                ${item.author ? `<span class="cw-item-author">${escapeHtml(item.author)}</span>` : ''}
                <span class="cw-item-time">${time}</span>
            </div>`;
        }
    });
    html += '</div>';
    return html;
}

function renderWorkingPicker(state) {
    const W = S.widgets.diff_viewer.wizard;
    return `
        <div class="cw-working-options">
            <button class="cw-working-btn" data-staged="false">
                ${ICONS.edit}
                <span>${W.working_tree}</span>
            </button>
            <button class="cw-working-btn" data-staged="true">
                ${ICONS.check}
                <span>${W.staged_changes}</span>
            </button>
        </div>`;
}

function renderFilePicker(state) {
    const W = S.widgets.diff_viewer.wizard;
    return `
        <input class="cw-file-search" type="text" placeholder="${W.search_placeholder}" autocomplete="off" spellcheck="false">
        <div class="cw-list">${renderFileListItems(state)}</div>`;
}

function renderFileListItems(state) {
    const query = state.wizardFileQuery.toLowerCase();
    const files = state.wizardPickerData;
    const filtered = query ? files.filter(f => f.toLowerCase().includes(query)) : files;
    const shown = filtered.slice(0, 200); // limit for performance

    if (!shown.length) return `<div class="cw-empty">${S.widgets.diff_viewer.wizard.no_git_history}</div>`;

    let html = '';
    shown.forEach((filePath, i) => {
        const name = basename(filePath);
        const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/') + 1) : '';
        const focused = i === state.wizardFocusIndex ? ' cw-focused' : '';
        html += `<div class="cw-file-item${focused}" data-path="${escapeHtml(filePath)}" data-idx="${i}">
            <span class="cw-file-item-icon">${ICONS.file}</span>
            <span class="cw-file-item-name">${escapeHtml(name)}</span>
            <span class="cw-file-item-dir">${escapeHtml(dir)}</span>
        </div>`;
    });
    return html;
}

// ── Wizard actions ──

async function wizardPickItem(state, sessionId, dataset) {
    const ref = dataset.ref;
    if (!ref) return;

    const cwd = state.wizardCwd || WidgetManager.currentCwd || '';
    const filePath = state.wizardFilePath;
    const relPath = filePath.startsWith(cwd + '/') ? filePath.slice(cwd.length + 1) : filePath;
    const step = state.wizardStep;

    // Show loading in the diff viewer
    state.wizardActive = false;
    state.loading = true;
    state.files = [];
    renderContent(sessionId);

    try {
        let refContent;
        if (step === 'shadow') {
            const resp = await fetch(`${CONFIG.API_BASE}/api/shadow/files/${encodeURIComponent(relPath)}/content?ref=${encodeURIComponent(ref)}&cwd=${encodeURIComponent(cwd)}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            refContent = data.content;
        } else if (step === 'git' || step === 'branch') {
            const resp = await fetch(`${CONFIG.API_BASE}/api/git/file-at-ref?file=${encodeURIComponent(relPath)}&ref=${encodeURIComponent(ref)}&cwd=${encodeURIComponent(cwd)}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            refContent = data.content;
        }

        if (refContent !== undefined) {
            const currentContent = state.wizardFileContent || '';
            const refLabel = step === 'branch' ? ref : ref.slice(0, 8);
            state.loading = false;
            state.files = [{
                path: relPath,
                oldContent: refContent,
                newContent: currentContent,
                oldLabel: refLabel,
                newLabel: 'Current',
                startLine: 1,
                additions: 0,
                deletions: 0
            }];
            state.source = 'wizard';
            state.viewMode = loadViewMode() || ((state.currentContainer?.offsetWidth >= 600) ? 'split' : 'unified');
            state.currentFileIndex = 0;
            state.currentHunkIndex = -1;
            renderContent(sessionId);
        }
    } catch (err) {
        console.error('[DiffViewer] Wizard pick error:', err);
        state.loading = false;
        state.error = err.message;
        renderContent(sessionId);
    }
}

async function wizardPickWorking(state, sessionId, staged) {
    const cwd = state.wizardCwd || WidgetManager.currentCwd || '';
    const filePath = state.wizardFilePath;
    const relPath = filePath.startsWith(cwd + '/') ? filePath.slice(cwd.length + 1) : filePath;

    state.wizardActive = false;
    state.loading = true;
    state.files = [];
    renderContent(sessionId);

    try {
        const resp = await fetch(`${CONFIG.API_BASE}/api/git/file-content?file=${encodeURIComponent(relPath)}&cwd=${encodeURIComponent(cwd)}&staged=${staged}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        state.loading = false;
        state.files = [{
            path: relPath,
            oldContent: data.old || '',
            newContent: data.new || '',
            oldLabel: data.oldLabel || 'HEAD',
            newLabel: data.newLabel || (staged ? 'Staged' : 'Working Tree'),
            startLine: 1,
            additions: 0,
            deletions: 0
        }];
        state.source = 'wizard';
        state.viewMode = loadViewMode() || ((state.currentContainer?.offsetWidth >= 600) ? 'split' : 'unified');
        state.currentFileIndex = 0;
        state.currentHunkIndex = -1;
        renderContent(sessionId);
    } catch (err) {
        console.error('[DiffViewer] Working changes error:', err);
        state.loading = false;
        state.error = err.message;
        renderContent(sessionId);
    }
}

async function wizardPickFile(state, sessionId, otherPath) {
    const cwd = state.wizardCwd || WidgetManager.currentCwd || '';

    state.wizardActive = false;
    state.loading = true;
    state.files = [];
    renderContent(sessionId);

    try {
        const fullOtherPath = otherPath.startsWith('/') ? otherPath : `${cwd}/${otherPath}`;
        const resp = await fetch(`${CONFIG.API_BASE}/api/file?path=${encodeURIComponent(fullOtherPath)}&cwd=${encodeURIComponent(cwd)}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        const currentContent = state.wizardFileContent || '';
        state.loading = false;
        state.files = [{
            path: state.wizardFilePath,
            oldContent: currentContent,
            newContent: data.content || '',
            oldLabel: basename(state.wizardFilePath),
            newLabel: basename(otherPath),
            startLine: 1,
            additions: 0,
            deletions: 0
        }];
        state.source = 'wizard';
        state.viewMode = loadViewMode() || ((state.currentContainer?.offsetWidth >= 600) ? 'split' : 'unified');
        state.currentFileIndex = 0;
        state.currentHunkIndex = -1;
        renderContent(sessionId);
    } catch (err) {
        console.error('[DiffViewer] File compare error:', err);
        state.loading = false;
        state.error = err.message;
        renderContent(sessionId);
    }
}

// ═══════════════════════════════════════════════════════════════
// Quick Compare (one-click presets, bypasses wizard)
// ═══════════════════════════════════════════════════════════════

function _relPath(filePath, cwd) {
    return filePath.startsWith(cwd + '/') ? filePath.slice(cwd.length + 1) : filePath;
}

async function _shadowContent(relPath, ref, cwd) {
    const url = `${CONFIG.API_BASE}/api/shadow/files/${encodeURIComponent(relPath)}/content?ref=${encodeURIComponent(ref)}&cwd=${encodeURIComponent(cwd)}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return (await resp.json()).content;
}

async function _gitContentAtRef(relPath, ref, cwd) {
    const url = `${CONFIG.API_BASE}/api/git/file-at-ref?file=${encodeURIComponent(relPath)}&ref=${encodeURIComponent(ref)}&cwd=${encodeURIComponent(cwd)}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return (await resp.json()).content;
}

async function _currentFileContent(filePath, cwd) {
    const url = `${CONFIG.API_BASE}/api/file?path=${encodeURIComponent(filePath)}&cwd=${encodeURIComponent(cwd)}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return (await resp.json()).content;
}

async function quickCompareGitHead(filePath, cwd) {
    cwd = cwd || WidgetManager.currentCwd || '';
    const relPath = _relPath(filePath, cwd);
    try {
        const resp = await fetch(`${CONFIG.API_BASE}/api/git/file-content?file=${encodeURIComponent(relPath)}&cwd=${encodeURIComponent(cwd)}`);
        if (!resp.ok) throw new Error('Git read failed');
        const data = await resp.json();
        DiffViewerWidget.openWithContent(filePath, data.old || '', data.new || '', {
            source: 'quick-compare',
            oldLabel: data.oldLabel || 'HEAD',
            newLabel: data.newLabel || 'Working Tree',
        });
    } catch (err) {
        console.error('[DiffViewer] quickCompareGitHead failed:', err);
        showToast(`${S.toast.compare_failed}: ${err.message}`);
    }
}

async function quickComparePreviousCommit(filePath, cwd) {
    cwd = cwd || WidgetManager.currentCwd || '';
    const relPath = _relPath(filePath, cwd);
    try {
        const [oldContent, newContent] = await Promise.all([
            _gitContentAtRef(relPath, 'HEAD~1', cwd),
            _gitContentAtRef(relPath, 'HEAD', cwd),
        ]);
        if (oldContent === null && newContent === null) {
            showToast(S.toast.compare_no_git_history);
            return;
        }
        DiffViewerWidget.openWithContent(filePath, oldContent || '', newContent || '', {
            source: 'quick-compare',
            oldLabel: 'HEAD~1',
            newLabel: 'HEAD',
        });
    } catch (err) {
        console.error('[DiffViewer] quickComparePreviousCommit failed:', err);
        showToast(`${S.toast.compare_failed}: ${err.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════
// History Bar (stepper + picker + pivots)
// ═══════════════════════════════════════════════════════════════

function _stateCwd(state) {
    return state.wizardCwd || WidgetManager.currentCwd || '';
}

async function loadHistoryForCurrentFile(state, sessionId) {
    if (!state.files.length) return;
    const file = state.files[state.currentFileIndex];
    if (!file?.path || file.path === 'untitled') return;

    const cwd = _stateCwd(state);
    const key = `${cwd}:${file.path}`;
    if (state.historyKey === key && state.historyCommits !== null) return;

    state.historyKey = key;
    state.historyLoading = true;
    state.historyCommits = null;

    const relPath = _relPath(file.path, cwd);
    try {
        const url = `${CONFIG.API_BASE}/api/shadow/files/${encodeURIComponent(relPath)}/history?cwd=${encodeURIComponent(cwd)}&limit=20`;
        const resp = await fetch(url);
        if (resp.ok) {
            const data = await resp.json();
            state.historyCommits = data.commits || [];
        } else {
            state.historyCommits = [];
        }
    } catch {
        state.historyCommits = [];
    }
    state.historyLoading = false;

    // Try to align historyIndex to current new-side label (a hash prefix match)
    state.historyIndex = findHistoryIndex(state, file);

    // Re-render bar only (cheaper than full content rerender)
    renderHistoryBar(state, sessionId);
}

function findHistoryIndex(state, file) {
    if (!state.historyCommits?.length) return -1;
    const label = (file.newLabel || '').trim();
    if (!label) return -1;
    // Match on hashShort prefix
    return state.historyCommits.findIndex(c =>
        c.hash && (label === c.hash || label.startsWith(c.hash) || c.hash.startsWith(label))
    );
}

function renderHistoryBar(state, sessionId) {
    const container = state.currentContainer;
    if (!container) return;
    const barEl = container.querySelector('.dv-history-bar');
    if (!barEl) return;

    barEl.innerHTML = buildHistoryBarHtml(state);
    wireHistoryBar(state, sessionId, barEl);
}

function buildHistoryBarHtml(state) {
    const HB = S.widgets.diff_viewer.history_bar;
    const commits = state.historyCommits;
    const i = state.historyIndex;

    const hasHistory = Array.isArray(commits) && commits.length > 0;
    const atIndex = hasHistory && i >= 0 && i < commits.length;

    const prevDisabled = !hasHistory || (i >= commits.length - 1);
    const nextDisabled = !hasHistory || i <= 0;

    let pickerLabel;
    let pickerSub = '';
    if (state.historyLoading) {
        pickerLabel = HB.picker_loading;
    } else if (!hasHistory) {
        pickerLabel = HB.picker_empty;
    } else if (atIndex) {
        const c = commits[i];
        pickerLabel = `${c.hash} · ${c.summary || c.subject || ''}`;
        pickerSub = `${c.additions ? '+' + c.additions : ''}${c.deletions ? ' -' + c.deletions : ''}${c.timestamp ? ' · ' + timeAgo(c.timestamp) : ''}`.trim();
    } else {
        pickerLabel = HB.picker_no_match;
    }

    const dis = (d) => d ? ' dv-disabled' : '';
    return `
        <div class="dv-stepper">
            <button class="dv-step-btn${dis(prevDisabled)}" data-action="step-prev" data-tooltip="${HB.step_prev}" ${prevDisabled ? 'disabled' : ''}>${ICONS.back}</button>
            <button class="dv-picker" data-action="picker">
                <span class="dv-picker-label">${escapeHtml(pickerLabel)}</span>
                ${pickerSub ? `<span class="dv-picker-sub">${escapeHtml(pickerSub)}</span>` : ''}
                <span class="dv-picker-caret">${ICONS.down}</span>
            </button>
            <button class="dv-step-btn${dis(nextDisabled)}" data-action="step-next" data-tooltip="${HB.step_next}" ${nextDisabled ? 'disabled' : ''}>${ICONS.forward}</button>
        </div>
        <div class="dv-divider"></div>
        <div class="dv-pivots">
            <button class="dv-pivot" data-action="pivot-head" data-tooltip="${HB.pivot_head_tooltip}">${HB.pivot_head}</button>
            <button class="dv-pivot" data-action="pivot-working" data-tooltip="${HB.pivot_working_tooltip}">${HB.pivot_working}</button>
            <button class="dv-pivot" data-action="pivot-pick" data-tooltip="${HB.pivot_pick_tooltip}">${HB.pivot_pick}</button>
        </div>`;
}

function wireHistoryBar(state, sessionId, barEl) {
    barEl.querySelector('[data-action="step-prev"]')?.addEventListener('click', (e) => {
        if (e.currentTarget.disabled) return;
        stepHistory(state, sessionId, +1);
    });
    barEl.querySelector('[data-action="step-next"]')?.addEventListener('click', (e) => {
        if (e.currentTarget.disabled) return;
        stepHistory(state, sessionId, -1);
    });
    barEl.querySelector('[data-action="picker"]')?.addEventListener('click', (e) => {
        showHistoryPicker(state, sessionId, e.currentTarget);
    });
    barEl.querySelector('[data-action="pivot-head"]')?.addEventListener('click', () => {
        pivotVsHead(state);
    });
    barEl.querySelector('[data-action="pivot-working"]')?.addEventListener('click', () => {
        pivotVsWorking(state);
    });
    barEl.querySelector('[data-action="pivot-pick"]')?.addEventListener('click', () => {
        pivotPick(state);
    });
}

function stepHistory(state, sessionId, delta) {
    if (!state.historyCommits?.length) return;
    let target = state.historyIndex;
    if (target < 0) {
        // Not aligned yet — first step jumps to newest (index 0) when going newer,
        // or to oldest visible window (index 0) when going older. Default to newest.
        target = delta > 0 ? 0 : 0;
    } else {
        target = target + delta;
    }
    if (target < 0 || target >= state.historyCommits.length) return;
    state.historyIndex = target;
    loadDiffAtHistoryIndex(state, sessionId);
}

function showHistoryPicker(state, sessionId, anchor) {
    if (!state.historyCommits?.length) return;
    const HB = S.widgets.diff_viewer.history_bar;
    const rect = anchor.getBoundingClientRect();

    const items = [];
    let lastSession = null;
    state.historyCommits.forEach((c, i) => {
        if (lastSession !== null && c.sessionId && c.sessionId !== lastSession) {
            items.push({ type: 'separator' });
        }
        if (c.sessionId) lastSession = c.sessionId;

        const stats = `${c.additions ? '+' + c.additions : ''}${c.deletions ? ' -' + c.deletions : ''}`.trim();
        const time = c.timestamp ? timeAgo(c.timestamp) : '';
        const sub = [stats, time].filter(Boolean).join(' · ');

        items.push({
            label: `${c.hash} · ${(c.summary || c.subject || '').slice(0, 80)}`,
            sublabel: sub,
            action: () => {
                state.historyIndex = i;
                loadDiffAtHistoryIndex(state, sessionId);
            }
        });
    });

    const menu = window.app?.contextMenu || (window._dvCtxMenu ||= new ContextMenu());
    menu.show(rect.left, rect.bottom + 4, items);
}

async function loadDiffAtHistoryIndex(state, sessionId) {
    const commits = state.historyCommits;
    const i = state.historyIndex;
    if (!commits || i < 0 || i >= commits.length) return;

    const file = state.files[state.currentFileIndex];
    if (!file) return;

    const cwd = _stateCwd(state);
    const relPath = _relPath(file.path, cwd);
    const newCommit = commits[i];
    const oldCommit = commits[i + 1]; // next-older on the linear file history

    state.loading = true;
    renderContent(sessionId);

    try {
        const newContent = await _shadowContent(relPath, newCommit.hashFull, cwd);
        const oldContent = oldCommit
            ? await _shadowContent(relPath, oldCommit.hashFull, cwd)
            : await _shadowContent(relPath, newCommit.hashFull + '~1', cwd);

        const HB = S.widgets.diff_viewer.history_bar;
        state.loading = false;
        state.files = [{
            path: file.path,
            oldContent: oldContent || '',
            newContent: newContent || '',
            oldLabel: oldCommit ? oldCommit.hash : HB.picker_initial,
            newLabel: newCommit.hash,
            startLine: 1,
            additions: 0,
            deletions: 0
        }];
        state.source = 'history-bar';
        state.currentFileIndex = 0;
        state.currentHunkIndex = -1;
        renderContent(sessionId);
    } catch (err) {
        console.error('[DiffViewer] loadDiffAtHistoryIndex failed:', err);
        state.loading = false;
        state.error = err.message;
        renderContent(sessionId);
    }
}

async function pivotVsHead(state) {
    const file = state.files[state.currentFileIndex];
    if (!file?.path) return;
    await quickCompareGitHead(file.path, _stateCwd(state));
}

async function pivotVsWorking(state) {
    const file = state.files[state.currentFileIndex];
    if (!file?.path) return;
    const cwd = _stateCwd(state);
    try {
        const workingContent = await _currentFileContent(file.path, cwd);
        if (workingContent === null) {
            showToast(S.toast.compare_failed);
            return;
        }
        DiffViewerWidget.openWithContent(file.path, file.newContent || '', workingContent, {
            source: 'history-bar',
            oldLabel: file.newLabel || S.widgets.diff_viewer.before,
            newLabel: 'Working Tree'
        });
    } catch (err) {
        console.error('[DiffViewer] pivotVsWorking failed:', err);
        showToast(`${S.toast.compare_failed}: ${err.message}`);
    }
}

function pivotPick(state) {
    const file = state.files[state.currentFileIndex];
    if (!file?.path) return;
    DiffViewerWidget.openCompareWizard(file.path, _stateCwd(state));
}

function shouldShowHistoryBar(state) {
    if (state.wizardActive) return false;
    if (state.loading || state.error) return false;
    if (state.files.length !== 1) return false;
    const f = state.files[0];
    if (!f?.path || f.path === 'untitled') return false;
    return true;
}

// ═══════════════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════════════

function renderContent(sessionId) {
    const state = getState(sessionId);
    const container = state.currentContainer;
    if (!container) return;

    // Wizard mode takes priority
    if (state.wizardActive) {
        renderWizard(sessionId);
        return;
    }

    if (state.loading) {
        container.innerHTML = `<div class="diff-viewer-loading">${S.widgets.diff_viewer.loading}</div>`;
        return;
    }

    if (state.error) {
        container.innerHTML = `<div class="diff-viewer-empty">${escapeHtml(state.error)}</div>`;
        return;
    }

    if (!state.files.length) {
        container.innerHTML = `<div class="diff-viewer-empty">${S.widgets.diff_viewer.no_files}</div>`;
        return;
    }

    const multiFile = state.files.length > 1;
    const file = state.files[state.currentFileIndex];

    // Determine view mode: force unified if container is narrow
    const effectiveMode = (container.offsetWidth < 600) ? 'unified' : state.viewMode;

    // Build diff entries
    const oldLines = (file.oldContent || '').split('\n');
    const newLines = (file.newContent || '').split('\n');
    const startLine = file.startLine || 1;

    const diffEntries = generateSmartDiff(oldLines, newLines, startLine, escapeHtml, {
        contextLines: 3,
        collapseThreshold: 6
    });

    // Calculate stats from entries if not provided
    if (!file.additions && !file.deletions) {
        file.additions = diffEntries.filter(e => e.type === 'added' || e.type === 'modified').length;
        file.deletions = diffEntries.filter(e => e.type === 'removed' || e.type === 'modified').length;
    }

    // Render diff HTML
    const diffHtml = effectiveMode === 'split'
        ? renderSideBySideDiff(diffEntries, {
            collapseLabel: (count) => S.widgets.diff_viewer.unchanged_lines.replace('{count}', count)
          })
        : `<div class="changes-diff">${renderSmartDiff(diffEntries)}</div>`;

    // Build column header for split mode
    const headerHtml = effectiveMode === 'split' ? `
        <div class="sbs-header">
            <div class="sbs-header-label left">${escapeHtml(file.oldLabel || S.widgets.diff_viewer.before)}</div>
            <div class="sbs-header-gutter"></div>
            <div class="sbs-header-label right">${escapeHtml(file.newLabel || S.widgets.diff_viewer.after)}</div>
        </div>
    ` : '';

    // Multi-file: sidebar + tab bar
    let fileListHtml = '';
    let fileTabsHtml = '';
    if (multiFile) {
        fileListHtml = '<div class="diff-viewer-file-list">';
        fileTabsHtml = '<div class="diff-viewer-file-tabs">';
        state.files.forEach((f, i) => {
            const name = basename(f.path);
            const active = i === state.currentFileIndex ? ' active' : '';
            const add = f.additions || 0;
            const del = f.deletions || 0;
            const stats = `${add ? `<span class="added">+${add}</span>` : ''}${del ? `<span class="removed">-${del}</span>` : ''}`;

            fileListHtml += `<div class="diff-viewer-file-item${active}" data-file-idx="${i}">
                <span class="diff-viewer-file-name">${escapeHtml(name)}</span>
                <span class="diff-viewer-file-stats">${stats}</span>
            </div>`;

            fileTabsHtml += `<div class="diff-viewer-file-tab${active}" data-file-idx="${i}">${escapeHtml(name)}</div>`;
        });
        fileListHtml += '</div>';
        fileTabsHtml += '</div>';
    }

    const showBar = shouldShowHistoryBar(state);
    if (showBar) {
        const expectedKey = `${_stateCwd(state)}:${file.path}`;
        if (state.historyKey !== expectedKey) {
            state.historyCommits = null;
            state.historyLoading = false;
            state.historyIndex = -1;
        }
    }
    const barHtml = showBar ? `<div class="dv-history-bar">${buildHistoryBarHtml(state)}</div>` : '';

    const wrapClass = state.wrapLines ? ' wrap-lines' : '';
    container.innerHTML = `
        ${barHtml}
        ${multiFile ? fileTabsHtml : ''}
        <div class="diff-viewer-layout">
            ${multiFile ? fileListHtml : ''}
            <div class="diff-viewer-content${wrapClass}">
                ${headerHtml}
                ${diffHtml}
            </div>
        </div>
    `;

    if (showBar) {
        const barEl = container.querySelector('.dv-history-bar');
        if (barEl) wireHistoryBar(state, sessionId, barEl);
        // Trigger async load if needed; result re-renders the bar in place
        if (state.historyCommits === null && !state.historyLoading) {
            loadHistoryForCurrentFile(state, sessionId);
        } else {
            // Re-align historyIndex if labels changed (e.g. after a pivot)
            const newIdx = findHistoryIndex(state, file);
            if (newIdx !== state.historyIndex) {
                state.historyIndex = newIdx;
                renderHistoryBar(state, sessionId);
            }
        }
    }

    // Wire up file navigation clicks
    container.querySelectorAll('[data-file-idx]').forEach(el => {
        el.addEventListener('click', () => {
            state.currentFileIndex = parseInt(el.dataset.fileIdx, 10);
            state.currentHunkIndex = -1;
            renderContent(sessionId);
        });
    });

    // Wire up collapse expand
    container.querySelectorAll('.sbs-collapse, .diff-collapse').forEach(el => {
        el.addEventListener('click', () => {
            // Re-render with higher context to show collapsed lines
            // For simplicity, remove collapse and show all context
            el.style.display = 'none';
        });
    });

    // Cache hunk elements for keyboard navigation
    state.hunkElements = Array.from(container.querySelectorAll('[data-hunk]'));
    state.currentHunkIndex = -1;

    // Update widget header summary
    const widget = WidgetManager.get('diff-viewer');
    if (widget) {
        const totalFiles = state.files.length;
        const fileLabel = totalFiles > 1 ? `${state.currentFileIndex + 1}/${totalFiles}` : basename(file.path);
        const modeLabel = effectiveMode === 'split' ? S.widgets.diff_viewer.split_view : S.widgets.diff_viewer.unified_view;
        widget.setSummary?.(`${fileLabel} · ${modeLabel}`);
    }

    // Focus for keyboard nav
    container.tabIndex = -1;
    container.focus();
}

// ═══════════════════════════════════════════════════════════════
// Keyboard navigation
// ═══════════════════════════════════════════════════════════════

function handleKeyDown(e, sessionId) {
    const state = getState(sessionId);

    // Wizard keyboard nav
    if (state.wizardActive) {
        handleWizardKeyDown(e, state, sessionId);
        return;
    }

    if (!state.files.length) return;

    switch (e.key) {
        case 'j':
        case 'n':
            e.preventDefault();
            navigateHunk(1, state);
            break;
        case 'k':
        case 'p':
            e.preventDefault();
            navigateHunk(-1, state);
            break;
        case ']':
            e.preventDefault();
            navigateFile(1, state, sessionId);
            break;
        case '[':
            e.preventDefault();
            navigateFile(-1, state, sessionId);
            break;
        case 'u':
            e.preventDefault();
            toggleViewMode(state, sessionId);
            break;
        case 'Escape':
            e.preventDefault();
            WidgetManager.close('diff-viewer');
            break;
    }
}

function handleWizardKeyDown(e, state, sessionId) {
    if (state.wizardStep === 'source') {
        // Source picker: arrow keys, Enter, number keys, Escape
        const totalCards = WIZARD_SOURCES.length;
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                state.wizardFocusIndex = Math.min(state.wizardFocusIndex + 2, totalCards - 1);
                renderWizard(sessionId);
                break;
            case 'ArrowUp':
                e.preventDefault();
                state.wizardFocusIndex = Math.max(state.wizardFocusIndex - 2, 0);
                renderWizard(sessionId);
                break;
            case 'ArrowRight':
                e.preventDefault();
                if (state.wizardFocusIndex < totalCards - 1) state.wizardFocusIndex++;
                renderWizard(sessionId);
                break;
            case 'ArrowLeft':
                e.preventDefault();
                if (state.wizardFocusIndex > 0) state.wizardFocusIndex--;
                renderWizard(sessionId);
                break;
            case 'Enter':
                e.preventDefault();
                if (state.wizardFocusIndex >= 0 && state.wizardFocusIndex < totalCards) {
                    wizardSelectSource(state, WIZARD_SOURCES[state.wizardFocusIndex].id, sessionId);
                }
                break;
            case '1': case '2': case '3': case '4': case '5': {
                e.preventDefault();
                const idx = parseInt(e.key) - 1;
                if (idx < totalCards) wizardSelectSource(state, WIZARD_SOURCES[idx].id, sessionId);
                break;
            }
            case 'Escape':
                e.preventDefault();
                WidgetManager.close('diff-viewer');
                break;
        }
    } else {
        // Picker: up/down to navigate, Enter to select, Backspace/Escape to go back
        // Skip keyboard list nav if file search input is focused
        const isSearchFocused = state.currentContainer?.querySelector('.cw-file-search') === document.activeElement;

        switch (e.key) {
            case 'ArrowDown':
                if (isSearchFocused) return; // let input handle cursor
                e.preventDefault();
                state.wizardFocusIndex = Math.min(state.wizardFocusIndex + 1, state.wizardPickerData.length - 1);
                updateFocusHighlight(state);
                break;
            case 'ArrowUp':
                if (isSearchFocused) return;
                e.preventDefault();
                state.wizardFocusIndex = Math.max(state.wizardFocusIndex - 1, 0);
                updateFocusHighlight(state);
                break;
            case 'Enter':
                e.preventDefault();
                if (state.wizardStep === 'file' && state.wizardFocusIndex >= 0) {
                    const items = state.currentContainer?.querySelectorAll('.cw-file-item');
                    const item = items?.[state.wizardFocusIndex];
                    if (item) wizardPickFile(state, sessionId, item.dataset.path);
                } else if (state.wizardFocusIndex >= 0) {
                    const items = state.currentContainer?.querySelectorAll('.cw-item');
                    const item = items?.[state.wizardFocusIndex];
                    if (item) wizardPickItem(state, sessionId, item.dataset);
                }
                break;
            case 'Backspace':
                if (isSearchFocused && state.wizardFileQuery) return; // let input handle delete
                e.preventDefault();
                state.wizardStep = 'source';
                state.wizardFocusIndex = -1;
                renderWizard(sessionId);
                break;
            case 'Escape':
                e.preventDefault();
                state.wizardStep = 'source';
                state.wizardFocusIndex = -1;
                renderWizard(sessionId);
                break;
        }
    }
}

function updateFocusHighlight(state) {
    const container = state.currentContainer;
    if (!container) return;
    container.querySelectorAll('.cw-focused').forEach(el => el.classList.remove('cw-focused'));
    const items = container.querySelectorAll('.cw-item, .cw-file-item');
    if (state.wizardFocusIndex >= 0 && state.wizardFocusIndex < items.length) {
        items[state.wizardFocusIndex].classList.add('cw-focused');
        items[state.wizardFocusIndex].scrollIntoView({ block: 'nearest' });
    }
}

function navigateHunk(direction, state) {
    if (!state.hunkElements.length) return;

    // Find unique hunk indices
    const hunkIds = [...new Set(state.hunkElements.map(el => el.dataset.hunk))];
    if (!hunkIds.length) return;

    // Move to next/prev hunk
    state.currentHunkIndex += direction;
    if (state.currentHunkIndex < 0) state.currentHunkIndex = 0;
    if (state.currentHunkIndex >= hunkIds.length) state.currentHunkIndex = hunkIds.length - 1;

    const targetHunkId = hunkIds[state.currentHunkIndex];
    const targetEl = state.hunkElements.find(el => el.dataset.hunk === targetHunkId);
    if (targetEl) {
        // Clear old highlight
        state.currentContainer?.querySelectorAll('.sbs-hunk-active').forEach(el => el.classList.remove('sbs-hunk-active'));

        // Highlight all elements in this hunk
        state.hunkElements
            .filter(el => el.dataset.hunk === targetHunkId)
            .forEach(el => el.classList.add('sbs-hunk-active'));

        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function navigateFile(direction, state, sessionId) {
    if (state.files.length <= 1) return;
    const newIdx = state.currentFileIndex + direction;
    if (newIdx < 0 || newIdx >= state.files.length) return;
    state.currentFileIndex = newIdx;
    state.currentHunkIndex = -1;
    renderContent(sessionId);
}

function toggleViewMode(state, sessionId) {
    state.viewMode = state.viewMode === 'split' ? 'unified' : 'split';
    saveViewMode(state.viewMode);
    renderContent(sessionId);
}

function toggleWrapLines(state, btn) {
    state.wrapLines = !state.wrapLines;
    saveWrapLines(state.wrapLines);
    const content = state.currentContainer?.querySelector('.diff-viewer-content');
    if (content) content.classList.toggle('wrap-lines', state.wrapLines);
    btn?.classList.toggle('is-active', state.wrapLines);
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function basename(path) {
    return path ? path.split('/').pop() : '';
}

function timeAgo(timestamp) {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;
    if (diff < 60) return '<1m';
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
    return `${Math.floor(diff / 604800)}w`;
}

// ═══════════════════════════════════════════════════════════════
// Widget registration
// ═══════════════════════════════════════════════════════════════

export function registerDiffViewerWidget() {
    WidgetManager.register('diff-viewer', {
        type: 'floating',
        title: S.widgets.titles.diff_viewer,
        icon: 'columns',
        scope: 'session',
        hiddenInPicker: true,

        deviceTypes: {
            default: 'floating',
            phone: 'bottom-sheet',
            tablet: 'floating',
            desktop: 'floating'
        },

        allowedTypes: ['floating', 'bottom-sheet', 'tab'],

        heights: { half: '55vh', full: '90vh' },

        headerActions: [
            {
                icon: 'wrapText',
                title: S.widgets.diff_viewer.toggle_wrap,
                onClick: (e) => {
                    const state = getState(WidgetManager.currentSessionId);
                    toggleWrapLines(state, e.currentTarget);
                }
            },
            {
                icon: 'columns',
                title: S.widgets.diff_viewer.toggle_view,
                onClick: () => {
                    const sessionId = WidgetManager.currentSessionId;
                    const state = getState(sessionId);
                    toggleViewMode(state, sessionId);
                }
            }
        ],

        render: (container, ctx) => {
            const sessionId = ctx.sessionId || WidgetManager.currentSessionId;
            const state = getState(sessionId);
            state.currentContainer = container;

            // Wizard mode: open from openCompareWizard()
            if (ctx.wizardMode) {
                state.wizardActive = true;
                state.wizardStep = 'source';
                state.wizardFilePath = ctx.wizardFilePath;
                state.wizardFileContent = ctx.wizardFileContent;
                state.wizardCwd = ctx.wizardCwd;
                state.wizardFocusIndex = -1;
                state.wizardPickerData = [];
                state.wizardFileQuery = '';
                state.wizardAllFiles = null;
                state.files = [];
                state.loading = false;
                state.error = null;
            }

            // Normal mode: files passed directly
            if (ctx.files) {
                state.wizardActive = false;
                state.files = ctx.files;
                state.source = ctx.source || 'unknown';
                state.currentFileIndex = ctx.fileIndex || 0;
                state.viewMode = loadViewMode() || ((container.offsetWidth >= 600) ? 'split' : 'unified');
                state.currentHunkIndex = -1;
            }

            renderContent(sessionId);

            // Mark the wrap toggle as active if wrap mode is on.
            const wrapBtn = container.closest('.widget')
                ?.querySelector(`.widget-actions [data-tooltip="${S.widgets.diff_viewer.toggle_wrap}"]`);
            if (wrapBtn && state.wrapLines) wrapBtn.classList.add('is-active');

            // Keyboard handler
            container.onkeydown = (e) => handleKeyDown(e, sessionId);
        },

        onDestroy: (sessionId) => {
            destroyState(sessionId);
        }
    });
}

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

export const DiffViewerWidget = {
    /**
     * Open with explicit old/new content (Edit tool blocks, Changes widget)
     */
    openWithContent(filePath, oldContent, newContent, options = {}) {
        const file = {
            path: filePath || 'untitled',
            oldContent: oldContent || '',
            newContent: newContent || '',
            oldLabel: options.oldLabel || S.widgets.diff_viewer.before,
            newLabel: options.newLabel || S.widgets.diff_viewer.after,
            startLine: options.startLine || 1,
            additions: 0,
            deletions: 0
        };
        WidgetManager.open('diff-viewer', {
            files: [file],
            source: options.source || 'edit-tool',
            fileIndex: 0
        });
    },

    /**
     * Open with multiple files (multi-file git diff)
     */
    openWithFiles(files, options = {}) {
        WidgetManager.open('diff-viewer', {
            files,
            source: options.source || 'diff',
            fileIndex: options.fileIndex || 0,
        });
    },

    /**
     * Open the compare wizard for a file
     */
    async openCompareWizard(filePath, cwd) {
        cwd = cwd || WidgetManager.currentCwd || '';
        // Load the file's current content
        let content = '';
        try {
            const resp = await fetch(`${CONFIG.API_BASE}/api/file?path=${encodeURIComponent(filePath)}&cwd=${encodeURIComponent(cwd)}`);
            if (resp.ok) {
                const data = await resp.json();
                content = data.content || '';
            }
        } catch (err) {
            console.error('[DiffViewer] Failed to load file for wizard:', err);
        }

        WidgetManager.open('diff-viewer', {
            wizardMode: true,
            wizardFilePath: filePath,
            wizardFileContent: content,
            wizardCwd: cwd
        });
    },

    // Edit data cache for tool-renderer onclick
    cacheEditData,
    openFromCache,

    // Quick compare presets (bypass wizard)
    quickCompareGitHead,
    quickComparePreviousCommit,

    // State access
    getState,
    destroyState
};
