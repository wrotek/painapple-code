/**
 * Session preview bottom sheet — quick peek at a session's recent messages
 * without opening it as a full tab.
 *
 * The preview is a separate DOM subtree appended to the welcome container;
 * `updatePreviewUI` swaps it in/out without re-rendering the entire welcome
 * screen, so the surrounding card grid keeps its scroll position.
 */

import { CONFIG } from '../config.js';
import { escapeHtml, formatRelativeTime } from '../utils.js';
import { state, saveWelcomeState } from './state.js';

/**
 * Load session messages for preview.
 */
async function loadPreviewMessages(sessionId) {
    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/sessions/${sessionId}/logs/messages?limit=10`);
        if (!response.ok) throw new Error('Failed to load messages');
        const data = await response.json();
        return data.messages || [];
    } catch (e) {
        console.error('Failed to load preview messages:', e);
        return [];
    }
}

/**
 * Render the session preview bottom sheet.
 */
function renderPreviewSheet(session, messages, isLoading) {
    if (!session) return '';

    const name = session.name || session.project || 'Session';
    const timeAgo = formatRelativeTime(session.last_activity || session.created_at);
    const tags = session.tags || [];
    const summary = session.summary || '';

    return `
        <div class="session-preview-overlay" data-action="close-preview"></div>
        <div class="session-preview-sheet">
            <div class="preview-header">
                <div class="preview-title">
                    <span class="preview-name">${escapeHtml(name)}</span>
                    <span class="preview-project">${escapeHtml(session.project || '')}</span>
                </div>
                <button class="preview-close" data-action="close-preview">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>

            <div class="preview-meta">
                <span class="preview-time">${timeAgo}</span>
                ${tags.length > 0 ? `
                    <div class="preview-tags">
                        ${tags.slice(0, 4).map(t => `<span class="welcome-tag">${escapeHtml(t)}</span>`).join('')}
                    </div>
                ` : ''}
            </div>

            ${summary ? `<div class="preview-summary">${escapeHtml(summary)}</div>` : ''}

            <div class="preview-messages">
                <div class="preview-messages-header">Recent Messages</div>
                ${isLoading ? `
                    <div class="preview-loading">
                        <div class="loading-spinner"></div>
                        <span>Loading...</span>
                    </div>
                ` : messages.length > 0 ? `
                    <div class="preview-messages-list">
                        ${messages.slice(0, 8).map(msg => `
                            <div class="preview-message preview-message--${msg.role || 'unknown'}">
                                <span class="preview-msg-role">${msg.role || 'message'}</span>
                                <span class="preview-msg-text">${escapeHtml(truncateText(msg.content || '', 120))}</span>
                            </div>
                        `).join('')}
                    </div>
                ` : `
                    <div class="preview-empty">No messages yet</div>
                `}
            </div>

            <div class="preview-actions">
                <button class="welcome-btn welcome-btn--primary" data-action="preview-open">
                    Open Session
                </button>
                <button class="welcome-btn welcome-btn--secondary" data-action="preview-open-new-tab">
                    Open in New Tab
                </button>
                <button class="welcome-btn welcome-btn--fork" data-action="preview-fork">
                    Fork
                </button>
            </div>
        </div>
    `;
}

/**
 * Truncate text to max length with ellipsis.
 */
function truncateText(text, maxLength) {
    if (!text) return '';
    // Remove newlines and extra whitespace
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '...';
}

/**
 * Show session preview.
 */
export async function showPreview(session, container) {
    state.previewSession = session;
    state.previewMessages = null;
    state.previewLoading = true;

    // Render loading state
    updatePreviewUI(container);

    // Load messages
    const messages = await loadPreviewMessages(session.session_id);
    state.previewMessages = messages;
    state.previewLoading = false;

    // Re-render with messages
    updatePreviewUI(container);
}

/**
 * Update preview UI without re-rendering entire welcome screen.
 */
export function updatePreviewUI(container) {
    // Remove existing preview
    const existingPreview = container.querySelector('.session-preview-overlay');
    const existingSheet = container.querySelector('.session-preview-sheet');
    if (existingPreview) existingPreview.remove();
    if (existingSheet) existingSheet.remove();

    // Add new preview if session is set
    if (state.previewSession) {
        const previewHtml = renderPreviewSheet(
            state.previewSession,
            state.previewMessages || [],
            state.previewLoading
        );
        container.insertAdjacentHTML('beforeend', previewHtml);
        attachPreviewListeners(container);
    }
}

/**
 * Close the preview.
 */
export function closePreview(container) {
    state.previewSession = null;
    state.previewMessages = null;
    state.previewLoading = false;
    updatePreviewUI(container);
}

/**
 * Close session preview if open (exported for global Escape handling).
 * @returns {boolean} True if preview was closed
 */
export function closeSessionPreview() {
    if (!state.previewSession) return false;
    const container = document.getElementById('welcome-container');
    if (!container) return false;
    closePreview(container);
    return true;
}

/**
 * Attach preview event listeners.
 */
export function attachPreviewListeners(container) {
    // Close preview on click
    container.querySelectorAll('[data-action="close-preview"]').forEach(el => {
        el.addEventListener('click', () => closePreview(container));
    });

    // Close preview on Escape key
    const escapeHandler = (e) => {
        if (e.key === 'Escape' && state.previewSession) {
            e.preventDefault();
            e.stopPropagation();
            closePreview(container);
            document.removeEventListener('keydown', escapeHandler);
        }
    };
    document.addEventListener('keydown', escapeHandler);

    // Open session (current tab)
    container.querySelector('[data-action="preview-open"]')?.addEventListener('click', () => {
        const session = state.previewSession;
        if (session) {
            // Save state before opening (for "back to sessions" feature)
            saveWelcomeState(container);
            closePreview(container);
            window.dispatchEvent(new CustomEvent('welcome:open-session', {
                detail: { sessionId: session.session_id, projectPath: session.project_path, fromWelcome: true }
            }));
        }
    });

    // Open in new tab (no back button needed since we stay on welcome)
    container.querySelector('[data-action="preview-open-new-tab"]')?.addEventListener('click', () => {
        const session = state.previewSession;
        if (session) {
            closePreview(container);
            window.dispatchEvent(new CustomEvent('welcome:open-session-new-tab', {
                detail: { sessionId: session.session_id, projectPath: session.project_path }
            }));
        }
    });

    // Fork
    container.querySelector('[data-action="preview-fork"]')?.addEventListener('click', () => {
        const session = state.previewSession;
        if (session) {
            // Save state before forking
            saveWelcomeState(container);
            closePreview(container);
            window.dispatchEvent(new CustomEvent('welcome:fork-session', {
                detail: { sessionId: session.session_id, projectPath: session.project_path, fromWelcome: true }
            }));
        }
    });
}
