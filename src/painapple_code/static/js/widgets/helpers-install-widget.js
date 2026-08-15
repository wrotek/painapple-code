/**
 * HelpersInstallWidget — Auto-journal control center.
 *
 * Single panel for the auto-journal feature. Surfaces:
 *  - feature explanation (so users discover what it does)
 *  - per-project toggles (shadow git, rich commits) via PATCH /api/project/config
 *  - helper file install / update / uninstall via /api/bridge/helpers/{install,uninstall}
 *  - "Open Journal" shortcut to the history-explorer widget
 *  - link to system-settings defaults
 *
 * Open from the #status-helpers pill in the status bar.
 */

import { WidgetManager } from '../widget-system/index.js';
import { CONFIG } from '../config.js';
import { escapeHtml } from '../utils.js';
import { refreshAgentsForCwd } from '../snippets-autocomplete.js';
import { ensureModelsLoaded, getSummaryModelLabel, formatModelLabel } from '../status-bar.js';
import S from '../strings.js';

/** Substitute {model} with the configured auto-journal model label. */
function subModel(s) {
    return String(s ?? '').replace(/\{model\}/g, getSummaryModelLabel());
}

const DISMISS_KEY = 'helpers_install_dismissed';

async function fetchStatus() {
    const resp = await fetch(`${CONFIG.API_BASE}/api/bridge/helpers/status`);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    return resp.json();
}

async function fetchProjectConfig(cwd) {
    const url = `${CONFIG.API_BASE}/api/project/config?cwd=${encodeURIComponent(cwd)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`project/config ${resp.status}`);
    return resp.json();
}

async function patchProjectConfig(cwd, updates) {
    const url = `${CONFIG.API_BASE}/api/project/config?cwd=${encodeURIComponent(cwd)}`;
    const resp = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
    });
    if (!resp.ok) throw new Error(`patch ${resp.status}`);
    return resp.json();
}

async function fetchCommitSections(hash) {
    const resp = await fetch(`${CONFIG.API_BASE}/api/bridge/projects/${hash}/commit-sections`);
    if (!resp.ok) throw new Error(`commit-sections ${resp.status}`);
    return resp.json();
}

async function saveCommitSections(hash, sections) {
    const resp = await fetch(`${CONFIG.API_BASE}/api/bridge/projects/${hash}/commit-sections`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sections }),
    });
    if (!resp.ok) throw new Error(`commit-sections PUT ${resp.status}`);
    return resp.json();
}

async function runInstall() {
    const resp = await fetch(`${CONFIG.API_BASE}/api/bridge/helpers/install`, {
        method: 'POST',
    });
    return resp.json();
}

async function runUninstall() {
    const resp = await fetch(`${CONFIG.API_BASE}/api/bridge/helpers/uninstall`, {
        method: 'POST',
    });
    return resp.json();
}

async function setAgentModel(model) {
    const resp = await fetch(`${CONFIG.API_BASE}/api/bridge/helpers/agent-model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
    });
    if (!resp.ok) throw new Error(`agent-model ${resp.status}`);
    return resp.json();
}

function getActiveProjectCwd() {
    return window.app?.activeSession?.cwd || null;
}

/**
 * Recording state — what shadow-git + summary fork are actually doing for
 * this project. Independent of helpers (auto-journal records without
 * them).
 */
function getRecordingState(projectConfig) {
    const M = S.helpers.modal;
    const sg = projectConfig?.shadow_git || {};
    const enabled = sg.enabled !== false;
    const rich = sg.rich_commits !== false;
    if (!enabled) return { kind: 'project-disabled', text: M.status_project_disabled };
    if (!rich)    return { kind: 'recording-basic',  text: subModel(M.status_recording_basic) };
    return            { kind: 'recording-full',   text: M.status_recording_full };
}

/** Helpers state — null when all current, so the banner stays clean. */
function getHelpersState(status) {
    const M = S.helpers.modal;
    if (!status.all_installed) return { kind: 'helpers-missing',  text: M.status_helpers_missing };
    if (status.any_outdated)   return { kind: 'helpers-outdated', text: M.status_helpers_outdated };
    return null;
}

