/**
 * Interactive question/approval mixin — Claude can pause for user input via
 * AskUserQuestion (multi-question wizard) or ExitPlanMode (plan approval).
 * This module owns:
 *   - handleAskUserQuestion: render new or merge into existing wizard
 *   - handleExitPlanMode: render plan-approval card with detected planFile
 *   - sendToolAnswer / sendToolAnswers: ship answers back over WebSocket and
 *     mark the message as answered
 *
 * Both render flows update the tab badge (?), scroll to the new card, and
 * persist via sessionManager. Applied to Session.prototype via
 * Object.assign in session.js.
 */

import { debug } from '../config.js';
import { genId } from '../utils.js';
import { showToast } from '../context-menu.js';
import S from '../strings.js';
import { basename } from '../path-utils.js';

const getApp = () => window.app;

/**
 * Coerce a tool-input `questions` value into an array of question objects.
 *
 * The CLI/SDK usually delivers `input.questions` already parsed as an array,
 * but some turns arrive with it as a JSON-encoded *string* (e.g.
 * `"[{\"question\": ...}]"`). When that happens the old `Array.isArray` guard
 * silently fell through to `[]`, so the "Claude is asking" card rendered with
 * no questions and no options — visibly broken. Parse the string form here so
 * both shapes work.
 * @param {*} raw - block.input?.questions (array, JSON string, or undefined)
 * @returns {Array} normalized questions array (empty if unparseable)
 */
function normalizeQuestions(raw) {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string' && raw.trim()) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
        } catch (e) {
            debug.log('Failed to parse AskUserQuestion questions string:', e);
        }
    }
    return [];
}

