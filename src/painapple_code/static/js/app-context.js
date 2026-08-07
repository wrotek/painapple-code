/**
 * AppContext - Shared context for all controllers
 *
 * Provides access to common dependencies without callback spaghetti.
 * Controllers use ctx.session instead of getSession() callbacks.
 */

export class AppContext {
    constructor(app) {
        this._app = app;
        this._listeners = new Map();
    }

    // ═══════════════════════════════════════════════════════════════
    // GETTERS - Direct access to app state (no callbacks needed)
    // ═══════════════════════════════════════════════════════════════

    /** Current active session */
    get session() {
        return this._app.activeSession;
    }

    /** The main App instance */
    get app() {
        return this._app;
    }

    /** DOM element references */
    get els() {
        return this._app.els;
    }

    /** Markdown renderer */
    get markdown() {
        return this._app.markdown;
    }

    /** Session manager */
    get sessionManager() {
        return this._app.sessionManager;
    }

    /** Tool renderer module */
    get toolRenderer() {
        return this._app.toolRenderer;
    }


    /** Shortcut manager */
    get shortcutManager() {
        return this._app.shortcutManager;
    }

    /** Status bar module */
    get statusBar() {
        return this._app.statusBar;
    }

    /** Scroll manager module */
    get scrollManager() {
        return this._app.scrollManager;
    }

    // ═══════════════════════════════════════════════════════════════
    // EVENT BUS - Simple pub/sub for cross-controller communication
    // ═══════════════════════════════════════════════════════════════

    /**
     * Emit an event to all listeners
     * @param {string} event - Event name
     * @param {*} data - Event data
     */
    emit(event, data) {
        const handlers = this._listeners.get(event);
        if (handlers) {
            handlers.forEach(handler => {
                try {
                    handler(data);
                } catch (e) {
                    console.error(`Error in event handler for ${event}:`, e);
                }
            });
        }
    }

    /**
     * Subscribe to an event
     * @param {string} event - Event name
     * @param {Function} handler - Event handler
     * @returns {Function} Unsubscribe function
     */
    on(event, handler) {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, new Set());
        }
        this._listeners.get(event).add(handler);

        // Return unsubscribe function
        return () => this.off(event, handler);
    }

    /**
     * Unsubscribe from an event
     * @param {string} event - Event name
     * @param {Function} handler - Event handler
     */
    off(event, handler) {
        const handlers = this._listeners.get(event);
        if (handlers) {
            handlers.delete(handler);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // HELPER METHODS - Common operations used by multiple controllers
    // ═══════════════════════════════════════════════════════════════

    /**
     * Add a message to the system log (stored per-session)
     * @param {string} text - Log message
     * @param {string} type - Log type ('info', 'error', 'success')
     */
    addSystemLog(text, type = 'info') {
        this._app.activeSession?.addSystemLog(text, type);
    }

    /**
     * Send a message through the active session
     * @param {string} content - Message content
     */
    sendMessage(content) {
        this._app.sendMessage(content);
    }

    /**
     * Switch to a different session
     * @param {Session} session - Session to switch to
     */
    switchToSession(session) {
        this._app.switchToSession(session);
    }

    /**
     * Get the message container for the current session
     * With container pool: returns the session-specific .session-messages element
     * Without pool: returns #messages
     * @returns {HTMLElement}
     */
    getMessageContainer() {
        // Delegate to chatCtrl if available (has container pool logic)
        if (this._app.chatCtrl) {
            return this._app.chatCtrl._getActiveMessageContainer();
        }
        // Fallback to #messages
        return this._app.els.messages;
    }
}
