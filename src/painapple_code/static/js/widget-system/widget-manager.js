/**
 * WidgetManager - Central registry and manager for all widgets
 *
 * Supports two widget scopes:
 * - 'global': One shared instance (config, debug, cost analytics, etc.)
 * - 'session': Separate instance per session tab (terminal, git, changes, etc.)
 *
 * Session-scoped widgets are hidden/shown on session switch (not destroyed/recreated),
 * preserving DOM state, WebSocket connections, scroll positions, etc.
 */

import { WidgetBus } from './event-bus.js';
import { DeviceManager } from './device-manager.js';
import { getWidgetClass } from './types/index.js';
import { debug } from '../config.js';

/**
 * Default widget types per device
 */
const DEVICE_DEFAULTS = {
    'file-explorer': {
        default: 'top-sheet',
        phone: 'top-sheet',
        tablet: 'top-sheet',
        desktop: 'floating'
    },
    'terminal': {
        default: 'top-sheet',
        phone: 'top-sheet',
        tablet: 'floating',
        desktop: 'floating'
    },
    'git': {
        default: 'bottom-sheet',
        phone: 'bottom-sheet',
        tablet: 'bottom-sheet',
        desktop: 'sidebar-right'
    },
    'logs': {
        default: 'bottom-sheet',
        phone: 'bottom-sheet',
        tablet: 'bottom-sheet',
        desktop: 'bottom-sheet'
    },
    'settings': {
        default: 'modal',
        phone: 'modal',
        tablet: 'modal',
        desktop: 'modal'
    },
    'comments': {
        default: 'top-sheet',
        phone: 'top-sheet',
        tablet: 'top-sheet',
        desktop: 'sidebar-right'
    }
};

class WidgetManagerClass {
    constructor() {
        /** @type {Map<string, object>} Widget configs (registration data) */
        this.configs = new Map();

        /** @type {Map<string, import('./base-widget.js').BaseWidget>} Global widget instances */
        this.globalWidgets = new Map();

        /** @type {Map<string, Map<string, import('./base-widget.js').BaseWidget>>} Session widget instances: sessionId -> (widgetId -> widget) */
        this.sessionWidgets = new Map();

        /** @type {Array<import('./base-widget.js').BaseWidget>} Z-index ordering stack */
        this.zIndexStack = [];

        /** @type {string|null} */
        this.currentSessionId = null;

        /** @type {string|null} */
        this.currentCwd = null;

        // Base z-index for floating widgets (above old panels: modals 1000, log-explorer 999, terminal 900)
        this.baseZIndex = 1500;

        // User type overrides (from settings)
        this.userTypeOverrides = this.loadUserOverrides();

        // Backwards compat: keep this.widgets as a proxy that routes through _resolve
        // This handles any external code that directly accesses WidgetManager.widgets
        this.widgets = this._createWidgetsProxy();

        // Set up event listeners
        this.setupEventListeners();
    }

    /**
     * Create a proxy for backwards-compat this.widgets access.
     * External code that calls WidgetManager.widgets.get(id) still works.
     */
    _createWidgetsProxy() {
        const self = this;
        return {
            get(id) { return self._resolve(id); },
            has(id) { return !!self._resolve(id); },
            set(id, widget) {
                // Should not be used externally, but route correctly
                const config = self.configs.get(id);
                if (config?.scope === 'session') {
                    const map = self._getSessionMap();
                    if (map) map.set(id, widget);
                } else {
                    self.globalWidgets.set(id, widget);
                }
            },
            delete(id) {
                const config = self.configs.get(id);
                if (config?.scope === 'session') {
                    const map = self.sessionWidgets.get(self.currentSessionId);
                    if (map) map.delete(id);
                } else {
                    self.globalWidgets.delete(id);
                }
            },
            forEach(fn) {
                // Iterate global + current session widgets
                self.globalWidgets.forEach(fn);
                const sessionMap = self.sessionWidgets.get(self.currentSessionId);
                if (sessionMap) sessionMap.forEach(fn);
            },
            get size() {
                let count = self.globalWidgets.size;
                const sessionMap = self.sessionWidgets.get(self.currentSessionId);
                if (sessionMap) count += sessionMap.size;
                return count;
            }
        };
    }

    // ==================== Internal Helpers ====================

