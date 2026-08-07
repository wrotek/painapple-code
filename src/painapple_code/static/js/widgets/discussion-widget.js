/**
 * Discussion Widget - Forked thread discussions about selected text
 *
 * Allows users to:
 * - Select text in chat messages or file preview
 * - Start a discussion (forked session)
 * - Get real-time responses in thread cards
 * - Reply in ongoing threads
 */

import S from '../strings.js';
import { escapeHtml, highlightThinkingKeywords } from '../utils.js';
import { showToast } from '../context-menu.js';
import { CONFIG, debug } from '../config.js';
import { WidgetManager, WidgetBus, ICONS } from '../widget-system/index.js';
import { isThinkingKeywordsHighlightingEnabled } from './config-widget.js';
import { MarkdownRenderer } from '../components.js';

// Markdown renderer instance (lazy init)
let mdRenderer = null;
function getMarkdown() {
    if (!mdRenderer) {
        mdRenderer = new MarkdownRenderer();
    }
    return mdRenderer;
}

// ─────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────

class DiscussionState {
    constructor() {
        this.sessionId = null;
        this.threads = [];           // Active discussion threads
        this.queue = [];             // Items waiting to be sent
        this.loading = false;
        this.error = null;
    }

    reset() {
        this.threads = [];
        this.queue = [];
        this.loading = false;
        this.error = null;
    }
}

// Per-session state map
const states = new Map();

function getState(sessionId) {
    if (!sessionId) sessionId = WidgetManager.currentSessionId;
    if (!states.has(sessionId)) states.set(sessionId, new DiscussionState());
    return states.get(sessionId);
}

function destroyState(sessionId) {
    const state = states.get(sessionId);
    if (state) {
        // Close all thread WebSockets
        for (const thread of state.threads) {
            if (thread.ws) {
                thread.ws.onclose = null;
                thread.ws.close();
                thread.ws = null;
            }
        }
        states.delete(sessionId);
    }
}

// ─────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────

function renderContent(container, ctx) {
    if (!container) return;
    const state = getState();

    // Empty state when no threads or queue items
    if (state.threads.length === 0 && state.queue.length === 0) {
        container.innerHTML = `
            <div class="discussion-empty">
                <div class="discussion-empty-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                </div>
                <h3>No Discussions Yet</h3>
                <p>Fork a side thread to ask a question without losing your place in the main chat.</p>
                <div class="discussion-instructions">
                    <div class="instruction">
                        <span class="step">1</span>
                        <span>Tap the bubble icon next to any message to open the comment editor</span>
                    </div>
                    <div class="instruction">
                        <span class="step">2</span>
                        <span>Type your question and press <kbd>Ctrl+Enter</kbd> to fork the thread</span>
                    </div>
                    <div class="instruction">
                        <span class="step">3</span>
                        <span>Or run <code>/btw &lt;question&gt;</code> from the input — no selection needed</span>
                    </div>
                </div>
            </div>
        `;
        return;
    }

    // Render threads and queue
    container.innerHTML = `
        <div class="discussion-content">
            ${renderQueue()}
            ${renderThreads()}
        </div>
    `;
}

function renderQueue() {
    const state = getState();
    if (state.queue.length === 0) return '';

    const items = state.queue.map((item, i) => `
        <div class="queue-item" data-queue-index="${i}">
            <div class="queue-item-header">
                <span class="queue-anchor">
                    ${item.anchor.type === 'file' ? '📄' : '💬'}
                    ${escapeHtml(formatAnchor(item.anchor))}
                </span>
                <button class="queue-item-remove" data-tooltip="Remove">×</button>
            </div>
            <div class="queue-item-question">${escapeHtml(item.question)}</div>
        </div>
    `).join('');

    return `
        <div class="discussion-queue">
            <div class="queue-header">
                <span>📋 Queue (${state.queue.length})</span>
            </div>
            <div class="queue-items">${items}</div>
        </div>
    `;
}

function renderThreads() {
    const state = getState();
    if (state.threads.length === 0) return '';

    const threadCards = state.threads.map(thread => renderThreadCard(thread)).join('');

    return `
        <div class="discussion-threads">
            ${threadCards}
        </div>
    `;
}

