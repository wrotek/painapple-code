/**
 * Server-side system controls — API auto-retry max, max upload size, SIGINT-on-ask. Each is
 * its own GET-on-load, save-on-change pair against `/api/app/*`.
 *
 * Grouped here because the patterns are nearly identical (small `setupX`
 * function that wires inputs to API calls), but each panel is otherwise
 * unrelated to the others. None of them need shared state with the rest
 * of config-widget. (Provider CLI paths, per-provider session defaults, and
 * the auto-journal model live in the provider panel — config/models-tab.js.)
 */

import S from '../../strings.js';

// ═══════════════════════════════════════════════════════════════════════════
// API Retry Controls
// ═══════════════════════════════════════════════════════════════════════════

export function setupApiRetryControls(container) {
    const input = container.querySelector('#api-retry-max-input');
    if (!input) return;

    // Load current value from global config
    fetch('/api/app/api-retry-max')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            if (data) input.value = data.api_retry_max;
        })
        .catch(() => {});

    // Save on change
    input.addEventListener('change', async (e) => {
        const value = parseInt(e.target.value, 10);
        if (value >= 0 && value <= 10) {
            try {
                const resp = await fetch('/api/app/api-retry-max', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ api_retry_max: value })
                });
                if (resp.ok) {
                    const data = await resp.json();
                    input.value = data.api_retry_max;
                }
            } catch (err) {
                console.error('Failed to save api_retry_max:', err);
            }
        } else {
            e.target.value = '3';
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Max Upload Size
// ═══════════════════════════════════════════════════════════════════════════

export function setupUploadLimitControls(container) {
    const input = container.querySelector('#upload-max-mb-input');
    const desc = container.querySelector('#upload-max-mb-desc');
    if (!input) return;

    let bounds = { min: 1, max: 4096, default: 128 };
    const apply = (data) => {
        bounds = { min: data.min, max: data.max, default: data.default };
        input.min = data.min;
        input.max = data.max;
        input.value = data.upload_max_mb;
        if (desc) {
            desc.textContent = S.settings.system_labels.upload_max_mb_desc
                .replace('{min}', data.min)
                .replace('{max}', data.max)
                .replace('{default}', data.default);
        }
        // Keep the chat input's pre-upload check in step without a reload.
        window.app?.uploadManager?.setUploadLimitMb(data.upload_max_mb);
    };

    fetch('/api/app/upload-max-mb')
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data) apply(data); })
        .catch(() => {});

    input.addEventListener('change', async (e) => {
        const value = parseInt(e.target.value, 10);
        if (!(value >= bounds.min && value <= bounds.max)) {
            e.target.value = String(bounds.default);
            return;
        }
        try {
            const resp = await fetch('/api/app/upload-max-mb', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ upload_max_mb: value }),
            });
            if (resp.ok) apply(await resp.json());
        } catch (err) {
            console.error('Failed to save upload_max_mb:', err);
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Stop-on-AskUserQuestion Toggle
// ═══════════════════════════════════════════════════════════════════════════

export function setupSigintOnAskControls(container) {
    const checkbox = container.querySelector('#sigint-on-ask');
    if (!checkbox) return;

    // Load current value from global config
    fetch('/api/app/sigint-on-ask')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            if (data) checkbox.checked = !!data.sigint_on_ask;
        })
        .catch(() => {});

    // Save on change
    checkbox.addEventListener('change', async () => {
        const value = checkbox.checked;
        try {
            const resp = await fetch('/api/app/sigint-on-ask', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sigint_on_ask: value }),
            });
            if (resp.ok) {
                const data = await resp.json();
                checkbox.checked = !!data.sigint_on_ask;
                window.app?.activeSession?.addSystemLog(
                    `Stop on AskUserQuestion: ${data.sigint_on_ask ? 'on' : 'off'}`, 'info');
            } else {
                checkbox.checked = !value;
            }
        } catch (e) {
            console.error('Failed to save sigint_on_ask:', e);
            checkbox.checked = !value;
        }
    });
}

