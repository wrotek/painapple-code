/**
 * Widget System Initialization
 *
 * Call initWidgetSystem() early in app startup to set up the widget system.
 */

import { WidgetManager, WidgetBus } from './index.js';
import { initWidgets, GitWidget, TerminalWidget, LogExplorerWidget, FileExplorerWidget, FilePreviewWidget, HistoryExplorerWidget, DiffViewerWidget } from '../widgets/index.js';
import { debug } from '../config.js';

/**
 * Initialize the widget system
 * @param {object} options
 * @param {string} options.sessionId - Current session ID
 * @param {string} options.cwd - Current working directory
 * @param {boolean} options.restoreOpenWidgets - Whether to restore previously open widgets (default: true)
 */
export function initWidgetSystem(options = {}) {
    // Set initial session if provided
    if (options.sessionId) {
        WidgetBus.emit('session:changed', {
            sessionId: options.sessionId,
            cwd: options.cwd
        });
    }

    // Initialize all application widgets
    initWidgets();

    // Restore previously open widgets (unless disabled)
    if (options.restoreOpenWidgets !== false) {
        // Defer restoration to next frame to ensure DOM is ready
        requestAnimationFrame(() => {
            WidgetManager.restoreOpenWidgets();
        });
    }

    debug.log('[WidgetSystem] Initialized');

    return {
        WidgetManager,
        WidgetBus,
        GitWidget,
        TerminalWidget,
        LogExplorerWidget,
        FileExplorerWidget,
        FilePreviewWidget,
        HistoryExplorerWidget,
        DiffViewerWidget
    };
}

// Export for direct access
export { WidgetManager, WidgetBus, GitWidget, TerminalWidget, LogExplorerWidget, FileExplorerWidget, FilePreviewWidget, HistoryExplorerWidget, DiffViewerWidget };