function renderThreadCard(thread) {
    const statusClass = thread.status || 'active';
    const isCollapsed = thread.collapsed;
    const isLoading = thread.status === 'connecting' || thread.status === 'thinking';
    const hasError = thread.status === 'error';
    const isContinued = thread.status === 'continued' || thread.graduated;

    // For continued threads, show a compact card with link to tab
    if (isContinued) {
        return `
            <div class="thread-card continued" data-thread-id="${thread.id}">
                <div class="thread-header">
                    <span class="thread-anchor">
                        📍 ${escapeHtml(formatAnchor(thread.anchor))}
                    </span>
                    <span class="thread-continued-badge">
                        Continued in Tab
                    </span>
                </div>
                <div class="thread-continued-info">
                    <span class="thread-message-count">💬 ${thread.messages.length} messages</span>
                    <button class="thread-open-tab" data-session-id="${thread.forkedSessionId}" data-tooltip="Open in tab">
                        Open in Tab ↗
                    </button>
                </div>
            </div>
        `;
    }

    // Status indicator
    let statusIndicator = '';
    if (thread.status === 'connecting') {
        statusIndicator = '<span class="thread-status connecting">⏳ Connecting...</span>';
    } else if (thread.status === 'thinking') {
        statusIndicator = '<span class="thread-status thinking">💭 Thinking...</span>';
    } else if (thread.status === 'error') {
        statusIndicator = `<span class="thread-status error">❌ ${escapeHtml(thread.error || 'Error')}</span>`;
    } else if (thread.status === 'resolved') {
        statusIndicator = '<span class="thread-status resolved">✓ Resolved</span>';
    }

    const messages = thread.messages.map(msg => {
        const streamingClass = msg.isStreaming ? 'streaming' : '';
        // Render markdown for assistant messages, extract question for user messages
        let renderedContent;
        if (msg.role === 'assistant') {
            renderedContent = getMarkdown().render(msg.content || '');
        } else {
            // User messages: extract just the question, escape HTML, optionally highlight thinking keywords
            const question = extractUserQuestion(msg.content || '');
            const escaped = escapeHtml(question).replace(/\n/g, '<br>');
            renderedContent = isThinkingKeywordsHighlightingEnabled() ? highlightThinkingKeywords(escaped) : escaped;
        }
        const cursor = msg.isStreaming ? '<span class="streaming-cursor">▌</span>' : '';
        return `
            <div class="thread-message ${msg.role} ${streamingClass}">
                <span class="thread-message-role">${msg.role === 'user' ? '👤' : '🤖'}</span>
                <div class="thread-message-content markdown-body">${renderedContent}${cursor}</div>
            </div>
        `;
    }).join('');

    // Cost display
    const costDisplay = thread.totalCost > 0
        ? `<span class="thread-cost">$${thread.totalCost.toFixed(4)}</span>`
        : '';

    return `
        <div class="thread-card ${statusClass}" data-thread-id="${thread.id}">
            <div class="thread-header">
                <span class="thread-anchor" data-tooltip="Jump to source">
                    📍 ${escapeHtml(formatAnchor(thread.anchor))}
                </span>
                <div class="thread-actions">
                    ${costDisplay}
                    <button class="thread-collapse" data-tooltip="${isCollapsed ? 'Expand' : 'Collapse'}">${isCollapsed ? '+' : '−'}</button>
                    <button class="thread-close" data-tooltip="Close thread">×</button>
                </div>
            </div>
            ${statusIndicator}
            ${!isCollapsed ? `
                ${thread.anchor.selectedText ? `
                <div class="thread-quote">
                    <div class="thread-quote-text">${escapeHtml(thread.anchor.selectedText)}</div>
                </div>
                ` : ''}
                <div class="thread-messages">${messages}</div>
                ${!hasError && thread.status !== 'resolved' ? `
                    <div class="thread-reply">
                        <input type="text" class="thread-reply-input" placeholder="Reply..." ${isLoading ? 'disabled' : ''} />
                        <button class="thread-send" data-tooltip="Send" ${isLoading ? 'disabled' : ''}>Send</button>
                    </div>
                ` : ''}
                ${!hasError && thread.status === 'active' ? `
                    <div class="thread-footer">
                        <button class="thread-resolve" data-tooltip="Mark resolved">✓ Resolve</button>
                        <button class="thread-continue" data-session-id="${thread.forkedSessionId}" data-tooltip="Continue this discussion in a full tab">
                            Continue in Tab ↗
                        </button>
                    </div>
                ` : ''}
            ` : ''}
        </div>
    `;
}

