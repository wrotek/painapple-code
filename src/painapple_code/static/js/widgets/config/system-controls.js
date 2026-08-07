/**
 * Bridge-side system controls — API auto-retry max, SIGINT-on-ask. Each is
 * its own GET-on-load, save-on-change pair against `/api/bridge/*`.
 *
 * Grouped here because the patterns are nearly identical (small `setupX`
 * function that wires inputs to API calls), but each panel is otherwise
 * unrelated to the others. None of them need shared state with the rest
 * of config-widget. (Engine CLI paths, per-engine session defaults, and
 * the auto-journal model live in the engine panel — config/models-tab.js.)
 */

// ═══════════════════════════════════════════════════════════════════════════
// API Retry Controls
// ═══════════════════════════════════════════════════════════════════════════

export function setupApiRetryControls(container) {
    const input = container.querySelector('#api-retry-max-input');
    if (!input) return;

    // Load current value from bridge config
    fetch('/api/bridge/api-retry-max')
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
                const resp = await fetch('/api/bridge/api-retry-max', {
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
// Stop-on-AskUserQuestion Toggle
// ═══════════════════════════════════════════════════════════════════════════

export function setupSigintOnAskControls(container) {
    const checkbox = container.querySelector('#sigint-on-ask');
    if (!checkbox) return;

    // Load current value from bridge config
    fetch('/api/bridge/sigint-on-ask')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            if (data) checkbox.checked = !!data.sigint_on_ask;
        })
        .catch(() => {});

    // Save on change
    checkbox.addEventListener('change', async () => {
        const value = checkbox.checked;
        try {
            const resp = await fetch('/api/bridge/sigint-on-ask', {
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

