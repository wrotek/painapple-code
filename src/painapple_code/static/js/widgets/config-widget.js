/**
 * Config Widget — Settings UI orchestrator.
 *
 * Tabbed Settings panel (Project / Shortcuts / Appearance / Quick Actions
 * / Claude / System). The heavy logic for each section lives under
 * `./config/*`:
 *
 *   state.js           — config storage helpers + ConfigState singleton
 *   shortcut-editor.js — Shortcuts tab capture/edit class
 *   quick-actions-tab.js — Quick Actions FAB editor
 *   commit-sections.js — Commit Sections editor inside Project tab
 *   dir-autocomplete.js — Extra-dirs lists (project + global)
 *   system-controls.js — Claude path / effort / API retry / token profile
 *   models-tab.js      — Models tab CRUD
 *   gestures.js        — Wheel + touch swipe handlers for tab cycling
 *
 * What stays here: the main `renderConfigPanel` template, the master
 * `attachConfigEventHandlers` wiring, tab navigation (switch/cycle/
 * jump-by-index + Escape/Ctrl+[/]/Ctrl+1-9 keybindings), and the
 * `registerConfigWidget` modal-widget registration. Public exports are
 * re-exported from the state module so external importers
 * (`app.js`, `welcome.js`, `chat-controller.js`, `thinking-controller.js`,
 * `preview/preview-events.js`, `tool-renderer.js`, `discussion-widget.js`,
 * `log-explorer-widget.js`) need no changes.
 */

import S from '../strings.js';
import { escapeHtml } from '../utils.js';
import { SHORTCUTS } from '../shortcuts.js';
import { ShortcutHints, HINT_CANDIDATE_IDS, DEFAULT_HINT_IDS, getHintsConfig, setHintsEnabled, setHintIds } from '../shortcut-hints.js';
import { debug, CONFIG } from '../config.js';
import { WidgetManager } from '../widget-system/index.js';
import { MarkdownRenderer } from '../components.js';
import { showToast } from '../context-menu.js';

import { FilePreviewWidget } from './file-preview-widget.js';
import { TerminalWidget } from './terminal-widget.js';

import {
    state,
    subModel,
    LAYOUT_MODES,
    DEFAULT_COLLAPSE_MODES,
    applyLayout,
    applyFloatingButtonsOpacity,
} from './config/state.js';
import { ShortcutEditor } from './config/shortcut-editor.js';
import { renderQuickActionsTab, setupQuickActionsEvents } from './config/quick-actions-tab.js';
import {
    renderCommitSectionsEditor,
    setupCommitSectionsHandlers,
    setupCommitSectionItemHandlers,
    updateSectionsCount,
} from './config/commit-sections.js';
import {
    renderExtraDirsListHTML,
    setupExtraDirAddHandler,
    updateExtraDirsInPlace,
} from './config/dir-autocomplete.js';
import {
    setupApiRetryControls,
    setupSigintOnAskControls,
} from './config/system-controls.js';
import { setupModelsTab } from './config/models-tab.js';
import { setupConfigGestures, cleanupConfigGestures } from './config/gestures.js';

// Re-exports preserve the public API at './widgets/config-widget.js' so
// every external importer keeps working without changes.
export {
    LAYOUT_MODES,
    loadUserConfig,
    saveUserConfig,
    applyLayout,
    applyFloatingButtonsOpacity,
    isThinkingKeywordsHighlightingEnabled,
    isSelectionInPreviewEnabled,
    isAnnotateOnPasteEnabled,
    getToolCategory,
    getToolCollapseMode,
    applyAutocorrectSetting,
} from './config/state.js';

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get human-readable description of current preview size
 */
function getPreviewSizeDescription() {
    const settings = FilePreviewWidget.getSizeSettings();
    if (settings.isCustom) {
        return `Custom: ${settings.width}×${settings.height}px (default: ${settings.defaultWidth}×${settings.defaultHeight})`;
    }
    return `Default: ${settings.defaultWidth}×${settings.defaultHeight}px`;
}

/**
 * Update the preview size description in the UI
 */