function formatAnchor(anchor) {
    if (anchor.type === 'file') {
        const fileName = anchor.filePath?.split('/').pop() || 'file';
        if (anchor.startLine == null) {
            // No line numbers (e.g., rendered markdown)
            return fileName;
        }
        if (anchor.startLine === anchor.endLine) {
            return `${fileName}:${anchor.startLine}`;
        }
        return `${fileName}:${anchor.startLine}-${anchor.endLine}`;
    } else if (anchor.type === 'btw') {
        return 'Side question';
    } else {
        return `Message #${anchor.messageIndex || '?'}`;
    }
}

// ─────────────────────────────────────────────────────────────────────
// Event Handlers
// ─────────────────────────────────────────────────────────────────────

function handleContainerClick(e, ctx) {
    // Queue item removal
    const removeBtn = e.target.closest('.queue-item-remove');
    if (removeBtn) {
        const item = removeBtn.closest('.queue-item');
        const index = parseInt(item?.dataset.queueIndex, 10);
        if (!isNaN(index)) {
            removeFromQueue(index);
            renderContent(ctx.container, ctx);
        }
        return;
    }

    // Thread collapse toggle
    if (e.target.closest('.thread-collapse')) {
        const card = e.target.closest('.thread-card');
        const threadId = card?.dataset.threadId;
        if (threadId) {
            toggleThreadCollapse(threadId);
            renderContent(ctx.container, ctx);
        }
        return;
    }

    // Thread close
    if (e.target.closest('.thread-close')) {
        const card = e.target.closest('.thread-card');
        const threadId = card?.dataset.threadId;
        if (threadId) {
            closeThread(threadId);
            renderContent(ctx.container, ctx);
        }
        return;
    }

    // Thread resolve
    if (e.target.closest('.thread-resolve')) {
        const card = e.target.closest('.thread-card');
        const threadId = card?.dataset.threadId;
        if (threadId) {
            resolveThread(threadId);
            renderContent(ctx.container, ctx);
        }
        return;
    }

    // Thread send button click
    if (e.target.closest('.thread-send')) {
        const card = e.target.closest('.thread-card');
        const threadId = card?.dataset.threadId;
        const input = card?.querySelector('.thread-reply-input');
        const value = input?.value?.trim();
        if (threadId && value) {
            sendThreadReply(threadId, value);
            input.value = '';
        }
        return;
    }

    // Jump to anchor
    if (e.target.closest('.thread-anchor')) {
        const card = e.target.closest('.thread-card');
        const threadId = card?.dataset.threadId;
        if (threadId) {
            jumpToAnchor(threadId);
        }
        return;
    }

    // Continue in Tab - promote discussion to full session
    if (e.target.closest('.thread-continue')) {
        const btn = e.target.closest('.thread-continue');
        const sessionId = btn?.dataset.sessionId;
        const card = btn.closest('.thread-card');
        const threadId = card?.dataset.threadId;
        // An unsent reply the user already typed rides along to the chat input
        // of the tab we're about to open (the card is re-rendered as a compact
        // "continued" card, so the text would otherwise be dropped silently).
        const replyInput = card?.querySelector('.thread-reply-input');
        if (sessionId && threadId) {
            const draft = replyInput?.value?.trim() || '';
            if (replyInput) replyInput.value = '';
            graduateThread(threadId, sessionId, ctx, draft);
        }
        return;
    }

    // Open in Tab - for already-continued threads
    if (e.target.closest('.thread-open-tab')) {
        const btn = e.target.closest('.thread-open-tab');
        const sessionId = btn?.dataset.sessionId;
        if (sessionId) {
            openSessionInTab(sessionId);
        }
        return;
    }
}

// ─────────────────────────────────────────────────────────────────────
// Actions (stubs for now, will be implemented in later phases)
// ─────────────────────────────────────────────────────────────────────

function removeFromQueue(index) {
    const state = getState();
    state.queue.splice(index, 1);
    updateBadge();
}