function renderSectionsBlock(commitSections, richEnabled) {
    const M = S.helpers.modal;
    if (!commitSections?.sections) return '';
    const sections = commitSections.sections;
    const enabledCount = sections.filter(s => s.enabled).length;
    const total = sections.length;
    const countText = M.sections_count
        .replace('{enabled}', enabledCount)
        .replace('{total}', total);

    const chips = sections.map(s => {
        const cls = [
            'helpers-section-chip',
            s.enabled ? 'enabled' : 'disabled',
            s.required ? 'required' : '',
            !s.builtin ? 'custom' : '',
        ].filter(Boolean).join(' ');
        return `
            <button type="button"
                    class="${cls}"
                    data-role="section-toggle"
                    data-section-id="${escapeHtml(s.id)}"
                    ${s.required ? 'disabled' : ''}
                    title="${escapeHtml(s.title)}${s.required ? ' (' + M.sections_required_marker + ')' : ''}">
                <span class="helpers-section-chip-mark"></span>
                <span class="helpers-section-chip-label">${escapeHtml(s.title)}</span>
            </button>`;
    }).join('');

    return `
        <div class="helpers-sections-block ${richEnabled ? '' : 'dimmed'}">
            <div class="helpers-sections-header">
                <span class="helpers-sections-label">${escapeHtml(M.sections_label)}</span>
                <span class="helpers-sections-count">${escapeHtml(countText)}</span>
                <button type="button" class="helpers-link helpers-sections-customize" data-role="sections-customize">
                    ${escapeHtml(M.sections_customize)}
                </button>
            </div>
            <div class="helpers-sections-chips">${chips}</div>
        </div>`;
}

function renderProjectSection(projectConfig, cwd, commitSections) {
    const M = S.helpers.modal;
    if (!cwd) {
        return `
            <section class="helpers-section">
                <h4 class="helpers-section-title">${escapeHtml(M.section_project)}</h4>
                <p class="helpers-section-hint">${escapeHtml(M.no_active_project)}</p>
            </section>`;
    }
    const sg = projectConfig?.shadow_git || {};
    const enabled = sg.enabled !== false;
    const rich = sg.rich_commits !== false;
    return `
        <section class="helpers-section">
            <h4 class="helpers-section-title">${escapeHtml(M.section_project)}</h4>
            <label class="helpers-toggle">
                <input type="checkbox" data-role="proj-shadow" ${enabled ? 'checked' : ''}>
                <div class="helpers-toggle-text">
                    <span class="helpers-toggle-label">${escapeHtml(S.settings.toggles.enable_shadow_git)}</span>
                    <span class="helpers-toggle-hint">${escapeHtml(M.toggle_shadow_git_hint)}</span>
                </div>
            </label>
            <label class="helpers-toggle">
                <input type="checkbox" data-role="proj-rich" ${rich ? 'checked' : ''}>
                <div class="helpers-toggle-text">
                    <span class="helpers-toggle-label">${escapeHtml(subModel(S.settings.toggles.rich_commits))}</span>
                    <span class="helpers-toggle-hint">${escapeHtml(subModel(M.toggle_rich_commits_hint))}</span>
                </div>
            </label>
            ${renderSectionsBlock(commitSections, rich)}
        </section>`;
}

