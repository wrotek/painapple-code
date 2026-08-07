/**
 * Quick Actions tab — radial-FAB editor (visibility, options, preset
 * picker, slot layout, action picker dialog). All state lives outside
 * config-widget — `quickActionsMenu` is the source of truth, this module
 * just renders + wires events.
 *
 * The `editingSlotIndex` closure inside `setupQuickActionsEvents` tracks
 * which radial slot the action picker dialog is currently editing; the
 * dialog reuses one DOM subtree across "add new" and "replace existing"
 * by toggling `data-editing-slot` on the dialog element.
 */

import S from '../../strings.js';
import { escapeHtml } from '../../utils.js';
import { quickActionsMenu, QUICK_ACTION_PRESETS, getSlotKeyLabel } from '../../quick-actions-menu.js';
import { QuickActionsRegistry, CUSTOM_ACTION_TYPES } from '../../quick-actions-registry.js';

/**
 * Render the Quick Actions configuration tab
 */
export function renderQuickActionsTab() {
    const config = quickActionsMenu.getConfig();
    const currentPreset = config.preset || 'balanced';
    const slots = config.slots || [];

    // Build preset buttons
    const presetButtons = Object.entries(QUICK_ACTION_PRESETS).map(([id, preset]) => `
        <button class="qa-preset-btn ${currentPreset === id ? 'active' : ''}" data-preset="${id}" data-tooltip="${preset.description}">
            ${preset.name}
        </button>
    `).join('');

    // Build interactive radial editor (clickable slots)
    const RADIAL_RADIUS = 60;
    const radialSlots = [];
    const maxSlots = 8;

    for (let i = 0; i < maxSlots; i++) {
        const angle = (-3 * Math.PI / 4) + (i * (2 * Math.PI / maxSlots));
        const x = Math.cos(angle) * RADIAL_RADIUS;
        const y = Math.sin(angle) * RADIAL_RADIUS;
        const slotKey = getSlotKeyLabel(i, maxSlots);
        const actionId = slots[i];
        const action = actionId ? QuickActionsRegistry.get(actionId) : null;
        const isEmpty = !action;

        radialSlots.push(`
            <div class="qa-radial-slot ${isEmpty ? 'empty' : ''}"
                 data-slot="${i}"
                 style="transform: translate(${x}px, ${y}px)"
                 data-tooltip="${action ? action.label : 'Add action'}">
                <span class="qa-radial-key">${slotKey}</span>
                ${isEmpty ? `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="12" y1="8" x2="12" y2="16"/>
                        <line x1="8" y1="12" x2="16" y2="12"/>
                    </svg>
                ` : `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        ${getQuickActionIcon(action.icon)}
                    </svg>
                `}
            </div>
        `);
    }

    // Build table rows for slot list
    const slotRows = slots.map((actionId, index) => {
        const action = QuickActionsRegistry.get(actionId);
        if (!action) return '';
        const slotKey = getSlotKeyLabel(index, slots.length);
        const isFirst = index === 0;
        const isLast = index === slots.length - 1;

        return `
            <tr class="qa-slot-row" data-index="${index}" data-action-id="${actionId}">
                <td class="qa-slot-cell-key">
                    <span class="qa-slot-key-badge">${slotKey}</span>
                </td>
                <td class="qa-slot-cell-action">
                    <span class="qa-slot-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            ${getQuickActionIcon(action.icon)}
                        </svg>
                    </span>
                    <span class="qa-slot-label">${action.label}</span>
                </td>
                <td class="qa-slot-cell-actions">
                    <button class="qa-slot-btn qa-slot-up" data-index="${index}" ${isFirst ? 'disabled' : ''} data-tooltip="Move up">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="18 15 12 9 6 15"/>
                        </svg>
                    </button>
                    <button class="qa-slot-btn qa-slot-down" data-index="${index}" ${isLast ? 'disabled' : ''} data-tooltip="Move down">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="6 9 12 15 18 9"/>
                        </svg>
                    </button>
                    <button class="qa-slot-btn qa-slot-remove" data-index="${index}" data-tooltip="Remove">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    const currentVisibility = quickActionsMenu.getVisibility();
    const visibilityModes = [
        { id: 'always', label: S.settings.qa_editor.visibility_always },
        { id: 'mobile', label: S.settings.qa_editor.visibility_mobile },
        { id: 'disabled', label: S.settings.qa_editor.visibility_disabled },
    ];
    const visibilityButtons = visibilityModes.map(m => `
        <button class="qa-visibility-btn ${currentVisibility === m.id ? 'active' : ''}" data-visibility="${m.id}">
            ${m.label}
        </button>
    `).join('');

    return `
        <div class="quick-actions-config">
            <div class="qa-section">
                <h3 class="qa-section-title">${S.settings.qa_editor.visibility}</h3>
                <p class="config-hint">${S.settings.qa_editor.visibility_hint}</p>
                <div class="qa-visibility-group" id="qa-visibility-group">
                    ${visibilityButtons}
                </div>
            </div>

            <div class="qa-section">
                <h3 class="qa-section-title">${S.settings.qa_editor.options}</h3>
                <label class="project-toggle">
                    <input type="checkbox" id="qa-context-aware" ${config.options?.contextAware ? 'checked' : ''}>
                    <span class="project-toggle-label">${S.settings.qa_editor.context_aware}</span>
                    <span class="project-toggle-hint">${S.settings.qa_editor.context_aware_hint}</span>
                </label>
                <label class="project-toggle">
                    <input type="checkbox" id="qa-show-tooltips" ${config.options?.showTooltips !== false ? 'checked' : ''}>
                    <span class="project-toggle-label">${S.settings.qa_editor.show_tooltips}</span>
                    <span class="project-toggle-hint">${S.settings.qa_editor.show_tooltips_hint}</span>
                </label>
                <label class="project-toggle">
                    <input type="checkbox" id="qa-drag-release" ${config.options?.dragRelease ? 'checked' : ''}>
                    <span class="project-toggle-label">${S.settings.qa_editor.drag_release}</span>
                    <span class="project-toggle-hint">${S.settings.qa_editor.drag_release_hint}</span>
                </label>
                <label class="project-toggle">
                    <input type="checkbox" id="qa-haptic" ${config.options?.hapticFeedback !== false ? 'checked' : ''}>
                    <span class="project-toggle-label">${S.settings.qa_editor.haptic}</span>
                    <span class="project-toggle-hint">${S.settings.qa_editor.haptic_hint}</span>
                </label>
            </div>

            <div class="qa-section">
                <h3 class="qa-section-title">${S.settings.qa_editor.preset}</h3>
                <p class="config-hint">Choose a preset or customize your own.</p>
                <div class="qa-preset-grid">
                    ${presetButtons}
                </div>
            </div>

            <div class="qa-section">
                <h3 class="qa-section-title">${S.settings.qa_editor.layout}</h3>
                <p class="config-hint">Click a slot to change its action.</p>
                <div class="qa-radial-editor">
                    <div class="qa-radial-center">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                        </svg>
                    </div>
                    ${radialSlots.join('')}
                </div>
            </div>

            <div class="qa-section">
                <h3 class="qa-section-title">${S.settings.qa_editor.actions}</h3>
                <div class="qa-slots-table-wrap">
                    <table class="qa-slots-table">
                        <thead>
                            <tr>
                                <th>${S.settings.qa_editor.table_key}</th>
                                <th>${S.settings.qa_editor.table_action}</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody id="qa-slots-list">
                            ${slotRows}
                        </tbody>
                    </table>
                </div>
                <button class="qa-add-btn" id="qa-add-action" ${slots.length >= 8 ? 'disabled' : ''}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="8" x2="12" y2="16"/>
                        <line x1="8" y1="12" x2="16" y2="12"/>
                    </svg>
                    Add Action
                    <span class="qa-slots-count">${slots.length}/8</span>
                </button>
            </div>

            <div class="qa-section">
                <h3 class="qa-section-title">${S.settings.qa_editor.custom_title}</h3>
                <p class="config-hint">${S.settings.qa_editor.custom_hint}</p>
                <div class="qa-custom-list" id="qa-custom-list">
                    ${renderCustomActionsList()}
                </div>
                <button class="qa-add-btn" id="qa-add-custom">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="8" x2="12" y2="16"/>
                        <line x1="8" y1="12" x2="16" y2="12"/>
                    </svg>
                    ${S.settings.qa_editor.custom_add}
                </button>
            </div>

            <div class="qa-section">
                <button class="qa-reset-btn" id="qa-reset-position">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                        <path d="M3 3v5h5"/>
                    </svg>
                    ${S.settings.qa_editor.reset_fab}
                </button>
            </div>
        </div>

        <!-- Action Picker Dialog -->
        <div class="qa-add-dialog" id="qa-add-dialog" hidden>
            <div class="qa-add-dialog-content">
                <div class="qa-add-dialog-header">
                    <h3 id="qa-dialog-title">${S.settings.qa_editor.select_action}</h3>
                    <button class="qa-add-dialog-close" id="qa-add-dialog-close">×</button>
                </div>
                <div class="qa-add-dialog-search">
                    <input type="text" id="qa-action-search" placeholder="${S.settings.qa_editor.search_placeholder}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
                </div>
                <div class="qa-add-dialog-list" id="qa-action-list">
                    ${renderActionPickerList(slots)}
                </div>
            </div>
        </div>

        <!-- Custom Action Editor Dialog -->
        <div class="qa-add-dialog" id="qa-custom-dialog" hidden>
            <div class="qa-add-dialog-content">
                <div class="qa-add-dialog-header">
                    <h3 id="qa-custom-dialog-title">${S.settings.qa_editor.custom_new_title}</h3>
                    <button class="qa-add-dialog-close" id="qa-custom-dialog-close">×</button>
                </div>
                <div class="qa-custom-form">
                    <label class="qa-custom-field">
                        <span class="qa-custom-field-label">${S.settings.qa_editor.custom_label}</span>
                        <input type="text" id="qa-custom-label" maxlength="24"
                               placeholder="${S.settings.qa_editor.custom_label_placeholder}"
                               autocomplete="off" autocorrect="off" spellcheck="false">
                    </label>
                    <div class="qa-custom-field">
                        <span class="qa-custom-field-label">${S.settings.qa_editor.custom_type}</span>
                        <div class="qa-custom-type-group" id="qa-custom-type-group">
                            ${CUSTOM_ACTION_TYPES.map(t => `
                                <button class="qa-custom-type-btn" data-type="${t}">${S.settings.qa_editor.custom_types[t]}</button>
                            `).join('')}
                        </div>
                    </div>
                    <label class="qa-custom-field">
                        <span class="qa-custom-field-label">${S.settings.qa_editor.custom_payload}</span>
                        <textarea id="qa-custom-payload" rows="3" spellcheck="false"></textarea>
                    </label>
                    <div class="qa-custom-field">
                        <span class="qa-custom-field-label">${S.settings.qa_editor.custom_icon}</span>
                        <div class="qa-custom-icon-grid" id="qa-custom-icon-grid">
                            ${CUSTOM_ICON_CHOICES.map(name => `
                                <button class="qa-custom-icon-btn" data-icon="${name}" data-tooltip="${name}">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        ${getQuickActionIcon(name)}
                                    </svg>
                                </button>
                            `).join('')}
                        </div>
                    </div>
                    <div class="qa-custom-form-actions">
                        <button class="qa-custom-cancel" id="qa-custom-cancel">${S.settings.qa_editor.custom_cancel}</button>
                        <button class="qa-custom-save" id="qa-custom-save">${S.settings.qa_editor.custom_save}</button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

/**
 * Render the custom actions management list
 */
function renderCustomActionsList() {
    const customs = quickActionsMenu.getCustomActions();
    if (customs.length === 0) {
        return `<div class="qa-custom-empty">${S.settings.qa_editor.custom_empty}</div>`;
    }

    return customs.map(def => {
        const typeName = S.settings.qa_editor.custom_types[def.type] || def.type;
        const payload = def.payload || '';
        const preview = payload.length > 48 ? payload.slice(0, 48) + '…' : payload;
        return `
            <div class="qa-custom-row" data-custom-id="${escapeHtml(def.id)}">
                <span class="qa-slot-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        ${getQuickActionIcon(def.icon)}
                    </svg>
                </span>
                <span class="qa-custom-info">
                    <span class="qa-custom-label-text">${escapeHtml(def.label)}</span>
                    <span class="qa-custom-payload-preview"><span class="qa-custom-type-badge" data-type="${escapeHtml(def.type)}">${typeName}</span> ${escapeHtml(preview)}</span>
                </span>
                <button class="qa-slot-btn qa-custom-edit" data-custom-id="${escapeHtml(def.id)}" data-tooltip="${S.settings.qa_editor.custom_edit_title}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                    </svg>
                </button>
                <button class="qa-slot-btn qa-custom-delete" data-custom-id="${escapeHtml(def.id)}" data-tooltip="${S.settings.qa_editor.custom_delete}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                    <span class="qa-custom-delete-label" hidden>${S.settings.qa_editor.custom_delete_confirm}</span>
                </button>
            </div>
        `;
    }).join('');
}

/**
 * Get SVG path for quick action icon
 */
function getQuickActionIcon(iconName) {
    const icons = {
        'plus-circle': '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
        'x': '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
        'git-branch': '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
        'terminal': '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
        'folder': '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
        'git-merge': '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
        'bug': '<path d="M8 2l1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3 3 0 1 1 6 0v1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6M12 20v-9"/>',
        'square': '<rect x="3" y="3" width="18" height="18" rx="2"/>',
        'dollar-sign': '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
        'coins': '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
        'activity': '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
        'settings': '<circle cx="12" cy="12" r="3"/>',
        'help-circle': '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
        'file-diff': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>',
        'message-circle': '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
        'search': '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
        'trash-2': '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
        'scroll': '<path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4"/><path d="M19 3H9a2 2 0 0 0-2 2v11a2 2 0 0 1 2-2h8"/>',
        'play': '<polygon points="5 3 19 12 5 21 5 3"/>',
        'package': '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>',
        'database': '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
        'image': '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
        'clipboard': '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
        'copy': '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
        'chevrons-down': '<polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/>',
        'chevrons-up': '<polyline points="17 11 12 6 7 11"/><polyline points="17 18 12 13 7 18"/>',
        'bookmark-plus': '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/><line x1="12" y1="7" x2="12" y2="13"/><line x1="9" y1="10" x2="15" y2="10"/>',
        'wifi': '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
        'refresh-cw': '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
        'maximize': '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
        'home': '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
        'star': '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
        'clock': '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
        'slash': '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
        'check-circle': '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
        'git-commit': '<circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/>',
        'git-pull-request': '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/>',
        'check-square': '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
        'share-2': '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
        'plus-square': '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
        'minimize-2': '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>',
        'maximize-2': '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
        'edit': '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
        'code': '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
        'bookmark': '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
        'bookmark-minus': '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/><line x1="9" y1="10" x2="15" y2="10"/>',
        'file-plus': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>',
        'paperclip': '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
        'camera': '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
        'folder-open': '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M2 10h20"/>',
        'arrow-left': '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
        'moon': '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
        'chevron-left': '<polyline points="15 18 9 12 15 6"/>',
        'chevron-right': '<polyline points="9 18 15 12 9 6"/>',
        'edit-3': '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
        'zap': '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    };
    return icons[iconName] || icons['help-circle'];
}

// Icon choices offered in the custom-action editor. Every name must exist in
// BOTH this tab's getQuickActionIcon map and quick-actions-menu's ICONS map.
const CUSTOM_ICON_CHOICES = [
    'zap', 'terminal', 'play', 'code', 'star', 'package',
    'database', 'git-merge', 'search', 'clock', 'refresh-cw', 'folder',
];

/**
 * Render the action picker list for the add dialog
 */
function renderActionPickerList(currentSlots, searchTerm = '') {
    const categories = QuickActionsRegistry.getAllCategories();
    let html = '';

    for (const category of categories) {
        const actions = QuickActionsRegistry.getByCategory(category);
        const filteredActions = actions.filter(a => {
            if (currentSlots.includes(a.id)) return false; // Already in slots
            if (searchTerm && !a.label.toLowerCase().includes(searchTerm.toLowerCase()) &&
                !a.description.toLowerCase().includes(searchTerm.toLowerCase())) return false;
            return true;
        });

        if (filteredActions.length === 0) continue;

        html += `<div class="qa-action-category">${category}</div>`;
        for (const action of filteredActions) {
            html += `
                <div class="qa-action-option" data-action-id="${action.id}">
                    <span class="qa-action-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            ${getQuickActionIcon(action.icon)}
                        </svg>
                    </span>
                    <span class="qa-action-info">
                        <span class="qa-action-label">${action.label}</span>
                        <span class="qa-action-desc">${action.description}</span>
                    </span>
                    ${action.shortcut ? `<span class="qa-action-shortcut">${action.shortcut}</span>` : ''}
                </div>
            `;
        }
    }

    return html || '<div class="qa-no-actions">No actions available</div>';
}

/**
 * Setup event handlers for Quick Actions configuration tab
 */
export function setupQuickActionsEvents(container) {
    // Track which slot we're editing (null = adding new)
    let editingSlotIndex = null;

    // Visibility selector
    container.querySelectorAll('.qa-visibility-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.visibility;
            quickActionsMenu.setVisibility(mode);
            container.querySelectorAll('.qa-visibility-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.visibility === mode);
            });
        });
    });

    // Preset buttons
    container.querySelectorAll('.qa-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const presetId = btn.dataset.preset;
            quickActionsMenu.applyPreset(presetId);
            // Re-render the quick actions section
            refreshQuickActionsTab(container);
        });
    });

    // Radial slot clicks - open action picker for that slot
    container.querySelectorAll('.qa-radial-slot').forEach(slot => {
        slot.addEventListener('click', () => {
            const slotIndex = parseInt(slot.dataset.slot, 10);
            const config = quickActionsMenu.getConfig();
            const isEmpty = slotIndex >= config.slots.length;

            editingSlotIndex = isEmpty ? null : slotIndex;

            // Update dialog title
            const dialogTitle = container.querySelector('#qa-dialog-title');
            if (dialogTitle) {
                dialogTitle.textContent = isEmpty ? S.settings.qa_editor.add_action : S.settings.qa_editor.replace_slot.replace('{key}', getSlotKeyLabel(slotIndex, 8));
            }

            // Show dialog
            const dialog = container.querySelector('#qa-add-dialog');
            if (dialog) {
                dialog.dataset.editingSlot = isEmpty ? '' : slotIndex;
                dialog.hidden = false;
                const searchInput = dialog.querySelector('#qa-action-search');
                if (searchInput) {
                    searchInput.value = '';
                    searchInput.focus();
                }
                // Refresh action list (if editing, show all actions; if adding, exclude existing)
                const listContainer = container.querySelector('#qa-action-list');
                if (listContainer) {
                    listContainer.innerHTML = renderActionPickerList(
                        isEmpty ? config.slots : [], // Show all actions when replacing
                        ''
                    );
                    attachActionPickerClickHandlers(container, editingSlotIndex);
                }
            }
        });
    });

    // Slot row clicks - open action picker to replace
    container.querySelectorAll('.qa-slot-row').forEach(row => {
        row.addEventListener('click', (e) => {
            // Don't trigger if clicking buttons
            if (e.target.closest('.qa-slot-btn')) return;

            const slotIndex = parseInt(row.dataset.index, 10);
            editingSlotIndex = slotIndex;

            const dialogTitle = container.querySelector('#qa-dialog-title');
            if (dialogTitle) {
                dialogTitle.textContent = `Replace Slot ${getSlotKeyLabel(slotIndex, 8)}`;
            }

            const dialog = container.querySelector('#qa-add-dialog');
            if (dialog) {
                dialog.dataset.editingSlot = slotIndex;
                dialog.hidden = false;
                const searchInput = dialog.querySelector('#qa-action-search');
                if (searchInput) {
                    searchInput.value = '';
                    searchInput.focus();
                }
                // Show all actions when replacing
                const listContainer = container.querySelector('#qa-action-list');
                if (listContainer) {
                    listContainer.innerHTML = renderActionPickerList([], '');
                    attachActionPickerClickHandlers(container, slotIndex);
                }
            }
        });
    });

    // Move up buttons
    container.querySelectorAll('.qa-slot-up').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const index = parseInt(btn.dataset.index, 10);
            if (index <= 0) return;

            const config = quickActionsMenu.getConfig();
            const newSlots = [...config.slots];
            [newSlots[index - 1], newSlots[index]] = [newSlots[index], newSlots[index - 1]];
            quickActionsMenu.setConfig({ ...config, slots: newSlots, preset: 'custom' });
            refreshQuickActionsTab(container);
        });
    });

    // Move down buttons
    container.querySelectorAll('.qa-slot-down').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const index = parseInt(btn.dataset.index, 10);
            const config = quickActionsMenu.getConfig();
            if (index >= config.slots.length - 1) return;

            const newSlots = [...config.slots];
            [newSlots[index], newSlots[index + 1]] = [newSlots[index + 1], newSlots[index]];
            quickActionsMenu.setConfig({ ...config, slots: newSlots, preset: 'custom' });
            refreshQuickActionsTab(container);
        });
    });

    // Slot remove buttons
    container.querySelectorAll('.qa-slot-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const index = parseInt(btn.dataset.index, 10);
            const config = quickActionsMenu.getConfig();
            const newSlots = config.slots.filter((_, i) => i !== index);
            quickActionsMenu.setConfig({ ...config, slots: newSlots, preset: 'custom' });
            refreshQuickActionsTab(container);
        });
    });

    // Add Action button
    const addBtn = container.querySelector('#qa-add-action');
    if (addBtn) {
        addBtn.addEventListener('click', () => {
            editingSlotIndex = null;

            const dialogTitle = container.querySelector('#qa-dialog-title');
            if (dialogTitle) {
                dialogTitle.textContent = S.settings.qa_editor.add_action;
            }

            const dialog = container.querySelector('#qa-add-dialog');
            if (dialog) {
                dialog.dataset.editingSlot = '';
                dialog.hidden = false;
                const searchInput = dialog.querySelector('#qa-action-search');
                if (searchInput) {
                    searchInput.value = '';
                    searchInput.focus();
                }
                // Show only actions not already in slots
                const config = quickActionsMenu.getConfig();
                const listContainer = container.querySelector('#qa-action-list');
                if (listContainer) {
                    listContainer.innerHTML = renderActionPickerList(config.slots, '');
                    attachActionPickerClickHandlers(container, null);
                }
            }
        });
    }

    // Add Action dialog close
    const dialogClose = container.querySelector('#qa-add-dialog-close');
    if (dialogClose) {
        dialogClose.addEventListener('click', () => {
            const dialog = container.querySelector('#qa-add-dialog');
            if (dialog) dialog.hidden = true;
        });
    }

    // Add Action dialog backdrop click
    const dialog = container.querySelector('#qa-add-dialog');
    if (dialog) {
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) dialog.hidden = true;
        });
    }

    // Add Action search
    const searchInput = container.querySelector('#qa-action-search');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const config = quickActionsMenu.getConfig();
            const listContainer = container.querySelector('#qa-action-list');
            const editSlot = dialog?.dataset.editingSlot;
            const isEditing = editSlot !== '' && editSlot !== undefined;

            if (listContainer) {
                listContainer.innerHTML = renderActionPickerList(
                    isEditing ? [] : config.slots,
                    e.target.value
                );
                attachActionPickerClickHandlers(container, isEditing ? parseInt(editSlot, 10) : null);
            }
        });
    }

    // Action option clicks
    attachActionPickerClickHandlers(container, null);

    // Options checkboxes
    const contextAware = container.querySelector('#qa-context-aware');
    if (contextAware) {
        contextAware.addEventListener('change', (e) => {
            updateQuickActionsOption('contextAware', e.target.checked);
        });
    }

    const showTooltips = container.querySelector('#qa-show-tooltips');
    if (showTooltips) {
        showTooltips.addEventListener('change', (e) => {
            updateQuickActionsOption('showTooltips', e.target.checked);
        });
    }

    const dragRelease = container.querySelector('#qa-drag-release');
    if (dragRelease) {
        dragRelease.addEventListener('change', (e) => {
            updateQuickActionsOption('dragRelease', e.target.checked);
        });
    }

    const haptic = container.querySelector('#qa-haptic');
    if (haptic) {
        haptic.addEventListener('change', (e) => {
            updateQuickActionsOption('hapticFeedback', e.target.checked);
        });
    }

    // Reset position button
    const resetPosBtn = container.querySelector('#qa-reset-position');
    if (resetPosBtn) {
        resetPosBtn.addEventListener('click', () => {
            quickActionsMenu.resetPosition();
        });
    }

    setupCustomActionEvents(container);
}

