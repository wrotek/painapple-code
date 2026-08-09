/**
 * Preview edit mode (CodeMirror)
 *
 * Handles CodeMirror lazy-loading, edit/save/discard operations, and
 * fallback textarea for when CodeMirror fails to load.
 */

import { state, isEditMode, isEditable, fns, wrapLines } from './preview-state.js';
import { getEffectiveLanguage, detectContentLanguage, showToast } from './preview-utils.js';
import { CONFIG } from '../config.js';
import { WidgetBus } from '../widget-system/index.js';
import S from '../strings.js';
import { basename } from '../path-utils.js';

let CodeEditorClass = null;
async function getCodeEditor() {
    if (!CodeEditorClass) {
        const { CodeEditor } = await import('../editor-view.js');
        CodeEditorClass = CodeEditor;
    }
    return CodeEditorClass;
}

/**
 * Switch to edit view — lazy-loads CodeMirror
 */
export async function switchToEditView(targetContainer) {
    if (isEditMode() && !state.isScratch) return;
    if (!state.currentPath && !state.isScratch) return;
    if (!state.isScratch && !state.content) return;
    if (!isEditable()) return;

    // Capture state at call time — closures must target this instance
    // even if the global `state` pointer swaps during async CodeMirror load.
    const s = state;

    if (s.content == null) s.content = '';
    if (s.editBuffer === null) {
        s.editBuffer = s.content;
    }
    // Save pending scroll line — rerenderContent would consume it for the edit
    // mode DOM which has no line elements. Restore after CM loads (or on leaveEdit).
    const savedScrollToLine = s.scrollToLine;
    const savedScrollOptions = s.scrollOptions;
    s.scrollToLine = null;
    s.scrollOptions = null;

    s.viewMode = 'edit';

    // If caller provided the container (e.g. scratch tabs), use it directly
    if (!targetContainer) {
        fns.rerenderContent();
    }

    // Find the CM container
    const container = targetContainer
        || s.container?.querySelector('.file-preview-widget') || s.container
        || fns.findPreviewContainer();
    if (!container) return;

    const cmContainer = container.querySelector('.preview-cm-container');
    if (!cmContainer) return;

    // Race CM loading against a timeout — fall back to textarea if CDN is slow
    const CM_TIMEOUT_MS = 6000;
    let timedOut = false;
    const timeoutId = setTimeout(() => {
        timedOut = true;
        if (!s.editor?.view) {
            console.warn('[FilePreview] CodeMirror load timed out, falling back to textarea');
            if (s.editor) { s.editor.destroy(); s.editor = null; }
            // Restore scroll line for leaveEditView to use when returning to code
            if (savedScrollToLine) {
                s.scrollToLine = savedScrollToLine;
                s.scrollOptions = savedScrollOptions;
            }
            const liveCm = container.querySelector('.preview-cm-container');
            if (liveCm) {
                mountFallbackTextarea(liveCm, container, s);
            }
        }
    }, CM_TIMEOUT_MS);

    try {
        const CodeEditor = await getCodeEditor();
        if (timedOut) return;
        // Destroy previous editor in THIS state instance
        if (s.editor) { try { s.editor.destroy(); } catch(e) {} s.editor = null; }
        s.editor = new CodeEditor(cmContainer, {
            content: s.editBuffer,
            language: getEffectiveLanguage(),
            readOnly: false,
            lineWrapping: wrapLines,
            onChange: (newContent) => {
                s.editBuffer = newContent;
                s.modified = newContent !== s.content;
                const dot = container.querySelector('.preview-modified-dot');
                if (dot) dot.classList.toggle('visible', s.modified);
                const editTab = container.querySelector('.toggle-btn[data-mode="edit"]');
                if (editTab) editTab.classList.toggle('modified', s.modified);
                // Auto-detect language for scratch pads still on default 'text'
                if (s.isScratch && s.language === 'text' && !s.languageOverride && newContent.length > 20) {
                    const detected = detectContentLanguage(newContent);
                    if (detected && detected !== 'text') {
                        s.language = detected;
                        // Update language selector dropdown
                        const langSelect = container.querySelector('.language-select');
                        if (langSelect) langSelect.value = detected;
                        // Recreate CM with detected language
                        if (s.editor) {
                            s.editBuffer = s.editor.getContent();
                            s.editor.destroy();
                            s.editor = null;
                            s.viewMode = 'code';
                            fns.switchToEditView();
                        }
                    }
                }
                // Auto-save scratch content to localStorage
                if (s.isScratch && s.scratchId) {
                    try {
                        localStorage.setItem(`claude-scratch-${s.scratchId}`, JSON.stringify({
                            content: newContent,
                            language: getEffectiveLanguage()
                        }));
                    } catch (e) { /* ignore */ }
                }
                if (s.currentPath) {
                    WidgetBus.emit('widget:file-changed', {
                        widgetId: 'file-preview',
                        filePath: s.currentPath,
                        fileName: (s.modified ? '\u2022 ' : '') + basename(s.currentPath)
                    });
                }
            }
        });
        await s.editor.init();
        if (timedOut) { s.editor.destroy(); s.editor = null; return; }
        clearTimeout(timeoutId);
        if (s.editor) {
            s.editor.focus();
            // Restore scroll position from code view
            if (savedScrollToLine) {
                s.editor.scrollToLine(savedScrollToLine);
            }
        }
    } catch (err) {
        clearTimeout(timeoutId);
        if (timedOut) return;
        console.error('[FilePreview] CodeMirror failed, falling back to textarea:', err);
        s.editor = null;
        // Restore scroll line for leaveEditView to use when returning to code
        if (savedScrollToLine) {
            s.scrollToLine = savedScrollToLine;
            s.scrollOptions = savedScrollOptions;
        }
        mountFallbackTextarea(cmContainer, container, s);
    }
}

