/**
 * Widgets - Application widgets using the widget system
 *
 * This module registers all application widgets with WidgetManager.
 * Import and call initWidgets() during app initialization.
 */

import { registerGitWidget, GitWidget } from './git-widget.js';
import { registerTerminalWidget, TerminalWidget } from './terminal-widget.js';
import { registerConfigWidget } from './config-widget.js';
import { registerLogExplorerWidget, openLogExplorer, closeLogExplorer } from './log-explorer-widget.js';
import { registerFileExplorerWidget, FileExplorerWidget } from './file-explorer-widget.js';
import { registerSearchFilesWidget, SearchFilesWidget } from './search-files-widget.js';
import { registerFilePreviewWidget, FilePreviewWidget } from './file-preview-widget.js';
import { registerImagePreviewWidget, ImagePreviewWidget } from './image-preview-widget.js';
import { registerImageAnnotateWidget, ImageAnnotateWidget, openImageAnnotator, isImageAnnotatorOpen, handleAnnotatorEscape } from './image-annotate-widget.js';
import { registerHistoryExplorerWidget, HistoryExplorerWidget } from './history-explorer-widget.js';
import { registerActiveSessionsWidget, activeSessionsState, startGlobalPoll } from './active-sessions-widget.js';
import { registerCostAnalyticsWidget } from './cost-analytics-widget.js';
import { registerDiscussionWidget, addToQueue as addDiscussionToQueue, startThread as startDiscussionThread, sendThreadReply as sendDiscussionReply } from './discussion-widget.js';
import { registerDebugWidget, DebugWidget } from './debug-widget.js';
import { registerPromptExplorerWidget, PromptExplorerWidget } from './prompt-explorer-widget.js';
import { registerSkillsWidget, SkillsWidget } from './skills-widget.js';
import { registerCommandsWidget, CommandsWidget } from './commands-widget.js';
import { registerUploadsWidget, UploadsWidget } from './uploads-widget.js';
import { registerTasksWidget } from './tasks-widget.js';
import { registerSubAgentsWidget } from './sub-agents-widget.js';
import { registerAgentsWidget } from './agents-widget.js';
import { registerPluginsWidget, PluginsWidget } from './plugins-widget.js';
import { registerSnippetsWidget, SnippetsWidget } from './snippets-widget.js';
import { registerDiffViewerWidget, DiffViewerWidget } from './diff-viewer-widget.js';
import { registerZenWidget, openZen, closeZen, toggleZen, isZenOpen } from './zen-widget.js';
import { registerHelpersInstallWidget, HelpersInstallWidget } from './helpers-install-widget.js';
import { registerBrowserWidget, BrowserWidget } from './browser-widget.js';
import { registerAboutWidget, AboutWidget } from './about-widget.js';
import { initQuickActionsMenu, quickActionsMenu } from '../quick-actions-menu.js';
import { debug } from '../config.js';

/**
 * Initialize all widgets
 * Call this after WidgetManager is set up
 */
export function initWidgets() {
    // Register all widgets
    registerGitWidget();
    registerTerminalWidget();
    registerConfigWidget();
    registerLogExplorerWidget();
    registerFileExplorerWidget();
    registerSearchFilesWidget();
    registerFilePreviewWidget();
    registerImagePreviewWidget();
    registerImageAnnotateWidget();
    registerHistoryExplorerWidget();
    registerActiveSessionsWidget();
    registerCostAnalyticsWidget();
    registerDiscussionWidget();
    registerDebugWidget();
    registerPromptExplorerWidget();
    registerSkillsWidget();
    registerCommandsWidget();
    registerUploadsWidget();
    registerTasksWidget();
    registerSubAgentsWidget();
    registerAgentsWidget();
    registerPluginsWidget();
    registerSnippetsWidget();
    registerDiffViewerWidget();
    registerZenWidget();
    registerHelpersInstallWidget();
    registerBrowserWidget();
    registerAboutWidget();

    // Initialize quick actions menu (radial FAB, replaces old debug FAB)
    initQuickActionsMenu();

    // Start global background poll for process state sync (tab status indicators)
    startGlobalPoll();

    debug.log('[Widgets] Initialized');
}

// Re-export config widget utilities for app.js compatibility
export {
    loadUserConfig,
    saveUserConfig,
    applyLayout,
    LAYOUT_MODES,
    getConfigState,
    toggleConfigPanel,
    showConfigPanel,
    hideConfigPanel,
    isAnnotateOnPasteEnabled
} from './config-widget.js';

// Export individual widget APIs for external access
export { GitWidget, TerminalWidget, FileExplorerWidget, SearchFilesWidget, FilePreviewWidget, ImagePreviewWidget, HistoryExplorerWidget, DiffViewerWidget };

// Image Annotate widget API
export { ImageAnnotateWidget, openImageAnnotator, isImageAnnotatorOpen, handleAnnotatorEscape };

// Log Explorer widget API
export const LogExplorerWidget = {
    open: openLogExplorer,
    close: closeLogExplorer
};

// Active Sessions widget API
export const ActiveSessionsWidget = {
    getState: () => activeSessionsState,
    startGlobalPoll
};

// Discussion widget API
export const DiscussionWidget = {
    addToQueue: addDiscussionToQueue,
    startThread: startDiscussionThread,
    sendReply: sendDiscussionReply
};

// Debug widget API (also exposed as window.debugLog)
export { DebugWidget };

// About widget API (opened from the help modal and the quick-actions palette)
export { AboutWidget };

// Prompt Explorer widget API
export { PromptExplorerWidget };

// Skills Manager widget API
export { SkillsWidget };

// Commands Manager widget API
export { CommandsWidget };

// Uploads widget API
export { UploadsWidget };

// Zen Mode API
export const ZenMode = {
    open: openZen,
    close: closeZen,
    toggle: toggleZen,
    get isOpen() { return isZenOpen(); },
};

// Helpers Install widget API
export { HelpersInstallWidget };

// Snippets widget API
export { SnippetsWidget };

// Plugins widget API
export { PluginsWidget };

// Browser widget API
export { BrowserWidget };

// Quick Actions Menu API
export const QuickActionsMenu = {
    open: () => quickActionsMenu.open(),
    close: () => quickActionsMenu.close(),
    toggle: () => quickActionsMenu.toggle(),
    openAtPosition: (x, y) => quickActionsMenu.openAtPosition(x, y),
    setConfig: (config) => quickActionsMenu.setConfig(config),
    getConfig: () => quickActionsMenu.getConfig(),
    applyPreset: (presetId) => quickActionsMenu.applyPreset(presetId),
    setVisibility: (mode) => quickActionsMenu.setVisibility(mode),
    getVisibility: () => quickActionsMenu.getVisibility(),
    resetPosition: () => quickActionsMenu.resetPosition(),
    // State checks for ESC handling
    get isOpen() { return quickActionsMenu.isOpen; },
    get isContextMenuOpen() { return quickActionsMenu.isContextMenuOpen; },
    closeContextMenu: () => quickActionsMenu.closeContextMenu()
};
