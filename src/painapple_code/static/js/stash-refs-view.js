/**
 * Shared renderer for stash references.
 *
 * One shape, two surfaces: the sent-message bubble (chat-controller) and the
 * arrow-up recall hint (input-handler). Both read the same compact ref objects
 * — `{type, filePath, selectedText, note, messageIndex, markerIndex}` — that
 * the send path stores on the message and on the history entry, so they must
 * not be allowed to drift into two different-looking previews of one thing.
 *
 * Every interpolated field is escaped here; callers pass raw values.
 */

import { escapeHtml } from './utils.js';
import { basename } from './path-utils.js';
import S from './strings.js';

const PREVIEW_CHARS = 100;

/**
 * @param {Array} refs - compact stash references
 * @param {Object} [opts]
 * @param {string} [opts.label] - override the summary text (raw; escaped here)
 * @param {boolean} [opts.open] - force expanded/collapsed (default: single ref)
 * @returns {string} HTML for a collapsible references block
 */
export function renderStashRefs(refs, { label = null, open = null } = {}) {
    if (!Array.isArray(refs) || refs.length === 0) return '';

    const count = refs.length;
    const refsHtml = refs.map(ref => {
        const text = ref.selectedText || '';
        const preview = text.length > PREVIEW_CHARS
            ? text.slice(0, PREVIEW_CHARS) + '...'
            : text;
        const noteHtml = ref.note
            ? `<div class="ref-note">💬 ${escapeHtml(ref.note)}</div>`
            : '';

        let sourceLabel;
        if (ref.type === 'file') {
            sourceLabel = `📄 ${escapeHtml(basename(ref.filePath) || 'file')}`;
        } else if (ref.type === 'image') {
            const name = escapeHtml(basename(ref.filePath) || 'image');
            sourceLabel = ref.markerIndex != null
                ? `📍 ${name} · marker ${ref.markerIndex}`
                : `📍 ${name}`;
        } else {
            sourceLabel = `💬 Message #${ref.messageIndex || '?'}`;
        }

        // Image-marker refs have no quoted selection — the note carries it
        const textHtml = preview ? `<div class="ref-text">"${escapeHtml(preview)}"</div>` : '';

        return `
                <div class="stash-ref-item">
                    <div class="ref-source">${sourceLabel}</div>
                    ${textHtml}
                    ${noteHtml}
                </div>
            `;
    }).join('');

    const summary = label !== null
        ? escapeHtml(label)
        : escapeHtml(
            count === 1
                ? S.ui.stash.refs_attached_one
                : S.ui.stash.refs_attached_many.replace('{count}', count)
        );
    const isOpen = open === null ? count === 1 : open;

    return `
            <details class="stash-refs-block" ${isOpen ? 'open' : ''}>
                <summary class="stash-refs-header">
                    <span class="refs-icon">📎</span>
                    <span class="refs-count">${summary}</span>
                </summary>
                <div class="stash-refs-content">
                    ${refsHtml}
                </div>
            </details>
        `;
}
