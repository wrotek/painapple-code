/**
 * ChatController - Handles message rendering and chat display
 *
 * Manages: message list, scroll position, history loading, welcome screen
 *
 * Performance optimization: Uses SessionContainerPool for O(1) tab switching
 * instead of O(n) DOM rebuilds on every session switch.
 */

import { CONFIG, HAS_PHYSICAL_KEYBOARD, debug } from '../config.js';
import { MarkdownRenderer } from '../components.js';
import { escapeHtml, escapeAttr, formatTime, formatRelativeTime, highlightThinkingKeywords } from '../utils.js';
import { isThinkingKeywordsHighlightingEnabled } from '../widgets/config-widget.js';
import {
    initWelcomeScreen,
    handleWelcomeTask,
    resetWelcomeScreen,
    isTaskMode,
    refreshSessions,
    restoreWelcomeState,
    clearSavedWelcomeState,
    getSavedWelcomeState
} from '../welcome.js';
import { SessionContainerPool, useContainerPool } from '../session-container-pool.js';
import { showToast } from '../context-menu.js';
import { engineAuthorLabel } from '../status-bar.js';
import S from '../strings.js';
import { basename, isAbsolutePath, joinPath } from '../path-utils.js';
import { renderStashRefs } from '../stash-refs-view.js';

// Turn-summary files row: current-turn pills (changed files + image thumbs)
// always render in full; session-accumulated pills (changed first, then image
// thumbs) top the row up to this many total pills.
const FILES_ROW_CAP = 10;

// Kept in sync with image-preview-widget.js IMAGE_EXT_RE and the backend's
// turn_tracker.IMAGE_EXTENSIONS.
const FILES_ROW_IMAGE_RE = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i;

// Distance (px) a touch must move for the subsequent touchend to be treated
// as the end of a scroll gesture rather than a tap.
const TAP_MOVE_THRESHOLD = 10;
// Matches the long-press threshold used by the document-level file-menu handler
// in app.js — a touch held this long has already opened a context menu, so the
// subsequent touchend must not also fire the tap action.
const LONG_PRESS_MS = 400;

/**
 * Bind click + touch tap handler to an element, skipping touchend when the
 * touch moved beyond TAP_MOVE_THRESHOLD — i.e. the user was scrolling, not
 * tapping. click is bound as-is so desktop/trackpad clicks still work, and
 * modern iOS suppresses the synthetic click after a scroll anyway.
 *
 * Also skips when an iOS long-press just triggered a file context menu
 * (app.js binds that at document level on the same elements); without this
 * guard, tapping a .turn-file-pill opened both the menu and the preview.
 */
function bindTapHandler(element, handler) {
    let startX = 0, startY = 0, moved = false, startTime = 0;
    const contextMenuOpen = () => !!window.app?.contextMenu?.visible;
    element.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        moved = false;
        startTime = Date.now();
    }, { passive: true });
    element.addEventListener('touchmove', (e) => {
        if (moved) return;
        const t = e.touches[0];
        if (Math.abs(t.clientX - startX) > TAP_MOVE_THRESHOLD ||
            Math.abs(t.clientY - startY) > TAP_MOVE_THRESHOLD) {
            moved = true;
        }
    }, { passive: true });
    element.addEventListener('touchend', (e) => {
        if (moved) return;
        if (Date.now() - startTime >= LONG_PRESS_MS) return;
        if (contextMenuOpen()) return;
        // Kill any pending app.js long-press timer — handler() calls
        // stopPropagation, so the document's touchend never runs to clear it,
        // and otherwise the 400 ms timer would fire and open the context
        // menu on top of the preview we're about to show.
        window.__cancelFileLongPress?.();
        handler(e);
    }, { passive: false });
    element.addEventListener('click', (e) => {
        if (contextMenuOpen()) return;
        window.__cancelFileLongPress?.();
        handler(e);
    });
}

export class ChatController {
    constructor(ctx, thinkingController) {
        this.ctx = ctx;
        this.thinkingCtrl = thinkingController;

        // Container pool for instant tab switching (initialized lazily)
        this._containerPool = null;
        this._useContainerPool = useContainerPool();

        // Cache for recent sessions to prevent flickering
        this._recentSessionsCache = null;
        this._recentSessionsCacheTime = 0;

        // Session file pills hidden by user: sessionId → Set<filePath>
        this._hiddenSessionFiles = new Map();
    }

    /** Returns the active welcome container in #welcome-view (or null) */
    _activeWelcomeContainer() {
        return this.ctx.app?.els?.welcomeView?.querySelector('#welcome-container') || null;
    }

    // ═══════════════════════════════════════════════════════════════
    // CONTEXT BLOCK RENDERING
    // ═══════════════════════════════════════════════════════════════

    /**
     * Check if content looks like /context command output
     */
    _isContextOutput(content) {
        return content && (
            content.startsWith('## Context Usage') ||
            content.includes('**Model:**') && content.includes('**Tokens:**')
        );
    }

    /**
     * Parse context output and extract summary info
     */
    _parseContextSummary(content) {
        const summary = { model: 'Unknown', tokens: '?', limit: '?', percent: '?' };

        // Parse model: **Model:** claude-opus-4-5-20251101
        const modelMatch = content.match(/\*\*Model:\*\*\s*(\S+)/);
        if (modelMatch) {
            summary.model = modelMatch[1];
        }

        // Parse tokens: **Tokens:** 76.5k / 200.0k (38%)
        const tokensMatch = content.match(/\*\*Tokens:\*\*\s*([\d.]+k?)\s*\/\s*([\d.]+k?)\s*\((\d+%)\)/);
        if (tokensMatch) {
            summary.tokens = tokensMatch[1];
            summary.limit = tokensMatch[2];
            summary.percent = tokensMatch[3];
        }

        return summary;
    }

    /**
     * Render /context output as a collapsible block
     */
    _renderContextBlock(content, timestamp) {
        const summary = this._parseContextSummary(content);
        const fullContent = this.ctx.markdown.render(content);
        const id = `context-${Date.now()}`;

        return `
            <div class="context-block collapsed" id="${id}">
                <div class="context-header" data-act="toggle-class" data-block=".context-block" data-cls="collapsed">
                    <span class="context-icon">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"/>
                            <path d="M12 6v6l4 2"/>
                        </svg>
                    </span>
                    <span class="context-label">Context</span>
                    <span class="context-summary">
                        <span class="context-tokens">${summary.tokens} / ${summary.limit}</span>
                        <span class="context-percent">${summary.percent}</span>
                    </span>
                    <span class="context-model">${summary.model}</span>
                    <span class="context-time">${formatTime(timestamp)}</span>
                    <span class="context-expand">▶</span>
                </div>
                <div class="context-content">
                    <div class="markdown-content">${fullContent}</div>
                </div>
            </div>
        `;
    }

    // ═══════════════════════════════════════════════════════════════
    // MESSAGE RENDERING
    // ═══════════════════════════════════════════════════════════════

    /**
     * Initialize container pool lazily (first use)
     * @private
     */
    _initContainerPool() {
        if (this._containerPool || !this._useContainerPool) return;
        this._containerPool = new SessionContainerPool(this.ctx.els.messages, {
            // When a session is LRU-evicted, save its scrollTop on the session object
            // so it can be restored if the container is re-created later.
            // scrollTop may be null = "was at bottom" → restore scrolls to bottom.
            onBeforeEvict: (sessionId, scrollTop) => {
                const session = this.ctx.app?.sessionManager?.get(sessionId);
                if (session) {
                    session.scrollPosition = scrollTop;
                }
            }
        });
    }

    /**
     * Get the active message container for appending new messages
     * CRITICAL: Use this instead of ctx.els.messages when appending messages
     * to ensure messages go to the correct session container
     * @private
     */
    _getActiveMessageContainer() {
        // Initialize pool on first use (lazy init)
        this._initContainerPool();

        if (this._useContainerPool && this._containerPool) {
            const session = this.ctx.session;
            const sessionId = session?.id || session?.storeId || session?.sessionId;
            if (sessionId) {
                // IMPORTANT: Use acquire() to get or create container
                // Never fall back to #messages or messages will appear in all tabs
                const container = this._containerPool.acquire(sessionId);

                // If this container isn't currently active (visible), activate it
                // This handles the case where we're appending to a new session
                // that hasn't been fully initialized yet
                if (this._containerPool.activeId !== sessionId) {
                    debug.log('[_getActiveMessageContainer] Activating container for', sessionId,
                        'was active:', this._containerPool.activeId);
                    this._containerPool.activate(sessionId);
                    // Mark as rendered to prevent renderMessages() from clearing it
                    this._containerPool.markRendered(sessionId, 0);
                }

                return container;
            } else {
                console.warn('[_getActiveMessageContainer] No sessionId available!', session);
            }
        }
        // Fallback to #messages - but log a warning because this could cause cross-tab bleed
        console.warn('[_getActiveMessageContainer] Falling back to #messages - pool disabled or no session');
        return this.ctx.els.messages;
    }

    /**
     * Render all messages for the active session
     *
     * Performance: Uses container pooling for O(1) tab switches.
     * - First visit: renders all messages O(n)
     * - Subsequent visits: show/hide cached container O(1)
     */
    renderMessages() {
        const session = this.ctx.session;
        if (!session) return;

        const sessionId = session.id || session.storeId || session.sessionId;

        // Filter out system messages (they go to system log now)
        const messages = session.messages.filter(m => m.role !== 'system');

        // Welcome view is its own top-level view rendered by App.renderWelcome;
        // _doSessionSwitch routes there via TabController.switchToWelcome before
        // renderMessages is ever called for an empty session. renderMessages only
        // renders chat content into the session's container.

        // Clear skipWelcome flag once we've bypassed it
        if (session.skipWelcome) {
            session.skipWelcome = false;
        }

        // ─────────────────────────────────────────────────────────────────
        // CONTAINER POOL: Check for cached container (O(1) switch)
        // ─────────────────────────────────────────────────────────────────
        this._initContainerPool();

        debug.log('[ChatCtrl] renderMessages:', sessionId,
            'usePool:', this._useContainerPool,
            'poolExists:', !!this._containerPool,
            'needsRender:', this._containerPool?.needsRender(sessionId));

        if (this._useContainerPool && this._containerPool) {
            // Check if we have a cached, rendered container
            if (!this._containerPool.needsRender(sessionId)) {
                // O(1) switch - browser natively preserves scrollTop on display:none elements
                debug.log('[ChatCtrl] O(1) SWITCH - using cached container');
                this._containerPool.activate(sessionId);

                // Handle back-to-sessions pill
                this._hideBackToSessionsPill();
                const savedState = getSavedWelcomeState();
                if (session.openedFromWelcome && savedState) {
                    this._showBackToSessionsPill(session);
                }

                // Retarget scroll-aware components, but skip initState() —
                // the browser preserved scrollTop natively, and we restore
                // isUserScrolledUp from the session object below.
                this._retargetScrollComponents({ skipInitState: true });

                // Restore scroll manager state from the session's saved state
                // (saved in switchSession PHASE 1 before the switch)
                const scrollManager = this.ctx.app?.scrollManager;
                if (scrollManager) {
                    scrollManager.isUserScrolledUp = !!session.isUserScrolledUp;
                }

                // Self-heal: if the user was at the bottom when they left this
                // session, pin it back to the bottom. Browsers normally preserve
                // scrollTop through display:none, but iPadOS WKWebView can drop
                // the offset after a long background stay / memory pressure —
                // which used to re-show the tab scrolled to the top.
                if (!session.isUserScrolledUp) {
                    const el = this._containerPool.get(sessionId);
                    if (el) el.scrollTop = el.scrollHeight;
                }

                return;
            }

            // First render for this session - get/create container
            debug.log('[ChatCtrl] FIRST RENDER - creating container for', sessionId);
            const container = this._containerPool.acquire(sessionId);
            container.innerHTML = '';

            // Render into the session-specific container
            this._renderMessagesIntoContainer(container, session, messages);

            // Mark as rendered and activate
            this._containerPool.markRendered(sessionId, messages.length);
            this._containerPool.activate(sessionId);
        } else {
            // No pool - use legacy rendering (clear and rebuild)
            debug.log('[ChatCtrl] LEGACY RENDER - no pool');
            this.ctx.els.messages.innerHTML = '';
            this._renderMessagesIntoContainer(this.ctx.els.messages, session, messages);
        }

        // Retarget scroll-aware components to the active session container
        this._retargetScrollComponents();

        // Restore scroll position or scroll to bottom
        this.restoreScrollPosition();

        // Check gutter space for all thinking sections and tool groups after DOM is ready
        requestAnimationFrame(() => {
            this.thinkingCtrl.checkAllGutterSpace();
            this.checkAllToolGroupGutterSpace();
        });
    }

    /**
     * Render messages into a specific container element
     * Extracted from renderMessages for container pool support
     * @private
     */
    _renderMessagesIntoContainer(container, session, messages) {
        // Handle "Back to sessions" floating pill
        this._hideBackToSessionsPill();
        const savedState = getSavedWelcomeState();
        if (session.openedFromWelcome && savedState) {
            this._showBackToSessionsPill(session);
        }

        // Show "more history" notice if there are older messages
        if (session.hasMoreMessages && session.totalMessageCount > 0) {
            const loadedCount = session.messages.length;
            const totalCount = session.totalMessageCount;
            const remaining = totalCount - loadedCount;
            if (remaining > 0) {
                const notice = document.createElement('div');
                notice.className = 'message-history-notice';
                notice.onclick = () => this.handleScrollTop();
                notice.innerHTML = `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="17 11 12 6 7 11"/>
                        <polyline points="17 18 12 13 7 18"/>
                    </svg>
                    <span>${remaining.toLocaleString()} older messages • scroll up to load</span>
                `;
                container.appendChild(notice);
            }
        }

        // Temporarily override ctx.els.messages for renderMessage calls
        const originalMessages = this.ctx.els.messages;
        this.ctx.els.messages = container;

        try {
            // Group consecutive thinking messages and tool messages
            let i = 0;
            while (i < messages.length) {
                const msg = messages[i];

                if (msg.role === 'thinking') {
                    // Collect consecutive thinking messages from the same turn
                    const thinkingGroup = [msg];
                    let j = i + 1;
                    while (j < messages.length && messages[j].role === 'thinking' &&
                           messages[j].turnId === msg.turnId) {
                        thinkingGroup.push(messages[j]);
                        j++;
                    }

                    if (thinkingGroup.length >= 2) {
                        this.thinkingCtrl.renderThinkingGroup(thinkingGroup);
                    } else {
                        this.renderMessage(msg, false);
                    }
                    i = j;
                } else if (msg.role === 'tool') {
                    // Collect consecutive tool messages from the same turn
                    const toolGroup = [msg];
                    let j = i + 1;
                    while (j < messages.length && messages[j].role === 'tool' &&
                           messages[j].turnId === msg.turnId) {
                        toolGroup.push(messages[j]);
                        j++;
                    }

                    if (toolGroup.length >= 2) {
                        this._renderToolGroup(toolGroup);
                    } else {
                        this.renderMessage(msg, false);
                    }
                    i = j;
                } else {
                    this.renderMessage(msg, false);
                    i++;
                }
            }
        } finally {
            // Move plan-approval cards to after turn summary bars
            this._repositionPlanApproval(container);
            // Restore original messages element
            this.ctx.els.messages = originalMessages;
        }
    }

    /**
     * Invalidate a session's cached container (force re-render on next switch)
     * Call this when messages change while session is not visible
     */
    invalidateSession(sessionId) {
        if (this._containerPool) {
            this._containerPool.invalidate(sessionId);
        }
    }

    /**
     * Release a session's container (when session is closed)
     */
    releaseSession(sessionId) {
        if (this._containerPool) {
            this._containerPool.release(sessionId);
        }
    }

    /**
     * Author shown in a bubble's header. Every role but `assistant` names
     * itself; the assistant is the session's ENGINE ("claude", "codex", …),
     * so a Codex transcript never claims to be authored by Claude. Shared by
     * the live path (renderMessage) and the re-render/lazy-load path
     * (createMessageElement) so both agree after a reload.
     */
    _authorLabel(msg) {
        return msg.role === 'assistant'
            ? escapeHtml(engineAuthorLabel(this.ctx.session))
            : msg.role;
    }

