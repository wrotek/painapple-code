/**
 * Commit Sections editor — the per-project list of fields that the rich-
 * commit summary run is asked to fill in (summary, work_done, decisions,
 * etc.). Toggle/reorder/edit each section, add custom ones, reset to the
 * built-in defaults.
 *
 * The editor renders as a collapsible block inside the Project tab. Items
 * are rendered from `state.commitSections` (loaded by the orchestrator on
 * widget open), and every mutation goes through `state.saveCommitSections`
 * before refreshing the DOM.
 *
 * `renderCommitSectionsEditor(state)` takes the singleton as an argument
 * so the existing call sites in the orchestrator (which read state from
 * its own scope) don't change shape.
 */

import S from '../../strings.js';
import { escapeHtml, appConfirm } from '../../utils.js';
import { state, subModel } from './state.js';

/**
 * Render the commit sections editor
 */
export function renderCommitSectionsEditor(state) {
    if (!state.commitSections?.sections) {
        return '<div class="sections-loading">Loading sections...</div>';
    }

    const sections = state.commitSections.sections;
    const builtinIds = state.commitSections.builtin_ids || [];

    return `
        <div class="sections-list">
            ${sections.map((section, index) => `
                <div class="section-item ${section.required ? 'required' : ''} ${section.enabled ? 'enabled' : 'disabled'}"
                     data-section-id="${escapeHtml(section.id)}"
                     data-order="${section.order}">
                    <div class="section-drag-handle" data-tooltip="Drag to reorder">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/>
                            <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
                            <circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>
                        </svg>
                    </div>
                    <label class="section-toggle">
                        <input type="checkbox"
                               ${section.enabled ? 'checked' : ''}
                               ${section.required ? 'disabled' : ''}
                               data-section-id="${escapeHtml(section.id)}">
                        <div class="section-info">
                            <div class="section-name-row">
                                <span class="section-name">${escapeHtml(section.title)}</span>
                                ${section.required ? '<span class="section-badge required">required</span>' : ''}
                                ${!section.builtin ? '<span class="section-badge custom">custom</span>' : ''}
                            </div>
                            <span class="section-prompt-preview">${escapeHtml(section.prompt || '')}</span>
                        </div>
                    </label>
                    <div class="section-actions">
                        ${!section.required ? `
                            <button class="section-edit-btn" data-section-id="${escapeHtml(section.id)}" data-tooltip="Edit prompt">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                                </svg>
                            </button>
                        ` : ''}
                        ${!section.builtin ? `
                            <button class="section-delete-btn" data-section-id="${escapeHtml(section.id)}" data-tooltip="Delete section">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                                </svg>
                            </button>
                        ` : ''}
                        <button class="section-move-up" data-section-id="${escapeHtml(section.id)}"
                                ${index === 0 ? 'disabled' : ''} data-tooltip="Move up">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 15l-6-6-6 6"/>
                            </svg>
                        </button>
                        <button class="section-move-down" data-section-id="${escapeHtml(section.id)}"
                                ${index === sections.length - 1 ? 'disabled' : ''} data-tooltip="Move down">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M6 9l6 6 6-6"/>
                            </svg>
                        </button>
                    </div>
                </div>
            `).join('')}
        </div>
        <div class="sections-footer">
            <button class="sections-add-btn" id="add-custom-section">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 5v14M5 12h14"/>
                </svg>
                Add Custom Section
            </button>
            <button class="sections-reset-btn" id="reset-sections" data-tooltip="Reset to defaults">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                    <path d="M3 3v5h5"/>
                </svg>
                Reset
            </button>
        </div>
    `;
}

/**
 * Render custom section edit modal
 */
