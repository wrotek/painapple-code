/**
 * File open/preview mixin — routes file-path clicks and Cmd+click opens to the
 * file-preview / image-preview / history widgets, and resolves file paths
 * against the session cwd. Extracted from app.js; applied to App.prototype via
 * Object.assign. Uses `this` (App instance) plus the imports below.
 */
import { CONFIG } from '../config.js';
import { recordOpen as recordRecentOpen } from '../recent-opens.js';
import { FilePreviewWidget, HistoryExplorerWidget } from '../widget-system/init.js';
import { ImagePreviewWidget } from '../widgets/index.js';

export const filePreviewMethods = {
    /**
     * Open a file in background tab (Cmd+click behavior)
     * Opens read-only preview as a background tab without switching to it
     */
    async openFileInEditor(path, cwd, options = {}) {
        cwd = cwd || this.activeSession?.cwd || CONFIG.HOME;
        let fullPath = (path.startsWith('/') || path.startsWith('~')) ? path : `${cwd}/${path}`.replace(/\/+/g, '/');

        // Resolve bare filenames
        if (!path.includes('/')) {
            const resolved = await this._resolveFile(path, cwd);
            if (resolved) fullPath = resolved;
        }

        FilePreviewWidget.setCwd(cwd);

        // Open as background tab via tab controller
        this.tabCtrl?.openFilePreviewTab(fullPath, fullPath.split('/').pop(), { background: true });
    },

    /**
     * Preview a file in the floating preview widget
     * Uses lightweight FilePreviewWidget (highlight.js, not CodeMirror)
     *
     * Features click-time resolution:
     * - For paths with '/', resolves relative to CWD
     * - For bare filenames, searches project subdirectories via /api/find-file
     * - Results are cached to avoid repeated API calls
     */
    async previewFile(path, options = {}) {
        const cwd = this.activeSession?.cwd || CONFIG.HOME;
        let fullPath = (path.startsWith('/') || path.startsWith('~')) ? path : `${cwd}/${path}`.replace(/\/+/g, '/');

        // For bare filenames (no '/'), try fuzzy resolution
        if (!path.includes('/')) {
            const resolved = await this._resolveFile(path, cwd);
            if (resolved) fullPath = resolved;
        }

        recordRecentOpen(fullPath);

        // Image files open in the gallery widget so they participate in
        // session-wide prev/next navigation alongside Read/Write tool images.
        // File-explorer opens pass imageGallery:'dir' — the strip then lists
        // the clicked image's directory siblings instead of chat images.
        if (/\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(fullPath)) {
            if (options.imageGallery === 'dir') {
                ImagePreviewWidget.showForFile(fullPath);
            } else {
                ImagePreviewWidget.show(`/api/file-raw?path=${encodeURIComponent(fullPath)}`);
            }
            return;
        }

        // Set CWD for relative path display
        FilePreviewWidget.setCwd(cwd);

        // Open the preview
        await FilePreviewWidget.preview(fullPath, options);
    },

    /**
     * Modifier-aware router for clicks on file links / pills.
     * - Plain click → floating preview (delegates to previewFile, which also
     *   handles images via the gallery widget and fuzzy-resolves bare names).
     * - Cmd/Ctrl+click → background full tab.
     * - Cmd/Ctrl+Shift+click → foreground full tab.
     * Images always go to the gallery widget regardless of modifier — the
     * file-preview tab can't render images and the gallery is the right home.
     */
    async openFileLink(path, options = {}, event = null) {
        const cmd = !!(event && (event.metaKey || event.ctrlKey));
        const shift = !!(event && event.shiftKey);
        const isImage = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(path);

        if (!cmd || isImage) {
            return this.previewFile(path, options);
        }

        // Resolve to an absolute path before opening as a tab.
        const cwd = this.activeSession?.cwd || CONFIG.HOME;
        let fullPath = (path.startsWith('/') || path.startsWith('~')) ? path : `${cwd}/${path}`.replace(/\/+/g, '/');
        if (!path.includes('/')) {
            const resolved = await this._resolveFile(path, cwd);
            if (resolved) fullPath = resolved;
        }

        const tabOpts = shift ? { newTab: true } : { background: true };
        this.tabCtrl?.openFilePreviewTab(fullPath, null, tabOpts);
    },

    /**
     * Toggle the floating file preview, restoring the last previewed file.
     * Bound to the rail's preview button and Alt+V — the way back in after
     * Escape closes the widget.
     */
    togglePreview() {
        return FilePreviewWidget.toggle();
    },

    /**
     * Open a file in the floating preview widget and switch to its History
     * tab. Optionally seeds the From/To cursors via opts.seed.
     *
     * Used by the right-click "Compare" presets (this turn / last change /
     * session start) and by history-explorer's "View" action.
     */
    async previewFileWithHistory(path, opts = {}) {
        const cwd = opts.cwd || this.activeSession?.cwd || CONFIG.HOME;
        let fullPath = (path.startsWith('/') || path.startsWith('~')) ? path : `${cwd}/${path}`.replace(/\/+/g, '/');

        if (!path.includes('/')) {
            const resolved = await this._resolveFile(path, cwd);
            if (resolved) fullPath = resolved;
        }

        FilePreviewWidget.setCwd(cwd);
        await FilePreviewWidget.previewWithHistory(fullPath, { seed: opts.seed });
    },

    /**
     * Show file history in History Explorer widget
     * Opens the widget to the Files tab with the specified file selected
     * @param {string} path - File path (relative or absolute)
     * @param {string} cwd - Working directory for the project
     */
    async showFileHistory(path, cwd) {
        await HistoryExplorerWidget.openToFile(path, cwd);
    },

    /**
     * Resolve a bare filename to its full path using /api/find-file
     * @param {string} filename - Bare filename (e.g., "git-widget.js")
     * @param {string} cwd - Current working directory
     * @returns {string|null} - Full path if found, null otherwise
     */
    async _resolveFile(filename, cwd) {
        try {
            const url = `${CONFIG.API_BASE}/api/find-file?name=${encodeURIComponent(filename)}&cwd=${encodeURIComponent(cwd)}`;
            const response = await fetch(url);
            const data = await response.json();
            // Files only — /api/find-file can also resolve directories
            // (is_dir: true) for the terminal's dir-click handling
            return (data.found && !data.is_dir) ? data.path : null;
        } catch (err) {
            console.warn('[App] Failed to resolve file:', filename, err);
            return null;
        }
    },
};