function toggleThreadCollapse(threadId) {
    const state = getState();
    const thread = state.threads.find(t => t.id === threadId);
    if (thread) {
        thread.collapsed = !thread.collapsed;
    }
}

function closeThread(threadId) {
    const state = getState();
    const index = state.threads.findIndex(t => t.id === threadId);
    if (index !== -1) {
        state.threads.splice(index, 1);
    }
}

function resolveThread(threadId) {
    const state = getState();
    const thread = state.threads.find(t => t.id === threadId);
    if (thread) {
        thread.status = 'resolved';
        thread.resolvedAt = new Date().toISOString();
    }
}

/**
 * Graduate a discussion thread to a full session tab
 * @param {string} threadId - Local thread ID
 * @param {string} sessionId - The forked session ID to graduate
 * @param {object} ctx - Widget context for re-rendering
 * @param {string} [draft] - Unsent reply text to carry into the tab's chat input
 */
async function graduateThread(threadId, sessionId, ctx, draft = '') {
    const state = getState();
    const thread = state.threads.find(t => t.id === threadId);
    if (!thread) {
        console.error('[DiscussionWidget] Thread not found:', threadId);
        return;
    }

    debug.log('[DiscussionWidget] Graduating thread:', threadId, 'session:', sessionId);

    try {
        // Call the graduation API
        const response = await fetch(`${CONFIG.API_BASE}/api/session/${sessionId}/graduate`, {
            method: 'POST'
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to graduate session');
        }

        const result = await response.json();
        debug.log('[DiscussionWidget] Graduation result:', result);

        // Close the thread's WebSocket connection (no longer needed)
        if (thread.ws) {
            thread.ws.close();
            thread.ws = null;
        }

        // Update thread state to 'continued'
        thread.status = 'continued';
        thread.graduated = true;
        thread.graduatedAt = result.graduated_at;

        // Open the session in a new tab, carrying any unsent reply along
        openSessionInTab(sessionId, result.name || 'Discussion', draft);

        // Update the UI
        updateBadge();
        WidgetManager.update('discussion');

        // Show toast notification
        showToast(draft ? S.toast.discussion_continued_with_draft : S.toast.discussion_continued);

    } catch (err) {
        console.error('[DiscussionWidget] Failed to graduate thread:', err);
        thread.status = 'error';
        thread.error = err.message;
        WidgetManager.update('discussion');
    }
}

/**
 * Move an unsent draft into the main chat input of the (now active) tab.
 *
 * Runs in a rAF so it lands AFTER the session switch has restored that
 * session's own input text (_doSessionSwitch sets messageInput.value
 * synchronously, then focuses in its own rAF) — otherwise the restore
 * would clobber the carried draft.
 *
 * @param {string} draft - Text to carry over (no-op when empty)
 */
function carryDraftToChatInput(draft) {
    const text = (draft || '').trim();
    if (!text) return;

    requestAnimationFrame(() => {
        const input = window.app?.els?.messageInput;
        if (!input) return;

        // Append rather than replace — never destroy something already typed
        const existing = input.value;
        const gap = existing && !existing.endsWith('\n') ? '\n' : '';
        input.value = existing ? `${existing}${gap}${text}` : text;
        input.selectionStart = input.selectionEnd = input.value.length;

        // Drives auto-resize, highlight backdrop and the draft autosave
        input.dispatchEvent(new Event('input', { bubbles: true }));
        window.app?.focusInput?.();
    });
}

/**
 * Open a session in a new tab
 * @param {string} sessionId - Session ID to open
 * @param {string} [name] - Optional tab name
 * @param {string} [draft] - Unsent text to place in the tab's chat input
 */
function openSessionInTab(sessionId, name, draft = '') {
    debug.log('[DiscussionWidget] Opening session in tab:', sessionId);

    // Check if window.app and session manager are available
    if (!window.app?.sessionManager) {
        console.error('[DiscussionWidget] SessionManager not available');
        return;
    }

    const manager = window.app.sessionManager;

    // Check if session is already open in a tab
    const existingSession = manager.sessions.find(s => s.storeId === sessionId);
    if (existingSession) {
        // Switch to existing tab
        window.app.switchToSession(existingSession);
        carryDraftToChatInput(draft);
        debug.log('[DiscussionWidget] Switched to existing tab');
        return;
    }

    // Create a new tab for this session
    // We need to load the session metadata to get the CWD
    fetch(`${CONFIG.API_BASE}/api/sessions/${sessionId}/logs`)
        .then(res => res.json())
        .then(data => {
            const cwd = data.cwd || window.app.activeSession?.cwd || '.';
            // Create new session tab with storeId to connect to existing session
            const session = manager.create({
                cwd,
                storeId: sessionId,
                name: name || undefined
            });
            if (!session) {
                console.error('[DiscussionWidget] Failed to create session (max sessions reached?)');
                return;
            }
            // Switch to the new tab and connect
            window.app.switchToSession(session);
            session.connect();
            carryDraftToChatInput(draft);
            debug.log('[DiscussionWidget] Created new tab for session:', sessionId);
        })
        .catch(err => {
            console.error('[DiscussionWidget] Failed to load session info:', err);
            // Fallback: create with current CWD
            const cwd = window.app.activeSession?.cwd || '.';
            const session = manager.create({
                cwd,
                storeId: sessionId,
                name: name || undefined
            });
            if (session) {
                window.app.switchToSession(session);
                session.connect();
                carryDraftToChatInput(draft);
            }
        });
}

function jumpToAnchor(threadId) {
    const state = getState();
    const thread = state.threads.find(t => t.id === threadId);
    if (!thread) return;

    const anchor = thread.anchor;
    if (anchor.type === 'file') {
        // Open file preview and scroll to line
        window.app?.previewFile(anchor.filePath, {
            line: anchor.startLine,
            end: anchor.endLine
        });
    } else {
        // Scroll to message in chat
        const messageEl = document.querySelector(`[data-message-id="${anchor.messageId}"]`);
        if (messageEl) {
            messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            messageEl.classList.add('highlight-pulse');
            setTimeout(() => messageEl.classList.remove('highlight-pulse'), 2000);
        }
    }
}

function updateBadge() {
    const state = getState();
    const total = state.threads.filter(t => t.status === 'active').length + state.queue.length;
    const badge = document.getElementById('rail-discussion-badge');
    if (badge) {
        badge.textContent = total > 0 ? total : '';
    }
}

// ─────────────────────────────────────────────────────────────────────
// Thread Persistence - Load/Save from Server
// ─────────────────────────────────────────────────────────────────────

/**
 * Load threads for a session from the server
 * @param {string} sessionId - Parent session ID
 */
async function loadThreadsFromServer(sessionId) {
    if (!sessionId) return;
    const state = getState(sessionId);

    debug.log('[DiscussionWidget] Loading threads for session:', sessionId);
    state.loading = true;

    try {
        const response = await fetch(`/api/session/${sessionId}/threads`);
        if (!response.ok) {
            throw new Error(`Failed to load threads: ${response.status}`);
        }

        const data = await response.json();
        debug.log('[DiscussionWidget] Loaded', data.count, 'threads from server');

        // Convert server format to widget format
        for (const serverThread of data.threads) {
            // Skip if thread already exists in state (e.g., just created)
            if (state.threads.some(t => t.forkedSessionId === serverThread.id)) {
                continue;
            }

            const thread = {
                id: `thread_${serverThread.id}`,
                parentSessionId: sessionId,
                forkedSessionId: serverThread.id,
                ws: null,
                anchor: serverThread.anchor || { type: 'unknown', selectedText: '' },
                status: serverThread.status || 'active',
                messages: (serverThread.messages || []).map((msg, i) => ({
                    id: `msg_${i}`,
                    role: msg.role,
                    content: msg.content,
                    timestamp: msg.timestamp,
                    isStreaming: false
                })),
                createdAt: serverThread.created_at,
                updatedAt: serverThread.last_activity,
                collapsed: false,
                totalCost: serverThread.total_cost || 0
            };

            state.threads.push(thread);

            // Reconnect WebSocket for active threads (not resolved)
            if (thread.status === 'active' && thread.forkedSessionId) {
                // Don't reconnect immediately - only when user interacts
                debug.log('[DiscussionWidget] Thread', thread.id, 'is active, WS will reconnect on interaction');
            }
        }

        updateBadge();
        WidgetManager.update('discussion');
    } catch (err) {
        console.error('[DiscussionWidget] Failed to load threads:', err);
        state.error = err.message;
    } finally {
        state.loading = false;
    }
}

/**
 * Ensure thread has active WebSocket connection
 * Called before sending messages
 */
function ensureThreadConnection(thread) {
    if (thread.ws && thread.ws.readyState === WebSocket.OPEN) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const wsUrl = getWsUrl(thread.forkedSessionId);
        debug.log('[DiscussionWidget] Reconnecting thread WS:', wsUrl);

        thread.ws = new WebSocket(wsUrl);

        thread.ws.onopen = () => {
            debug.log('[DiscussionWidget] Thread WS reconnected');
            resolve();
        };

        thread.ws.onmessage = (event) => handleThreadWsMessage(thread, event);

        thread.ws.onerror = (err) => {
            console.warn('[DiscussionWidget] Thread WS reconnect error:', err);
            thread.status = 'error';
            thread.error = 'WebSocket reconnection failed';
            WidgetManager.update('discussion');
            reject(err);
        };

        thread.ws.onclose = () => {
            debug.log('[DiscussionWidget] Thread WS closed');
            thread.ws = null;
        };
    });
}

