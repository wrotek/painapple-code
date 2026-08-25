/**
 * Unified-diff / patch preview plugin
 *
 * Handles: .diff, .patch
 *
 * A .diff file already IS a diff — unlike the History tab or the git widget we
 * have no old/new file pair to run `generateSmartDiff()` over. So this plugin
 * parses the unified-diff text straight into the SAME entry shape that
 * `diff-utils.js` renders ({type, oldLineNum, newLineNum, content}), which
 * means both the unified and side-by-side renderers — plus every rule in
 * 22-edit-diff.css — come for free with no LCS pass at all. Line numbers come
 * out of the `@@ -a,b +c,d @@` headers rather than being recomputed.
 *
 * Falls through to code view for 'code'/'edit' modes.
 */

import { renderSmartDiff, renderSideBySideDiff, computeWordDiff, areSimilarLines } from '../diff-utils.js';
import { escapeHtml } from '../utils.js';
import S from '../strings.js';

const HUNK_RE = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Pair up adjacent removed/added runs into 'modified' entries so the
 * word-level highlighting in 22-edit-diff.css has something to bite on.
 *
 * Unified diffs don't mark pairs, so this pairs equal-length runs positionally
 * — but only when `areSimilarLines()` agrees, the same gate `generateSmartDiff`
 * applies. Without it, a rewritten prose paragraph pairs into a 'modified' row
 * where nearly every word is marked, which is noisier than just showing the
 * old and new lines whole. Any run that fails the gate falls back to plain
 * removed-then-added rows.
 */
function pairRuns(removed, added, out) {
    const pairable = removed.length > 0
        && removed.length === added.length
        && removed.every((r, i) => areSimilarLines(r.raw, added[i].raw));

    if (pairable) {
        for (let i = 0; i < removed.length; i++) {
            const r = removed[i], a = added[i];
            const { oldHtml, newHtml } = computeWordDiff(r.raw, a.raw, escapeHtml);
            out.push({
                type: 'modified',
                oldLineNum: r.oldLineNum,
                newLineNum: a.newLineNum,
                oldContent: oldHtml || ' ',
                newContent: newHtml || ' ',
            });
        }
    } else {
        for (const r of removed) out.push({ type: 'removed', oldLineNum: r.oldLineNum, content: escapeHtml(r.raw) || ' ' });
        for (const a of added) out.push({ type: 'added', newLineNum: a.newLineNum, content: escapeHtml(a.raw) || ' ' });
    }
    removed.length = 0;
    added.length = 0;
}

/**
 * Parse unified-diff text into per-file sections of renderable entries.
 * Tolerates bare `--- / +++` patches (no `diff --git` line) and plain
 * hunk-only fragments, both of which show up when someone pipes a diff
 * to a file by hand.
 */
export function parseUnifiedDiff(text) {
    const lines = (text || '').split('\n');
    // A newline-terminated file splits to a trailing '' that is not a line.
    // Left in, it renders as a spurious blank context row on every section.
    if (lines.length && lines[lines.length - 1] === '') lines.pop();

    // `git format-patch` terminates with a mail signature:
    //     -- \n2.53.0\n
    // The `-- ` line starts with '-', so a naive pass counts it as a deleted
    // line (and renders it as one). Strip it only when it sits at the very end
    // followed by a version-looking line, so a genuine `-- ` removal mid-diff
    // — e.g. a markdown list item — is left alone.
    for (let i = lines.length - 1, blanks = 0; i >= 0 && lines.length - i <= 4; i--) {
        if (lines[i] === '') { blanks++; continue; }
        if (/^\d+\.\d+(\.\d+)?/.test(lines[i]) && i > 0 && /^-- ?$/.test(lines[i - 1])) {
            lines.length = i - 1;
        }
        break;
    }

    const files = [];
    let file = null;
    let entries = null;
    let oldNum = 0, newNum = 0;
    const removed = [], added = [];

    const startFile = (label) => {
        pairRuns(removed, added, entries || []);
        entries = [];
        file = { label, oldPath: '', newPath: '', additions: 0, deletions: 0, entries, meta: [] };
        files.push(file);
    };
    const ensureFile = () => { if (!file) startFile(''); };

    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            startFile(line.slice('diff --git '.length));
            file.meta.push(line);
            continue;
        }

        if (line.startsWith('--- ')) {
            // A bare patch with no `diff --git` header still starts a file here,
            // but only if the current section already has hunks — otherwise
            // this is the `---` belonging to the section we just opened.
            if (!file || file.entries.length) startFile('');
            file.oldPath = line.slice(4).trim();
            file.meta.push(line);
            continue;
        }
        if (line.startsWith('+++ ')) {
            ensureFile();
            file.newPath = line.slice(4).trim();
            file.meta.push(line);
            continue;
        }

        const hunk = HUNK_RE.exec(line);
        if (hunk) {
            ensureFile();
            pairRuns(removed, added, entries);
            oldNum = parseInt(hunk[1], 10);
            newNum = parseInt(hunk[3], 10);
            entries.push({ type: 'collapse', count: 0, startLine: oldNum, endLine: oldNum, header: line });
            continue;
        }

        if (!file) continue;

        const kind = line[0];
        if (kind === '+') {
            added.push({ raw: line.slice(1), newLineNum: newNum++ });
            file.additions++;
        } else if (kind === '-') {
            removed.push({ raw: line.slice(1), oldLineNum: oldNum++ });
            file.deletions++;
        } else if (kind === ' ' || line === '') {
            pairRuns(removed, added, entries);
            entries.push({ type: 'context', oldLineNum: oldNum++, newLineNum: newNum++, content: escapeHtml(line.slice(1)) || ' ' });
        } else if (line.startsWith('\\ No newline')) {
            // marker line — belongs to the previous entry, nothing to render
        } else {
            // index/mode/similarity/binary headers and free-text preamble
            pairRuns(removed, added, entries);
            file.meta.push(line);
        }
    }
    pairRuns(removed, added, entries || []);

    // Drop a leading section that captured only free-text preamble. A
    // header-only section (new empty file, mode change, binary) has no
    // hunks but did name a file, so it survives and renders as a header.
    return files.filter(f => f.entries.length || f.newPath || f.oldPath || f.label);
}