    /**
     * Get or create the session widget map for a sessionId
     * @param {string} [sessionId]
     * @returns {Map<string, import('./base-widget.js').BaseWidget>|null}
     */
    _getSessionMap(sessionId = this.currentSessionId) {
        if (!sessionId) return null;
        if (!this.sessionWidgets.has(sessionId)) {
            this.sessionWidgets.set(sessionId, new Map());
        }
        return this.sessionWidgets.get(sessionId);
    }

    /**
     * Resolve a widget by ID, respecting scope.
     * For session-scoped widgets, returns the current session's instance.
     * @param {string} id
     * @returns {import('./base-widget.js').BaseWidget|undefined}
     */
    _resolve(id) {
        const config = this.configs.get(id);
        if (!config) return undefined;

        if (config.scope === 'global') {
            return this.globalWidgets.get(id);
        }
        // Session-scoped
        const sessionMap = this.sessionWidgets.get(this.currentSessionId);
        return sessionMap?.get(id);
    }

    /**
     * Store a widget in the correct map
     * @param {string} id
     * @param {import('./base-widget.js').BaseWidget} widget
     */
    _store(id, widget) {
        const config = this.configs.get(id);
        if (config?.scope === 'global') {
            this.globalWidgets.set(id, widget);
        } else {
            const map = this._getSessionMap();
            if (map) map.set(id, widget);
        }
    }

    /**
     * Remove a widget from the correct map
     * @param {string} id
     */
    _remove(id) {
        const config = this.configs.get(id);
        if (config?.scope === 'global') {
            this.globalWidgets.delete(id);
        } else {
            const sessionMap = this.sessionWidgets.get(this.currentSessionId);
            if (sessionMap) sessionMap.delete(id);
        }
    }

    /**
     * Iterate ALL widget instances (global + all sessions)
     * @param {Function} fn
     */
    _forEachWidget(fn) {
        this.globalWidgets.forEach(fn);
        this.sessionWidgets.forEach(sessionMap => {
            sessionMap.forEach(fn);
        });
    }

    /**
     * Compare two CWDs for project-scope matching (normalize trailing slashes)
     * @param {string|null} cwd1
     * @param {string|null} cwd2
     * @returns {boolean}
     */
    _cwdMatch(cwd1, cwd2) {
        if (!cwd1 || !cwd2) return false;
        const normalize = p => p.replace(/\/+$/, '');
        return normalize(cwd1) === normalize(cwd2);
    }

    // ==================== Event Listeners ====================

    /**
     * Set up event listeners
     */
    setupEventListeners() {
        // Handle widget focus (bring to front)
        WidgetBus.on('widget:focus', ({ widgetId }) => {
            const widget = this._resolve(widgetId);
            if (widget) {
                this.bringToFront(widget);
            }
        });

        // Handle session changes — switch widget visibility
        WidgetBus.on('session:changed', ({ sessionId, cwd }) => {
            this.switchSession(sessionId, cwd);
        });

        // Handle widget transform requests (from BaseWidget.transformTo)
        WidgetBus.on('widget:transform-request', ({ widgetId, newType, options }) => {
            this.transform(widgetId, newType, options);
        });

        // Handle device changes
        DeviceManager.onChange((newDevice, oldDevice) => {
            this.onDeviceChange(newDevice, oldDevice);
        });

        // Persist open widgets when they open/close
        WidgetBus.on('widget:opened', () => {
            this.saveOpenWidgets();
        });
        WidgetBus.on('widget:closed', () => {
            this.saveOpenWidgets();
        });

        // Handle visibility scope changes — re-evaluate widget visibility
        WidgetBus.on('widget:scope-changed', ({ widgetId, scope, ownerSessionId }) => {
            this._onScopeChanged(widgetId, scope, ownerSessionId);
        });
    }

    /**
     * Re-evaluate a widget's visibility after its scope changed
     * @param {string} widgetId
     * @param {string} scope - New effective scope
     * @param {string|null} ownerSessionId - Widget's owning session
     */
    _onScopeChanged(widgetId, scope, ownerSessionId) {
        // Find the widget across all session maps
        let widget = this.globalWidgets.get(widgetId);
        if (!widget) {
            for (const [, map] of this.sessionWidgets) {
                widget = map.get(widgetId);
                if (widget) break;
            }
        }
        if (!widget || !widget.isVisible) return;

        const isOwnSession = ownerSessionId === this.currentSessionId;

        // Determine if widget should be visible now
        let shouldShow;
        if (scope === 'global' || scope === 'all-sessions') {
            shouldShow = true;
        } else if (scope === 'project') {
            shouldShow = isOwnSession || this._cwdMatch(widget._ownerCwd, this.currentCwd);
        } else {
            // 'session' — only visible on own tab
            shouldShow = isOwnSession;
        }

        if (widget.container) widget.container.style.display = shouldShow ? '' : 'none';
        if (widget._backdrop) widget._backdrop.style.display = shouldShow ? '' : 'none';
    }

