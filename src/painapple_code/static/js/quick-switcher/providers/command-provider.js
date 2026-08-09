/**
 * CommandProvider — wraps the existing QuickActionsRegistry.
 *
 * Every entry in quick-actions-registry.js becomes searchable here, including
 * by `keywords` synonyms (e.g. ">branch" finds fork-session).
 */

import { BaseProvider } from './base-provider.js';
import { QuickActionsRegistry } from '../../quick-actions-registry.js';
import { scoreFuzzy } from '../fuzzy-scorer.js';

const MAX_RESULTS = 30;

export class CommandProvider extends BaseProvider {
    async getItems(query) {
        const all = QuickActionsRegistry.getAll().filter(a => {
            try { return a.isVisible() && a.isEnabled(); } catch { return false; }
        });

        if (!query.trim()) {
            return all.slice(0, MAX_RESULTS).map(a => this._toItem(a, null));
        }

        const scored = [];
        for (const a of all) {
            const haystack = `${a.label} ${a.description || ''} ${(a.keywords || []).join(' ')}`;
            const r = scoreFuzzy(haystack, query);
            if (!r) continue;
            const labelMatch = scoreFuzzy(a.label, query);
            scored.push({
                action: a,
                score: labelMatch ? labelMatch.score + 20 : r.score,
                matches: labelMatch ? labelMatch.matches : null,
            });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, MAX_RESULTS).map(s => this._toItem(s.action, s.matches));
    }

    _toItem(action, matches) {
        return {
            id: `cmd:${action.id}`,
            type: 'command',
            label: action.label,
            description: action.description !== action.label ? action.description : '',
            icon: action.icon,
            meta: action.shortcutDisplay || '',
            data: { actionId: action.id },
            matches,
        };
    }

    async execute(item) {
        QuickActionsRegistry.execute(item.data.actionId);
    }
}