function renderSectionEditModal(section, isNew = false) {
    return `
        <div class="section-edit-modal" id="section-edit-modal">
            <div class="section-edit-content">
                <h3>${isNew ? S.settings.section_editor.add_title : S.settings.section_editor.edit_title.replace('{name}', escapeHtml(section?.title || ''))}</h3>
                <div class="section-edit-form">
                    <div class="form-group">
                        <label for="section-title">${S.settings.section_editor.section_title_label}</label>
                        <input type="text" id="section-title"
                               value="${escapeHtml(section?.title || '')}"
                               placeholder="${S.settings.section_editor.title_placeholder}"
                               ${section?.builtin ? 'disabled' : ''}>
                    </div>
                    <div class="form-group">
                        <label for="section-prompt">${S.settings.section_editor.prompt_label}</label>
                        <textarea id="section-prompt" rows="4"
                                  placeholder="${subModel(S.settings.section_editor.prompt_placeholder)}">${escapeHtml(section?.prompt || '')}</textarea>
                    </div>
                    <div class="form-group">
                        <label>${S.settings.section_editor.applies_to}</label>
                        <div class="applies-to-checkboxes">
                            <label>
                                <input type="checkbox" id="applies-file-changes"
                                       ${!section || section.applies_to?.includes('file_changes') ? 'checked' : ''}>
                                ${S.settings.section_editor.file_changes}
                            </label>
                            <label>
                                <input type="checkbox" id="applies-tool-only"
                                       ${!section || section.applies_to?.includes('tool_only') ? 'checked' : ''}>
                                ${S.settings.section_editor.tool_only}
                            </label>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>${S.settings.section_editor.field_type}</label>
                        <div class="field-type-selector">
                            <label>
                                <input type="radio" name="field-type" value="array"
                                       ${!section?.field_type || section.field_type === 'array' ? 'checked' : ''}>
                                ${S.settings.section_editor.list_type}
                            </label>
                            <label>
                                <input type="radio" name="field-type" value="string"
                                       ${section?.field_type === 'string' ? 'checked' : ''}>
                                ${S.settings.section_editor.single_type}
                            </label>
                        </div>
                        <span class="form-hint">${S.settings.section_editor.field_type_hint}</span>
                    </div>
                    ${isNew ? `
                        <div class="form-group">
                            <label for="section-id">${S.settings.section_editor.section_id}</label>
                            <input type="text" id="section-id"
                                   placeholder="${S.settings.section_editor.id_placeholder}">
                            <span class="form-hint">${S.settings.section_editor.id_hint}</span>
                        </div>
                    ` : ''}
                </div>
                <div class="section-edit-actions">
                    <button class="btn-cancel" id="cancel-section-edit">Cancel</button>
                    <button class="btn-save" id="save-section-edit" data-section-id="${escapeHtml(section?.id || '')}" data-is-new="${isNew}">
                        ${isNew ? S.settings.section_editor.add_btn : S.settings.section_editor.save_btn}
                    </button>
                </div>
            </div>
        </div>
    `;
}

/**
 * Setup event handlers for commit sections editor
 */
export function setupCommitSectionsHandlers(container) {
    // Toggle sections editor
    const toggleBtn = container.querySelector('#toggle-commit-sections');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', async () => {
            state.commitSectionsExpanded = !state.commitSectionsExpanded;

            const editor = container.querySelector('#commit-sections-editor');

            if (state.commitSectionsExpanded) {
                // Load sections if not loaded yet
                if (!state.commitSections) {
                    await state.loadCommitSections();
                }
                // Always refresh editor content when expanding
                if (editor) {
                    editor.innerHTML = renderCommitSectionsEditor(state);
                    setupCommitSectionItemHandlers(container);
                }
            }

            // Toggle UI
            const chevron = toggleBtn.querySelector('.chevron-icon');
            if (chevron) chevron.classList.toggle('expanded', state.commitSectionsExpanded);
            if (editor) editor.classList.toggle('expanded', state.commitSectionsExpanded);
        });
    }

    // Update sections count badge (if already loaded)
    updateSectionsCount(container);

    // If already expanded and sections loaded, refresh editor
    if (state.commitSectionsExpanded && state.commitSections) {
        const editor = container.querySelector('#commit-sections-editor');
        if (editor) {
            editor.innerHTML = renderCommitSectionsEditor(state);
            setupCommitSectionItemHandlers(container);
        }
    }
}

/**
 * Setup handlers for individual section items
 */
export function setupCommitSectionItemHandlers(container) {
    const editor = container.querySelector('#commit-sections-editor');
    if (!editor) return;

    // Section enable/disable toggles
    editor.querySelectorAll('.section-toggle input[type="checkbox"]').forEach(checkbox => {
        checkbox.addEventListener('change', async (e) => {
            const sectionId = e.target.dataset.sectionId;
            await state.saveCommitSections({ [sectionId]: { enabled: e.target.checked } });
            updateSectionsCount(container);
        });
    });

    // Move up buttons
    editor.querySelectorAll('.section-move-up').forEach(btn => {
        btn.addEventListener('click', async () => {
            const sectionId = btn.dataset.sectionId;
            await moveSectionUp(sectionId);
            refreshSectionsEditor(container);
        });
    });

    // Move down buttons
    editor.querySelectorAll('.section-move-down').forEach(btn => {
        btn.addEventListener('click', async () => {
            const sectionId = btn.dataset.sectionId;
            await moveSectionDown(sectionId);
            refreshSectionsEditor(container);
        });
    });

    // Edit buttons
    editor.querySelectorAll('.section-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const sectionId = btn.dataset.sectionId;
            const section = state.commitSections?.sections?.find(s => s.id === sectionId);
            showSectionEditModal(container, section, false);
        });
    });

    // Delete buttons
    editor.querySelectorAll('.section-delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const sectionId = btn.dataset.sectionId;
            if (await appConfirm(S.settings.confirms.delete_section.replace('{id}', sectionId), { confirmLabel: 'Delete', danger: true })) {
                await state.saveCommitSections({ [sectionId]: { delete: true } });
                refreshSectionsEditor(container);
            }
        });
    });

    // Add custom section button
    const addBtn = editor.querySelector('#add-custom-section');
    if (addBtn) {
        addBtn.addEventListener('click', () => {
            showSectionEditModal(container, null, true);
        });
    }

    // Reset button
    const resetBtn = editor.querySelector('#reset-sections');
    if (resetBtn) {
        resetBtn.addEventListener('click', async () => {
            if (await appConfirm(S.settings.confirms.reset_sections, { confirmLabel: 'Reset', danger: true })) {
                await state.resetCommitSections();
                refreshSectionsEditor(container);
            }
        });
    }
}

