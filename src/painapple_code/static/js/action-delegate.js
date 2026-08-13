/**
 * Delegated click actions — the replacement for inline `onclick` attributes.
 *
 * CSP forbids inline handlers (script-src without 'unsafe-inline'), so
 * dynamically rendered HTML marks clickables with `data-act="<name>"` plus
 * `data-*` arguments, and ONE document-level listener dispatches here.
 *
 * Attribute is `data-act`, NOT `data-action` — stash-ui.js already owns
 * `data-action` with its own scoped dispatcher, and .file-path-link anchors
 * are already handled by the MarkdownRenderer delegate in components.js.
 *
 * Semantics vs the old inline handlers:
 * - The INNERMOST `[data-act]` element wins and is the only one dispatched,
 *   which reproduces what the scattered `event.stopPropagation()` calls used
 *   to guarantee for nested clickables (a copy button inside a clickable
 *   header, a view-full button inside a collapsible card, ...).
 * - A plain <a> nested inside an actionable element keeps its native
 *   behavior (e.g. the external domain link in a WebFetch header) — the
 *   dispatcher steps aside instead of hijacking the click.
 * - Unknown names are ignored without preventDefault, so markup from other
 *   subsystems can never be broken by this listener.
 *
 * Renderer modules register their own actions via registerActions(); the
 * cross-cutting ones every renderer uses are defined below.
 */

import { b64AttrDecode } from './utils.js';

const ACTIONS = Object.create(null);

export function registerActions(map) {
    for (const [name, fn] of Object.entries(map)) {
        if (ACTIONS[name] && ACTIONS[name] !== fn) {
            console.warn(`action-delegate: duplicate action "${name}" overwritten`);
        }
        ACTIONS[name] = fn;
    }
}

function safeParseOpts(json) {
    if (!json) return {};
    try {
        const v = JSON.parse(json);
        return v && typeof v === 'object' ? v : {};
    } catch { return {}; }
}