/**
 * Mount a plain <textarea> as fallback when CodeMirror fails to load
 */
function mountFallbackTextarea(cmContainer, widgetContainer, s = state) {
    cmContainer.innerHTML = '';
    const textarea = document.createElement('textarea');
    textarea.className = 'preview-edit-fallback';
    textarea.value = s.editBuffer || s.content || '';
    textarea.spellcheck = false;
    textarea.addEventListener('input', () => {
        s.editBuffer = textarea.value;
        s.modified = textarea.value !== s.content;
        const dot = widgetContainer.querySelector('.preview-modified-dot');
        if (dot) dot.classList.toggle('visible', s.modified);
        const editTab = widgetContainer.querySelector('.toggle-btn[data-mode="edit"]');
        if (editTab) editTab.classList.toggle('modified', s.modified);
        if (s.isScratch && s.scratchId) {
            try {
                localStorage.setItem(`claude-scratch-${s.scratchId}`, JSON.stringify({
                    content: textarea.value,
                    language: getEffectiveLanguage()
                }));
            } catch (e) { /* ignore */ }
        }
        if (s.currentPath) {
            WidgetBus.emit('widget:file-changed', {
                widgetId: 'file-preview',
                filePath: s.currentPath,
                fileName: (s.modified ? '\u2022 ' : '') + basename(s.currentPath)
            });
        }
    });
    cmContainer.appendChild(textarea);
    textarea.focus();
}

/**
 * Leave edit view — destroys CM editor, switches to target view
 * Edits persist in editBuffer (not discarded)
 */
export function leaveEditView(targetMode = 'code') {
    if (!isEditMode()) return;

    // Capture cursor line before destroying editor for scroll restoration
    if (state.editor?.view && targetMode === 'code') {
        try {
            const pos = state.editor.view.state.selection.main.head;
            const lineNum = state.editor.view.state.doc.lineAt(pos).number;
            state.scrollToLine = lineNum;
            state.scrollOptions = { flash: false, position: 'center' };
        } catch (e) { /* ignore */ }
    }

    if (state.editor) {
        state.editBuffer = state.editor.getContent();
        state.editor.destroy();
        state.editor = null;
    }

    state.viewMode = targetMode;

    WidgetBus.emit('widget:file-changed', {
        widgetId: 'file-preview',
        filePath: state.currentPath,
        fileName: (state.modified ? '\u2022 ' : '') + basename(state.currentPath)
    });

    fns.rerenderContent();
}

