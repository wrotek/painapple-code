/**
 * UploadsWidget - Browse images and files uploaded to the current session
 *
 * Shows a grid of image thumbnails and a list of non-image files.
 * Clicking an image opens the image preview modal; clicking a file opens file preview.
 *
 * Refreshes automatically when:
 * - Widget is first opened (render)
 * - Widget becomes visible again (onOpen)
 * - User sends a message with images (uploads:changed event)
 * - User clicks the refresh button (onRefresh)
 */

import { WidgetManager, WidgetBus, ICONS } from '../widget-system/index.js';
import { ImagePreviewWidget } from './image-preview-widget.js';
import { CONFIG } from '../config.js';
import { formatSize, escapeHtml } from '../utils.js';
import { ContextMenu, copyToClipboard, copyImageToClipboard, showToast, lastInputWasTouch } from '../context-menu.js';
import S from '../strings.js';

// Shared context menu for image/file thumbnails
const contextMenu = new ContextMenu();

// ============================================================================
// Per-instance state (keyed by sessionId to avoid singleton issues)
// ============================================================================

const instances = new Map(); // sessionId -> { files, loading, error, container, ctx, onlyThisSession }

const PREF_KEY = 'uploads-widget:only-this-session';

function readPref() {
    try {
        const v = localStorage.getItem(PREF_KEY);
        return v === null ? true : v === 'true';
    } catch {
        return true;
    }
}

function writePref(value) {
    try { localStorage.setItem(PREF_KEY, String(value)); } catch {}
}

function getState(sessionId) {
    if (!instances.has(sessionId)) {
        instances.set(sessionId, {
            files: [],
            loading: false,
            error: null,
            container: null,
            ctx: null,
            onlyThisSession: readPref(),
        });
    }
    return instances.get(sessionId);
}

// Track the "current" sessionId for the public refresh() API
let activeSessionId = null;

// ============================================================================
// Data Fetching
// ============================================================================

async function loadUploads(sessionId, onlyThisSession) {
    if (!sessionId) return [];
    const scope = onlyThisSession ? 'session' : 'project';
    const resp = await fetch(`${CONFIG.API_BASE}/api/sessions/${sessionId}/uploads?scope=${scope}`);
    if (!resp.ok) throw new Error(`Failed to load uploads: ${resp.status}`);
    const data = await resp.json();
    return data.files || [];
}

// ============================================================================
// Rendering
// ============================================================================

function getUploadUrl(sessionId, filename) {
    return `${CONFIG.API_BASE}/api/sessions/${sessionId}/uploads/${encodeURIComponent(filename)}`;
}

// Paperclip — "attach this upload to the message input"
const ATTACH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';

function attachButtonHtml(name, ownerId) {
    return `<button class="uploads-attach" data-action="attach" data-name="${escapeHtml(name)}" data-owner="${escapeHtml(ownerId)}" data-tooltip="${S.uploads.attach_tooltip}" aria-label="${S.uploads.attach}">${ATTACH_ICON}</button>`;
}

/**
 * Re-attach a stored upload to the current session's message input.
 * Looks the entry up in widget state so the manager gets the full record
 * (owning session + absolute path), not just a filename. In project scope the
 * same filename can exist under several sessions, so the owner disambiguates.
 *
 * @param {string} widgetSessionId - the instance key (widget's own session)
 * @param {string} name - upload filename
 * @param {string} ownerId - session the upload is stored under
 */
async function attachUpload(widgetSessionId, name, ownerId) {
    const st = instances.get(widgetSessionId);
    const entry = st?.files.find(f => f.name === name && (!ownerId || f.session_id === ownerId))
        || st?.files.find(f => f.name === name);
    if (!entry) return;

    const manager = window.app?.uploadManager;
    if (!manager) return;
    if (!manager.getSessionId()) {
        showToast(S.uploads.attach_no_session);
        return;
    }

    if (await manager.attachStored(entry)) {
        showToast(S.uploads.attached.replace('{name}', entry.name));
        window.app?.focusInput?.();
    }
}

function filterBarHtml(onlyThisSession) {
    const checked = onlyThisSession ? 'checked' : '';
    return `
        <div class="uploads-filter-bar">
            <label class="uploads-filter-checkbox">
                <input type="checkbox" data-action="toggle-scope" ${checked}>
                <span>${S.uploads.only_this_session}</span>
            </label>
        </div>
    `;
}

