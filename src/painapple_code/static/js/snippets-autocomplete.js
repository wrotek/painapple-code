/**
 * Snippets Autocomplete Module
 * Provides suggestions for agents and user-defined text snippets when typing # in chat input
 *
 * Data is stored server-side in ~/.painapple-code/config.json
 * with localStorage as cache/fallback for offline use.
 */

import S from './strings.js';
import { escapeHtml } from './utils.js';
import { CONFIG } from './config.js';
import { anchorAbove } from './caret-position.js';

/**
 * Get user-facing agents — discovered from ~/.claude/agents/ and the
 * project's `<cwd>/.claude/agents/`. Claude's hardcoded built-ins
 * (Explore, Plan, general-purpose) are intentionally excluded — they
 * are agents Claude uses internally, not ones humans typically invoke
 * via `#`.
 */
export function getBuiltInAgents() {
    return loadDiscoveredAgents();
}

// localStorage cache keys (fallback for offline use)
const SNIPPETS_CACHE_KEY = 'claude-code-snippets-cache';
const LEGACY_SNIPPETS_CACHE_KEY = 'claude-code-favorites-cache';
const DISABLED_AGENTS_CACHE_KEY = 'claude-code-disabled-agents-cache';
const AGENT_PATTERNS_CACHE_KEY = 'claude-code-agent-patterns-cache';
const DISCOVERED_AGENTS_CACHE_KEY = 'claude-code-discovered-agents-cache';

// Default pattern - {agent} is replaced with agent name
export const DEFAULT_AGENT_PATTERN = S.prompts.agents.default_pattern;

// In-memory cache (populated from server or localStorage)
let _snippetsCache = null;
let _disabledAgentsCache = null;
let _agentPatternsCache = null;
let _discoveredAgentsCache = null;

// ═══════════════════════════════════════════════════════════════════════════
// Server API Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch user snippets from server
 */
export async function fetchUserSnippets() {
    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/user/snippets`);
        if (response.ok) {
            const data = await response.json();
            _snippetsCache = data.snippets || [];
            _disabledAgentsCache = new Set(data.disabled_agents || []);
            localStorage.setItem(SNIPPETS_CACHE_KEY, JSON.stringify(_snippetsCache));
            localStorage.setItem(DISABLED_AGENTS_CACHE_KEY, JSON.stringify([..._disabledAgentsCache]));
            localStorage.removeItem(LEGACY_SNIPPETS_CACHE_KEY);
            return data;
        }
    } catch (e) {
        console.error('Failed to fetch snippets from server:', e);
    }
    return null;
}

/**
 * Save user snippets to server
 */
export async function saveUserSnippets(snippets, disabledAgents) {
    _snippetsCache = snippets;
    _disabledAgentsCache = disabledAgents instanceof Set ? disabledAgents : new Set(disabledAgents);
    localStorage.setItem(SNIPPETS_CACHE_KEY, JSON.stringify(_snippetsCache));
    localStorage.setItem(DISABLED_AGENTS_CACHE_KEY, JSON.stringify([..._disabledAgentsCache]));

    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/user/snippets`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                snippets: snippets,
                disabled_agents: [..._disabledAgentsCache]
            })
        });
        return response.ok;
    } catch (e) {
        console.error('Failed to save snippets to server:', e);
        return false;
    }
}

/**
 * Fetch agent patterns from server
 */
export async function fetchAgentPatterns() {
    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/user/agent-patterns`);
        if (response.ok) {
            const data = await response.json();
            _agentPatternsCache = data;
            localStorage.setItem(AGENT_PATTERNS_CACHE_KEY, JSON.stringify(data));
            return data;
        }
    } catch (e) {
        console.error('Failed to fetch agent patterns from server:', e);
    }
    return null;
}

/**
 * Save agent patterns to server
 */
export async function saveAgentPatternsToServer(patterns) {
    _agentPatternsCache = patterns;
    localStorage.setItem(AGENT_PATTERNS_CACHE_KEY, JSON.stringify(patterns));

    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/user/agent-patterns`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patterns)
        });
        return response.ok;
    } catch (e) {
        console.error('Failed to save agent patterns to server:', e);
        return false;
    }
}

