/**
 * SkillsProvider — list folder-form skills (project + personal + plugin).
 *
 * `$` prefix in the quick switcher. Mirrors the in-input `$` autocomplete
 * but with a different default action: picking a skill here opens the
 * Skills Manager focused on that skill (for viewing/editing). Context
 * menu offers "insert into chat" for users who want the autocomplete
 * behaviour from the picker.
 *
 * Reuses the picker cache from skills-autocomplete.js so the two share
 * a single source of truth and invalidate together.
 */

import { BaseProvider } from './base-provider.js';
import { fetchSkillsForPicker } from '../../skills-autocomplete.js';
import { WidgetManager } from '../../widget-system/index.js';
import { scoreFuzzy } from '../fuzzy-scorer.js';
import { copyToClipboard, showToast } from '../../context-menu.js';
import S from '../../strings.js';

const MAX_RESULTS = 30;

const DOLLAR_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>';

export class SkillsProvider extends BaseProvider {
    async getItems(query) {
        const cwd = window.app?.activeSession?.cwd;
        if (!cwd) return [];

        const all = await fetchSkillsForPicker(cwd);
        const q = query.trim();

        let items;
        if (!q) {
            items = all.slice(0, MAX_RESULTS).map(s => this._toItem(s, null));
        } else {
            const scored = [];
            for (const s of all) {
                const nameScore = scoreFuzzy(s.name, q);
                const descScore = (s.description || '').toLowerCase().includes(q.toLowerCase())
                    ? { score: 30 + q.length, matches: [] }
                    : null;
                if (!nameScore && !descScore) continue;
                const best = nameScore && (!descScore || nameScore.score >= descScore.score)
                    ? nameScore
                    : descScore;
                scored.push({ skill: s, score: best.score, matches: nameScore?.matches || [] });
            }
            scored.sort((a, b) => b.score - a.score);
            items = scored.slice(0, MAX_RESULTS).map(s => this._toItem(s.skill, s.matches));
        }

        // Pinned entry point to the Skills Manager — always last, survives
        // filtering so $ mode never dead-ends in "No results".
        items.push(this._managerItem());
        return items;
    }

    _managerItem() {
        return {
            id: 'skill-manager',
            type: 'skill-manager',
            label: S.quick_switcher.skills.open_manager,
            description: S.quick_switcher.skills.open_manager_desc,
            icon: 'settings',
            data: {},
            matches: null,
        };
    }

    _toItem(skill, matches) {
        const scope = S.skills_widget?.filters?.[skill.scope] || skill.scope;
        return {
            id: `skill:${skill.id}`,
            type: 'skill',
            label: skill.name,
            description: skill.description || '',
            icon: DOLLAR_ICON,
            meta: scope,
            data: {
                skillId: skill.id,
                name: skill.name,
                scope: skill.scope,
                editable: skill.editable,
            },
            matches: matches?.length ? matches : null,
        };
    }

    async execute(item) {
        if (item.type === 'skill-manager') {
            WidgetManager.open('skills');
            return;
        }
        // Default: open the Skills Manager focused on this skill.
        // The widget reads `expandSkillId` from its render context.
        WidgetManager.open('skills', { expandSkillId: item.data.skillId });
    }

    getContextMenuItems(item) {
        if (item.type !== 'skill') return [];
        const QM = S.quick_switcher.context_menu.skill;
        const invocation = `/${item.data.name}`;
        return [
            { label: QM.open_in_manager, action: () => {
                WidgetManager.open('skills', { expandSkillId: item.data.skillId });
            }},
            { label: QM.insert_in_chat, action: () => this._insertInChat(invocation) },
            { type: 'separator' },
            { label: QM.copy_invocation, action: async () => {
                if (await copyToClipboard(invocation)) showToast(S.toast.copied);
            }},
        ];
    }

    _insertInChat(invocation) {
        const input = document.getElementById('message-input');
        if (!input) return;
        const pos = input.selectionStart ?? input.value.length;
        const value = input.value;
        const needsSpace = pos > 0 && !/\s/.test(value[pos - 1]);
        const insertText = (needsSpace ? ' ' : '') + invocation + ' ';
        input.value = value.slice(0, pos) + insertText + value.slice(pos);
        const newPos = pos + insertText.length;
        input.selectionStart = input.selectionEnd = newPos;
        input.focus();
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }
}