    // ==================== Registration ====================

    /**
     * Register a widget configuration
     * @param {string} id - Unique widget ID
     * @param {object} config - Widget configuration
     */
    register(id, config) {
        // Infer scope: explicit scope > sessionAware flag > default 'session'
        const scope = config.scope || (config.sessionAware === false ? 'global' : 'session');

        this.configs.set(id, {
            ...config,
            id,
            scope
        });

        return this;
    }

    // ==================== Creation ====================

    /**
     * Create and initialize a widget
     * @param {string} id - Widget ID (must be registered first)
     * @param {object} options - Override options
     * @returns {import('./base-widget.js').BaseWidget}
     */
    create(id, options = {}) {
        const config = this.configs.get(id);
        if (!config) {
            throw new Error(`Widget not registered: ${id}`);
        }

        // Determine type (user override > device default > config default)
        const type = this.getWidgetType(id, config);

        // Merge config with type and options
        const finalConfig = {
            ...config,
            ...options,
            type
        };

        // Get the appropriate widget class
        const WidgetClass = getWidgetClass(type);

        // Create instance
        const widget = new WidgetClass(id, finalConfig);

        // For session-scoped widgets, stamp the owning session ID and CWD
        if (config.scope === 'session') {
            widget._ownerSessionId = this.currentSessionId;
            widget.cwd = this.currentCwd;
            widget._ownerCwd = this.currentCwd;
        } else {
            widget._ownerCwd = this.currentCwd;
        }

        // Store in the correct map
        this._store(id, widget);

        // Initialize (creates DOM, attaches events)
        widget.init();

        // Set session and render
        if (config.scope === 'session') {
            // Session widget already knows its session via _ownerSessionId
            widget.sessionId = this.currentSessionId;
            widget.render();
        } else if (this.currentSessionId) {
            widget.setSession(this.currentSessionId);
        } else {
            // Render with null session - ensures content container is set
            widget.render();
        }

        // Add to z-index stack
        this.zIndexStack.push(widget);
        this.updateZIndices();

        return widget;
    }

    /**
     * Get or create a widget (scope-aware)
     * @param {string} id
     * @returns {import('./base-widget.js').BaseWidget}
     */
    get(id) {
        let widget = this._resolve(id);
        if (!widget && this.configs.has(id)) {
            // For session-scoped widgets, need a current session to create
            const config = this.configs.get(id);
            if (config.scope === 'session' && !this.currentSessionId) {
                return undefined;
            }
            widget = this.create(id);
        }
        return widget;
    }

    /**
     * Check if widget exists for current scope
     * @param {string} id
     * @returns {boolean}
     */
    has(id) {
        return !!this._resolve(id);
    }

    /**
     * Get all widgets visible in current context (global + current session)
     * @returns {import('./base-widget.js').BaseWidget[]}
     */
    list() {
        const result = Array.from(this.globalWidgets.values());
        const sessionMap = this.sessionWidgets.get(this.currentSessionId);
        if (sessionMap) {
            result.push(...sessionMap.values());
        }
        return result;
    }

    // ==================== Type Management ====================

    /**
     * Determine widget type based on user preference, device, and config
     * @param {string} id
     * @param {object} config
     * @returns {string}
     */
    getWidgetType(id, config) {
        // 1. User override (highest priority)
        const userOverride = this.userTypeOverrides[id];
        if (userOverride) return userOverride;

        // 2. Device-specific default
        const deviceDefaults = DEVICE_DEFAULTS[id] || config.deviceTypes;
        if (deviceDefaults) {
            const device = DeviceManager.getDevice();
            if (deviceDefaults[device]) {
                return deviceDefaults[device];
            }
            if (deviceDefaults.default) {
                return deviceDefaults.default;
            }
        }

        // 3. Config default
        return config.type || 'bottom-sheet';
    }

