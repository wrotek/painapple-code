/**
 * Widget System - Main entry point
 *
 * Usage:
 *
 * import { WidgetManager, WidgetBus } from './widget-system/index.js';
 *
 * // Register widgets
 * WidgetManager.register('files', {
 *     type: 'bottom-sheet',
 *     title: 'Files',
 *     icon: 'folder',
 *     shortcut: 'Alt+F',
 *     render: (container, ctx) => renderFileList(container, ctx),
 *     onSessionChange: (sessionId) => loadFiles(sessionId)
 * });
 *
 * // Create/get widget
 * const filesWidget = WidgetManager.get('files');
 * filesWidget.open();
 *
 * // Listen for events
 * WidgetBus.on('file:open', ({ path }) => openInEditor(path));
 *
 * // Transform widget type
 * filesWidget.transformTo('sidebar-left');
 */

// Core
export { WidgetBus, WidgetEventBus } from './event-bus.js';
export { DeviceManager, DeviceManagerClass } from './device-manager.js';
export { ICONS, getIcon, createIconElement } from './icons.js';

// Base widget
export { BaseWidget } from './base-widget.js';

// Widget types
export {
    BottomSheetWidget,
    SidebarWidget,
    FloatingWidget,
    TabWidget,
    ModalWidget,
    getWidgetClass,
    WIDGET_TYPES
} from './types/index.js';

// Manager
export { WidgetManager, WidgetManagerClass } from './widget-manager.js';