function renderHelpersSection(status) {
    const M = S.helpers.modal;
    // Aggregate state for the section header tag — single label that
    // tells the user the overall helpers situation without yelling.
    const overallState = !status.all_installed ? 'missing'
        : status.any_outdated ? 'outdated' : 'current';
    const overallText = overallState === 'missing'  ? M.helpers_status_missing
                      : overallState === 'outdated' ? M.helpers_status_outdated
                      :                               M.helpers_status_current;
    // `unsupported` is its own state, not a flavour of missing: the server
    // deliberately never installs these (the two shell-script helpers on
    // Windows), so "Not installed" read as a broken install the user could
    // fix by clicking Install again — and no click ever would.
    const fileRows = (status.files || []).map(f => {
        const fState = f.unsupported ? 'unsupported'
            : !f.installed ? 'missing'
            : !f.up_to_date ? 'outdated' : 'current';
        const fLabel = fState === 'unsupported' ? M.helpers_status_unsupported
                     : fState === 'missing'  ? M.helpers_status_missing
                     : fState === 'outdated' ? M.helpers_status_outdated
                     :                         M.helpers_status_current;
        const reason = f.unsupported_reason
            ? ` data-tooltip="${escapeHtml(f.unsupported_reason)}"` : '';
        return `
            <li class="helpers-file-row${f.unsupported ? ' unsupported' : ''}">
                <code class="helpers-file-target">${escapeHtml(f.target)}</code>
                <span class="helpers-file-state ${fState}"${reason}>${escapeHtml(fLabel)}</span>
            </li>`;
    }).join('');
    // Don't tell someone to run a helper we just told them isn't available.
    // The invocation itself is platform-specific (PowerShell needs the bare
    // name so PATHEXT finds the .cmd), so the server hands us the exact text.
    const anyUnsupported = (status.files || []).some(f => f.unsupported);
    const usageExample = anyUnsupported
        ? M.helpers_usage_example_agent_only
        : M.helpers_usage_example.replace(
            '{cmd}', escapeHtml(status.usage_command || '~/.local/bin/shadow-git log'));
    // Subagent model selector — same picks as the main model selector (full
    // model IDs from models.yaml) plus "Inherit". Styled buttons (no native
    // select); labels come from formatModelLabel so they match the main selector.
    const modelOptions = status.agent_model_options || ['inherit'];
    const currentModel = status.agent_model || 'inherit';
    const modelButtons = modelOptions.map(opt => {
        const label = opt === 'inherit' ? M.agent_model_opt_inherit : (formatModelLabel(opt) || opt);
        return `
        <button type="button"
                class="helpers-model-opt ${opt === currentModel ? 'active' : ''}"
                data-role="agent-model" data-model="${escapeHtml(opt)}" title="${escapeHtml(opt)}">
            ${escapeHtml(label)}
        </button>`;
    }).join('');

    return `
        <section class="helpers-section">
            <div class="helpers-section-header">
                <h4 class="helpers-section-title">${escapeHtml(M.section_helpers)}</h4>
                <span class="helpers-section-tag tag-${overallState}">${escapeHtml(overallText)}</span>
            </div>
            <p class="helpers-section-hint">${escapeHtml(M.section_helpers_hint)}</p>
            <p class="helpers-usage-example">${usageExample}</p>
            <ul class="helpers-file-list">${fileRows}</ul>
            <div class="helpers-model-row">
                <span class="helpers-model-label">${escapeHtml(M.agent_model_label)}</span>
                <div class="helpers-model-opts">${modelButtons}</div>
                <p class="helpers-model-hint">${escapeHtml(subModel(M.agent_model_hint))}</p>
            </div>
        </section>`;
}

function renderActionRow(helpersState) {
    const M = S.helpers.modal;
    if (helpersState === 'current') {
        // Helpers fine — primary CTA is Open Journal; helpers admin is secondary
        return `
            <div class="helpers-install-actions helpers-actions-current">
                <button class="helpers-btn helpers-btn-primary" data-role="open-journal">
                    ${escapeHtml(M.open_journal_btn)}
                </button>
            </div>
            <div class="helpers-secondary-row">
                <button class="helpers-link" data-role="install">${escapeHtml(M.reinstall_btn)}</button>
                <span class="helpers-sep">·</span>
                <button class="helpers-link helpers-link-danger" data-role="uninstall">${escapeHtml(M.uninstall_btn)}</button>
                <span class="helpers-sep">·</span>
                <button class="helpers-link" data-role="settings">${escapeHtml(M.settings_link)} →</button>
            </div>`;
    }
    // missing / outdated — primary CTA is Install/Update + Cancel
    const action = helpersState === 'outdated' ? M.update_btn : M.install_btn;
    return `
        <label class="helpers-dont-show">
            <input type="checkbox" data-role="dont-show" />
            <span>${escapeHtml(M.dont_show)}</span>
        </label>
        <div class="helpers-install-actions">
            <button class="helpers-btn helpers-btn-cancel" data-role="cancel">
                ${escapeHtml(M.cancel_btn)}
            </button>
            <button class="helpers-btn helpers-btn-primary" data-role="install">
                ${escapeHtml(action)}
            </button>
        </div>
        <div class="helpers-secondary-row">
            <button class="helpers-link" data-role="open-journal">${escapeHtml(M.open_journal_btn)}</button>
            <span class="helpers-sep">·</span>
            <button class="helpers-link" data-role="settings">${escapeHtml(M.settings_link)} →</button>
        </div>`;
}

