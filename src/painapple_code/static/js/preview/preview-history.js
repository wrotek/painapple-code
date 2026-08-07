/**
 * Preview history view (shadow-git diff browser)
 *
 * Two cursors — From (older) and To (newer) — with a stepper that moves To.
 * From auto-tracks "one before To" unless the user explicitly sets it; the
 * stepper still works in either mode (in auto, From follows; otherwise From
 * stays put while To scrubs).
 *
 * State lives on PreviewState — no shared state with the diff-viewer widget.
 */

import { state, fns, resetHistory } from './preview-state.js';
import { escapeHtml } from '../utils.js';
import { CONFIG } from '../config.js';
import { WidgetManager, ICONS } from '../widget-system/index.js';
import { generateSmartDiff, renderSmartDiff, renderSideBySideDiff } from '../diff-utils.js';
import { ContextMenu, showToast } from '../context-menu.js';
import { DiffViewerWidget } from '../widgets/diff-viewer-widget.js';
import S from '../strings.js';

const PREF_KEY_VIEW_MODE = 'preview-history-view-mode';

function loadDiffViewMode() {
    try {
        const v = localStorage.getItem(PREF_KEY_VIEW_MODE);
        return v === 'unified' || v === 'split' ? v : null;
    } catch { return null; }
}
function saveDiffViewMode(v) {
    try { localStorage.setItem(PREF_KEY_VIEW_MODE, v); } catch {}
}

function getCwd() {
    return state.cwd || WidgetManager.currentCwd || '';
}

