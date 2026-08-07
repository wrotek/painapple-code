/**
 * Skills Autocomplete Module
 *
 * `$` trigger that shows a picker of folder-form skills (project +
 * personal + plugin) and inserts `/skill-name ` at the cursor on select.
 * Mirrors the `#` snippets picker, but skills-only.
 *
 * Source of truth is `/api/skills?cwd=...`. Results are cached in memory
 * by cwd and refreshed lazily on first open per cwd.
 */

import S from './strings.js';
import { escapeHtml } from './utils.js';
import { CONFIG } from './config.js';
import { anchorAbove } from './caret-position.js';

// Short-TTL cache so the picker is snappy when reopened in quick succession
// but still reflects skills the user just created/deleted in the Skills widget.
const CACHE_TTL_MS = 5000;
let _cache = null;       // { cwd, items, fetchedAt }
let _inflight = null;    // Promise<Array> while a fetch is pending

export async function fetchSkillsForPicker(cwd) {
    if (!cwd) return [];
    const now = Date.now();
    if (_cache && _cache.cwd === cwd && (now - _cache.fetchedAt) < CACHE_TTL_MS) {
        return _cache.items;
    }
    if (_inflight) return _inflight;
    _inflight = (async () => {
        try {
            const r = await fetch(`${CONFIG.API_BASE}/api/skills?cwd=${encodeURIComponent(cwd)}`);
            if (!r.ok) return _cache?.items || [];
            const data = await r.json();
            const items = (data.skills || []).map(s => ({
                id: s.id,
                name: s.name,
                scope: s.scope,
                scope_label: s.scope_label,
                description: s.description || '',
                editable: s.editable,
            }));
            _cache = { cwd, items, fetchedAt: Date.now() };
            return items;
        } catch {
            return _cache?.items || [];
        } finally {
            _inflight = null;
        }
    })();
    return _inflight;
}

export function invalidateSkillsCache() {
    _cache = null;
}

export class SkillsAutocomplete {
    constructor(input) {
        this.input = input;

        this.visible = false;
        this.items = [];
        this.selectedIndex = 0;
        this.triggerPos = -1;
        this.query = '';
        this._loading = false;

        this.container = document.createElement('div');
        this.container.id = 'skills-autocomplete';
        this.container.className = 'snippets-autocomplete';

        this.input.parentElement.insertBefore(this.container, this.input);

        this._handleClick = this._handleClick.bind(this);
        this.container.addEventListener('click', this._handleClick);
    }

    _fuzzyScore(text, query) {
        if (!query) return 1;
        const t = text.toLowerCase();
        const q = query.toLowerCase();
        if (t.startsWith(q)) return 100 + q.length * 10;
        const words = t.split(/[\s\-_]/);
        for (const w of words) {
            if (w.startsWith(q)) return 80 + q.length * 5;
        }
        // Subsequence fuzzy
        let score = 0, ti = 0, prev = -1, run = 0;
        for (const ch of q) {
            const idx = t.indexOf(ch, ti);
            if (idx === -1) return 0;
            if (prev !== -1 && idx === prev + 1) { run += 2; score += 5 + run; }
            else { run = 0; }
            score += 1;
            prev = idx;
            ti = idx + 1;
        }
        return score;
    }