// ── Shared actions ─────────────────────────────────────────────────────────
registerActions({
    // File preview / editor open. Path always rides in data-file (escaped as
    // an attribute, read back verbatim from dataset — never inline JS).
    'preview-file': (el, e) => {
        e.preventDefault();
        window.app?.previewFile(el.dataset.file, safeParseOpts(el.dataset.previewOpts));
    },
    'open-in-editor': (el) => {
        window.app?.openFileInEditor(el.dataset.file);
    },

    // Clipboard copy of arbitrary text carried base64 in data-copy (see
    // b64Attr in utils.js — attribute-safe for any payload). Optional
    // feedback: 'copied' class for data-copied-ms (default 1500), and when
    // data-label-sel names a child, its text swaps to data-copied-label
    // ("Copied!") and restores to whatever it said before.
    'copy-b64': (el) => {
        navigator.clipboard.writeText(b64AttrDecode(el.dataset.copy || ''));
        const ms = parseInt(el.dataset.copiedMs || '1500', 10);
        const label = el.dataset.labelSel ? el.querySelector(el.dataset.labelSel) : null;
        const restore = label ? label.textContent : null;
        el.classList.add('copied');
        if (label) label.textContent = el.dataset.copiedLabel || 'Copied!';
        clearTimeout(el._copyTimer);
        el._copyTimer = setTimeout(() => {
            el.classList.remove('copied');
            if (label) label.textContent = restore;
        }, ms);
    },

    // Expand/collapse toggle on the ancestor matched by data-block.
    // data-more-label holds the collapsed-state label ("▼ 12 more lines");
    // the expanded-state label is uniform.
    'toggle-expand': (el) => {
        const block = el.closest(el.dataset.block);
        if (!block) return;
        block.classList.toggle('expanded');
        if (el.dataset.moreLabel) {
            el.textContent = block.classList.contains('expanded')
                ? '▲ Collapse' : el.dataset.moreLabel;
        }
    },

    // Generic class toggle: toggles data-cls on the ancestor matched by
    // data-block (long-command wrappers, the /context card header, ...).
    'toggle-class': (el) => {
        el.closest(el.dataset.block)?.classList.toggle(el.dataset.cls);
    },

    // Open a file link (grep/glob/output paths). data-line-opts is optional
    // JSON; data-resolved wins over data-file when both are present.
    'open-file-link': (el, e) => {
        e.preventDefault();
        const target = el.dataset.resolved || el.dataset.file;
        if (target) window.app?.openFileLink(target, safeParseOpts(el.dataset.lineOpts), e);
    },

    'open-bg-task': (el) => {
        window.app?.openBackgroundTask?.(el.dataset.taskId);
    },
    'open-diff-cache': (el) => {
        window.DiffViewerWidget?.openFromCache(el.dataset.cacheId);
    },

    // ── app.* methods keyed by an id in data-id ──────────────────────────
    // Every one of these took only an internal id (msg.id / group id / tool
    // id / thinking-section id) inline; the id now rides in data-id (plus
    // data-arg / data-i for the few that take a second argument), and the
    // element reference for toggle-favorite is the element itself.
    'toggle-tool': (el) => window.app?.toggleTool?.(el.dataset.id),
    'toggle-tool-collapse': (el) => window.app?.toggleToolCollapse?.(el.dataset.id),
    'toggle-normal-tool-collapse': (el) => window.app?.toggleNormalToolCollapse?.(el.dataset.id),
    'toggle-tool-group': (el) => window.app?.toggleToolGroup?.(el.dataset.id),
    'copy-tool-output': (el) => window.app?.copyToolOutput?.(el.dataset.id),
    'toggle-task-block': (el) => window.app?.toggleTaskBlock?.(el.dataset.id),
    'toggle-skill-block': (el) => window.app?.toggleSkillBlock?.(el.dataset.id),
    'toggle-task-output-block': (el) => window.app?.toggleTaskOutputBlock?.(el.dataset.id),
    'copy-message': (el) => window.app?.copyMessage?.(el.dataset.id),
    'toggle-message-favorite': (el) => window.app?.toggleMessageFavorite?.(el),
    'preview-plan': () => window.app?.previewPlan?.(),
    'approve-plan': (el) => window.app?.approvePlan?.(el.dataset.id),
    'reject-plan': (el) => window.app?.rejectPlan?.(el.dataset.id),
    'respond-permission': (el) => {
        // data-i present only for a specific suggestion button; absent for the
        // plain allow/deny actions (respondPermission ignores a trailing
        // undefined, matching the old two- vs three-arg call sites).
        const i = el.dataset.i !== undefined ? Number(el.dataset.i) : undefined;
        window.app?.respondPermission?.(el.dataset.id, el.dataset.decision, i);
    },
    'open-login-terminal': (el) => window.app?.openLoginTerminal?.(el.dataset.command || null),
    'edit-question-answer': (el) => window.app?.editQuestionAnswer?.(el.dataset.id),
    'cancel-edit-question': (el) => window.app?.cancelEditQuestion?.(el.dataset.id),
    'ignore-question': (el) => window.app?.ignoreQuestion?.(el.dataset.id),
    'submit-question-answers': (el) => window.app?.submitQuestionAnswers?.(el.dataset.id),
    'toggle-thinking-tools': (el) => window.app?.toggleThinkingTools?.(el.dataset.id),
    'toggle-thinking-step': (el) => window.app?.toggleThinkingStep?.(el.dataset.id, Number(el.dataset.step)),
    'toggle-task-group': (el) => window.app?.toggleTaskGroup?.(el.dataset.id),

    // ── Widget globals ───────────────────────────────────────────────────
    'bt-select-task': (el) => window._btWidget?.selectTask(el.dataset.taskId),
    'bt-back': () => window._btWidget?.backToList(),
    'bt-copy-output': () => window._btWidget?.copyOutput(),
    'cost-retry': () => window.costAnalyticsRetry?.(),

    // ── Small pure-DOM toggles that also swap a tooltip label ────────────
    // The chart/excalidraw "Show JSON ⇄ Show chart" toggles: flip data-cls on
    // the ancestor (data-block) and set data-tooltip to the label matching the
    // new state (data-on-label when the class is now present, else
    // data-off-label).
    'toggle-json-view': (el) => {
        const block = el.closest(el.dataset.block);
        if (!block) return;
        const on = block.classList.toggle(el.dataset.cls);
        el.setAttribute('data-tooltip', on ? el.dataset.onLabel : el.dataset.offLabel);
    },

    // tool-output show-more: two siblings (.tool-output-preview /
    // .tool-output-full) toggle 'hidden' and the button label flips.
    'toggle-tool-output': (el) => {
        const wrap = el.closest(el.dataset.block) || el.parentElement;
        wrap?.querySelector('.tool-output-preview')?.classList.toggle('hidden');
        wrap?.querySelector('.tool-output-full')?.classList.toggle('hidden');
        el.textContent = el.textContent === 'Show more' ? 'Show less' : 'Show more';
    },
});

// ── Dispatcher ─────────────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    const el = t.closest('[data-act]');
    if (!el) return;
    // A plain link between the click target and the actionable ancestor keeps
    // its native behavior — don't hijack it.
    const a = t.closest('a');
    if (a && a !== el && el.contains(a) && !a.dataset.act) return;
    const fn = ACTIONS[el.dataset.act];
    if (fn) fn(el, e);
});
