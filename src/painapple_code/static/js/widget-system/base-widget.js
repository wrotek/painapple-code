/**
 * BaseWidget - Core widget class with transform support
 *
 * All widget types extend this class. Provides:
 * - State management
 * - Transform between types (bottom-sheet ↔ floating ↔ tab ↔ sidebar)
 * - Header rendering with actions
 * - Event emission via WidgetBus
 * - Session awareness (global widgets) and session ownership (session-scoped widgets)
 */

import { WidgetBus } from './event-bus.js';
import { ICONS } from './icons.js';
import S from '../strings.js';

/**
 * Widget types
 * @typedef {'bottom-sheet' | 'top-sheet' | 'sidebar-left' | 'sidebar-right' | 'floating' | 'tab' | 'modal' | 'drawer'} WidgetType
 */

/**
 * @typedef {Object} WidgetConfig
 * @property {string} id - Unique widget identifier
 * @property {WidgetType} type - Widget display type
 * @property {string} title - Display title
 * @property {string} icon - Icon name from ICONS
 * @property {string} [shortcut] - Keyboard shortcut
 * @property {string} [defaultState] - Initial state
 * @property {number} [zIndex] - Base z-index
 * @property {Object} [heights] - Heights for bottom-sheet { half, full }
 * @property {string} [width] - Width for sidebar/floating
 * @property {string} [minWidth] - Minimum width
 * @property {string} [maxWidth] - Maximum width
 * @property {boolean} [closable=true] - Show close button
 * @property {boolean} [resizable=false] - Allow resize
 * @property {boolean} [draggable=false] - Allow drag (floating)
 * @property {boolean} [sessionAware=true] - Update on session change (global widgets only)
 * @property {'session'|'global'} [scope='session'] - Widget scope
 * @property {boolean} [persistState=true] - Save state to localStorage
 * @property {boolean} [allowTransform=true] - Allow type transforms
 * @property {WidgetType[]} [allowedTypes] - Types this widget can transform to
 * @property {Array<{icon: string, title: string, onClick: Function}>} [headerActions] - Custom header buttons
 * @property {boolean} [hideHeader=false] - Hide the header completely
 * @property {Function} render - (container, context) => void
 * @property {Function} [onOpen] - Called when widget opens
 * @property {Function} [onClose] - Called when widget closes
 * @property {Function} [onStateChange] - (newState, oldState) => void
 * @property {Function} [onSessionChange] - (sessionId) => void
 * @property {Function} [onResize] - ({ width, height }) => void
 * @property {Function} [onTransform] - (fromType, toType) => void
 * @property {Function} [onDestroy] - (sessionId) => void - cleanup for session widgets
 */

export class BaseWidget {
    /**
     * @param {string} id
     * @param {WidgetConfig} config
     */
    constructor(id, config) {
        this.id = id;
        this.config = config;
        this.type = config.type;
        this.state = config.defaultState || 'collapsed';
        this.container = null;
        this.contentContainer = null;
        this.headerEl = null;
        this.sessionId = null;
        this.isVisible = false;

        // Session ownership: set by WidgetManager for session-scoped widgets.
        // null for global widgets. This is the session this widget belongs to.
        this._ownerSessionId = null;

        // Visibility scope override (null = default based on registered scope).
        // Set by user via floating widget scope selector.
        this.visibilityScope = null;

        // CWD at time of widget creation (for 'project' visibility scope comparison).
        this._ownerCwd = null;

        // Transform history
        this._previousType = null;
        this._previousPosition = null;
        this._previousDimensions = null;

        // Gesture state (for subclasses)
        this.isDragging = false;
        this.dragStartX = 0;
        this.dragStartY = 0;

        // Bound event handlers (for cleanup)
        this._boundHandlers = new Map();
    }

    /**
     * Initialize the widget - create DOM and attach events
     */
    init() {
        this.createContainer();
        this.attachBaseEvents();

        // Restore persisted state
        if (this.config.persistState !== false) {
            this.restorePersistedState();
        }

        // Emit created event
        WidgetBus.emit('widget:created', { widgetId: this.id, type: this.type });
    }