function renderContent(sessionId) {
    const st = instances.get(sessionId);
    if (!st || !st.container) return;

    const bar = filterBarHtml(st.onlyThisSession);

    if (st.loading) {
        st.container.innerHTML = bar + '<div class="uploads-loading">Loading...</div>';
        return;
    }

    if (st.error) {
        st.container.innerHTML = bar + `<div class="uploads-error">${escapeHtml(st.error)}</div>`;
        return;
    }

    if (st.files.length === 0) {
        const hint = st.onlyThisSession
            ? S.uploads.empty_session
            : S.uploads.empty_project;
        st.container.innerHTML = bar + `
            <div class="uploads-empty">
                <div class="uploads-empty-icon">${ICONS.image}</div>
                <div>${S.uploads.empty_title}</div>
                <div class="uploads-empty-hint">${hint}</div>
            </div>
        `;
        return;
    }

    const images = st.files.filter(f => f.is_image);
    const files = st.files.filter(f => !f.is_image);

    let html = bar;

    // Image grid
    if (images.length > 0) {
        html += '<div class="uploads-section">';
        html += `<div class="uploads-section-label">Images (${images.length})</div>`;
        html += '<div class="uploads-grid">';
        for (const img of images) {
            const sid = img.session_id || sessionId;
            const url = getUploadUrl(sid, img.name);
            html += `
                <div class="uploads-thumb" data-action="preview-image" data-url="${url}" data-name="${escapeHtml(img.name)}" data-owner="${escapeHtml(sid)}" data-tooltip="${img.name} (${formatSize(img.size)})">
                    <img src="${url}" alt="${img.name}" loading="lazy">
                    ${attachButtonHtml(img.name, sid)}
                </div>
            `;
        }
        html += '</div></div>';
    }

    // File list
    if (files.length > 0) {
        html += '<div class="uploads-section">';
        html += `<div class="uploads-section-label">Files (${files.length})</div>`;
        html += '<div class="uploads-file-list">';
        for (const f of files) {
            const sid = f.session_id || sessionId;
            html += `
                <div class="uploads-file-item" data-action="preview-file" data-name="${f.name}" data-session="${sid}">
                    <span class="uploads-file-icon">${ICONS.file}</span>
                    <span class="uploads-file-name">${f.name}</span>
                    <span class="uploads-file-size">${formatSize(f.size)}</span>
                    ${attachButtonHtml(f.name, sid)}
                </div>
            `;
        }
        html += '</div></div>';
    }

    st.container.innerHTML = html;

    // Update summary
    if (st.ctx) {
        const parts = [];
        if (images.length > 0) parts.push(`${images.length} image${images.length > 1 ? 's' : ''}`);
        if (files.length > 0) parts.push(`${files.length} file${files.length > 1 ? 's' : ''}`);
        st.ctx.setSummary(parts.join(', '));
    }
}

// ============================================================================
// Event Handling
// ============================================================================

function handleClick(e) {
    const sessionId = e.currentTarget._uploadsSessionId;

    // Attach button wins over the row/thumb it sits inside
    const attachBtn = e.target.closest('[data-action="attach"]');
    if (attachBtn) {
        e.preventDefault();
        e.stopPropagation();
        attachUpload(sessionId, attachBtn.dataset.name, attachBtn.dataset.owner);
        return;
    }

    const thumb = e.target.closest('[data-action="preview-image"]');
    if (thumb) {
        ImagePreviewWidget.show(thumb.dataset.url);
        return;
    }

    const fileItem = e.target.closest('[data-action="preview-file"]');
    if (fileItem) {
        const sid = fileItem.dataset.session || sessionId;
        if (!sid) return;
        const url = getUploadUrl(sid, fileItem.dataset.name);
        window.open(url, '_blank');
    }
}

function handleChange(e) {
    const sessionId = e.currentTarget._uploadsSessionId;
    const toggle = e.target.closest('[data-action="toggle-scope"]');
    if (!toggle || !sessionId) return;
    const st = getState(sessionId);
    st.onlyThisSession = !!toggle.checked;
    writePref(st.onlyThisSession);
    refreshSession(sessionId);
}

/** Absolute URL for a (possibly root-relative) upload url. */
function absoluteUrl(url) {
    try { return new URL(url, location.origin).href; }
    catch { return url; }
}

/** Build the context-menu items for an image thumbnail. */
function imageMenuItems(url, widgetSessionId, name, ownerId) {
    const abs = absoluteUrl(url);
    return [
        { label: S.uploads.attach, action: () => attachUpload(widgetSessionId, name, ownerId) },
        { separator: true },
        { label: S.context_menus.image.preview, action: () => ImagePreviewWidget.show(url) },
        { separator: true },
        {
            label: S.context_menus.image.copy_image,
            action: async () => {
                if (await copyImageToClipboard(url)) { showToast(S.toast.image_copied); return; }
                // iPad PWA / older Safari can't put image bytes on the clipboard
                // — fall back to the link so the action still does something.
                showToast(await copyToClipboard(abs) ? S.toast.image_copy_fell_back : S.toast.image_copy_failed);
            },
        },
        {
            label: S.context_menus.image.copy_link,
            action: async () => { if (await copyToClipboard(abs)) showToast(S.toast.link_copied); },
        },
        { separator: true },
        { label: S.context_menus.image.open_new_tab, action: () => window.open(abs, '_blank') },
    ];
}

