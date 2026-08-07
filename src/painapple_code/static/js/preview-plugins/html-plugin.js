/**
 * HTML preview plugin
 *
 * Handles: .html, .htm
 * Adds a "Rendered" view mode that loads the file in a sandboxed iframe
 * via /api/browser/render (same endpoint as the Browser widget, so
 * relative refs resolve through /api/browser/asset). Falls through to
 * the core code/edit views for source viewing and inline editing.
 */

import { CONFIG, escapeHtml } from './plugin-helpers.js';

// Auto-resize iframes to their internal content height so the parent
// wrap (overflow: auto) is the actual scroll surface. Without this,
// desktop wheel only scrolls when the cursor is over a <table> (WebKit
// hit-test quirk routes wheel events differently for table cells); over
// any other element the wheel finds no scrollable target and dies.
// Server injects a script that postMessages document.scrollHeight on
// load / resize / DOM mutation; we match the source iframe and size it.
// Registered once per page — the listener is global, scoped by class.
if (typeof window !== 'undefined' && !window.__paHtmlAutosize) {
    window.__paHtmlAutosize = true;
    window.addEventListener('message', (e) => {
        const data = e.data;
        if (!data) return;

        // Autoresize: match the source iframe and size it to its content.
        if (data.type === 'painapple-html-height') {
            const h = Number(data.height);
            if (!Number.isFinite(h) || h <= 0) return;
            const frames = document.querySelectorAll('iframe.preview-html-frame');
            for (const f of frames) {
                if (f.contentWindow === e.source) {
                    const px = h + 'px';
                    if (f.style.height !== px) f.style.height = px;
                    break;
                }
            }
            return;
        }

        // Escape-forward from inside the iframe. Once focus is in the
        // iframe, the iframe owns its own keydowns — the parent never
        // sees them, and Esc stops closing the preview widget. The
        // injected script forwards Escape; we re-dispatch it on the
        // parent document so the normal handleEscape priority chain
        // runs (close inline-edit → close widget tab → closeTopmost).
        if (data.type === 'painapple-html-key' && data.key === 'Escape') {
            // Verify the source is one of our iframes (don't trust any
            // random window that learnt the message name).
            const frames = document.querySelectorAll('iframe.preview-html-frame');
            let recognised = false;
            for (const f of frames) {
                if (f.contentWindow === e.source) { recognised = true; break; }
            }
            if (!recognised) return;
            document.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Escape',
                code: 'Escape',
                bubbles: true,
                cancelable: true,
            }));
        }
    });
}

export default {
    id: 'html',

    match(path) {
        const ext = path?.split('.').pop()?.toLowerCase();
        return ext === 'html' || ext === 'htm';
    },

    needsFetch: true,
    editable: true,

    viewModes: [{
        mode: 'rendered',
        label: 'Rendered',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    }],

    defaultViewMode: 'rendered',

    initState() { return {}; },

    renderBody(state) {
        if (state.viewMode !== 'rendered') return null;

        const path = state.currentPath || '';
        const src = `${CONFIG.API_BASE}/api/browser/render?path=${encodeURIComponent(path)}`;

        return `
            <div class="preview-body preview-html-body">
                <iframe class="preview-html-frame"
                        sandbox="allow-scripts"
                        referrerpolicy="no-referrer"
                        scrolling="yes"
                        src="${escapeHtml(src)}"></iframe>
            </div>
        `;
    },
};
