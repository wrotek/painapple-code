/**
 * Quick Actions Registry
 *
 * Central registry for all quick actions available in the radial menu.
 * Actions are organized by category and include metadata for display,
 * execution handlers, and state checks.
 *
 * Each action has:
 * - id: Unique identifier
 * - icon: Feather icon name (or SVG path)
 * - label: Short display name
 * - description: Tooltip/help text
 * - category: Grouping for settings UI
 * - shortcut: Optional keyboard shortcut display
 * - execute: Function to run the action
 * - isEnabled: Optional function returning boolean
 * - isVisible: Optional function returning boolean
 * - badge: Optional function returning badge text/count
 */

import { WidgetManager } from './widget-system/index.js';
import { DebugWidget } from './widgets/debug-widget.js';
import { TerminalWidget } from './widgets/terminal-widget.js';
import { appConfirm, escapeHtml } from './utils.js';
import { copyToClipboard, showToast } from './context-menu.js';
import { OpenDialog } from './open-dialog.js';
import S from './strings.js';
import { debug } from './config.js';
import { engineInfo } from './status-bar.js';

// ─────────────────────────────────────────────────────────────────────────────
// Registry Class
// ─────────────────────────────────────────────────────────────────────────────

class QuickActionsRegistryClass {
    constructor() {
        this.actions = new Map();
        this.categories = new Map();
    }

    /**
     * Register an action
     */
    register(id, config) {
        const action = {
            id,
            icon: config.icon,
            label: config.label,
            description: config.description || config.label,
            shortcut: config.shortcut || null,
            category: config.category,
            keywords: config.keywords || [],
            execute: config.execute,
            isEnabled: config.isEnabled || (() => true),
            isVisible: config.isVisible || (() => true),
            badge: config.badge || null,
        };

        this.actions.set(id, action);

        // Track categories
        if (!this.categories.has(config.category)) {
            this.categories.set(config.category, []);
        }
        this.categories.get(config.category).push(action);

        return this;
    }

    /**
     * Unregister an action (used to re-sync user-defined custom actions)
     */
    unregister(id) {
        const action = this.actions.get(id);
        if (!action) return false;
        this.actions.delete(id);

        const list = this.categories.get(action.category);
        if (list) {
            const idx = list.indexOf(action);
            if (idx !== -1) list.splice(idx, 1);
            if (list.length === 0) this.categories.delete(action.category);
        }
        return true;
    }

    /**
     * Get an action by ID
     */
    get(id) {
        return this.actions.get(id);
    }

    /**
     * Get all actions in a category
     */
    getByCategory(category) {
        return this.categories.get(category) || [];
    }

    /**
     * Get all category names
     */
    getAllCategories() {
        return Array.from(this.categories.keys());
    }

    /**
     * Get all actions
     */
    getAll() {
        return Array.from(this.actions.values());
    }

    /**
     * Execute an action by ID
     */
    execute(id) {
        const action = this.actions.get(id);
        if (!action) {
            console.warn(`[QuickActions] Unknown action: ${id}`);
            return false;
        }

        if (!action.isEnabled()) {
            debug.log(`[QuickActions] Action disabled: ${id}`);
            return false;
        }

        try {
            action.execute();
            return true;
        } catch (err) {
            console.error(`[QuickActions] Error executing ${id}:`, err);
            return false;
        }
    }
}

// Singleton instance
export const QuickActionsRegistry = new QuickActionsRegistryClass();

// ─────────────────────────────────────────────────────────────────────────────
// Helper to get app instance
// ─────────────────────────────────────────────────────────────────────────────