function renderBody(container, status, projectConfig, cwd, commitSections) {
    const helpersState = status.all_current ? 'current'
        : status.any_outdated ? 'outdated'
        : 'missing';
    const recording = getRecordingState(projectConfig);
    const helpers = getHelpersState(status);
    const M = S.helpers.modal;

    container.innerHTML = `
        <div class="helpers-install-content">
            <div class="helpers-status-banner">
                <span class="status-pair pair-${recording.kind}">
                    <span class="status-pair-dot"></span>
                    <span class="status-pair-text">${escapeHtml(recording.text)}</span>
                </span>
                ${helpers ? `
                <span class="status-pair pair-${helpers.kind}">
                    <span class="status-pair-dot"></span>
                    <span class="status-pair-text">${escapeHtml(helpers.text)}</span>
                </span>` : ''}
            </div>
            <div class="helpers-install-body">
                <p class="helpers-body-lead">${escapeHtml(subModel(M.body_intro_lead))}</p>
                <p class="helpers-body-feature"><strong>Shadow git</strong> ${escapeHtml(subModel(M.body_intro_shadow).replace(/^Shadow git\s+/, ''))}</p>
                <p class="helpers-body-feature"><strong>Rich commits</strong> ${escapeHtml(subModel(M.body_intro_rich).replace(/^Rich commits\s+/, ''))}</p>
                <p class="helpers-body-outro">${escapeHtml(subModel(M.body_intro_outro))}</p>
            </div>
            ${renderProjectSection(projectConfig, cwd, commitSections)}
            ${renderHelpersSection(status)}
            ${renderActionRow(helpersState)}
            <div class="helpers-install-result" hidden>
                <div class="helpers-install-status"></div>
                <pre class="helpers-install-log"></pre>
            </div>
        </div>
    `;
}

/**
 * Re-fetch status + project config + commit sections and re-render in
 * place. Called after install / uninstall / toggle so the modal stays in
 * sync without flashing.
 */
async function rerender(container, cwd) {
    let status;
    let projectConfig = null;
    let projectInfo = null;
    let commitSections = null;
    try {
        status = await fetchStatus();
    } catch (e) {
        return;
    }
    if (cwd) {
        try {
            const data = await fetchProjectConfig(cwd);
            projectConfig = data.config || {};
            projectInfo = data.project || null;
        } catch (e) { /* fall through with null */ }
    }
    if (projectInfo?.hash) {
        try {
            commitSections = await fetchCommitSections(projectInfo.hash);
        } catch (e) { /* fall through with null */ }
    }
    renderBody(container, status, projectConfig, cwd, commitSections);
    bindActions(container, status, projectConfig, projectInfo, cwd, commitSections);
    if (window.app?.refreshHelpersStatus) {
        window.app.refreshHelpersStatus();
    }
    // The shadow-git-researcher agent lives in ~/.claude/agents/, so the #
    // autocomplete cache needs to know about install/uninstall. Refresh
    // silently — failure here shouldn't break the modal.
    refreshAgentsForCwd(cwd).catch(() => {});
}

