/**
 * TabWidget - Full view integrated into tab bar
 *
 * States: inactive → active
 * Takes full content area when active
 * Managed by TabManager for switching
 */

import { BaseWidget } from '../base-widget.js';
import { WidgetBus } from '../event-bus.js';

export class TabWidget extends BaseWidget {
    constructor(id, config) {
        super(id, config);

        // Tab-specific config
        this.tabTitle = config.tabTitle || config.title;
        this.tabIcon = config.tabIcon || config.icon;
        this.closable = config.closable !== false;

        // Reference to tab element in tab bar
        this.tabElement = null;
    }

    init() {
        super.init();

        // Tab widgets render into a view container, not body
        this.container.classList.add('widget-tab-view');

        // Create tab element for tab bar
        this.tabElement = this.createTabElement();

        // Emit event for TabManager to pick up
        WidgetBus.emit('tab:created', {
            widgetId: this.id,
            tabElement: this.tabElement,
            container: this.container
        });
    }

    /**
     * Create the tab element for the tab bar
     */
    createTabElement() {
        const tab = document.createElement('div');
        tab.className = 'widget-tab-btn';
        tab.dataset.widgetId = this.id;

        // Icon
        if (this.tabIcon) {
            const icon = document.createElement('span');
            icon.className = 'widget-tab-icon';
            icon.innerHTML = this.config.icon ? `<span class="icon">${this.config.icon}</span>` : '';
            tab.appendChild(icon);
        }

        // Title
        const title = document.createElement('span');
        title.className = 'widget-tab-title';
        title.textContent = this.tabTitle;
        tab.appendChild(title);

        // Close button
        if (this.closable) {
            const closeBtn = document.createElement('button');
            closeBtn.className = 'widget-tab-close';
            closeBtn.innerHTML = '×';
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.close();
            });
            tab.appendChild(closeBtn);
        }

        // Click to activate
        tab.addEventListener('click', () => this.activate());

        return tab;
    }

    /**
     * Activate this tab (bring to front)
     */
    activate() {
        this.setState('active');
        WidgetBus.emit('tab:activated', { widgetId: this.id });
    }

    /**
     * Deactivate this tab
     */
    deactivate() {
        this.setState('inactive');
    }

    setState(newState) {
        super.setState(newState);

        // Update tab element class
        if (this.tabElement) {
            this.tabElement.classList.toggle('widget-tab-active', newState === 'active');
        }

        // Update container visibility
        if (this.container) {
            this.container.classList.toggle('widget-tab-visible', newState === 'active');
        }
    }

    open() {
        this.activate();
    }

    close() {
        // For tabs, close means remove the tab
        WidgetBus.emit('tab:closed', { widgetId: this.id });
        this.destroy();
    }

    /**
     * Update tab title
     */
    setTitle(title) {
        this.tabTitle = title;
        const titleEl = this.tabElement?.querySelector('.widget-tab-title');
        if (titleEl) {
            titleEl.textContent = title;
        }
    }

    /**
     * Mark tab as dirty (unsaved changes)
     */
    setDirty(dirty) {
        this.tabElement?.classList.toggle('widget-tab-dirty', dirty);
    }

    destroy() {
        // Remove tab element
        this.tabElement?.remove();
        this.tabElement = null;

        super.destroy();
    }
}