export const interactiveMethods = {
    /**
     * Handle AskUserQuestion tool - render interactive form for user input
     * Groups multiple questions from the same turn into a wizard-style UI
     * @param {Object} block - Tool use block with id, name, input
     */
    handleAskUserQuestion(block) {
        const app = getApp();
        const timestamp = this._currentServerTimestamp || new Date().toISOString();

        // Check if there's an existing unanswered question message to merge with
        // (multiple AskUserQuestion calls in same turn should be grouped)
        const existingQuestion = this.messages.find(m =>
            m.role === 'question' && !m.answered
        );

        // Create entry for this tool call
        const questions = normalizeQuestions(block.input?.questions);
        const entry = {
            toolId: block.id,
            questions,
            answers: {}
        };

        if (existingQuestion) {
            // Merge into existing question group
            if (!existingQuestion.entries) {
                // Convert single-entry format to multi-entry
                existingQuestion.entries = [{
                    toolId: existingQuestion.toolId,
                    questions: Array.isArray(existingQuestion.questions) ? existingQuestion.questions : [],
                    answers: existingQuestion.answers || {}
                }];
            }
            existingQuestion.entries.push(entry);
            existingQuestion.timestamp = timestamp;  // Update timestamp

            debug.log('Merged AskUserQuestion into existing group:', block.id, 'total entries:', existingQuestion.entries.length);

            // Re-render the message to show updated wizard
            if (app.activeSession === this) {
                const existingEl = document.getElementById(`msg-${existingQuestion.id}`);
                if (existingEl) {
                    const newEl = app.chatCtrl.createMessageElement(existingQuestion);
                    existingEl.replaceWith(newEl);
                }
            }
        } else {
            // Auto-dismiss any stale unanswered questions from previous turns
            // (e.g., auto-denied AskUserQuestion that was never answered by user)
            const staleQuestions = this.messages.filter(m => m.role === 'question' && !m.answered);
            for (const stale of staleQuestions) {
                stale.answered = true;
                if (app.activeSession === this) {
                    const el = document.getElementById(`msg-${stale.id}`);
                    if (el) {
                        const newEl = app.chatCtrl.createMessageElement(stale);
                        el.replaceWith(newEl);
                    }
                }
            }

            // Create new question message with entries array
            const msg = {
                id: genId(),
                role: 'question',
                toolId: block.id,  // Keep for backward compat
                toolName: 'AskUserQuestion',
                questions,  // Keep for backward compat
                entries: [entry],  // New grouped format
                answered: false,
                answers: {},  // Keep for backward compat
                activeTab: 0,  // Track active tab in wizard
                timestamp
            };

            this.messages.push(msg);

            if (app.activeSession === this) {
                app.renderMessage(msg);
            }

            debug.log('Created new AskUserQuestion:', block.id, questions.length, 'questions');
        }

        this.lastActivity = timestamp;
        this.pendingQuestionId = block.id;  // Track pending question
        this.updateTab();  // Update tab badge (shows ? indicator)

        // Scroll to the question form and update indicator
        if (app.activeSession === this) {
            setTimeout(() => {
                const questionMsg = this.messages.find(m => m.role === 'question' && !m.answered);
                if (questionMsg) {
                    const questionEl = document.getElementById(`msg-${questionMsg.id}`);
                    if (questionEl) {
                        questionEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                }
                // Update indicator (will show if user scrolls away)
                app.updateQuestionIndicator();
            }, 100);
        }

        app.sessionManager.saveSessions();
    },

    /**
     * Handle ExitPlanMode tool - render interactive plan approval UI
     * @param {Object} block - Tool use block with id, name, input
     */
    handleExitPlanMode(block) {
        const app = getApp();
        const timestamp = this._currentServerTimestamp || new Date().toISOString();

        // Find the plan file from session's Write tool history
        let planFile = null;
        for (let i = this.messages.length - 1; i >= 0; i--) {
            const m = this.messages[i];
            if (m.role === 'tool' && m.toolName === 'Write' && m.toolInput?.file_path?.includes('.claude/plans/')) {
                planFile = m.toolInput.file_path;
                break;
            }
        }

        // Fallback: look for any recent Write with 'plan' in the filename
        if (!planFile) {
            for (let i = this.messages.length - 1; i >= 0; i--) {
                const m = this.messages[i];
                if (m.role === 'tool' && m.toolName === 'Write' && m.toolInput?.file_path) {
                    const fname = basename(m.toolInput.file_path).toLowerCase();
                    if (fname.includes('plan')) {
                        planFile = m.toolInput.file_path;
                        break;
                    }
                }
            }
        }

        // Final fallback: use the most recent Write tool output (the plan file
        // may have a non-standard name like "modular-dreaming-riddle.md")
        if (!planFile) {
            for (let i = this.messages.length - 1; i >= 0; i--) {
                const m = this.messages[i];
                if (m.role === 'tool' && m.toolName === 'Write' && m.toolInput?.file_path) {
                    planFile = m.toolInput.file_path;
                    break;
                }
            }
        }

        const msg = {
            id: genId(),
            role: 'plan_approval',
            toolId: block.id,
            toolName: 'ExitPlanMode',
            planFile,
            answered: false,
            decision: null,  // 'approve' or 'reject'
            timestamp
        };

        this.messages.push(msg);

        if (app.activeSession === this) {
            app.renderMessage(msg);
        }

        this.lastActivity = timestamp;
        this.pendingQuestionId = block.id;  // Reuse ? badge mechanism
        this.updateTab();

        // Scroll to the approval card
        if (app.activeSession === this) {
            setTimeout(() => {
                const el = document.getElementById(`msg-${msg.id}`);
                if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                app.updateQuestionIndicator();
            }, 100);
        }

        app.sessionManager.saveSessions();
    },

    /**
     * Handle a `permission_request` frame (interactive can_use_tool ask from
     * the claude-sdk provider). Renders an inline approve/deny card; the
     * provider process is paused until sendPermissionResponse() answers.
     * Reconnect replays are deduped by requestId.
     * @param {Object} frame - {request_id, tool_name, input, description, ...}
     */
    handlePermissionRequest(frame) {
        const app = getApp();
        const timestamp = this._currentServerTimestamp || new Date().toISOString();

        // Dedupe: reconnect replay of a card we already have. Only replay
        // frames dedupe, and only against a still-unanswered card — request
        // ids are per-process counters (perm-1, perm-2, …), so a NON-replay
        // frame reusing an id is a NEW ask from a restarted process, not a
        // duplicate. Matching any old card here would swallow that ask and
        // leave the process blocked with no card to answer.
        if (frame.replay && this.messages.some(m =>
                m.role === 'permission' && !m.answered && m.requestId === frame.request_id)) {
            return;
        }

        // A non-replay ask reusing an unanswered card's request id means the
        // process restarted (ids restart at perm-1 per process) — that old
        // card's ask died with its process and can never be answered. Expire
        // just the colliding card. Other unanswered cards are left alone:
        // parallel tool calls from the live process legitimately stack asks,
        // and they all must stay answerable. Cards orphaned by a process
        // death are expired by expirePendingPermissionCards (session_ended)
        // or lazily via the ok=false response ack.
        if (!frame.replay) {
            for (const stale of this.messages.filter(m =>
                    m.role === 'permission' && !m.answered && m.requestId === frame.request_id)) {
                stale.answered = true;
                stale.decision = 'expired';
                stale.waitedMs = this._permWaitedMs(stale);
                this._rerenderPermissionCard(stale);
            }
        }

        const msg = {
            id: genId(),
            role: 'permission',
            requestId: frame.request_id,
            toolName: frame.tool_name,
            toolInput: frame.input || {},
            toolUseId: frame.tool_use_id || null,
            title: frame.title || null,
            description: frame.description || null,
            // Provider "don't ask again" rule suggestions → "always allow" rows
            suggestions: Array.isArray(frame.suggestions) ? frame.suggestions : [],
            answered: false,
            decision: null,  // 'allow' | 'allow_always' | 'deny' | 'expired'
            timestamp
        };
        this.messages.push(msg);

        if (app.activeSession === this) {
            app.renderMessage(msg);
        }

        // The provider process is blocked in its permission callback — show a
        // paused activity state and freeze the elapsed timer until the answer.
        if (!this._permPausedAt) {
            this._permPausedAt = Date.now();
            this._activityBeforePermission = this._lastActivity;
        }
        this._setActivity({
            active: true,
            paused: true,
            icon: 'lock',
            label: S.permission_card.activity_paused,
        });

        this.lastActivity = timestamp;
        this.pendingQuestionId = frame.request_id;  // Reuse ? badge mechanism
        this.updateTab();

        if (app.activeSession === this) {
            setTimeout(() => {
                const el = document.getElementById(`msg-${msg.id}`);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                app.updateQuestionIndicator();
            }, 100);
        } else if (!frame.replay) {
            // Background tab needs a decision — surface a click-to-go toast
            const label = S.permission_card.toast_pending.replace('{name}', this.name || 'Session');
            showToast(label, {
                interactive: true,
                duration: 10000,
                className: 'permission-toast',
                onMount: (toast) => {
                    toast.style.cursor = 'pointer';
                    toast.addEventListener('click', () => getApp().switchSession(this));
                },
            });
        }

        app.sessionManager.saveSessions();
    },

    /**
     * Send the user's allow/deny decision for a permission card.
     * @param {string} msgId - The permission message id
     * @param {string} behavior - 'allow' | 'deny'
     * @param {string} [feedback] - Optional deny guidance for the model
     * @param {number} [suggestionIndex] - "Always allow": index into the
     *   request's suggestions; the provider applies that rule update itself.
     */
    sendPermissionResponse(msgId, behavior, feedback, suggestionIndex) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot send permission response: WebSocket not connected');
            showToast(S.errors.not_connected);
            return false;
        }
        const msg = this.messages.find(m => m.role === 'permission' && m.id === msgId);
        if (!msg || msg.answered) return false;

        const alwaysAllow = behavior === 'allow' && Number.isInteger(suggestionIndex);
        this.ws.send(JSON.stringify({
            type: 'permission_response',
            request_id: msg.requestId,
            behavior,
            message: feedback || undefined,
            suggestion_index: alwaysAllow ? suggestionIndex : undefined,
        }));
        debug.log('Sent permission response:', msg.requestId, behavior, suggestionIndex);

        msg.answered = true;
        msg.decision = alwaysAllow ? 'allow_always' : behavior;
        msg.waitedMs = this._permWaitedMs(msg);
        if (behavior === 'deny' && feedback) msg.feedback = feedback;
        this._rerenderPermissionCard(msg);

        this.pendingQuestionId = null;
        this._resumePermissionActivity();
        this.updateTab();
        const app = getApp();
        if (app.activeSession === this) {
            app.updateQuestionIndicator();
        }
        app.sessionManager.saveSessions();
        return true;
    },

    /**
     * Server ack for a permission_response. ok=false → the request had
     * expired (process restarted) — mark the card so the user knows.
     */
    handlePermissionResolved(frame) {
        if (frame.ok) return;
        const msg = this.messages.find(m => m.role === 'permission' && m.requestId === frame.request_id);
        if (msg) {
            msg.decision = 'expired';
            msg.answered = true;
            msg.waitedMs = this._permWaitedMs(msg);
            this._rerenderPermissionCard(msg);
            this._resumePermissionActivity();
            getApp().sessionManager.saveSessions();
        }
    },

    /**
     * Find the permission card for a denial the USER made by hand (clicked
     * Deny on the card). Used to tell manual denies apart from permission-mode
     * auto-denies: the mode-explainer error card ("blocked by X mode — change
     * the permission level…") is wrong and redundant for a manual decision —
     * the answered card and the tool error (which quotes the user's feedback)
     * already tell the story. Matches by tool_use_id when both sides have it,
     * else falls back to tool name.
     * @param {string} toolName
     * @param {string|null} toolUseId
     * @returns {Object|undefined} the denied card message, if any
     */
    findManualDenyCard(toolName, toolUseId) {
        return [...this.messages].reverse().find(m =>
            m.role === 'permission' && m.decision === 'deny' &&
            ((toolUseId && m.toolUseId) ? m.toolUseId === toolUseId : m.toolName === toolName));
    },

    /**
     * How long a permission ask waited before it was resolved/expired, anchored
     * on the card's server timestamp (same anchor as the live elapsed ticker in
     * chat-controller). Clamped to >= 0 to absorb minor client/server skew.
     */
    _permWaitedMs(msg) {
        const start = Date.parse(msg.timestamp);
        return Math.max(0, Date.now() - (Number.isNaN(start) ? Date.now() : start));
    },

    /**
     * Expire every unanswered permission card — called on session_ended: the
     * provider process died and the server dropped its pending asks (a
     * response can only reach the stdin that asked), so these cards can never
     * be answered. Clears the paused-activity bookkeeping without touching the
     * activity strip itself; the session_ended handler sets the final state.
     */
    expirePendingPermissionCards() {
        const pending = this.messages.filter(m => m.role === 'permission' && !m.answered);
        if (!pending.length) return;
        for (const msg of pending) {
            msg.answered = true;
            msg.decision = 'expired';
            msg.waitedMs = this._permWaitedMs(msg);
            this._rerenderPermissionCard(msg);
        }
        this._permPausedAt = null;
        this._activityBeforePermission = null;
        this.pendingQuestionId = null;
        this.updateTab();
        const app = getApp();
        if (app.activeSession === this) app.updateQuestionIndicator();
        app.sessionManager.saveSessions();
    },

    /**
     * Un-pause the activity strip after the last pending ask is answered:
     * shift the turn start time forward by the paused span (so the elapsed
     * timer resumes where it froze) and restore the pre-ask activity.
     */
    _resumePermissionActivity() {
        if (!this._permPausedAt) return;
        // Parallel tool calls can stack asks — stay paused until all answered
        if (this.messages.some(m => m.role === 'permission' && !m.answered)) return;
        const pausedMs = Date.now() - this._permPausedAt;
        this._permPausedAt = null;
        if (this._turnStartTime) this._turnStartTime += pausedMs;
        const prev = this._activityBeforePermission;
        this._activityBeforePermission = null;
        this._setActivity(prev
            ? { ...prev, paused: false }
            : { active: true, icon: 'sparkle', label: S.activity.states.working });
    },

    /** Re-render a permission card in place (if this session is visible). */
    _rerenderPermissionCard(msg) {
        const app = getApp();
        if (app.activeSession !== this) return;
        const el = document.getElementById(`msg-${msg.id}`);
        if (el) {
            el.replaceWith(app.chatCtrl.createMessageElement(msg));
        }
    },

    /**
     * Submit answers for AskUserQuestion tool
     * @param {string} toolId - The tool_use_id
     * @param {Object} answers - Answers keyed by question header
     */
    sendToolAnswer(toolId, answers, comment = '') {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot send tool answer: WebSocket not connected');
            return false;
        }

        // Find the question message to get original questions for context
        const questionMsg = this.messages.find(m => m.role === 'question' && m.toolId === toolId);
        const questions = questionMsg?.questions || [];

        const message = {
            type: 'tool_answer',
            tool_use_id: toolId,
            answers: answers,
            questions: questions  // Include original questions for server to format
        };
        if (comment) message.comment = comment;

        this.ws.send(JSON.stringify(message));
        debug.log('Sent tool answer:', toolId, answers);

        // Update the question message as answered (reuse questionMsg from above)
        if (questionMsg) {
            questionMsg.answered = true;
            questionMsg._editing = false;  // leave edit mode on (re)send
            questionMsg.answers = answers;
            questionMsg.comment = comment;
            const app = getApp();
            if (app.activeSession === this) {
                app.updateQuestionMessage(questionMsg);
            }
            app.sessionManager.saveSessions();
        }

        this.pendingQuestionId = null;
        this.updateTab();  // Remove ? badge now that question is answered
        // Clear the floating question indicator
        const app = getApp();
        if (app.activeSession === this) {
            app.updateQuestionIndicator();
        }
        return true;
    },

    /**
     * Submit answers for grouped AskUserQuestion (wizard mode)
     * Sends answers for each tool entry sequentially
     * @param {Array} entries - Array of {toolId, questions, answers}
     * @param {Object} questionMsg - The question message object
     */
    sendToolAnswers(entries, questionMsg, comment = '') {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot send tool answers: WebSocket not connected');
            return false;
        }

        // Send answer for each entry. The free-text comment is shared across the
        // whole card, so it rides on the LAST frame only (each frame becomes its
        // own follow-up message server-side — attaching it to every entry would
        // repeat the comment N times).
        entries.forEach((entry, i) => {
            const message = {
                type: 'tool_answer',
                tool_use_id: entry.toolId,
                answers: entry.answers,
                questions: entry.questions  // Include original questions for server to format
            };
            if (comment && i === entries.length - 1) message.comment = comment;
            this.ws.send(JSON.stringify(message));
            debug.log('Sent tool answer:', entry.toolId, entry.answers);
        });

        // Update the question message as answered
        if (questionMsg) {
            questionMsg.answered = true;
            questionMsg._editing = false;  // leave edit mode on (re)send
            questionMsg.comment = comment;
            // Update answers in entries
            if (questionMsg.entries) {
                questionMsg.entries.forEach((e, i) => {
                    if (entries[i]) {
                        e.answers = entries[i].answers;
                    }
                });
            }
            // Also update legacy answers field for backward compatibility
            questionMsg.answers = entries[0]?.answers || {};

            const app = getApp();
            if (app.activeSession === this) {
                app.updateQuestionMessage(questionMsg);
            }
            app.sessionManager.saveSessions();
        }

        this.pendingQuestionId = null;
        this.updateTab();  // Remove ? badge now that question is answered
        // Clear the floating question indicator
        const appRef = getApp();
        if (appRef.activeSession === this) {
            appRef.updateQuestionIndicator();
        }
        return true;
    },
};
