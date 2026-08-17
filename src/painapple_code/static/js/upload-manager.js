/**
 * Upload Manager Module
 * Handles file and image uploads with preview, drag-drop, and paste support
 */

import { CONFIG } from './config.js';
import { genId, escapeHtml, $ } from './utils.js';
import { ImagePreviewWidget, openImageAnnotator, isImageAnnotatorOpen, isAnnotateOnPasteEnabled } from './widgets/index.js';
import { ContextMenu, copyToClipboard, showToast } from './context-menu.js';
import { WidgetBus } from './widget-system/event-bus.js';
import S from './strings.js';

// Media types Claude accepts verbatim as a base64 image block. Anything else
// (svg, bmp, …) has to go back through /api/upload-image, which re-encodes it.
const CLAUDE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const EXT_MIME = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
};

/** Best-effort image mime from a filename — File.type drives handleImages(). */
function guessImageMime(name) {
    const ext = (name || '').split('.').pop().toLowerCase();
    return EXT_MIME[ext] || 'image/png';
}

/**
 * UploadManager - Handle file and image uploads
 */
export class UploadManager {
    /**
     * @param {Object} elements - DOM elements
     * @param {HTMLElement} elements.inputContainer - Container for input area
     * @param {HTMLTextAreaElement} elements.messageInput - The message input
     * @param {HTMLElement} elements.messagesContainer - For drag-drop zone
     * @param {HTMLButtonElement} elements.sendBtn - Send button (to update state)
     * @param {Object} options - Configuration
     * @param {string} options.apiBase - API base URL
     * @param {Object} callbacks - Callbacks
     * @param {Function} callbacks.getSessionId - Returns current session storeId
     * @param {Function} callbacks.isConnected - Returns true if session connected
     * @param {Function} callbacks.onError - Called on upload error
     * @param {Function} callbacks.onStateChange - Called when uploads change
     */
    constructor(elements, options = {}, callbacks = {}) {
        this.els = elements;
        this.apiBase = options.apiBase || CONFIG.API_BASE;

        // Callbacks
        this.getSessionId = callbacks.getSessionId || (() => null);
        this.isConnected = callbacks.isConnected || (() => false);
        this.onError = callbacks.onError || ((msg) => console.error(msg));
        this.onStateChange = callbacks.onStateChange || (() => {});

        // State
        this.pendingImages = [];
        this.uploadingImages = [];
        this.pendingFiles = [];
        this.uploadingFiles = [];

        // Session ids of upload batches (a multi-file paste/drop) still being
        // walked. handleImages()/_uploadFiles() upload sequentially, so between
        // one file finishing and the next being pushed, uploading* is
        // momentarily empty — without this, isUploading() would blink false
        // mid-batch and a send parked on the batch would fire with only the
        // first file.
        //
        // Keyed by session because this manager is a singleton shared by every
        // tab: a batch started in session A keeps running after a switch to B,
        // and counting it as "B is uploading" would park B's send behind an
        // upload that will never belong to it.
        this._activeBatchSessions = [];

        // Context menu for file chips
        this._contextMenu = new ContextMenu();
        this._longPressTimer = null;

        // Create hidden file inputs
        this._createInputs();

        // Bind event listeners
        this._bindEvents();
    }

    /**
     * Show image in preview modal (uses widget system)
     */
    showImagePreview(src) {
        ImagePreviewWidget.show(src);
    }

    /**
     * Create hidden file inputs
     */
    _createInputs() {
        // Image input
        this.imageInput = document.createElement('input');
        this.imageInput.type = 'file';
        this.imageInput.accept = 'image/png,image/jpeg,image/gif,image/webp';
        this.imageInput.multiple = true;
        this.imageInput.style.display = 'none';
        document.body.appendChild(this.imageInput);

        this.imageInput.addEventListener('change', (e) => {
            this.handleImages(e.target.files);
            this.imageInput.value = '';
        });

        // General file input
        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.multiple = true;
        this.fileInput.style.display = 'none';
        document.body.appendChild(this.fileInput);

        this.fileInput.addEventListener('change', (e) => {
            this.handleFiles(e.target.files);
            this.fileInput.value = '';
        });
    }

