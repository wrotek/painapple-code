/**
 * Startup & welcome-wiring mixin — autoReconnectSessions (re-opens sessions that
 * were connected before a page refresh), initBeforeUnload (warns on unsaved /
 * running work), removeWelcomePlaceholder, and initWelcomeEvents (wires the
 * welcome screen's project cards, recent list, and new-session actions).
 * Extracted from app.js; applied to App.prototype via Object.assign. Uses `this`
 * (App instance) plus the imports below.
 */
import S from '../strings.js';
import { CONFIG, debug } from '../config.js';
import { WidgetManager } from '../widget-system/init.js';

export const startupWelcomeMethods = {
    autoReconnectSessions() {
        // Reconnect sessions that were connected before page refresh
        this.sessionManager.sessions.forEach(session => {
            if (session.wasConnected && session.cwd) {
                debug.log(`Auto-reconnecting session: ${session.name} (cwd: ${session.cwd})`);
                session.connect();
            }
        });
    },

    initBeforeUnload() {
        // Save session state before page unloads (refresh/close)
        // CRITICAL: Use immediate saves (bypass debounce) - page may close before timer fires
        const saveAllState = () => {
            // Save current upload state to active session before serialization
            if (this.activeSession && this.uploadManager) {
                const uploadState = this.uploadManager.saveState();
                this.activeSession.pendingImages = uploadState.pendingImages;
                this.activeSession.pendingFiles = uploadState.pendingFiles;
            }
            this.sessionManager.saveSessionsImmediate();
            this.tabCtrl?.saveWidgetTabs();
        };

        window.addEventListener('beforeunload', () => {
            debug.log('[App] beforeunload triggered, saving state');
            saveAllState();
        });

        // pagehide is more reliable than beforeunload on iPadOS PWA
        // (Apple may skip beforeunload on PWA reload/close, but pagehide fires)
        window.addEventListener('pagehide', () => {
            debug.log('[App] pagehide triggered, saving state');
            saveAllState();
        });

        // Listen for storage quota exceeded events
        window.addEventListener('storage-quota-exceeded', (e) => {
            this.handleStorageQuotaExceeded(e.detail);
        });
    },

    /**
     * Remove the current session if it's a "welcome placeholder" (disconnected, empty, no storeId).
     * This allows opening a session from the welcome screen to replace the current tab
     * instead of creating a new one.
     */
    removeWelcomePlaceholder() {
        if (this.activeSession) {
            const isWelcomePlaceholder =
                this.activeSession.status === 'disconnected' &&
                (!this.activeSession.messages || this.activeSession.messages.length === 0) &&
                !this.activeSession.storeId;

            if (isWelcomePlaceholder) {
                // Save the tab position so the replacement session can be inserted here
                this._welcomeReplaceIndex = this.sessionManager.sessions.indexOf(this.activeSession);
                this.sessionManager.remove(this.activeSession);
            }
        }
    },

    /**
     * Initialize welcome screen event listeners.
     * The welcome screen emits custom events that we handle here.
     */
    initWelcomeEvents() {
        // Open a session from welcome screen (current tab)
        window.addEventListener('welcome:open-session', (e) => {
            const { sessionId, projectPath, fromWelcome } = e.detail;

            // Remove placeholder so the new session replaces it instead of creating a new tab
            this.removeWelcomePlaceholder();

            // Load the session (will create a new tab since placeholder is gone)
            // Pass fromWelcome flag to enable "back to sessions" feature
            this.ctx.emit('sessionItemClicked', { sessionId, cwd: projectPath, fromWelcome: fromWelcome || false });
        });

        // Open a session in a new tab (background=true keeps current tab focused)
        window.addEventListener('welcome:open-session-new-tab', async (e) => {
            const { sessionId, projectPath, background = false } = e.detail;
            // Load session directly - loadSessionFromServer handles creating the tab
            await this.loadSessionFromServer(sessionId, 50, false, { background });
        });

        // Fork a session (from preview/context menu)
        window.addEventListener('welcome:fork-session', async (e) => {
            const { sessionId, projectPath, fromWelcome } = e.detail;
            try {
                const response = await fetch(`${CONFIG.API_BASE}/api/session/${sessionId}/fork`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });

                if (!response.ok) {
                    throw new Error(`Fork failed: ${response.status}`);
                }

                const data = await response.json();
                const forkedSessionId = data.session_id;

                // Remove placeholder so forked session replaces it
                this.removeWelcomePlaceholder();

                // Open the forked session
                this.ctx.emit('sessionItemClicked', { sessionId: forkedSessionId, cwd: projectPath, fromWelcome: fromWelcome || false });
            } catch (err) {
                console.error('Fork failed:', err);
                this.activeSession?.addSystemLog(`Failed to fork session: ${err.message}`);
            }
        });

        // Start session on a specific project (from project chip on welcome screen)
        window.addEventListener('welcome:new-session-on-project', (e) => {
            const { projectPath } = e.detail;
            if (!projectPath || !this.activeSession) return;

            // Use current session, set cwd and connect
            this.activeSession.cwd = projectPath;
            this.activeSession.skipWelcome = true;
            this.activeSession.connect();
            this.sessionManager.saveSessions();
            this.fetchProjectCommands(projectPath);
            // cwd is set → switch to chat view
            this.tabCtrl.switchToSession(this.activeSession);
            // Focus the message input for immediate typing
            this.els.messageInput?.focus();
        });

        // Start a new session on a project
        window.addEventListener('welcome:start-project', (e) => {
            const { path, query } = e.detail;
            // Set the CWD for the active session and connect
            if (path && this.activeSession) {
                this.activeSession.cwd = path;
                this.activeSession.skipWelcome = true;  // Don't show welcome screen after connect
                this.activeSession.connect();  // Start the Claude connection
                this.sessionManager.saveSessions();
                this.fetchProjectCommands(path);
                // cwd is set → switch to chat view
                this.tabCtrl.switchToSession(this.activeSession);
            }
            // If there was a query (task intent), put it in the input
            if (query) {
                this.els.messageInput.value = query;
                this.syncInputHighlightBackdrop();
            }
            this.els.messageInput.focus();
        });

        // Browse for a project (open file explorer)
        window.addEventListener('welcome:browse-project', () => {
            // Open file explorer widget in directory mode
            import('./widget-system/index.js').then(({ WidgetManager }) => {
                WidgetManager.open('file-explorer');
            });
        });

        // View all sessions (placeholder — session browser removed)

        // View session details
        window.addEventListener('welcome:session-details', (e) => {
            const { sessionId } = e.detail;
            import('./widget-system/index.js').then(({ WidgetManager }) => {
                WidgetManager.open('log-explorer', { sessionId });
            });
        });

        // Clear input when welcome resets
        window.addEventListener('welcome:clear-input', () => {
            this.els.messageInput.value = '';
            this.syncInputHighlightBackdrop();
            this.els.messageInput.focus();
        });

        // Start a new session (from search no-results)
        window.addEventListener('welcome:new-session', () => {
            this.removeWelcomePlaceholder();
            this.createSession();
            this.els.messageInput.focus();
        });

        // Continue an existing session with a task message
        window.addEventListener('welcome:continue-with-task', (e) => {
            const { sessionId, projectPath, task } = e.detail;

            // Remove placeholder so the session replaces it
            this.removeWelcomePlaceholder();

            // Open the session and queue the task message
            this.ctx.emit('sessionItemClicked', { sessionId, cwd: projectPath });
            // After session opens, send the task
            setTimeout(() => {
                if (this.activeSession?.status === 'connected') {
                    this._sendMessageDirect(task);
                } else {
                    // Queue message for when connected
                    const checkConnection = setInterval(() => {
                        if (this.activeSession?.status === 'connected') {
                            clearInterval(checkConnection);
                            this._sendMessageDirect(task);
                        }
                    }, 100);
                    setTimeout(() => clearInterval(checkConnection), 10000);
                }
            }, 500);
        });

        // Start fresh session with a task message
        window.addEventListener('welcome:start-fresh-task', (e) => {
            const { task } = e.detail;
            const cwd = this.activeSession?.cwd;
            if (!cwd) {
                this.activeSession?.addSystemLog(S.errors.select_project);
                return;
            }

            // cwd is set → switch to chat view
            this.tabCtrl.switchToSession(this.activeSession);

            // Clear input and use the task
            this.els.messageInput.value = '';
            this.syncInputHighlightBackdrop();

            // Send the task message (will trigger connect + send)
            this._sendMessageDirect(task);
        });

        // Fork a session and send task to the fork
        window.addEventListener('welcome:fork-with-task', async (e) => {
            const { sessionId, projectPath, task } = e.detail;

            try {
                // Call fork API
                const response = await fetch(`${CONFIG.API_BASE}/api/session/${sessionId}/fork`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ context: task })
                });

                if (!response.ok) {
                    throw new Error(`Fork failed: ${response.status}`);
                }

                const data = await response.json();
                const forkedSessionId = data.session_id;

                // Remove placeholder so forked session replaces it
                this.removeWelcomePlaceholder();

                // Open the forked session
                this.ctx.emit('sessionItemClicked', { sessionId: forkedSessionId, cwd: projectPath });

                // After session opens, send the task
                setTimeout(() => {
                    if (this.activeSession?.status === 'connected') {
                        this._sendMessageDirect(task);
                    } else {
                        // Queue message for when connected
                        const checkConnection = setInterval(() => {
                            if (this.activeSession?.status === 'connected') {
                                clearInterval(checkConnection);
                                this._sendMessageDirect(task);
                            }
                        }, 100);
                        setTimeout(() => clearInterval(checkConnection), 10000);
                    }
                }, 500);
            } catch (err) {
                console.error('Fork failed:', err);
                this.activeSession?.addSystemLog(`Failed to fork session: ${err.message}`);
            }
        });
    },
};