    /**
     * Create the widget container and structure
     */
    createContainer() {
        this.container = document.createElement('div');

        // Use unique DOM ID for session-scoped widgets to avoid collisions
        const domId = this._ownerSessionId
            ? `widget-${this.id}-${this._ownerSessionId}`
            : `widget-${this.id}`;
        this.container.id = domId;

        this.container.className = `widget widget-${this.type}`;
        this.container.dataset.widgetId = this.id;
        this.container.dataset.widgetType = this.type;

        // Tag session-scoped widgets with their owner session
        if (this._ownerSessionId) {
            this.container.dataset.ownerSession = this._ownerSessionId;
        }

        // Build structure
        if (!this.config.hideHeader) {
            this.headerEl = this.createHeader();
            this.container.appendChild(this.headerEl);
        }

        // Content wrapper (preserves content during transforms)
        const contentWrapper = document.createElement('div');
        contentWrapper.className = 'widget-content-wrapper';

        this.contentContainer = document.createElement('div');
        this.contentContainer.className = 'widget-content';

        contentWrapper.appendChild(this.contentContainer);
        this.container.appendChild(contentWrapper);

        document.body.appendChild(this.container);

        // Initial state class
        this.updateStateClass();
    }

    /**
     * Create the header element
     * @returns {HTMLElement}
     */
    createHeader() {
        const header = document.createElement('div');
        header.className = 'widget-header';

        // Drag handle (for bottom-sheet, floating)
        const dragHandle = document.createElement('div');
        dragHandle.className = 'widget-drag-handle';
        header.appendChild(dragHandle);

        // Icon
        if (this.config.icon) {
            const iconEl = document.createElement('span');
            iconEl.className = 'widget-title-icon';
            iconEl.innerHTML = ICONS[this.config.icon] || ICONS.file;
            header.appendChild(iconEl);
        }

        // Title
        const titleEl = document.createElement('span');
        titleEl.className = 'widget-title';
        titleEl.textContent = this.config.title;
        header.appendChild(titleEl);

        // Summary slot (for showing counts, status, etc.)
        const summaryEl = document.createElement('span');
        summaryEl.className = 'widget-summary';
        header.appendChild(summaryEl);

        // Spacer
        const spacer = document.createElement('div');
        spacer.className = 'widget-header-spacer';
        header.appendChild(spacer);

        // Actions container
        const actionsEl = document.createElement('div');
        actionsEl.className = 'widget-actions';

        // Custom header actions
        if (this.config.headerActions) {
            this.config.headerActions.forEach(action => {
                const btn = this.createHeaderButton(action.icon, action.title, action.onClick);
                actionsEl.appendChild(btn);
            });
        }

        // Transform actions (if allowed)
        if (this.config.allowTransform !== false) {
            this.addTransformActions(actionsEl);
        }

        // Refresh button (common)
        if (this.config.onRefresh) {
            const refreshBtn = this.createHeaderButton('refresh', 'Refresh', () => this.config.onRefresh());
            actionsEl.appendChild(refreshBtn);
        }

        // Close button
        if (this.config.closable !== false) {
            const closeBtn = this.createHeaderButton('close', 'Close', () => this.close());
            closeBtn.classList.add('widget-close');
            actionsEl.appendChild(closeBtn);
        }

        header.appendChild(actionsEl);

        return header;
    }