    /**
     * Set widget type override (user preference)
     * @param {string} id
     * @param {string} type
     */
    setWidgetType(id, type) {
        this.userTypeOverrides[id] = type;
        this.saveUserOverrides();

        // Transform existing widget if it exists
        const widget = this._resolve(id);
        if (widget && widget.type !== type && widget.canTransformTo(type)) {
            widget.transformTo(type);
        }
    }

    /**
     * Clear type override for a widget
     * @param {string} id
     */
    clearWidgetType(id) {
        delete this.userTypeOverrides[id];
        this.saveUserOverrides();
    }

    /**
     * Load user type overrides from localStorage
     */
    loadUserOverrides() {
        try {
            const data = localStorage.getItem('widget-type-overrides');
            return data ? JSON.parse(data) : {};
        } catch {
            return {};
        }
    }

    /**
     * Save user type overrides to localStorage
     */
    saveUserOverrides() {
        try {
            localStorage.setItem('widget-type-overrides', JSON.stringify(this.userTypeOverrides));
        } catch {
            // Storage full or unavailable
        }
    }

    // ==================== Session Switching ====================

    /**
     * Switch active session — hide old session's widgets, show new session's.
     * No re-rendering, no reconnection. Just CSS visibility toggle.
     * @param {string} newSessionId
     * @param {string} newCwd
     */
    switchSession(newSessionId, newCwd) {
        const oldSessionId = this.currentSessionId;

        // Update current references
        this.currentSessionId = newSessionId;
        this.currentCwd = newCwd;

        // Hide old session's widget containers (respecting visibility scope)
        if (oldSessionId && oldSessionId !== newSessionId) {
            const oldMap = this.sessionWidgets.get(oldSessionId);
            if (oldMap) {
                oldMap.forEach(widget => {
                    const vScope = widget.getEffectiveVisibilityScope();
                    // 'all-sessions' and 'global' stay visible across all sessions
                    if (vScope === 'all-sessions' || vScope === 'global') return;
                    // 'project' stays visible if CWD matches the new session
                    if (vScope === 'project' && this._cwdMatch(widget._ownerCwd, newCwd)) return;
                    // 'session' (default) — hide
                    if (widget.container) widget.container.style.display = 'none';
                    if (widget._backdrop) widget._backdrop.style.display = 'none';
                });
            }

            // Update project-scoped widgets from OTHER sessions:
            // show if their CWD matches the new session, hide if not
            this.sessionWidgets.forEach((map, sessionId) => {
                if (sessionId === oldSessionId || sessionId === newSessionId) return;
                map.forEach(widget => {
                    if (widget.getEffectiveVisibilityScope() !== 'project') return;
                    if (!widget.isVisible) return;
                    const show = this._cwdMatch(widget._ownerCwd, newCwd);
                    if (widget.container) widget.container.style.display = show ? '' : 'none';
                    if (widget._backdrop) widget._backdrop.style.display = show ? '' : 'none';
                });
            });
        }

        // Show new session's widget containers (only those that are logically open)
        if (newSessionId) {
            const newMap = this.sessionWidgets.get(newSessionId);
            if (newMap) {
                newMap.forEach(widget => {
                    if (widget.container) {
                        widget.container.style.display = '';
                    }
                    if (widget._backdrop) {
                        widget._backdrop.style.display = '';
                    }
                });
            }
        }

        // Hide/show global widgets tied to their opening session
        // (e.g., file-preview opened in context of one session should hide on switch,
        //  then restore when switching back)
        if (oldSessionId && oldSessionId !== newSessionId) {
            this.globalWidgets.forEach(widget => {
                if (!widget.config.closeOnSessionSwitch) return;
                // Restore: widget was hidden when we previously left newSessionId
                if (widget._visibleInSession === newSessionId) {
                    widget.container.style.display = '';
                    if (widget._backdrop) widget._backdrop.style.display = '';
                    delete widget._visibleInSession;
                }
                // Hide: widget is visible and not already hidden by a prior switch
                else if (widget.isVisible && !widget._visibleInSession) {
                    widget._visibleInSession = oldSessionId;
                    widget.container.style.display = 'none';
                    if (widget._backdrop) widget._backdrop.style.display = 'none';
                }
            });
        }

        // Notify global widgets that care about session context
        this.globalWidgets.forEach(widget => {
            if (widget.config.sessionAware !== false && widget.config.onSessionChange) {
                const oldCwd = widget.cwd;
                widget.setSession(newSessionId);
                widget.cwd = newCwd;
                // If CWD changed within the same session, notify via onCwdChange
                if (newCwd && newCwd !== oldCwd && oldSessionId === newSessionId && widget.config.onCwdChange) {
                    widget.config.onCwdChange(newCwd);
                }
            }
        });

        // Emit event for widgets that need to adjust after becoming visible
        // (e.g., terminal needs to call fitAddon.fit())
        if (newSessionId && oldSessionId !== newSessionId) {
            requestAnimationFrame(() => {
                WidgetBus.emit('session:widgets-shown', { sessionId: newSessionId, cwd: newCwd });
            });
        }
    }