/**
 * Wire the custom-actions manage list + editor dialog.
 */
function setupCustomActionEvents(container) {
    const dialog = container.querySelector('#qa-custom-dialog');
    if (!dialog) return;

    const labelInput = dialog.querySelector('#qa-custom-label');
    const payloadInput = dialog.querySelector('#qa-custom-payload');
    const typeBtns = Array.from(dialog.querySelectorAll('.qa-custom-type-btn'));
    const iconBtns = Array.from(dialog.querySelectorAll('.qa-custom-icon-btn'));
    const titleEl = dialog.querySelector('#qa-custom-dialog-title');

    let editingId = null;
    let selectedType = 'terminal';
    let selectedIcon = CUSTOM_ICON_CHOICES[0];

    const payloadPlaceholders = {
        terminal: S.settings.qa_editor.custom_payload_placeholder_terminal,
        prompt: S.settings.qa_editor.custom_payload_placeholder_prompt,
        slash: S.settings.qa_editor.custom_payload_placeholder_slash,
    };

    const setType = (type) => {
        selectedType = type;
        typeBtns.forEach(b => b.classList.toggle('active', b.dataset.type === type));
        if (payloadInput) payloadInput.placeholder = payloadPlaceholders[type] || '';
    };
    const setIcon = (icon) => {
        selectedIcon = icon;
        iconBtns.forEach(b => b.classList.toggle('active', b.dataset.icon === icon));
    };

    const openEditor = (def = null) => {
        editingId = def?.id || null;
        if (titleEl) {
            titleEl.textContent = def
                ? S.settings.qa_editor.custom_edit_title
                : S.settings.qa_editor.custom_new_title;
        }
        if (labelInput) labelInput.value = def?.label || '';
        if (payloadInput) payloadInput.value = def?.payload || '';
        setType(def?.type || 'terminal');
        setIcon(def?.icon && CUSTOM_ICON_CHOICES.includes(def.icon) ? def.icon : CUSTOM_ICON_CHOICES[0]);
        dialog.hidden = false;
        labelInput?.focus();
    };

    typeBtns.forEach(btn => btn.addEventListener('click', () => setType(btn.dataset.type)));
    iconBtns.forEach(btn => btn.addEventListener('click', () => setIcon(btn.dataset.icon)));

    // Add button
    container.querySelector('#qa-add-custom')?.addEventListener('click', () => openEditor());

    // Edit buttons
    container.querySelectorAll('.qa-custom-edit').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const def = quickActionsMenu.getCustomActions().find(d => d.id === btn.dataset.customId);
            if (def) openEditor(def);
        });
    });

    // Delete buttons — two-click arm pattern (window.confirm no-ops on iPad PWA)
    container.querySelectorAll('.qa-custom-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!btn.classList.contains('armed')) {
                btn.classList.add('armed');
                btn.querySelector('.qa-custom-delete-label')?.removeAttribute('hidden');
                setTimeout(() => {
                    btn.classList.remove('armed');
                    btn.querySelector('.qa-custom-delete-label')?.setAttribute('hidden', '');
                }, 3000);
                return;
            }
            const id = btn.dataset.customId;
            const customs = quickActionsMenu.getCustomActions().filter(d => d.id !== id);
            // Also drop it from any radial slot it occupies
            const config = quickActionsMenu.getConfig();
            if (config.slots.includes(id)) {
                quickActionsMenu.setConfig({
                    ...config,
                    slots: config.slots.filter(s => s !== id),
                    preset: 'custom',
                });
            }
            quickActionsMenu.setCustomActions(customs);
            refreshQuickActionsTab(container);
        });
    });

    // Save
    dialog.querySelector('#qa-custom-save')?.addEventListener('click', () => {
        const label = (labelInput?.value || '').trim();
        const payload = (payloadInput?.value || '').trim();
        if (!label || !payload) {
            (label ? payloadInput : labelInput)?.focus();
            return;
        }

        const customs = quickActionsMenu.getCustomActions();
        if (editingId) {
            const idx = customs.findIndex(d => d.id === editingId);
            if (idx !== -1) {
                customs[idx] = { ...customs[idx], label, icon: selectedIcon, type: selectedType, payload };
            }
        } else {
            const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID().slice(0, 8)
                : Math.random().toString(36).slice(2, 10);
            customs.push({ id: `custom-${rand}`, label, icon: selectedIcon, type: selectedType, payload });
        }
        quickActionsMenu.setCustomActions(customs);
        dialog.hidden = true;
        refreshQuickActionsTab(container);
    });

    // Cancel / close / backdrop
    dialog.querySelector('#qa-custom-cancel')?.addEventListener('click', () => { dialog.hidden = true; });
    dialog.querySelector('#qa-custom-dialog-close')?.addEventListener('click', () => { dialog.hidden = true; });
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) dialog.hidden = true;
    });
}