    /**
     * Create a header button
     */
    createHeaderButton(icon, title, onClick) {
        const btn = document.createElement('button');
        btn.className = 'widget-header-btn';
        btn.setAttribute('data-tooltip', title);
        btn.innerHTML = ICONS[icon] || icon;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick(e);
        });
        return btn;
    }

    /**
     * Add transform action buttons based on current type
     */
    addTransformActions(container) {
        const actions = this.getTransformActions();
        actions.forEach(action => {
            const btn = this.createHeaderButton(action.icon, action.title, action.onClick);
            btn.classList.add('widget-transform-btn');
            container.appendChild(btn);
        });
    }

    /**
     * Get available transform actions for current type
     */
    getTransformActions() {
        const actions = [];
        const allowed = this.config.allowedTypes || ['bottom-sheet', 'sidebar-left', 'floating', 'tab'];

        // From bottom-sheet, top-sheet, or floating -> can open as a real tab in the app's tab bar
        if ((this.type === 'bottom-sheet' || this.type === 'top-sheet' || this.type === 'floating') && allowed.includes('tab')) {
            actions.push({
                icon: 'maximize',
                title: S.widgets.header_actions.open_in_tab,
                onClick: (e) => this.openAsTab(e)
            });
        }

        // From floating -> can dock to sidebar
        if (this.type === 'floating' && allowed.includes('sidebar-left')) {
            actions.push({
                icon: 'sidebar',
                title: S.widgets.header_actions.dock_to_side,
                onClick: () => this.transformTo('sidebar-left')
            });
        }

        // From sidebar -> can pop out to floating
        if ((this.type === 'sidebar-left' || this.type === 'sidebar-right') && allowed.includes('floating')) {
            actions.push({
                icon: 'popout',
                title: S.widgets.header_actions.undock,
                onClick: () => this.transformTo('floating')
            });
        }

        return actions;
    }

    /**
     * Attach base event listeners
     */
    attachBaseEvents() {
        // Header click to toggle (for bottom-sheet mainly)
        if (this.headerEl) {
            const headerClickHandler = (e) => {
                // Don't toggle if clicking a button
                if (e.target.closest('button')) return;
                this.toggleState();
            };
            this.headerEl.addEventListener('click', headerClickHandler);
            this._boundHandlers.set('headerClick', headerClickHandler);
        }

        // Session change listener — only for GLOBAL widgets that are session-aware.
        // Session-scoped widgets belong to a fixed session and don't need this.
        if (this.config.scope === 'global' && this.config.sessionAware !== false) {
            const sessionHandler = ({ sessionId }) => {
                this.setSession(sessionId);
            };
            WidgetBus.on('session:changed', sessionHandler);
            this._boundHandlers.set('sessionChange', sessionHandler);
        }
    }

    /**
     * Render the widget content
     */
    render() {
        if (!this.config.render) return;

        const context = {
            sessionId: this.sessionId,
            cwd: this.getCwd(),
            state: this.state,
            type: this.type,
            dimensions: this.getDimensions(),
            emit: (event, data) => WidgetBus.emit(event, data),
            on: (event, handler) => WidgetBus.on(event, handler),
            setSummary: (text) => this.setSummary(text),
            setSummaryHTML: (html) => this.setSummaryHTML(html),
            setLoading: (loading) => this.setLoading(loading),
            setError: (error) => this.setError(error),
            // Merge in any context passed via WidgetManager.open(id, context)
            ...this._openContext
        };

        // Clear one-time context after use
        this._openContext = null;

        this.config.render(this.contentContainer, context);
    }

    // ==================== State Management ====================

    /**
     * Open the widget
     */
    open() {
        // Both bottom-sheet and top-sheet use 'half' state
        const newState = (this.type === 'bottom-sheet' || this.type === 'top-sheet') ? 'half' : 'visible';
        this.setState(newState);
    }

    /**
     * Close the widget
     * @returns {boolean} false if close was prevented by beforeClose
     */
    close() {
        // Allow widget to prevent close (e.g., unsaved changes confirmation)
        if (this.config.beforeClose && this.config.beforeClose() === false) {
            return false;
        }
        this.setState('collapsed');
        return true;
    }

    /**
     * Toggle between open/closed
     */
    toggle() {
        if (this.state === 'collapsed' || this.state === 'hidden') {
            this.open();
        } else {
            this.close();
        }
    }

    /**
     * Toggle between states (for bottom-sheet: collapsed -> half -> full)
     */
    toggleState() {
        if (this.type === 'bottom-sheet') {
            const states = ['collapsed', 'half', 'full'];
            const currentIndex = states.indexOf(this.state);
            const nextIndex = (currentIndex + 1) % states.length;
            this.setState(states[nextIndex]);
        } else {
            this.toggle();
        }
    }

    /**
     * Set widget state
     * @param {string} newState
     */
    setState(newState) {
        const oldState = this.state;
        if (oldState === newState) return;

        this.state = newState;
        this.isVisible = newState !== 'collapsed' && newState !== 'hidden';

        this.updateStateClass();

        // Clear inline display:none that setSessionWidgetsVisible / switchSession
        // may have applied. Without this, the inline style wins over the
        // widget-visible CSS class and the widget stays hidden after open().
        if (this.isVisible && this.container) {
            this.container.style.display = '';
            if (this._backdrop) this._backdrop.style.display = '';
        }

        // Callbacks
        this.config.onStateChange?.(newState, oldState);

        // Events
        if (this.isVisible && (oldState === 'collapsed' || oldState === 'hidden')) {
            this.config.onOpen?.();
            WidgetBus.emit('widget:opened', { widgetId: this.id, type: this.type, state: newState });
        } else if (!this.isVisible) {
            this.config.onClose?.();
            WidgetBus.emit('widget:closed', { widgetId: this.id });
        }

        // Persist state
        if (this.config.persistState !== false) {
            this.persistState();
        }
    }

    /**
     * Update CSS classes based on state
     */
    updateStateClass() {
        if (!this.container) return;

        // Remove all state classes
        this.container.classList.remove(
            'widget-collapsed', 'widget-hidden',
            'widget-half', 'widget-full',
            'widget-visible', 'widget-open',
            'widget-active', 'widget-inactive'
        );

        // Add current state class
        this.container.classList.add(`widget-${this.state}`);
    }

    // ==================== Transform System ====================

    /**
     * Check if widget can transform to given type
     * @param {WidgetType} type
     * @returns {boolean}
     */
    canTransformTo(type) {
        if (this.config.allowTransform === false) return false;
        if (this.type === type) return false;

        // Modal cannot transform
        if (this.type === 'modal') return false;
        if (type === 'modal') return false;

        // Check allowed types
        const allowed = this.config.allowedTypes || ['bottom-sheet', 'sidebar-left', 'sidebar-right', 'floating', 'tab'];
        return allowed.includes(type);
    }

    /**
     * Transform widget to a different type while preserving content
     * Delegates to WidgetManager via event bus to properly recreate with correct class
     * @param {WidgetType} newType
     * @param {Object} options
     */
    transformTo(newType, options = {}) {
        if (!this.canTransformTo(newType)) {
            console.warn(`[Widget] Cannot transform ${this.id} from ${this.type} to ${newType}`);
            return;
        }

        // Delegate to WidgetManager via event bus
        // This avoids circular dependency and ensures proper widget class instantiation
        WidgetBus.emit('widget:transform-request', {
            widgetId: this.id,
            newType,
            options
        });
    }

    /**
     * Transform back to previous type
     */
    popBack() {
        if (this._previousType && this.canTransformTo(this._previousType)) {
            this.transformTo(this._previousType);
        }
    }

    /**
     * Open this widget as a tab in the app's main tab bar
     * This closes the overlay widget and opens the content as a real tab
     */
    openAsTab(e) {
        const background = e && (e.metaKey || e.ctrlKey);
        if (this.config.onOpenAsTab) {
            this.config.onOpenAsTab({ background });
            return;
        }
        WidgetBus.emit('widget:open-as-tab', {
            widgetId: this.id,
            title: this.config.title || this.id,
            icon: this.config.icon || 'layers',
            background
        });
    }

    // ==================== Session Management ====================

    /**
     * Set the current session (for global widgets responding to session switches)
     * @param {string} sessionId
     */
    setSession(sessionId) {
        const oldSessionId = this.sessionId;
        this.sessionId = sessionId;

        if (oldSessionId !== sessionId) {
            this.config.onSessionChange?.(sessionId);
            this.render();
        }
    }

    /**
     * Get current working directory
     */
    getCwd() {
        return this.cwd || null;
    }

    /**
     * Get effective visibility scope for this widget.
     * Returns the user override if set, otherwise 'session' (default for all floating widgets).
     * @returns {'session'|'project'|'all-sessions'|'global'}
     */
    getEffectiveVisibilityScope() {
        return this.visibilityScope || 'session';
    }

    // ==================== UI Helpers ====================

    /**
     * Set summary text in header
     * @param {string} text
     */
    setSummary(text) {
        const summaryEl = this.headerEl?.querySelector('.widget-summary');
        if (summaryEl) {
            summaryEl.textContent = text;
        }
    }

    /**
     * Set summary HTML in header (for rich content like badges)
     * @param {string} html
     */
    setSummaryHTML(html) {
        const summaryEl = this.headerEl?.querySelector('.widget-summary');
        if (summaryEl) {
            summaryEl.innerHTML = html;
        }
    }

    /**
     * Show/hide loading state
     * @param {boolean} loading
     */
    setLoading(loading) {
        this.container?.classList.toggle('widget-loading', loading);
    }

    /**
     * Show error state
     * @param {string|null} error
     */
    setError(error) {
        this.container?.classList.toggle('widget-error', !!error);
        // Could also display error message in content
    }

    // ==================== Dimensions ====================

    /**
     * Get widget dimensions
     * @returns {{ width: number, height: number }}
     */
    getDimensions() {
        if (!this.container) return { width: 0, height: 0 };
        return {
            width: this.container.offsetWidth,
            height: this.container.offsetHeight
        };
    }

    /**
     * Get widget position
     * @returns {{ x: number, y: number }}
     */
    getPosition() {
        if (!this.container) return { x: 0, y: 0 };
        const rect = this.container.getBoundingClientRect();
        return { x: rect.left, y: rect.top };
    }

    // ==================== Persistence ====================

    /**
     * Get storage key for this widget.
     * Session-scoped widgets include their owner session ID for per-session persistence.
     */
    getStorageKey() {
        if (this._ownerSessionId) {
            return `widget-${this.id}-${this._ownerSessionId}-state`;
        }
        return `widget-${this.id}-state`;
    }

    /**
     * Persist current state
     */
    persistState() {
        try {
            const data = {
                state: this.state,
                type: this.type,
                position: this.getPosition(),
                dimensions: this.getDimensions(),
                visibilityScope: this.visibilityScope,
                ...this.persistExtras()
            };
            localStorage.setItem(this.getStorageKey(), JSON.stringify(data));
        } catch (e) {
            // Storage might be full or unavailable
        }
    }

    /**
     * Extra fields a subclass wants merged into the persisted record.
     * @returns {Object}
     */
    persistExtras() {
        return {};
    }

    /**
     * Load persisted state from localStorage
     * @returns {Object|null} Persisted data or null
     */
    loadPersistedState() {
        try {
            const data = localStorage.getItem(this.getStorageKey());
            if (data) {
                return JSON.parse(data);
            }
        } catch (e) {
            // Invalid data
        }
        return null;
    }

    /**
     * Restore persisted state
     * Subclasses can override to restore position, size, etc.
     * Note: State (visible/collapsed) is NOT restored here -
     * that's handled by WidgetManager.restoreOpenWidgets()
     */
    restorePersistedState() {
        // Load data for subclasses to use
        this._persistedState = this.loadPersistedState();

        // Restore visibility scope override
        if (this._persistedState?.visibilityScope) {
            this.visibilityScope = this._persistedState.visibilityScope;
        }
    }

    // ==================== Lifecycle ====================

    /**
     * Destroy the widget
     */
    destroy() {
        // Remove event listeners
        this._boundHandlers.forEach((handler, key) => {
            if (key === 'sessionChange') {
                WidgetBus.off('session:changed', handler);
            }
        });
        this._boundHandlers.clear();

        // Remove from DOM
        this.container?.remove();
        this.container = null;
        this.contentContainer = null;
        this.headerEl = null;

        // Emit event
        WidgetBus.emit('widget:destroyed', { widgetId: this.id });
    }

    /**
     * Get widget config (for cloning/transforming)
     */
    getConfig() {
        return { ...this.config };
    }
}