    /**
     * Hide/show the current session's widgets (containers + backdrops).
     * Used when switching to/from widget tab mode — the floating widgets
     * should disappear while a full-page tab (terminal, file preview) is active.
     * @param {boolean} visible
     */
    setSessionWidgetsVisible(visible) {
        const sessionId = this.currentSessionId;
        if (!sessionId) return;
        const map = this.sessionWidgets.get(sessionId);
        if (!map) return;
        map.forEach(widget => {
            // 'global' visibility scope stays visible even during terminal fullscreen
            if (!visible && widget.getEffectiveVisibilityScope() === 'global') return;
            if (widget.container) {
                widget.container.style.display = visible ? '' : 'none';
            }
            if (widget._backdrop) {
                widget._backdrop.style.display = visible ? '' : 'none';
            }
        });
        // Also hide/show global widgets that act session-bound (e.g., file-preview)
        this.globalWidgets.forEach(widget => {
            if (!widget.config.closeOnSessionSwitch || !widget.isVisible) return;
            if (!visible && widget.getEffectiveVisibilityScope() === 'global') return;
            if (widget.container) {
                widget.container.style.display = visible ? '' : 'none';
            }
            if (widget._backdrop) {
                widget._backdrop.style.display = visible ? '' : 'none';
            }
        });
    }

    /**
     * Destroy all session-scoped widgets for a given session.
     * Called when a session tab is closed.
     * @param {string} sessionId
     */
    destroySessionWidgets(sessionId) {
        const sessionMap = this.sessionWidgets.get(sessionId);
        if (!sessionMap) return;

        sessionMap.forEach((widget, id) => {
            // Remove from z-index stack
            const stackIndex = this.zIndexStack.indexOf(widget);
            if (stackIndex > -1) {
                this.zIndexStack.splice(stackIndex, 1);
            }

            // Call widget-specific cleanup callback
            widget.config.onDestroy?.(sessionId);

            // Destroy DOM and handlers
            widget.destroy();
        });

        this.sessionWidgets.delete(sessionId);

        // Clean up localStorage for this session
        try {
            localStorage.removeItem(`widget-open-set-${sessionId}`);
            // Clean up per-widget state keys
            this.configs.forEach((config, id) => {
                if (config.scope === 'session') {
                    localStorage.removeItem(`widget-${id}-${sessionId}-state`);
                }
            });
        } catch {
            // Ignore storage errors
        }

        debug.log(`[WidgetManager] Destroyed widgets for session ${sessionId}`);
    }

    // ==================== Open Widget Persistence ====================

    /**
     * Get list of currently open widget IDs (split by scope)
     * @returns {{ global: string[], session: string[] }}
     */
    getOpenWidgetIds() {
        const global = [];
        const session = [];

        this.globalWidgets.forEach((widget, id) => {
            if (widget.isVisible) global.push(id);
        });

        if (this.currentSessionId) {
            const sessionMap = this.sessionWidgets.get(this.currentSessionId);
            if (sessionMap) {
                sessionMap.forEach((widget, id) => {
                    if (widget.isVisible) session.push(id);
                });
            }
        }

        return { global, session };
    }

    /**
     * Save open widget sets to localStorage
     */
    saveOpenWidgets() {
        try {
            const { global, session } = this.getOpenWidgetIds();
            localStorage.setItem('widget-open-set-global', JSON.stringify(global));
            if (this.currentSessionId) {
                localStorage.setItem(`widget-open-set-${this.currentSessionId}`, JSON.stringify(session));
            }
        } catch {
            // Storage full or unavailable
        }
    }

    /**
     * Load open widget set from localStorage
     * @param {'global'|string} scope - 'global' or a sessionId
     * @returns {string[]}
     */
    loadOpenWidgets(scope = 'global') {
        try {
            const key = scope === 'global' ? 'widget-open-set-global' : `widget-open-set-${scope}`;
            const data = localStorage.getItem(key);
            return data ? JSON.parse(data) : [];
        } catch {
            return [];
        }
    }

