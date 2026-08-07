/**
 * Message-action mixin — clipboard copy (copyCode / copyToolOutput / copyMessage),
 * toggleMessageFavorite, the AskUserQuestion answer flow (submitQuestionAnswers /
 * ignoreQuestion / updateQuestionMessage), and plan approve/reject/preview.
 * Extracted from app.js; applied to App.prototype via Object.assign. Uses `this`
 * (App instance) plus the imports below.
 */
import { $ } from '../utils.js';
import { FilePreviewWidget } from '../widget-system/init.js';

export const messageActionMethods = {
    copyCode(codeId) {
        const codeEl = $(`#${codeId}`);
        if (codeEl) {
            navigator.clipboard.writeText(codeEl.textContent);
            const btn = $(`[data-code-id="${codeId}"]`);
            if (btn) {
                btn.classList.add('copied');
                btn.innerHTML = `
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M20 6L9 17l-5-5"/>
                    </svg>
                    Copied!
                `;
                setTimeout(() => {
                    btn.classList.remove('copied');
                    btn.innerHTML = `
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                        </svg>
                        Copy
                    `;
                }, 2000);
            }
        }
    },

    copyToolOutput(msgId) {
        const msg = this.activeSession?.messages.find(m => m.id === msgId);
        if (msg && (msg.toolOutput || msg.toolError)) {
            navigator.clipboard.writeText(msg.toolOutput || msg.toolError);
        }
    },

    copyMessage(msgId) {
        const msg = this.activeSession?.messages.find(m => m.id === msgId);
        if (msg && msg.content) {
            navigator.clipboard.writeText(msg.content);
            const btn = $(`[data-msg-id="${msgId}"].message-copy-btn`);
            if (btn) {
                btn.classList.add('copied');
                btn.innerHTML = `
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M20 6L9 17l-5-5"/>
                    </svg>
                    <span class="copy-label">Copied!</span>
                `;
                setTimeout(() => {
                    btn.classList.remove('copied');
                    btn.innerHTML = `
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                        </svg>
                        <span class="copy-label">Copy</span>
                    `;
                }, 2000);
            }
        }
    },

    /**
     * Toggle favorite state for a user message
     * Called from the favorite button in message header
     * @param {HTMLElement} btn - The button element
     */
    async toggleMessageFavorite(btn) {
        const msgId = btn.dataset.msgId;
        const promptId = btn.dataset.promptId;

        if (!promptId) {
            console.warn('[App] Cannot favorite message without promptId');
            return;
        }

        // Find the message in active session (use window.app to avoid this binding issues)
        const app = window.app;
        const msg = app?.activeSession?.messages?.find(m => m.id === msgId);

        // Optimistic UI update
        const wasActive = btn.classList.contains('active');
        btn.classList.toggle('active');
        btn.setAttribute('data-tooltip', wasActive ? 'Add to favorites' : 'Remove from favorites');

        // Import and call the API
        try {
            const { toggleFavorite } = await import('./prompt-favorites.js');
            // Get content preview from message if found, otherwise from button's parent message
            const contentPreview = msg?.content?.substring(0, 100) || '';
            const newState = await toggleFavorite(promptId, contentPreview);

            // Update session message state if found
            if (msg) {
                msg.isFavorite = newState;
                app?.sessionManager?.saveSessions();
            }

            // Revert UI if API state doesn't match expected
            if (newState === wasActive) {
                btn.classList.toggle('active');
                btn.setAttribute('data-tooltip', newState ? 'Remove from favorites' : 'Add to favorites');
            }
        } catch (err) {
            console.error('[App] Failed to toggle favorite:', err);
            // Revert UI on error
            btn.classList.toggle('active');
            btn.setAttribute('data-tooltip', wasActive ? 'Remove from favorites' : 'Add to favorites');
        }
    },

    // ═══════════════════════════════════════════════════════════════
    // ASKUSERQUESTION HANDLING
    // ═══════════════════════════════════════════════════════════════

    /**
     * Submit answers for AskUserQuestion tool (supports both single and grouped wizard mode)
     * Called from the submit button in the question form
     * @param {string} msgId - The message ID containing question(s)
     */
    submitQuestionAnswers(msgId) {
        const session = this.activeSession;
        if (!session) {
            console.error('No active session');
            return;
        }

        // Find the question message
        const questionMsg = session.messages.find(m => m.id === msgId && m.role === 'question');
        if (!questionMsg) {
            console.error('Question message not found:', msgId);
            return;
        }

        const form = document.querySelector(`.question-form[data-msg-id="${msgId}"]`);
        if (!form) {
            console.error('Question form not found:', msgId);
            return;
        }

        // Get entries (support both old single format and new grouped format)
        const entries = questionMsg.entries || [{
            toolId: questionMsg.toolId,
            questions: questionMsg.questions || [],
            answers: {}
        }];

        // Collect answers from all entries
        let hasAnyAnswer = false;

        form.querySelectorAll('.question-entry').forEach((entryEl, entryIdx) => {
            const entry = entries[entryIdx];
            if (!entry) return;

            entryEl.querySelectorAll('.question-item').forEach(item => {
                const header = item.dataset.header;
                const isMulti = item.dataset.multi === 'true';
                const selectedOptions = item.querySelectorAll('.question-option.selected');

                if (isMulti) {
                    const values = Array.from(selectedOptions)
                        .map(btn => {
                            if (btn.dataset.value === '__other__') {
                                const input = item.querySelector('.question-other-input');
                                return input?.value?.trim() || '';
                            }
                            return btn.dataset.value;
                        })
                        .filter(v => v);
                    if (values.length > 0) {
                        entry.answers[header] = values.join(', ');
                        hasAnyAnswer = true;
                    }
                } else {
                    const selected = selectedOptions[0];
                    if (selected) {
                        if (selected.dataset.value === '__other__') {
                            const input = item.querySelector('.question-other-input');
                            entry.answers[header] = input?.value?.trim() || 'Other';
                        } else {
                            entry.answers[header] = selected.dataset.value;
                        }
                        hasAnyAnswer = true;
                    }
                }
            });
        });

        // Free-text comment (shared across the card, independent of the options).
        const commentEl = form.querySelector('.question-comment');
        const comment = commentEl?.value?.trim() || '';

        // Need at least one selected answer OR a comment — a wholly empty submit
        // shakes the form.
        if (!hasAnyAnswer && !comment) {
            form.classList.add('shake');
            setTimeout(() => form.classList.remove('shake'), 500);
            return;
        }

        // Persist the comment so it re-renders on the answered card / restore.
        questionMsg.comment = comment;

        // Send answers for each entry (each has its own tool_id)
        session.sendToolAnswers(entries, questionMsg, comment);
    },

    /**
     * Dismiss an AskUserQuestion without sending anything to Claude.
     * Marks the message as answered+ignored locally so the banner clears
     * and the form collapses, but no tool_answer is sent over the WS.
     */
    ignoreQuestion(msgId) {
        const session = this.activeSession;
        if (!session) return;

        const questionMsg = session.messages.find(m => m.id === msgId && m.role === 'question');
        if (!questionMsg || questionMsg.answered) return;

        questionMsg.answered = true;
        questionMsg.ignored = true;

        this.updateQuestionMessage(questionMsg);

        session.pendingQuestionId = null;
        session.updateTab();
        this.updateQuestionIndicator();
        this.sessionManager.saveSessions();
    },

    /**
     * Re-open an already-answered AskUserQuestion card so the user can change
     * their choice and resend it to Claude. Sets a transient `_editing` flag and
     * re-renders — the form comes back interactive with the previous answers
     * pre-selected (see _renderQuestionForm / findAnswerRecord). No WS traffic
     * until the user actually submits.
     */
    editQuestionAnswer(msgId) {
        const session = this.activeSession;
        if (!session) return;

        const questionMsg = session.messages.find(m => m.id === msgId && m.role === 'question');
        if (!questionMsg || !questionMsg.answered) return;
        // An ignored/skipped card was never actually answered — nothing to edit.
        if (questionMsg.ignored || questionMsg.skipped) return;

        questionMsg._editing = true;
        this.updateQuestionMessage(questionMsg);
    },

    /** Abandon an in-progress answer edit and restore the answered view. */
    cancelEditQuestion(msgId) {
        const session = this.activeSession;
        if (!session) return;

        const questionMsg = session.messages.find(m => m.id === msgId && m.role === 'question');
        if (!questionMsg) return;

        questionMsg._editing = false;
        this.updateQuestionMessage(questionMsg);
    },

    /** @delegate ChatController */
    updateQuestionMessage(msg) {
        this.chatCtrl.updateQuestionMessage(msg);
    },

    /**
     * Answer an interactive permission card (claude-sdk can_use_tool ask).
     * Reads the optional deny-guidance input and relays the decision over the
     * session WebSocket; the provider process resumes as soon as it lands.
     */
    respondPermission(msgId, behavior, suggestionIndex) {
        const session = this.activeSession;
        if (!session) return;
        const feedback = behavior === 'deny'
            ? (document.getElementById(`perm-feedback-${msgId}`)?.value || '').trim()
            : '';
        session.sendPermissionResponse(msgId, behavior, feedback, suggestionIndex);
        this.updateQuestionIndicator();
    },

    /**
     * The newest unanswered interactive permission card in the active session,
     * or null. Backs the Enter=Allow / Esc=Deny keyboard shortcuts so the user
     * can clear a pending ask without reaching for the mouse.
     */
    pendingPermissionCard() {
        const session = this.activeSession;
        if (!session) return null;
        for (let i = session.messages.length - 1; i >= 0; i--) {
            const m = session.messages[i];
            if (m.role === 'permission' && !m.answered) return m;
        }
        return null;
    },

    /**
     * Allow the pending permission card via keyboard (Enter). No-op when there
     * is no card waiting — the shortcut's `permissionPending` context already
     * gates this, so the guard is just belt-and-suspenders.
     */
    allowPendingPermission() {
        const msg = this.pendingPermissionCard();
        if (!msg) return;
        this.respondPermission(msg.id, 'allow');
    },

    /**
     * Deny the pending permission card via keyboard (Esc). Any text typed into
     * the deny-guidance field rides along as feedback. Returns true when a card
     * was denied so handleEscape() can stop its priority chain.
     */
    denyPendingPermission() {
        const msg = this.pendingPermissionCard();
        if (!msg) return false;
        this.respondPermission(msg.id, 'deny');
        return true;
    },

    /**
     * Approve plan from ExitPlanMode approval card
     * Sends approval as a regular user message and resumes Claude
     */
    approvePlan(msgId) {
        const session = this.activeSession;
        if (!session) return;

        const msg = session.messages.find(m => m.id === msgId && m.role === 'plan_approval');
        if (!msg || msg.answered) return;

        msg.answered = true;
        msg.decision = 'approve';

        // Re-render the approval card
        const el = document.getElementById(`msg-${msg.id}`);
        if (el) {
            const newEl = this.chatCtrl.createMessageElement(msg);
            el.replaceWith(newEl);
        }

        // Clear pending question state
        session.pendingQuestionId = null;
        session.updateTab();
        this.updateQuestionIndicator();
        this.sessionManager.saveSessions();

        // Send approval as a regular user message
        this.sendMessage('Approved. Proceed with the plan implementation.');
    },

    /**
     * Reject plan from ExitPlanMode approval card
     * Re-enters plan mode and lets user type feedback
     */
    rejectPlan(msgId) {
        const session = this.activeSession;
        if (!session) return;

        const msg = session.messages.find(m => m.id === msgId && m.role === 'plan_approval');
        if (!msg || msg.answered) return;

        // Soft state — user is revising, but can still Approve later
        msg.decision = 'revise';

        // Re-render the approval card (shows revise status + Approve button)
        const el = document.getElementById(`msg-${msg.id}`);
        if (el) {
            const newEl = this.chatCtrl.createMessageElement(msg);
            el.replaceWith(newEl);
        }

        // Re-enter plan mode on client
        session.permissionMode = 'plan';
        session.pendingQuestionId = null;
        session.updateTab();
        this.updateInputPlaceholder();
        this.updateQuestionIndicator();
        this.sessionManager.saveSessions();

        // Re-enter plan mode on server (so restarts use --permission-mode plan)
        if (session.ws?.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify({
                type: 'set_permission_mode',
                mode: 'plan'
            }));
        }

        // Focus input so user can type feedback
        this.els.messageInput?.focus();
    },

    /**
     * Preview the plan file for the current session.
     * Plan file path is stored on the plan_approval message by handleExitPlanMode.
     */
    async previewPlan() {
        const session = this.activeSession;
        if (!session) return;

        // Find the latest plan_approval message with a planFile
        const msg = [...session.messages].reverse().find(m => m.role === 'plan_approval' && m.planFile);
        if (!msg?.planFile) return;

        // Use the already-imported FilePreviewWidget (not dynamic import, which would
        // load a separate module instance due to cache-bust query params)
        FilePreviewWidget.preview(msg.planFile);
    },
};