    /**
     * Render a single message
     */
    renderMessage(msg, scroll = true) {
        // Skip system messages - they go to system log
        if (msg.role === 'system') return;

        // Skip result messages - they're metadata-only (cost, duration)
        if (msg.role === 'result') return;

        // CRITICAL: Get the correct container for the active session
        // With pool: this is the session-specific .session-messages container
        // Without pool: this is the shared #messages element
        const messageContainer = this._getActiveMessageContainer();

        // Handle error messages (from Claude Code's local-command-stderr)
        if (msg.role === 'error') {
            const div = document.createElement('div');
            div.className = 'message error';
            div.id = `msg-${msg.id}`;
            div.innerHTML = `
                <div class="message-header">
                    <span class="message-role error">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"/>
                            <line x1="12" y1="8" x2="12" y2="12"/>
                            <line x1="12" y1="16" x2="12.01" y2="16"/>
                        </svg>
                        error
                    </span>
                    <span class="message-time">${formatTime(msg.timestamp)}</span>
                    <button class="message-copy-btn" data-msg-id="${msg.id}" data-id="${escapeAttr(msg.id)}" data-act="copy-message" data-tooltip="Copy message">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                        </svg>
                        <span class="copy-label">Copy</span>
                    </button>
                </div>
                <div class="message-content">${escapeHtml(msg.content)}</div>
            `;
            messageContainer.appendChild(div);
            if (scroll) this.scrollToBottom();
            return;
        }

        // Handle auth-error affordance — Claude CLI returned 401 / expired token.
        if (msg.role === 'auth_error') {
            messageContainer.appendChild(this._renderAuthError(msg));
            if (scroll) this.scrollToBottom();
            return;
        }

        // Handle info messages (e.g., compaction summary, /context results)
        if (msg.role === 'info') {
            const div = document.createElement('div');
            div.id = `msg-${msg.id}`;

            // Check if this is /context output - render as collapsible block
            if (msg.source === 'local-command-stdout' && this._isContextOutput(msg.content)) {
                div.className = 'message context';
                div.innerHTML = this._renderContextBlock(msg.content, msg.timestamp);
            } else if (msg.source === 'fork-reference') {
                // Fork reference - show link to parent session
                div.className = 'message info fork-reference';
                const parentName = escapeHtml(msg.forkedFromName || 'parent session');
                const parentId = msg.forkedFromId;
                div.innerHTML = `
                    <div class="message-header">
                        <span class="message-role fork">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="18" r="3"/>
                                <circle cx="6" cy="6" r="3"/>
                                <circle cx="18" cy="6" r="3"/>
                                <path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9"/>
                                <line x1="12" y1="12" x2="12" y2="15"/>
                            </svg>
                            fork
                        </span>
                        <span class="message-time">${formatTime(msg.timestamp)}</span>
                    </div>
                    <div class="message-content">
                        Forked from <a href="/app?session=${parentId}"
                            class="fork-parent-link"
                            target="_blank"
                            data-session-id="${parentId}"
                            data-tooltip="Open parent session in new tab">"${parentName}"</a>
                        <span class="fork-hint">— Claude has full context from the parent conversation</span>
                    </div>
                `;
            } else {
                div.className = 'message info';
                // Use markdown rendering for command output (has tables), plain text for simple info
                const contentHtml = msg.source === 'local-command-stdout'
                    ? `<div class="markdown-content">${this.ctx.markdown.render(msg.content)}</div>`
                    : escapeHtml(msg.content);
                div.innerHTML = `
                    <div class="message-header">
                        <span class="message-role info">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="10"/>
                                <line x1="12" y1="16" x2="12" y2="12"/>
                                <line x1="12" y1="8" x2="12.01" y2="8"/>
                            </svg>
                            info
                        </span>
                        <span class="message-time">${formatTime(msg.timestamp)}</span>
                    </div>
                    <div class="message-content">${contentHtml}</div>
                `;
            }
            messageContainer.appendChild(div);
            if (scroll) this.scrollToBottom();
            return;
        }

        // Handle context usage indicators (from /context command or turn_summary)
        // Upgrades existing partial bar or creates new full/partial bar
        if (msg.role === 'context') {
            const turnNumber = msg.turnNumber;
            // Find existing bar with same turn number — but only replace if it's a
            // partial/shimmer bar (live upgrade from turn_summary → context_update).
            // Full bars from earlier compaction epochs keep their position (turn numbers
            // restart after compaction, so T1 can appear multiple times).
            const existingBar = turnNumber
                ? messageContainer.querySelector(`#turn-summary-T${turnNumber}`)
                : null;
            const isPartialBar = existingBar?.querySelector('.context-bar-loading');
            const existingPartial = isPartialBar ? existingBar : null;
            // Don't replace rate-limit token switcher with context bar
            if (existingBar?.querySelector('.rate-limited-bar')) {
                return;
            }
            // Unique ID: use msg.id when available to avoid cross-epoch collisions
            const barId = msg.id ? `turn-summary-${msg.id}` : (turnNumber ? `turn-summary-T${turnNumber}` : `turn-${Date.now()}`);
            // Partial context messages (from turn_summary, before context fetch completes)
            // render as shimmer bars showing tools/cost/duration but no context fill.
            // Keyed on missing data, not the _partial flag: a sync merge can land
            // full context data on a message without clearing the flag.
            if (!msg.contextTokens) {
                const div = document.createElement('div');
                div.className = 'turn-summary-bar';
                div.id = barId;
                div.dataset.turnNumber = turnNumber || '';
                div.dataset.cwd = msg.cwd || window.app?.activeSession?.cwd || '';
                let headerHtml = '<div class="turn-header-row"><div class="turn-badge-group">';
                if (turnNumber) headerHtml += `<span class="turn-number">T${turnNumber}</span>`;
                headerHtml += '<span class="turn-expand-chevron" data-tooltip="Details">▼</span></div>';
                headerHtml += '<div class="context-bar-mini context-bar-loading"></div></div>';
                const toolsInline = this._buildToolsInline(msg.toolsSummary || {});
                const filesHtml = this._buildFilesRowHtml(msg.changedFiles || [], msg.fileActions || {});
                const toolsHtml = this._buildToolsRowHtml(toolsInline, this._formatDuration(msg.durationMs || 0), this._formatCost(msg.costUsd || 0), msg.model);
                div.innerHTML = headerHtml + filesHtml + toolsHtml;
                this._attachFilePillHandlers(div);
                if (existingPartial) {
                    existingPartial.replaceWith(div);
                } else {
                    messageContainer.appendChild(div);
                }
                this._repositionPlanApproval(messageContainer);
                if (scroll) this.scrollToBottom();
                return;
            }
            const div = this._renderContextIndicator(msg);
            if (div) {
                if (existingPartial) {
                    existingPartial.replaceWith(div);
                } else {
                    messageContainer.appendChild(div);
                }
                this._repositionPlanApproval(messageContainer);
                if (scroll) this.scrollToBottom();
            }
            return;
        }

        // Handle real-time grouping for thinking messages
        if (msg.role === 'thinking') {
            this.thinkingCtrl.renderThinkingMessageWithGrouping(msg);
            if (scroll) this.scrollToBottom();
            return;
        }

        // Handle real-time grouping for tool messages
        if (msg.role === 'tool') {
            this._renderToolMessageWithGrouping(msg);
            if (scroll) this.scrollToBottom();
            return;
        }

        // Handle AskUserQuestion - interactive question form
        if (msg.role === 'question') {
            const div = this._renderQuestionForm(msg);
            messageContainer.appendChild(div);
            if (scroll) this.scrollToBottom();
            return;
        }

        // Handle ExitPlanMode - interactive plan approval
        if (msg.role === 'plan_approval') {
            const div = this._renderPlanApproval(msg);
            messageContainer.appendChild(div);
            if (scroll) this.scrollToBottom();
            return;
        }

        // Handle interactive permission ask (claude-sdk can_use_tool)
        if (msg.role === 'permission') {
            const div = this._renderPermissionCard(msg);
            messageContainer.appendChild(div);
            if (scroll) this.scrollToBottom();
            return;
        }

        const div = document.createElement('div');
        const planModeClass = msg.planMode ? ' plan-mode' : '';
        div.className = `message ${msg.role}${planModeClass}`;
        div.id = `msg-${msg.id}`;

        const content = this._renderMessageContent(msg);

        const copyButton = (msg.role === 'assistant' || msg.role === 'user') ? `
            <button class="message-copy-btn" data-msg-id="${msg.id}" data-id="${escapeAttr(msg.id)}" data-act="copy-message" data-tooltip="Copy message">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                <span class="copy-label">Copy</span>
            </button>
        ` : '';

        // Favorite button for user messages (only if promptId is known)
        const favoriteButton = (msg.role === 'user') ? `
            <button class="message-favorite-btn${msg.isFavorite ? ' active' : ''}${msg.promptId ? '' : ' hidden'}"
                    data-msg-id="${msg.id}"
                    data-prompt-id="${msg.promptId || ''}"
                    data-act="toggle-message-favorite"
                    data-tooltip="${msg.isFavorite ? 'Remove from favorites' : 'Add to favorites'}">
                <svg class="heart-outline" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                </svg>
                <svg class="heart-filled" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                </svg>
            </button>
        ` : '';

        // Thinking indicator for user messages
        const effortIndicator = msg.role === 'user' ? this._renderEffortIndicator(msg.effort_level) : '';

        div.innerHTML = `
            <div class="message-header">
                <span class="message-role ${msg.role}">${this._authorLabel(msg)}</span>
                ${effortIndicator}
                <span class="message-time">${formatTime(msg.timestamp)}</span>
                ${favoriteButton}
                ${copyButton}
            </div>
            <div class="message-content">${content}</div>
        `;

        messageContainer.appendChild(div);

        // Render excalidraw code blocks as SVG diagrams
        MarkdownRenderer.processExcalidrawBlocks(div);
        // Render Vega-Lite chart code blocks as SVG charts
        MarkdownRenderer.processChartBlocks(div);

        // Track new assistant messages for the "new messages" indicator
        if (scroll && msg.role === 'assistant') {
            this.ctx.scrollManager?.trackNewMessage();
        }

        if (scroll) this.scrollToBottom();
    }

    /**
     * Generate thinking indicator HTML for user messages
     * Shows the thinking budget that was active when the message was sent
     * @private
     */
    _renderEffortIndicator(effortLevel) {
        if (!effortLevel) return '';

        const labels = { low: 'Lo', medium: 'Med', xhigh: 'XHi', max: 'Max' };
        const label = labels[effortLevel] || effortLevel;

        return `<span class="effort-indicator" data-level="${effortLevel}" data-tooltip="Effort: ${effortLevel}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 6v6l4 2" stroke-linecap="round"/>
            </svg>
            <span class="effort-indicator-label">${label}</span>
        </span>`;
    }

    /**
     * Render message content with attachment indicators
     * Handles both new format (metadata fields) and old format (suffix in content)
     * @private
     */
    _renderMessageContent(msg) {
        if (msg.role === 'assistant') {
            return `<div class="markdown-content">${this.ctx.markdown.render(msg.content, msg.verifiedFiles)}</div>`;
        }

        // User message - render markdown, then append attachment indicators
        let content = msg.content || '';

        // Strip old format "[X images attached]" suffix before rendering
        const oldFormatMatch = content.match(/\n\[(\d+ files?, )?(\d+) images? attached\]$/);
        if (oldFormatMatch) {
            content = content.slice(0, oldFormatMatch.index);
        }

        let rendered = this.ctx.markdown.render(content, msg.verifiedFiles);

        // Highlight thinking keywords after markdown rendering
        if (isThinkingKeywordsHighlightingEnabled()) {
            rendered = highlightThinkingKeywords(rendered);
        }

        let displayText = `<div class="markdown-content">${rendered}</div>`;

        // Render image thumbnails if available
        if (msg.imageThumbnails && msg.imageThumbnails.length > 0) {
            const thumbsHtml = msg.imageThumbnails.map(src =>
                `<div class="message-image-thumb" data-src="${escapeHtml(src)}"><img src="${escapeHtml(src)}" alt="Attached image"></div>`
            ).join('');
            displayText += `<div class="message-images">${thumbsHtml}</div>`;
        } else if (msg.hasImages && msg.imageCount > 0) {
            const attachments = [];
            if (msg.hasFiles && msg.fileCount > 0) {
                attachments.push(`${msg.fileCount} file${msg.fileCount > 1 ? 's' : ''}`);
            }
            attachments.push(`${msg.imageCount} image${msg.imageCount > 1 ? 's' : ''}`);
            displayText += `<span class="attachment-indicator">[${attachments.join(', ')} attached]</span>`;
        } else if (msg.hasFiles && msg.fileCount > 0) {
            displayText += `<span class="attachment-indicator">[${msg.fileCount} file${msg.fileCount > 1 ? 's' : ''} attached]</span>`;
        }

        // Old format fallback indicator
        if (oldFormatMatch) {
            const suffix = oldFormatMatch[0].slice(1);
            displayText += `<span class="attachment-indicator">${escapeHtml(suffix)}</span>`;
        }

        // Render stash references if attached
        if (msg.hasRefs && msg.stashRefs && msg.stashRefs.length > 0) {
            displayText += renderStashRefs(msg.stashRefs);
        }

        return displayText;
    }

    // ═══════════════════════════════════════════════════════════════
    // TURN SUMMARY BAR (formerly Context Indicator)
    // ═══════════════════════════════════════════════════════════════

