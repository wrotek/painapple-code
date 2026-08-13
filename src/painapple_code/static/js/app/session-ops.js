/**
 * Session-operations mixin — compactSession, the plan-compose state hook
 * (onPlanComposeChange) and planMode, session forking (forkSession /
 * forkCompactSession), btwDiscussion (fork into a discussion widget),
 * cloneSession, and stopClaude. Extracted from app.js; applied to App.prototype
 * via Object.assign. Uses `this` (App instance) plus the imports below.
 */
import S from '../strings.js';
import { CONFIG } from '../config.js';
import { Session } from '../session.js';
import { permissionSettings } from '../permission-settings.js';
import { DiscussionWidget } from '../widgets/index.js';

export const sessionOpsMethods = {
    compactSession(args = '') {
        const cmd = args.trim() ? `/compact ${args.trim()}` : '/compact';
        this.sendMessage(cmd);
    },

    /**
     * Flip the permission button to plan (or back) when the user enters/leaves
     * the `/plan ` compose box. This is purely visual — nothing is sent to the
     * server, so a running turn is never interrupted just by typing `/plan`.
     * The real switch + restart happens at send time, via planMode().
     * @param {boolean} active - true on entering plan compose, false on abandon
     */
    onPlanComposeChange(active) {
        if (active) {
            if (permissionSettings.getLevel() === 'plan') return;
            this._planComposePrevLevel = permissionSettings.getLevel();
            permissionSettings.currentLevel = 'plan';
            permissionSettings.updateButtonState();
        } else {
            const prev = this._planComposePrevLevel;
            this._planComposePrevLevel = null;
            // Nothing to revert, or the user changed the level manually — leave it.
            if (!prev || permissionSettings.getLevel() !== 'plan') return;
            permissionSettings.currentLevel = prev;
            permissionSettings.updateButtonState();
        }
    },

    /**
     * Enter plan mode. Sets plan as the desired permission mode — like the
     * permission button, it applies on the next message (the bridge respawns
     * the idle process in plan mode, or reuses it if already in plan). Any text
     * after `/plan ` is sent through the normal path as the first message.
     * @param {string} prompt - Optional prompt to send after entering plan mode
     */
    planMode(prompt = '') {
        if (!this.activeSession?.ws || this.activeSession.ws.readyState !== WebSocket.OPEN) {
            this.activeSession?.addSystemLog(S.errors.not_connected, 'error');
            return;
        }

        // Committed to plan by sending — no pending compose revert.
        this._planComposePrevLevel = null;

        // Set plan as the desired mode (skip if already there). No interrupt,
        // no restart — the next message applies it via the universal path.
        if (!this.activeSession.isInPlanMode) {
            this.activeSession.ws.send(JSON.stringify({ type: 'set_permission_mode', mode: 'plan' }));
            this.activeSession.permissionMode = 'plan';  // optimistic; echo confirms
            permissionSettings.currentLevel = 'plan';
            permissionSettings.updateButtonState();
        }

        // Send the prompt (if any) through the normal path — sendMessage marks
        // it plan and attaches stash. An empty /plan just arms plan for the next turn.
        const userPrompt = prompt.trim();
        if (userPrompt) {
            this.sendMessage(userPrompt);
        } else {
            this.activeSession.addSystemLog(S.status.entering_plan_mode, 'info');
        }
    },

    async forkSession() {
        if (!this.activeSession?.storeId) {
            this.activeSession?.addSystemLog(S.errors.cannot_fork, 'error');
            return;
        }
        // Engines without fork (capabilities.fork=false, e.g. ephemeral codex
        // exec) fail friendly here; the server 409s as the backstop.
        if (this.activeSession.providerCaps?.fork === false) {
            this.activeSession.addSystemLog(S.engine.fork_unsupported.replace(
                '{engine}', this.activeSession.providerDisplayName || this.activeSession.provider), 'error');
            return;
        }

        // Capture source session info BEFORE the fork API call
        const sourceSession = this.activeSession;
        const sourceStoreId = sourceSession.storeId;
        const sourceName = sourceSession.name;

        try {
            const response = await fetch(
                `${CONFIG.API_BASE}/api/session/${this.activeSession.storeId}/fork`,
                { method: 'POST' }
            );

            if (!response.ok) {
                const error = await response.json();
                this.activeSession?.addSystemLog(`Fork failed: ${error.detail || response.statusText}`, 'error');
                return;
            }

            const data = await response.json();
            sourceSession.addSystemLog(`Forked session: ${data.id}`, 'info');

            // Create new session WITHOUT copying messages (Claude has context via --fork-session)
            // Just add a reference message linking to parent session
            const forkedSession = this.sessionManager.create({
                storeId: data.id,
                cwd: data.cwd,
                name: `Fork of ${sourceName}`,
                providerSessionId: data.provider_session_id,  // Fork will use --fork-session
            });

            if (forkedSession) {
                // Copy prompt history from source for arrow-up browsing
                if (sourceSession.promptHistory?.length) {
                    forkedSession.promptHistory = [...sourceSession.promptHistory];
                    forkedSession.promptHistoryLoaded = true;
                }

                // Add a fork reference message (rendered with link to parent)
                forkedSession.addMessage({
                    role: 'info',
                    content: `Forked from "${sourceName}"`,
                    source: 'fork-reference',
                    forkedFromId: sourceStoreId,
                    forkedFromName: sourceName
                });

                // Switch to the forked session
                this.switchToSession(forkedSession);
                // Connect with --fork-session to branch from source conversation
                forkedSession.connect();
            }
        } catch (error) {
            console.error('Fork session failed:', error);
            this.activeSession?.addSystemLog(`Fork failed: ${error.message}`, 'error');
        }
    },

    /**
     * Fork session then compact - branch conversation and immediately run /compact
     */
    async forkCompactSession(args = '') {
        if (!this.activeSession?.storeId) {
            this.activeSession?.addSystemLog(S.errors.cannot_fork_compact, 'error');
            return;
        }

        const sourceSession = this.activeSession;
        const sourceStoreId = sourceSession.storeId;
        const sourceName = sourceSession.name;

        try {
            const response = await fetch(
                `${CONFIG.API_BASE}/api/session/${this.activeSession.storeId}/fork`,
                { method: 'POST' }
            );

            if (!response.ok) {
                const error = await response.json();
                this.activeSession?.addSystemLog(`Fork-compact failed: ${error.detail || response.statusText}`, 'error');
                return;
            }

            const data = await response.json();
            sourceSession.addSystemLog(`Forked session: ${data.id} (compacting)`, 'info');

            const forkedSession = this.sessionManager.create({
                storeId: data.id,
                cwd: data.cwd,
                name: `Fork of ${sourceName}`,
                providerSessionId: data.provider_session_id,
            });

            if (forkedSession) {
                // Copy prompt history from source for arrow-up browsing
                if (sourceSession.promptHistory?.length) {
                    forkedSession.promptHistory = [...sourceSession.promptHistory];
                    forkedSession.promptHistoryLoaded = true;
                }

                forkedSession.addMessage({
                    role: 'info',
                    content: `Forked from "${sourceName}"`,
                    source: 'fork-reference',
                    forkedFromId: sourceStoreId,
                    forkedFromName: sourceName
                });

                this.switchToSession(forkedSession);
                forkedSession.connect();

                // Queue /compact to send after fork connection is established
                const compactCmd = args.trim() ? `/compact ${args.trim()}` : '/compact';
                // Optimistically mark as working so tab dot + activity strip light up
                // immediately, rather than waiting 1-2s for the subprocess's system/init.
                // Server-side system/init / system/status will just reassert these.
                forkedSession.isAgentRunning = true;
                forkedSession._setActivity({ active: true, icon: 'compress', label: S.activity.states.compacting });
                forkedSession.updateTab();
                const checkConnection = setInterval(() => {
                    if (forkedSession.status === 'connected') {
                        clearInterval(checkConnection);
                        forkedSession.send(compactCmd);
                    }
                }, 100);
                setTimeout(() => clearInterval(checkConnection), 10000);
            }
        } catch (error) {
            console.error('Fork-compact failed:', error);
            this.activeSession?.addSystemLog(`Fork-compact failed: ${error.message}`, 'error');
        }
    },

    /**
     * /btw <question> - fork a discussion thread for a side question.
     * Same machinery as "Discuss Now" on a selection, but without a quoted anchor.
     */
    async btwDiscussion(args = '') {
        const question = (args || '').trim();
        if (!question) {
            this.activeSession?.addSystemLog(S.errors.btw_needs_question, 'error');
            return;
        }
        if (!this.activeSession?.storeId) {
            this.activeSession?.addSystemLog(S.errors.btw_no_session, 'error');
            return;
        }
        const anchor = { type: 'btw', selectedText: '' };
        await DiscussionWidget.startThread(anchor, question);
    },

    /**
     * Clone session - create new session with same CWD but fresh conversation
     * Unlike fork, this doesn't branch the conversation - it starts fresh.
     */
    cloneSession(promptText) {
        const sourceCwd = this.activeSession?.cwd;
        if (!sourceCwd) {
            this.activeSession?.addSystemLog(S.errors.cannot_clone, 'error');
            return;
        }

        const sourceName = this.activeSession?.name || 'Session';
        // Clone runs on the source session's engine (bound provider, or the
        // pending pick on a not-yet-bound tab) — rides the create WS URL.
        const sourceEngine = this.activeSession?.provider || this.activeSession?.pendingProvider || null;

        // Create new session with same CWD
        const clonedSession = this.sessionManager.create({
            cwd: sourceCwd,
            name: `Clone of ${sourceName}`,
        });

        if (clonedSession) {
            if (sourceEngine) clonedSession.pendingProvider = sourceEngine;
            this.activeSession?.addSystemLog(`Cloned to new session with same project`, 'info');
            this.switchToSession(clonedSession);

            // Clone inherits cwd from source — predicate routes to chat view.
            // Still hide the connection bar synchronously; otherwise it shows
            // briefly until ws.onopen drops it.
            this.els.connectionBar.classList.remove('visible');

            if (promptText?.trim()) {
                this._sendMessageDirect(promptText.trim());
            } else {
                clonedSession.connect();
            }
        }
    },

    stopClaude() {
        if (!this.activeSession || !this.isTyping) return;

        if (this.activeSession.stop()) {
            this.activeSession?.addSystemLog(S.status.stopping, 'info');
        }
    },
};