function relPath(filePath, cwd) {
    if (!filePath) return '';
    return filePath.startsWith(cwd + '/') ? filePath.slice(cwd.length + 1) : filePath;
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

async function fetchShadowContent(rel, ref, cwd) {
    const url = `${CONFIG.API_BASE}/api/shadow/files/${encodeURIComponent(rel)}/content?ref=${encodeURIComponent(ref)}&cwd=${encodeURIComponent(cwd)}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return (await resp.json()).content;
}

async function fetchCurrentContent(filePath, cwd) {
    const url = `${CONFIG.API_BASE}/api/file?path=${encodeURIComponent(filePath)}&cwd=${encodeURIComponent(cwd)}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return (await resp.json()).content;
}

async function fetchGitContentAtRef(rel, ref, cwd) {
    const url = `${CONFIG.API_BASE}/api/git/file-at-ref?file=${encodeURIComponent(rel)}&ref=${encodeURIComponent(ref)}&cwd=${encodeURIComponent(cwd)}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return (await resp.json()).content;
}

/**
 * Resolve current From/To selections to concrete refs with content-fetching info.
 */
function resolveFromTo() {
    const commits = state.historyCommits;
    if (!commits) return null;

    // To
    let to;
    if (state.historyToKind === 'head') {
        to = { kind: 'head' };
    } else if (state.historyToKind === 'working') {
        to = { kind: 'working' };
    } else {
        if (commits.length === 0) return null;
        const idx = Math.min(Math.max(state.historyToIndex, 0), commits.length - 1);
        to = { kind: 'snapshot', index: idx, commit: commits[idx] };
    }

    // From
    let from;
    if (state.historyFromKind === 'auto') {
        if (to.kind === 'snapshot') {
            const next = to.index + 1;
            from = next < commits.length
                ? { kind: 'snapshot', index: next, commit: commits[next], auto: true }
                : { kind: 'initial', auto: true };
        } else {
            // To = HEAD or Working — auto-baseline is the newest snapshot.
            from = commits.length > 0
                ? { kind: 'snapshot', index: 0, commit: commits[0], auto: true }
                : { kind: 'initial', auto: true };
        }
    } else if (state.historyFromKind === 'initial') {
        from = { kind: 'initial' };
    } else {
        const i = state.historyFromIndex;
        from = (i >= 0 && i < commits.length)
            ? { kind: 'snapshot', index: i, commit: commits[i] }
            : { kind: 'initial' };
    }

    return { from, to };
}

async function fetchRef(ref, rel, cwd) {
    if (ref.kind === 'snapshot') {
        return await fetchShadowContent(rel, ref.commit.hashFull, cwd);
    }
    if (ref.kind === 'initial') {
        const commits = state.historyCommits;
        if (!commits.length) return '';
        const oldest = commits[commits.length - 1];
        return await fetchShadowContent(rel, oldest.hashFull + '~1', cwd) ?? '';
    }
    if (ref.kind === 'head') {
        return await fetchGitContentAtRef(rel, 'HEAD', cwd) ?? '';
    }
    if (ref.kind === 'working') {
        return await fetchCurrentContent(state.currentPath, cwd);
    }
    return '';
}

function shortLabelForRef(ref) {
    const HB = S.widgets.diff_viewer.history_bar;
    if (ref.kind === 'snapshot') return ref.commit.hash;
    if (ref.kind === 'initial') return HB.picker_initial;
    if (ref.kind === 'head') return 'HEAD';
    if (ref.kind === 'working') return 'Working';
    return '';
}

function pickerLabelForRef(ref) {
    if (ref.kind === 'snapshot') {
        const c = ref.commit;
        const subject = c.summary || c.subject || '';
        return subject ? `${c.hash} · ${subject}` : c.hash;
    }
    return shortLabelForRef(ref);
}

/**
 * Load shadow history for the current file (caches by cwd:path key).
 */
export async function loadHistory() {
    if (!state.currentPath) return;
    const cwd = getCwd();
    const key = `${cwd}:${state.currentPath}`;
    if (state.historyKey === key && state.historyCommits !== null) {
        // Already loaded; if a fresh seed arrived since, apply it and reload.
        if (state.historyPendingSeed && state.historyCommits.length > 0) {
            applyPendingSeed();
            await loadDiff();
        }
        return;
    }

    state.historyKey = key;
    state.historyLoading = true;
    state.historyCommits = null;

    const rel = relPath(state.currentPath, cwd);
    try {
        const url = `${CONFIG.API_BASE}/api/shadow/files/${encodeURIComponent(rel)}/history?cwd=${encodeURIComponent(cwd)}&limit=20`;
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

    if (state.historyCommits.length > 0) {
        if (state.historyPendingSeed) {
            applyPendingSeed();
        } else {
            // Default selection: To = newest snapshot, From = auto (one before).
            state.historyToKind = 'snapshot';
            state.historyToIndex = 0;
            state.historyFromKind = 'auto';
        }
        await loadDiff();
    } else {
        fns.rerenderContent();
    }
}

/**
 * Resolve a hash (full or short) to an index in state.historyCommits.
 */
function findCommitIndex(hash) {
    if (!hash) return -1;
    const commits = state.historyCommits;
    if (!commits?.length) return -1;
    return commits.findIndex(c =>
        c.hashFull === hash ||
        c.hash === hash ||
        c.hashFull?.startsWith(hash) ||
        (hash.length >= 7 && hash.startsWith(c.hashFull))
    );
}

/**
 * Apply state.historyPendingSeed to the From/To cursors. Falls back to
 * defaults silently if a hash can't be resolved.
 */
function applyPendingSeed() {
    const seed = state.historyPendingSeed;
    if (!seed) return;
    state.historyPendingSeed = null;

    if (seed.toKind === 'head' || seed.toKind === 'working') {
        state.historyToKind = seed.toKind;
    } else if (seed.toKind === 'snapshot' && seed.toHash) {
        const idx = findCommitIndex(seed.toHash);
        state.historyToKind = 'snapshot';
        state.historyToIndex = idx >= 0 ? idx : 0;
    } else {
        state.historyToKind = 'snapshot';
        state.historyToIndex = 0;
    }

    if (seed.fromKind === 'auto' || seed.fromKind === 'initial') {
        state.historyFromKind = seed.fromKind;
    } else if (seed.fromKind === 'snapshot' && seed.fromHash) {
        const idx = findCommitIndex(seed.fromHash);
        if (idx >= 0) {
            state.historyFromKind = 'snapshot';
            state.historyFromIndex = idx;
        } else {
            state.historyFromKind = 'auto';
        }
    } else {
        state.historyFromKind = 'auto';
    }
}

/**
 * Fetch From and To content per current selections, render the resulting diff.
 */
export async function loadDiff() {
    const resolved = resolveFromTo();
    if (!resolved) return;

    const cwd = getCwd();
    const rel = relPath(state.currentPath, cwd);

    state.historyLoading = true;
    fns.rerenderContent();

    try {
        const [oldContent, newContent] = await Promise.all([
            fetchRef(resolved.from, rel, cwd),
            fetchRef(resolved.to, rel, cwd),
        ]);
        state.historyOldContent = oldContent || '';
        state.historyNewContent = newContent || '';
        state.historyOldLabel = shortLabelForRef(resolved.from);
        state.historyNewLabel = shortLabelForRef(resolved.to);
    } catch (err) {
        console.error('[PreviewHistory] loadDiff failed:', err);
        state.historyOldContent = '';
        state.historyNewContent = '';
        showToast(`${S.toast.compare_failed}: ${err.message}`);
    }
    state.historyLoading = false;
    fns.rerenderContent();
}

function effectiveDiffMode() {
    if (state.historyDiffMode) return state.historyDiffMode;
    const saved = loadDiffViewMode();
    if (saved) return saved;
    const w = state.container?.offsetWidth || 0;
    return w >= 600 ? 'split' : 'unified';
}

function buildHistoryBarHtml() {
    const HB = S.widgets.diff_viewer.history_bar;
    const commits = state.historyCommits;
    const hasHistory = Array.isArray(commits) && commits.length > 0;
    const resolved = hasHistory ? resolveFromTo() : null;

    // Stepper disabled state — operates on the To cursor.
    let prevDisabled = !hasHistory;
    let nextDisabled = !hasHistory;
    if (hasHistory) {
        if (state.historyToKind === 'snapshot') {
            prevDisabled = state.historyToIndex >= commits.length - 1;
            nextDisabled = state.historyToIndex <= 0;
        } else {
            // To is HEAD/Working: < jumps to newest snapshot; > is no-op.
            prevDisabled = false;
            nextDisabled = true;
        }
    }

    const fromLabel = resolved ? pickerLabelForRef(resolved.from) : (state.historyLoading ? HB.picker_loading : HB.picker_empty);
    const toLabel = resolved ? pickerLabelForRef(resolved.to) : (state.historyLoading ? HB.picker_loading : HB.picker_empty);
    const fromAuto = resolved?.from?.auto ? ' dv-picker-auto' : '';

    const dis = (d) => d ? ' dv-disabled' : '';
    return `
        <div class="dv-stepper">
            <button class="dv-step-btn${dis(prevDisabled)}" data-action="ph-step-prev" data-tooltip="${HB.step_prev}" ${prevDisabled ? 'disabled' : ''}>${ICONS.back}</button>
            <button class="dv-picker dv-picker-from${fromAuto}" data-action="ph-picker-from" data-tooltip="${HB.from_tooltip}">
                <span class="dv-picker-prefix">${HB.from_prefix}</span>
                <span class="dv-picker-label">${escapeHtml(fromLabel)}</span>
                <span class="dv-picker-caret">${ICONS.down}</span>
            </button>
            <span class="dv-arrow">→</span>
            <button class="dv-picker dv-picker-to" data-action="ph-picker-to" data-tooltip="${HB.to_tooltip}">
                <span class="dv-picker-prefix">${HB.to_prefix}</span>
                <span class="dv-picker-label">${escapeHtml(toLabel)}</span>
                <span class="dv-picker-caret">${ICONS.down}</span>
            </button>
            <button class="dv-step-btn${dis(nextDisabled)}" data-action="ph-step-next" data-tooltip="${HB.step_next}" ${nextDisabled ? 'disabled' : ''}>${ICONS.forward}</button>
        </div>
        <div class="dv-divider"></div>
        <button class="dv-pivot" data-action="ph-pick" data-tooltip="${HB.pivot_pick_tooltip}">${HB.pivot_pick}</button>
        <div class="dv-divider"></div>
        <button class="dv-pivot ph-mode-toggle" data-action="ph-toggle-mode" data-tooltip="${S.widgets.diff_viewer.toggle_view}">
            ${effectiveDiffMode() === 'split' ? S.widgets.diff_viewer.unified_view : S.widgets.diff_viewer.split_view}
        </button>`;
}

/**
 * Build the full HTML body for the history view (called from preview-render).
 */
export function renderHistoryBody() {
    const cwd = getCwd();
    const expectedKey = `${cwd}:${state.currentPath}`;
    if (state.historyKey !== expectedKey) {
        // Trigger lazy load — first paint shows the loading bar; loadHistory()
        // re-renders once data arrives.
        resetHistory(state);
        state.historyLoading = true;
        queueMicrotask(() => loadHistory());
    }

    const barHtml = `<div class="dv-history-bar">${buildHistoryBarHtml()}</div>`;

    const HB = S.widgets.diff_viewer.history_bar;
    const commits = state.historyCommits;
    const hasHistory = Array.isArray(commits) && commits.length > 0;
    const noContent = state.historyOldContent === null && state.historyNewContent === null;

    let bodyHtml;
    if (state.historyLoading && noContent) {
        bodyHtml = `
            <div class="preview-history-empty">
                <div class="loading-spinner"></div>
                <span>${HB.picker_loading}</span>
            </div>`;
    } else if (!hasHistory) {
        bodyHtml = `<div class="preview-history-empty"><span>${HB.picker_empty}</span></div>`;
    } else if (noContent) {
        bodyHtml = `<div class="preview-history-empty"><span>${HB.picker_empty}</span></div>`;
    } else {
        const oldLines = (state.historyOldContent || '').split('\n');
        const newLines = (state.historyNewContent || '').split('\n');
        const entries = generateSmartDiff(oldLines, newLines, 1, escapeHtml, {
            contextLines: 3,
            collapseThreshold: 6
        });

        const mode = effectiveDiffMode();
        const oldLabel = state.historyOldLabel || HB.picker_initial;
        const newLabel = state.historyNewLabel || '';

        const headerHtml = mode === 'split' ? `
            <div class="sbs-header">
                <div class="sbs-header-label left">${escapeHtml(oldLabel)}</div>
                <div class="sbs-header-gutter"></div>
                <div class="sbs-header-label right">${escapeHtml(newLabel)}</div>
            </div>` : '';

        const diffHtml = mode === 'split'
            ? renderSideBySideDiff(entries, {
                collapseLabel: (n) => S.widgets.diff_viewer.unchanged_lines.replace('{count}', n)
              })
            : `<div class="changes-diff">${renderSmartDiff(entries)}</div>`;

        bodyHtml = `
            <div class="preview-history-content">
                ${headerHtml}
                ${diffHtml}
            </div>`;
    }

    return `
        ${barHtml}
        <div class="preview-body preview-history-body">
            ${bodyHtml}
        </div>`;
}

/**
 * Wire history-bar event handlers. Called from setupEventHandlers when in history mode.
 */
export function wireHistoryEvents(container) {
    const bar = container.querySelector('.dv-history-bar');
    if (!bar) return;

    bar.querySelector('[data-action="ph-step-prev"]')?.addEventListener('click', (e) => {
        if (e.currentTarget.disabled) return;
        step(+1);
    });
    bar.querySelector('[data-action="ph-step-next"]')?.addEventListener('click', (e) => {
        if (e.currentTarget.disabled) return;
        step(-1);
    });
    bar.querySelector('[data-action="ph-picker-from"]')?.addEventListener('click', (e) => {
        showFromPicker(e.currentTarget);
    });
    bar.querySelector('[data-action="ph-picker-to"]')?.addEventListener('click', (e) => {
        showToPicker(e.currentTarget);
    });
    bar.querySelector('[data-action="ph-pick"]')?.addEventListener('click', () => {
        if (!state.currentPath) return;
        DiffViewerWidget.openCompareWizard(state.currentPath, getCwd());
    });
    bar.querySelector('[data-action="ph-toggle-mode"]')?.addEventListener('click', () => {
        const next = effectiveDiffMode() === 'split' ? 'unified' : 'split';
        state.historyDiffMode = next;
        saveDiffViewMode(next);
        fns.rerenderContent();
    });

    // Wire collapse-section expand (re-render with all context shown)
    container.querySelectorAll('.sbs-collapse, .diff-collapse').forEach(el => {
        el.addEventListener('click', () => { el.style.display = 'none'; });
    });
}

function step(delta) {
    const commits = state.historyCommits;
    if (!commits?.length) return;

    if (state.historyToKind !== 'snapshot') {
        // To = HEAD or Working: < (older, delta=+1) jumps to newest snapshot.
        if (delta > 0) {
            state.historyToKind = 'snapshot';
            state.historyToIndex = 0;
            loadDiff();
        }
        return;
    }

    const target = state.historyToIndex + delta;
    if (target < 0 || target >= commits.length) return;
    state.historyToIndex = target;
    loadDiff();
}

function buildSnapshotMenuItems(onPick) {
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
            action: () => onPick(i)
        });
    });
    return items;
}

function showFromPicker(anchor) {
    if (!state.historyCommits) return;
    const HB = S.widgets.diff_viewer.history_bar;
    const items = [
        { label: HB.from_auto, action: () => { state.historyFromKind = 'auto'; loadDiff(); } },
        { label: HB.picker_initial, action: () => { state.historyFromKind = 'initial'; loadDiff(); } },
    ];
    if (state.historyCommits.length > 0) {
        items.push({ type: 'separator' });
        items.push(...buildSnapshotMenuItems((i) => {
            state.historyFromKind = 'snapshot';
            state.historyFromIndex = i;
            loadDiff();
        }));
    }
    const rect = anchor.getBoundingClientRect();
    const menu = window.app?.contextMenu || (window._previewHistoryCtxMenu ||= new ContextMenu());
    menu.show(rect.left, rect.bottom + 4, items);
}

function showToPicker(anchor) {
    if (!state.historyCommits) return;
    const HB = S.widgets.diff_viewer.history_bar;
    const items = [
        { label: HB.to_head, action: () => { state.historyToKind = 'head'; loadDiff(); } },
        { label: HB.to_working, action: () => { state.historyToKind = 'working'; loadDiff(); } },
    ];
    if (state.historyCommits.length > 0) {
        items.push({ type: 'separator' });
        items.push(...buildSnapshotMenuItems((i) => {
            state.historyToKind = 'snapshot';
            state.historyToIndex = i;
            loadDiff();
        }));
    }
    const rect = anchor.getBoundingClientRect();
    const menu = window.app?.contextMenu || (window._previewHistoryCtxMenu ||= new ContextMenu());
    menu.show(rect.left, rect.bottom + 4, items);
}