function bindActions(container, status, projectConfig, projectInfo, cwd, commitSections) {
    const M = S.helpers.modal;
    const result = container.querySelector('.helpers-install-result');
    const statusEl = container.querySelector('.helpers-install-status');
    const logEl = container.querySelector('.helpers-install-log');

    const showLog = (text, kind) => {
        result.hidden = false;
        statusEl.textContent = text;
        statusEl.className = `helpers-install-status ${kind}`;
    };

    // Project toggles
    const shadowToggle = container.querySelector('[data-role="proj-shadow"]');
    if (shadowToggle && cwd) {
        shadowToggle.addEventListener('change', async (e) => {
            try {
                await patchProjectConfig(cwd, {
                    shadow_git: { enabled: e.target.checked }
                });
                await rerender(container, cwd);
            } catch (err) {
                showLog(String(err?.message || err), 'failure');
            }
        });
    }
    const richToggle = container.querySelector('[data-role="proj-rich"]');
    if (richToggle && cwd) {
        richToggle.addEventListener('change', async (e) => {
            try {
                await patchProjectConfig(cwd, {
                    shadow_git: { rich_commits: e.target.checked }
                });
                await rerender(container, cwd);
            } catch (err) {
                showLog(String(err?.message || err), 'failure');
            }
        });
    }

    // Cancel (only present in missing/outdated state)
    const cancelBtn = container.querySelector('[data-role="cancel"]');
    const dontShow = container.querySelector('[data-role="dont-show"]');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            if (dontShow?.checked) {
                try { localStorage.setItem(DISMISS_KEY, 'true'); } catch {}
            }
            WidgetManager.close('helpers-install');
        });
    }

    // Install / Reinstall / Update
    const installBtn = container.querySelector('[data-role="install"]');
    if (installBtn) {
        installBtn.addEventListener('click', async () => {
            installBtn.disabled = true;
            if (cancelBtn) cancelBtn.disabled = true;
            showLog(M.installing, 'running');
            logEl.textContent = '';
            try {
                const r = await runInstall();
                logEl.textContent = ((r.stdout || '') +
                    (r.stderr ? '\n--- stderr ---\n' + r.stderr : '')).trim();
                if (r.ok) {
                    showLog(M.success, 'success');
                    await rerender(container, cwd);
                } else {
                    showLog(M.failure, 'failure');
                    installBtn.disabled = false;
                    if (cancelBtn) cancelBtn.disabled = false;
                }
            } catch (e) {
                showLog(M.failure, 'failure');
                logEl.textContent = String(e?.message || e);
                installBtn.disabled = false;
                if (cancelBtn) cancelBtn.disabled = false;
            }
        });
    }

    // Uninstall — two-click confirm. First click swaps label; second within
    // 3 seconds executes; otherwise label resets.
    const uninstallBtn = container.querySelector('[data-role="uninstall"]');
    if (uninstallBtn) {
        let confirmTimer = null;
        uninstallBtn.addEventListener('click', async () => {
            if (uninstallBtn.dataset.confirming !== 'true') {
                uninstallBtn.dataset.confirming = 'true';
                uninstallBtn.textContent = M.uninstall_confirm_btn;
                clearTimeout(confirmTimer);
                confirmTimer = setTimeout(() => {
                    uninstallBtn.dataset.confirming = 'false';
                    uninstallBtn.textContent = M.uninstall_btn;
                }, 3000);
                return;
            }
            clearTimeout(confirmTimer);
            uninstallBtn.disabled = true;
            showLog(M.uninstalling, 'running');
            logEl.textContent = '';
            try {
                const r = await runUninstall();
                logEl.textContent = JSON.stringify(r, null, 2);
                if (r.ok) {
                    showLog(M.uninstalled, 'success');
                    await rerender(container, cwd);
                } else {
                    showLog(M.uninstall_failure, 'failure');
                }
            } catch (e) {
                showLog(M.uninstall_failure, 'failure');
                logEl.textContent = String(e?.message || e);
            }
        });
    }

    // Open Journal — closes this widget and opens the history-explorer
    const openJournalBtn = container.querySelector('[data-role="open-journal"]');
    if (openJournalBtn) {
        openJournalBtn.addEventListener('click', () => {
            WidgetManager.close('helpers-install');
            WidgetManager.open('history-explorer');
        });
    }

    // Settings — open the config widget on its System tab
    const settingsBtn = container.querySelector('[data-role="settings"]');
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            WidgetManager.close('helpers-install');
            // Name the section too — it's the last block on the System tab, so
            // a bare tab switch leaves the user hunting for what the link named.
            WidgetManager.open('config', {
                tab: 'system',
                section: 'shadow-git-defaults-section',
            });
        });
    }

    // Section chips — toggle individual section.enabled and PUT the
    // whole list back. Optimistic UI: flip the chip class right away,
    // then rerender on success.
    const sectionChips = container.querySelectorAll('[data-role="section-toggle"]');
    sectionChips.forEach(btn => {
        btn.addEventListener('click', async () => {
            if (btn.disabled || !projectInfo?.hash || !commitSections?.sections) return;
            const sectionId = btn.dataset.sectionId;
            const updated = commitSections.sections.map(s =>
                s.id === sectionId ? { ...s, enabled: !s.enabled } : s
            );
            btn.classList.toggle('enabled');
            btn.classList.toggle('disabled');
            try {
                await saveCommitSections(projectInfo.hash, updated);
                await rerender(container, cwd);
            } catch (err) {
                showLog(String(err?.message || err), 'failure');
                // Roll back the optimistic flip
                btn.classList.toggle('enabled');
                btn.classList.toggle('disabled');
            }
        });
    });

    // "Customize sections →" — opens the full editor in Settings → Project tab
    const sectionsCustomize = container.querySelector('[data-role="sections-customize"]');
    if (sectionsCustomize) {
        sectionsCustomize.addEventListener('click', () => {
            WidgetManager.close('helpers-install');
            WidgetManager.open('config', { tab: 'project' });
        });
    }

    // Subagent model selector — persist the choice and apply it to the
    // installed agent file (no reinstall needed). Optimistic active swap.
    const modelBtns = container.querySelectorAll('[data-role="agent-model"]');
    modelBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
            if (btn.classList.contains('active')) return;
            const model = btn.dataset.model;
            modelBtns.forEach(b => b.classList.toggle('active', b === btn));
            try {
                await setAgentModel(model);
                await rerender(container, cwd);
            } catch (err) {
                showLog(String(err?.message || err), 'failure');
                await rerender(container, cwd);
            }
        });
    });
}