function getApp() {
    return window.app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Category: Sessions & Tabs
// ─────────────────────────────────────────────────────────────────────────────

QuickActionsRegistry.register('new-session', {
    keywords: ['create', 'add', 'fresh', 'start', 'tab', 'launch'],
    icon: 'plus-circle',
    label: S.quick_actions_registry.actions.new_session.label,
    description: S.quick_actions_registry.actions.new_session.desc,
    shortcut: 'Ctrl+K',
    category: S.quick_actions_registry.categories.sessions,
    execute: () => getApp()?.createSession(),
    isEnabled: () => (getApp()?.sessionManager?.sessions?.length || 0) < 10,
});

QuickActionsRegistry.register('close-tab', {
    keywords: ['x', 'remove', 'kill', 'dismiss', 'shut'],
    icon: 'x',
    label: S.quick_actions_registry.actions.close_tab.label,
    description: S.quick_actions_registry.actions.close_tab.desc,
    shortcut: 'Escape',
    category: S.quick_actions_registry.categories.sessions,
    execute: () => {
        const app = getApp();
        if (!app) return;

        // First try to close topmost floating widget (like ESC key behavior)
        const { WidgetManager } = window;
        if (WidgetManager?.closeTopmost?.({ allowTerminalPassthrough: false })) {
            return; // Widget was closed, done
        }

        // No widgets open - close the current tab based on active mode
        if (app.activeMode === 'widget' && app.activeWidgetTabId) {
            app.closeWidgetTab(app.activeWidgetTabId);
        } else if (app.activeSession) {
            app.closeSession(app.activeSession);
        }
    },
    isEnabled: () => {
        const app = getApp();
        if (!app) return false;
        // Enable if there's any widget or tab to close
        const hasWidget = window.WidgetManager?.hasVisibleWidgets?.();
        return hasWidget ||
               app.activeWidgetTabId ||
               app.sessionManager?.sessions?.length > 0;
    },
});

QuickActionsRegistry.register('prev-tab', {
    keywords: ['back', 'left', 'before'],
    icon: 'chevron-left',
    label: S.quick_actions_registry.actions.prev_tab.label,
    description: S.quick_actions_registry.actions.prev_tab.desc,
    shortcut: 'Ctrl+[',
    category: S.quick_actions_registry.categories.sessions,
    execute: () => getApp()?.cycleTab(-1),
    isEnabled: () => (getApp()?.sessionManager?.sessions?.length || 0) > 1,
});

QuickActionsRegistry.register('next-tab', {
    keywords: ['forward', 'right', 'after'],
    icon: 'chevron-right',
    label: S.quick_actions_registry.actions.next_tab.label,
    description: S.quick_actions_registry.actions.next_tab.desc,
    shortcut: 'Ctrl+]',
    category: S.quick_actions_registry.categories.sessions,
    execute: () => getApp()?.cycleTab(1),
    isEnabled: () => (getApp()?.sessionManager?.sessions?.length || 0) > 1,
});

QuickActionsRegistry.register('fork-session', {
    keywords: ['branch', 'split', 'diverge'],
    icon: 'git-branch',
    label: S.quick_actions_registry.actions.fork_session.label,
    description: S.quick_actions_registry.actions.fork_session.desc,
    category: S.quick_actions_registry.categories.sessions,
    execute: () => getApp()?.forkSession?.(),
    // Hidden for engines that can't branch a conversation (capabilities.fork=false)
    isEnabled: () => getApp()?.activeSession?.messages?.length > 0
        && getApp()?.activeSession?.providerCaps?.fork !== false,
});

QuickActionsRegistry.register('clone-session', {
    keywords: ['duplicate', 'copy', 'same project'],
    icon: 'copy',
    label: S.quick_actions_registry.actions.clone_session.label,
    description: S.quick_actions_registry.actions.clone_session.desc,
    shortcut: 'Ctrl+Shift+M',
    category: S.quick_actions_registry.categories.sessions,
    execute: () => getApp()?.cloneSession?.(),
    isEnabled: () => getApp()?.activeSession?.cwd != null,
});

QuickActionsRegistry.register('continue-in-cli', {
    keywords: ['shell', 'bash', 'cli', 'resume terminal'],
    icon: 'terminal',
    label: S.quick_actions_registry.actions.continue_in_cli.label,
    description: S.quick_actions_registry.actions.continue_in_cli.desc,
    category: S.quick_actions_registry.categories.sessions,
    execute: async () => {
        const session = getApp()?.activeSession;
        if (!session?.providerSessionId) return;
        // Engine-self-described resume command (Claude "claude -r {id}", Codex
        // "codex exec resume {id}") — never hardcode an engine's resume verb.
        const engine = engineInfo(session.provider || session.pendingProvider);
        const tmpl = engine?.cli_resume_template || 'claude -r {id}';
        const cmd = tmpl.replace('{id}', session.providerSessionId);
        if (await copyToClipboard(cmd)) {
            const shown = tmpl.replace('{id}', session.providerSessionId.slice(0, 8) + '…');
            showToast(S.toast.cli_resume_copied.replace('{cmd}', shown));
        }
    },
    isEnabled: () => !!getApp()?.activeSession?.providerSessionId,
});

QuickActionsRegistry.register('new-draft', {
    keywords: ['scratch', 'note', 'draft', 'temp'],
    icon: 'edit',
    label: S.quick_actions_registry.actions.new_draft.label,
    description: S.quick_actions_registry.actions.new_draft.desc,
    shortcut: 'Ctrl+N',
    category: S.quick_actions_registry.categories.sessions,
    execute: () => getApp()?.createScratchTab(),
});

QuickActionsRegistry.register('toggle-favorite', {
    keywords: ['star', 'pin', 'bookmark', 'mark'],
    icon: 'star',
    label: S.quick_actions_registry.actions.toggle_favorite.label,
    description: S.quick_actions_registry.actions.toggle_favorite.desc,
    category: S.quick_actions_registry.categories.sessions,
    execute: async () => {
        const app = getApp();
        const session = app?.activeSession;
        if (!session?.storeId) return;

        // Dynamic import to avoid circular dependency
        const { toggleFavoriteSession } = await import('./welcome.js');
        const newState = await toggleFavoriteSession(session.storeId);

        // Show feedback
        
        if (newState === null) {
            showToast(S.errors.update_favorite);
        } else {
            showToast(newState ? S.toast.added_favorite : S.toast.removed_favorite);
        }
    },
    isEnabled: () => {
        const session = getApp()?.activeSession;
        return session?.storeId != null;
    },
    badge: () => {
        // Could show star if favorited, but checking synchronously is tricky
        // For now, no badge - the icon itself is a star
        return null;
    },
});

// ─────────────────────────────────────────────────────────────────────────────
// Category: Panels & Widgets
// ─────────────────────────────────────────────────────────────────────────────

QuickActionsRegistry.register('terminal', {
    keywords: ['shell', 'bash', 'console', 'cli', 'tty'],
    icon: 'terminal',
    label: S.quick_actions_registry.actions.terminal.label,
    description: S.quick_actions_registry.actions.terminal.desc,
    shortcut: 'Ctrl+`',
    category: S.quick_actions_registry.categories.panels,
    execute: () => getApp()?.toggleTerminalPanel(),
});

QuickActionsRegistry.register('new-terminal', {
    keywords: ['shell', 'console', 'pty', 'tty'],
    icon: 'plus-square',
    label: S.quick_actions_registry.actions.new_terminal.label,
    description: S.quick_actions_registry.actions.new_terminal.desc,
    shortcut: 'Ctrl+Shift+`',
    category: S.quick_actions_registry.categories.panels,
    execute: () => getApp()?.createTerminal(),
});

QuickActionsRegistry.register('file-preview', {
    keywords: ['preview', 'view', 'file', 'editor', 'reopen', 'last'],
    icon: 'eye',
    label: S.quick_actions_registry.actions.file_preview.label,
    description: S.quick_actions_registry.actions.file_preview.desc,
    shortcut: 'Alt+V',
    category: S.quick_actions_registry.categories.panels,
    execute: () => getApp()?.togglePreview(),
});

QuickActionsRegistry.register('file-explorer', {
    keywords: ['files', 'browser', 'tree', 'folder', 'directory', 'dir'],
    icon: 'folder',
    label: S.quick_actions_registry.actions.file_explorer.label,
    description: S.quick_actions_registry.actions.file_explorer.desc,
    shortcut: 'Alt+F',
    category: S.quick_actions_registry.categories.panels,
    execute: () => getApp()?.toggleFileExplorer(),
});

QuickActionsRegistry.register('search-files', {
    keywords: ['grep', 'find', 'text', 'content', 'search in files', 'ripgrep', 'project search'],
    icon: 'search',
    label: S.quick_actions_registry.actions.search_files.label,
    description: S.quick_actions_registry.actions.search_files.desc,
    shortcut: 'Ctrl+Shift+F',
    category: S.quick_actions_registry.categories.panels,
    execute: () => getApp()?.toggleSearchFiles(),
});

QuickActionsRegistry.register('log-explorer', {
    keywords: ['logs', 'output', 'journal', 'transcript'],
    icon: 'scroll',
    label: S.quick_actions_registry.actions.log_explorer.label,
    description: S.quick_actions_registry.actions.log_explorer.desc,
    shortcut: 'Alt+L',
    category: S.quick_actions_registry.categories.panels,
    execute: () => getApp()?.toggleLogExplorer(),
});

QuickActionsRegistry.register('git-panel', {
    keywords: ['vcs', 'repo', 'commit', 'status', 'branch', 'diff'],
    icon: 'git-merge',
    label: S.quick_actions_registry.actions.git_panel.label,
    description: S.quick_actions_registry.actions.git_panel.desc,
    shortcut: 'Alt+G',
    category: S.quick_actions_registry.categories.panels,
    execute: () => getApp()?.toggleGitPanel(),
});

QuickActionsRegistry.register('cost-analytics', {
    keywords: ['money', 'spend', 'tokens', 'billing', 'usage', 'price', 'analytics'],
    icon: 'coins',
    label: S.quick_actions_registry.actions.cost_analytics.label,
    description: S.quick_actions_registry.actions.cost_analytics.desc,
    shortcut: 'Alt+4',
    category: S.quick_actions_registry.categories.panels,
    execute: () => getApp()?.toggleCostAnalytics(),
});

QuickActionsRegistry.register('active-sessions', {
    keywords: ['running', 'live', 'busy', 'workers'],
    icon: 'activity',
    label: S.quick_actions_registry.actions.active_sessions.label,
    description: S.quick_actions_registry.actions.active_sessions.desc,
    shortcut: 'Alt+S',
    category: S.quick_actions_registry.categories.panels,
    execute: () => getApp()?.toggleActiveSessions(),
});

QuickActionsRegistry.register('discussion', {
    keywords: ['ask', 'thread', 'qa', 'forked talk', 'question'],
    icon: 'message-circle',
    label: S.quick_actions_registry.actions.discussion.label,
    description: S.quick_actions_registry.actions.discussion.desc,
    shortcut: 'Alt+/',
    category: S.quick_actions_registry.categories.panels,
    execute: () => getApp()?.toggleDiscussion(),
});

QuickActionsRegistry.register('debug-logs', {
    keywords: ['errors', 'console', 'browser', 'devtools'],
    icon: 'bug',
    label: S.quick_actions_registry.actions.debug_console.label,
    description: S.quick_actions_registry.actions.debug_console.desc,
    shortcut: 'Alt+D',
    category: S.quick_actions_registry.categories.panels,
    execute: () => WidgetManager.toggle('debug-logs'),
    badge: () => {
        const n = DebugWidget.getUnseenErrorCount();
        return n > 0 ? (n > 99 ? '99+' : String(n)) : null;
    },
});

QuickActionsRegistry.register('prompt-history', {
    keywords: ['recent', 'past', 'previous prompts', 'archive', 'search prompts'],
    icon: 'clock',
    label: S.quick_actions_registry.actions.prompt_history.label,
    description: S.quick_actions_registry.actions.prompt_history.desc,
    shortcut: 'Ctrl+R',
    category: S.quick_actions_registry.categories.panels,
    execute: () => WidgetManager.toggle('prompt-explorer'),
});

QuickActionsRegistry.register('skills', {
    keywords: ['skill', 'skills', 'manage skills', 'folder skill', 'SKILL.md'],
    icon: 'dollarSign',
    label: S.quick_actions_registry.actions.skills.label,
    description: S.quick_actions_registry.actions.skills.desc,
    shortcut: 'Alt+K',
    category: S.quick_actions_registry.categories.panels,
    execute: () => WidgetManager.toggle('skills'),
});

QuickActionsRegistry.register('commands', {
    keywords: ['command', 'commands', 'slash', 'slash commands', 'cli', 'builtin', 'legacy'],
    icon: 'chevron-right',
    label: S.quick_actions_registry.actions.commands.label,
    description: S.quick_actions_registry.actions.commands.desc,
    shortcut: 'Alt+Shift+K',
    category: S.quick_actions_registry.categories.panels,
    execute: () => WidgetManager.toggle('commands'),
});

QuickActionsRegistry.register('agents', {
    keywords: ['agent', 'agents', 'subagent', 'manage agents', 'agent definition'],
    icon: 'brain',
    label: S.quick_actions_registry.actions.agents.label,
    description: S.quick_actions_registry.actions.agents.desc,
    category: S.quick_actions_registry.categories.panels,
    execute: () => WidgetManager.toggle('agents'),
});

QuickActionsRegistry.register('plugins', {
    keywords: ['plugin', 'plugins', 'marketplace', 'install', 'uninstall', 'enable'],
    icon: 'tool',
    label: S.quick_actions_registry.actions.plugins.label,
    description: S.quick_actions_registry.actions.plugins.desc,
    category: S.quick_actions_registry.categories.panels,
    execute: () => WidgetManager.toggle('plugins'),
});

QuickActionsRegistry.register('browser', {
    keywords: ['web', 'url', 'website', 'iframe', 'html', 'render', 'webview', 'page'],
    icon: 'globe',
    label: S.quick_actions_registry.actions.browser.label,
    description: S.quick_actions_registry.actions.browser.desc,
    shortcut: 'Alt+B',
    category: S.quick_actions_registry.categories.panels,
    execute: () => WidgetManager.toggle('browser'),
});

QuickActionsRegistry.register('snippets', {
    keywords: ['snippet', 'snippets', 'expand', 'expansion', 'macro', 'shortcut text'],
    icon: 'code',
    label: S.quick_actions_registry.actions.snippets.label,
    description: S.quick_actions_registry.actions.snippets.desc,
    category: S.quick_actions_registry.categories.panels,
    execute: () => WidgetManager.toggle('snippets'),
});

QuickActionsRegistry.register('uploads-browser', {
    keywords: ['files', 'images', 'pictures', 'attachments', 'media'],
    icon: 'image',
    label: S.quick_actions_registry.actions.uploads_browser.label,
    description: S.quick_actions_registry.actions.uploads_browser.desc,
    category: S.quick_actions_registry.categories.panels,
    execute: () => WidgetManager.toggle('uploads'),
});

QuickActionsRegistry.register('background-tasks', {
    keywords: ['jobs', 'workers', 'async', 'parallel', 'queue'],
    icon: 'loader',
    label: S.quick_actions_registry.actions.background_tasks.label,
    description: S.quick_actions_registry.actions.background_tasks.desc,
    category: S.quick_actions_registry.categories.panels,
    execute: () => WidgetManager.toggle('background-tasks'),
});

QuickActionsRegistry.register('history-explorer', {
    keywords: ['journal', 'past', 'archive', 'old', 'turns'],
    icon: 'archive',
    label: S.quick_actions_registry.actions.history_explorer.label,
    description: S.quick_actions_registry.actions.history_explorer.desc,
    shortcut: 'Alt+H',
    category: S.quick_actions_registry.categories.panels,
    execute: () => getApp()?.toggleHistoryExplorer(),
});

QuickActionsRegistry.register('effort-settings', {
    keywords: ['thinking', 'reasoning', 'depth', 'budget', 'low high', 'ultrathink'],
    icon: 'cpu',
    label: 'Cycle Effort Level',
    description: 'Cycle through effort levels (low/medium/high/xhigh/max)',
    shortcut: "Ctrl+'",
    category: S.quick_actions_registry.categories.panels,
    execute: () => getApp()?.toggleThinkingSettings(),
});

QuickActionsRegistry.register('effort-oneshot', {
    keywords: ['one-shot', 'oneshot', 'next prompt', 'temporary', 'bump', 'boost'],
    icon: 'zap',
    label: 'Cycle Effort One-Shot',
    description: 'Arm a one-shot effort override for the next send only, then auto-reverts',
    shortcut: "Ctrl+Shift+'",
    category: S.quick_actions_registry.categories.panels,
    execute: () => getApp()?.cycleEffortOneShot(),
});

QuickActionsRegistry.register('reopen-tab', {
    keywords: ['restore', 'undo close', 'last closed', 'recover'],
    icon: 'rotate-ccw',
    label: S.quick_actions_registry.actions.reopen_tab.label,
    description: S.quick_actions_registry.actions.reopen_tab.desc,
    shortcut: 'Ctrl+Shift+T',
    category: S.quick_actions_registry.categories.sessions,
    execute: () => getApp()?.reopenLastClosedTab(),
});

QuickActionsRegistry.register('quick-switcher', {
    keywords: ['palette', 'command palette', 'launcher', 'spotlight', 'fzf', 'cmd+p', 'ctrl+p', 'finder'],
    icon: 'command',
    label: S.quick_switcher.action.label,
    description: S.quick_switcher.action.desc,
    shortcut: 'Ctrl+K',
    category: S.quick_actions_registry.categories.panels,
    execute: () => getApp()?.toggleQuickSwitcher(),
});

QuickActionsRegistry.register('open-dialog', {
    keywords: ['open file', 'open folder', 'open directory', 'path', 'browse', 'navigate', 'tab complete', 'cmd+o'],
    icon: 'folder',
    label: S.open_dialog.action.label,
    description: S.open_dialog.action.desc,
    shortcut: 'Ctrl+O',
    category: S.quick_actions_registry.categories.panels,
    execute: () => getApp()?.toggleOpenDialog(),
});

QuickActionsRegistry.register('settings', {
    keywords: ['preferences', 'config', 'options', 'prefs'],
    icon: 'settings',
    label: S.quick_actions_registry.actions.settings.label,
    description: S.quick_actions_registry.actions.settings.desc,
    shortcut: 'Ctrl+,',
    category: S.quick_actions_registry.categories.panels,
    execute: () => getApp()?.showSettings(),
});

QuickActionsRegistry.register('help', {
    keywords: ['docs', 'shortcuts', 'tips', 'about', 'manual'],
    icon: 'help-circle',
    label: S.quick_actions_registry.actions.help.label,
    description: S.quick_actions_registry.actions.help.desc,
    category: S.quick_actions_registry.categories.panels,
    execute: () => getApp()?.showHelp(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Category: Chat Actions
// ─────────────────────────────────────────────────────────────────────────────

QuickActionsRegistry.register('send-message', {
    keywords: ['submit', 'go', 'enter', 'ship'],
    icon: 'send',
    label: S.quick_actions_registry.actions.send_message.label,
    description: S.quick_actions_registry.actions.send_message.desc,
    shortcut: 'Ctrl+Enter',
    category: S.quick_actions_registry.categories.chat,
    execute: () => {
        const app = getApp();
        if (!app) return;
        // During a working turn, send-btn is hidden and followup-btn is the visible target.
        const followupBtn = document.getElementById('followup-btn');
        const sendBtn = document.getElementById('send-btn');
        const target = (followupBtn && followupBtn.classList.contains('visible') && !followupBtn.disabled)
            ? followupBtn
            : (sendBtn && !sendBtn.disabled ? sendBtn : null);
        if (target) {
            target.click();
        } else if (app.sendMessage) {
            app.sendMessage();
        }
    },
    isEnabled: () => {
        const app = getApp();
        if (!app) return false;
        const input = app.els?.messageInput;
        return input && input.value.trim().length > 0;
    },
});

QuickActionsRegistry.register('stop', {
    keywords: ['cancel', 'abort', 'kill', 'interrupt', 'halt'],
    icon: 'square',
    label: S.quick_actions_registry.actions.stop.label,
    description: S.quick_actions_registry.actions.stop.desc,
    shortcut: 'Escape',
    category: S.quick_actions_registry.categories.chat,
    execute: () => getApp()?.stopClaude?.(),
    isEnabled: () => getApp()?.isTyping === true,
    badge: () => getApp()?.isTyping ? '!' : null,
});

QuickActionsRegistry.register('scroll-bottom', {
    keywords: ['end', 'last', 'down', 'newest'],
    icon: 'chevrons-down',
    label: S.quick_actions_registry.actions.scroll_bottom.label,
    description: S.quick_actions_registry.actions.scroll_bottom.desc,
    category: S.quick_actions_registry.categories.chat,
    execute: () => {
        const container = document.querySelector('.messages-container');
        if (container) container.scrollTop = container.scrollHeight;
    },
});

QuickActionsRegistry.register('scroll-top', {
    keywords: ['begin', 'first', 'up', 'oldest'],
    icon: 'chevrons-up',
    label: S.quick_actions_registry.actions.scroll_top.label,
    description: S.quick_actions_registry.actions.scroll_top.desc,
    category: S.quick_actions_registry.categories.chat,
    execute: () => {
        const container = document.querySelector('.messages-container');
        if (container) container.scrollTop = 0;
    },
});

QuickActionsRegistry.register('focus-input', {
    keywords: ['type', 'compose', 'message box', 'caret'],
    icon: 'edit',
    label: S.quick_actions_registry.actions.focus_input.label,
    description: S.quick_actions_registry.actions.focus_input.desc,
    shortcut: 'Ctrl+/',
    category: S.quick_actions_registry.categories.chat,
    execute: () => getApp()?.focusInput(),
});

QuickActionsRegistry.register('search-chat', {
    keywords: ['find', 'lookup', 'search messages', 'in conversation'],
    icon: 'search',
    label: S.quick_actions_registry.actions.search_chat.label,
    description: S.quick_actions_registry.actions.search_chat.desc,
    // Real binding is Ctrl+F (shortcuts.js 'search') — Ctrl+Shift+F now
    // belongs to the project-wide Search in Files widget.
    shortcut: 'Ctrl+F',
    category: S.quick_actions_registry.categories.chat,
    execute: () => getApp()?.openSearch(),
});

QuickActionsRegistry.register('trim-messages', {
    keywords: ['compact', 'reduce', 'cleanup', 'shrink', 'free memory'],
    icon: 'minimize-2',
    label: S.quick_actions_registry.actions.trim_messages.label,
    description: S.quick_actions_registry.actions.trim_messages.desc,
    category: S.quick_actions_registry.categories.chat,
    execute: () => getApp()?.handleTrimMessages(),
    isEnabled: () => (getApp()?.chatCtrl?.getTrimCount() || 0) > 0,  // Uses default 100, preserves last turn
    badge: () => {
        const count = getApp()?.chatCtrl?.getTrimCount() || 0;  // Uses default 100, preserves last turn
        return count > 0 ? (count > 99 ? '99+' : String(count)) : null;
    },
});

// ─────────────────────────────────────────────────────────────────────────────
// Category: Input Actions
// ─────────────────────────────────────────────────────────────────────────────

QuickActionsRegistry.register('upload', {
    keywords: ['attach', 'add file', 'browse', 'image'],
    icon: 'upload',
    label: S.quick_actions_registry.actions.upload.label,
    description: S.quick_actions_registry.actions.upload.desc,
    category: S.quick_actions_registry.categories.input,
    execute: () => getApp()?.uploadManager?.openFilePicker(),
});

QuickActionsRegistry.register('paste', {
    keywords: ['clipboard', 'insert'],
    icon: 'clipboard',
    label: S.quick_actions_registry.actions.paste.label,
    description: S.quick_actions_registry.actions.paste.desc,
    category: S.quick_actions_registry.categories.input,
    execute: async () => {
        const app = getApp();
        if (!app) return;

        // If a terminal is recently focused or is the active tab, paste there
        if (TerminalWidget.isRecentlyFocused()) {
            const handled = await TerminalWidget.paste();
            if (handled) return;
        }

        try {
            // Try to read clipboard (requires permission on some browsers)
            if (navigator.clipboard && navigator.clipboard.read) {
                const items = await navigator.clipboard.read();

                for (const item of items) {
                    // Check for image types first
                    const imageType = item.types.find(t => t.startsWith('image/'));
                    if (imageType) {
                        const blob = await item.getType(imageType);
                        // Use uploadManager if available
                        if (app.uploadManager?.handlePastedImage) {
                            app.uploadManager.handlePastedImage(blob);
                            // Refocus input to keep keyboard open
                            app.els?.messageInput?.focus();
                            return;
                        }
                        // Fallback: create a paste event-like handling
                        const file = new File([blob], 'pasted-image.png', { type: imageType });
                        if (app.uploadManager?.handleFiles) {
                            app.uploadManager.handleFiles([file]);
                            // Refocus input to keep keyboard open
                            app.els?.messageInput?.focus();
                            return;
                        }
                    }

                    // Check for text
                    if (item.types.includes('text/plain')) {
                        const blob = await item.getType('text/plain');
                        const text = await blob.text();

                        // Insert text at cursor in message input
                        const input = app.els?.messageInput;
                        if (input) {
                            const start = input.selectionStart;
                            const end = input.selectionEnd;
                            const before = input.value.substring(0, start);
                            const after = input.value.substring(end);
                            input.value = before + text + after;
                            input.selectionStart = input.selectionEnd = start + text.length;
                            input.focus();
                            // Trigger input event for auto-resize
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                        return;
                    }
                }
            } else if (navigator.clipboard && navigator.clipboard.readText) {
                // Fallback for browsers that only support readText
                const text = await navigator.clipboard.readText();
                const input = app.els?.messageInput;
                if (input && text) {
                    const start = input.selectionStart;
                    const end = input.selectionEnd;
                    const before = input.value.substring(0, start);
                    const after = input.value.substring(end);
                    input.value = before + text + after;
                    input.selectionStart = input.selectionEnd = start + text.length;
                    input.focus();
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
            } else {
                // Last resort: focus input and let user paste manually
                app.els?.messageInput?.focus();
                debug.log('[QuickActions] Clipboard API not available, focused input for manual paste');
            }
        } catch (err) {
            // Permission denied or other error - focus input as fallback
            console.warn('[QuickActions] Clipboard access failed:', err.message);
            app.els?.messageInput?.focus();
            // Show hint to user
            app.activeSession?.addSystemLog(S.quick_actions_registry.paste_hint, 'info');
        }
    },
});

// ─────────────────────────────────────────────────────────────────────────────
// Category: Navigation
// ─────────────────────────────────────────────────────────────────────────────

QuickActionsRegistry.register('change-cwd', {
    keywords: ['working directory', 'project', 'folder', 'path', 'dir', 'cd'],
    icon: 'folder-open',
    label: S.quick_actions_registry.actions.change_cwd.label,
    description: S.quick_actions_registry.actions.change_cwd.desc,
    category: S.quick_actions_registry.categories.navigation,
    execute: () => {
        OpenDialog.show();
    },
});

// ─────────────────────────────────────────────────────────────────────────────
// Category: Utilities
// ─────────────────────────────────────────────────────────────────────────────

QuickActionsRegistry.register('storage-info', {
    keywords: ['localstorage', 'usage', 'space', 'quota', 'disk'],
    icon: 'database',
    label: S.quick_actions_registry.actions.storage_info.label,
    description: S.quick_actions_registry.actions.storage_info.desc,
    category: S.quick_actions_registry.categories.utilities,
    execute: async () => {
        const { Storage } = await import('./utils.js');
        
        const usage = Storage.getUsage();
        const sorted = Object.entries(usage.keys).sort((a, b) => b[1] - a[1]).slice(0, 5);
        const lines = sorted.map(([key, bytes]) => {
            const fmt = bytes > 1024 * 1024
                ? (bytes / 1024 / 1024).toFixed(1) + 'M'
                : (bytes / 1024).toFixed(0) + 'K';
            return `${key}: ${fmt}`;
        });
        showToast(`Storage: ${usage.usedMB}\n${lines.join('\n')}`, 4000);
    },
});

QuickActionsRegistry.register('storage-cleanup', {
    keywords: ['clean', 'free space', 'reduce', 'trim', 'gc', 'garbage'],
    icon: 'trash',
    label: S.quick_actions_registry.actions.storage_cleanup.label,
    description: S.quick_actions_registry.actions.storage_cleanup.desc,
    category: S.quick_actions_registry.categories.utilities,
    execute: async () => {
        const { Storage } = await import('./utils.js');
        
        const app = getApp();
        if (!app?.sessionManager) return;

        const beforeUsage = Storage.getUsage();

        for (const session of app.sessionManager.sessions) {
            if (session.messages.length > 30) {
                session.messages = session.messages.slice(-30);
            }
        }
        app.sessionManager.saveSessions();

        const afterUsage = Storage.getUsage();
        const saved = beforeUsage.used - afterUsage.used;
        const savedFmt = saved > 1024 * 1024
            ? (saved / 1024 / 1024).toFixed(2) + ' MB'
            : (saved / 1024).toFixed(1) + ' KB';
        showToast(`Freed ${savedFmt} of storage. Now ${afterUsage.usedMB}.`, 3000);
    },
});

QuickActionsRegistry.register('fullscreen', {
    keywords: ['expand', 'maximize', 'f11', 'full screen'],
    icon: 'maximize',
    label: S.quick_actions_registry.actions.fullscreen.label,
    description: S.quick_actions_registry.actions.fullscreen.desc,
    category: S.quick_actions_registry.categories.utilities,
    execute: () => {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            document.documentElement.requestFullscreen();
        }
    },
});

// Opt-in: Eruda loads from a CDN, so the server gates it behind --enable-eruda.
if (window.INSTANCE_CONFIG?.eruda_enabled) {
    QuickActionsRegistry.register('eruda', {
        keywords: ['devtools', 'mobile dev', 'inspector', 'console', 'debug'],
        icon: 'code',
        label: S.quick_actions_registry.actions.eruda.label,
        description: S.quick_actions_registry.actions.eruda.desc,
        category: S.quick_actions_registry.categories.utilities,
        execute: () => {
            if (window.eruda) {
                try {
                    if (eruda._devTools?._isShow) eruda.hide();
                    else eruda.show();
                } catch(e) {}
                return;
            }
            // First time: load from CDN, init, and show
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/eruda';
            script.onload = () => {
                if (window.eruda) {
                    eruda.init();
                    setTimeout(() => eruda.show(), 100);
                    try {
                        const pos = JSON.parse(localStorage.getItem('eruda-pos'));
                        if (pos) eruda.position(pos);
                    } catch(e) {}
                    // Periodically save position
                    setInterval(() => {
                        try {
                            const pos = eruda.position();
                            if (pos) localStorage.setItem('eruda-pos', JSON.stringify(pos));
                        } catch(e) {}
                    }, 5000);
                }
            };
            document.head.appendChild(script);
        },
    });
}

QuickActionsRegistry.register('reload', {
    keywords: ['refresh', 'f5', 'restart page'],
    icon: 'refresh-cw',
    label: S.quick_actions_registry.actions.reload.label,
    description: S.quick_actions_registry.actions.reload.desc,
    category: S.quick_actions_registry.categories.utilities,
    execute: () => location.reload(),
});

QuickActionsRegistry.register('hard-reset', {
    keywords: ['nuke', 'wipe', 'clear cache', 'fresh', 'factory reset'],
    icon: 'trash-2',
    label: S.quick_actions_registry.actions.hard_reset.label,
    description: S.quick_actions_registry.actions.hard_reset.desc,
    category: S.quick_actions_registry.categories.utilities,
    execute: async () => {
        const ok = await appConfirm(S.quick_actions_registry.hard_reset_confirm, { confirmLabel: 'Reset', danger: true });
        if (!ok) return;
        // Clear service workers
        if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map(r => r.unregister()));
        }
        // Clear browser caches
        if ('caches' in window) {
            const names = await caches.keys();
            await Promise.all(names.map(n => caches.delete(n)));
        }
        // Clear all localStorage (sessions, tabs, messages, settings)
        localStorage.clear();
        // Clear sessionStorage
        sessionStorage.clear();
        location.reload(true);
    },
});

QuickActionsRegistry.register('capture-snapshot', {
    keywords: ['debug', 'dump', 'export state', 'localstorage', 'screenshot state'],
    icon: 'camera',
    label: S.quick_actions_registry.actions.capture_snapshot.label,
    description: S.quick_actions_registry.actions.capture_snapshot.desc,
    category: S.quick_actions_registry.categories.utilities,
    execute: async () => {
        const snapshot = {
            version: 2,
            captured_at: new Date().toISOString(),
            url: location.href,
            localStorage: {},
            metrics: {
                dom_nodes: document.querySelectorAll('*').length,
                heap_mb: performance.memory
                    ? Math.round(performance.memory.usedJSHeapSize / 1024 / 1024 * 100) / 100
                    : null,
                session_count: window.app?.sessionManager?.sessions?.length || 0,
                total_in_memory_messages:
                    (window.app?.sessionManager?.sessions || []).reduce((sum, s) => sum + (s.messages?.length || 0), 0),
            },
            session_summary: [],
            memory_state: {
                active_session_id: window.app?.activeSession?.id || null,
                active_mode: localStorage.getItem('claude-code-active-mode') || 'session',
                sessions: (window.app?.sessionManager?.sessions || []).map(s => ({
                    id: s.id,
                    storeId: s.storeId || null,
                    in_memory_message_count: s.messages?.length || 0,
                    has_more_messages: !!s.hasMoreMessages,
                    total_message_count: s.totalMessageCount || 0,
                    has_cached_dom: !!window.app?.chatCtrl?.sessionPool?.containers?.has(s.id),
                })),
            },
        };
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            snapshot.localStorage[k] = localStorage.getItem(k);
        }
        try {
            const sessions = JSON.parse(localStorage.getItem('claude-code-sessions') || '[]');
            snapshot.session_summary = sessions.map(s => ({
                id: s.id, name: s.name, cwd: s.cwd,
                message_count: (s.messages || []).length,
                total_cost: s.totalCost || 0, model: s.model,
                has_store_id: !!s.storeId,
                store_id: s.storeId || null,
            }));
        } catch (e) { snapshot.parse_error = e.message; }
        let bytes = 0;
        for (const [k, v] of Object.entries(snapshot.localStorage))
            bytes += k.length + (v ? v.length : 0);
        snapshot.localStorage_bytes = bytes;

        // ── Client-side full memory dump ──
        // Captures the FULL un-truncated in-memory state per session
        // (localStorage only has 30 truncated messages per session)
        const clientSessions = {};
        let clientBytes = 0;
        const MAX_CLIENT_BYTES = 30 * 1024 * 1024; // 30MB cap
        for (const s of (window.app?.sessionManager?.sessions || [])) {
            const sessionData = {
                id: s.id,
                storeId: s.storeId || null,
                name: s.name,
                cwd: s.cwd,
                // Full un-truncated messages (the critical piece)
                messages: s.messages || [],
                message_count: s.messages?.length || 0,
                // Runtime state
                runtime: {
                    turnId: s.turnId || 0,
                    model: s.model,
                    providerSessionId: s.providerSessionId,
                    contextTokens: s.contextTokens || 0,
                    contextWindow: s.contextWindow || 0,
                    totalInputTokens: s.totalInputTokens || 0,
                    totalOutputTokens: s.totalOutputTokens || 0,
                    totalCost: s.totalCost || 0,
                    hasMoreMessages: !!s.hasMoreMessages,
                    totalMessageCount: s.totalMessageCount || 0,
                    permissionMode: s.permissionMode || null,
                    isAgentRunning: !!s.isAgentRunning,
                    isReady: !!s.isReady,
                },
                // Transient UI state
                scrollPosition: s.scrollPosition,
                isUserScrolledUp: !!s.isUserScrolledUp,
                inputText: s.inputText || '',
                // System logs (connection events, errors)
                systemLogs: (s.systemLogs || []).slice(-100), // last 100
                // Prompt history
                promptHistory: s.promptHistory || [],
            };
            const chunk = JSON.stringify(sessionData);
            if (clientBytes + chunk.length > MAX_CLIENT_BYTES) break;
            clientBytes += chunk.length;
            clientSessions[s.id] = sessionData;
        }
        snapshot.client_sessions = clientSessions;
        snapshot.client_sessions_bytes = clientBytes;
        snapshot.metrics.client_sessions_count = Object.keys(clientSessions).length;
        snapshot.metrics.total_client_messages =
            Object.values(clientSessions).reduce((sum, s) => sum + (s.message_count || 0), 0);

        const numSessions = snapshot.session_summary.length;
        const totalMsgs = snapshot.session_summary.reduce((s, x) => s + x.message_count, 0);
        const sizeKB = (bytes / 1024).toFixed(1);

        try {
            const resp = await fetch('/api/perf/snapshot', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(snapshot),
            });
            if (resp.status === 401) {
                // auth-fetch wrapper is already redirecting to /login. Bail
                // quietly — don't queue an "upload failed" toast that would
                // flash after the user logs back in.
                return;
            }
            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}`);
            }
            const result = await resp.json();

            const path = result.path;
            const serverInfo = result.server_sessions
                ? `+ ${result.server_sessions} server sessions (${result.server_bytes_mb || 0}MB)`
                : '';
            const clientInfo = snapshot.metrics.total_client_messages
                ? `${snapshot.metrics.total_client_messages} client msgs (${(clientBytes / 1024 / 1024).toFixed(1)}MB)`
                : '';
            showToast(`
                <div style="font-weight:600;margin-bottom:4px">Snapshot saved</div>
                <div class="snapshot-toast-path" data-tooltip="Tap to copy">${escapeHtml(path)}</div>
                <div style="margin-top:4px;opacity:.7;font-size:12px">
                    ${numSessions} sessions, ${totalMsgs} msgs, ${sizeKB} KB, ${snapshot.metrics.dom_nodes} DOM nodes
                    ${clientInfo ? `<br>${clientInfo}` : ''}
                    ${serverInfo ? `<br>${serverInfo}` : ''}
                </div>
            `, {
                duration: 8000,
                html: true,
                pauseOnHover: true,
                interactive: true,
                className: 'snapshot-toast',
                onMount: (toast) => {
                    const pathEl = toast.querySelector('.snapshot-toast-path');
                    pathEl.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        try {
                            await navigator.clipboard.writeText(path);
                            pathEl.textContent = 'Copied!';
                            setTimeout(() => { pathEl.textContent = path; }, 1000);
                        } catch {
                            const range = document.createRange();
                            range.selectNodeContents(pathEl);
                            const sel = window.getSelection();
                            sel.removeAllRanges();
                            sel.addRange(range);
                        }
                    });
                },
            });
        } catch (e) {
            // Don't attempt a blob download fallback: iPadOS WKWebView ignores
            // the `download` attribute on programmatic <a> clicks and navigates
            // the PWA to the blob: URL instead, breaking the app shell.
            console.error('[capture-snapshot] upload failed:', e);
            showToast(S.toast.upload_failed, 3000);
        }
    },
});

QuickActionsRegistry.register('zen-mode', {
    keywords: ['focus', 'distraction free', 'minimal', 'hide ui', 'clean'],
    icon: 'moon',
    label: S.quick_actions_registry.actions.zen_mode.label,
    description: S.quick_actions_registry.actions.zen_mode.desc,
    shortcut: 'Alt+Z',
    category: S.quick_actions_registry.categories.panels,
    execute: () => {
        window.toggleZenMode?.();
    },
    isEnabled: () => !!getApp()?.activeSession,
});

// ─────────────────────────────────────────────────────────────────────────────
// Custom user-defined actions — terminal command / prompt / slash command
//
// Definitions live in bridge config (`quickActions.customActions`, synced
// cross-device) and are (re-)registered here by syncCustomActions(), called
// from quick-actions-menu's load/save paths. Shape:
//   { id: 'custom-<rand>', label, icon, type: 'terminal'|'prompt'|'slash',
//     payload: string }
// ─────────────────────────────────────────────────────────────────────────────

export const CUSTOM_ACTION_TYPES = ['terminal', 'prompt', 'slash'];

function executeCustomAction(def) {
    const app = getApp();
    if (!app) return;
    const payload = (def.payload || '').trim();
    if (!payload) return;

    switch (def.type) {
        case 'terminal':
            // Open a terminal tab in the active session's cwd and run it
            app.tabCtrl?.openTerminalWidgetTab({
                cwd: app.activeSession?.cwd || null,
                title: def.label,
                initialCommand: payload + '\n',
            });
            break;
        case 'prompt':
            // Send through the normal message path (history, stash, welcome routing)
            app.sendMessage(payload);
            break;
        case 'slash':
            app.handleSlashCommand(payload.startsWith('/') ? payload : '/' + payload);
            break;
        default:
            console.warn('[QuickActions] Unknown custom action type:', def.type);
    }
}

/**
 * Replace all registered custom actions with the given definitions.
 * Idempotent — safe to call on every config load/save.
 */
export function syncCustomActions(defs) {
    for (const action of QuickActionsRegistry.getAll()) {
        if (action.id.startsWith('custom-')) {
            QuickActionsRegistry.unregister(action.id);
        }
    }

    for (const def of defs || []) {
        if (!def?.id || !def.label || !CUSTOM_ACTION_TYPES.includes(def.type)) continue;
        const typeName = S.settings.qa_editor.custom_types[def.type] || def.type;
        const payload = def.payload || '';
        const preview = payload.length > 60 ? payload.slice(0, 60) + '…' : payload;
        QuickActionsRegistry.register(def.id, {
            icon: def.icon || 'zap',
            label: def.label,
            description: `${typeName}: ${preview}`,
            category: S.quick_actions_registry.categories.custom,
            keywords: ['custom', def.type, def.label],
            execute: () => executeCustomAction(def),
            // Prompt/slash need a session to send into; terminal works anywhere
            isEnabled: def.type === 'terminal' ? undefined : () => !!getApp()?.activeSession,
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Presets — loaded from server (/api/bridge/presets → ~/.painapple-code/presets/)
// Source of truth: presets.defaults.json (ships with project, seeds user dir)
// ─────────────────────────────────────────────────────────────────────────────

// Minimal fallback if server hasn't responded yet
export const QUICK_ACTION_PRESETS = {
    balanced: {
        name: 'Balanced',
        description: S.quick_actions_registry.presets.balanced.desc,
        slots: ['git-panel', 'file-explorer', 'new-session', 'close-tab', 'stop', 'terminal']
    }
};

/**
 * Replace presets with server-provided values (from ~/.painapple-code/presets/*.json).
 */
export function updatePresets(serverPresets) {
    for (const key of Object.keys(QUICK_ACTION_PRESETS)) {
        delete QUICK_ACTION_PRESETS[key];
    }
    Object.assign(QUICK_ACTION_PRESETS, serverPresets);
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_QUICK_ACTIONS_CONFIG = {
    preset: 'balanced',
    slots: QUICK_ACTION_PRESETS.balanced.slots,
    options: {
        contextAware: true,
        showTooltips: true,
        dragRelease: false,
        hapticFeedback: true,
        menuPosition: 'bottom-right'
    }
};
