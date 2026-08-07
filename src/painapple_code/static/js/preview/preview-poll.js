/**
 * Preview file-change polling
 *
 * Polls file mtime via /api/file/stat while the preview is visible.
 * - View mode / edit without changes: silent auto-reload
 * - Edit mode with unsaved changes: shows notification bar
 */

import { state, fns } from './preview-state.js';
import { statFile, fetchFile, showToast } from './preview-utils.js';
import { isInlineEditInProgress } from './preview-inline-edit.js';
import S from '../strings.js';

const POLL_INTERVAL_MS = 5000;
let pollTimer = null;

export function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(checkForChanges, POLL_INTERVAL_MS);
}

export function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

async function checkForChanges() {
    // Skip: no file, scratch mode, loading, or no known mtime
    if (!state.currentPath || state.isScratch || state.isLoading || !state.mtime) return;

    try {
        const stat = await statFile(state.currentPath);
        if (!stat.exists) return;
        if (stat.mtime <= state.mtime) return;

        // File changed on disk
        if (state.viewMode === 'edit' && state.modified) {
            showChangedNotification();
        } else if (isInlineEditInProgress()) {
            // An open inline-edit textarea holds unsaved keystrokes; a
            // silentReload() → rerenderContent() would wipe it. Defer — the
            // mtime stays ahead, so we'll reload on a later tick once it closes.
            return;
        } else {
            await silentReload();
        }
    } catch (err) {
        // Network error etc — skip this cycle
        console.warn('[preview-poll] stat failed:', err.message);
    }
}

async function silentReload() {
    try {
        const { content, mtime } = await fetchFile(state.currentPath);
        state.content = content;
        state.mtime = mtime;
        // Update editBuffer if in edit mode (no unsaved changes)
        if (state.viewMode === 'edit') {
            state.editBuffer = content;
            if (state.editor) {
                state.editor.setContent(content);
            }
        }
        fns.rerenderContent();
    } catch (err) {
        console.warn('[preview-poll] reload failed:', err.message);
    }
}

function showChangedNotification() {
    const container = fns.findPreviewContainer();
    if (!container) return;
    // Don't show duplicate
    if (container.querySelector('.preview-changed-bar')) return;

    const bar = document.createElement('div');
    bar.className = 'preview-changed-bar';
    bar.innerHTML = `
        <span class="preview-changed-text">File changed on disk</span>
        <button class="preview-changed-btn reload">Reload</button>
        <button class="preview-changed-btn dismiss">Dismiss</button>
    `;

    bar.querySelector('.reload').addEventListener('click', async () => {
        bar.remove();
        await silentReload();
        showToast(S.toast.reloaded);
    });

    bar.querySelector('.dismiss').addEventListener('click', () => {
        bar.remove();
        // Update mtime so we don't re-trigger until next change
        statFile(state.currentPath).then(s => {
            if (s.exists) state.mtime = s.mtime;
        }).catch(() => {});
    });

    // Insert at top of the preview body
    const body = container.querySelector('.preview-body');
    if (body) {
        body.insertBefore(bar, body.firstChild);
    } else {
        container.insertBefore(bar, container.firstChild);
    }
}