/**
 * Move a section up in order
 */
async function moveSectionUp(sectionId) {
    const sections = state.commitSections?.sections;
    if (!sections) return;

    const index = sections.findIndex(s => s.id === sectionId);
    if (index <= 0) return;

    const currentSection = sections[index];
    const prevSection = sections[index - 1];

    // Swap orders
    const updates = {
        [currentSection.id]: { order: prevSection.order },
        [prevSection.id]: { order: currentSection.order }
    };

    await state.saveCommitSections(updates);
}

/**
 * Move a section down in order
 */
async function moveSectionDown(sectionId) {
    const sections = state.commitSections?.sections;
    if (!sections) return;

    const index = sections.findIndex(s => s.id === sectionId);
    if (index < 0 || index >= sections.length - 1) return;

    const currentSection = sections[index];
    const nextSection = sections[index + 1];

    // Swap orders
    const updates = {
        [currentSection.id]: { order: nextSection.order },
        [nextSection.id]: { order: currentSection.order }
    };

    await state.saveCommitSections(updates);
}

/**
 * Refresh the sections editor after changes
 */
function refreshSectionsEditor(container) {
    const editor = container.querySelector('#commit-sections-editor');
    if (editor) {
        editor.innerHTML = renderCommitSectionsEditor(state);
        setupCommitSectionItemHandlers(container);
    }
    updateSectionsCount(container);
}

/**
 * Update the sections count badge
 */
export function updateSectionsCount(container) {
    const countSpan = container.querySelector('.sections-count');
    if (countSpan && state.commitSections?.sections) {
        const enabledCount = state.commitSections.sections.filter(s => s.enabled).length;
        countSpan.textContent = `${enabledCount} enabled`;
    }
}

/**
 * Show section edit modal
 */
function showSectionEditModal(container, section, isNew) {
    // Remove existing modal if any
    const existingModal = container.querySelector('#section-edit-modal');
    if (existingModal) existingModal.remove();

    // Add modal to container
    const modalHtml = renderSectionEditModal(section, isNew);
    container.insertAdjacentHTML('beforeend', modalHtml);

    const modal = container.querySelector('#section-edit-modal');

    // Cancel button
    modal.querySelector('#cancel-section-edit').addEventListener('click', () => {
        modal.remove();
    });

    // Click outside to close
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
    });

    // Save button
    modal.querySelector('#save-section-edit').addEventListener('click', async () => {
        const title = modal.querySelector('#section-title').value.trim();
        const prompt = modal.querySelector('#section-prompt').value.trim();
        const appliesFileChanges = modal.querySelector('#applies-file-changes').checked;
        const appliesToolOnly = modal.querySelector('#applies-tool-only').checked;
        const fieldType = modal.querySelector('input[name="field-type"]:checked')?.value || 'array';

        if (!title || !prompt) {
            alert(S.settings.alerts.title_prompt_required);
            return;
        }

        const appliesTo = [];
        if (appliesFileChanges) appliesTo.push('file_changes');
        if (appliesToolOnly) appliesTo.push('tool_only');

        if (appliesTo.length === 0) {
            alert(S.settings.alerts.applies_to_required);
            return;
        }

        let sectionId;
        if (isNew) {
            sectionId = modal.querySelector('#section-id').value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
            if (!sectionId) {
                alert(S.settings.alerts.section_id_required);
                return;
            }
            // Check if ID already exists
            if (state.commitSections?.sections?.some(s => s.id === sectionId)) {
                alert(S.settings.alerts.section_id_exists);
                return;
            }
        } else {
            sectionId = section.id;
        }

        const update = {
            [sectionId]: {
                title,
                prompt,
                applies_to: appliesTo,
                field_type: fieldType,
                enabled: true
            }
        };

        await state.saveCommitSections(update);
        modal.remove();
        refreshSectionsEditor(container);
    });

    // Focus title input
    setTimeout(() => {
        const titleInput = modal.querySelector('#section-title');
        if (titleInput && !section?.builtin) titleInput.focus();
        else modal.querySelector('#section-prompt').focus();
    }, 100);
}