/**
 * Discard unsaved edits and reset edit state
 */
export function discardEdits() {
    state.editBuffer = null;
    state.modified = false;
    WidgetBus.emit('widget:file-changed', {
        widgetId: 'file-preview',
        filePath: state.currentPath,
        fileName: basename(state.currentPath)
    });
}

/**
 * Save file content from editor
 */
export async function saveFile() {
    if (!isEditMode() || !state.currentPath) return;
    if (state.saving) return;

    state.saving = true;
    const content = state.editor
        ? state.editor.getContent()
        : state.editBuffer || state.content;

    try {
        const resp = await fetch(`${CONFIG.API_BASE}/api/file/write`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: state.currentPath, content })
        });

        if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            throw new Error(data.detail || `HTTP ${resp.status}`);
        }

        const result = await resp.json().catch(() => ({}));
        state.content = content;
        state.editBuffer = content;
        state.modified = false;
        if (result.mtime) state.mtime = result.mtime;

        const container = fns.findPreviewContainer();
        if (container) {
            const dot = container.querySelector('.preview-modified-dot');
            if (dot) dot.classList.remove('visible');
            const editTab = container.querySelector('.toggle-btn[data-mode="edit"]');
            if (editTab) editTab.classList.remove('modified');
        }

        WidgetBus.emit('widget:file-changed', {
            widgetId: 'file-preview',
            filePath: state.currentPath,
            fileName: basename(state.currentPath)
        });

        showToast(S.toast.file_saved);
    } catch (err) {
        console.error('[FilePreview] Save failed:', err);
        showToast(`Save failed: ${err.message}`);
    } finally {
        state.saving = false;
    }
}

// Language to file extension mapping for Save As
const LANG_EXTENSIONS = {
    text: '.txt', javascript: '.js', typescript: '.ts', python: '.py',
    shell: '.sh', fish: '.fish', ruby: '.rb', go: '.go', rust: '.rs',
    java: '.java', c: '.c', cpp: '.cpp', csharp: '.cs', php: '.php',
    swift: '.swift', kotlin: '.kt', html: '.html', css: '.css', scss: '.scss',
    json: '.json', yaml: '.yaml', xml: '.xml', markdown: '.md', sql: '.sql',
    dockerfile: '', makefile: '', toml: '.toml', ini: '.ini', csv: '.csv',
};

/**
 * Save scratch content to a file (Save As dialog)
 */
export async function saveAsFile() {
    if (!state.isScratch) return;

    const content = state.editor
        ? state.editor.getContent()
        : state.editBuffer || state.content || '';

    const lang = getEffectiveLanguage();
    const ext = LANG_EXTENSIONS[lang] || '.txt';
    const cwd = state.cwd || CONFIG.HOME || '/';
    const suggestion = `${cwd}/untitled${ext}`;

    const path = prompt('Save as:', suggestion);
    if (!path || !path.trim()) return;

    const savePath = path.trim();
    state.saving = true;

    try {
        const resp = await fetch(`${CONFIG.API_BASE}/api/file/write`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: savePath, content })
        });

        if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            throw new Error(data.detail || `HTTP ${resp.status}`);
        }

        if (state.scratchId) {
            try {
                localStorage.removeItem(`claude-scratch-${state.scratchId}`);
            } catch (e) { /* ignore */ }
        }

        state.isScratch = false;
        state.scratchId = null;
        state.currentPath = savePath;
        state.content = content;
        state.editBuffer = content;
        state.modified = false;

        WidgetBus.emit('widget:file-changed', {
            widgetId: 'file-preview',
            filePath: savePath,
            fileName: basename(savePath),
            convertScratch: true
        });

        showToast(`Saved to ${basename(savePath)}`);
    } catch (err) {
        console.error('[FilePreview] Save As failed:', err);
        showToast(`Save failed: ${err.message}`);
    } finally {
        state.saving = false;
    }
}