export function registerHelpersInstallWidget() {
    // Guard against the create-time + open-time double-render race.
    // The widget system renders once on create (no ctx) and again from
    // open(id, ctx). If the first render awaits a fetch, it resolves after
    // the second synchronous render and overwrites it. We tag each render
    // with a generation counter and only commit if still current.
    let renderGen = 0;

    WidgetManager.register('helpers-install', {
        // The state-neutral pill label — a window title must not claim
        // on/off, the banner inside does that.
        title: S.helpers.pill.unknown,
        icon: 'tool',
        type: 'floating',
        scope: 'global',
        size: { width: 800, height: 780 },
        minSize: { width: 520, height: 480 },

        async render(container, ctx) {
            const gen = ++renderGen;
            container.classList.add('helpers-install-widget');

            // Wait for the models cache so {model} substitutions render the
            // configured auto-journal model rather than the "Haiku" fallback.
            await ensureModelsLoaded();
            if (gen !== renderGen) return;

            let status = ctx?.status;
            if (!status) {
                try {
                    status = await fetchStatus();
                } catch (e) {
                    if (gen !== renderGen) return;
                    container.innerHTML = `<div class="helpers-install-error">
                        Failed to read helper status: ${escapeHtml(e.message)}</div>`;
                    return;
                }
            }

            const cwd = getActiveProjectCwd();
            let projectConfig = null;
            let projectInfo = null;
            let commitSections = null;
            if (cwd) {
                try {
                    const data = await fetchProjectConfig(cwd);
                    projectConfig = data.config || {};
                    projectInfo = data.project || null;
                } catch (e) { /* fall through with null */ }
            }
            if (projectInfo?.hash) {
                try {
                    commitSections = await fetchCommitSections(projectInfo.hash);
                } catch (e) { /* fall through with null */ }
            }

            // Bail if a newer render started while we awaited.
            if (gen !== renderGen) return;
            renderBody(container, status, projectConfig, cwd, commitSections);
            bindActions(container, status, projectConfig, projectInfo, cwd, commitSections);
        },
    });
}

export const HelpersInstallWidget = {
    open: (status) => WidgetManager.open('helpers-install', { status }),
    close: () => WidgetManager.close('helpers-install'),
    DISMISS_KEY,
};