/**
 * Fetch discovered agents from ~/.claude/agents/ and optionally {cwd}/.claude/agents/
 * These are user-defined agents with YAML frontmatter
 * @param {string} [cwd] - Optional project directory to scan for project-local agents
 */
export async function fetchDiscoveredAgents(cwd = null) {
    try {
        let url = `${CONFIG.API_BASE}/api/agents`;
        if (cwd) {
            url += `?cwd=${encodeURIComponent(cwd)}`;
        }
        const response = await fetch(url);
        if (response.ok) {
            const data = await response.json();
            const agents = (data.agents || []).map(agent => ({
                id: agent.id,
                name: agent.name,
                desc: agent.description || '',
                type: 'agent',
                file: agent.file,
                source: agent.source || 'global'
            }));
            _discoveredAgentsCache = agents;
            localStorage.setItem(DISCOVERED_AGENTS_CACHE_KEY, JSON.stringify(agents));
            return agents;
        }
    } catch (e) {
        console.error('Failed to fetch discovered agents:', e);
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Synchronous Access Functions (use cache/localStorage)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Load disabled agents set (from cache or localStorage)
 */
export function loadDisabledAgents() {
    if (_disabledAgentsCache) {
        return _disabledAgentsCache;
    }
    try {
        const saved = localStorage.getItem(DISABLED_AGENTS_CACHE_KEY);
        if (saved) {
            _disabledAgentsCache = new Set(JSON.parse(saved));
            return _disabledAgentsCache;
        }
    } catch (e) {
        console.error('Failed to load disabled agents:', e);
    }
    return new Set();
}

/**
 * Save disabled agents set (updates cache and server)
 */
export function saveDisabledAgents(disabledSet) {
    _disabledAgentsCache = disabledSet;
    localStorage.setItem(DISABLED_AGENTS_CACHE_KEY, JSON.stringify([...disabledSet]));
    saveUserSnippets(loadSnippets(), disabledSet);
}

/**
 * Load user snippets (from cache or localStorage)
 */
export function loadSnippets() {
    if (_snippetsCache) {
        return _snippetsCache;
    }
    try {
        const saved = localStorage.getItem(SNIPPETS_CACHE_KEY)
            ?? localStorage.getItem(LEGACY_SNIPPETS_CACHE_KEY);
        if (saved) {
            _snippetsCache = JSON.parse(saved);
            return _snippetsCache;
        }
    } catch (e) {
        console.error('Failed to load snippets:', e);
    }
    return [];
}

/**
 * Save user snippets (updates cache and server)
 */
export function saveSnippets(snippets) {
    _snippetsCache = snippets;
    localStorage.setItem(SNIPPETS_CACHE_KEY, JSON.stringify(snippets));
    saveUserSnippets(snippets, loadDisabledAgents());
}

/**
 * Load discovered agents (from cache or localStorage)
 * These are agents from ~/.claude/agents/
 */
export function loadDiscoveredAgents() {
    if (_discoveredAgentsCache) {
        return _discoveredAgentsCache;
    }
    try {
        const saved = localStorage.getItem(DISCOVERED_AGENTS_CACHE_KEY);
        if (saved) {
            _discoveredAgentsCache = JSON.parse(saved);
            return _discoveredAgentsCache;
        }
    } catch (e) {
        console.error('Failed to load discovered agents:', e);
    }
    return [];
}

/**
 * Load agent patterns (from cache or localStorage)
 */
export function loadAgentPatterns() {
    if (_agentPatternsCache) {
        return _agentPatternsCache;
    }
    try {
        const saved = localStorage.getItem(AGENT_PATTERNS_CACHE_KEY);
        if (saved) {
            _agentPatternsCache = JSON.parse(saved);
            return _agentPatternsCache;
        }
    } catch (e) {
        console.error('Failed to load agent patterns:', e);
    }
    return { global: DEFAULT_AGENT_PATTERN, agents: {} };
}

/**
 * Save agent patterns (updates cache and server)
 */
export function saveAgentPatterns(patterns) {
    _agentPatternsCache = patterns;
    localStorage.setItem(AGENT_PATTERNS_CACHE_KEY, JSON.stringify(patterns));
    saveAgentPatternsToServer(patterns);
}

/**
 * Get the pattern to use for a specific agent
 */
export function getAgentPattern(agentId) {
    const patterns = loadAgentPatterns();
    return patterns.agents[agentId] || patterns.global || DEFAULT_AGENT_PATTERN;
}

/**
 * Initialize snippets data from server
 * Call this on app startup
 * @param {string} [cwd] - Optional project directory for project-local agents
 */
export async function initSnippetsData(cwd = null) {
    await Promise.all([
        fetchUserSnippets(),
        fetchAgentPatterns(),
        fetchDiscoveredAgents(cwd)
    ]);
}

/**
 * Refresh agents for a new cwd (call when session cwd changes)
 * @param {string} cwd - The new project directory
 */
export async function refreshAgentsForCwd(cwd) {
    return fetchDiscoveredAgents(cwd);
}

/**
 * SnippetsAutocomplete - Suggestions for # trigger
 */
export class SnippetsAutocomplete {
    /**
     * @param {HTMLTextAreaElement} input - The message input element
     * @param {Object} options - Configuration options
     */
    constructor(input, options = {}) {
        this.input = input;

        this.visible = false;
        this.items = [];
        this.selectedIndex = 0;
        this.triggerPos = -1;
        this.query = '';

        this.container = document.createElement('div');
        this.container.id = 'snippets-autocomplete';
        this.container.className = 'snippets-autocomplete';

        this.input.parentElement.insertBefore(this.container, this.input);

        this._handleClick = this._handleClick.bind(this);
        this.container.addEventListener('click', this._handleClick);

        this._handleModifier = this._handleModifier.bind(this);
    }

    /**
     * Track Alt / Ctrl-Cmd modifier state while the dropdown is visible
     * so the highlighted action icon reflects what Enter will do.
     *
     * Also fires the corresponding action on Enter+modifier here in capture
     * phase, so the action can't be swallowed by an upstream global keydown
     * listener (this kept biting on iPad and Mac where Cmd+Enter goes
     * through document-level shortcut dispatchers).
     */
    _handleModifier(e) {
        let mod = '';
        if (e.ctrlKey || e.metaKey) mod = 'mod-ctrl';
        else if (e.altKey) mod = 'mod-alt';
        if (mod !== this._currentMod) {
            this.container.classList.remove('mod-alt', 'mod-ctrl');
            if (mod) this.container.classList.add(mod);
            this._currentMod = mod;
        }

        if (e.type === 'keydown' && e.key === 'Enter' && this.hasSelection()) {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                e.stopImmediatePropagation();
                this.selectAndSend();
                return;
            }
            if (e.altKey) {
                e.preventDefault();
                e.stopImmediatePropagation();
                this.select(undefined, { short: true });
                return;
            }
        }
    }

    /**
     * Get all items (discovered agents + user snippets)
     */
    getAllItems() {
        const disabled = loadDisabledAgents();
        const agents = getBuiltInAgents().filter(a => !disabled.has(a.id));

        const userSnippets = loadSnippets()
            .filter(s => !s.hidden)
            .map(s => ({
                ...s,
                type: 'snippet'
            }));

        return [...agents, ...userSnippets];
    }

    /**
     * Fuzzy match score between query and text
     */
    _fuzzyScore(text, query) {
        if (!query) return 1;

        const textLower = text.toLowerCase();
        const queryLower = query.toLowerCase();

        if (textLower.startsWith(queryLower)) {
            return 100 + (queryLower.length * 10);
        }

        const words = textLower.split(/[\s-_]/);
        for (const word of words) {
            if (word.startsWith(queryLower)) {
                return 80 + (queryLower.length * 5);
            }
        }

        let score = 0;
        let textIdx = 0;
        let prevMatchIdx = -1;
        let consecutiveBonus = 0;

        for (const char of queryLower) {
            const idx = textLower.indexOf(char, textIdx);
            if (idx === -1) return 0;

            if (prevMatchIdx !== -1 && idx === prevMatchIdx + 1) {
                consecutiveBonus += 2;
                score += 5 + consecutiveBonus;
            } else {
                consecutiveBonus = 0;
            }

            score += 1;
            prevMatchIdx = idx;
            textIdx = idx + 1;
        }

        return score;
    }

    /**
     * Search items with fuzzy matching
     */
    search(query) {
        const items = this.getAllItems();

        if (!query) {
            return items.slice(0, 12);
        }

        const scored = items
            .map(item => {
                const nameScore = this._fuzzyScore(item.name, query);
                const descScore = this._fuzzyScore(item.desc || '', query) * 0.5;
                const score = Math.max(nameScore, descScore);

                if (score === 0) return null;
                return { ...item, score };
            })
            .filter(Boolean);

        scored.sort((a, b) => b.score - a.score);

        return scored.slice(0, 10);
    }

    /**
     * Show the autocomplete dropdown
     */
    show(query, triggerPos) {
        this.triggerPos = triggerPos;
        this.query = query;

        this.items = this.search(query);

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
        window.addEventListener('keydown', this._handleModifier, true);
        window.addEventListener('keyup', this._handleModifier, true);
    }

    /**
     * Hide the autocomplete dropdown
     */
    hide() {
        this.visible = false;
        this.container.classList.remove('visible', 'mod-alt', 'mod-ctrl');
        this._currentMod = '';
        this.items = [];
        this.selectedIndex = 0;
        this.triggerPos = -1;
        this.query = '';
        this._detachAnchor?.();
        this._detachAnchor = null;
        window.removeEventListener('keydown', this._handleModifier, true);
        window.removeEventListener('keyup', this._handleModifier, true);
    }

    /**
     * Render the dropdown
     */
    render() {
        const hasAgents = this.items.some(i => i.type === 'agent');
        const hasSnippets = this.items.some(i => i.type === 'snippet');
        const showSnippetsHeader = hasSnippets || loadSnippets().length === 0;

        let html = '';

        if (hasAgents) {
            html += '<div class="snippets-section"><span>Agents</span><a class="snippets-edit-link" href="#" data-widget="agents">Edit</a></div>';
            this.items.forEach((item, i) => {
                if (item.type !== 'agent') return;
                html += this._renderItem(item, i);
            });
        }

        if (showSnippetsHeader) {
            html += '<div class="snippets-section"><span>Snippets</span><a class="snippets-edit-link" href="#" data-widget="snippets">Edit</a></div>';
            this.items.forEach((item, i) => {
                if (item.type !== 'snippet') return;
                html += this._renderItem(item, i);
            });
        }

        if (!hasAgents && !showSnippetsHeader) {
            this.items.forEach((item, i) => {
                html += this._renderItem(item, i);
            });
        }

        this.container.innerHTML = html;
    }

    /**
     * Render a single item
     */
    _renderItem(item, index) {
        const highlighted = this.highlightMatch(item.name, this.query);
        let typeBadge = '';
        if (item.type === 'agent' && item.source === 'project') {
            typeBadge = '<span class="snippets-type-badge project">project</span>';
        }

        return `
            <div class="snippets-item ${index === this.selectedIndex ? 'selected' : ''}"
                 data-index="${index}">
                <div class="snippets-content">
                    <span class="snippets-name">${highlighted}</span>
                    ${item.desc ? `<span class="snippets-desc">${escapeHtml(item.desc)}</span>` : ''}
                </div>
                ${typeBadge}
                <div class="snippets-actions">
                    <button class="snippets-insert-btn" data-index="${index}" data-tooltip="Insert (Enter)">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="9 10 4 15 9 20"/>
                            <path d="M20 4v7a4 4 0 0 1-4 4H4"/>
                        </svg>
                    </button>
                    <button class="snippets-insertname-btn" data-index="${index}" data-tooltip="Insert name only (Alt+Enter)">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="4 7 4 4 20 4 20 7"/>
                            <line x1="9" y1="20" x2="15" y2="20"/>
                            <line x1="12" y1="4" x2="12" y2="20"/>
                        </svg>
                    </button>
                    <button class="snippets-send-btn" data-index="${index}" data-tooltip="Send now (Ctrl+Enter)">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="22" y1="2" x2="11" y2="13"/>
                            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                        </svg>
                    </button>
                </div>
            </div>
        `;
    }

    /**
     * Highlight matching characters
     */
    highlightMatch(text, query) {
        if (!query) return escapeHtml(text);

        const textLower = text.toLowerCase();
        const queryLower = query.toLowerCase();

        let result = '';
        let textIdx = 0;
        let queryIdx = 0;

        while (textIdx < text.length) {
            if (queryIdx < queryLower.length && textLower[textIdx] === queryLower[queryIdx]) {
                result += `<mark>${escapeHtml(text[textIdx])}</mark>`;
                queryIdx++;
            } else {
                result += escapeHtml(text[textIdx]);
            }
            textIdx++;
        }

        return result;
    }

    /**
     * Move selection up or down
     */
    moveSelection(delta) {
        if (!this.visible || this.items.length === 0) return;

        this.selectedIndex += delta;
        if (this.selectedIndex < 0) this.selectedIndex = this.items.length - 1;
        if (this.selectedIndex >= this.items.length) this.selectedIndex = 0;

        this.render();

        const selectedEl = this.container.querySelector('.snippets-item.selected');
        if (selectedEl) {
            selectedEl.scrollIntoView({ block: 'nearest' });
        }
    }

    /**
     * Select the current item
     * @param {number} index - Item index to select
     * @param {object} options - { short: true } to insert just the name instead of full pattern
     */
    select(index = this.selectedIndex, { short = false } = {}) {
        if (index < 0 || index >= this.items.length) return;

        const item = this.items[index];

        let insertText;
        if (short) {
            insertText = item.name + ' ';
        } else if (item.type === 'agent') {
            const pattern = getAgentPattern(item.id);
            insertText = pattern.replace('{agent}', item.name);
            if (!insertText.endsWith(' ')) {
                insertText += ' ';
            }
        } else {
            insertText = (item.text || item.name) + ' ';
        }

        const value = this.input.value;
        const before = value.slice(0, this.triggerPos);
        const after = value.slice(this.triggerPos + 1 + this.query.length);

        this.input.value = before + insertText + after;
        this.input.focus();

        const cursorPos = before.length + insertText.length;
        this.input.selectionStart = this.input.selectionEnd = cursorPos;

        this.hide();

        this.input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /**
     * Handle click on item
     */
    _handleClick(e) {
        const editLink = e.target.closest('.snippets-edit-link');
        if (editLink) {
            e.preventDefault();
            e.stopPropagation();
            this.hide();
            const widgetId = editLink.dataset.widget || 'snippets';
            window.WidgetManager?.open(widgetId);
            return;
        }

        const sendBtn = e.target.closest('.snippets-send-btn');
        if (sendBtn) {
            e.stopPropagation();
            const index = parseInt(sendBtn.dataset.index, 10);
            this.selectAndSend(index);
            return;
        }

        const insertNameBtn = e.target.closest('.snippets-insertname-btn');
        if (insertNameBtn) {
            e.stopPropagation();
            const index = parseInt(insertNameBtn.dataset.index, 10);
            this.select(index, { short: true });
            return;
        }

        const item = e.target.closest('.snippets-item');
        if (item) {
            const index = parseInt(item.dataset.index, 10);
            this.select(index);
        }
    }

    /**
     * Select an item and immediately send it
     */
    selectAndSend(index = this.selectedIndex) {
        if (index < 0 || index >= this.items.length) return;

        const item = this.items[index];

        let sendText;
        if (item.type === 'agent') {
            const pattern = getAgentPattern(item.id);
            sendText = pattern.replace('{agent}', item.name);
            if (!sendText.endsWith(' ')) {
                sendText += ' ';
            }
        } else {
            sendText = (item.text || item.name);
        }

        const value = this.input.value;
        const before = value.slice(0, this.triggerPos);
        const after = value.slice(this.triggerPos + 1 + this.query.length);
        this.input.value = before + after;

        this.hide();

        if (window.app) {
            const remainingText = this.input.value.trim();
            const finalMessage = remainingText ? `${sendText.trim()} ${remainingText}` : sendText.trim();
            this.input.value = '';
            window.app.sendMessage(finalMessage);
        }
    }

    /**
     * Check if there's a valid selection
     */
    hasSelection() {
        return this.selectedIndex >= 0 && this.selectedIndex < this.items.length;
    }

    /**
     * Get the currently selected item
     */
    getSelectedItem() {
        if (!this.hasSelection()) return null;
        return this.items[this.selectedIndex];
    }
}
