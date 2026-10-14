/**
 * CliVersionWidget — "your agent CLI is out of date" popup.
 *
 * Providers self-describe a minimum CLI version (Provider.min_cli_version);
 * GET /api/app/cli-versions lists the enabled ones below it. Auto-opened on
 * app load by `_checkCliVersions` (app/settings-helpers.js), same shape as
 * the helpers-install popup: Later / "Don't show again for this version".
 *
 * "Update in terminal" hands the provider's own self-update command
 * (`update_command`, e.g. `claude update`) to a PTY terminal tab, then polls
 * the endpoint so a toast confirms once the CLI is new enough — the check is
 * live, so no server restart is involved.
 */

import { WidgetManager } from '../widget-system/index.js';
import { CONFIG } from '../config.js';
import { escapeHtml } from '../utils.js';
import { showToast } from '../context-menu.js';
import S from '../strings.js';

const DISMISS_KEY = 'cli_version_dismissed';
const POLL_MS = 5000;
const POLL_MAX = 60;          // ~5 min — `claude update` is usually seconds

/** Identity of one warning: re-pops when the installed version or the floor moves. */
function dismissKey(s) {
    return `${s.provider}|${s.version}|${s.min_version}`;
}

function readDismissed() {
    try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]')); }
    catch { return new Set(); }
}

/** True when every stale entry was already dismissed by the user. */
export function allDismissed(stale) {
    const seen = readDismissed();
    return stale.every(s => seen.has(dismissKey(s)));
}

function dismiss(stale) {
    const seen = readDismissed();
    stale.forEach(s => seen.add(dismissKey(s)));
    try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...seen])); } catch {}
}

export async function fetchStaleCliVersions() {
    const resp = await fetch(`${CONFIG.API_BASE}/api/app/cli-versions`);
    if (!resp.ok) throw new Error(`cli-versions ${resp.status}`);
    return (await resp.json()).stale || [];
}

/** After a terminal handoff: poll until `provider` drops off the stale list. */
function pollUntilUpdated(provider, name) {
    let n = 0;
    const tick = async () => {
        if (++n > POLL_MAX) return;
        try {
            const stale = await fetchStaleCliVersions();
            if (!stale.some(s => s.provider === provider)) {
                showToast(S.cli_version.updated_toast.replace('{name}', name), { duration: 4000 });
                return;
            }
        } catch { /* transient — keep polling */ }
        setTimeout(tick, POLL_MS);
    };
    setTimeout(tick, POLL_MS);
}

function renderEntry(s) {
    const M = S.cli_version;
    const update = s.update_command
        ? `<button class="cli-version-btn cli-version-btn-primary" data-role="update"
                   data-provider="${escapeHtml(s.provider)}">${escapeHtml(M.update_btn)}</button>
           <code class="cli-version-cmd">${escapeHtml(s.update_command)}</code>`
        : '';
    return `
        <div class="cli-version-entry" data-provider="${escapeHtml(s.provider)}">
            <div class="cli-version-heading">${escapeHtml(M.heading.replace('{name}', s.display_name))}</div>
            <div class="cli-version-versions">${escapeHtml(
                M.versions.replace('{version}', s.version || '?').replace('{min}', s.min_version))}</div>
            ${s.reason ? `<p class="cli-version-reason">${escapeHtml(M.reason_prefix)} ${escapeHtml(s.reason)}.</p>` : ''}
            ${s.upgrade_hint ? `<p class="cli-version-hint">${escapeHtml(s.upgrade_hint)}</p>` : ''}
            <div class="cli-version-update-row">${update}</div>
        </div>`;
}

function render(container, stale) {
    const M = S.cli_version;
    if (!stale.length) {
        container.innerHTML = `<div class="cli-version-ok">${escapeHtml(M.all_ok)}</div>`;
        return;
    }
    container.innerHTML = `
        <div class="cli-version-body">${stale.map(renderEntry).join('')}</div>
        <div class="cli-version-footer">
            <label class="cli-version-dont-show">
                <input type="checkbox" data-role="dont-show" />
                <span>${escapeHtml(M.dont_show)}</span>
            </label>
            <button class="cli-version-btn" data-role="later">${escapeHtml(M.later_btn)}</button>
        </div>`;

    container.querySelector('[data-role="later"]')?.addEventListener('click', () => {
        if (container.querySelector('[data-role="dont-show"]')?.checked) dismiss(stale);
        WidgetManager.close('cli-version');
    });

    container.querySelectorAll('[data-role="update"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const s = stale.find(x => x.provider === btn.dataset.provider);
            if (!s?.update_command) return;
            // Close first — a floating widget would sit over the new tab.
            WidgetManager.close('cli-version');
            window.app?.openTerminalWidgetTab({
                title: M.terminal_tab.replace('{name}', s.display_name),
                icon: 'terminal',
                initialCommand: s.update_command + '\n',
            });
            pollUntilUpdated(s.provider, s.display_name);
        });
    });
}

export function registerCliVersionWidget() {
    // Same create-time vs open-time double-render guard as helpers-install.
    let renderGen = 0;
    WidgetManager.register('cli-version', {
        title: S.cli_version.title,
        icon: 'warning',
        type: 'floating',
        scope: 'global',
        size: { width: 560, height: 380 },
        minSize: { width: 420, height: 280 },

        async render(container, ctx) {
            const gen = ++renderGen;
            container.classList.add('cli-version-widget');
            let stale = ctx?.stale;
            if (!stale) {
                try { stale = await fetchStaleCliVersions(); }
                catch (e) {
                    if (gen !== renderGen) return;
                    container.innerHTML = `<div class="cli-version-ok">${escapeHtml(e.message)}</div>`;
                    return;
                }
            }
            if (gen !== renderGen) return;
            render(container, stale);
        },
    });
}