function updatePreviewSizeUI(container) {
    const desc = container.querySelector('#preview-size-desc');
    const btn = container.querySelector('#reset-preview-size');
    if (desc) {
        desc.textContent = getPreviewSizeDescription();
    }
    if (btn) {
        btn.disabled = !FilePreviewWidget.getSizeSettings().isCustom;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Collapse Mode Grid
// ═══════════════════════════════════════════════════════════════════════════

function _permissionOptions() {
    return S.permissions.order.map(key => {
        const lvl = S.permissions.levels[key];
        return `<option value="${key}">${lvl.popup_label}</option>`;
    }).join('\n');
}

function _collapseModeSelect(context, toolType, currentModes) {
    const modes = currentModes || DEFAULT_COLLAPSE_MODES;
    const val = modes[context]?.[toolType] || DEFAULT_COLLAPSE_MODES[context][toolType];
    return `<select class="system-select collapse-mode-select" data-context="${context}" data-type="${toolType}">
        <option value="expanded" ${val === 'expanded' ? 'selected' : ''}>${S.settings.collapse_modes.expanded}</option>
        <option value="compact" ${val === 'compact' ? 'selected' : ''}>${S.settings.collapse_modes.compact}</option>
        <option value="collapsed" ${val === 'collapsed' ? 'selected' : ''}>${S.settings.collapse_modes.collapsed}</option>
    </select>`;
}

function renderCollapseGrid(config) {
    const modes = config.toolCollapseModes || DEFAULT_COLLAPSE_MODES;
    const contexts = Object.entries(S.settings.thinking_modes).map(([key, label]) => ({ key, label }));
    const types = ['read', 'write', 'execute'];

    const rows = contexts.map(ctx =>
        `<span class="collapse-grid-label">${ctx.label}</span>` +
        types.map(t => _collapseModeSelect(ctx.key, t, modes)).join('')
    ).join('');

    return `<div class="collapse-mode-grid">
        <span></span><span class="collapse-grid-header">Read</span><span class="collapse-grid-header">Write</span><span class="collapse-grid-header">Execute</span>
        ${rows}
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Render Functions
// ═══════════════════════════════════════════════════════════════════════════

function renderConfigPanel(container, context) {
    debug.log('[Config] renderConfigPanel called, projectConfig:', state.projectConfig?.shadow_git);
    state.container = container;

    // Handle tab requested via WidgetManager.open context (avoids dynamic import module mismatch)
    if (context?.tab) {
        state.activeTab = context.tab;
        state._tabSelected = true;
    }

    // The 'snippets' and 'agents' tabs have moved into standalone widgets.
    // Honour legacy tab requests by routing them to the widget instead.
    if (state.activeTab === 'favorites' || state.activeTab === 'snippets') {
        state.activeTab = 'shortcuts';
        setTimeout(() => {
            WidgetManager.close('config');
            WidgetManager.open('snippets');
        }, 0);
    } else if (state.activeTab === 'agents') {
        state.activeTab = 'shortcuts';
        setTimeout(() => {
            WidgetManager.close('config');
            WidgetManager.open('agents');
        }, 0);
    }

    // Check if we have an active project
    const hasProject = state.hasActiveProject();
    debug.log('[Config] hasProject:', hasProject, 'cwd:', window.app?.activeSession?.cwd);
    const projectName = hasProject ? (state.projectInfo?.name || 'Project') : '';

    // Default to project tab if available and no explicit tab selected
    if (hasProject && state.activeTab === 'shortcuts' && !state._tabSelected) {
        state.activeTab = 'project';
    }
    state._tabSelected = true;

    container.innerHTML = `
        <div class="config-tabs">
            ${hasProject ? `
            <button class="config-tab ${state.activeTab === 'project' ? 'active' : ''}" data-tab="project">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                ${escapeHtml(projectName)}
            </button>
            ` : ''}
            <button class="config-tab ${state.activeTab === 'shortcuts' ? 'active' : ''}" data-tab="shortcuts">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="2" y="4" width="20" height="16" rx="2"/>
                    <path d="M6 8h4M14 8h4M6 12h2M10 12h4M16 12h2M6 16h12"/>
                </svg>
                Shortcuts
            </button>
            <button class="config-tab ${state.activeTab === 'appearance' ? 'active' : ''}" data-tab="appearance">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
                </svg>
                Appearance
            </button>
            <button class="config-tab ${state.activeTab === 'terminal' ? 'active' : ''}" data-tab="terminal">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="4 17 10 11 4 5"/>
                    <line x1="12" y1="19" x2="20" y2="19"/>
                </svg>
                ${S.settings.tabs.terminal}
            </button>
            <button class="config-tab ${state.activeTab === 'quickactions' ? 'active' : ''}" data-tab="quickactions">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                </svg>
                Quick Actions
            </button>
            <button class="config-tab ${state.activeTab === 'models' ? 'active' : ''}" data-tab="models">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                    <path d="M2 17l10 5 10-5"/>
                    <path d="M2 12l10 5 10-5"/>
                </svg>
                ${S.settings.sections.engines}
            </button>
            <button class="config-tab ${state.activeTab === 'system' ? 'active' : ''}" data-tab="system">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
                System
            </button>
        </div>

        <div class="config-body">
            ${hasProject ? `
            <!-- Project tab -->
            <div class="config-section" data-section="project" ${state.activeTab !== 'project' ? 'hidden' : ''}>
                <div class="project-settings">
                    <div class="project-info">
                        <div class="project-info-path">
                            <span class="project-info-label">Path</span>
                            <span class="project-info-value">${escapeHtml(state.projectInfo?.path || state.getProjectCwd() || '')}</span>
                        </div>
                        <div class="project-info-hash">
                            <span class="project-info-label">Hash</span>
                            <span class="project-info-value">${escapeHtml(state.projectInfo?.hash || '')}</span>
                        </div>
                    </div>

                    <div class="project-section">
                        <h3 class="project-section-title">${S.settings.sections.extra_dirs_project}</h3>
                        <p class="config-hint">${S.settings.hints.extra_dirs_project_desc}</p>

                        <div class="extra-dirs-list" id="extra-dirs-list">
                            ${renderExtraDirsListHTML(state.projectConfig?.extra_dirs || [], 'extra-dir-remove')}
                        </div>

                        <div class="extra-dir-add-row">
                            <input type="text" id="extra-dir-input" class="extra-dir-input"
                                   placeholder="/path/to/directory" spellcheck="false" autocomplete="off">
                            <button class="extra-dir-add-btn" id="extra-dir-add-btn">Add</button>
                        </div>
                    </div>

                    <div class="project-section">
                        <h3 class="project-section-title">${S.settings.sections.shadow_git}</h3>
                        <p class="config-hint">${S.settings.hints.shadow_git_desc}</p>

                        <label class="project-toggle">
                            <input type="checkbox" id="shadow-git-enabled"
                                   ${state.projectConfig?.shadow_git?.enabled !== false ? 'checked' : ''}>
                            <span class="project-toggle-label">${S.settings.toggles.enable_shadow_git}</span>
                        </label>

                        <label class="project-toggle">
                            <input type="checkbox" id="shadow-git-rich-commits"
                                   ${state.projectConfig?.shadow_git?.rich_commits !== false ? 'checked' : ''}>
                            <span class="project-toggle-label">${subModel(S.settings.toggles.rich_commits)}</span>
                            <span class="project-toggle-hint">${S.settings.toggles.rich_commits_hint}</span>
                        </label>

                        <div class="commit-sections-container ${state.projectConfig?.shadow_git?.rich_commits !== false ? '' : 'disabled'}">
                            <button class="commit-sections-toggle" id="toggle-commit-sections">
                                <svg class="chevron-icon ${state.commitSectionsExpanded ? 'expanded' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M9 18l6-6-6-6"/>
                                </svg>
                                <span>${S.settings.section_editor.configure}</span>
                                <span class="sections-count">${state.commitSections?.sections?.filter(s => s.enabled).length || 0} enabled</span>
                            </button>
                            <div class="commit-sections-editor ${state.commitSectionsExpanded ? 'expanded' : ''}" id="commit-sections-editor">
                                ${renderCommitSectionsEditor(state)}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            ` : ''}

            <!-- Shortcuts tab -->
            <div class="config-section" data-section="shortcuts" ${state.activeTab !== 'shortcuts' ? 'hidden' : ''}>
                <div class="shortcuts-header">
                    <p class="shortcuts-hint">${S.settings.shortcuts_tab.hint}</p>
                    <button class="shortcuts-reset-all" data-tooltip="Reset all to defaults">
                        ${S.settings.shortcuts_tab.reset_all}
                    </button>
                </div>
                <div class="shortcuts-list"></div>
            </div>

            <!-- Appearance tab -->
            <div class="config-section" data-section="appearance" ${state.activeTab !== 'appearance' ? 'hidden' : ''}>
                <div class="appearance-section">
                    <h3 class="appearance-section-title">${S.settings.sections.layout_density}</h3>
                    <div class="layout-options">
                        <label class="layout-option">
                            <input type="radio" name="layout" value="compact" ${state.config.layout === 'compact' ? 'checked' : ''}>
                            <span class="layout-option-content">
                                <span class="layout-option-label">Compact</span>
                                <span class="layout-option-desc">Minimal spacing, more content visible</span>
                            </span>
                        </label>
                        <label class="layout-option">
                            <input type="radio" name="layout" value="normal" ${state.config.layout === 'normal' || !state.config.layout ? 'checked' : ''}>
                            <span class="layout-option-content">
                                <span class="layout-option-label">Normal</span>
                                <span class="layout-option-desc">Balanced spacing (default)</span>
                            </span>
                        </label>
                        <label class="layout-option">
                            <input type="radio" name="layout" value="spacious" ${state.config.layout === 'spacious' ? 'checked' : ''}>
                            <span class="layout-option-content">
                                <span class="layout-option-label">Spacious</span>
                                <span class="layout-option-desc">More breathing room, larger elements</span>
                            </span>
                        </label>
                    </div>
                </div>
                <div class="appearance-section">
                    <h3 class="appearance-section-title">${S.settings.sections.font_size}</h3>
                    <p class="config-hint">${S.settings.hints.font_desc}</p>
                    <div class="font-scale-control">
                        <button class="font-scale-btn" id="font-decrease" data-tooltip="Decrease (70% min)">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M5 12h14"/>
                            </svg>
                        </button>
                        <span class="font-scale-label" id="font-size-label">${Math.round((window.app?.fontScale || 1) * 100)}%</span>
                        <button class="font-scale-btn" id="font-increase" data-tooltip="Increase (150% max)">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 5v14M5 12h14"/>
                            </svg>
                        </button>
                    </div>
                </div>
                <div class="appearance-section">
                    <h3 class="appearance-section-title">${S.settings.sections.floating_buttons}</h3>
                    <p class="config-hint">${S.settings.hints.floating_desc}</p>
                    <div class="opacity-slider-control">
                        <input type="range" id="floating-opacity-slider" min="10" max="100" step="5"
                               value="${Math.round((state.config.floatingButtonsOpacity ?? 0.7) * 100)}"
                               class="opacity-slider">
                        <span class="opacity-slider-label" id="floating-opacity-label">${Math.round((state.config.floatingButtonsOpacity ?? 0.7) * 100)}%</span>
                    </div>
                </div>
                <div class="appearance-section">
                    <h3 class="appearance-section-title">${S.settings.sections.tool_blocks}</h3>
                    <div class="system-setting">
                        <label class="project-toggle">
                            <input type="checkbox" id="code-block-wrap"
                                   ${MarkdownRenderer.getCodeWrapPref() ? 'checked' : ''}>
                            <span class="project-toggle-label">${S.settings.toggles.code_block_wrap}</span>
                            <span class="project-toggle-hint">${S.settings.toggles.code_block_wrap_hint}</span>
                        </label>
                    </div>
                    <p class="config-hint">${S.settings.hints.tool_blocks_desc}</p>
                    ${renderCollapseGrid(state.config)}
                </div>
                <div class="appearance-section">
                    <h3 class="appearance-section-title">${S.settings.sections.widgets}</h3>
                    <div class="system-setting">
                        <label class="project-toggle">
                            <input type="checkbox" id="selection-in-preview"
                                   ${state.config.selectionInPreview ? 'checked' : ''}>
                            <span class="project-toggle-label">${S.settings.toggles.selection_in_preview}</span>
                            <span class="project-toggle-hint">${S.settings.toggles.selection_in_preview_hint}</span>
                        </label>
                    </div>
                    <p class="config-hint">${S.settings.hints.widget_sizes_desc}</p>
                    <div class="system-setting">
                        <label class="system-setting-label">
                            <span class="system-setting-name">File Preview</span>
                            <span class="system-setting-desc" id="preview-size-desc">
                                ${getPreviewSizeDescription()}
                            </span>
                        </label>
                        <div class="system-setting-control">
                            <button class="system-reset-btn" id="reset-preview-size"
                                    ${!FilePreviewWidget.getSizeSettings().isCustom ? 'disabled' : ''}>
                                Reset
                            </button>
                        </div>
                    </div>
                </div>
                <div class="appearance-section">
                    <h3 class="appearance-section-title">${S.settings.sections.input}</h3>
                    <div class="system-setting">
                        <label class="project-toggle">
                            <input type="checkbox" id="disable-autocorrect"
                                   ${state.config.disableAutocorrect ? 'checked' : ''}>
                            <span class="project-toggle-label">${S.settings.system.autocorrect.label}</span>
                            <span class="project-toggle-hint">${S.settings.system.autocorrect.desc}</span>
                        </label>
                    </div>
                    <div class="system-setting">
                        <label class="project-toggle">
                            <input type="checkbox" id="highlight-thinking-keywords"
                                   ${state.config.highlightThinkingKeywords ? 'checked' : ''}>
                            <span class="project-toggle-label">${S.settings.toggles.highlight_thinking}</span>
                            <span class="project-toggle-hint">${S.settings.toggles.highlight_thinking_hint}</span>
                        </label>
                    </div>
                    <div class="system-setting">
                        <label class="project-toggle">
                            <input type="checkbox" id="annotate-on-paste"
                                   ${state.config.annotateOnPaste ? 'checked' : ''}>
                            <span class="project-toggle-label">${S.settings.toggles.annotate_on_paste}</span>
                            <span class="project-toggle-hint">${S.settings.toggles.annotate_on_paste_hint}</span>
                        </label>
                    </div>
                    <div class="system-setting">
                        <label class="project-toggle">
                            <input type="checkbox" id="shortcut-hints-enabled"
                                   ${getHintsConfig().enabled ? 'checked' : ''}>
                            <span class="project-toggle-label">${S.settings.toggles.shortcut_hints}</span>
                            <span class="project-toggle-hint">${S.settings.toggles.shortcut_hints_hint}</span>
                        </label>
                    </div>
                    <div class="shortcut-hints-picker" id="shortcut-hints-picker">
                        <div class="shortcut-hints-picker-header">
                            <span>${S.shortcut_hints.customize}</span>
                            <button class="system-reset-btn" id="shortcut-hints-reset" type="button">
                                ${S.shortcut_hints.reset}
                            </button>
                        </div>
                        <div class="shortcut-hints-picker-list">
                            ${renderShortcutHintsPicker()}
                        </div>
                    </div>
                </div>
            </div>

            <!-- Terminal tab — settings for the embedded PTY terminal. The
                 control IDs (#terminal-clipboard-write, #terminal-size-w/h,
                 #reset-terminal-size) are queried on the whole container in
                 attachConfigEventHandlers, so the wiring is location-agnostic. -->
            <div class="config-section" data-section="terminal" ${state.activeTab !== 'terminal' ? 'hidden' : ''}>
                <div class="appearance-section">
                    <h3 class="appearance-section-title">${S.settings.sections.terminal_clipboard}</h3>
                    <div class="system-setting">
                        <label class="project-toggle">
                            <input type="checkbox" id="terminal-clipboard-write"
                                   ${state.config.terminalClipboardWrite === true ? 'checked' : ''}>
                            <span class="project-toggle-label">${S.settings.toggles.terminal_clipboard}</span>
                            <span class="project-toggle-hint">${S.settings.toggles.terminal_clipboard_hint}</span>
                        </label>
                    </div>
                </div>
                <div class="appearance-section">
                    <h3 class="appearance-section-title">${S.settings.sections.terminal_floating}</h3>
                    <p class="config-hint">${S.settings.hints.terminal_size_desc}</p>
                    <div class="system-setting">
                        <div class="system-setting-control widget-size-inputs">
                            <input type="number" id="terminal-size-w" class="size-input" min="400" max="2000" step="50"
                                   value="${TerminalWidget.getConfiguredSize().width}">
                            <span class="size-separator">&times;</span>
                            <input type="number" id="terminal-size-h" class="size-input" min="200" max="1200" step="50"
                                   value="${TerminalWidget.getConfiguredSize().height}">
                            <button class="system-reset-btn" id="reset-terminal-size">Reset</button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Quick Actions tab -->
            <div class="config-section" data-section="quickactions" ${state.activeTab !== 'quickactions' ? 'hidden' : ''}>
                ${renderQuickActionsTab()}
            </div>

            <!-- Engines tab (internally data-tab="models") — everything
                 provider-centric renders dynamically from the registry via
                 setupModelsTab; nothing here is hardcoded per engine. -->
            <div class="config-section" data-section="models" ${state.activeTab !== 'models' ? 'hidden' : ''}>
                <div class="system-section">
                    <h3 class="system-section-title">${S.settings.sections.engines}</h3>
                    <div class="engines-list" id="engines-list">
                        <!-- populated by setupModelsTab -->
                    </div>
                    <p class="config-hint" id="engines-hint">${S.settings.hints.engines_hint}</p>
                </div>
                <div class="system-section">
                    <h3 class="system-section-title">${S.settings.sections.engine_settings}</h3>
                    <div class="engine-subtabs" id="engine-subtabs">
                        <!-- one sub-tab per enabled engine, populated by setupModelsTab -->
                    </div>
                    <div class="engine-panel" id="engine-panel">
                        <!-- the selected engine's CLI path, login, catalog, defaults, journal -->
                    </div>
                    <p class="config-hint">${S.settings.hints.models_summary_hint}</p>
                    <button type="button" class="config-action-btn" id="open-auto-journal-from-models">${S.settings.hints.models_summary_link}</button>
                </div>
            </div>

            <!-- System tab -->
            <div class="config-section" data-section="system" ${state.activeTab !== 'system' ? 'hidden' : ''}>
                <div class="system-section">
                    <h3 class="system-section-title">${S.settings.sections.sessions}</h3>
                    <div class="system-setting">
                        <label class="system-setting-label">
                            <span class="system-setting-name">${S.settings.system_labels.session_list_limit}</span>
                            <span class="system-setting-desc">${S.settings.system_labels.session_list_limit_desc}</span>
                        </label>
                        <div class="system-setting-control">
                            <input type="number" id="session-list-limit-input" min="10" max="500" step="10"
                                   value="${state.config.sessionListLimit || CONFIG.DEFAULT_SESSION_LIST_LIMIT}"
                                   class="system-number-input">
                        </div>
                    </div>
                    <div class="system-setting">
                        <label class="system-setting-label">
                            <span class="system-setting-name">${S.settings.system_labels.api_retry_max}</span>
                            <span class="system-setting-desc">${S.settings.system_labels.api_retry_max_desc}</span>
                        </label>
                        <div class="system-setting-control">
                            <input type="number" id="api-retry-max-input" min="0" max="10"
                                   value="3"
                                   class="system-number-input">
                        </div>
                    </div>
                    <div class="system-setting">
                        <label class="project-toggle">
                            <input type="checkbox" id="sigint-on-ask">
                            <span class="project-toggle-label">${S.settings.system_labels.sigint_on_ask}</span>
                            <span class="project-toggle-hint">${S.settings.system_labels.sigint_on_ask_desc}</span>
                        </label>
                    </div>
                </div>
                <div class="system-section">
                    <h3 class="system-section-title">${S.settings.sections.permissions}</h3>
                    <div class="system-setting">
                        <label class="system-setting-label">
                            <span class="system-setting-name">${S.settings.permissions.default_label}</span>
                            <span class="system-setting-desc">${S.settings.system_labels.perm_normal_desc}</span>
                        </label>
                        <div class="system-setting-control">
                            <select id="default-permission-level" class="system-select">
                                ${_permissionOptions()}
                            </select>
                        </div>
                    </div>
                    <p class="config-hint">${S.settings.hints.perm_hint}</p>
                </div>
                <div class="system-section">
                    <h3 class="system-section-title">${S.settings.sections.file_downloads}</h3>
                    <div class="system-setting">
                        <div class="system-setting-label">
                            <span class="system-setting-name">${S.settings.system_labels.download_behavior}</span>
                            <span class="system-setting-desc">${S.settings.system_labels.download_behavior_desc}</span>
                        </div>
                        <div class="system-radio-group" id="download-mode-group">
                            <label class="system-radio-label">
                                <input type="radio" name="downloadMode" value="auto"
                                       ${(state.config.downloadMode || 'auto') === 'auto' ? 'checked' : ''}>
                                <span>${S.settings.download_mode.auto}</span>
                                <span class="system-radio-hint">${S.settings.download_mode.auto_desc}</span>
                            </label>
                            <label class="system-radio-label">
                                <input type="radio" name="downloadMode" value="download"
                                       ${state.config.downloadMode === 'download' ? 'checked' : ''}>
                                <span>${S.settings.download_mode.download}</span>
                                <span class="system-radio-hint">${S.settings.download_mode.download_desc}</span>
                            </label>
                            <label class="system-radio-label">
                                <input type="radio" name="downloadMode" value="copy"
                                       ${state.config.downloadMode === 'copy' ? 'checked' : ''}>
                                <span>${S.settings.download_mode.copy}</span>
                                <span class="system-radio-hint">${S.settings.download_mode.copy_desc}</span>
                            </label>
                        </div>
                    </div>
                </div>
                <div class="system-section">
                    <h3 class="system-section-title">${S.settings.sections.extra_dirs_global}</h3>
                    <p class="config-hint">${S.settings.hints.extra_dirs_global_desc}</p>

                    <div class="extra-dirs-list" id="global-extra-dirs-list">
                        ${renderExtraDirsListHTML(state.globalExtraDirs || [], 'global-extra-dir-remove')}
                    </div>

                    <div class="extra-dir-add-row">
                        <input type="text" id="global-extra-dir-input" class="extra-dir-input"
                               placeholder="/path/to/directory" spellcheck="false" autocomplete="off">
                        <button class="extra-dir-add-btn" id="global-extra-dir-add-btn">Add</button>
                    </div>
                </div>
                <div class="system-section">
                    <h3 class="system-section-title">${S.settings.sections.shadow_git_defaults}</h3>
                    <p class="config-hint">${S.settings.hints.shadow_defaults_hint}</p>
                    <div class="system-setting">
                        <label class="project-toggle">
                            <input type="checkbox" id="shadow-git-default-enabled"
                                   ${state.shadowGitDefaults?.enabled !== false ? 'checked' : ''}>
                            <span class="project-toggle-label">${S.settings.toggles.shadow_git_default}</span>
                        </label>
                    </div>
                    <div class="system-setting">
                        <label class="project-toggle">
                            <input type="checkbox" id="shadow-git-default-rich-commits"
                                   ${state.shadowGitDefaults?.rich_commits !== false ? 'checked' : ''}>
                            <span class="project-toggle-label">${S.settings.toggles.rich_commits_default}</span>
                            <span class="project-toggle-hint">${subModel(S.settings.toggles.rich_commits_default_hint)}</span>
                        </label>
                    </div>
                </div>
            </div>
        </div>
    `;

    attachConfigEventHandlers(container);
    renderShortcutsTab(container);
}

function renderShortcutsTab(container) {
    const shortcutsList = container.querySelector('.shortcuts-list');
    if (shortcutsList && state.shortcutEditor) {
        state.shortcutEditor.render(shortcutsList);
    }
}

/**
 * Render checkbox list for each candidate hint shortcut.
 * Uses the user's current selection from localStorage.
 */
function renderShortcutHintsPicker() {
    const { ids } = getHintsConfig();
    const selected = new Set(ids);
    return HINT_CANDIDATE_IDS.map(id => {
        const sc = SHORTCUTS.find(s => s.id === id);
        if (!sc) return '';
        const keyLabel = (sc.keys && sc.keys[0]) || '';
        const isChecked = selected.has(id);
        return `
            <label class="shortcut-hints-picker-item">
                <input type="checkbox" data-hint-id="${id}" ${isChecked ? 'checked' : ''}>
                <span class="shortcut-hints-picker-key">${escapeHtml(keyLabel)}</span>
                <span class="shortcut-hints-picker-label">${escapeHtml(sc.label || id)}</span>
            </label>
        `;
    }).join('');
}


function attachConfigEventHandlers(container) {
    debug.log('[Config] attachConfigEventHandlers called, container:', container);
    debug.log('[Config] All checkboxes in container:', container.querySelectorAll('input[type="checkbox"]'));
    // Tab switching
    container.querySelectorAll('.config-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab;
            switchTab(container, tabName);
        });
    });

    // Reset all shortcuts — two-click inline confirm (iPad PWA can't
    // be trusted with window.confirm: in standalone mode it sometimes
    // silently no-ops, leaving the button feeling broken).
    const resetAllBtn = container.querySelector('.shortcuts-reset-all');
    if (resetAllBtn) {
        const defaultLabel = S.settings.shortcuts_tab.reset_all;
        const confirmLabel = S.settings.shortcuts_tab.reset_all_confirm;
        let armed = false;
        let armTimer = null;
        const disarm = () => {
            armed = false;
            resetAllBtn.classList.remove('armed');
            resetAllBtn.textContent = defaultLabel;
            if (armTimer) { clearTimeout(armTimer); armTimer = null; }
        };
        resetAllBtn.addEventListener('click', () => {
            if (!armed) {
                armed = true;
                resetAllBtn.classList.add('armed');
                resetAllBtn.textContent = confirmLabel;
                armTimer = setTimeout(disarm, 4000);
                return;
            }
            disarm();
            const shortcutsList = container.querySelector('.shortcuts-list');
            state.shortcutEditor?.resetAll(shortcutsList);
            showToast(S.toast.shortcuts_reset);
        });
        resetAllBtn.addEventListener('blur', disarm);
    }

    // Layout radio buttons
    container.querySelectorAll('input[name="layout"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            state.setLayout(e.target.value);
        });
    });

    // Session list limit input
    const sessionListLimitInput = container.querySelector('#session-list-limit-input');
    if (sessionListLimitInput) {
        sessionListLimitInput.addEventListener('change', (e) => {
            const value = parseInt(e.target.value, 10);
            if (value >= 10 && value <= 500) {
                state.setSessionListLimit(value);
            } else {
                e.target.value = state.config.sessionListLimit || CONFIG.DEFAULT_SESSION_LIST_LIMIT;
            }
        });
    }

    // Disable autocorrect toggle
    const disableAutocorrect = container.querySelector('#disable-autocorrect');
    if (disableAutocorrect) {
        disableAutocorrect.addEventListener('change', (e) => {
            state.setDisableAutocorrect(e.target.checked);
        });
    }

    // Thinking keywords highlighting toggle
    const highlightThinkingKeywords = container.querySelector('#highlight-thinking-keywords');
    if (highlightThinkingKeywords) {
        highlightThinkingKeywords.addEventListener('change', (e) => {
            state.setHighlightThinkingKeywords(e.target.checked);
        });
    }

    // Annotate-images-on-paste toggle
    const annotateOnPaste = container.querySelector('#annotate-on-paste');
    if (annotateOnPaste) {
        annotateOnPaste.addEventListener('change', (e) => {
            state.setAnnotateOnPaste(e.target.checked);
        });
    }

    // Terminal OSC 52 clipboard-write toggle
    const terminalClipboard = container.querySelector('#terminal-clipboard-write');
    if (terminalClipboard) {
        terminalClipboard.addEventListener('change', (e) => {
            state.setTerminalClipboardWrite(e.target.checked);
        });
    }

    // Shortcut hints master toggle
    const hintsEnabled = container.querySelector('#shortcut-hints-enabled');
    const hintsPicker = container.querySelector('#shortcut-hints-picker');
    if (hintsEnabled) {
        hintsEnabled.addEventListener('change', (e) => {
            setHintsEnabled(e.target.checked);
            ShortcutHints.refresh();
            if (hintsPicker) {
                hintsPicker.classList.toggle('disabled', !e.target.checked);
            }
        });
        // Reflect initial state
        if (hintsPicker) {
            hintsPicker.classList.toggle('disabled', !hintsEnabled.checked);
        }
    }

    // Shortcut hints checkboxes — write full ordered list on every change
    container.querySelectorAll('#shortcut-hints-picker input[type="checkbox"][data-hint-id]').forEach(cb => {
        cb.addEventListener('change', () => {
            const checked = Array.from(
                container.querySelectorAll('#shortcut-hints-picker input[type="checkbox"][data-hint-id]:checked')
            ).map(el => el.dataset.hintId);
            // Preserve HINT_CANDIDATE_IDS order (iterate the canonical list, keep only checked)
            const ordered = HINT_CANDIDATE_IDS.filter(id => checked.includes(id));
            setHintIds(ordered);
            ShortcutHints.refresh();
        });
    });

    // Reset shortcut hints to defaults
    const hintsReset = container.querySelector('#shortcut-hints-reset');
    if (hintsReset) {
        hintsReset.addEventListener('click', () => {
            setHintIds(DEFAULT_HINT_IDS.slice());
            // Re-render checkboxes to reflect defaults
            const picker = container.querySelector('.shortcut-hints-picker-list');
            if (picker) picker.innerHTML = renderShortcutHintsPicker();
            // Re-bind checkbox handlers (innerHTML wiped them)
            container.querySelectorAll('#shortcut-hints-picker input[type="checkbox"][data-hint-id]').forEach(cb => {
                cb.addEventListener('change', () => {
                    const checked = Array.from(
                        container.querySelectorAll('#shortcut-hints-picker input[type="checkbox"][data-hint-id]:checked')
                    ).map(el => el.dataset.hintId);
                    const ordered = HINT_CANDIDATE_IDS.filter(id => checked.includes(id));
                    setHintIds(ordered);
                    ShortcutHints.refresh();
                });
            });
            ShortcutHints.refresh();
        });
    }

    // Permission level select (loaded from server API)
    const permSelect = container.querySelector('#default-permission-level');
    if (permSelect) {
        fetch(`${CONFIG.API_BASE || ''}/api/bridge/default-permissions`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (!data) return;
                // The default engine self-describes its modes (e.g. claude-sdk
                // adds "Ask"); rebuild the options from that vocabulary.
                if (Array.isArray(data.modes) && data.modes.length) {
                    permSelect.innerHTML = data.modes.map(m =>
                        `<option value="${m.value}">${m.label}</option>`).join('\n');
                }
                permSelect.value = data.default_level || 'dontAsk';
            })
            .catch(() => {});
        permSelect.addEventListener('change', (e) => {
            fetch(`${CONFIG.API_BASE || ''}/api/bridge/default-permissions`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ permission_level: e.target.value })
            });
            if (window.permissionSettings) {
                window.permissionSettings.globalDefault = e.target.value;
            }
        });
    }

    // Download mode radios
    container.querySelectorAll('input[name="downloadMode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            state.setDownloadMode(e.target.value);
        });
    });

    // Terminal size inputs
    const termW = container.querySelector('#terminal-size-w');
    const termH = container.querySelector('#terminal-size-h');
    const saveTermSize = () => {
        const w = parseInt(termW?.value) || TerminalWidget.DEFAULT_WIDTH;
        const h = parseInt(termH?.value) || TerminalWidget.DEFAULT_HEIGHT;
        TerminalWidget.setConfiguredSize(w, h);
    };
    if (termW) termW.addEventListener('change', saveTermSize);
    if (termH) termH.addEventListener('change', saveTermSize);

    const resetTermBtn = container.querySelector('#reset-terminal-size');
    if (resetTermBtn) {
        resetTermBtn.addEventListener('click', () => {
            TerminalWidget.resetConfiguredSize();
            if (termW) termW.value = TerminalWidget.DEFAULT_WIDTH;
            if (termH) termH.value = TerminalWidget.DEFAULT_HEIGHT;
        });
    }

    // Reset preview size button
    const resetPreviewBtn = container.querySelector('#reset-preview-size');
    if (resetPreviewBtn) {
        resetPreviewBtn.addEventListener('click', () => {
            FilePreviewWidget.resetSize();
            updatePreviewSizeUI(container);
        });
    }


    // Line-wrap toggle — shares the one chat-wide preference with the per-block
    // wrap buttons, so flipping it here restyles every rendered block instantly.
    const codeBlockWrap = container.querySelector('#code-block-wrap');
    if (codeBlockWrap) {
        codeBlockWrap.addEventListener('change', (e) => {
            MarkdownRenderer.setCodeWrap(e.target.checked);
        });
    }

    // Selection in preview toggle
    const selectionInPreview = container.querySelector('#selection-in-preview');
    if (selectionInPreview) {
        selectionInPreview.addEventListener('change', (e) => {
            state.setSelectionInPreview(e.target.checked);
        });
    }

    // Tool collapse mode grid selects
    container.querySelectorAll('.collapse-mode-select').forEach(sel => {
        sel.addEventListener('change', () => {
            state.setCollapseMode(sel.dataset.context, sel.dataset.type, sel.value);
        });
    });

    // Quick Actions tab event handlers
    setupQuickActionsEvents(container);

    // Font scale controls
    const fontDecrease = container.querySelector('#font-decrease');
    const fontIncrease = container.querySelector('#font-increase');
    const fontSizeLabel = container.querySelector('#font-size-label');

    if (fontDecrease) {
        fontDecrease.addEventListener('click', () => {
            window.app?.adjustFontSize(-0.1);
            if (fontSizeLabel && window.app?.fontScale) {
                fontSizeLabel.textContent = `${Math.round(window.app.fontScale * 100)}%`;
            }
        });
    }

    if (fontIncrease) {
        fontIncrease.addEventListener('click', () => {
            window.app?.adjustFontSize(0.1);
            if (fontSizeLabel && window.app?.fontScale) {
                fontSizeLabel.textContent = `${Math.round(window.app.fontScale * 100)}%`;
            }
        });
    }

    // Floating buttons opacity slider
    const floatingOpacitySlider = container.querySelector('#floating-opacity-slider');
    const floatingOpacityLabel = container.querySelector('#floating-opacity-label');

    if (floatingOpacitySlider) {
        floatingOpacitySlider.addEventListener('input', (e) => {
            const value = parseInt(e.target.value, 10);
            const opacity = value / 100;
            // Update label immediately for feedback
            if (floatingOpacityLabel) {
                floatingOpacityLabel.textContent = `${value}%`;
            }
            // Apply the opacity
            applyFloatingButtonsOpacity(opacity);
            // Save to config
            state.config.floatingButtonsOpacity = opacity;
            state.save();
        });
    }

    // Engines tab (list, sub-tabs, per-engine panel incl. session defaults)
    setupModelsTab(container);

    // API retry max controls
    setupApiRetryControls(container);

    // Stop-on-AskUserQuestion toggle
    setupSigintOnAskControls(container);

    // Project settings handlers
    const shadowGitEnabled = container.querySelector('#shadow-git-enabled');
    debug.log('[Config] shadowGitEnabled element:', shadowGitEnabled);
    if (shadowGitEnabled) {
        shadowGitEnabled.addEventListener('change', async (e) => {
            debug.log('[Config] shadowGitEnabled changed:', e.target.checked);
            await state.saveProjectConfig({
                shadow_git: {
                    ...state.projectConfig?.shadow_git,
                    enabled: e.target.checked
                }
            });
        });
    }

    const shadowGitRichCommits = container.querySelector('#shadow-git-rich-commits');
    if (shadowGitRichCommits) {
        shadowGitRichCommits.addEventListener('change', async (e) => {
            await state.saveProjectConfig({
                shadow_git: {
                    ...state.projectConfig?.shadow_git,
                    rich_commits: e.target.checked
                }
            });
        });
    }

    // Extra directories handlers (project) - in-place update, no full re-render
    const projectDirOpts = {
        inputId: 'extra-dir-input',
        btnId: 'extra-dir-add-btn',
        listId: 'extra-dirs-list',
        removeClass: 'extra-dir-remove',
        getDirsFn: () => state.projectConfig?.extra_dirs || [],
        saveFn: async (dirs) => { await state.saveProjectConfig({ extra_dirs: dirs }); },
    };
    setupExtraDirAddHandler(container, projectDirOpts);
    // Attach initial remove handlers
    updateExtraDirsInPlace(container, { ...projectDirOpts, dirs: projectDirOpts.getDirsFn() });

    // Global shadow git defaults handlers
    const shadowGitDefaultEnabled = container.querySelector('#shadow-git-default-enabled');
    if (shadowGitDefaultEnabled) {
        shadowGitDefaultEnabled.addEventListener('change', async (e) => {
            await state.saveShadowGitDefaults({
                ...state.shadowGitDefaults,
                enabled: e.target.checked
            });
        });
    }

    const shadowGitDefaultRichCommits = container.querySelector('#shadow-git-default-rich-commits');
    if (shadowGitDefaultRichCommits) {
        shadowGitDefaultRichCommits.addEventListener('change', async (e) => {
            await state.saveShadowGitDefaults({
                ...state.shadowGitDefaults,
                rich_commits: e.target.checked
            });
        });
    }

    // Global extra directories handlers - in-place update, no full re-render
    const globalDirOpts = {
        inputId: 'global-extra-dir-input',
        btnId: 'global-extra-dir-add-btn',
        listId: 'global-extra-dirs-list',
        removeClass: 'global-extra-dir-remove',
        getDirsFn: () => state.globalExtraDirs || [],
        saveFn: async (dirs) => { await state.saveGlobalExtraDirs(dirs); },
    };
    setupExtraDirAddHandler(container, globalDirOpts);
    updateExtraDirsInPlace(container, { ...globalDirOpts, dirs: globalDirOpts.getDirsFn() });

    // Commit sections handlers
    setupCommitSectionsHandlers(container);
}

function switchTab(container, tabName) {
    state.activeTab = tabName;

    // Update tab buttons
    container.querySelectorAll('.config-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });

    // Update sections
    container.querySelectorAll('.config-section').forEach(section => {
        section.hidden = section.dataset.section !== tabName;
    });

    // Auto-focus search input when switching to shortcuts tab
    if (tabName === 'shortcuts') {
        setTimeout(() => {
            const searchInput = container.querySelector('.shortcuts-search-input');
            if (searchInput) {
                searchInput.focus();
                debug.log('[Config] switchTab: Focused shortcuts search input');
            }
        }, 50);
    }
}

/**
 * Cycle through settings tabs (for Ctrl+[/] navigation)
 * @param {HTMLElement} container - The config widget container
 * @param {number} direction - -1 for previous, 1 for next
 */
function cycleSettingsTab(container, direction) {
    // Get visible tabs in DOM order
    const tabs = Array.from(container.querySelectorAll('.config-tab'));
    if (tabs.length === 0) return;

    // Find current active tab index
    const currentIndex = tabs.findIndex(tab => tab.classList.contains('active'));
    if (currentIndex === -1) return;

    // Calculate new index with wrap-around
    const newIndex = (currentIndex + direction + tabs.length) % tabs.length;
    const newTabName = tabs[newIndex].dataset.tab;

    switchTab(container, newTabName);
}

/**
 * Switch to settings tab by index (for Ctrl+1-9 navigation)
 * @param {HTMLElement} container - The config widget container
 * @param {number} index - 0-based tab index
 */
function switchToSettingsTabByIndex(container, index) {
    const tabs = Array.from(container.querySelectorAll('.config-tab'));
    if (index >= 0 && index < tabs.length) {
        const tabName = tabs[index].dataset.tab;
        switchTab(container, tabName);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Custom Keyboard Handler
// ═══════════════════════════════════════════════════════════════════════════

let keydownHandler = null;

function handleConfigKeydown(e) {
    const widget = WidgetManager.widgets.get('config');
    if (!widget?.isVisible) return;

    // While capturing a shortcut, hand every key (including Escape) to the
    // editor so users can bind Cmd+[, Cmd+1-9, Escape, etc. without this
    // handler stealing them for settings-tab navigation.
    if (state.shortcutEditor?.capturing) return;

    // Handle Escape (close panel)
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        widget.close();
        return;
    }

    // Handle Ctrl/Cmd + key combinations
    const hasModifier = e.ctrlKey || e.metaKey;
    if (hasModifier && !e.altKey && !e.shiftKey) {
        // Ctrl+[ / Cmd+[ (previous tab)
        if (e.key === '[') {
            e.preventDefault();
            e.stopImmediatePropagation();
            cycleSettingsTab(state.container, -1);
            return;
        }
        // Ctrl+] / Cmd+] (next tab)
        if (e.key === ']') {
            e.preventDefault();
            e.stopImmediatePropagation();
            cycleSettingsTab(state.container, 1);
            return;
        }
        // Ctrl+1-9 / Cmd+1-9 (jump to tab by index)
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= 9) {
            e.preventDefault();
            e.stopImmediatePropagation();
            switchToSettingsTabByIndex(state.container, num - 1);
            return;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Widget Registration
// ═══════════════════════════════════════════════════════════════════════════

export function registerConfigWidget() {
    state.shortcutEditor = new ShortcutEditor();

    WidgetManager.register('config', {
        // type: 'modal' is load-bearing — the inline `position: fixed` overlays
        // below (`.config-modal-overlay`, `.qa-add-dialog`, `.section-edit-modal`)
        // are appended to this widget's container, not document.body. Floating
        // widgets apply `transform: scale(1)`, which would create a containing
        // block and trap those overlays inside the widget bounds. If converting
        // to 'floating', append those overlays to document.body instead.
        type: 'modal',
        title: S.widgets.titles.settings,
        icon: 'settings',
        scope: 'global',

        // Modal options
        closeOnBackdrop: true,
        closeOnEscape: false,  // We handle escape manually for capture mode
        width: '500px',
        maxWidth: '95vw',
        maxHeight: '85vh',

        // No transform for modal
        allowTransform: false,

        render: renderConfigPanel,

        onOpen: async () => {
            // Check for tab requested via WidgetManager.open context (works across module instances)
            const widget = WidgetManager.get('config');
            const contextTab = widget?._openContext?.tab;
            const requestedTab = contextTab || (state._tabSelected ? state.activeTab : null);
            state._tabSelected = false;

            // Switch to requested tab IMMEDIATELY (before async loading)
            if (requestedTab && state.container) {
                switchTab(state.container, requestedTab);
            }

            // Load configs in parallel
            const promises = [state.loadShadowGitDefaults(), state.loadGlobalExtraDirs()];
            if (state.hasActiveProject()) {
                promises.push(state.loadProjectConfig());
            }
            await Promise.all(promises);

            // Load commit sections after project config (needs project hash)
            if (state.hasActiveProject() && state.projectInfo?.hash) {
                await state.loadCommitSections();
                // Update sections count badge and refresh editor if expanded
                if (state.container) {
                    updateSectionsCount(state.container);
                    // Refresh editor content if sections are expanded (fixes loading state stuck)
                    if (state.commitSectionsExpanded && state.commitSections) {
                        const editor = state.container.querySelector('#commit-sections-editor');
                        if (editor) {
                            editor.innerHTML = renderCommitSectionsEditor(state);
                            setupCommitSectionItemHandlers(state.container);
                        }
                    }
                }
            }

            // Check if widget was rendered (has content with checkboxes)
            // If not, render now. This handles the case where:
            // 1. Widget was created without a session (no setSession render trigger)
            // 2. Widget is reopened and sessionId hasn't changed
            const container = state.container;
            const hasCheckboxes = container?.querySelector('#shadow-git-enabled') ||
                                  container?.querySelector('#shadow-git-default-enabled');

            if (!hasCheckboxes) {
                // Need full render - widget content is empty
                debug.log('[Config] onOpen: no checkboxes found, triggering full render');
                WidgetManager.update('config');
            } else {
                // Widget already rendered - just sync checkbox states
                // WITHOUT full re-render (which would destroy event handlers)
                if (state.projectConfig) {
                    const sgEnabled = container.querySelector('#shadow-git-enabled');
                    const sgRich = container.querySelector('#shadow-git-rich-commits');

                    if (sgEnabled) sgEnabled.checked = state.projectConfig.shadow_git?.enabled !== false;
                    if (sgRich) sgRich.checked = state.projectConfig.shadow_git?.rich_commits !== false;
                }

                if (state.shadowGitDefaults) {
                    const defEnabled = container.querySelector('#shadow-git-default-enabled');
                    const defRich = container.querySelector('#shadow-git-default-rich-commits');

                    if (defEnabled) defEnabled.checked = state.shadowGitDefaults.enabled !== false;
                    if (defRich) defRich.checked = state.shadowGitDefaults.rich_commits !== false;
                }

                // Sync extra dirs lists (they may have loaded after initial render)
                if (state.projectConfig) {
                    updateExtraDirsInPlace(container, {
                        listId: 'extra-dirs-list',
                        dirs: state.projectConfig.extra_dirs || [],
                        removeClass: 'extra-dir-remove',
                        getDirsFn: () => state.projectConfig?.extra_dirs || [],
                        saveFn: async (dirs) => { await state.saveProjectConfig({ extra_dirs: dirs }); },
                    });
                }
                updateExtraDirsInPlace(container, {
                    listId: 'global-extra-dirs-list',
                    dirs: state.globalExtraDirs || [],
                    removeClass: 'global-extra-dir-remove',
                    getDirsFn: () => state.globalExtraDirs || [],
                    saveFn: async (dirs) => { await state.saveGlobalExtraDirs(dirs); },
                });
                debug.log('[Config] onOpen: synced checkbox states and extra dirs from loaded config');
            }

            // Add custom keyboard handler (Escape, Ctrl+[/] for tab navigation)
            keydownHandler = handleConfigKeydown;
            document.addEventListener('keydown', keydownHandler, true);

            // Setup swipe gestures for settings tabs
            if (state.container) {
                setupConfigGestures(state.container, (direction) => cycleSettingsTab(state.container, direction));
            }

            // Disable main shortcut handler while config is open
            if (window.app?.shortcutManager) {
                window.app.shortcutManager.enabled = false;
            }

            // Sync font scale label
            const fontSizeLabel = state.container?.querySelector('#font-size-label');
            if (fontSizeLabel && window.app?.fontScale) {
                fontSizeLabel.textContent = `${Math.round(window.app.fontScale * 100)}%`;
            }

            // Switch to requested tab (e.g. "Customize..." → quickactions)
            if (requestedTab && state.container) {
                switchTab(state.container, requestedTab);
            }

            // Auto-focus search input if on shortcuts tab
            if (state.activeTab === 'shortcuts' && state.container) {
                setTimeout(() => {
                    const searchInput = state.container.querySelector('.shortcuts-search-input');
                    if (searchInput) {
                        searchInput.focus();
                        debug.log('[Config] onOpen: Focused shortcuts search input');
                    }
                }, 100);
            }
        },

        onClose: () => {
            // Remove custom keyboard handler
            if (keydownHandler) {
                document.removeEventListener('keydown', keydownHandler, true);
                keydownHandler = null;
            }

            // Cleanup swipe gestures
            if (state.container) {
                cleanupConfigGestures(state.container);
            }

            // Cancel any active capture
            state.shortcutEditor?.cancelCapture();

            // Re-enable main shortcut handler
            if (window.app?.shortcutManager) {
                window.app.shortcutManager.enabled = true;
            }
        },
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Exports for app.js compatibility
// ═══════════════════════════════════════════════════════════════════════════

export function getConfigState() {
    return state;
}

export function toggleConfigPanel() {
    WidgetManager.toggle('config');
}

export function showConfigPanel(tab = null) {
    if (tab) {
        state.activeTab = tab;
        state._tabSelected = true; // Prevent auto-switch to project tab
    }
    WidgetManager.open('config', tab ? { tab } : undefined);
}

export function hideConfigPanel() {
    WidgetManager.close('config');
}