/**
 * Attach click handlers to action picker options
 * @param {HTMLElement} container - Container element
 * @param {number|null} editingSlotIndex - Index of slot being edited, or null for adding new
 */
function attachActionPickerClickHandlers(container, editingSlotIndex) {
    container.querySelectorAll('.qa-action-option').forEach(option => {
        option.addEventListener('click', () => {
            const actionId = option.dataset.actionId;
            const config = quickActionsMenu.getConfig();
            let newSlots;

            if (editingSlotIndex !== null && editingSlotIndex >= 0) {
                // Replace action at specific slot
                newSlots = [...config.slots];
                newSlots[editingSlotIndex] = actionId;
            } else {
                // Add new action
                if (config.slots.length >= 8) {
                    alert(S.toast.max_actions);
                    return;
                }
                newSlots = [...config.slots, actionId];
            }

            quickActionsMenu.setConfig({ ...config, slots: newSlots, preset: 'custom' });
            const dialog = container.querySelector('#qa-add-dialog');
            if (dialog) dialog.hidden = true;
            refreshQuickActionsTab(container);
        });
    });
}

/**
 * Update a quick actions option
 */
function updateQuickActionsOption(key, value) {
    const config = quickActionsMenu.getConfig();
    quickActionsMenu.setConfig({
        ...config,
        options: { ...config.options, [key]: value }
    });
}

/**
 * Refresh the quick actions tab content
 */
function refreshQuickActionsTab(container) {
    const section = container.querySelector('.config-section[data-section="quickactions"]');
    if (section) {
        // Preserve scroll position across re-render (moving slots up/down)
        const scrollParent = section.closest('.widget-body') || section.parentElement;
        const scrollTop = scrollParent?.scrollTop || 0;
        section.innerHTML = renderQuickActionsTab();
        setupQuickActionsEvents(container);
        if (scrollParent) scrollParent.scrollTop = scrollTop;
    }
}
