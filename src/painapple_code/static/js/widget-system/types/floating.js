/**
 * FloatingWidget - Draggable, resizable window
 *
 * States: hidden → visible → maximized
 * Can be positioned anywhere, dragged by header, resized from corners
 */

import { BaseWidget } from '../base-widget.js';
import { WidgetBus } from '../event-bus.js';
import { ICONS } from '../icons.js';
import S from '../../strings.js';

export class FloatingWidget extends BaseWidget {
    /** Gap from the viewport edge when spawning at the default position */
    static SPAWN_MARGIN = 20;
    /** Distance from the top when spawning (clears the header/tab strip) */
    static SPAWN_TOP = 60;
    /** Gap left of the window when it spawns beside the chat column.
     *  Wide enough to clear the tool gutter icons that float in the column's
     *  right margin (24px icon sitting ~32px past the content edge). */
    static COLUMN_GAP = 64;

    constructor(id, config) {
        super(id, config);

        // Size first — the default spawn position is derived from the width.
        this.size = config.size || { width: 700, height: 500 };

        // Default spawn: top of the screen, just right of the chat column, so
        // the newest message stays visible. A widget can still pin its own
        // position via config.position; once the user drags/snaps the window,
        // _userPositioned freezes it there.
        this._userPositioned = !!config.position;
        this.position = config.position ? { ...config.position } : this._defaultPosition();
        this.minSize = config.minSize || { width: 200, height: 150 };
        // Upper bound is a RATIO of the viewport, not a fixed size: constrainToViewport()
        // recomputes maxSize on every rotation/split-view change, so a one-shot
        // config.maxSize would be silently clobbered. Widgets override the ratio instead.
        // Default 1.0 = a widget may be resized edge-to-edge (applyResize keeps it on-screen).
        this.maxSizeRatio = config.maxSizeRatio || { width: 1, height: 1 };
        this.maxSize = this._viewportMaxSize();

        // State before maximize
        this._preMaximizeState = null;

        // Default size for comfort zoom toggle (config size = the widget's intended default)
        this._defaultSize = { ...(config.size || { width: 700, height: 500 }) };
        this._isComfortZoomed = false;

        // Drag state
        this.isDragging = false;
        this.dragStartX = 0;
        this.dragStartY = 0;
        this.dragStartPosX = 0;
        this.dragStartPosY = 0;

        // Resize state
        this.isResizing = false;
        this.resizeDirection = null;

        // Snap preview
        this.snapTarget = null;
    }

    /**
     * Remember whether the position was user-chosen, so a persisted record
     * can tell "the user parked it here" from "it auto-spawned top-right".
     */
    persistExtras() {
        return { userPositioned: this._userPositioned };
    }

    /**
     * Default spawn position — top of the screen, immediately right of the
     * chat column, so the newest message stays visible.
     *
     * The chat column is left-aligned and capped at a fixed width, so on a
     * wide display it does NOT reach the right edge: pinning the window to
     * that edge would strand it a screenful away from the conversation.
     * Instead we sit just past the column and only fall back to the right
     * edge when there isn't room for that (the usual case on laptop widths).
     *
     * Computed from the live viewport/DOM so it stays correct across
     * rotation and split-view changes.
     */
    _defaultPosition() {
        const margin = FloatingWidget.SPAWN_MARGIN;
        const vw = window.innerWidth || 1024;

        // Furthest right the window can sit and still be fully on-screen
        const rightEdgeX = Math.max(margin, vw - this.size.width - margin);

        // #input-wrapper spans exactly the chat column, so its right edge is
        // the column's right edge — no need to duplicate the width from CSS.
        const column = document.getElementById('input-wrapper');
        const columnRight = column ? column.getBoundingClientRect().right : 0;
        const besideColumnX = columnRight + FloatingWidget.COLUMN_GAP;

        // Hug the column, but never push the window off-screen
        const x = columnRight > 0
            ? Math.min(rightEdgeX, Math.max(margin, besideColumnX))
            : rightEdgeX;

        return { x, y: FloatingWidget.SPAWN_TOP };
    }