    /**
     * Restore previously open widgets after initialization.
     * Call this after all widgets are registered.
     */
    restoreOpenWidgets() {
        // Migrate from old format if needed
        this._migrateLocalStorage();

        // Restore global widgets
        const globalIds = this.loadOpenWidgets('global');
        if (globalIds.length > 0) {
            debug.log('[WidgetManager] Restoring global widgets:', globalIds);
            this._restoreWidgetSet(globalIds);
        }

        // Restore current session's widgets
        if (this.currentSessionId) {
            const sessionIds = this.loadOpenWidgets(this.currentSessionId);
            if (sessionIds.length > 0) {
                debug.log('[WidgetManager] Restoring session widgets:', sessionIds);
                this._restoreWidgetSet(sessionIds);
            }
        }
    }

    /**
     * Restore a set of widgets by ID
     * @param {string[]} ids
     */
    _restoreWidgetSet(ids) {
        ids.forEach(id => {
            if (this.configs.has(id)) {
                const config = this.configs.get(id);
                // Skip session widgets if no current session
                if (config.scope === 'session' && !this.currentSessionId) return;

                const widget = this.get(id);
                if (widget) {
                    const persistedState = widget._persistedState?.state;
                    if (persistedState && persistedState !== 'collapsed' && persistedState !== 'hidden') {
                        widget.setState(persistedState);
                    } else {
                        widget.open();
                    }
                }
            }
        });
    }

    /**
     * Restore session widgets for a specific session (called on session switch when
     * the session has no widgets yet but has persisted open-set data).
     * @param {string} sessionId
     */
    restoreSessionWidgets(sessionId) {
        if (!sessionId) return;

        const sessionMap = this.sessionWidgets.get(sessionId);
        // Only restore if the session has no widgets yet (first visit)
        if (sessionMap && sessionMap.size > 0) return;

        const sessionIds = this.loadOpenWidgets(sessionId);
        if (sessionIds.length > 0) {
            debug.log(`[WidgetManager] Restoring session ${sessionId} widgets:`, sessionIds);
            this._restoreWidgetSet(sessionIds);
        }
    }

    /**
     * One-time migration from old localStorage format
     */
    _migrateLocalStorage() {
        try {
            if (localStorage.getItem('widget-scope-v2')) return;

            // Migrate old widget-open-set to global
            const oldOpenSet = localStorage.getItem('widget-open-set');
            if (oldOpenSet) {
                const ids = JSON.parse(oldOpenSet);
                const globalIds = [];
                const sessionIds = [];

                ids.forEach(id => {
                    const config = this.configs.get(id);
                    if (config?.scope === 'global') {
                        globalIds.push(id);
                    } else {
                        sessionIds.push(id);
                    }
                });

                localStorage.setItem('widget-open-set-global', JSON.stringify(globalIds));

                // Apply session widgets to current session (if any)
                if (this.currentSessionId && sessionIds.length > 0) {
                    localStorage.setItem(`widget-open-set-${this.currentSessionId}`, JSON.stringify(sessionIds));
                }

                localStorage.removeItem('widget-open-set');
            }

            localStorage.setItem('widget-scope-v2', '1');
        } catch {
            // Ignore migration errors
        }
    }

    // ==================== Device Change ====================

    /**
     * Handle device type change
     */
    onDeviceChange(newDevice, oldDevice) {
        // Transform all widgets to device-appropriate types (unless user override)
        this._forEachWidget((widget) => {
            const id = widget.id;
            if (this.userTypeOverrides[id]) return;

            const config = this.configs.get(id);
            const newType = this.getWidgetType(id, config);

            if (widget.type !== newType && widget.canTransformTo(newType)) {
                widget.transformTo(newType);
            }
        });
    }

    // ==================== Z-Index Management ====================

    /**
     * Bring a widget to front (z-index)
     */
    bringToFront(widget) {
        const index = this.zIndexStack.indexOf(widget);
        if (index > -1) {
            this.zIndexStack.splice(index, 1);
        }
        this.zIndexStack.push(widget);
        this.updateZIndices();
    }