/** Build the context-menu items for a non-image file row. */
function fileMenuItems(url, widgetSessionId, name, ownerId) {
    const abs = absoluteUrl(url);
    return [
        { label: S.uploads.attach, action: () => attachUpload(widgetSessionId, name, ownerId) },
        { separator: true },
        { label: S.context_menus.image.open_new_tab, action: () => window.open(abs, '_blank') },
        {
            label: S.context_menus.image.copy_link,
            action: async () => { if (await copyToClipboard(abs)) showToast(S.toast.link_copied); },
        },
    ];
}

function handleContextMenu(e) {
    const sessionId = e.currentTarget._uploadsSessionId;
    const thumb = e.target.closest('[data-action="preview-image"]');
    if (thumb) {
        // On touch, yield to the native iOS callout — it can actually copy
        // image bytes, which the clipboard API can't inside an iPad PWA.
        if (lastInputWasTouch()) return;
        e.preventDefault();
        e.stopPropagation();
        contextMenu.show(e.clientX, e.clientY, imageMenuItems(
            thumb.dataset.url, sessionId, thumb.dataset.name, thumb.dataset.owner,
        ));
        return;
    }
    const fileItem = e.target.closest('[data-action="preview-file"]');
    if (fileItem) {
        const sid = fileItem.dataset.session || sessionId;
        if (!sid) return;
        e.preventDefault();
        e.stopPropagation();
        contextMenu.show(e.clientX, e.clientY, fileMenuItems(
            getUploadUrl(sid, fileItem.dataset.name), sessionId, fileItem.dataset.name, sid,
        ));
    }
}

// Long-press → context menu for touch devices (iPad has no right-click).
// Images are deliberately EXCLUDED: WebKit shows its own callout for them,
// which is the only way to get real image bytes onto an iPad clipboard.
// Non-image files get no native menu, so they keep the custom one.
let longPressTimer = null;

function handleTouchStart(e) {
    const sessionId = e.currentTarget._uploadsSessionId;
    const fileItem = e.target.closest('[data-action="preview-file"]');
    if (!fileItem) return;
    const touch = e.touches[0];
    longPressTimer = setTimeout(() => {
        longPressTimer = null;
        const sid = fileItem.dataset.session || sessionId;
        if (sid) contextMenu.show(touch.clientX, touch.clientY, fileMenuItems(
            getUploadUrl(sid, fileItem.dataset.name), sessionId, fileItem.dataset.name, sid,
        ));
    }, 500);
}

function cancelLongPress() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
}

// ============================================================================
// Refresh
// ============================================================================

async function refreshSession(sessionId) {
    if (!sessionId) return;
    const st = getState(sessionId);
    st.loading = true;
    st.error = null;
    renderContent(sessionId);
    try {
        st.files = await loadUploads(sessionId, st.onlyThisSession);
    } catch (e) {
        st.error = e.message;
    }
    st.loading = false;
    renderContent(sessionId);
}

/** Public refresh — refreshes the active session's widget */
async function refresh() {
    if (activeSessionId) {
        await refreshSession(activeSessionId);
    }
}

// ============================================================================
// Bus event listener (auto-refresh when images are uploaded)
// ============================================================================

let busListenerAttached = false;

function attachBusListener() {
    if (busListenerAttached) return;
    busListenerAttached = true;

    WidgetBus.on('uploads:changed', ({ sessionId }) => {
        // Only refresh if the widget instance exists for this session
        if (sessionId && instances.has(sessionId)) {
            refreshSession(sessionId);
        }
    });
}

// ============================================================================
// Widget Registration
// ============================================================================

export function registerUploadsWidget() {
    WidgetManager.register('uploads', {
        title: S.widgets.titles.uploads,
        icon: 'image',
        type: 'floating',
        scope: 'session',
        resizable: true,
        size: { width: 400, height: 350 },
        minSize: { width: 280, height: 200 },
        allowedTypes: ['floating', 'sidebar-right', 'bottom-sheet'],

        onRefresh: refresh,

        onOpen() {
            // Re-fetch data whenever the widget becomes visible
            refresh();
        },

        render(container, ctx) {
            const sessionId = ctx.sessionId;
            activeSessionId = sessionId;
            const st = getState(sessionId);
            st.container = container;
            st.ctx = ctx;

            container.classList.add('uploads-widget-content');
            container._uploadsSessionId = sessionId;
            container.addEventListener('click', handleClick);
            container.addEventListener('change', handleChange);
            container.addEventListener('contextmenu', handleContextMenu);
            container.addEventListener('touchstart', handleTouchStart, { passive: true });
            container.addEventListener('touchend', cancelLongPress);
            container.addEventListener('touchmove', cancelLongPress);

            // Attach bus listener once (listens for uploads:changed)
            attachBusListener();

            refreshSession(sessionId);
        },

        onSessionChange(sessionId) {
            activeSessionId = sessionId;
            refreshSession(sessionId);
        },

        onClose() {
            // Don't clear state — keep cached data for re-open
        },

        onDestroy() {
            if (activeSessionId) {
                instances.delete(activeSessionId);
            }
        }
    });
}

// Public API
export const UploadsWidget = {
    open: () => WidgetManager.open('uploads'),
    close: () => WidgetManager.close('uploads'),
    refresh,
};