// ─────────────────────────────────────────────────────────────────────
// WebSocket Helpers for Thread Forks
// ─────────────────────────────────────────────────────────────────────

/**
 * Get WebSocket URL for a session
 */
function getWsUrl(sessionId) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/chat?session=${sessionId}`;
}

/**
 * Extract the user's question from a templated prompt
 * Returns just the question part, or the full content if not a template
 */
function extractUserQuestion(content) {
    if (!content) return '';

    // Look for "**My question:**" pattern and extract what follows
    const questionMatch = content.match(/\*\*My question:\*\*\s*(.+?)(?:\n\nPlease provide|$)/s);
    if (questionMatch) {
        return questionMatch[1].trim();
    }

    // If no template pattern, return as-is
    return content;
}

/**
 * Format the initial prompt for a thread discussion
 */
function formatThreadPrompt(anchor, question) {
    if (anchor.type === 'btw') {
        return `Side question (forked from our main conversation — answer here, the main thread continues separately):

**My question:** ${question}`;
    }

    const contextType = anchor.type === 'file'
        ? `from file ${anchor.filePath}`
        : 'from our conversation';

    return `I have a question about this specific text ${contextType}:

> ${anchor.selectedText}

**My question:** ${question}

Please provide a focused, concise answer about this specific selection.`;
}

/**
 * Handle incoming WebSocket message for a thread
 */
function handleThreadWsMessage(thread, event) {
    try {
        const msg = JSON.parse(event.data);
        debug.log('[DiscussionWidget] Thread WS message:', msg.type, msg.data?.type);

        if (msg.type === 'connected') {
            // WebSocket connected, now send the prompt
            thread.status = 'thinking';
            WidgetManager.update('discussion');

            // Send the formatted prompt
            const prompt = formatThreadPrompt(thread.anchor, thread.initialQuestion);
            thread.ws.send(JSON.stringify({
                type: 'user_message',
                content: prompt
            }));
            debug.log('[DiscussionWidget] Sent thread prompt');
        }
        else if (msg.type === 'agent_message') {
            const data = msg.data;
            debug.log('[DiscussionWidget] agent_message data:', JSON.stringify(data).slice(0, 500));

            if (data.type === 'assistant') {
                // Claude's response - content is nested under data.message.content
                // Format: {type:'assistant', message: {content: [{type:'text', text:'...'}]}}
                let content = '';
                const messageContent = data.message?.content || data.content;

                if (Array.isArray(messageContent)) {
                    content = messageContent
                        .filter(c => c.type === 'text')
                        .map(c => c.text)
                        .join('');
                } else if (typeof messageContent === 'string') {
                    content = messageContent;
                }

                debug.log('[DiscussionWidget] Extracted content:', content.slice(0, 200));

                if (content) {
                    // Find or create assistant message
                    let assistantMsg = thread.messages.find(m => m.role === 'assistant' && m.isStreaming);
                    if (!assistantMsg) {
                        assistantMsg = {
                            id: `msg_${Date.now()}`,
                            role: 'assistant',
                            content: '',
                            isStreaming: true,
                            timestamp: new Date().toISOString()
                        };
                        thread.messages.push(assistantMsg);
                        debug.log('[DiscussionWidget] Created new assistant message');
                    }
                    assistantMsg.content = content;
                    debug.log('[DiscussionWidget] Thread now has', thread.messages.length, 'messages');
                    WidgetManager.update('discussion');
                }
            }
            else if (data.type === 'result') {
                // Conversation turn complete
                thread.status = 'active';
                // Mark streaming complete
                thread.messages.forEach(m => { m.isStreaming = false; });
                thread.updatedAt = new Date().toISOString();

                // Store cost info (server sends total_cost_usd)
                const turnCost = data.total_cost_usd || data.cost_usd || 0;
                if (turnCost) {
                    thread.totalCost = (thread.totalCost || 0) + turnCost;
                }

                debug.log('[DiscussionWidget] Result - thread messages:', thread.messages.length, 'cost:', turnCost);
                WidgetManager.update('discussion');
                debug.log('[DiscussionWidget] Thread response complete');
            }
        }
        else if (msg.type === 'error') {
            console.error('[DiscussionWidget] Thread error:', msg.message);
            thread.status = 'error';
            thread.error = msg.message;
            WidgetManager.update('discussion');
        }
    } catch (err) {
        console.error('[DiscussionWidget] Error handling thread message:', err);
    }
}

/**
 * Connect WebSocket for a thread
 */
function connectThreadWs(thread) {
    const wsUrl = getWsUrl(thread.forkedSessionId);
    debug.log('[DiscussionWidget] Connecting thread WS:', wsUrl);

    thread.ws = new WebSocket(wsUrl);

    thread.ws.onopen = () => {
        debug.log('[DiscussionWidget] Thread WS opened');
    };

    thread.ws.onmessage = (event) => handleThreadWsMessage(thread, event);

    thread.ws.onerror = (err) => {
        console.warn('[DiscussionWidget] Thread WS error:', err);
        thread.status = 'error';
        thread.error = 'WebSocket connection failed';
        WidgetManager.update('discussion');
    };

    thread.ws.onclose = () => {
        debug.log('[DiscussionWidget] Thread WS closed');
        thread.ws = null;
    };
}

// ─────────────────────────────────────────────────────────────────────
// Public API (for external use)
// ─────────────────────────────────────────────────────────────────────

/**
 * Add an item to the comment queue
 * @param {Object} anchor - Thread anchor (type, filePath/messageId, lines, text)
 * @param {string} question - The question/comment text
 */
export function addToQueue(anchor, question) {
    const state = getState();
    state.queue.push({
        id: `queue_${Date.now()}`,
        anchor,
        question,
        addedAt: new Date().toISOString()
    });
    updateBadge();

    // Open the widget and refresh content
    WidgetManager.open('discussion');
    WidgetManager.update('discussion');
}

/**
 * Start a new thread immediately (Discuss Now)
 * Forks the current session and sends the question to Claude
 * @param {Object} anchor - Thread anchor
 * @param {string} question - Initial question
 */
export async function startThread(anchor, question) {
    const state = getState();
    debug.log('[DiscussionWidget] startThread called with:', { anchor, question });

    // Get current session ID from app (uses activeSession, not currentSession)
    const currentSessionId = window.app?.activeSession?.storeId;
    if (!currentSessionId) {
        console.error('[DiscussionWidget] No current session to fork from (activeSession.storeId is null)');
        // Show user-friendly message
        window.app?.activeSession?.addSystemLog('Cannot start thread: session not fully connected', 'error');
        return;
    }
    // Discussion threads are forks — engines without fork can't host them.
    const active = window.app?.activeSession;
    if (active?.providerCaps?.fork === false) {
        active.addSystemLog(S.engine.fork_unsupported.replace(
            '{engine}', active.providerDisplayName || active.provider), 'error');
        return;
    }

    // Create thread with connecting status
    const thread = {
        id: `thread_${Date.now()}`,
        parentSessionId: currentSessionId,
        forkedSessionId: null,  // Will be set after fork
        ws: null,               // WebSocket connection
        anchor,
        initialQuestion: question,  // Store for later use
        status: 'connecting',   // connecting → thinking → active | error
        messages: [
            { id: `msg_${Date.now()}`, role: 'user', content: question, timestamp: new Date().toISOString() }
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        collapsed: false,
        totalCost: 0
    };

    state.threads.unshift(thread);
    updateBadge();

    // Open the widget and show connecting state
    WidgetManager.open('discussion');
    WidgetManager.update('discussion');

    try {
        // Fork the session with comment_thread flag
        const forkUrl = `/api/session/${currentSessionId}/fork?comment_thread=true&thread_anchor=${encodeURIComponent(JSON.stringify(anchor))}`;
        debug.log('[DiscussionWidget] Forking session:', forkUrl);

        const response = await fetch(forkUrl, { method: 'POST' });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to fork session');
        }

        const forkData = await response.json();
        debug.log('[DiscussionWidget] Fork created:', forkData);

        thread.forkedSessionId = forkData.id;
        thread.providerSessionId = forkData.provider_session_id;

        // Connect WebSocket to the forked session
        connectThreadWs(thread);

    } catch (err) {
        console.error('[DiscussionWidget] Failed to start thread:', err);
        thread.status = 'error';
        thread.error = err.message;
        WidgetManager.update('discussion');
    }
}

/**
 * Send a reply in an existing thread
 * @param {string} threadId - Thread to reply in
 * @param {string} message - Reply message
 */
export async function sendThreadReply(threadId, message) {
    const state = getState();
    const thread = state.threads.find(t => t.id === threadId);
    if (!thread) {
        console.error('[DiscussionWidget] Thread not found:', threadId);
        return;
    }

    // Add user message immediately for responsive UI
    thread.messages.push({
        id: `msg_${Date.now()}`,
        role: 'user',
        content: message,
        timestamp: new Date().toISOString()
    });

    thread.status = 'connecting';
    WidgetManager.update('discussion');

    try {
        // Ensure WebSocket is connected (will reconnect if needed)
        await ensureThreadConnection(thread);

        thread.status = 'thinking';
        WidgetManager.update('discussion');

        // Send to Claude
        thread.ws.send(JSON.stringify({
            type: 'user_message',
            content: message
        }));
    } catch (err) {
        console.error('[DiscussionWidget] Failed to send reply:', err);
        thread.status = 'error';
        thread.error = 'Failed to reconnect';
        WidgetManager.update('discussion');
    }
}

// ─────────────────────────────────────────────────────────────────────
// Widget Registration
// ─────────────────────────────────────────────────────────────────────

export function registerDiscussionWidget() {
    WidgetManager.register('discussion', {
        type: 'sidebar-right',
        title: S.widgets.titles.discussion,
        icon: 'message-square',
        shortcut: 'Alt+/',

        // Device-specific types
        deviceTypes: {
            default: 'bottom-sheet',
            phone: 'bottom-sheet',
            tablet: 'bottom-sheet',
            desktop: 'sidebar-right'
        },

        // Heights for bottom-sheet mode
        heights: {
            half: '50vh',
            full: '85vh'
        },

        // Sidebar width - wider for better readability
        sidebarWidth: 420,

        render(container, ctx) {
            const sessionId = ctx.sessionId;
            const state = getState(sessionId);
            const prevSessionId = state.sessionId;
            state.sessionId = sessionId;
            ctx.container = container;

            // Add container class for styling
            container.classList.add('discussion-widget-content');

            // Render content
            renderContent(container, ctx);

            // Set up event delegation
            container.addEventListener('click', (e) => handleContainerClick(e, ctx));

            // Handle reply input enter key
            container.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && e.target.classList.contains('thread-reply-input')) {
                    e.preventDefault();
                    const card = e.target.closest('.thread-card');
                    const threadId = card?.dataset.threadId;
                    const value = e.target.value.trim();
                    if (threadId && value) {
                        sendThreadReply(threadId, value);
                        e.target.value = '';
                    }
                }
            });

            // Update badge
            updateBadge();

            // Load threads from server if first render for this session
            if (sessionId && sessionId !== prevSessionId) {
                loadThreadsFromServer(sessionId);
            }
        },

        onDestroy: (sessionId) => {
            destroyState(sessionId);
        }
    });
}

export { destroyState as destroyDiscussionState };