function fileTitle(file) {
    const strip = (p) => p.replace(/^[ab]\//, '').replace(/\t.*$/, '');
    const oldP = strip(file.oldPath || '');
    const newP = strip(file.newPath || '');
    if (newP && oldP && newP !== oldP && oldP !== '/dev/null') return `${oldP} → ${newP}`;
    return newP && newP !== '/dev/null' ? newP : (oldP || file.label || '');
}

export default {
    id: 'diff',

    match(path) {
        const ext = path?.split('.').pop()?.toLowerCase();
        return ext === 'diff' || ext === 'patch';
    },

    needsFetch: true,
    editable: true,

    viewModes: [{
        mode: 'diff',
        label: S.preview?.tab_diff || 'Diff',
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/><line x1="5" y1="19" x2="19" y2="19"/></svg>`,
    }],

    defaultViewMode: 'diff',

    initState() {
        return { sideBySide: false };
    },

    renderBody(state) {
        if (state.viewMode !== 'diff') return null;

        const files = parseUnifiedDiff(state.content || '');
        if (!files.length) {
            return `<div class="preview-body"><div class="diff-preview-empty">${
                escapeHtml(S.preview?.diff_unparsable || 'Not a recognizable unified diff — use the Code tab.')
            }</div></div>`;
        }

        const sbs = state.pluginState.sideBySide;
        const body = files.map(file => {
            // The `collapse` entries we emitted for @@ headers are hunk separators,
            // not collapsed-context markers — render them as headers instead.
            const chunks = [];
            let buf = [];
            for (const e of file.entries) {
                if (e.type === 'collapse') {
                    if (buf.length) chunks.push({ header: null, entries: buf });
                    buf = [];
                    chunks.push({ header: e.header, entries: null });
                } else buf.push(e);
            }
            if (buf.length) chunks.push({ header: null, entries: buf });

            const inner = chunks.map(c => c.header !== null
                ? `<div class="diff-preview-hunk-header">${escapeHtml(c.header)}</div>`
                : (sbs ? renderSideBySideDiff(c.entries) : renderSmartDiff(c.entries))
            ).join('');

            return `
                <div class="diff-preview-file">
                    <div class="diff-preview-file-header">
                        <span class="diff-preview-file-name">${escapeHtml(fileTitle(file))}</span>
                        <span class="diff-preview-stats">
                            <span class="diff-stat-added">+${file.additions}</span>
                            <span class="diff-stat-removed">-${file.deletions}</span>
                        </span>
                    </div>
                    ${inner}
                </div>
            `;
        }).join('');

        return `<div class="preview-body"><div class="diff-preview${sbs ? ' sbs' : ''}">${body}</div></div>`;
    },

    renderToolbarControls(state) {
        if (state.viewMode !== 'diff') return '';
        const on = state.pluginState.sideBySide;
        const tooltip = on
            ? (S.preview?.diff_unified || 'Unified view')
            : (S.widgets?.diff_viewer?.side_by_side || 'Side by side');
        return `
            <button class="diff-preview-sbs-toggle ${on ? 'active' : ''}" data-tooltip="${escapeHtml(tooltip)}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg>
            </button>
        `;
    },

    setupEvents(container, state, helpers) {
        if (state.viewMode !== 'diff') return;
        container.querySelector('.diff-preview-sbs-toggle')?.addEventListener('click', () => {
            state.pluginState.sideBySide = !state.pluginState.sideBySide;
            helpers.rerenderContent();
        });
    },
};