    /**
     * Bind paste and drag-drop events
     */
    _bindEvents() {
        // Track Shift on the paste chord — ClipboardEvent carries no modifier
        // state, so remember it from the keydown that triggers the paste.
        // Shift inverts the annotate-on-paste setting: with auto-annotate on,
        // Cmd/Ctrl+Shift+V uploads plain; with it off (default), Shift+V is
        // the way to open the annotation editor from a paste.
        this.els.messageInput.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
                this._pasteShift = e.shiftKey;
            }
        });

        // Paste on message input
        this.els.messageInput.addEventListener('paste', (e) => {
            const items = e.clipboardData?.items;
            if (!items) return;

            const shift = this._pasteShift === true;
            this._pasteShift = false;

            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    if (file) {
                        const annotate = isAnnotateOnPasteEnabled() !== shift;
                        // GIFs would be flattened by the canvas export; the
                        // editor is also skipped while one is already open.
                        if (annotate && file.type !== 'image/gif' && !isImageAnnotatorOpen()) {
                            this._openAnnotator(file);
                        } else {
                            this.handleImages([file]);
                        }
                    }
                    break;
                }
            }
        });

        // Drag and drop on messages area
        this.els.messagesContainer.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.els.messagesContainer.classList.add('drag-over');
        });

        this.els.messagesContainer.addEventListener('dragleave', (e) => {
            e.preventDefault();
            this.els.messagesContainer.classList.remove('drag-over');
        });

        this.els.messagesContainer.addEventListener('drop', (e) => {
            e.preventDefault();
            this.els.messagesContainer.classList.remove('drag-over');
            this.handleFiles(e.dataTransfer.files);
        });
    }

    /**
     * Handle file uploads - routes images to image handler, others to file upload
     */
    handleFiles(files) {
        const fileArray = Array.from(files);
        const imageFiles = fileArray.filter(f => f.type.startsWith('image/'));
        const otherFiles = fileArray.filter(f => !f.type.startsWith('image/'));

        if (imageFiles.length > 0) {
            this.handleImages(imageFiles);
        }
        if (otherFiles.length > 0) {
            this._uploadFiles(otherFiles);
        }
    }

    /**
     * Handle image uploads
     */
    async handleImages(files) {
        const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
        if (!imageFiles.length) return;

        const batch = this._beginBatch();
        try {
            await this._handleImagesBatch(imageFiles);
        } finally {
            this._endBatch(batch);
            // Batch fully settled — let listeners (e.g. a send parked on this
            // batch) act now that isUploading() is honestly false.
            this._notifyChange();
        }
    }

    async _handleImagesBatch(imageFiles) {
        for (const file of imageFiles) {
            const preview = URL.createObjectURL(file);
            const uploadId = genId();

            // Show loading state
            this.uploadingImages.push({ id: uploadId, preview });
            this._renderImagePreviews();

            try {
                const formData = new FormData();
                formData.append('file', file);

                const sessionId = this.getSessionId();
                let uploadUrl = `${this.apiBase}/api/upload-image`;
                if (sessionId) uploadUrl += `?session=${encodeURIComponent(sessionId)}`;

                const response = await fetch(uploadUrl, {
                    method: 'POST',
                    body: formData
                });

                this.uploadingImages = this.uploadingImages.filter(img => img.id !== uploadId);

                if (!response.ok) {
                    const error = await response.json();
                    this.onError(`Upload failed: ${error.detail}`);
                    this._renderImagePreviews();
                    this._notifyChange();
                    continue;
                }

                const data = await response.json();

                // The user switched tabs while this was in flight. pendingImages
                // now belongs to a different session (switchSession saved the
                // outgoing arrays off before we resolved), so pushing here would
                // silently attach this image to someone else's next message.
                if (this._isForeignSession(sessionId)) {
                    URL.revokeObjectURL(preview);
                    this._renderImagePreviews();
                    this._notifyChange();
                    continue;
                }

                this.pendingImages.push({
                    file,
                    preview,
                    imageData: data.image,
                    storedName: data.stored_name || null,
                    mediaType: data.media_type || null,
                });

                this._renderImagePreviews();
                this._notifyChange();
            } catch (error) {
                this.uploadingImages = this.uploadingImages.filter(img => img.id !== uploadId);
                this.onError(`Upload error: ${error.message}`);
                this._renderImagePreviews();
                this._notifyChange();
            }
        }
    }

    /**
     * Open the annotation editor for a pasted image. Done → upload the
     * annotated PNG; skip → upload the original; cancel → drop the paste.
     */
    _openAnnotator(file) {
        openImageAnnotator(file, {
            onDone: (blob, markers) => {
                const annotated = this._annotatedFile(blob, file.name);
                this.handleImages([annotated]);
                this._stashMarkers(annotated.name, markers);
            },
            onSkip: () => this.handleImages([file]),
        });
    }

    /**
     * Re-open a pending image in the annotation editor; on done the
     * annotated PNG replaces the original pending upload.
     */
    async editImage(index) {
        const img = this.pendingImages[index];
        if (!img) return;
        let blob = img.file;
        if (!blob) {
            // Restored from server — the preview blob URL is the only copy
            try { blob = await fetch(img.preview).then(r => r.blob()); }
            catch { return; }
        }
        openImageAnnotator(blob, {
            onDone: (out, markers) => {
                const name = img.file?.name || img.storedName;
                this.removeImage(index);
                const annotated = this._annotatedFile(out, name);
                this.handleImages([annotated]);
                this._stashMarkers(annotated.name, markers);
            },
        });
    }

    /**
     * Attach an annotated PNG produced outside the paste flow — currently the
     * image gallery's "Open in Annotation Editor" action, which annotates a
     * file that already exists on disk. The result lands in the same place as
     * paste-to-annotate: a pending chat attachment, with marker notes stashed.
     * @param {Blob} blob - PNG exported by the annotation editor
     * @param {string} originalName - name of the source image
     * @param {Array} markers - [{n, note}] from the editor
     */
    attachAnnotated(blob, originalName, markers) {
        const annotated = this._annotatedFile(blob, originalName);
        this.handleImages([annotated]);
        this._stashMarkers(annotated.name, markers);
    }

    /**
     * Re-attach an upload that already exists on disk as a pending attachment
     * on the current input — the Uploads widget's "Attach to Chat" action.
     *
     * Non-image files need no copy: the prompt only ever carries the absolute
     * path, so an upload from any session in the project attaches as-is.
     *
     * Images DO travel as base64, so the bytes are fetched back. Same session →
     * reuse the stored name (no duplicate on disk, and the pending image
     * survives a page refresh). Different session → re-upload into THIS
     * session, because restoreFromServer() resolves storedName against the
     * current session's uploads dir and would 404 otherwise.
     *
     * @param {Object} entry - {name, session_id, path, size, is_image} as
     *                         served by GET /api/sessions/{id}/uploads
     * @returns {Promise<boolean>} true when something is now pending
     */
    async attachStored(entry) {
        if (!entry?.name) return false;

        if (!entry.is_image) {
            if (!entry.path) {
                this.onError(S.uploads.attach_no_path);
                return false;
            }
            const fileEntry = {
                name: entry.name,
                path: entry.path,
                size: entry.size || 0,
                originalName: entry.name,
            };
            const existingIdx = this.pendingFiles.findIndex(f => f.path === entry.path);
            if (existingIdx >= 0) this.pendingFiles[existingIdx] = fileEntry;
            else this.pendingFiles.push(fileEntry);
            this._renderFilePreviews();
            this._notifyChange();
            return true;
        }

        const ownerId = entry.session_id;
        const currentId = this.getSessionId();
        if (!ownerId) return false;

        // Already pending from this same session — don't stack a duplicate
        if (ownerId === currentId && this.pendingImages.some(i => i.storedName === entry.name)) {
            return true;
        }

        const uploadId = genId();
        this.uploadingImages.push({
            id: uploadId,
            preview: `${this.apiBase}/api/sessions/${encodeURIComponent(ownerId)}/uploads/${encodeURIComponent(entry.name)}`,
        });
        this._renderImagePreviews();

        try {
            const resp = await fetch(
                `${this.apiBase}/api/sessions/${encodeURIComponent(ownerId)}/uploads/${encodeURIComponent(entry.name)}?base64_encode=true`
            );
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const blob = this._base64Blob(data.data, data.media_type);

            this.uploadingImages = this.uploadingImages.filter(i => i.id !== uploadId);

            // Cross-session, or a format Claude can't take as-is (svg/bmp land
            // on 'application/octet-stream') — round-trip through the upload
            // endpoint so the server normalises AND files it under this session.
            const claudeSafe = CLAUDE_IMAGE_TYPES.has(data.media_type);
            if (ownerId !== currentId || !claudeSafe) {
                const type = claudeSafe ? data.media_type : guessImageMime(entry.name);
                await this.handleImages([new File([blob], entry.name, { type })]);
                return true;
            }

            this.pendingImages.push({
                file: null,
                preview: URL.createObjectURL(blob),
                imageData: {
                    type: 'image',
                    source: { type: 'base64', media_type: data.media_type, data: data.data },
                },
                storedName: entry.name,
                mediaType: data.media_type,
            });
            this._renderImagePreviews();
            this._notifyChange();
            return true;
        } catch (err) {
            this.uploadingImages = this.uploadingImages.filter(i => i.id !== uploadId);
            this._renderImagePreviews();
            this._notifyChange();
            this.onError(S.uploads.attach_failed.replace('{name}', entry.name));
            return false;
        }
    }

    /** Decode a base64 payload into a Blob (preview + re-upload source). */
    _base64Blob(base64, mediaType) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: mediaType });
    }

    /**
     * Turn numbered-marker comments from the annotation editor into Comments
     * Stash items. The stash block and the annotated image travel in the same
     * user message, so "marker N on <file>" is enough for Claude to connect
     * the comment to the badge on the picture.
     */
    async _stashMarkers(fileName, markers) {
        if (!markers?.length) return;
        try {
            const { Stash } = await import('./stash.js');
            // Stash.add unshifts — insert in reverse so the list reads 1, 2, 3
            for (const m of [...markers].reverse()) {
                await Stash.add({
                    type: 'image',
                    filePath: fileName,
                    markerIndex: m.n,
                }, m.note);
            }
            showToast(S.toast.markers_stashed.replace('{count}', markers.length));
        } catch (err) {
            console.error('[Upload] Failed to stash marker comments:', err);
        }
    }

    /**
     * Wrap an exported annotation blob as a File named after the original.
     */
    _annotatedFile(blob, originalName) {
        const base = (originalName || 'pasted-image').replace(/\.[^.]+$/, '');
        return new File([blob], `${base}-annotated.png`, { type: 'image/png' });
    }

    /**
     * Handle non-image file uploads
     */
    async _uploadFiles(files) {
        if (!files.length) return;

        const batch = this._beginBatch();
        try {
            await this._uploadFilesBatch(files);
        } finally {
            this._endBatch(batch);
            this._notifyChange();
        }
    }

    async _uploadFilesBatch(files) {
        const sessionId = this.getSessionId();

        for (const file of files) {
            const uploadId = genId();

            this.uploadingFiles.push({ id: uploadId, name: file.name });
            this._renderFilePreviews();

            try {
                const formData = new FormData();
                formData.append('file', file);

                let url = `${this.apiBase}/api/upload-file`;
                if (sessionId) url += `?session=${encodeURIComponent(sessionId)}`;

                const response = await fetch(url, { method: 'POST', body: formData });

                this.uploadingFiles = this.uploadingFiles.filter(f => f.id !== uploadId);

                if (!response.ok) {
                    const error = await response.json();
                    this.onError(`File upload failed: ${error.detail}`);
                    this._renderFilePreviews();
                    this._notifyChange();
                    continue;
                }

                const data = await response.json();
                const fileEntry = {
                    name: data.stored_name,
                    path: data.path,
                    size: data.size,
                    originalName: data.filename,
                };

                // Switched tabs mid-flight — pendingFiles is the new session's
                // list now, so don't attach this file to it. The upload itself
                // still succeeded under the original session (it's on disk
                // there), which the WidgetBus event below reports.
                if (this._isForeignSession(sessionId)) {
                    this._renderFilePreviews();
                    this._notifyChange();
                    WidgetBus.emit('uploads:changed', { sessionId });
                    continue;
                }

                // Replace existing entry with same name, or append
                const existingIdx = this.pendingFiles.findIndex(f => f.name === data.stored_name);
                if (existingIdx >= 0) {
                    this.pendingFiles[existingIdx] = fileEntry;
                } else {
                    this.pendingFiles.push(fileEntry);
                }

                this._renderFilePreviews();
                this._notifyChange();

                // Notify uploads widget that files changed (file is already on disk)
                if (sessionId) {
                    WidgetBus.emit('uploads:changed', { sessionId });
                }
            } catch (error) {
                this.uploadingFiles = this.uploadingFiles.filter(f => f.id !== uploadId);
                this.onError(`File upload error: ${error.message}`);
                this._renderFilePreviews();
                this._notifyChange();
            }
        }
    }

    /**
     * Render file previews
     */
    _renderFilePreviews() {
        let container = $('#file-previews');

        // Only create container if we have files to show
        const hasFiles = this.uploadingFiles.length > 0 || this.pendingFiles.length > 0;

        if (!container && hasFiles) {
            container = document.createElement('div');
            container.id = 'file-previews';
            // Insert before image-previews if it exists, otherwise before textarea wrapper
            const imagePreviews = $('#image-previews');
            if (imagePreviews && imagePreviews.parentNode === this.els.inputContainer) {
                this.els.inputContainer.insertBefore(container, imagePreviews);
            } else {
                const textareaWrapper = this.els.inputContainer.querySelector('.input-textarea-wrapper');
                if (textareaWrapper) {
                    this.els.inputContainer.insertBefore(container, textareaWrapper);
                } else {
                    this.els.inputContainer.appendChild(container);
                }
            }
        }

        // If no container and no files, nothing to do
        if (!container) return;

        const formatSize = (bytes) => {
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        };

        const getFileIcon = (name) => {
            const ext = name.split('.').pop()?.toLowerCase();
            const codeExts = ['js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'css', 'html', 'vue', 'svelte'];
            const dataExts = ['json', 'yaml', 'yml', 'xml', 'csv', 'sql'];
            const docExts = ['md', 'txt', 'rst', 'doc', 'docx', 'pdf'];
            if (codeExts.includes(ext)) return '📝';
            if (dataExts.includes(ext)) return '📊';
            if (docExts.includes(ext)) return '📄';
            return '📎';
        };

        const uploadingHtml = this.uploadingFiles.map(f => `
            <div class="file-preview uploading" data-upload-id="${f.id}">
                <span class="file-icon">⏳</span>
                <span class="file-name">${escapeHtml(f.name)}</span>
                <span class="file-spinner"></span>
            </div>
        `).join('');

        const pendingHtml = this.pendingFiles.map((f, idx) => `
            <div class="file-preview" data-index="${idx}">
                <span class="file-icon">${getFileIcon(f.name)}</span>
                <span class="file-name">${escapeHtml(f.name)}</span>
                <span class="file-size">${formatSize(f.size)}</span>
                <button class="file-remove" data-index="${idx}" data-tooltip="${S.upload_manager.remove_file}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                </button>
            </div>
        `).join('');

        container.innerHTML = uploadingHtml + pendingHtml;

        container.querySelectorAll('.file-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.removeFile(parseInt(btn.dataset.index));
            });
        });

        // Click to preview, context menu for options
        container.querySelectorAll('.file-preview:not(.uploading)').forEach(chip => {
            const idx = parseInt(chip.dataset.index);
            const file = this.pendingFiles[idx];
            if (!file) return;

            // Click → preview
            chip.addEventListener('click', (e) => {
                if (e.target.closest('.file-remove')) return;
                e.preventDefault();
                this._openFilePreview(file.path);
            });

            // Right-click → context menu
            chip.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._showFileContextMenu(e.clientX, e.clientY, file, idx);
            });

            // Long-press for touch → context menu
            chip.addEventListener('touchstart', (e) => {
                if (e.target.closest('.file-remove')) return;
                this._longPressTimer = setTimeout(() => {
                    this._longPressTimer = null;
                    const touch = e.touches[0];
                    this._showFileContextMenu(touch.clientX, touch.clientY, file, idx);
                }, 500);
            }, { passive: true });
            chip.addEventListener('touchend', () => {
                if (this._longPressTimer) {
                    clearTimeout(this._longPressTimer);
                    this._longPressTimer = null;
                }
            });
            chip.addEventListener('touchmove', () => {
                if (this._longPressTimer) {
                    clearTimeout(this._longPressTimer);
                    this._longPressTimer = null;
                }
            });
        });

        container.classList.toggle('visible', hasFiles);
    }

    /**
     * Render image previews
     */
    _renderImagePreviews() {
        let container = $('#image-previews');

        // Only create container if we have images to show
        const hasImages = this.uploadingImages.length > 0 || this.pendingImages.length > 0;

        if (!container && hasImages) {
            container = document.createElement('div');
            container.id = 'image-previews';
            // Insert before the textarea wrapper (a direct child of inputContainer)
            const textareaWrapper = this.els.inputContainer.querySelector('.input-textarea-wrapper');
            if (textareaWrapper) {
                this.els.inputContainer.insertBefore(container, textareaWrapper);
            } else {
                this.els.inputContainer.appendChild(container);
            }
        }

        // If no container and no images, nothing to do
        if (!container) return;

        const uploadingHtml = this.uploadingImages.map(img => `
            <div class="image-preview uploading" data-upload-id="${img.id}">
                <img src="${img.preview}" alt="Uploading...">
                <div class="upload-spinner">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="8"/>
                    </svg>
                </div>
            </div>
        `).join('');

        const pendingHtml = this.pendingImages.map((img, idx) => `
            <div class="image-preview" data-index="${idx}">
                <img src="${img.preview}" alt="Upload preview">
                <button class="image-annotate" data-index="${idx}" data-tooltip="${S.upload_manager.annotate_image}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
                    </svg>
                </button>
                <button class="image-remove" data-index="${idx}" data-tooltip="${S.upload_manager.remove_image}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                </button>
            </div>
        `).join('');

        container.innerHTML = uploadingHtml + pendingHtml;

        container.querySelectorAll('.image-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.removeImage(parseInt(btn.dataset.index));
            });
        });

        container.querySelectorAll('.image-annotate').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.editImage(parseInt(btn.dataset.index));
            });
        });

        // Click a pending thumbnail → open the annotation editor directly
        // (annotating is the primary intent; the pencil button is the same
        // action). Uploading thumbnails have no pending index — skip them.
        container.querySelectorAll('.image-preview:not(.uploading) img').forEach(img => {
            img.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const wrap = img.closest('.image-preview[data-index]');
                if (wrap) this.editImage(parseInt(wrap.dataset.index));
            });
        });

        container.classList.toggle('visible', hasImages);
    }

    /**
     * Notify that upload state changed
     */
    _notifyChange() {
        this.onStateChange();
    }

    /** Register an in-flight batch against the session that started it. */
    _beginBatch() {
        const batch = { session: this.getSessionId() };
        this._activeBatchSessions.push(batch);
        return batch;
    }

    _endBatch(batch) {
        const i = this._activeBatchSessions.indexOf(batch);
        if (i !== -1) this._activeBatchSessions.splice(i, 1);
    }

    /**
     * Does `session` belong to a different session than the one on screen?
     *
     * Deliberately false when either id is missing: a fresh tab has no storeId
     * until it connects, so an image pasted into it starts a batch with a null
     * session and would otherwise be judged "foreign" the moment the id is
     * assigned mid-upload — dropping a perfectly good attachment.
     */
    _isForeignSession(session) {
        const current = this.getSessionId();
        return !!(session && current && session !== current);
    }

    // ─────────────────────────────────────────────────────────────────
    // File preview & context menu
    // ─────────────────────────────────────────────────────────────────

    /**
     * Open file in the inline preview widget
     */
    _openFilePreview(filePath) {
        window.app?.previewFile(filePath);
    }

    /**
     * Show context menu for a file chip
     */
    _showFileContextMenu(x, y, file, index) {
        this._contextMenu.show(x, y, [
            {
                label: S.context_menus.file.preview,
                action: () => this._openFilePreview(file.path),
            },
            {
                label: S.widgets.header_actions.copy_path,
                action: async () => {
                    await copyToClipboard(file.path);
                    showToast(S.toast.path_copied);
                },
            },
            { separator: true },
            {
                label: S.common.delete,
                action: () => this.removeFile(index),
            },
        ]);
    }

    // ─────────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────────

    /**
     * Open image file picker
     */
    openImagePicker() {
        this.imageInput.click();
    }

    /**
     * Open general file picker
     */
    openFilePicker() {
        this.fileInput.click();
    }

    /**
     * Remove a pending file
     */
    removeFile(index) {
        if (index >= 0 && index < this.pendingFiles.length) {
            this.pendingFiles.splice(index, 1);
            this._renderFilePreviews();
            this._notifyChange();
        }
    }

    /**
     * Remove a pending image
     */
    removeImage(index) {
        if (index >= 0 && index < this.pendingImages.length) {
            URL.revokeObjectURL(this.pendingImages[index].preview);
            this.pendingImages.splice(index, 1);
            this._renderImagePreviews();
            this._notifyChange();
        }
    }

    /**
     * Clear all pending files
     */
    clearFiles() {
        this.pendingFiles = [];
        this._renderFilePreviews();
    }

    /**
     * Clear all pending images
     */
    clearImages() {
        this.pendingImages.forEach(img => URL.revokeObjectURL(img.preview));
        this.pendingImages = [];
        this._renderImagePreviews();
    }

    /**
     * Clear all pending uploads
     */
    clear() {
        this.clearFiles();
        this.clearImages();
    }

    /**
     * Save current upload state (for session switching).
     * Returns arrays that can be stored on a Session object.
     * Does NOT revoke blob URLs — the session still owns them.
     */
    saveState() {
        return {
            pendingImages: this.pendingImages.slice(),
            pendingFiles: this.pendingFiles.slice()
        };
    }

    /**
     * Restore upload state (for session switching).
     * Replaces current state and re-renders previews.
     */
    restoreState(state) {
        // Clear current without revoking URLs (they belong to the outgoing session)
        this.pendingImages = state?.pendingImages || [];
        this.pendingFiles = state?.pendingFiles || [];
        this.uploadingImages = [];
        this.uploadingFiles = [];
        this._renderImagePreviews();
        this._renderFilePreviews();
        this._notifyChange();
    }

    /**
     * Restore uploads from server after page refresh.
     * Fetches images from server to reconstruct imageData and blob URLs.
     * Files are metadata-only (already on disk server-side).
     *
     * @param {Object} metadata - {images: [{storedName, mediaType}], files: [{name, path, size, originalName}]}
     * @param {string} sessionId - The server-side session storeId
     */
    async restoreFromServer(metadata, sessionId) {
        if (!metadata || !sessionId) return;
        const { images = [], files = [] } = metadata;

        // Restore files (metadata-only, no server fetch needed)
        if (files.length > 0) {
            this.pendingFiles = files.slice();
            this._renderFilePreviews();
        }

        // Restore images (fetch from server for base64 + preview)
        if (images.length > 0) {
            for (const imgMeta of images) {
                try {
                    const resp = await fetch(
                        `${this.apiBase}/api/sessions/${encodeURIComponent(sessionId)}/uploads/${encodeURIComponent(imgMeta.storedName)}?base64_encode=true`
                    );
                    if (!resp.ok) {
                        console.warn(`[UploadManager] Failed to restore image ${imgMeta.storedName}: ${resp.status}`);
                        continue;
                    }
                    const data = await resp.json();

                    // Reconstruct Claude API imageData
                    const imageData = {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: data.media_type,
                            data: data.data
                        }
                    };

                    // Create blob URL for preview
                    const preview = URL.createObjectURL(this._base64Blob(data.data, data.media_type));

                    this.pendingImages.push({
                        file: null,
                        preview,
                        imageData,
                        storedName: imgMeta.storedName,
                        mediaType: data.media_type,
                    });
                } catch (err) {
                    console.warn(`[UploadManager] Error restoring image ${imgMeta.storedName}:`, err);
                }
            }
            this._renderImagePreviews();
        }

        if (images.length > 0 || files.length > 0) {
            this._notifyChange();
        }
    }

    /**
     * Get pending images for sending
     */
    getPendingImages() {
        return this.pendingImages.map(img => img.imageData);
    }

    /**
     * Get pending files for message text
     */
    getPendingFiles() {
        return this.pendingFiles.slice();
    }

    /**
     * Check if there are pending uploads
     */
    get hasPending() {
        return this.pendingImages.length > 0 || this.pendingFiles.length > 0;
    }

    /**
     * Check if there are active uploads
     */
    get isUploading() {
        // Only batches belonging to the session on screen count — see
        // _activeBatchSessions in the constructor.
        return this._activeBatchSessions.some(b => !this._isForeignSession(b.session)) ||
               this.uploadingImages.length > 0 ||
               this.uploadingFiles.length > 0;
    }
}