    /**
     * Update z-indices for all widgets in stack
     */
    updateZIndices() {
        this.zIndexStack.forEach((widget, i) => {
            if (widget.container) {
                // Skip modal widgets - they use fixed CSS z-index (above backdrop)
                if (widget.type === 'modal') return;
                widget.container.style.zIndex = String(this.baseZIndex + i * 10);
            }
        });
    }

    // ==================== Widget Operations ====================

    /**
     * Close all widgets (global + current session)
     */
    closeAll() {
        this.globalWidgets.forEach(widget => widget.close());
        const sessionMap = this.sessionWidgets.get(this.currentSessionId);
        if (sessionMap) sessionMap.forEach(widget => widget.close());
    }

    /**
     * Destroy a widget by ID
     * @param {string} id
     */
    destroy(id) {
        const widget = this._resolve(id);
        if (widget) {
            widget.destroy();
            this._remove(id);

            const stackIndex = this.zIndexStack.indexOf(widget);
            if (stackIndex > -1) {
                this.zIndexStack.splice(stackIndex, 1);
            }
        }
    }

    /**
     * Destroy all widgets
     */
    destroyAll() {
        this._forEachWidget(widget => widget.destroy());
        this.globalWidgets.clear();
        this.sessionWidgets.clear();
        this.zIndexStack = [];
    }

    /**
     * Toggle a widget (open if closed, close if open)
     * @param {string} id
     */
    toggle(id) {
        const widget = this.get(id);
        if (widget) {
            widget.toggle();
            if (widget.isVisible) {
                this.bringToFront(widget);
            }
        }
    }

    /**
     * Open a widget
     * @param {string} id
     * @param {object} context - Optional context to pass to render()
     */
    open(id, context) {
        // NOTE: No console.log here - causes infinite loop with debug-logs widget!
        const widget = this.get(id);
        if (widget) {
            // Store context for render
            if (context) {
                widget._openContext = context;
            }
            widget.open();
            // Re-render when context is provided (context is consumed by render)
            if (context) {
                widget.render();
            }
            this.bringToFront(widget);
        }
    }

    /**
     * Close a widget
     * @param {string} id
     */
    close(id) {
        // Don't use this.get() here - don't create widget just to close it
        const widget = this._resolve(id);
        if (widget) {
            widget.close();
        }
    }

    /**
     * Update/re-render a widget's content
     * @param {string} id
     */
    update(id) {
        // NOTE: No console.log here - causes infinite loop with debug-logs widget!
        const widget = this.get(id);  // Use this.get() to auto-create if needed
        if (widget) {
            widget.render();
        }
    }

    /**
     * Check if a widget is currently open
     * @param {string} id
     * @returns {boolean}
     */
    isOpen(id) {
        const widget = this._resolve(id);
        return widget ? widget.isVisible : false;
    }

    /**
     * Check if a widget is not just logically open but actually on screen.
     *
     * switchSession() hides a session's widgets with an inline display:none
     * while leaving isVisible true, so isOpen() alone reports "open" for a
     * widget the user cannot see. Same display test getVisibleWidgets() uses.
     * This is the right primitive for UI that mirrors widget state (rail
     * highlighting, toggles) — isOpen() stays the logical-state question.
     * @param {string} id
     * @returns {boolean}
     */
    isShowing(id) {
        const widget = this._resolve(id);
        return !!(widget && widget.isVisible && widget.container &&
                  widget.container.style.display !== 'none');
    }

    /**
     * Get all visible widgets sorted by z-index (topmost first)
     * Only returns widgets whose containers are actually displayed (not session-hidden)
     * @returns {import('./base-widget.js').BaseWidget[]}
     */
    getVisibleWidgets() {
        return this.zIndexStack.filter(w =>
            w.isVisible && w.container && w.container.style.display !== 'none'
        ).reverse();
    }

    /**
     * Close the topmost visible widget
     * Used for ESC key handling - close widgets before stopping Claude
     * @param {Object} options
     * @param {boolean} options.allowTerminalPassthrough - If true (default), don't close if
     *        user is focused in terminal (for ESC to pass through to vim/nano).
     *        Set to false for Ctrl+W which should always close the terminal.
     * @returns {boolean} True if a widget was closed, false if none were open
     */
    closeTopmost(options = {}) {
        const { allowTerminalPassthrough = true } = options;
        const visible = this.getVisibleWidgets();
        if (visible.length === 0) return false;

        const topmost = visible[0];
        const activeEl = document.activeElement;

        // Don't close if user is focused inside a terminal within this widget
        // Terminal needs ESC for vim, nano, escape sequences, etc.
        // But Ctrl+W should always close (allowTerminalPassthrough: false)
        if (allowTerminalPassthrough && activeEl && topmost.container?.contains(activeEl)) {
            const inTerminal = activeEl.closest('.xterm') ||
                              activeEl.closest('.terminal-widget-xterm');
            if (inTerminal) {
                return false;  // Let ESC pass through to terminal
            }
        }

        const closed = topmost.close();
        return closed !== false;  // beforeClose can prevent close
    }

