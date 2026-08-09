/**
 * PanelProvider — fuzzy search over registered widgets.
 *
 * Default action toggles the widget (open if closed, close if open).
 */

import { BaseProvider } from './base-provider.js';
import { WidgetManager } from '../../widget-system/index.js';
import { WidgetBus } from '../../widget-system/event-bus.js';
import { scoreFuzzy } from '../fuzzy-scorer.js';
import { formatLiteralChord } from '../../shortcuts.js';
import S from '../../strings.js';

const MAX_RESULTS = 30;

// Semantic grouping for the empty-query panel list. Search mode stays flat.
const GROUP_ORDER = ['work', 'analytics', 'workflow', 'system', 'other'];
const GROUP_BY_ID = {
    'file-explorer':    'work',
    'git':              'work',
    'terminal':         'work',
    'history-explorer': 'work',
    'browser':          'work',

    'cost-analytics':   'analytics',
    'log-explorer':     'analytics',
    'prompt-explorer':  'analytics',
    'active-sessions':  'analytics',
    'background-tasks': 'analytics',

    'agents':           'workflow',
    'sub-agents':       'workflow',
    'skills':           'workflow',
    'discussion':       'workflow',
    'uploads':          'workflow',

    'config':           'system',
    'debug-logs':       'system',
};

export class PanelProvider extends BaseProvider {
    async getItems(query) {
        // Iterate registered widget configs, not instances — widgets are
        // lazily instantiated on first open, so WidgetManager.list() would
        // hide everything the user hasn't touched yet.
        const all = Array.from(WidgetManager.configs?.values() || []);
        const configs = all.filter(c => !c.hiddenInPicker);
        if (!configs.length) return [];

        if (!query.trim()) {
            // Group by category, open widgets first within each group.
            const byGroup = new Map(GROUP_ORDER.map(g => [g, []]));
            for (const c of configs) {
                const g = GROUP_BY_ID[c.id] || 'other';
                byGroup.get(g).push(c);
            }
            const out = [];
            for (const g of GROUP_ORDER) {
                const items = byGroup.get(g);
                if (!items.length) continue;
                items.sort((a, b) => {
                    const ao = WidgetManager.isOpen(a.id) ? 0 : 1;
                    const bo = WidgetManager.isOpen(b.id) ? 0 : 1;
                    if (ao !== bo) return ao - bo;
                    return (a.title || a.id).localeCompare(b.title || b.id);
                });
                const groupTitle = S.quick_switcher.panel_groups?.[g] || g;
                for (const c of items) out.push(this._toItem(c, null, groupTitle));
                if (out.length >= MAX_RESULTS) break;
            }
            return out.slice(0, MAX_RESULTS);
        }

        const scored = [];
        for (const c of configs) {
            const title = c.title || c.id;
            const r = scoreFuzzy(title, query);
            if (!r) continue;
            scored.push({ config: c, score: r.score, matches: r.matches });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, MAX_RESULTS).map(s => this._toItem(s.config, s.matches, null));
    }

    _toItem(config, matches, group) {
        const open = WidgetManager.isOpen(config.id);
        return {
            id: `panel:${config.id}`,
            type: 'panel',
            label: config.title || config.id,
            description: '',
            icon: config.icon || 'sidebar',
            // Widget `shortcut:` fields are hardcoded in their Ctrl form.
            meta: open ? 'open' : (formatLiteralChord(config.shortcut) || ''),
            data: { widgetId: config.id },
            matches,
            group,
        };
    }

    async execute(item, opts = {}) {
        const id = item.data.widgetId;
        if (opts.background) {
            this._openAsTab(id, { background: true });
            return;
        }
        if (opts.newTab) {
            this._openAsTab(id, { background: false });
            return;
        }
        WidgetManager.toggle(id);
    }

    _openAsTab(widgetId, { background }) {
        const config = WidgetManager.configs?.get?.(widgetId);
        const title = config?.title || widgetId;
        const icon = config?.icon || 'layers';
        // tab-controller listens on this bus event for widget:open-as-tab.
        WidgetBus.emit('widget:open-as-tab', { widgetId, title, icon, background });
    }

    getContextMenuItems(item) {
        const id = item.data.widgetId;
        const open = WidgetManager.isOpen(id);
        const QM = S.quick_switcher.context_menu.panel;
        return [
            { label: open ? QM.close : QM.open, action: () => WidgetManager.toggle(id) },
            { label: QM.open_tab, action: () => this._openAsTab(id, { background: false }) },
            { label: QM.open_background, action: () => this._openAsTab(id, { background: true }) },
        ];
    }
}
