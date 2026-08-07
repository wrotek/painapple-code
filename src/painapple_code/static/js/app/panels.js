/**
 * Panel & widget toggle mixin — thin delegators that open/close/cycle the
 * various floating widgets, panels, and switchers from keyboard shortcuts,
 * rail buttons, and quick actions. Applied to App.prototype via Object.assign
 * in app.js; every method uses `this` (App instance) and the imports below.
 */
import { WidgetManager, WidgetBus } from '../widget-system/init.js';
import { QuickSwitcher } from '../quick-switcher/index.js';
import { OpenDialog } from '../open-dialog.js';
import { QuickActionsRegistry } from '../quick-actions-registry.js';
import { QuickActionsMenu } from '../widgets/index.js';
import { bgTaskTracker } from '../background-tasks.js';
import { effortSettings } from '../effort-settings.js';

export const panelMethods = {
    toggleFileExplorer() {
        this.fileExplorer?.toggle();
    },

    toggleSearchFiles() {
        WidgetManager.toggle('search-files');
    },

    toggleQuickSwitcher() {
        QuickSwitcher.toggle();
    },

    // Command palette — same picker as the quick switcher, opened straight
    // into command mode via the '>' prefix (VS Code / Cursor / Zed idiom).
    // Pressing again while open just hides (toggle semantics).
    openCommandPalette() {
        if (QuickSwitcher.isOpen()) QuickSwitcher.hide();
        else QuickSwitcher.show('>');
    },

    toggleOpenDialog() {
        OpenDialog.toggle();
    },

    toggleGridSwitcher() {
        this.gridSwitcher?.toggle();
    },

    /**
     * Cycle through cards in the grid switcher. If the grid is closed, opens it.
     * If already open, advances focus by `direction` (+1 forward, -1 backward).
     * Wired to Alt+Tab (forward) and Alt+Shift+Tab (backward).
     */
    cycleGridSwitcher(direction = 1) {
        if (!this.gridSwitcher) return;
        if (this.gridSwitcher.visible) {
            this.gridSwitcher.advance(direction);
        } else {
            // Mac/Windows app-switcher feel: open with the next session
            // pre-selected (skipping the currently-active one) and commit
            // on Alt-release.
            this.gridSwitcher.show({
                commitOnAltRelease: true,
                initialDirection: direction,
            });
        }
    },

    toggleLogExplorer() {
        WidgetManager.toggle('log-explorer');
    },

    toggleGitPanel() {
        WidgetManager.toggle('git');
    },

    toggleActiveSessions() {
        WidgetManager.toggle('active-sessions');
    },

    toggleCostAnalytics() {
        WidgetManager.toggle('cost-analytics');
    },

    toggleDiscussion() {
        WidgetManager.toggle('discussion');
    },

    toggleDebugConsole() {
        WidgetManager.toggle('debug-logs');
    },

    toggleEruda() {
        QuickActionsRegistry.execute('eruda');
    },

    toggleHistoryExplorer() {
        WidgetManager.toggle('history-explorer');
    },

    togglePromptExplorer() {
        WidgetManager.toggle('prompt-explorer');
    },

    // Bank the current input as a server-side draft (Ctrl+Shift+S).
    // Retrieval lives in the Prompt Explorer's Drafts tab.
    savePromptDraft() {
        this.inputHandler?.saveAsDraft();
    },

    // Explicit reload so Cmd+R works in the iOS/PWA standalone wrapper,
    // where there's no browser chrome to handle it natively. In a normal
    // browser this is equivalent to the native reload; Cmd+Shift+R (hard
    // reload) is a different key and still passes through.
    reloadPage() {
        window.location.reload();
    },

    toggleSkills() {
        WidgetManager.toggle('skills');
    },

    toggleCommands() {
        WidgetManager.toggle('commands');
    },

    async togglePreviewInlineEdit() {
        // Find file-preview container — could be floating widget OR a tab
        const container = document.querySelector('.file-preview-widget');
        if (!container) return;

        // Use module namespace (not destructuring) so state is the live binding
        // — activateState(tabId) reassigns the module-level state variable
        const mod = await import('../preview/preview-state.js');

        if (mod.state.viewMode === 'code' && mod.isEditable()) {
            // Code view → enter edit mode, capturing visible line for scroll restoration
            const scrollContainer = container.querySelector('.preview-body');
            if (scrollContainer) {
                const scrollTop = scrollContainer.scrollTop;
                const lineRows = scrollContainer.querySelectorAll('.preview-line');
                for (const row of lineRows) {
                    const rowTop = row.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top + scrollTop;
                    if (rowTop + row.offsetHeight > scrollTop) {
                        mod.state.scrollToLine = parseInt(row.dataset.line, 10);
                        mod.state.scrollOptions = { flash: false, position: 'center' };
                        break;
                    }
                }
            }
            const { switchToEditView } = await import('../preview/preview-edit.js');
            switchToEditView();
        } else if (mod.isEditMode()) {
            // Edit mode → leave to code view (leaveEditView captures cursor line)
            const { leaveEditView } = await import('../preview/preview-edit.js');
            leaveEditView('code');
        } else {
            // Rendered/other view → toggle inline edit
            const { toggleInlineEdit } = await import('../preview/preview-inline-edit.js');
            toggleInlineEdit(container);
        }
    },

    toggleBackgroundTasks() {
        WidgetManager.toggle('background-tasks');
    },

    toggleBrowser() {
        WidgetManager.toggle('browser');
    },

    toggleZenMode() {
        window.toggleZenMode?.();
    },

    openBackgroundTask(taskId) {
        WidgetManager.open('background-tasks');
        WidgetBus.emit('background-task:focus', { taskId });
    },

    _updateBgTasksBadge() {
        const badge = document.getElementById('tasks-badge');
        if (!badge) return;
        const running = bgTaskTracker.runningCount();
        badge.textContent = running > 0 ? running : '';
    },

    /**
     * Update the running agents header badge.
     * Called from session._handleTaskProgress / _onAgentCompleted.
     */
    updateAgentsBadge(count) {
        const badge = document.getElementById('agents-badge');
        if (!badge) return;
        badge.textContent = count > 0 ? count : '';
    },

    toggleThinkingSettings() {
        effortSettings.cycle();
    },

    cycleEffortOneShot() {
        effortSettings.cycleOneShot();
    },


    toggleQuickActions() {
        QuickActionsMenu.toggle();
    },
};