    init() {
        super.init();

        // Add floating-specific class
        this.container.classList.add('widget-floating-window');

        // Make container focusable so Escape key works to close it
        this.container.setAttribute('tabindex', '-1');

        // Set initial position and size
        this.updatePosition();
        this.updateSize();

        // Attach drag and resize handlers
        this.attachDragHandler();
        this.attachResizeHandlers();

        // Add visibility scope selector to header
        this._addScopeSelector();

        // Click to bring to front
        this.container.addEventListener('mousedown', () => this.bringToFront());

        // Double-click header to toggle comfort zoom
        if (this.headerEl) {
            this.headerEl.addEventListener('dblclick', (e) => {
                if (e.target.closest('button')) return;
                this.comfortZoom();
            });
        }

        // Re-constrain on viewport changes (iPad app switch, rotation, split view).
        // IMPORTANT: Skip resize events while page is hidden — iOS fires resize with
        // shrunken app-switcher dimensions, which would corrupt widget position/size.
        this._onViewportChange = () => {
            if (document.visibilityState !== 'hidden') {
                this.constrainToViewport();
            }
        };
        window.addEventListener('resize', this._onViewportChange);

        // Save/restore position across background — iOS can corrupt fixed-position
        // element layout during app switch transitions.
        this._savedLayout = null;
        this._onVisibilityChange = () => {
            if (document.visibilityState === 'hidden' && this.isVisible) {
                // Snapshot known-good position/size before iOS corrupts it
                this._savedLayout = {
                    position: { ...this.position },
                    size: { ...this.size }
                };
            } else if (document.visibilityState === 'visible' && this.isVisible) {
                if (this._savedLayout) {
                    this.position = this._savedLayout.position;
                    this.size = this._savedLayout.size;
                    this._savedLayout = null;
                }
                this.updatePosition();
                this.updateSize();
                // Delay — iOS needs time to finalize viewport dimensions
                setTimeout(() => this.constrainToViewport(), 150);
            }
        };
        document.addEventListener('visibilitychange', this._onVisibilityChange);

        // Contain wheel events within the widget — prevent scroll from leaking
        // through position:fixed to the app behind (Safari/iPadOS quirk).
        this.container.addEventListener('wheel', (e) => {
            // Walk up from target to find the nearest vertically-scrollable ancestor
            let el = e.target;
            while (el && el !== this.container) {
                const style = window.getComputedStyle(el);
                const oy = style.overflowY;
                if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
                    const { scrollTop, scrollHeight, clientHeight } = el;
                    const atTop = scrollTop <= 0 && e.deltaY < 0;
                    const atBottom = scrollTop >= scrollHeight - clientHeight - 1 && e.deltaY > 0;
                    if (!atTop && !atBottom) return; // within bounds — let it scroll normally
                    break; // at boundary — fall through to preventDefault
                }
                el = el.parentElement;
            }
            // At boundary or no scrollable container — block to prevent leak
            e.preventDefault();
        }, { passive: false });
    }

    // ==================== Visibility Scope Selector ====================

    /** Scope definitions with colors */
    static SCOPES = [
        { id: 'session',      color: 'var(--text-secondary)' },
        { id: 'project',      color: '#4a9eff' },
        { id: 'all-sessions', color: '#f5a623' },
        { id: 'global',       color: '#7ed321' },
    ];

    /**
     * Add visibility scope selector button to the floating header
     */
    _addScopeSelector() {
        if (!this.headerEl) return;
        const actionsEl = this.headerEl.querySelector('.widget-actions');
        if (!actionsEl) return;

        // Create scope button (inserted at the beginning of actions)
        const btn = document.createElement('button');
        btn.className = 'widget-header-btn widget-scope-btn';
        btn.setAttribute('data-tooltip', S.widgets.header_actions.visibility);
        btn.innerHTML = ICONS.eye;
        this._scopeBtn = btn;

        // Add colored dot indicator
        const dot = document.createElement('span');
        dot.className = 'widget-scope-dot';
        btn.appendChild(dot);
        this._scopeDot = dot;

        // Update dot color to match current scope
        this._updateScopeDot();

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleScopeDropdown();
        });

        // Insert before the first existing button (transform/close)
        actionsEl.insertBefore(btn, actionsEl.firstChild);
    }

    /**
     * Update the scope dot color to reflect current visibility scope
     */
    _updateScopeDot() {
        if (!this._scopeDot) return;
        const scope = this.getEffectiveVisibilityScope();
        const def = FloatingWidget.SCOPES.find(s => s.id === scope);
        this._scopeDot.style.background = def?.color || 'var(--text-secondary)';
    }

    /**
     * Toggle the scope dropdown open/closed
     */
    _toggleScopeDropdown() {
        if (this._scopeDropdown) {
            this._closeScopeDropdown();
            return;
        }
        this._openScopeDropdown();
    }

    /**
     * Open the scope selector dropdown
     */
    _openScopeDropdown() {
        const dropdown = document.createElement('div');
        dropdown.className = 'widget-scope-dropdown';
        this._scopeDropdown = dropdown;

        const currentScope = this.getEffectiveVisibilityScope();
        const ss = S.widgets.visibility_scope;

        FloatingWidget.SCOPES.forEach(({ id, color }) => {
            const option = document.createElement('div');
            option.className = 'widget-scope-option';
            if (id === currentScope) option.classList.add('active');

            const dot = document.createElement('span');
            dot.className = 'widget-scope-option-dot';
            dot.style.background = color;

            const text = document.createElement('div');
            text.className = 'widget-scope-option-text';

            const label = document.createElement('div');
            label.className = 'widget-scope-option-label';
            label.textContent = ss[id.replace('-', '_')] || id;

            const desc = document.createElement('div');
            desc.className = 'widget-scope-option-desc';
            desc.textContent = ss[id.replace('-', '_') + '_desc'] || '';

            text.appendChild(label);
            text.appendChild(desc);
            option.appendChild(dot);
            option.appendChild(text);

            option.addEventListener('click', (e) => {
                e.stopPropagation();
                this._setVisibilityScope(id);
                this._closeScopeDropdown();
            });

            dropdown.appendChild(option);
        });

        // Position relative to scope button
        if (this._scopeBtn) {
            this._scopeBtn.style.position = 'relative';
            this._scopeBtn.appendChild(dropdown);
        }

        // Close on click outside (next tick to avoid immediate close)
        requestAnimationFrame(() => {
            this._scopeOutsideHandler = (e) => {
                if (!dropdown.contains(e.target) && e.target !== this._scopeBtn) {
                    this._closeScopeDropdown();
                }
            };
            document.addEventListener('pointerdown', this._scopeOutsideHandler, true);
        });
    }

    /**
     * Close the scope dropdown
     */
    _closeScopeDropdown() {
        if (this._scopeDropdown) {
            this._scopeDropdown.remove();
            this._scopeDropdown = null;
        }
        if (this._scopeOutsideHandler) {
            document.removeEventListener('pointerdown', this._scopeOutsideHandler, true);
            this._scopeOutsideHandler = null;
        }
    }

    /**
     * Set the visibility scope and persist
     */
    _setVisibilityScope(scope) {
        this.visibilityScope = scope === 'session' ? null : scope;
        this._updateScopeDot();
        this.persistState();
        WidgetBus.emit('widget:scope-changed', {
            widgetId: this.id,
            scope: this.getEffectiveVisibilityScope(),
            ownerSessionId: this._ownerSessionId
        });
    }

    /**
     * Override to restore position and size from persisted state
     */
    restorePersistedState() {
        super.restorePersistedState();

        if (this._persistedState) {
            // Restore dimensions first (position constraining depends on size)
            if (this._persistedState.dimensions &&
                typeof this._persistedState.dimensions.width === 'number' &&
                typeof this._persistedState.dimensions.height === 'number') {
                this.size = {
                    width: Math.max(this.minSize.width, Math.min(this.maxSize.width, this._persistedState.dimensions.width)),
                    height: Math.max(this.minSize.height, Math.min(this.maxSize.height, this._persistedState.dimensions.height))
                };
            }

            // Restore position if saved — but only when the user actually
            // chose it. persistState() also fires for resize/scope changes, so
            // an auto-placed window would otherwise freeze at whatever the
            // top-right edge was on the previous run. (Records written before
            // this flag existed have it undefined → honoured, as before.)
            if (this._persistedState.userPositioned !== false &&
                this._persistedState.position &&
                typeof this._persistedState.position.x === 'number' &&
                typeof this._persistedState.position.y === 'number') {
                this.position = { ...this._persistedState.position };
                this._userPositioned = true;
                // Ensure still visible on screen after restore
                this.constrainPosition();
            }
        }
    }

    /**
     * Attach drag handler to header
     */
    attachDragHandler() {
        if (!this.headerEl) return;

        const onStart = (e) => {
            // Don't drag if clicking buttons or resize handles
            if (e.target.closest('button') || e.target.closest('.widget-resize-handle')) return;

            e.preventDefault();
            this.isDragging = true;
            // The user owns the position from here on — no more auto top-right
            this._userPositioned = true;
            this.dragStartX = e.touches?.[0]?.clientX ?? e.clientX;
            this.dragStartY = e.touches?.[0]?.clientY ?? e.clientY;
            this.dragStartPosX = this.position.x;
            this.dragStartPosY = this.position.y;

            this.container.classList.add('widget-dragging');
            document.body.style.userSelect = 'none';
            document.body.style.webkitUserSelect = 'none';
            document.addEventListener('mousemove', onMove, { passive: false });
            document.addEventListener('mouseup', onEnd);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
            document.addEventListener('touchcancel', onEnd);
        };

        const onMove = (e) => {
            if (!this.isDragging) return;
            e.preventDefault();

            const currentX = e.touches?.[0]?.clientX ?? e.clientX;
            const currentY = e.touches?.[0]?.clientY ?? e.clientY;

            this.position.x = this.dragStartPosX + (currentX - this.dragStartX);
            this.position.y = this.dragStartPosY + (currentY - this.dragStartY);

            // Keep within viewport
            this.constrainPosition();
            this.updatePosition();

            // Check for snap zones
            this.checkSnapZones(currentX, currentY);
        };

        const onEnd = () => {
            if (!this.isDragging) return;
            this.isDragging = false;

            this.container.classList.remove('widget-dragging');
            document.body.style.userSelect = '';
            document.body.style.webkitUserSelect = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
            document.removeEventListener('touchcancel', onEnd);

            // Apply snap if in snap zone
            if (this.snapTarget) {
                this.applySnap(this.snapTarget);
                this.hideSnapPreview();
            }

            // Persist position so it's restored on reload
            if (this.config.persistState !== false) {
                this.persistState();
            }
        };

        this.headerEl.addEventListener('mousedown', onStart);
        this.headerEl.addEventListener('touchstart', onStart, { passive: false });

        // Store handlers for cleanup
        this._dragHandler = { onStart, onMove, onEnd };
    }

    /**
     * Attach resize handlers to corners and edges
     */
    attachResizeHandlers() {
        if (this.config.resizable === false) return;

        const directions = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

        directions.forEach(dir => {
            const handle = document.createElement('div');
            handle.className = `widget-resize-handle widget-resize-${dir}`;

            const onStart = (e) => {
                e.preventDefault();
                e.stopPropagation();

                this.isResizing = true;
                // Resizing from a n/w edge moves the window too — treat the
                // resulting spot as user-chosen so open() won't re-anchor it.
                this._userPositioned = true;
                this.resizeDirection = dir;
                this.dragStartX = e.touches?.[0]?.clientX ?? e.clientX;
                this.dragStartY = e.touches?.[0]?.clientY ?? e.clientY;
                this._startSize = { ...this.size };
                this._startPos = { ...this.position };

                this.container.classList.add('widget-resizing');
                document.body.style.userSelect = 'none';
                document.body.style.webkitUserSelect = 'none';
                document.addEventListener('mousemove', onMove, { passive: false });
                document.addEventListener('mouseup', onEnd);
                document.addEventListener('touchmove', onMove, { passive: false });
                document.addEventListener('touchend', onEnd);
                document.addEventListener('touchcancel', onEnd);
            };

            const onMove = (e) => {
                if (!this.isResizing) return;
                e.preventDefault();

                const currentX = e.touches?.[0]?.clientX ?? e.clientX;
                const currentY = e.touches?.[0]?.clientY ?? e.clientY;
                const deltaX = currentX - this.dragStartX;
                const deltaY = currentY - this.dragStartY;

                this.applyResize(this.resizeDirection, deltaX, deltaY);
            };

            const onEnd = () => {
                if (!this.isResizing) return;
                this.isResizing = false;
                this.resizeDirection = null;

                this.container.classList.remove('widget-resizing');
                document.body.style.userSelect = '';
                document.body.style.webkitUserSelect = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onEnd);
                document.removeEventListener('touchmove', onMove);
                document.removeEventListener('touchend', onEnd);
                document.removeEventListener('touchcancel', onEnd);

                this.config.onResize?.(this.getDimensions());

                // Persist dimensions so restorePersistedState() has correct values on reload
                if (this.config.persistState !== false) {
                    this.persistState();
                }
            };

            handle.addEventListener('mousedown', onStart);
            handle.addEventListener('touchstart', onStart, { passive: false });

            this.container.appendChild(handle);
        });
    }

    /**
     * Apply resize based on direction
     */
    applyResize(dir, deltaX, deltaY) {
        let newWidth = this._startSize.width;
        let newHeight = this._startSize.height;
        let newX = this._startPos.x;
        let newY = this._startPos.y;

        // East (right edge)
        if (dir.includes('e')) {
            newWidth = this._startSize.width + deltaX;
        }
        // West (left edge)
        if (dir.includes('w')) {
            newWidth = this._startSize.width - deltaX;
            newX = this._startPos.x + deltaX;
        }
        // South (bottom edge)
        if (dir.includes('s')) {
            newHeight = this._startSize.height + deltaY;
        }
        // North (top edge)
        if (dir.includes('n')) {
            newHeight = this._startSize.height - deltaY;
            newY = this._startPos.y + deltaY;
        }

        // Apply constraints. Growing an edge stops AT the viewport border rather than
        // running off-screen, so a widget can be dragged out to fill the whole viewport
        // but never past it (the opposite edge stays anchored where the user left it).
        let maxW = this.maxSize.width;
        let maxH = this.maxSize.height;
        if (dir.includes('e')) maxW = Math.min(maxW, window.innerWidth - this._startPos.x);
        if (dir.includes('w')) maxW = Math.min(maxW, this._startPos.x + this._startSize.width);
        if (dir.includes('s')) maxH = Math.min(maxH, window.innerHeight - this._startPos.y);
        if (dir.includes('n')) maxH = Math.min(maxH, this._startPos.y + this._startSize.height);

        newWidth = Math.max(this.minSize.width, Math.min(maxW, newWidth));
        newHeight = Math.max(this.minSize.height, Math.min(maxH, newHeight));

        // West/north grow leftward/upward — recompute the moving edge after clamping
        if (dir.includes('w')) newX = this._startPos.x + this._startSize.width - newWidth;
        if (dir.includes('n')) newY = this._startPos.y + this._startSize.height - newHeight;

        // Update if changed
        if (newWidth !== this._startSize.width || newHeight !== this._startSize.height) {
            this.size = { width: newWidth, height: newHeight };
            this.position = { x: newX, y: newY };
            this.constrainPosition();
            this.updatePosition();
            this.updateSize();
        }
    }

    /**
     * Largest size this widget may take in the CURRENT viewport.
     * Recomputed on demand — never cached across viewport changes.
     */
    _viewportMaxSize() {
        return {
            width: window.innerWidth * this.maxSizeRatio.width,
            height: window.innerHeight * this.maxSizeRatio.height
        };
    }

    /**
     * Keep window within viewport bounds
     * Ensures meaningful portion of window stays visible
     */
    constrainPosition() {
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        // Horizontal: keep at least 100px visible on each side
        const hMargin = Math.min(100, this.size.width * 0.3);
        this.position.x = Math.max(-this.size.width + hMargin, Math.min(vw - hMargin, this.position.x));

        // Vertical: keep at least 200px or 40% of window height visible
        // This prevents the window from being pushed mostly off the bottom
        const minVisibleHeight = Math.min(200, this.size.height * 0.4);
        this.position.y = Math.max(0, Math.min(vh - minVisibleHeight, this.position.y));
    }

    /**
     * Full viewport re-constraint: update maxSize, clamp size, then constrain position.
     * Called on window resize and visibilitychange (iPad app switch, rotation, split view).
     */
    constrainToViewport() {
        if (!this.isVisible) return;

        // Update maxSize to current viewport
        this.maxSize = this._viewportMaxSize();

        // Clamp size to new maxSize
        this.size.width = Math.max(this.minSize.width, Math.min(this.maxSize.width, this.size.width));
        this.size.height = Math.max(this.minSize.height, Math.min(this.maxSize.height, this.size.height));

        this.constrainPosition();

        // Always force-update CSS — iOS may clear/modify inline style vars during background
        this.updatePosition();
        this.updateSize();
    }

    /**
     * Update CSS position
     */
    updatePosition() {
        if (!this.container) return;
        this.container.style.setProperty('--widget-x', `${this.position.x}px`);
        this.container.style.setProperty('--widget-y', `${this.position.y}px`);
    }

    /**
     * Update CSS size
     */
    updateSize() {
        if (!this.container) return;
        this.container.style.setProperty('--widget-width', `${this.size.width}px`);
        this.container.style.setProperty('--widget-height', `${this.size.height}px`);
    }

    /**
     * Check if dragging near screen edges (snap zones)
     */
    checkSnapZones(x, y) {
        const threshold = 30;
        const width = window.innerWidth;
        const height = window.innerHeight;

        let snap = null;

        if (x < threshold) snap = 'left';
        else if (x > width - threshold) snap = 'right';
        else if (y < threshold) snap = 'top';
        else if (y > height - threshold) snap = 'bottom';

        if (snap !== this.snapTarget) {
            if (this.snapTarget) this.hideSnapPreview();
            this.snapTarget = snap;
            if (snap) this.showSnapPreview(snap);
        }
    }

    /**
     * Show snap preview overlay
     */
    showSnapPreview(edge) {
        document.body.classList.add(`widget-snap-preview-${edge}`);
    }

    /**
     * Hide snap preview
     */
    hideSnapPreview() {
        document.body.classList.remove(
            'widget-snap-preview-left',
            'widget-snap-preview-right',
            'widget-snap-preview-top',
            'widget-snap-preview-bottom'
        );
        this.snapTarget = null;
    }

    /**
     * Apply snap to edge
     */
    applySnap(edge) {
        const width = window.innerWidth;
        const height = window.innerHeight;

        switch (edge) {
            case 'left':
                this.position = { x: 0, y: 0 };
                this.size = { width: width / 2, height: height };
                break;
            case 'right':
                this.position = { x: width / 2, y: 0 };
                this.size = { width: width / 2, height: height };
                break;
            case 'top':
                this.maximize();
                return;
            case 'bottom':
                this.position = { x: 0, y: height / 2 };
                this.size = { width: width, height: height / 2 };
                break;
        }

        this.updatePosition();
        this.updateSize();
    }

    /**
     * Bring this window to front
     */
    bringToFront() {
        WidgetBus.emit('widget:focus', { widgetId: this.id });
    }

    /**
     * Maximize the window
     */
    maximize() {
        if (this.state === 'maximized') {
            this.restore();
            return;
        }

        // Save current state
        this._preMaximizeState = {
            position: { ...this.position },
            size: { ...this.size }
        };

        this.position = { x: 0, y: 0 };
        this.size = { width: window.innerWidth, height: window.innerHeight };
        this.updatePosition();
        this.updateSize();
        this.setState('maximized');
    }

    /**
     * Restore from maximized
     */
    restore() {
        if (this._preMaximizeState) {
            this.position = this._preMaximizeState.position;
            this.size = this._preMaximizeState.size;
            this._preMaximizeState = null;
        }
        this.updatePosition();
        this.updateSize();
        this.setState('visible');
    }

    /**
     * Toggle between default size and comfort zoom (~85% viewport)
     * Double-click header triggers this.
     * Always uses two fixed sizes - ignores whatever manual resize state you're in.
     */
    comfortZoom() {
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        // Explicit user placement — don't re-anchor to top-right on next open
        this._userPositioned = true;

        if (this._isComfortZoomed) {
            // Back to default size, centered
            this.size = { ...this._defaultSize };
            this.position = {
                x: Math.round((vw - this.size.width) / 2),
                y: Math.round((vh - this.size.height) / 2)
            };
            this._isComfortZoomed = false;
        } else {
            // Zoom to 85% viewport, centered
            const zoomW = Math.round(vw * 0.85);
            const zoomH = Math.round(vh * 0.85);
            this.size = { width: zoomW, height: zoomH };
            this.position = {
                x: Math.round((vw - zoomW) / 2),
                y: Math.round((vh - zoomH) / 2)
            };
            this._isComfortZoomed = true;
        }

        this.constrainPosition();
        this.updatePosition();
        this.updateSize();
        this.config.onResize?.(this.getDimensions());
    }

    open() {
        // Still parked where it spawned? Re-anchor to the top-right — the
        // viewport may have resized/rotated since the widget was constructed.
        if (!this._userPositioned) {
            this.position = this._defaultPosition();
        }
        // Re-validate position against current viewport (may have changed since init)
        this.constrainPosition();
        this.updatePosition();
        this.setState('visible');

        // Focus the widget container so Escape key closes it
        // (pulls focus from terminal/other elements so shortcut system works)
        // Skip if onOpen already focused something inside this widget
        if (!this.container.contains(document.activeElement)) {
            this.container.focus();
        }
    }

    close() {
        // Force cleanup of any lingering drag/resize state
        // This ensures document-level event handlers are removed even if
        // touch was interrupted without proper touchend/touchcancel
        this.cleanupGestureHandlers();

        // Release focus if it's inside the widget (or on the widget's
        // iframe element itself, which is the case when the user clicked
        // on rendered HTML and `document.activeElement` is the IFRAME).
        // WKWebView/Tauri otherwise keeps targeting wheel events at the
        // last-focused element even after visibility:hidden — clicking
        // anywhere else "fixes" it for the user, but blurring on close
        // is the proper fix. Move focus to body so the next wheel event
        // gets a fresh hit-test against the visible chat behind.
        const active = document.activeElement;
        if (active && this.container?.contains(active)) {
            // .blur() naturally moves focus to <body>, which is what we want.
            try { active.blur(); } catch (_) {}
        }

        this.setState('hidden');
    }

    /**
     * Clean up any lingering document-level gesture handlers
     * Called on close to prevent scroll blocking after widget closes
     */
    cleanupGestureHandlers() {
        // Clean up drag state
        if (this.isDragging && this._dragHandler) {
            this.isDragging = false;
            this.container?.classList.remove('widget-dragging');
            document.removeEventListener('mousemove', this._dragHandler.onMove);
            document.removeEventListener('mouseup', this._dragHandler.onEnd);
            document.removeEventListener('touchmove', this._dragHandler.onMove);
            document.removeEventListener('touchend', this._dragHandler.onEnd);
            document.removeEventListener('touchcancel', this._dragHandler.onEnd);
        }

        // Clean up resize state
        if (this.isResizing) {
            this.isResizing = false;
            this.resizeDirection = null;
            this.container?.classList.remove('widget-resizing');
        }

        // Always clear body user-select override
        document.body.style.userSelect = '';
        document.body.style.webkitUserSelect = '';

        // Clean up snap preview if visible
        this.hideSnapPreview();
    }

    /**
     * Override toggleState to disable header click toggle for floating widgets
     * Floating widgets should only be closed via close button or ESC
     */
    toggleState() {
        // No-op: floating widgets don't toggle on header click
    }

    getDimensions() {
        return { ...this.size };
    }

    getPosition() {
        return { ...this.position };
    }

    destroy() {
        // Clean up scope dropdown if open
        this._closeScopeDropdown();

        // Remove floating-specific listeners before base cleanup
        if (this._onViewportChange) {
            window.removeEventListener('resize', this._onViewportChange);
        }
        if (this._onVisibilityChange) {
            document.removeEventListener('visibilitychange', this._onVisibilityChange);
        }
        super.destroy();
    }
}