    _search(query, allItems) {
        if (!query) return allItems.slice(0, 12);
        const q = query.toLowerCase();
        const scored = allItems
            .map(item => {
                // Name uses fuzzy (prefix > word-start > subsequence) — names are short
                // enough that subsequence isn't noisy.
                const nameScore = this._fuzzyScore(item.name, query);
                // Description uses contiguous substring only. Fuzzy on a long
                // description scoops up unrelated entries (e.g. searching
                // "clickup" matches a description containing "ClickHouse" because
                // c-l-i-c-k-h-...-u-p exists as a subsequence).
                const desc = (item.description || '').toLowerCase();
                const descScore = desc.includes(q) ? 30 + q.length : 0;
                const score = Math.max(nameScore, descScore);
                if (score === 0) return null;
                return { ...item, score };
            })
            .filter(Boolean);
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, 10);
    }

    async show(query, triggerPos, cwd) {
        this.triggerPos = triggerPos;
        this.query = query;
        this._loading = true;

        const all = await fetchSkillsForPicker(cwd);
        // If trigger position has moved away while we were fetching, abort.
        if (this.triggerPos !== triggerPos) return;
        this._loading = false;
        this.items = this._search(query, all);

        if (this.items.length === 0) {
            this.hide();
            return;
        }

        this.selectedIndex = this.noPreselectOnce ? -1 : 0;
        this.noPreselectOnce = false;
        this.visible = true;
        this.render();
        this.container.classList.add('visible');
        this.container.scrollTop = 0;
        this._detachAnchor?.();
        this._detachAnchor = anchorAbove(this.container, this.input, triggerPos);
    }

    hide() {
        this.visible = false;
        this.container.classList.remove('visible');
        this.items = [];
        this.selectedIndex = 0;
        this.triggerPos = -1;
        this.query = '';
        this._detachAnchor?.();
        this._detachAnchor = null;
    }

    render() {
        const groups = { project: [], personal: [], plugin: [] };
        for (const item of this.items) {
            (groups[item.scope] || (groups[item.scope] = [])).push(item);
        }

        let html = '';
        for (const scope of ['project', 'personal', 'plugin']) {
            const arr = groups[scope];
            if (!arr || arr.length === 0) continue;
            const label = S.skills_widget?.picker_groups?.[scope]
                || S.skills_widget?.groups?.[scope]
                || scope;
            html += `<div class="snippets-section"><span>${label}</span><a class="snippets-edit-link" href="#" data-widget="skills">Edit</a></div>`;
            for (const item of arr) {
                const i = this.items.indexOf(item);
                html += this._renderItem(item, i);
            }
        }
        this.container.innerHTML = html;
    }

    _renderItem(item, index) {
        const highlighted = this._highlight(item.name, this.query);
        const scopeBadge = `<span class="snippets-type-badge ${item.scope === 'project' ? 'project' : 'agent'}">${escapeHtml(item.scope)}</span>`;
        return `
            <div class="snippets-item ${index === this.selectedIndex ? 'selected' : ''}" data-index="${index}">
                <div class="snippets-content">
                    <span class="snippets-name">${highlighted}</span>
                    ${item.description ? `<span class="snippets-desc">${escapeHtml(item.description)}</span>` : ''}
                </div>
                ${scopeBadge}
            </div>
        `;
    }

    _highlight(text, query) {
        if (!query) return escapeHtml(text);
        const t = text.toLowerCase();
        const q = query.toLowerCase();
        let out = '', ti = 0, qi = 0;
        while (ti < text.length) {
            if (qi < q.length && t[ti] === q[qi]) {
                out += `<mark>${escapeHtml(text[ti])}</mark>`;
                qi++;
            } else {
                out += escapeHtml(text[ti]);
            }
            ti++;
        }
        return out;
    }

    moveSelection(delta) {
        if (!this.visible || this.items.length === 0) return;
        this.selectedIndex += delta;
        if (this.selectedIndex < 0) this.selectedIndex = this.items.length - 1;
        if (this.selectedIndex >= this.items.length) this.selectedIndex = 0;
        this.render();
        this.container.querySelector('.snippets-item.selected')
            ?.scrollIntoView({ block: 'nearest' });
    }

    select(index = this.selectedIndex) {
        if (index < 0 || index >= this.items.length) return;
        const item = this.items[index];
        // Replace `$query` at triggerPos with `/skill-name `
        const insertText = `/${item.name} `;
        const value = this.input.value;
        const before = value.slice(0, this.triggerPos);
        const after = value.slice(this.triggerPos + 1 + this.query.length);
        this.input.value = before + insertText + after;
        const cursor = before.length + insertText.length;
        this.input.selectionStart = this.input.selectionEnd = cursor;
        this.input.focus();
        this.hide();
        this.input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    _handleClick(e) {
        const editLink = e.target.closest('.snippets-edit-link');
        if (editLink) {
            e.preventDefault();
            e.stopPropagation();
            this.hide();
            const widgetId = editLink.dataset.widget || 'skills';
            window.WidgetManager?.open(widgetId);
            return;
        }

        const item = e.target.closest('.snippets-item');
        if (item) {
            const index = parseInt(item.dataset.index, 10);
            this.select(index);
        }
    }

    hasSelection() {
        return this.selectedIndex >= 0 && this.selectedIndex < this.items.length;
    }
}