    /**
     * Context-token count of the bar immediately preceding `msg` in the same
     * session — the baseline for this turn's "added tokens" delta and the
     * lighter "gain" segment of the mini bar.
     *
     * Derived from the session's ordered `messages` (the source of truth in
     * every render path) instead of a mutable per-controller field, so the
     * delta no longer depends on render order, lazy-load windows, tab switches,
     * or which session rendered last. Partial (shimmer) bars carry no tokens
     * and are skipped. Returns 0 when no prior context bar is loaded.
     * @private
     */
    _prevContextTokens(msg) {
        const msgs = this.ctx.session?.messages;
        if (!Array.isArray(msgs)) return 0;
        // Locate this message, then walk back to the previous real context bar.
        let idx = msg?.id ? msgs.findIndex(m => m.id === msg.id) : msgs.indexOf(msg);
        if (idx < 0) idx = msgs.length;  // Transient msg (not stored) → scan from end
        for (let i = idx - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.role === 'context' && !m._partial && typeof m.contextTokens === 'number') {
                return m.contextTokens;
            }
        }
        return 0;
    }

    /**
     * Render a Turn Summary Bar after each turn completes.
     * Shows: turn number, duration, cost, context bar, delta, files changed
     * Expandable to show file list, tools used, and context breakdown.
     * @private
     */
    _renderContextIndicator(msg) {
        const tokens = msg.contextTokens;
        const ctxWindow = msg.contextWindow;
        const percentage = msg.percentage || Math.round((tokens / ctxWindow) * 100);

        // Baseline for this turn's "added tokens" delta + gain segment: the
        // context bar immediately preceding this one in the SAME session, read
        // from the ordered message list rather than a mutable field. Keeps the
        // delta stable across the live path, full re-renders, lazy-load windows,
        // tab switches, and compaction epochs. Turn numbers restart after a
        // compaction/process restart, so a raw "last rendered anywhere" tracker
        // mismeasured the first turn of a new epoch — e.g. showing +100k on a
        // turn that changed nothing.
        const prevContext = this._prevContextTokens(msg);
        const delta = tokens - prevContext;

        // Don't show if no change AND no turn number (e.g., duplicate /context call)
        // Always render when there's a turnNumber — every turn deserves its bar
        if (delta === 0 && prevContext > 0 && !msg.turnNumber) return null;

        // Format helpers
        const formatK = (n) => {
            const abs = Math.abs(n);
            if (abs >= 1000) return `${(n / 1000).toFixed(1)}k`;
            return String(n);
        };

        // Calculate reserved buffer percentage (from breakdown if available)
        const reservedBuffer = msg.breakdown?.autocompact_buffer?.tokens || 0;
        const reservedPct = Math.round((reservedBuffer / ctxWindow) * 100);

        // Calculate effective percentage (used / usable window, excluding reserved)
        const usableWindow = ctxWindow - reservedBuffer;
        const effectivePct = reservedBuffer > 0 ? Math.round((tokens / usableWindow) * 100) : percentage;

        // Determine status class based on EFFECTIVE usage (what actually matters)
        let statusClass = '';
        let statusIcon = '';
        if (effectivePct >= 95) {
            statusClass = 'critical';
            statusIcon = '⚠️';
        } else if (effectivePct >= 85) {
            statusClass = 'danger';
            statusIcon = '⚡';
        } else if (effectivePct >= 70) {
            statusClass = 'warning';
        }

        // Delta display
        const deltaText = delta > 0 ? `+${formatK(delta)}` : formatK(delta);

        // Turn data from server
        const turnNumber = msg.turnNumber || null;
        const durationMs = msg.durationMs || 0;
        const costUsd = msg.costUsd || 0;
        const changedFiles = msg.changedFiles || [];
        const toolsSummary = msg.toolsSummary || {};
        const fileActions = msg.fileActions || {};
        const readImages = msg.readImages || [];

        // Format turn data
        const durationStr = this._formatDuration(durationMs);
        const costStr = this._formatCost(costUsd);
        const fileCount = changedFiles.length;

        // Build tools summary string (e.g., "Edit ×3  Bash ×2  Read ×5")
        const toolsStr = Object.entries(toolsSummary)
            .sort((a, b) => b[1] - a[1])  // Sort by count descending
            .map(([name, count]) => `${name} ×${count}`)
            .join('  ');

        const div = document.createElement('div');
        div.className = `turn-summary-bar ${statusClass}`;
        div.id = msg.id ? `turn-summary-${msg.id}` : (turnNumber ? `turn-summary-T${turnNumber}` : `turn-${Date.now()}`);
        if (turnNumber) div.dataset.turnNumber = String(turnNumber);
        if (msg.dbTurnId) div.dataset.turnId = msg.dbTurnId;

        // Store cwd for file preview (use msg.cwd from server, fallback to active session)
        const sessionCwd = msg.cwd || window.app?.activeSession?.cwd || '';
        div.dataset.cwd = sessionCwd;

        // Bar math
        const prevEffective = prevContext > 0 && usableWindow > 0 ? Math.round((prevContext / usableWindow) * 100) : 0;
        const gainEffectivePct = Math.max(0, effectivePct - prevEffective);
        const freePct = 100 - effectivePct;

        const toolsInline = this._buildToolsInline(toolsSummary);

        // Build header row HTML - [T16 ▼] [bar] [+11k]
        let headerHtml = '<div class="turn-header-row">';

        // Turn number + chevron grouped together (no gap between them)
        headerHtml += '<div class="turn-badge-group">';
        if (turnNumber) {
            headerHtml += `<span class="turn-number">T${turnNumber}</span>`;
        }
        headerHtml += `<span class="turn-expand-chevron" data-tooltip="Details">▼</span>`;
        headerHtml += '</div>';

        // Full-width context bar with fill segments and gain visualization
        const prevFillPct = Math.max(0, effectivePct - gainEffectivePct);
        headerHtml += `
            <div class="context-bar-mini ${statusClass}">
                <div class="context-fill-mini" style="width: ${prevFillPct}%"></div>
                <div class="context-gain-mini" style="left: ${prevFillPct}%; width: ${gainEffectivePct}%"></div>
                <div class="context-bar-text">
                    <span class="context-pct-effective">${statusIcon}${effectivePct}%</span>
                    <span class="context-tokens">${formatK(tokens)}/${formatK(usableWindow)}</span>
                </div>
            </div>`;

        // Delta display (token gain/loss this turn)
        if (delta !== 0) {
            headerHtml += `<span class="context-delta ${delta > 0 ? 'up' : 'down'}">${deltaText}</span>`;
        }
        headerHtml += '</div>';

        const sessionFiles = this._getSessionFiles(changedFiles);
        const filesHtml = this._buildFilesRowHtml(changedFiles, fileActions, sessionFiles, readImages, sessionCwd);
        const toolsHtml = this._buildToolsRowHtml(toolsInline, durationStr, costStr, msg.model);

        // Build expanded details HTML - context breakdown (cost moved to tools row)
        let expandedHtml = '<div class="turn-expanded-details">';

        // Context breakdown
        if (msg.breakdown) {
            expandedHtml += this._renderContextBreakdown(msg.breakdown);
        } else {
            expandedHtml += `<div class="turn-context-simple">${formatK(tokens)} / ${formatK(usableWindow)} tokens (${effectivePct}% used)</div>`;
        }
        expandedHtml += '</div>';

        div.innerHTML = headerHtml + filesHtml + toolsHtml + expandedHtml;

        // Store msg for later use
        div._contextMsg = msg;

        // Expand toggle - only on chevron or header row (not files/tools)
        const handleExpandToggle = (e) => {
            // Prevent keyboard on iOS
            e.preventDefault();
            if (document.activeElement && document.activeElement.blur) {
                document.activeElement.blur();
            }

            // Don't toggle when clicking interactive elements
            if (e.target.closest('.turn-file-pill') ||
                e.target.closest('.session-file-row') ||
                e.target.closest('.session-compact-file') ||
                e.target.closest('button') ||
                e.target.closest('a')) {
                return;
            }

            const wasExpanded = div.classList.contains('expanded');
            div.classList.toggle('expanded');

            if (!wasExpanded) {
                // Lazy-load session files on first expand
                if (!div._sessionFilesRendered) {
                    this._renderSessionFilesExpanded(div);
                }
                requestAnimationFrame(() => {
                    div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                });
            }
        };

        bindTapHandler(div, handleExpandToggle);

        this._attachFilePillHandlers(div);
        this._attachCompactFileHandlers(div);

        // Async git status decoration (fire-and-forget)
        setTimeout(() => this._fetchGitStatusForTurn(div), 0);

        return div;
    }

    /**
     * Render a partial Turn Summary Bar immediately when turn completes.
     * Shows files, tools, cost, duration — but no context bar (still loading).
     * Will be upgraded in-place when context_update arrives.
     * @param {Object} msg - turn_summary message from server
     */
    renderTurnSummaryPartial(msg) {
        const messageContainer = this._getActiveMessageContainer();
        if (!messageContainer) return;

        const turnNumber = msg.turnNumber || null;
        const durationMs = msg.durationMs || 0;
        const costUsd = msg.costUsd || 0;
        const changedFiles = msg.changedFiles || [];
        const toolsSummary = msg.toolsSummary || {};
        const fileActions = msg.fileActions || {};
        const readImages = msg.readImages || [];

        const durationStr = this._formatDuration(durationMs);
        const costStr = this._formatCost(costUsd);
        const toolsInline = this._buildToolsInline(toolsSummary);

        const div = document.createElement('div');
        div.className = 'turn-summary-bar';
        div.id = turnNumber ? `turn-summary-T${turnNumber}` : `turn-${Date.now()}`;

        const sessionCwd = msg.cwd || window.app?.activeSession?.cwd || '';
        div.dataset.cwd = sessionCwd;
        if (msg.dbTurnId) div.dataset.turnId = msg.dbTurnId;

        // Header row with turn badge + context bar (or rate-limit switcher)
        let headerHtml = '<div class="turn-header-row">';
        headerHtml += '<div class="turn-badge-group">';
        if (turnNumber) {
            headerHtml += `<span class="turn-number">T${turnNumber}</span>`;
        }
        headerHtml += `<span class="turn-expand-chevron" data-tooltip="Details">▼</span>`;
        headerHtml += '</div>';

        if (msg.rateLimited) {
            headerHtml += `<div class="context-bar-mini rate-limited-bar">
                <div class="context-bar-text">
                    <span class="rate-limit-label">Switch token:</span>
                    <span class="rate-limit-profiles"></span>
                </div>
            </div>`;
        } else {
            headerHtml += '<div class="context-bar-mini context-bar-loading"></div>';
        }
        headerHtml += '</div>';

        const sessionFiles = this._getSessionFiles(changedFiles);
        const filesHtml = this._buildFilesRowHtml(changedFiles, fileActions, sessionFiles, readImages, sessionCwd);
        const toolsHtml = this._buildToolsRowHtml(toolsInline, durationStr, costStr, msg.model);

        div.innerHTML = headerHtml + filesHtml + toolsHtml;
        this._attachFilePillHandlers(div);
        this._attachCompactFileHandlers(div);

        messageContainer.appendChild(div);
        this._repositionPlanApproval(messageContainer);

        if (msg.rateLimited) {
            this._initRateLimitSwitcher(div);
        }

        this.scrollToBottom();
    }

    /**
     * Initialize rate-limit token profile switcher inside a turn summary bar.
     * Fetches available profiles and wires up the apply button.
     * @private
     */
    _initRateLimitSwitcher(barEl) {
        const container = barEl.querySelector('.rate-limit-profiles');
        if (!container) return;

        // Use tokenProfile's color function if available
        const getColor = window.tokenProfile?.constructor
            ? (name) => {
                const colors = ['#4a9eff','#67c23a','#e6a23c','#f56c6c','#b37feb','#36cfc9','#ff85c0','#ffd666'];
                let h = 0;
                for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
                return colors[Math.abs(h) % colors.length];
            }
            : () => 'var(--text-secondary)';

        fetch('/api/app/token-profiles')
            .then(r => r.json())
            .then(data => {
                if (!data.profiles?.length) {
                    container.textContent = 'No profiles available';
                    return;
                }
                for (const p of data.profiles) {
                    const btn = document.createElement('button');
                    btn.className = 'rate-limit-profile-btn';
                    btn.dataset.profile = p.name;
                    const dot = document.createElement('span');
                    dot.className = 'rate-limit-dot';
                    dot.style.background = getColor(p.name);
                    btn.appendChild(dot);
                    btn.appendChild(document.createTextNode(p.name));
                    container.appendChild(btn);
                }
            })
            .catch(() => {
                container.textContent = 'Error loading profiles';
            });

        container.addEventListener('click', (e) => {
            const btn = e.target.closest('.rate-limit-profile-btn');
            if (!btn) return;
            // Update the toolbar button state — will be sent with next message
            window.tokenProfile?.selectProfile(btn.dataset.profile);
            btn.classList.add('applied');
        });
    }

    /**
     * Move any plan-approval card to appear after the last turn-summary-bar.
     * Called after turn summary renders so the approval card sits at the end of the turn.
     * @private
     */
    _repositionPlanApproval(container) {
        const approvals = container.querySelectorAll('.message.plan-approval:not(.answered)');
        if (!approvals.length) return;

        const lastApproval = approvals[approvals.length - 1];
        const bars = container.querySelectorAll('.turn-summary-bar');
        if (!bars.length) return;

        const lastBar = bars[bars.length - 1];

        // If approval comes before bar in DOM order, move it after
        if (lastApproval.compareDocumentPosition(lastBar) & Node.DOCUMENT_POSITION_FOLLOWING) {
            lastBar.after(lastApproval);
        }
    }

    /**
     * Render context breakdown HTML for expanded view
     * @private
     */
    _renderContextBreakdown(breakdown) {
        const formatK = (n) => {
            if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
            return String(n);
        };

        const order = ['system_prompt', 'system_tools', 'custom_agents', 'memory_files', 'skills', 'messages', 'free_space', 'autocompact_buffer'];
        const labels = {
            system_prompt: 'System prompt',
            system_tools: 'Tool definitions',
            custom_agents: 'Custom agents',
            memory_files: 'Memory files',
            skills: 'Skills',
            messages: 'Conversation',
            free_space: 'Free space',
            autocompact_buffer: 'Reserved buffer'
        };

        // Collect valid items
        const items = [];
        for (const key of order) {
            if (breakdown[key]) {
                const { tokens, pct } = breakdown[key];
                const isFree = key === 'free_space' || key === 'autocompact_buffer';
                items.push({ label: labels[key] || key, tokens, pct, muted: isFree });
            }
        }

        // Flipped table: labels as column headers, values below
        let html = '<table class="turn-context-breakdown">';
        // Header row — all labels
        html += '<tr>';
        for (const item of items) {
            const cls = item.muted ? ' class="muted"' : '';
            html += `<th${cls}>${item.label}</th>`;
        }
        html += '</tr>';
        // Values row — tokens + pct combined
        html += '<tr>';
        for (const item of items) {
            const mutedCls = item.muted ? ' muted' : '';
            html += `<td><span class="breakdown-tokens${mutedCls}">${formatK(item.tokens)}</span> <span class="breakdown-pct${mutedCls}">${item.pct.toFixed(1)}%</span></td>`;
        }
        html += '</tr>';
        html += '</table>';
        return html;
    }

    /** @private */
    _formatDuration(ms) {
        if (!ms || ms <= 0) return null;
        const sec = Math.floor(ms / 1000);
        if (sec < 60) return `${sec}s`;
        const min = Math.floor(sec / 60);
        const remSec = sec % 60;
        return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
    }

    /** @private */
    _formatCost(usd) {
        if (!usd || usd <= 0) return null;
        if (usd < 0.01) return `$${usd.toFixed(3)}`;
        if (usd < 0.10) return `$${usd.toFixed(2)}`;
        return `$${usd.toFixed(2)}`;
    }

    /** @private */
    _buildToolsInline(toolsSummary) {
        return Object.entries(toolsSummary)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([name, count]) => `${name} ×${count}`)
            .join(' • ');
    }

    /** @private */
    _buildFilesRowHtml(changedFiles, fileActions, sessionFiles, readImages, cwd) {
        const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const changedSet = new Set(changedFiles || []);
        const turnImages = (readImages || []).filter(fp => FILES_ROW_IMAGE_RE.test(fp) && !changedSet.has(fp));

        // Filter out user-hidden session files
        const hiddenSet = this._hiddenSessionFiles.get(window.app?.activeSession?.id) || new Set();
        const visibleSession = sessionFiles ? [...sessionFiles.entries()].filter(([fp]) => !hiddenSet.has(fp)) : [];

        // Row budget: current-turn pills (changed + image thumbs) always render
        // in full, even past the cap. Session-accumulated pills fill the
        // remaining slots — changed files first, image thumbs last. Truncation
        // always drops the OLDEST items; display stays chronological
        // (oldest → newest), matching the session-changed pill convention.
        let budget = Math.max(0, FILES_ROW_CAP - changedSet.size - turnImages.length);
        const sessionChanged = budget > 0 ? visibleSession.slice(-budget) : [];
        budget -= sessionChanged.length;
        let sessionImages = [];
        if (budget > 0) {
            // Never show a thumb for a file modified anywhere in the session
            // (or hidden by the user) — changed pills own those paths.
            const exclude = new Set([...changedSet, ...turnImages, ...hiddenSet]);
            if (sessionFiles) for (const fp of sessionFiles.keys()) exclude.add(fp);
            const taken = [];
            for (const group of this._getSessionReadImages(exclude)) {  // newest turn first
                if (budget <= 0) break;
                const take = group.slice(0, budget);
                taken.push(take);
                budget -= take.length;
            }
            sessionImages = taken.reverse().flat();  // display oldest → newest
        }

        const hasChanged = changedSet.size > 0;
        const hasImages = turnImages.length > 0 || sessionImages.length > 0;
        if (!hasChanged && sessionChanged.length === 0 && !hasImages) return '';

        let html = '<div class="turn-files-row">';
        if (hasChanged) {
            for (const filePath of changedFiles) {
                const fileName = basename(filePath);
                const stats = fileActions[filePath] || {};
                const adds = stats.adds || 0;
                const dels = stats.dels || 0;
                const isNew = stats.created || false;

                let pillContent = `<span class="file-name">${escHtml(fileName)}</span>`;
                if (isNew) pillContent += `<span class="file-new">new</span>`;
                if (adds > 0) pillContent += `<span class="file-adds">+${adds}</span>`;
                if (dels > 0) pillContent += `<span class="file-dels">-${dels}</span>`;

                html += `<span class="turn-file-pill" data-file-path="${escHtml(filePath)}"${isNew ? ' data-file-created="true"' : ''} data-tooltip="${escHtml(filePath)}">${pillContent}</span>`;
            }
        }
        if (sessionChanged.length > 0) {
            if (hasChanged) html += '<span class="turn-files-sep"></span>';
            for (const [fp, stats] of sessionChanged) {
                const name = basename(fp);
                let pillContent = `<span class="file-name">${escHtml(name)}</span>`;
                if (stats.created) pillContent += `<span class="file-new">new</span>`;
                if (stats.adds > 0) pillContent += `<span class="file-adds">+${stats.adds}</span>`;
                if (stats.dels > 0) pillContent += `<span class="file-dels">-${stats.dels}</span>`;
                pillContent += `<span class="session-file-hide" data-hide-path="${escHtml(fp)}" data-tooltip="Hide">×</span>`;
                html += `<span class="turn-file-pill session-compact-file" data-file-path="${escHtml(fp)}"${stats.created ? ' data-file-created="true"' : ''} data-tooltip="${escHtml(fp)}">${pillContent}</span>`;
            }
        }
        if (hasImages) {
            if (hasChanged || sessionChanged.length > 0) html += '<span class="turn-files-sep"></span>';
            // Thumbs keep .turn-read-file so git-dot exclusion and pill handlers
            // apply; a tap routes through previewFile → image gallery, where
            // collectImages() picks these pills up for session-wide navigation.
            const thumb = (fp, extraClass, tooltip) => {
                const full = isAbsolutePath(fp) ? fp : (cwd ? joinPath(cwd, fp) : fp);
                return `<span class="turn-file-pill turn-read-file turn-image-thumb${extraClass}" data-file-path="${escHtml(fp)}" data-tooltip="${escHtml(tooltip.replace('{path}', fp))}"><img src="/api/file-raw?path=${encodeURIComponent(full)}" alt="${escHtml(basename(fp))}" loading="lazy"></span>`;
            };
            for (const fp of turnImages) html += thumb(fp, '', S.turn_bar.read_tooltip);
            for (const fp of sessionImages) html += thumb(fp, ' session-read', S.turn_bar.read_session_tooltip);
        }
        html += '</div>';
        return html;
    }

    /** @private */
    _buildToolsRowHtml(toolsInline, durationStr, costStr, modelId) {
        if (!toolsInline && !durationStr && !costStr) return '';
        let html = '<div class="turn-tools-row">';
        if (toolsInline) {
            html += `<span class="turn-tools-list">${toolsInline}</span>`;
        }
        html += `<span class="turn-expand-hint">${S.turn_bar.expand_hint}</span>`;
        html += '<span class="turn-right-stats">';
        if (modelId) {
            const short = modelId.replace('claude-', '').replace(/-\d{8}$/, '');
            html += `<span class="turn-model-inline">${short}</span>`;
            html += '<span class="turn-stats-sep">•</span>';
        }
        if (costStr) {
            html += `<span class="turn-cost-inline">${costStr}</span>`;
        }
        if (durationStr) {
            if (costStr) html += '<span class="turn-stats-sep">•</span>';
            html += `<span class="turn-duration-inline">${durationStr}</span>`;
        }
        html += '</span>';
        html += '</div>';
        return html;
    }

    /**
     * Get session-accumulated files (from previous turns), excluding current turn files.
     * Returns Map of path → { adds, dels, created } or null if empty.
     * @private
     */
    _getSessionFiles(currentChangedFiles) {
        const session = window.app?.activeSession;
        if (!session) return null;

        const currentSet = new Set(currentChangedFiles || []);
        const sessionFiles = new Map();

        for (const msg of session.messages) {
            if (msg.role !== 'context' || !msg.changedFiles) continue;
            for (const fp of msg.changedFiles) {
                if (currentSet.has(fp)) continue;
                if (!sessionFiles.has(fp)) sessionFiles.set(fp, { adds: 0, dels: 0, created: false });
                const entry = sessionFiles.get(fp);
                const actions = msg.fileActions?.[fp];
                if (actions) {
                    entry.adds += actions.adds || 0;
                    entry.dels += actions.dels || 0;
                    if (actions.created) entry.created = true;
                }
            }
        }

        return sessionFiles.size > 0 ? sessionFiles : null;
    }

    /**
     * Get Read-tool images accumulated from previous turns, as one group per
     * turn, NEWEST turn first (so budget truncation keeps the most recent
     * shots) with in-turn read order preserved. Callers reverse the kept
     * groups for chronological display. Mirrors _getSessionFiles.
     * @private
     */
    _getSessionReadImages(excludeSet) {
        const session = window.app?.activeSession;
        if (!session) return [];

        const groups = [];
        const seen = new Set();
        for (let i = session.messages.length - 1; i >= 0; i--) {
            const msg = session.messages[i];
            if (msg.role !== 'context' || !msg.readImages) continue;
            const group = [];
            for (const fp of msg.readImages) {
                if (!FILES_ROW_IMAGE_RE.test(fp) || seen.has(fp) || excludeSet.has(fp)) continue;
                seen.add(fp);
                group.push(fp);
            }
            if (group.length) groups.push(group);
        }
        return groups;
    }

    /**
     * Attach click/touch handlers to .turn-file-pill elements within a container.
     * @private
     */
    _attachFilePillHandlers(container) {
        // Image thumbs whose file vanished (test screenshots get overwritten
        // between runs) would render as broken-image glyphs — hide them.
        container.querySelectorAll('.turn-image-thumb img').forEach(img => {
            img.addEventListener('error', () => {
                img.closest('.turn-image-thumb')?.remove();
            }, { once: true });
        });
        container.querySelectorAll('.turn-file-pill').forEach(pill => {
            const handleFileTap = async (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (document.activeElement && document.activeElement.blur) {
                    document.activeElement.blur();
                }
                const filePath = pill.dataset.filePath;
                const cwd = container.dataset.cwd;
                if (!filePath) return;
                const fullPath = isAbsolutePath(filePath) ? filePath : (cwd ? joinPath(cwd, filePath) : filePath);

                if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
                    // Cmd+Shift+Click → foreground new tab
                    this._openFileInTab(fullPath);
                    return;
                } else if (e.metaKey || e.ctrlKey) {
                    // Cmd/Ctrl+Click → background tab (browser convention)
                    this._openFileInTab(fullPath, { background: true });
                    return;
                } else {
                    // Default → plain file preview
                    this._openFilePreviewDirect(fullPath);
                }
            };
            bindTapHandler(pill, handleFileTap);
            pill.addEventListener('auxclick', (e) => {
                if (e.button === 1) {
                    // Middle-click → background tab (browser convention)
                    e.preventDefault();
                    const filePath = pill.dataset.filePath;
                    const cwd = container.dataset.cwd;
                    if (!filePath) return;
                    const fullPath = isAbsolutePath(filePath) ? filePath : (cwd ? joinPath(cwd, filePath) : filePath);
                    this._openFileInTab(fullPath, { background: true });
                }
            });
        });
    }

    /**
     * Attach click/touch handlers to .session-compact-file elements.
     * @private
     */
    _attachCompactFileHandlers(container) {
        container.querySelectorAll('.session-compact-file').forEach(el => {
            const handleTap = (e) => {
                // Hide button click — remove this pill from all turn bars
                if (e.target.closest('.session-file-hide')) {
                    e.preventDefault();
                    e.stopPropagation();
                    const hidePath = e.target.closest('.session-file-hide').dataset.hidePath;
                    if (hidePath) this._hideSessionFile(hidePath);
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                const filePath = el.dataset.filePath;
                const cwd = container.dataset.cwd;
                if (filePath) {
                    const fullPath = isAbsolutePath(filePath) ? filePath : (cwd ? joinPath(cwd, filePath) : filePath);
                    this._openFilePreviewDirect(fullPath);
                }
            };
            bindTapHandler(el, handleTap);
        });
    }

    /**
     * Hide a session file from all turn summary bars' inline pills.
     * File remains visible in expanded session files view.
     * @private
     */
    _hideSessionFile(filePath) {
        const sessionId = window.app?.activeSession?.id;
        if (sessionId) {
            if (!this._hiddenSessionFiles.has(sessionId)) {
                this._hiddenSessionFiles.set(sessionId, new Set());
            }
            this._hiddenSessionFiles.get(sessionId).add(filePath);
        }
        // Remove all matching session-compact pills from DOM
        document.querySelectorAll(`.session-compact-file[data-file-path="${CSS.escape(filePath)}"]`).forEach(el => {
            el.remove();
        });
        // Clean up empty separators and files rows
        document.querySelectorAll('.turn-files-row').forEach(row => {
            const sep = row.querySelector('.turn-files-sep');
            if (sep && !row.querySelector('.session-compact-file')) {
                sep.remove();
            }
            if (row.children.length === 0) {
                row.remove();
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Git status indicators on turn summary bars
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Normalize a file path to be relative to cwd for git status matching.
     * Turn tracker stores absolute paths; git status returns repo-relative paths.
     * @private
     */
    _normalizePathForGit(filePath, cwd) {
        if (!filePath || !cwd) return filePath;
        if (filePath.startsWith(cwd + '/')) {
            return filePath.slice(cwd.length + 1);
        }
        return filePath;
    }

    /**
     * Fetch git status and decorate a turn summary bar's file pills.
     * Called after the full bar (context_update) renders. Fire-and-forget.
     * @private
     */
    async _fetchGitStatusForTurn(barElement) {
        const cwd = barElement.dataset.cwd;
        if (!cwd) return;

        try {
            const resp = await fetch(`${CONFIG.API_BASE}/api/git/status?cwd=${encodeURIComponent(cwd)}`);
            if (!resp.ok) return;
            const data = await resp.json();
            if (data.error) return;

            // Build lookup: relative path → status
            const gitFileMap = new Map();
            for (const f of (data.staged || [])) gitFileMap.set(f.path, 'staged');
            for (const f of (data.modified || [])) gitFileMap.set(f.path, 'modified');
            for (const f of (data.untracked || [])) gitFileMap.set(f.path, 'untracked');

            // Store on element for expanded view reuse
            barElement._gitFileMap = gitFileMap;

            this._decorateFilePillsWithGitStatus(barElement, gitFileMap, cwd);
            this._renderGitSummaryIndicator(barElement, gitFileMap, cwd);
        } catch (err) {
            // Graceful degradation: pills stay as-is
            console.debug('Git status fetch failed for turn bar:', err);
        }
    }

    /**
     * Add git status indicators to file pills within a turn summary bar.
     * @private
     */
    _decorateFilePillsWithGitStatus(barElement, gitFileMap, cwd) {
        // Read-only chips stay undecorated — a workspace M/S/? dot on a file
        // this turn merely read implies a change it didn't make.
        for (const pill of barElement.querySelectorAll('.turn-file-pill:not(.turn-read-file)')) {
            const rawPath = pill.dataset.filePath;
            const relPath = this._normalizePathForGit(rawPath, cwd);
            const status = gitFileMap.get(relPath);

            // Remove any previous indicator
            pill.querySelector('.git-status-dot')?.remove();
            pill.classList.remove('git-modified', 'git-staged', 'git-untracked');

            if (status) {
                // Uncommitted file — add status dot badge
                pill.classList.add(`git-${status}`);
                const dot = document.createElement('span');
                dot.className = `git-status-dot git-dot-${status}`;
                dot.textContent = status === 'staged' ? 'S' : status === 'modified' ? 'M' : '?';
                pill.prepend(dot);
            }
            // Committed files: no decoration, keep original pill appearance
        }
    }

    /**
     * Render a compact git status summary in the tools row.
     * Shows "N uncommitted" or checkmark if all clean.
     * @private
     */
    _renderGitSummaryIndicator(barElement, gitFileMap, cwd) {
        // Collect ALL session file paths (all turns), not just this turn's pills
        const session = this.session;
        const sessionPaths = new Set();
        if (session?.messages) {
            for (const msg of session.messages) {
                if (msg.role !== 'context' || !msg.changedFiles) continue;
                for (const filePath of msg.changedFiles) {
                    sessionPaths.add(this._normalizePathForGit(filePath, cwd));
                }
            }
        }
        // Fallback: if no context messages yet, use turn pills
        if (sessionPaths.size === 0) {
            for (const pill of barElement.querySelectorAll('.turn-file-pill:not(.turn-read-file)')) {
                sessionPaths.add(this._normalizePathForGit(pill.dataset.filePath, cwd));
            }
        }

        let uncommittedCount = 0;
        for (const relPath of sessionPaths) {
            if (gitFileMap.has(relPath)) uncommittedCount++;
        }

        const rightStats = barElement.querySelector('.turn-right-stats');
        if (!rightStats) return;

        // Remove existing indicators + separators
        for (const el of rightStats.querySelectorAll('.turn-git-summary, .turn-git-project-count, .turn-git-sep')) {
            el.remove();
        }

        // Count "other" files (not in this session) by status type
        let otherM = 0, otherS = 0, otherU = 0, otherD = 0;
        for (const [path, status] of gitFileMap) {
            if (sessionPaths.has(path)) continue;
            if (status === 'modified') otherM++;
            else if (status === 'staged') otherS++;
            else if (status === 'untracked') otherU++;
            else if (status === 'deleted') otherD++;
        }
        const otherTotal = otherM + otherS + otherU + otherD;

        // "Other" breakdown — e.g. "1M 2?" or "3M 1S 5?"
        if (otherTotal > 0) {
            const parts = [];
            if (otherM > 0) parts.push(`${otherM}M`);
            if (otherS > 0) parts.push(`${otherS}S`);
            if (otherD > 0) parts.push(`${otherD}D`);
            if (otherU > 0) parts.push(`${otherU}?`);

            const projectSep = document.createElement('span');
            projectSep.className = 'turn-stats-sep turn-git-sep';
            projectSep.textContent = '•';
            const projectSpan = document.createElement('span');
            projectSpan.className = 'turn-git-project-count';
            projectSpan.textContent = parts.join(' ');
            projectSpan.setAttribute('data-tooltip', `${otherTotal} other uncommitted: ${parts.join(', ')}`);
            rightStats.prepend(projectSep);
            rightStats.prepend(projectSpan);
        }

        // Session indicator
        const indicator = document.createElement('span');
        indicator.className = 'turn-git-summary';

        if (uncommittedCount === 0) {
            indicator.classList.add('git-all-clean');
            indicator.innerHTML = '✓';
            indicator.setAttribute('data-tooltip', 'All turn files committed');
        } else {
            indicator.classList.add('git-has-uncommitted');
            indicator.textContent = `${uncommittedCount} uncommitted`;
            indicator.setAttribute('data-tooltip', `${uncommittedCount} file${uncommittedCount > 1 ? 's' : ''} not yet committed`);
        }

        const sep = document.createElement('span');
        sep.className = 'turn-stats-sep turn-git-sep';
        sep.textContent = '•';
        rightStats.prepend(sep);
        rightStats.prepend(indicator);
    }

    /**
     * Render aggregated session files in the expanded details section.
     * Shows all files changed across the session with git status.
     * Lazy-loaded on first expand.
     * @private
     */
    async _renderSessionFilesExpanded(barElement) {
        if (barElement._sessionFilesRendered) return;
        barElement._sessionFilesRendered = true;

        const session = window.app?.activeSession;
        if (!session) return;

        const cwd = barElement.dataset.cwd || session.cwd || '';

        // Aggregate all changed files from session context messages
        const sessionFileMap = new Map(); // relPath → { turns: Set, adds: 0, dels: 0 }
        for (const msg of session.messages) {
            if (msg.role !== 'context' || !msg.changedFiles) continue;
            const tn = msg.turnNumber;
            for (const filePath of msg.changedFiles) {
                const relPath = this._normalizePathForGit(filePath, cwd);
                if (!sessionFileMap.has(relPath)) {
                    sessionFileMap.set(relPath, { turns: new Set(), adds: 0, dels: 0 });
                }
                const entry = sessionFileMap.get(relPath);
                if (tn) entry.turns.add(tn);
                const actions = msg.fileActions?.[filePath];
                if (actions) {
                    entry.adds += actions.adds || 0;
                    entry.dels += actions.dels || 0;
                }
            }
        }

        // Reuse cached git status or fetch fresh
        let gitFileMap = barElement._gitFileMap;
        if (!gitFileMap) {
            try {
                const resp = await fetch(`${CONFIG.API_BASE}/api/git/status?cwd=${encodeURIComponent(cwd)}`);
                const data = await resp.json();
                gitFileMap = new Map();
                for (const f of (data.staged || [])) gitFileMap.set(f.path, 'staged');
                for (const f of (data.modified || [])) gitFileMap.set(f.path, 'modified');
                for (const f of (data.untracked || [])) gitFileMap.set(f.path, 'untracked');
                barElement._gitFileMap = gitFileMap;
            } catch {
                gitFileMap = new Map();
            }
        }

        // Nothing to show if no session files and no dirty project files
        if (sessionFileMap.size === 0 && gitFileMap.size === 0) return;

        const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        let html = '<div class="turn-session-files">';

        // Session changes section (only if session has files)
        if (sessionFileMap.size > 0) {
            let uncommitted = 0;
            for (const relPath of sessionFileMap.keys()) {
                if (gitFileMap.has(relPath)) uncommitted++;
            }
            const summaryText = uncommitted === 0
                ? `${sessionFileMap.size} files — all committed`
                : `${sessionFileMap.size} files — ${uncommitted} uncommitted`;

            html += `<div class="session-files-header">Session Changes <span class="session-files-count">${summaryText}</span></div>`;

            // Sort: uncommitted first, then committed
            const sorted = [...sessionFileMap.entries()].sort((a, b) => {
                const aUncommitted = gitFileMap.has(a[0]) ? 0 : 1;
                const bUncommitted = gitFileMap.has(b[0]) ? 0 : 1;
                return aUncommitted - bUncommitted;
            });

            html += '<div class="session-files-grid">';
            for (const [relPath, info] of sorted) {
                const gitStatus = gitFileMap.get(relPath);
                const statusClass = gitStatus || 'committed';
                const statusIcon = gitStatus
                    ? (gitStatus === 'staged' ? 'S' : gitStatus === 'modified' ? 'M' : '?')
                    : '✓';
                const fileName = basename(relPath);
                const turnsStr = info.turns.size > 0 ? [...info.turns].map(t => `T${t}`).join(' ') : '';
                const statsStr = (info.adds > 0 || info.dels > 0)
                    ? `<span class="sf-stats">${info.adds > 0 ? `<span class="file-adds">+${info.adds}</span>` : ''}${info.dels > 0 ? `<span class="file-dels">-${info.dels}</span>` : ''}</span>`
                    : '';

                html += `<div class="session-file-row git-${statusClass}" data-file-path="${escHtml(relPath)}">
                    <span class="session-file-status">${statusIcon}</span>
                    <span class="session-file-name" data-tooltip="${escHtml(relPath)}">${escHtml(fileName)}</span>
                    ${statsStr}
                    <span class="session-file-turns">${turnsStr}</span>
                </div>`;
            }
            html += '</div>';
        }

        // Other uncommitted files not touched by session
        const otherDirty = [];
        for (const [path, status] of gitFileMap) {
            if (!sessionFileMap.has(path)) otherDirty.push({ path, status });
        }

        if (otherDirty.length > 0) {
            const label = sessionFileMap.size > 0 ? `${otherDirty.length} other uncommitted` : `${otherDirty.length} uncommitted in project`;
            html += `<div class="session-files-header other-files-header">${label}</div>`;
            html += '<div class="session-files-grid">';
            for (const { path, status } of otherDirty.slice(0, 20)) {
                const statusIcon = status === 'staged' ? 'S' : status === 'modified' ? 'M' : '?';
                const fileName = basename(path);
                html += `<div class="session-file-row git-${status}" data-file-path="${escHtml(path)}">
                    <span class="session-file-status">${statusIcon}</span>
                    <span class="session-file-name" data-tooltip="${escHtml(path)}">${escHtml(fileName)}</span>
                </div>`;
            }
            if (otherDirty.length > 20) {
                html += `<div class="session-files-more">...${otherDirty.length - 20} more</div>`;
            }
            html += '</div>';
        }

        html += '</div>';

        // Insert into expanded details
        const expandedDetails = barElement.querySelector('.turn-expanded-details');
        if (expandedDetails) {
            expandedDetails.insertAdjacentHTML('beforeend', html);
            // Attach click handlers to session file rows for file preview
            this._attachSessionFileRowHandlers(expandedDetails, cwd);
        }
    }

    /**
     * Attach click handlers to .session-file-row elements for file preview.
     * @private
     */
    _attachSessionFileRowHandlers(container, cwd) {
        for (const row of container.querySelectorAll('.session-file-row[data-file-path]')) {
            row.style.cursor = 'pointer';
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                const filePath = row.dataset.filePath;
                if (filePath) {
                    const fullPath = isAbsolutePath(filePath) ? filePath : (cwd ? joinPath(cwd, filePath) : filePath);
                    this._openFilePreviewDirect(fullPath);
                }
            });
        }
    }

    /**
     * Open file in file preview widget (absolute path)
     * @private
     */
    _openFilePreviewDirect(fullPath) {
        // Use app.previewFile which has the correctly-imported FilePreviewWidget
        // (dynamic import would load a separate module instance due to cache-bust
        // query params, creating disconnected state from WidgetManager)
        if (window.app?.previewFile) {
            window.app.previewFile(fullPath);
        }
    }

    /**
     * Open file in a full tab (via TabController)
     * @param {string} fullPath - Absolute file path
     * @param {Object} options - Options passed to openFilePreviewTab
     * @private
     */
    _openFileInTab(fullPath, options = {}) {
        const tabCtrl = window.app?.tabCtrl;
        if (tabCtrl) {
            tabCtrl.openFilePreviewTab(fullPath, null, options);
        } else {
            // Fallback to floating preview if TabController not available
            this._openFilePreviewDirect(fullPath);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // TOOL GROUPING
    // ═══════════════════════════════════════════════════════════════

    /**
     * Render a group of consecutive tool messages with collapse-all button
     * @private
     */
    _renderToolGroup(toolMessages) {
        const groupId = `tool-group-${toolMessages[0].id}`;

        // Create group container
        const groupDiv = document.createElement('div');
        groupDiv.className = 'tool-group';
        groupDiv.id = groupId;

        // Add collapse-all button at the START for sticky positioning
        const collapseAllBtn = `
            <button class="tool-group-collapse-btn" data-act="toggle-tool-group" data-id="${escapeAttr(groupId)}" data-tooltip="Collapse/expand all tools">
                <svg class="collapse-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                    <path d="M7 13l5 5 5-5M7 6l5 5 5-5"/>
                </svg>
                <svg class="expand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                    <path d="M13 17l5-5-5-5M6 17l5-5-5-5"/>
                </svg>
            </button>
        `;
        groupDiv.insertAdjacentHTML('afterbegin', collapseAllBtn);

        // Render each tool message
        for (const msg of toolMessages) {
            const div = document.createElement('div');
            div.className = 'message tool';
            div.id = `msg-${msg.id}`;
            div.innerHTML = this.ctx.toolRenderer.renderToolBlock(msg);
            this.ctx.toolRenderer.processWriteCharts(div);
            this.ctx.toolRenderer.processWriteExcalidraw(div);
            this.ctx.toolRenderer.processReadExcalidraw(div);
            groupDiv.appendChild(div);
        }

        // Append to correct container (session-specific with pool, or #messages)
        this._getActiveMessageContainer().appendChild(groupDiv);
    }

    /**
     * Create a tool group DOM element without appending it
     * Used by prependMessages for older messages
     * @private
     */
    _createToolGroupElement(toolMessages) {
        const groupId = `tool-group-${toolMessages[0].id}`;

        const groupDiv = document.createElement('div');
        groupDiv.className = 'tool-group';
        groupDiv.id = groupId;

        // Add collapse-all button at the START
        const collapseAllBtn = `
            <button class="tool-group-collapse-btn" data-act="toggle-tool-group" data-id="${escapeAttr(groupId)}" data-tooltip="Collapse/expand all tools">
                <svg class="collapse-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                    <path d="M7 13l5 5 5-5M7 6l5 5 5-5"/>
                </svg>
                <svg class="expand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                    <path d="M13 17l5-5-5-5M6 17l5-5-5-5"/>
                </svg>
            </button>
        `;
        groupDiv.insertAdjacentHTML('afterbegin', collapseAllBtn);

        // Create each tool message
        for (const msg of toolMessages) {
            const div = document.createElement('div');
            div.className = 'message tool';
            div.id = `msg-${msg.id}`;
            div.innerHTML = this.ctx.toolRenderer.renderToolBlock(msg);
            this.ctx.toolRenderer.processWriteCharts(div);
            this.ctx.toolRenderer.processWriteExcalidraw(div);
            this.ctx.toolRenderer.processReadExcalidraw(div);
            groupDiv.appendChild(div);
        }

        return groupDiv;
    }

    /**
     * Render a tool message with real-time grouping
     * During streaming, this checks if we should add to an existing group or create a new one
     * Also nests sub-agent tools inside their parent Task block
     * @private
     */
    _renderToolMessageWithGrouping(msg) {
        const messages = this._getActiveMessageContainer();

        // Check if this tool has a parent Task (from server's parent_task_id)
        // This is the authoritative mechanism for sub-agent tool nesting
        // Query by data-tool-use-id attribute (stores Claude's tool_use_id)
        // Note: Only nest if parentTaskId is provided - no fallback heuristics
        // (fallback to "any running Task" would incorrectly nest unrelated tools)
        if (msg.parentTaskId && msg.toolName !== 'Task') {
            const parentTaskBlock = messages.querySelector(`.task-block[data-tool-use-id="${msg.parentTaskId}"]`);
            if (parentTaskBlock) {
                this._nestToolInTaskBlock(parentTaskBlock, msg);
                return;
            }
        }

        // Create the tool message element
        const div = document.createElement('div');
        div.className = 'message tool';
        div.id = `msg-${msg.id}`;
        div.dataset.turnId = msg.turnId;
        div.innerHTML = this.ctx.toolRenderer.renderToolBlock(msg);
        this.ctx.toolRenderer.processWriteCharts(div);
        this.ctx.toolRenderer.processWriteExcalidraw(div);
        this.ctx.toolRenderer.processReadExcalidraw(div);

        // Check the last element in messages container
        const lastChild = messages.lastElementChild;

        // Only group tools from the same turn (never across turn boundaries)
        if (lastChild?.classList.contains('tool-group') &&
            lastChild.dataset.turnId == msg.turnId) {
            // Last element is already a tool group from same turn - add to it
            lastChild.appendChild(div);
            // Check gutter space for the group
            requestAnimationFrame(() => this.checkToolGroupGutterSpace(lastChild));
        } else if (lastChild?.classList.contains('message') && lastChild.classList.contains('tool') &&
                   lastChild.dataset.turnId == msg.turnId) {
            // Last element is a single tool message from same turn - wrap both in a group
            const groupId = `tool-group-${lastChild.id.replace('msg-', '')}`;
            const groupDiv = document.createElement('div');
            groupDiv.className = 'tool-group';
            groupDiv.id = groupId;
            groupDiv.dataset.turnId = msg.turnId;

            // Add collapse-all button
            const collapseAllBtn = `
                <button class="tool-group-collapse-btn" data-act="toggle-tool-group" data-id="${escapeAttr(groupId)}" data-tooltip="Collapse/expand all tools">
                    <svg class="collapse-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <path d="M7 13l5 5 5-5M7 6l5 5 5-5"/>
                    </svg>
                    <svg class="expand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <path d="M13 17l5-5-5-5M6 17l5-5-5-5"/>
                    </svg>
                </button>
            `;
            groupDiv.insertAdjacentHTML('afterbegin', collapseAllBtn);

            // Remove single tool's has-gutter-space (now handled by group)
            lastChild.classList.remove('has-gutter-space');

            // Move existing tool to group
            messages.removeChild(lastChild);
            groupDiv.appendChild(lastChild);
            groupDiv.appendChild(div);
            messages.appendChild(groupDiv);

            // Check gutter space for the new group
            requestAnimationFrame(() => this.checkToolGroupGutterSpace(groupDiv));
        } else {
            // Not following a tool - render as single tool message
            messages.appendChild(div);
            // Check gutter space for single tool
            requestAnimationFrame(() => this.checkSingleToolGutterSpace(div));
        }
    }

    /**
     * Nest a sub-agent tool inside a running Task block
     * @private
     */
    _nestToolInTaskBlock(taskBlock, msg) {
        // Get or create children container inside the task block body
        let childrenContainer = taskBlock.querySelector('.task-block-children');
        if (!childrenContainer) {
            // Create children container inside the body
            let body = taskBlock.querySelector('.task-block-body');
            if (!body) {
                // Create body if it doesn't exist
                body = document.createElement('div');
                body.className = 'task-block-body';
                taskBlock.appendChild(body);
            }
            childrenContainer = document.createElement('div');
            childrenContainer.className = 'task-block-children';
            body.appendChild(childrenContainer);

            // Auto-expand the task block when children are added
            taskBlock.classList.add('expanded');
        }

        // Render the tool and add to children (agent context for collapse mode)
        const toolHtml = this.ctx.toolRenderer.renderToolBlock(msg, { isAgent: true });
        const wrapper = document.createElement('div');
        wrapper.className = 'task-block-child';
        wrapper.id = `msg-${msg.id}`;
        wrapper.setAttribute('data-tool-id', msg.toolId || msg.id);
        wrapper.innerHTML = toolHtml;
        this.ctx.toolRenderer.processWriteCharts(wrapper);
        this.ctx.toolRenderer.processWriteExcalidraw(wrapper);
        this.ctx.toolRenderer.processReadExcalidraw(wrapper);
        childrenContainer.appendChild(wrapper);

        // Update child count badge in header
        this._updateTaskBlockChildCount(taskBlock);
    }

    /**
     * Update the child count badge on a Task block
     * @private
     */
    _updateTaskBlockChildCount(taskBlock) {
        const children = taskBlock.querySelectorAll('.task-block-children .task-block-child');
        const count = children.length;

        // Find or create count badge
        const header = taskBlock.querySelector('.task-block-header');
        if (!header) return;

        let countBadge = header.querySelector('.task-block-count');
        if (count > 0) {
            if (!countBadge) {
                // Create badge before the status badge
                countBadge = document.createElement('span');
                countBadge.className = 'task-block-count';
                const statusBadge = header.querySelector('.task-block-badge');
                if (statusBadge) {
                    statusBadge.before(countBadge);
                } else {
                    header.appendChild(countBadge);
                }
            }
            countBadge.textContent = `${count} tool${count !== 1 ? 's' : ''}`;
        } else if (countBadge) {
            countBadge.remove();
        }
    }

    /**
     * Check gutter space for a single tool group
     */
    checkToolGroupGutterSpace(group) {
        // Use the scrolling container for measurement
        const container = document.getElementById('messages-container');
        if (!container) return;

        // Get the first message element in the group
        const firstMessage = group.querySelector('.message.tool');
        if (!firstMessage) return;

        const messageRect = firstMessage.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        // Right space: distance from message edge to container edge
        // Subtract ~20px for scrollbar buffer
        const rightSpace = containerRect.right - messageRect.right - 20;

        if (rightSpace >= 40) {
            group.classList.add('has-gutter-space');
        } else {
            group.classList.remove('has-gutter-space');
        }
    }

    /**
     * Check gutter space for a single standalone tool message
     */
    checkSingleToolGutterSpace(messageEl) {
        // Skip if this tool is in a group (groups have their own space check)
        if (messageEl.closest('.tool-group')) return;

        const container = document.getElementById('messages-container');
        if (!container) return;

        const messageRect = messageEl.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        // Right space: distance from message edge to container edge
        const rightSpace = containerRect.right - messageRect.right - 20;

        if (rightSpace >= 40) {
            messageEl.classList.add('has-gutter-space');
        } else {
            messageEl.classList.remove('has-gutter-space');
        }
    }

    /**
     * Check gutter space for all visible tool groups and single tool messages
     * Called on window resize and after rendering
     */
    checkAllToolGroupGutterSpace() {
        // Check tool groups
        document.querySelectorAll('.tool-group').forEach(group => {
            this.checkToolGroupGutterSpace(group);
        });

        // Check single tool messages (not in groups)
        document.querySelectorAll('.message.tool:not(.tool-group .message.tool)').forEach(msg => {
            this.checkSingleToolGutterSpace(msg);
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // SCROLL MANAGEMENT
    // ═══════════════════════════════════════════════════════════════

    /**
     * Retarget scroll-aware components (ScrollManager, ChatNavigator) to the
     * active per-session scroll container. Called after container pool activation
     * so all paths (O(1) switch, first render, welcome→session) stay in sync.
     * @param {Object} [options]
     * @param {boolean} [options.skipInitState] - Pass to ScrollManager.setContainer()
     *   to skip recalculating scroll state (used by O(1) switch path)
     * @private
     */
    _retargetScrollComponents(options = {}) {
        const scrollEl = this.ctx.app?.getActiveScrollContainer();
        if (!scrollEl) return;
        this.ctx.app.scrollManager?.setContainer(scrollEl, options);
        this.ctx.app.chatNavigator?.setScrollContainer(scrollEl);
    }

    /**
     * Restore scroll position for the active session
     */
    restoreScrollPosition() {
        const session = this.ctx.session;
        if (!session) return;

        // Use the active per-session scroll container (not the shared outer container)
        const container = this.ctx.app?.getActiveScrollContainer() || this.ctx.els.messagesContainer;
        if (!container) return;

        // Force layout calculation to ensure DOM is ready
        void container.offsetHeight;

        if (session.scrollPosition !== null && session.scrollPosition !== undefined) {
            // Explicit saved offset — an LRU-evicted container being rebuilt, or
            // a position captured just before an invalidate-triggered re-render.
            // ONE-SHOT: consume it after applying. Leaving it set replayed stale
            // offsets (worst case 0 = top) on every later re-render, which is
            // what pinned "return to tab" at the top of the transcript.
            container.scrollTop = session.scrollPosition;
            session.scrollPosition = null;
        } else if (session.isUserScrolledUp && container.scrollTop > 0) {
            // User was reading scrolled up and the browser preserved the offset
            // on the cached container — leave their place alone.
        } else {
            // Default: bottom (scrollPosition === null means "was at bottom",
            // and a rebuilt container that lost its offset lands here too).
            container.scrollTop = container.scrollHeight;
        }
        void container.scrollTop;

        // Re-sync the scrolled-up flag AFTER positioning: _retargetScrollComponents()
        // ran initState() while a rebuilt container was still at scrollTop 0, which
        // left isUserScrolledUp stuck true and made every soft scrollToBottom()
        // refuse to move afterwards. Use the setter (not initState) — it leaves the
        // state machine alone while a tab switch is in flight.
        const scrollManager = this.ctx.app?.scrollManager;
        if (scrollManager && scrollManager.container === container) {
            scrollManager.isUserScrolledUp = !scrollManager.isNearBottom();
        }
    }

    scrollToBottom() {
        this.ctx.scrollManager?.scrollToBottom();
    }

    /**
     * Update a message's favorite state in the DOM
     * Called when server confirms promptId or when favorite is toggled
     * @param {string} msgId - Client message ID
     * @param {string} promptId - Server prompt ID (sessionId:lineNumber)
     * @param {boolean} isFavorite - Whether the prompt is favorited
     */
    updateMessageFavoriteState(msgId, promptId, isFavorite) {
        const msgDiv = document.getElementById(`msg-${msgId}`);
        if (!msgDiv) return;

        const btn = msgDiv.querySelector('.message-favorite-btn');
        if (!btn) return;

        // Update button state
        btn.dataset.promptId = promptId;
        btn.classList.remove('hidden');
        btn.classList.toggle('active', isFavorite);
        btn.setAttribute('data-tooltip', isFavorite ? 'Remove from favorites' : 'Add to favorites');
    }

    /**
     * Re-render the content of a user message (e.g., after verifiedFiles arrives from server)
     * @param {Object} msg - Message object with updated fields
     */
    updateMessageContent(msg) {
        const msgDiv = document.getElementById(`msg-${msg.id}`);
        if (!msgDiv) return;
        const bubble = msgDiv.querySelector('.message-content');
        if (!bubble) return;
        bubble.innerHTML = this._renderMessageContent(msg);
    }

    /**
     * Scroll to a specific message, loading older messages if necessary
     * Used by Prompt Explorer to jump to a specific prompt
     * @param {string} targetTimestamp - ISO timestamp of the target message
     * @param {string} targetPromptId - Optional promptId for user messages (sessionId:lineNumber)
     * @returns {Promise<boolean>} True if message was found and scrolled to
     */
    async scrollToMessage(targetTimestamp, targetPromptId = null) {
        const session = this.ctx.session;
        if (!session) return false;

        // Helper to find the target message
        const findTarget = () => {
            // Try by promptId first (more reliable for user messages)
            if (targetPromptId) {
                const byPromptId = session.messages.find(m => m.promptId === targetPromptId);
                if (byPromptId) return byPromptId;
            }
            // Fall back to timestamp
            if (targetTimestamp) {
                return session.messages.find(m => m.timestamp === targetTimestamp);
            }
            return null;
        };

        // Check if message is already loaded
        let targetMsg = findTarget();

        // Load older messages until found or exhausted
        let loadAttempts = 0;
        const maxAttempts = 20; // Prevent infinite loops (20 * 50 = 1000 messages max)

        while (!targetMsg && session.hasMoreMessages && loadAttempts < maxAttempts) {
            loadAttempts++;
            const countBefore = session.messages.length;
            const result = await session.loadOlderMessages(50);

            if (result.loaded === 0 || result.error) {
                break;
            }

            // Prepend newly loaded messages to DOM
            const newMessages = session.messages.slice(0, result.loaded);
            this.prependMessages(newMessages);

            // Check again
            targetMsg = findTarget();
        }

        if (!targetMsg) {
            console.warn('[ChatController] Message not found after loading', { targetTimestamp, targetPromptId });
            return false;
        }

        // Find the DOM element and scroll to it
        const el = document.getElementById(`msg-${targetMsg.id}`);
        if (!el) {
            console.warn('[ChatController] Message element not found in DOM:', targetMsg.id);
            return false;
        }

        // Scroll into view with highlight effect
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // Add highlight animation
        el.classList.add('scroll-highlight');
        setTimeout(() => el.classList.remove('scroll-highlight'), 2000);

        return true;
    }

    // ═══════════════════════════════════════════════════════════════
    // HISTORY LOADING
    // ═══════════════════════════════════════════════════════════════

    /**
     * Handle scroll-to-top to load more messages
     */
    async handleScrollTop() {
        const session = this.ctx.session;
        if (!session || !session.hasMoreMessages || session.isLoadingMore) {
            return;
        }

        // Don't load more if there are no messages - nothing to load more of
        // This prevents triggering on welcome screen or empty sessions
        if (!session.messages || session.messages.length === 0) {
            return;
        }

        // Don't trigger load-more while initially loading from server
        if (session.isLoadingFromServer) {
            return;
        }

        // Don't trigger during session switching (check app flag)
        const app = window.app;
        if (app?._switchingSession) {
            return;
        }

        // Debounce: don't load if messages were just loaded (within 1000ms)
        // Longer debounce for mobile Safari which has slower rendering
        const timeSinceLoad = Date.now() - (session._lastLoadTime || 0);
        if (timeSinceLoad < 1000) {
            return;
        }

        this.showLoadMoreIndicator(true);

        try {
            const result = await session.loadOlderMessages(50);
            if (result.loaded > 0) {
                const newMessages = session.messages.slice(0, result.loaded);
                this.prependMessages(newMessages);
            }
            this.updateHistoryNotice();
        } catch (error) {
            console.error('Failed to load older messages:', error);
            this.ctx.addSystemLog(`Failed to load older messages: ${error.message}`, 'error');
        } finally {
            this.showLoadMoreIndicator(false);
        }
    }

    /**
     * Update or remove the "more history" notice at the top
     */
    updateHistoryNotice() {
        const session = this.ctx.session;
        const messagesContainer = this._getActiveMessageContainer();
        const existingNotice = messagesContainer.querySelector('.message-history-notice');

        if (!session?.hasMoreMessages) {
            if (existingNotice) {
                existingNotice.remove();
            }
            return;
        }

        const loadedCount = session.messages.length;
        const totalCount = session.totalMessageCount;
        const remaining = totalCount - loadedCount;

        if (existingNotice) {
            existingNotice.querySelector('span').textContent =
                `${remaining.toLocaleString()} older messages • scroll up to load`;
        }
    }

    /**
     * Show/hide loading indicator when loading more messages
     */
    showLoadMoreIndicator(show) {
        const messagesContainer = this._getActiveMessageContainer();
        let indicator = messagesContainer.querySelector('#load-more-indicator');

        if (show) {
            if (!indicator) {
                indicator = document.createElement('div');
                indicator.id = 'load-more-indicator';
                indicator.className = 'loading-indicator';
                indicator.innerHTML = `
                    <svg class="spinner" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="40 60"/>
                    </svg>
                    <span>Loading older messages...</span>
                `;

                const historyNotice = messagesContainer.querySelector('.message-history-notice');
                if (historyNotice) {
                    historyNotice.insertAdjacentElement('afterend', indicator);
                } else {
                    messagesContainer.insertAdjacentElement('afterbegin', indicator);
                }
            }
        } else if (indicator) {
            indicator.classList.add('fade-out');
            setTimeout(() => indicator.remove(), 300);
        }
    }

    /**
     * Prepend older messages to the top while preserving scroll position
     */
    prependMessages(messages) {
        if (!messages || messages.length === 0) return;

        // Use the per-session scroll container (which IS the message container)
        const container = this.ctx.app?.getActiveScrollContainer() || this.ctx.els.messagesContainer;
        const messagesDiv = this._getActiveMessageContainer();

        // Save current scroll state
        const prevScrollHeight = container.scrollHeight;
        const prevScrollTop = container.scrollTop;

        // Create a document fragment for efficient prepending
        const fragment = document.createDocumentFragment();

        // Group consecutive thinking and tool messages
        let i = 0;
        while (i < messages.length) {
            const msg = messages[i];

            if (msg.role === 'thinking') {
                const thinkingGroup = [msg];
                let j = i + 1;
                while (j < messages.length && messages[j].role === 'thinking') {
                    thinkingGroup.push(messages[j]);
                    j++;
                }

                if (thinkingGroup.length >= 2) {
                    const groupDiv = this.thinkingCtrl.createThinkingGroupElement(thinkingGroup);
                    fragment.appendChild(groupDiv);
                } else {
                    const div = this.createMessageElement(msg);
                    if (div) fragment.appendChild(div);
                }
                i = j;
            } else if (msg.role === 'tool') {
                // Group consecutive tool messages
                const toolGroup = [msg];
                let j = i + 1;
                while (j < messages.length && messages[j].role === 'tool') {
                    toolGroup.push(messages[j]);
                    j++;
                }

                if (toolGroup.length >= 2) {
                    const groupDiv = this._createToolGroupElement(toolGroup);
                    fragment.appendChild(groupDiv);
                } else {
                    const div = this.createMessageElement(msg);
                    if (div) fragment.appendChild(div);
                }
                i = j;
            } else if (msg.role === 'system' || msg.role === 'result') {
                i++;
            } else {
                const div = this.createMessageElement(msg);
                if (div) fragment.appendChild(div);
                i++;
            }
        }

        // Prepend to the messages container
        const historyNotice = messagesDiv.querySelector('.message-history-notice');
        const loadIndicator = messagesDiv.querySelector('#load-more-indicator');
        let insertBefore = historyNotice?.nextSibling || loadIndicator?.nextSibling || messagesDiv.firstChild;

        if (insertBefore) {
            messagesDiv.insertBefore(fragment, insertBefore);
        } else {
            messagesDiv.appendChild(fragment);
        }

        // Restore scroll position so view doesn't jump
        requestAnimationFrame(() => {
            const newScrollHeight = container.scrollHeight;
            const scrollDiff = newScrollHeight - prevScrollHeight;
            container.scrollTop = prevScrollTop + scrollDiff;

            // Enable gutter icons for prepended tool groups/messages
            this.checkAllToolGroupGutterSpace();
            this.ctx.app?.thinkingCtrl?.checkAllGutterSpace();
        });
    }

    /**
     * Trim old messages from DOM to improve scroll performance.
     * Keeps only the last N messages, but always includes the last complete turn
     * (user prompt + all AI responses that followed).
     * Old messages can be reloaded via lazy loading.
     * @param {number} keepCount - Number of recent messages to keep (default 100)
     * @returns {number} Number of messages trimmed
     */
    trimOldMessages(keepCount = 100) {
        const session = this.ctx.session;
        if (!session || !session.messages) {
            return 0;
        }

        const totalMessages = session.messages.length;
        if (totalMessages <= keepCount) {
            return 0;
        }

        const trimCount = totalMessages - keepCount;

        // Get IDs of messages to remove
        const messagesToRemove = session.messages.slice(0, trimCount);
        const idsToRemove = new Set(messagesToRemove.map(m => m.id));

        // Remove DOM elements
        const messagesDiv = this._getActiveMessageContainer();
        const allMsgElements = messagesDiv.querySelectorAll('[id^="msg-"], .thinking-group, .tool-group');

        for (const el of allMsgElements) {
            // Check if this element or any of its children should be removed
            if (el.id?.startsWith('msg-')) {
                const msgId = el.id.replace('msg-', '');
                if (idsToRemove.has(msgId)) {
                    el.remove();
                }
            } else if (el.classList.contains('thinking-group') || el.classList.contains('tool-group')) {
                // For groups, check if ALL messages in group should be removed
                const groupMsgIds = Array.from(el.querySelectorAll('[id^="msg-"]'))
                    .map(child => child.id.replace('msg-', ''));
                if (groupMsgIds.length > 0 && groupMsgIds.every(id => idsToRemove.has(id))) {
                    el.remove();
                }
            }
        }

        // Remove from session.messages array
        session.messages.splice(0, trimCount);

        // Mark that there are more messages available for lazy loading
        session.hasMoreMessages = true;

        // Update the history notice to show there's more
        this.updateHistoryNotice();

        return trimCount;
    }

    /**
     * Get count of messages that would be trimmed
     * Uses same logic as trimOldMessages to ensure complete turns are preserved
     * @param {number} keepCount - Number to keep (default 100)
     * @returns {number} Count that would be trimmed
     */
    getTrimCount(keepCount = 100) {
        const session = this.ctx.session;
        if (!session || !session.messages) return 0;

        const totalMessages = session.messages.length;
        if (totalMessages <= keepCount) return 0;

        return totalMessages - keepCount;
    }

    /**
     * Create a message DOM element without appending it
     */
    createMessageElement(msg) {
        if (msg.role === 'system' || msg.role === 'result') return null;

        if (msg.role === 'thinking') {
            const div = document.createElement('div');
            div.className = 'message thinking';
            div.id = `msg-${msg.id}`;
            div.innerHTML = this.thinkingCtrl.renderThinkingBlock(msg);
            return div;
        }

        // Handle info messages (e.g., compaction summary, /context results)
        if (msg.role === 'info') {
            const div = document.createElement('div');
            div.id = `msg-${msg.id}`;

            // Check if this is /context output - render as collapsible block
            if (msg.source === 'local-command-stdout' && this._isContextOutput(msg.content)) {
                div.className = 'message context';
                div.innerHTML = this._renderContextBlock(msg.content, msg.timestamp);
            } else {
                div.className = 'message info';
                // Use markdown rendering for command output (has tables), plain text for simple info
                const contentHtml = msg.source === 'local-command-stdout'
                    ? `<div class="markdown-content">${this.ctx.markdown.render(msg.content)}</div>`
                    : escapeHtml(msg.content);
                div.innerHTML = `
                    <div class="message-header">
                        <span class="message-role info">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="10"/>
                                <line x1="12" y1="16" x2="12" y2="12"/>
                                <line x1="12" y1="8" x2="12.01" y2="8"/>
                            </svg>
                            info
                        </span>
                        <span class="message-time">${formatTime(msg.timestamp)}</span>
                    </div>
                    <div class="message-content">${contentHtml}</div>
                `;
            }
            return div;
        }

        // Handle auth-error affordance — Claude CLI returned 401 / expired token.
        if (msg.role === 'auth_error') {
            return this._renderAuthError(msg);
        }

        // Handle AskUserQuestion - interactive question form
        if (msg.role === 'question') {
            return this._renderQuestionForm(msg);
        }

        // Handle ExitPlanMode - interactive plan approval
        if (msg.role === 'plan_approval') {
            return this._renderPlanApproval(msg);
        }

        // Handle interactive permission ask (claude-sdk can_use_tool)
        if (msg.role === 'permission') {
            return this._renderPermissionCard(msg);
        }

        const div = document.createElement('div');
        const planModeClass = msg.planMode ? ' plan-mode' : '';
        div.className = `message ${msg.role}${planModeClass}`;
        div.id = `msg-${msg.id}`;

        if (msg.role === 'tool') {
            div.innerHTML = this.ctx.toolRenderer.renderToolBlock(msg);
        } else {
            const content = this._renderMessageContent(msg);

            const copyButton = (msg.role === 'assistant' || msg.role === 'user') ? `
                <button class="message-copy-btn" data-msg-id="${msg.id}" data-id="${escapeAttr(msg.id)}" data-act="copy-message" data-tooltip="Copy message">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                    <span class="copy-label">Copy</span>
                </button>
            ` : '';

            // Favorite button for user messages
            const favoriteButton = (msg.role === 'user') ? `
                <button class="message-favorite-btn${msg.isFavorite ? ' active' : ''}${msg.promptId ? '' : ' hidden'}"
                        data-msg-id="${msg.id}"
                        data-prompt-id="${msg.promptId || ''}"
                        data-act="toggle-message-favorite"
                        data-tooltip="${msg.isFavorite ? 'Remove from favorites' : 'Add to favorites'}">
                    <svg class="heart-outline" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                    </svg>
                    <svg class="heart-filled" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                    </svg>
                </button>
            ` : '';

            // Thinking indicator for user messages
            const effortIndicator = msg.role === 'user' ? this._renderEffortIndicator(msg.effort_level) : '';

            div.innerHTML = `
                <div class="message-header">
                    <span class="message-role ${msg.role}">${this._authorLabel(msg)}</span>
                    ${effortIndicator}
                    <span class="message-time">${formatTime(msg.timestamp)}</span>
                    ${favoriteButton}
                    ${copyButton}
                </div>
                <div class="message-content">${content}</div>
            `;
        }

        // Render excalidraw code blocks as SVG diagrams
        MarkdownRenderer.processExcalidrawBlocks(div);
        // Render Vega-Lite chart code blocks as SVG charts
        MarkdownRenderer.processChartBlocks(div);

        return div;
    }

    // ═══════════════════════════════════════════════════════════════
    // WELCOME SCREEN
    // ═══════════════════════════════════════════════════════════════

    /**
     * Render recent projects/sessions in the welcome screen
     * Uses a short cache (5s) to prevent flickering from redundant API calls
     */
    async renderRecentProjects(container) {
        if (!container) return;

        const CACHE_TTL = 5000; // 5 seconds
        const now = Date.now();

        // Use cached data if fresh (prevents flicker on rapid re-renders)
        if (this._recentSessionsCache && (now - this._recentSessionsCacheTime) < CACHE_TTL) {
            this._renderSessionsList(container, this._recentSessionsCache);
            return;
        }

        container.innerHTML = '<div class="loading-sessions">Loading sessions...</div>';

        try {
            const response = await fetch(`${CONFIG.API_BASE}/api/sessions`);

            // Check if container is still in DOM (might have been removed by re-render)
            if (!container.isConnected) {
                return;
            }

            const data = await response.json();
            const sessions = data.sessions || [];

            // Update cache
            this._recentSessionsCache = sessions;
            this._recentSessionsCacheTime = now;

            // Double-check container is still connected before updating
            if (container.isConnected) {
                this._renderSessionsList(container, sessions);
            }
        } catch (error) {
            console.error('Failed to load sessions:', error);
            if (container.isConnected) {
                this._renderHistoryFallback(container);
            }
        }
    }

    /**
     * Render the sessions list (used by cache hit and fresh fetch)
     * @private
     */
    _renderSessionsList(container, sessions) {
        if (sessions.length > 0) {
            const recentSessions = sessions.slice(0, 5);
            container.innerHTML = `
                <h4>Continue</h4>
                <div class="session-list">
                    ${recentSessions.map(s => {
                        const name = s.name || basename(s.cwd) || 'Session';
                        const msgCount = s.message_count || 0;
                        const timeAgo = formatRelativeTime(s.last_activity);
                        const cost = s.total_cost > 0 ? `$${s.total_cost.toFixed(3)}` : '';
                        return `
                            <div class="session-item" data-session-id="${escapeHtml(s.id)}" data-path="${escapeHtml(s.cwd || '')}">
                                <div class="session-item-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                                    </svg>
                                    ${msgCount > 0 ? `<span class="msg-badge">${msgCount}</span>` : ''}
                                </div>
                                <div class="session-item-info">
                                    <div class="session-item-name">${escapeHtml(name)}</div>
                                    <div class="session-item-meta">
                                        <span>${timeAgo}</span>
                                        ${cost ? `<span class="session-cost">${cost}</span>` : ''}
                                    </div>
                                </div>
                                <svg class="session-item-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M9 18l6-6-6-6"/>
                                </svg>
                            </div>
                        `;
                    }).join('')}
                </div>
            `;

            // Add click handlers for sessions
            container.querySelectorAll('.session-item').forEach(item => {
                item.addEventListener('click', () => {
                    const sessionId = item.dataset.sessionId;
                    const cwd = item.dataset.path;
                    this.ctx.emit('sessionItemClicked', { sessionId, cwd });
                });
            });

        } else {
            // No sessions - check for history
            this._renderHistoryFallback(container);
        }
    }

    /**
     * Fallback to localStorage history if no server sessions
     */
    _renderHistoryFallback(container) {
        const history = window.app?.getCwdHistory?.() || [];

        if (history.length > 0) {
            const projects = history.slice(0, 5);
            container.innerHTML = `
                <h4>Recent Projects</h4>
                <div class="project-list">
                    ${projects.map(path => {
                        const name = basename(path);
                        return `
                            <div class="project-item" data-path="${escapeHtml(path)}">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                                </svg>
                                <div>
                                    <div class="project-name">${escapeHtml(name)}</div>
                                    <div class="project-path">${escapeHtml(path)}</div>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            `;

            container.querySelectorAll('.project-item').forEach(item => {
                item.addEventListener('click', () => {
                    const path = item.dataset.path;
                    this.ctx.emit('projectItemClicked', { path });
                });
            });
        } else {
            container.innerHTML = '';
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // New Welcome Screen API
    // ─────────────────────────────────────────────────────────────────

    /**
     * Check if the welcome view is currently the active top-level view.
     */
    isWelcomeShowing() {
        return this.ctx.app?.tabCtrl?.activeMode === 'welcome';
    }

    /**
     * Handle a task message from welcome screen.
     * Searches for related sessions and shows options to continue or start fresh.
     * @param {string} task - Task/message to send
     */
    async welcomeTask(task) {
        const c = this._activeWelcomeContainer();
        if (c) await handleWelcomeTask(task, c);
    }

    /**
     * Check if welcome is in task mode (showing related sessions)
     */
    isWelcomeInTaskMode() {
        return this.isWelcomeShowing() && isTaskMode();
    }

    /**
     * Reset welcome screen to default state
     */
    welcomeReset() {
        const c = this._activeWelcomeContainer();
        if (c) resetWelcomeScreen(c);
    }

    /**
     * Refresh welcome screen sessions
     */
    async welcomeRefresh() {
        const c = this._activeWelcomeContainer();
        if (c) await refreshSessions(c);
    }

    /**
     * Show the floating "Back to sessions" pill at bottom-left
     * @param {Object} session - The current session
     */
    _showBackToSessionsPill(session) {
        // Remove any existing pill first
        this._hideBackToSessionsPill();

        const pill = document.createElement('div');
        pill.className = 'back-to-sessions-pill';
        pill.id = 'back-to-sessions-pill';
        pill.innerHTML = `
            <button class="back-pill-btn" data-tooltip="Return to session list (Backspace)">
                <span class="back-pill-key">⌫</span>
                <span>Back to sessions</span>
            </button>
            <button class="back-pill-dismiss" data-tooltip="Dismiss (Esc)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
            </button>
        `;

        // Back button click handler
        pill.querySelector('.back-pill-btn').addEventListener('click', () => {
            this._handleBackToSessions();
        });

        // Dismiss button click handler
        pill.querySelector('.back-pill-dismiss').addEventListener('click', () => {
            session.openedFromWelcome = false;
            clearSavedWelcomeState();
            this._hideBackToSessionsPill();
        });

        // Setup swipe-right gesture for touch devices (iPad)
        this._setupSwipeGesture(pill);

        // Append to body (fixed positioning, so location doesn't matter)
        document.body.appendChild(pill);

        // Fade in animation
        requestAnimationFrame(() => {
            pill.classList.add('visible');
        });

        // Auto-hide after 8 seconds (soft fade to not annoy user)
        // Clear any existing timeout first
        if (this._backPillTimeout) {
            clearTimeout(this._backPillTimeout);
        }
        this._backPillTimeout = setTimeout(() => {
            this._dismissBackToSessionsPill();
        }, 8000);
    }

    /**
     * Hide the "Back to sessions" pill
     */
    _hideBackToSessionsPill() {
        // Clear auto-hide timeout
        if (this._backPillTimeout) {
            clearTimeout(this._backPillTimeout);
            this._backPillTimeout = null;
        }
        const pill = document.getElementById('back-to-sessions-pill');
        if (pill) {
            pill.classList.remove('visible');
            setTimeout(() => pill.remove(), 150);
        }
    }

    /**
     * Check if back-to-sessions is available (for Escape key handler)
     * @returns {boolean}
     */
    canGoBackToSessions() {
        const session = this.ctx.session;
        return session?.openedFromWelcome && !!getSavedWelcomeState();
    }

    /**
     * Dismiss the pill without navigating (called by Escape key)
     * Clears the flag and state so pill won't reappear
     */
    _dismissBackToSessionsPill() {
        const session = this.ctx.session;
        if (session) {
            session.openedFromWelcome = false;
            clearSavedWelcomeState();
        }
        this._hideBackToSessionsPill();
    }

    /**
     * Setup swipe-right gesture on pill for touch devices
     * Swipe right from left edge triggers back-to-sessions
     * @param {HTMLElement} pill - The pill element
     */
    _setupSwipeGesture(pill) {
        let touchStartX = 0;
        let touchStartY = 0;
        const SWIPE_THRESHOLD = 80;
        const VERTICAL_TOLERANCE = 50;

        // Also setup edge swipe on the messages container
        const messagesEl = this.ctx.els.messages;
        if (!messagesEl) return;

        const handleTouchStart = (e) => {
            const touch = e.touches[0];
            // Only track touches starting from left edge (within 30px)
            if (touch.clientX <= 30) {
                touchStartX = touch.clientX;
                touchStartY = touch.clientY;
            } else {
                touchStartX = 0;
            }
        };

        const handleTouchEnd = (e) => {
            if (touchStartX === 0) return;

            const touch = e.changedTouches[0];
            const deltaX = touch.clientX - touchStartX;
            const deltaY = Math.abs(touch.clientY - touchStartY);

            // Check if it's a rightward swipe from left edge
            if (deltaX > SWIPE_THRESHOLD && deltaY < VERTICAL_TOLERANCE) {
                this._handleBackToSessions();
            }

            touchStartX = 0;
        };

        messagesEl.addEventListener('touchstart', handleTouchStart, { passive: true });
        messagesEl.addEventListener('touchend', handleTouchEnd, { passive: true });

        // Store cleanup function
        this._swipeCleanup = () => {
            messagesEl.removeEventListener('touchstart', handleTouchStart);
            messagesEl.removeEventListener('touchend', handleTouchEnd);
        };
    }

    /**
     * Handle "Back to sessions" - close current session and return to welcome
     * Restores the previous welcome screen state (search, scroll, etc.)
     */
    _handleBackToSessions() {
        const session = this.ctx.session;
        if (!session) return;

        // Hide the pill first
        this._hideBackToSessionsPill();

        // Cleanup swipe gesture listeners
        if (this._swipeCleanup) {
            this._swipeCleanup();
            this._swipeCleanup = null;
        }

        // Clear the flag
        session.openedFromWelcome = false;

        // Get the app reference
        const app = this.ctx.app;
        if (!app) return;

        // Remove this session from the tab list
        app.sessionManager.remove(session);

        // Create a new session (shows welcome screen)
        app.createSession();

        // Restore the welcome state after render (welcome lives in #welcome-view now)
        requestAnimationFrame(() => {
            const welcomeContainer = app.els.welcomeView?.querySelector('#welcome-container');
            if (welcomeContainer) {
                restoreWelcomeState(welcomeContainer);
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // UTILITIES
    // ═══════════════════════════════════════════════════════════════

    clearMessages() {
        if (this.ctx.session) {
            this.ctx.session.clearServer();
            this.ctx.session.clear();
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // EXITPLANMODE APPROVAL RENDERING
    // ═══════════════════════════════════════════════════════════════

    /**
     * Render an interactive plan approval card for ExitPlanMode tool
     * @param {Object} msg - Plan approval message with answered/decision state
     * @returns {HTMLElement} The approval card element
     */
    /**
     * Auth-error affordance — the engine CLI returned 401 / expired token.
     * Renders the reason plus a one-click button into the engine's own login
     * PTY (`claude auth login` / `codex login --device-auth`, carried on the
     * message as `loginCommand`; label from `engine`). Shared by renderMessage
     * (live) and createMessageElement (re-render/lazy-load) so the button
     * survives session switches and page reloads.
     */
    _renderAuthError(msg) {
        const engine = msg.engine || 'Claude';
        const div = document.createElement('div');
        div.className = 'message error auth-error';
        div.id = `msg-${msg.id}`;
        div.innerHTML = `
            <div class="message-header">
                <span class="message-role error">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                    </svg>
                    ${escapeHtml(S.auth.error_role)}
                </span>
                <span class="message-time">${formatTime(msg.timestamp)}</span>
            </div>
            <div class="message-content">
                <div class="auth-error-reason">${escapeHtml(msg.content)}</div>
                <button class="auth-error-login-btn" data-act="open-login-terminal">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
                        <polyline points="10 17 15 12 10 7"/>
                        <line x1="15" y1="12" x2="3" y2="12"/>
                    </svg>
                    ${escapeHtml(S.auth.login_button.replace('{engine}', engine))}
                </button>
            </div>
        `;
        // Dataset assignment (not string interpolation) so the command needs
        // no attribute escaping.
        const btn = div.querySelector('.auth-error-login-btn');
        if (btn && msg.loginCommand) btn.dataset.command = msg.loginCommand;
        return div;
    }

    _renderPlanApproval(msg) {
        const div = document.createElement('div');
        div.className = `message plan-approval${msg.answered ? ' answered' : ''}`;
        div.id = `msg-${msg.id}`;

        const isAnswered = msg.answered;
        const decision = msg.decision;

        // Preview Plan button (disabled if no plan file found)
        const hasPlanFile = !!msg.planFile;
        const previewBtn = `
            <button class="plan-preview-btn" data-act="preview-plan"${hasPlanFile ? '' : ' disabled'}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="16" y1="13" x2="8" y2="13"/>
                    <line x1="16" y1="17" x2="8" y2="17"/>
                </svg>
                Preview Plan
            </button>`;

        let statusHtml;
        if (isAnswered && decision === 'approve') {
            statusHtml = `
                <div class="plan-approval-status approved">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                        <polyline points="22 4 12 14.01 9 11.01"/>
                    </svg>
                    Approved — proceeding with implementation
                </div>
                <div class="plan-approval-actions">
                    ${previewBtn}
                </div>`;
        } else if (isAnswered && decision === 'revise') {
            // Final revise — user sent a message without clicking Approve (no undo)
            statusHtml = `
                <div class="plan-approval-status rejected">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M1 4v6h6M23 20v-6h-6"/>
                        <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
                    </svg>
                    Revised
                </div>
                <div class="plan-approval-actions">
                    ${previewBtn}
                </div>`;
        } else if (decision === 'revise') {
            // Soft revise — show status but keep Approve button (user can change mind)
            statusHtml = `
                <div class="plan-approval-status rejected">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M1 4v6h6M23 20v-6h-6"/>
                        <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
                    </svg>
                    Revising — provide feedback below
                </div>
                <div class="plan-approval-actions">
                    <button class="plan-approve-btn" data-act="approve-plan" data-id="${escapeAttr(msg.id)}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="20 6 9 17 4 12"/>
                        </svg>
                        Approve & Proceed
                    </button>
                    ${previewBtn}
                </div>`;
        } else {
            statusHtml = `
                <div class="plan-approval-actions">
                    <button class="plan-approve-btn" data-act="approve-plan" data-id="${escapeAttr(msg.id)}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="20 6 9 17 4 12"/>
                        </svg>
                        Approve & Proceed
                    </button>
                    <button class="plan-reject-btn" data-act="reject-plan" data-id="${escapeAttr(msg.id)}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M1 4v6h6M23 20v-6h-6"/>
                            <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
                        </svg>
                        Revise Plan
                    </button>
                    ${previewBtn}
                </div>`;
        }

        div.innerHTML = `
            <div class="message-header">
                <span class="message-role plan-approval">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M9 11l3 3L22 4"/>
                        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                    </svg>
                    Plan ready for review
                </span>
                <span class="message-time">${formatTime(msg.timestamp)}</span>
            </div>
            <div class="plan-approval-body">
                <p class="plan-approval-desc">Claude has finished the plan. Review it above and choose how to proceed.</p>
                ${statusHtml}
            </div>
        `;

        return div;
    }

    /**
     * Render an interactive permission card (claude-sdk can_use_tool ask).
     * The provider process is paused until the user answers — Allow/Deny plus
     * an optional deny-guidance input.
     * @param {Object} msg - {requestId, toolName, toolInput, description, answered, decision}
     */
    _renderPermissionCard(msg) {
        const div = document.createElement('div');
        div.className = `message permission-card${msg.answered ? ' answered' : ''}`;
        div.id = `msg-${msg.id}`;

        const PC = S.permission_card;
        const toolName = escapeHtml(msg.toolName || 'tool');

        // Tool-input preview: rendered per-tool in human-friendly form
        // (Write → file + content preview, Edit → diff, Bash → command,
        //  everything else → key/value table) rather than a raw JSON dump.
        const inputHtml = this._renderPermissionInput(msg.toolName, msg.toolInput || {});

        const descHtml = msg.description
            ? `<p class="permission-desc">${escapeHtml(msg.description)}</p>` : '';

        // Elapsed-wait timer (unanswered cards only). Asks pause the process
        // indefinitely — there's no countdown, this just shows how long the
        // ask has been waiting. A 1s ticker updates it in place.
        const startMs = Date.parse(msg.timestamp) || Date.now();
        const elapsed0 = this._formatDuration(Math.max(0, Date.now() - startMs)) || '0s';

        let statusHtml;
        if (msg.answered) {
            const statusMap = {
                allow: { cls: 'allowed', label: PC.status_allowed, icon: '<polyline points="20 6 9 17 4 12"/>' },
                allow_always: { cls: 'allowed', label: PC.status_allowed_always, icon: '<polyline points="20 6 9 17 4 12"/>' },
                deny: { cls: 'denied', label: PC.status_denied, icon: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' },
                expired: { cls: 'expired', label: PC.status_expired, icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>' },
            };
            const st = statusMap[msg.decision] || statusMap.expired;
            // How long the ask waited before resolving/expiring (frozen).
            const waitedHtml = (typeof msg.waitedMs === 'number')
                ? `<span class="permission-status-elapsed">${escapeHtml(PC.waited.replace('{elapsed}', this._formatDuration(msg.waitedMs) || '0s'))}</span>`
                : '';
            // Deny guidance the user typed, echoed on the resolved card so the
            // decision reads complete at a glance: Denied · waited 2s · "…".
            const feedbackHtml = (msg.decision === 'deny' && msg.feedback)
                ? `<span class="permission-status-feedback" data-tooltip="${escapeHtml(msg.feedback)}">${escapeHtml(PC.deny_feedback_quote.replace('{feedback}', msg.feedback))}</span>`
                : '';
            statusHtml = `
                <div class="permission-status ${st.cls}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${st.icon}</svg>
                    ${st.label}
                    ${waitedHtml}
                    ${feedbackHtml}
                </div>`;
        } else {
            // "Always allow" rows — one per engine rule-suggestion on the ask.
            // Answering with a row allows the call AND has the engine persist
            // that rule (addRules / addDirectories / setMode), like the CLI's
            // "yes, don't ask again" options.
            const sugRows = (Array.isArray(msg.suggestions) ? msg.suggestions : [])
                .map((s, i) => {
                    const label = this._permissionSuggestionLabel(s);
                    if (!label) return '';
                    return `<button class="permission-suggestion-btn" data-act="respond-permission" data-id="${escapeAttr(msg.id)}" data-decision="allow" data-i="${i}">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="20 6 9 17 4 12"/><line x1="12" y1="18" x2="20" y2="18"/>
                        </svg>
                        <span>${label}</span>
                    </button>`;
                }).join('');
            statusHtml = `
                <input type="text" class="permission-feedback" id="perm-feedback-${msg.id}"
                       placeholder="${escapeHtml(PC.feedback_placeholder)}">
                <div class="permission-actions">
                    <button class="permission-allow-btn" data-act="respond-permission" data-id="${escapeAttr(msg.id)}" data-decision="allow">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="20 6 9 17 4 12"/>
                        </svg>
                        ${PC.allow}
                    </button>
                    <button class="permission-deny-btn" data-act="respond-permission" data-id="${escapeAttr(msg.id)}" data-decision="deny">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                        ${PC.deny}
                    </button>
                    <span class="permission-waiting">
                        <span class="permission-elapsed" data-start="${startMs}">${escapeHtml(elapsed0)}</span>
                        ${PC.waiting}
                    </span>
                </div>
                ${sugRows ? `<div class="permission-suggestions">${sugRows}</div>` : ''}`;
        }

        div.innerHTML = `
            <div class="message-header">
                <span class="message-role permission">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                    </svg>
                    ${PC.title}
                </span>
                <span class="message-time">${formatTime(msg.timestamp)}</span>
            </div>
            <div class="permission-body">
                <p class="permission-tool">${PC.wants_to_use.replace('{tool}', `<strong>${toolName}</strong>`)}</p>
                ${descHtml}
                ${inputHtml}
                ${statusHtml}
            </div>
        `;

        if (!msg.answered) this._startPermissionTicker();
        return div;
    }

    /**
     * Run a 1s ticker that updates the elapsed-wait timer on every unanswered
     * permission card. Self-stops once no `.permission-elapsed` elements remain
     * (all cards answered/expired drop the timer on re-render). Idempotent.
     */
    _startPermissionTicker() {
        if (this._permTicker) return;
        this._permTicker = setInterval(() => {
            const els = document.querySelectorAll('.permission-elapsed[data-start]');
            if (!els.length) {
                clearInterval(this._permTicker);
                this._permTicker = null;
                return;
            }
            const now = Date.now();
            els.forEach(el => {
                const start = parseInt(el.dataset.start, 10);
                if (start) el.textContent = this._formatDuration(Math.max(0, now - start)) || '0s';
            });
        }, 1000);
    }

    /**
     * Human-friendly preview of a tool call's input for the permission card.
     * Mirrors the transcript's tool rendering instead of dumping raw JSON:
     *   Bash/Shell  → `$ command`
     *   Write       → file header + truncated content preview
     *   Edit/MultiEdit → file header + old→new diff
     *   Read/Grep/Glob/other → the tool-renderer one-liner or key/value table
     * @param {string} toolName
     * @param {Object} input
     * @returns {string} HTML
     */
    _renderPermissionInput(toolName, input) {
        input = input || {};
        const PC = S.permission_card;
        const tr = this.ctx.toolRenderer;

        // Bash / Shell — command headline
        if ((toolName === 'Bash' || toolName === 'Shell') && typeof input.command === 'string') {
            return `<pre class="permission-input"><code>$ ${escapeHtml(input.command)}</code></pre>`;
        }

        // Write — file header + content preview
        if (toolName === 'Write' && input.file_path) {
            const filename = basename(input.file_path) || input.file_path;
            const content = typeof input.content === 'string' ? input.content : '';
            const nLines = content ? content.split('\n').length : 0;
            const tag = nLines
                ? `<span class="permission-file-tag">${escapeHtml(PC.lines_count.replace('{n}', nLines))}</span>`
                : '';
            const preview = this._truncateForPreview(content, 40, 2000);
            const previewHtml = content
                ? `<pre class="permission-input permission-file-preview"><code>${escapeHtml(preview)}</code></pre>`
                : '';
            return `<div class="permission-file-head">${tr.fileLink(input.file_path, filename, 'permission-file-name')}${tag}</div>${previewHtml}`;
        }

        // Edit / MultiEdit — file header + old→new diff
        if ((toolName === 'Edit' || toolName === 'MultiEdit') && input.file_path) {
            const filename = basename(input.file_path) || input.file_path;
            const edits = (toolName === 'MultiEdit' && Array.isArray(input.edits))
                ? input.edits
                : [{ old_string: input.old_string, new_string: input.new_string }];
            const tag = edits.length > 1
                ? `<span class="permission-file-tag">${escapeHtml(PC.edits_count.replace('{n}', edits.length))}</span>`
                : '';
            const diffHtml = edits
                .map(e => this._renderPermissionDiff(e.old_string, e.new_string))
                .join('');
            return `<div class="permission-file-head">${tr.fileLink(input.file_path, filename, 'permission-file-name')}${tag}</div>`
                + `<div class="permission-input permission-diff">${diffHtml}</div>`;
        }

        // Read / Grep / Glob and everything else — one-liner or key/value table
        const body = tr.formatToolInput(toolName, input);
        return body ? `<div class="permission-input">${body}</div>` : '';
    }

    /**
     * Truncate text to at most maxLines lines and maxChars characters,
     * appending an ellipsis line when clipped. Used for Write previews.
     */
    _truncateForPreview(text, maxLines, maxChars) {
        if (!text) return '';
        let out = text;
        let clipped = false;
        const lines = out.split('\n');
        if (lines.length > maxLines) { out = lines.slice(0, maxLines).join('\n'); clipped = true; }
        if (out.length > maxChars) { out = out.slice(0, maxChars); clipped = true; }
        return clipped ? out + '\n…' : out;
    }

    /**
     * Render one Edit hunk as a removed/added diff. Lines are capped so a huge
     * replacement doesn't blow out the card; the container scrolls.
     */
    _renderPermissionDiff(oldStr, newStr) {
        const CAP = 30;
        const rows = [];
        const push = (arr, cls) => {
            arr.slice(0, CAP).forEach(l => {
                rows.push(`<div class="permission-diff-line ${cls}">${escapeHtml(l) || '&nbsp;'}</div>`);
            });
            if (arr.length > CAP) rows.push(`<div class="permission-diff-line ${cls}">…</div>`);
        };
        if (typeof oldStr === 'string' && oldStr.length) push(oldStr.split('\n'), 'removed');
        if (typeof newStr === 'string' && newStr.length) push(newStr.split('\n'), 'added');
        return `<div class="permission-diff-hunk">${rows.join('')}</div>`;
    }

    /**
     * Human label for one engine permission-rule suggestion. Unknown types
     * return null and are not rendered (we never offer what we can't explain).
     */
    _permissionSuggestionLabel(s) {
        const PC = S.permission_card;
        const scopeMap = {
            session: PC.scope_session,
            localSettings: PC.scope_local_settings,
            projectSettings: PC.scope_project_settings,
            userSettings: PC.scope_user_settings,
        };
        const scope = escapeHtml(scopeMap[s.destination] || '');
        if (s.type === 'addRules' && Array.isArray(s.rules) && s.rules.length) {
            const detail = s.rules
                .map(r => r.rule_content ? `${r.tool_name}(${r.rule_content})` : r.tool_name)
                .join(', ');
            return PC.suggestion_add_rules
                .replace('{detail}', `<code>${escapeHtml(detail)}</code>`)
                .replace('{scope}', scope);
        }
        if (s.type === 'addDirectories' && Array.isArray(s.directories) && s.directories.length) {
            return PC.suggestion_add_directories
                .replace('{detail}', `<code>${escapeHtml(s.directories.join(', '))}</code>`)
                .replace('{scope}', scope);
        }
        if (s.type === 'setMode' && s.mode) {
            return PC.suggestion_set_mode
                .replace('{detail}', `<strong>${escapeHtml(String(s.mode))}</strong>`)
                .replace('{scope}', scope);
        }
        return null;
    }

    // ═══════════════════════════════════════════════════════════════
    // ASKUSERQUESTION FORM RENDERING
    // ═══════════════════════════════════════════════════════════════

    /**
     * Render an interactive question form for AskUserQuestion tool
     * Supports both single questions and grouped wizard-style multiple questions
     * @param {Object} msg - Question message with questions array or entries array
     * @returns {HTMLElement} The form container element
     */
    _renderQuestionForm(msg) {
        // `_editing` is a transient flag set when the user re-opens an already
        // answered card to change and resend their answer — treat it as unanswered
        // for rendering (enabled inputs + submit, active styling) while keeping
        // msg.answered true underneath.
        const isEditing = msg.answered && msg._editing;
        const isAnswered = msg.answered && !msg._editing;

        const div = document.createElement('div');
        div.className = `message question${isAnswered ? ' answered' : ''}${isEditing ? ' editing' : ''}`;
        div.id = `msg-${msg.id}`;

        // Check if this is a grouped question (wizard mode) or single question
        const entries = msg.entries || [{
            toolId: msg.toolId,
            questions: msg.questions || [],
            answers: msg.answers || {}
        }];

        const isWizard = entries.length > 1;
        const activeTab = msg.activeTab || 0;

        // Build wizard tabs (only if multiple entries)
        let tabsHtml = '';
        if (isWizard) {
            tabsHtml = `
                <div class="question-wizard-tabs">
                    ${entries.map((entry, idx) => {
                        const hasAnswer = Object.keys(entry.answers || {}).length > 0;
                        return `
                            <button class="wizard-tab ${idx === activeTab ? 'active' : ''} ${hasAnswer ? 'answered' : ''}"
                                    data-tab="${idx}">
                                <span class="wizard-tab-num">${idx + 1}</span>
                                ${hasAnswer ? '<svg class="wizard-tab-check" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                            </button>
                        `;
                    }).join('')}
                </div>
            `;
        }

        // Build content for each entry (only show active tab content)
        let entriesHtml = entries.map((entry, entryIdx) => {
            // Defensive: some turns (and sessions persisted before the parse
            // fix) stored `questions` as a JSON string instead of an array,
            // which rendered an empty "Claude is asking" card. Recover here.
            let questions = entry.questions;
            if (!Array.isArray(questions)) {
                if (typeof questions === 'string' && questions.trim()) {
                    try { const p = JSON.parse(questions); questions = Array.isArray(p) ? p : []; }
                    catch { questions = []; }
                } else {
                    questions = [];
                }
            }
            const answers = entry.answers || {};
            const isActive = entryIdx === activeTab;

            let questionsHtml = questions.map((q, qIdx) => {
                const header = q.header || `Q${qIdx + 1}`;
                const options = q.options || [];
                const isMulti = q.multiSelect === true;
                const selectedValue = answers[header] || '';

                return `
                    <div class="question-item" data-header="${escapeHtml(header)}" data-multi="${isMulti}" data-entry="${entryIdx}">
                        <div class="question-header">
                            <span class="question-badge">${escapeHtml(header)}</span>
                        </div>
                        <div class="question-text">${escapeHtml(q.question)}</div>
                        <div class="question-options">
                            ${options.map(opt => {
                                const isSelected = isMulti
                                    ? (selectedValue || '').includes(opt.label)
                                    : selectedValue === opt.label;
                                return `
                                    <button class="question-option${isSelected ? ' selected' : ''}"
                                            data-value="${escapeHtml(opt.label)}"
                                            ${isAnswered ? 'disabled' : ''}>
                                        <span class="option-label">${escapeHtml(opt.label)}</span>
                                        ${opt.description ? `<span class="option-desc">${escapeHtml(opt.description)}</span>` : ''}
                                    </button>
                                `;
                            }).join('')}
                            <button class="question-option question-option-other${selectedValue && !options.some(o => o.label === selectedValue) ? ' selected' : ''}"
                                    data-value="__other__"
                                    ${isAnswered ? 'disabled' : ''}>
                                <span class="option-label">Other...</span>
                                <span class="option-desc">Provide custom answer</span>
                            </button>
                        </div>
                        <input type="text" class="question-other-input" placeholder="Type your answer..."
                               style="display: ${selectedValue && !options.some(o => o.label === selectedValue) && !isMulti ? 'block' : 'none'}"
                               value="${escapeHtml(selectedValue && !options.some(o => o.label === selectedValue) ? selectedValue : '')}"
                               ${isAnswered ? 'disabled' : ''}>
                    </div>
                `;
            }).join('');

            return `
                <div class="question-entry ${isActive ? 'active' : ''}" data-entry-idx="${entryIdx}" data-tool-id="${entry.toolId}">
                    ${questionsHtml}
                </div>
            `;
        }).join('');

        // Navigation buttons for wizard
        let navHtml = '';
        if (isWizard && !isAnswered) {
            const canGoBack = activeTab > 0;
            const canGoNext = activeTab < entries.length - 1;
            const isLast = activeTab === entries.length - 1;

            navHtml = `
                <div class="question-wizard-nav">
                    <button class="wizard-nav-btn prev" ${canGoBack ? '' : 'disabled'} data-action="prev">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M15 18l-6-6 6-6"/>
                        </svg>
                        Previous
                    </button>
                    <span class="wizard-progress">${activeTab + 1} of ${entries.length}</span>
                    ${isLast ? '' : `
                        <button class="wizard-nav-btn next" data-action="next">
                            Next
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M9 18l6-6-6-6"/>
                            </svg>
                        </button>
                    `}
                </div>
            `;
        }

        // Status and submit button
        let statusHtml;
        if (isAnswered) {
            if (msg.ignored) {
                statusHtml = `<div class="question-status ignored">
                       <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                           <circle cx="12" cy="12" r="10"/>
                           <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
                       </svg>
                       ${S.question_form.status_ignored}
                   </div>`;
            } else if (msg.skipped) {
                statusHtml = `<div class="question-status skipped">
                       <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                           <polygon points="5 4 15 12 5 20 5 4"/>
                           <line x1="19" y1="5" x2="19" y2="19"/>
                       </svg>
                       ${S.question_form.status_skipped}
                   </div>`;
            } else {
                statusHtml = `<button class="question-edit" data-act="edit-question-answer" data-id="${escapeAttr(msg.id)}" data-tooltip="${S.question_form.edit_hint}">
                       <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                           <path d="M12 20h9"/>
                           <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
                       </svg>
                       ${S.question_form.edit_answer}
                   </button>
                   <div class="question-status answered">
                       <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                           <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                           <polyline points="22 4 12 14.01 9 11.01"/>
                       </svg>
                       ${S.question_form.status_answered}
                   </div>`;
            }
        } else {
            // When editing an already-answered card the left button cancels the
            // edit (restores the answered view) instead of ignoring the question.
            const leftBtn = isEditing
                ? `<button class="question-ignore" data-act="cancel-edit-question" data-id="${escapeAttr(msg.id)}" data-tooltip="${S.question_form.cancel_edit_hint}">
                       <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                           <line x1="18" y1="6" x2="6" y2="18"/>
                           <line x1="6" y1="6" x2="18" y2="18"/>
                       </svg>
                       ${S.question_form.cancel_edit}
                   </button>`
                : `<button class="question-ignore" data-act="ignore-question" data-id="${escapeAttr(msg.id)}" data-tooltip="${S.question_form.ignore_hint}">
                       <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                           <circle cx="12" cy="12" r="10"/>
                           <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
                       </svg>
                       Ignore
                   </button>`;
            statusHtml = `${leftBtn}
               <button class="question-submit" data-act="submit-question-answers" data-id="${escapeAttr(msg.id)}">
                   <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                       <line x1="22" y1="2" x2="11" y2="13"/>
                       <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                   </svg>
                   ${isEditing ? S.question_form.resend_answers : `Submit ${isWizard ? 'All ' : ''}Answers`}
               </button>`;
        }

        // Free-text comment box (shared across the whole card, independent of
        // which options are picked). Editable while unanswered/editing; shown
        // read-only afterwards only if the user actually left a comment.
        const commentValue = msg.comment || '';
        let commentHtml = '';
        if (!isAnswered) {
            commentHtml = `
                <div class="question-comment-wrap">
                    <label class="question-comment-label" for="qc-${msg.id}">${S.question_form.comment_label}</label>
                    <textarea id="qc-${msg.id}" class="question-comment" rows="2"
                              placeholder="${escapeHtml(S.question_form.comment_placeholder)}">${escapeHtml(commentValue)}</textarea>
                </div>
            `;
        } else if (commentValue) {
            commentHtml = `
                <div class="question-comment-wrap">
                    <label class="question-comment-label">${S.question_form.comment_label}</label>
                    <textarea class="question-comment" rows="2" disabled>${escapeHtml(commentValue)}</textarea>
                </div>
            `;
        }

        // Footer note + inline toggle reflecting the global "stop on questions"
        // setting. Filled and revealed by _setupQuestionStopNote once the
        // current setting is known: on → Claude pauses for you here; off →
        // Claude answered on its own, with a one-click affordance to enable.
        const stopNoteHtml = `
                <div class="question-stop-note" style="display:none">
                    <svg class="question-stop-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="16" x2="12" y2="12"/>
                        <line x1="12" y1="8" x2="12.01" y2="8"/>
                    </svg>
                    <span class="question-stop-text"></span>
                    <label class="question-stop-toggle" data-tooltip="${S.question_form.stop_toggle_hint}">
                        <input type="checkbox" class="question-stop-checkbox">
                        <span>${S.question_form.stop_toggle_label}</span>
                    </label>
                </div>
            `;

        div.innerHTML = `
            <div class="message-header">
                <span class="message-role question">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
                        <line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                    Claude is asking${isWizard ? ` (${entries.length} questions)` : ''}
                </span>
                <span class="message-time">${formatTime(msg.timestamp)}</span>
            </div>
            ${tabsHtml}
            <div class="question-form ${isWizard ? 'wizard-mode' : ''}" data-msg-id="${msg.id}">
                ${entriesHtml}
                ${navHtml}
                ${commentHtml}
                <div class="question-actions">
                    ${statusHtml}
                </div>
            </div>
            ${stopNoteHtml}
        `;

        // Attach event listeners for option selection and wizard navigation
        if (!isAnswered) {
            this._attachQuestionFormListeners(div, msg);
        }
        this._setupQuestionStopNote(div);

        return div;
    }

    /**
     * Fill and wire the question card's footer note/toggle from the global
     * "stop on questions" setting. On → Claude pauses for you on questions
     * like this; off → Claude answered on its own, and the toggle offers a
     * one-click way to be asked instead. The inline checkbox flips the setting
     * live (shared with the System-tab control).
     * @param {HTMLElement} container - The rendered question card
     */
    _setupQuestionStopNote(container) {
        const note = container.querySelector('.question-stop-note');
        const cb = container.querySelector('.question-stop-checkbox');
        const text = container.querySelector('.question-stop-text');
        if (!note || !cb || !text) return;

        const apply = (on) => {
            note.style.display = '';
            cb.checked = on;
            text.textContent = on
                ? S.question_form.stop_on_text
                : S.question_form.auto_deny_text;
            note.dataset.mode = on ? 'on' : 'off';
        };

        // Reflect the current global setting (one GET per question card).
        fetch('/api/app/sigint-on-ask')
            .then(r => r.ok ? r.json() : null)
            .then(d => { if (d) apply(!!d.sigint_on_ask); })
            .catch(() => {});

        cb.addEventListener('change', async () => {
            const value = cb.checked;
            try {
                const resp = await fetch('/api/app/sigint-on-ask', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sigint_on_ask: value }),
                });
                if (resp.ok) {
                    const data = await resp.json();
                    apply(!!data.sigint_on_ask);
                    showToast(data.sigint_on_ask
                        ? S.question_form.stop_toggle_on
                        : S.question_form.stop_toggle_off);
                } else {
                    cb.checked = !value;
                }
            } catch (e) {
                console.error('Failed to toggle sigint_on_ask:', e);
                cb.checked = !value;
            }
        });
    }

    /**
     * Attach event listeners to question form options and wizard navigation
     * @param {HTMLElement} container - The form container
     * @param {Object} msg - The question message
     */
    _attachQuestionFormListeners(container, msg) {
        const form = container.querySelector('.question-form');
        if (!form) return;

        const entries = msg.entries || [{
            toolId: msg.toolId,
            questions: msg.questions || [],
            answers: msg.answers || {}
        }];
        const isWizard = entries.length > 1;
        const totalQuestions = entries.reduce(
            (n, e) => n + (Array.isArray(e.questions) ? e.questions.length : 0), 0
        );

        // Option selection
        form.querySelectorAll('.question-option').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const questionItem = btn.closest('.question-item');
                const isMulti = questionItem.dataset.multi === 'true';
                const value = btn.dataset.value;
                const isOther = value === '__other__';
                const entryIdx = parseInt(questionItem.dataset.entry || '0', 10);
                const header = questionItem.dataset.header;

                if (isMulti) {
                    // Toggle selection for multiSelect
                    btn.classList.toggle('selected');
                } else {
                    // Single select - deselect others
                    questionItem.querySelectorAll('.question-option').forEach(b => {
                        b.classList.remove('selected');
                    });
                    btn.classList.add('selected');
                }

                // Show/hide "Other" input
                const otherInput = questionItem.querySelector('.question-other-input');
                if (otherInput) {
                    if (isOther && btn.classList.contains('selected')) {
                        otherInput.style.display = 'block';
                        otherInput.focus();
                    } else if (!isMulti) {
                        otherInput.style.display = 'none';
                    }
                }

                // Update answer in msg.entries for persistence
                if (entries[entryIdx]) {
                    if (!entries[entryIdx].answers) entries[entryIdx].answers = {};
                    const selectedBtns = questionItem.querySelectorAll('.question-option.selected');
                    if (isMulti) {
                        entries[entryIdx].answers[header] = Array.from(selectedBtns)
                            .map(b => b.dataset.value)
                            .filter(v => v !== '__other__')
                            .join(', ');
                    } else if (!isOther) {
                        entries[entryIdx].answers[header] = value;
                    }

                    // Update wizard tab indicator if answered
                    if (isWizard) {
                        this._updateWizardTabState(container, msg);
                    }
                }
            });
        });

        // "Other" input changes — persist the typed value as the answer.
        form.querySelectorAll('.question-other-input').forEach(input => {
            const questionItem = input.closest('.question-item');
            const entryIdx = parseInt(questionItem?.dataset.entry || '0', 10);
            const header = questionItem?.dataset.header;

            input.addEventListener('input', () => {
                if (entries[entryIdx] && header) {
                    if (!entries[entryIdx].answers) entries[entryIdx].answers = {};
                    entries[entryIdx].answers[header] = input.value;
                }
            });
        });

        // Free-text comment box — persist typed value onto the message so it
        // survives re-render (wizard tab switches, edit re-open). Swallow keydown
        // so the form's question-navigation handler doesn't hijack Enter/Tab
        // while the user is typing a multi-line comment.
        const commentEl = form.querySelector('.question-comment');
        if (commentEl && !commentEl.disabled) {
            commentEl.addEventListener('input', () => { msg.comment = commentEl.value; });
            commentEl.addEventListener('keydown', (e) => { e.stopPropagation(); });
        }

        // Keyboard navigation: Enter / Tab move forward through the questions,
        // Shift+Tab moves back, and the final forward step lands on the Submit
        // button so sending is always a deliberate second keystroke (never a
        // stray Enter on the first question). Arrow keys pick between options
        // within a question. See _handleQuestionFormKey for the full model.
        form.addEventListener('keydown', (e) => {
            this._handleQuestionFormKey(e, { container, form, msg, entries, isWizard, totalQuestions });
        });

        // Wizard tab clicks
        container.querySelectorAll('.wizard-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const tabIdx = parseInt(tab.dataset.tab, 10);
                this._switchWizardTab(container, msg, tabIdx);
            });
        });

        // Wizard navigation buttons
        container.querySelectorAll('.wizard-nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                const newTab = action === 'prev' ? msg.activeTab - 1 : msg.activeTab + 1;
                this._switchWizardTab(container, msg, newTab);
            });
        });
    }

    /**
     * Keyboard model for the question form.
     *
     * Each question is a single "stop". Enter and plain Tab advance to the next
     * stop; Shift+Tab goes back. Landing on a question focuses its custom-answer
     * input (if visible) otherwise its selected/first option. Moving forward off
     * the last question focuses the Submit button — in a wizard it first walks to
     * the next tab's questions — so submitting is always one extra, deliberate
     * keystroke. Up/Down (and Left/Right) move focus between the options of the
     * question the focus is currently in; Space selects the focused option.
     * Enter on an option selects it and then advances (jumps to the next
     * question). On the Submit button Enter still submits natively.
     *
     * "Other..." is the exception: focus landing on it (arrow key or Tab stop)
     * selects it and jumps into the revealed custom-answer input so typing can
     * start immediately — see _focusQuestionOption. Up gets back out of that
     * input onto the option list.
     * @param {KeyboardEvent} e
     * @param {Object} refs - { container, form, msg, entries, isWizard, totalQuestions }
     */
    _handleQuestionFormKey(e, { container, form, msg, entries, isWizard, totalQuestions }) {
        const target = e.target;
        const submit = form.querySelector('.question-submit');
        const isOption = target.classList?.contains('question-option');
        const inTextInput = target.classList?.contains('question-other-input');

        // Arrow keys move between the options of the focused question.
        if (isOption && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            const opts = Array.from(target.closest('.question-item').querySelectorAll('.question-option'));
            const cur = opts.indexOf(target);
            const fwd = e.key === 'ArrowDown' || e.key === 'ArrowRight';
            const next = opts[cur + (fwd ? 1 : -1)];
            if (next) { e.preventDefault(); this._focusQuestionOption(next); return; }
            // Down off "Other..." drops back into its revealed input, which sits
            // below the option list — the mirror of the Up escape below.
            if (fwd && target.dataset.value === '__other__') {
                const input = target.closest('.question-item').querySelector('.question-other-input');
                if (input && input.offsetParent !== null) { e.preventDefault(); input.focus(); }
            }
            return;
        }

        // Up out of the custom-answer input goes back to its option list (the
        // input sits directly below "Other...", so Up lands on that button).
        // Left/Right stay with the caret. Without this the revealed input is a
        // dead end for arrow-key users.
        if (inTextInput && e.key === 'ArrowUp') {
            const opts = Array.from(target.closest('.question-item').querySelectorAll('.question-option'));
            const other = opts[opts.length - 1];
            if (other) { e.preventDefault(); other.focus(); }
            return;
        }

        if (e.key !== 'Enter' && e.key !== 'Tab') return;

        // The active entry's questions are the navigable stops.
        const activeEntry = form.querySelector('.question-entry.active') || form;
        const stops = Array.from(activeEntry.querySelectorAll('.question-item'));

        // The control we focus when landing on a question.
        const stopTarget = (qi) => {
            const other = qi.querySelector('.question-other-input');
            if (other && other.offsetParent !== null) return other;
            return qi.querySelector('.question-option.selected')
                || qi.querySelector('.question-option');
        };
        const focusStop = (el) => {
            if (!el) return;
            if (el.classList?.contains('question-option')) { this._focusQuestionOption(el); return; }
            el.focus();
            if (el.tagName === 'INPUT' && typeof el.select === 'function') el.select();
            el.scrollIntoView({ block: 'nearest' });
        };

        // Move focus to the next question, else the next wizard tab's first
        // question, else the Submit button (so the final step prompts to submit).
        const currentItem = target.closest?.('.question-item');
        const goForward = () => {
            const idx = currentItem ? stops.indexOf(currentItem) : -1;
            if (idx > -1 && idx < stops.length - 1) {
                focusStop(stopTarget(stops[idx + 1]));
            } else if (isWizard && msg.activeTab < entries.length - 1) {
                this._switchWizardTab(container, msg, msg.activeTab + 1);
                const next = Array.from(form.querySelectorAll('.question-entry.active .question-item'));
                focusStop(stopTarget(next[0]));
            } else {
                focusStop(submit);
            }
        };

        // On the Submit button: let Enter/Space submit natively; Shift+Tab steps
        // back to the last question; there's nothing past Submit for plain Tab.
        if (target === submit) {
            if (e.key === 'Tab' && e.shiftKey && stops.length) {
                e.preventDefault();
                focusStop(stopTarget(stops[stops.length - 1]));
            }
            return;
        }

        // Enter on an option selects it, then advances — except "Other", which
        // reveals its text input, so we stay put to let the user type.
        if (e.key === 'Enter' && isOption) {
            e.preventDefault();
            target.click();
            if (target.dataset.value !== '__other__') goForward();
            return;
        }

        // Single-question card: Enter in the sole text input submits directly.
        if (e.key === 'Enter' && inTextInput && totalQuestions <= 1) {
            e.preventDefault();
            submit?.click();
            return;
        }

        if (!currentItem) return;  // focus on a tab / nav button — leave it to the browser
        const idx = stops.indexOf(currentItem);
        const back = e.key === 'Tab' && e.shiftKey;
        e.preventDefault();

        if (back) {
            if (idx > 0) {
                focusStop(stopTarget(stops[idx - 1]));
            } else if (isWizard && msg.activeTab > 0) {
                this._switchWizardTab(container, msg, msg.activeTab - 1);
                const prev = Array.from(form.querySelectorAll('.question-entry.active .question-item'));
                focusStop(stopTarget(prev[prev.length - 1]));
            }
            return;
        }

        // Forward (plain Tab, or Enter from a text input): jump to next question.
        goForward();
    }

    /**
     * Move keyboard focus onto an option button.
     *
     * Landing on "Other..." also selects it and drops focus straight into its
     * custom-answer input, so a keyboard user can just start typing instead of
     * having to reach for the mouse. Selecting is not optional: submit reads
     * `.question-other-input` only for an option carrying `.selected`, so
     * revealing the input without selecting would silently discard whatever
     * was typed. Already-selected is left alone — re-clicking would toggle a
     * multiSelect "Other" back off.
     * @param {HTMLElement} btn - a `.question-option`
     */
    _focusQuestionOption(btn) {
        if (!btn) return;
        const input = btn.dataset.value === '__other__' && !btn.disabled
            ? btn.closest('.question-item')?.querySelector('.question-other-input')
            : null;

        if (input) {
            if (btn.classList.contains('selected')) {
                input.style.display = 'block';   // click handler does this on the other branch
                input.focus();
            } else {
                btn.click();                     // selects, reveals and focuses the input
            }
            if (typeof input.select === 'function') input.select();
            input.scrollIntoView({ block: 'nearest' });
            return;
        }

        btn.focus();
        btn.scrollIntoView({ block: 'nearest' });
    }

    /**
     * Switch wizard tab
     */
    _switchWizardTab(container, msg, newTab) {
        const entries = msg.entries || [];
        if (newTab < 0 || newTab >= entries.length) return;

        msg.activeTab = newTab;

        // Update tab buttons
        container.querySelectorAll('.wizard-tab').forEach((tab, idx) => {
            tab.classList.toggle('active', idx === newTab);
        });

        // Update entry visibility
        container.querySelectorAll('.question-entry').forEach((entry, idx) => {
            entry.classList.toggle('active', idx === newTab);
        });

        // Update navigation
        const prevBtn = container.querySelector('.wizard-nav-btn.prev');
        const nextBtn = container.querySelector('.wizard-nav-btn.next');
        const progress = container.querySelector('.wizard-progress');

        if (prevBtn) prevBtn.disabled = newTab === 0;
        if (nextBtn) nextBtn.style.display = newTab === entries.length - 1 ? 'none' : '';
        if (progress) progress.textContent = `${newTab + 1} of ${entries.length}`;
    }

    /**
     * Update wizard tab state (checkmarks for answered tabs)
     */
    _updateWizardTabState(container, msg) {
        const entries = msg.entries || [];
        container.querySelectorAll('.wizard-tab').forEach((tab, idx) => {
            const entry = entries[idx];
            const hasAnswer = entry && Object.keys(entry.answers || {}).length > 0;
            tab.classList.toggle('answered', hasAnswer);

            // Add/update checkmark
            let check = tab.querySelector('.wizard-tab-check');
            if (hasAnswer && !check) {
                check = document.createElement('span');
                check.className = 'wizard-tab-check';
                check.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
                tab.appendChild(check);
            } else if (!hasAnswer && check) {
                check.remove();
            }
        });
    }

    /**
     * Update a question message after it's been answered
     * @param {Object} msg - The updated question message
     */
    updateQuestionMessage(msg) {
        const existing = document.getElementById(`msg-${msg.id}`);
        if (existing) {
            const newElement = this._renderQuestionForm(msg);
            existing.replaceWith(newElement);
        }
    }
}