    /**
     * Check if any widget is currently visible (and not session-hidden)
     * @returns {boolean}
     */
    hasVisibleWidgets() {
        return this.zIndexStack.some(w =>
            w.isVisible && w.container && w.container.style.display !== 'none'
        );
    }

    // ==================== Transform ====================

    /**
     * Transform a widget to a different type
     * This properly destroys the old widget and creates a new one with the correct class
     * @param {string} id - Widget ID
     * @param {string} newType - New widget type
     * @param {Object} options - Additional options
     * @returns {import('./base-widget.js').BaseWidget} The new widget
     */
    transform(id, newType, options = {}) {
        const oldWidget = this._resolve(id);
        if (!oldWidget) {
            console.warn(`[WidgetManager] Cannot transform: widget ${id} not found`);
            return null;
        }

        const config = this.configs.get(id);
        if (!config) {
            console.warn(`[WidgetManager] Cannot transform: config for ${id} not found`);
            return null;
        }

        const oldType = oldWidget.type;

        // 1. Capture state from old widget
        const snapshot = {
            sessionId: oldWidget.sessionId,
            cwd: oldWidget.cwd,
            ownerSessionId: oldWidget._ownerSessionId,
            scrollTop: oldWidget.contentContainer?.scrollTop || 0,
            wasVisible: oldWidget.isVisible,
            previousState: oldWidget.state,
            previousType: oldType,
            previousPosition: oldWidget.getPosition?.() || null,
            previousDimensions: oldWidget.getDimensions?.() || null
        };

        // 2. Remove old widget from z-index stack
        const stackIndex = this.zIndexStack.indexOf(oldWidget);
        if (stackIndex > -1) {
            this.zIndexStack.splice(stackIndex, 1);
        }

        // 3. Destroy old widget (removes from DOM)
        oldWidget.destroy();
        this._remove(id);

        // 4. Create new widget with the new type
        const finalConfig = {
            ...config,
            ...options,
            type: newType,
            _transformSnapshot: snapshot,
            _previousType: oldType
        };

        const WidgetClass = getWidgetClass(newType);
        const newWidget = new WidgetClass(id, finalConfig);

        // Preserve session ownership across transform
        if (snapshot.ownerSessionId) {
            newWidget._ownerSessionId = snapshot.ownerSessionId;
        }

        // Store in correct map
        this._store(id, newWidget);

        // Initialize (creates container and base DOM)
        newWidget.init();

        // 5. Restore session and cwd
        if (snapshot.sessionId) {
            newWidget.sessionId = snapshot.sessionId;
            newWidget.cwd = snapshot.cwd;
        }

        // 6. Store previous type for popBack
        newWidget._previousType = oldType;
        newWidget._previousPosition = snapshot.previousPosition;
        newWidget._previousDimensions = snapshot.previousDimensions;

        // 7. Add to z-index stack and bring to front
        this.zIndexStack.push(newWidget);
        this.updateZIndices();

        // 8. Restore visibility state (only open if was previously visible)
        if (snapshot.wasVisible) {
            if (newType === 'tab') {
                newWidget.open();
            } else {
                newWidget.setState('visible');
            }
        }

        // 9. Re-render content
        newWidget.render();

        // 10. Restore scroll position after render
        if (newWidget.contentContainer && snapshot.scrollTop) {
            requestAnimationFrame(() => {
                newWidget.contentContainer.scrollTop = snapshot.scrollTop;
            });
        }

        // 11. Emit transform event
        WidgetBus.emit('widget:transformed', {
            widgetId: id,
            from: oldType,
            to: newType
        });

        debug.log(`[WidgetManager] Transformed ${id}: ${oldType} → ${newType}`);

        return newWidget;
    }
}

// Global singleton
export const WidgetManager = new WidgetManagerClass();

// Also export class for testing
export { WidgetManagerClass };
