/**
 * Widget Types - Export all widget type implementations
 */

// Import all widget classes
import { BottomSheetWidget } from './bottom-sheet.js';
import { TopSheetWidget } from './top-sheet.js';
import { SidebarWidget } from './sidebar.js';
import { FloatingWidget } from './floating.js';
import { TabWidget } from './tab.js';
import { ModalWidget } from './modal.js';

// Re-export for external use
export { BottomSheetWidget, TopSheetWidget, SidebarWidget, FloatingWidget, TabWidget, ModalWidget };

/**
 * Map of type name to widget class (for lazy loading)
 */
export const WIDGET_TYPES = {
    'bottom-sheet': BottomSheetWidget,
    'top-sheet': TopSheetWidget,
    'sidebar-left': SidebarWidget,
    'sidebar-right': SidebarWidget,
    'floating': FloatingWidget,
    'tab': TabWidget,
    'modal': ModalWidget,
};

/**
 * Get widget class for type
 * @param {string} type
 * @returns {typeof import('../base-widget.js').BaseWidget}
 */
export function getWidgetClass(type) {
    const WidgetClass = WIDGET_TYPES[type];
    if (!WidgetClass) {
        throw new Error(`Unknown widget type: ${type}`);
    }
    return WidgetClass;
}
