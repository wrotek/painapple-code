/**
 * ProjectProvider — list projects tracked by the bridge.
 *
 * Default action opens a fresh session tab for the project.
 * Right arrow drills into a project to show its recent sessions; picking
 * one opens that session in a new tab. Left arrow (or Backspace on empty)
 * drills back out.
 */

import { BaseProvider } from './base-provider.js';
import { CONFIG } from '../../config.js';
import { scoreFuzzy } from '../fuzzy-scorer.js';
import { copyToClipboard, showToast } from '../../context-menu.js';
import S from '../../strings.js';

const CACHE_TTL = 60_000;
const SESSIONS_CACHE_TTL = 30_000;
const MAX_RESULTS = 30;
const SESSIONS_LIMIT = 20;

export class ProjectProvider extends BaseProvider {
    constructor() {
        super();
        this._cache = null;
        this._sessionsCache = new Map();    // path → { t, sessions } — recent-N preview
        this._allSessionsCache = new Map(); // path → { t, promise } — full list for search
        this._focusedProject = null;     // { path, name } when drilled in
        this._lastFocusedPath = null;    // one-shot: reselect this project after drill-out
    }

    async _loadProjects() {
        if (this._cache && Date.now() - this._cache.t < CACHE_TTL) {
            return this._cache.projects;
        }
        try {
            const r = await fetch(`${CONFIG.API_BASE}/api/welcome/projects`);
            if (!r.ok) return [];
            const data = await r.json();
            const projects = data.projects || [];
            this._cache = { t: Date.now(), projects };
            return projects;
        } catch {
            return [];
        }
    }

    async _loadSessions(path) {
        const cached = this._sessionsCache.get(path);
        if (cached && Date.now() - cached.t < SESSIONS_CACHE_TTL) {
            return cached.sessions;
        }
        try {
            const url = `${CONFIG.API_BASE}/api/welcome/projects/sessions?path=${encodeURIComponent(path)}&limit=${SESSIONS_LIMIT}`;
            const r = await fetch(url);
            if (!r.ok) return [];
            const data = await r.json();
            const sessions = data.sessions || [];
            this._sessionsCache.set(path, { t: Date.now(), sessions });
            return sessions;
        } catch {
            return [];
        }
    }

    /**
     * Full session list for a project (limit=0 → all non-empty sessions,
     * with shadow-git summaries). Used only once the user types a query —
     * the empty-query preview stays on the cheap recent-N fetch. Caches the
     * in-flight promise so drill-in prefetch and the first keystroke share
     * one request.
     */
    _loadAllSessions(path) {
        const cached = this._allSessionsCache.get(path);
        if (cached && Date.now() - cached.t < SESSIONS_CACHE_TTL) {
            return cached.promise;
        }
        const promise = (async () => {
            try {
                const url = `${CONFIG.API_BASE}/api/welcome/projects/sessions?path=${encodeURIComponent(path)}&limit=0`;
                const r = await fetch(url);
                if (!r.ok) return null;
                const data = await r.json();
                return data.sessions || [];
            } catch {
                return null;
            }
        })().then(sessions => {
            // Don't cache failures — retry on the next keystroke.
            if (sessions === null) {
                this._allSessionsCache.delete(path);
                return null;
            }
            return sessions;
        });
        this._allSessionsCache.set(path, { t: Date.now(), promise });
        return promise;
    }

    async getItems(query) {
        if (this._focusedProject) return this._getSessionItems(query);
        return this._getProjectItems(query);
    }

    async _getProjectItems(query) {
        const projects = await this._loadProjects();
        if (!projects.length) return [];

        const q = query.trim();

        // One-shot: right after drilling back out, reselect the project the
        // user just left instead of resetting to the top of the list.
        const lastFocused = this._lastFocusedPath;
        this._lastFocusedPath = null;

        if (!q) {
            const sorted = [...projects].sort((a, b) =>
                (b.session_count || 0) - (a.session_count || 0)
                || a.name.localeCompare(b.name)
            );
            const target = lastFocused || this._findCurrentProjectPath(sorted);
            return sorted.slice(0, MAX_RESULTS).map(p => {
                const item = this._toProjectItem(p, null);
                if (target && p.path.replace(/\/$/, '') === target.replace(/\/$/, '')) {
                    item.preselected = true;
                }
                return item;
            });
        }

        const qLower = q.toLowerCase();
        const scored = [];
        for (const p of projects) {
            const nameScore = scoreFuzzy(p.name, q);
            const pathScore = scoreFuzzy(p.path, q);
            if (!nameScore && !pathScore) continue;

            let score, matches;
            if (nameScore) {
                score = nameScore.score * 3 + (pathScore ? pathScore.score * 0.2 : 0);
                matches = nameScore.matches;
            } else {
                score = pathScore.score * 0.4;
                matches = [];
            }

            if (p.name.toLowerCase() === qLower) score += 1000;
            else if (p.name.toLowerCase().startsWith(qLower)) score += 100;

            scored.push({ project: p, score, matches });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, MAX_RESULTS).map(s => {
            const item = this._toProjectItem(s.project, s.matches);
            if (lastFocused && s.project.path.replace(/\/$/, '') === lastFocused.replace(/\/$/, '')) {
                item.preselected = true;
            }
            return item;
        });
    }

    async _getSessionItems(query) {
        const { path } = this._focusedProject;
        const q = query.trim();

        // Empty query → recent-N preview (cheap, instant).
        if (!q) {
            const sessions = await this._loadSessions(path);
            return sessions.map(s => this._toSessionItem(s, null));
        }

        // Query → search the project's FULL session list (all ages), matching
        // title and AI summary. Falls back to the preview window if the full
        // fetch failed.
        const sessions = (await this._loadAllSessions(path)) ?? await this._loadSessions(path);
        if (!sessions.length) return [];

        // Rank by match-quality GROUP, newest-first within each group:
        //   3 — query is a substring of the title ("readme" → "README …")
        //   2 — query is a substring of the AI summary
        //   1 — title fuzzy-matches (chars scattered across the title)
        // Raw fuzzy scores are deliberately NOT compared across sessions —
        // their micro-differences (length penalty, word-boundary bonuses)
        // would shuffle equally-good hits, when the user expects equally-good
        // hits ordered by recency. Summary hits require a contiguous
        // substring: a scattered subsequence over 200 chars of prose matches
        // nearly anything and is pure noise.
        const qLower = q.toLowerCase();
        const scored = [];
        for (const s of sessions) {
            const title = this._sessionTitle(s);
            const titleScore = scoreFuzzy(title, q);
            const summaryHit = s.summary && s.summary.toLowerCase().includes(qLower);

            let group;
            if (titleScore && title.toLowerCase().includes(qLower)) group = 3;
            else if (summaryHit) group = 2;
            else if (titleScore) group = 1;
            else continue;

            scored.push({
                session: s,
                group,
                t: Date.parse(s.last_activity) || 0,
                matches: titleScore ? titleScore.matches : [],
            });
        }
        scored.sort((a, b) => b.group - a.group || b.t - a.t);
        return scored.slice(0, MAX_RESULTS).map(s => this._toSessionItem(s.session, s.matches));
    }

    /**
     * Project the active session lives in — longest project path that
     * contains the session cwd wins, so nested checkouts resolve to the
     * innermost project (e.g. a worktree under another tracked repo).
     */
    _findCurrentProjectPath(projects) {
        const cwd = (window.app?.activeSession?.cwd || window.app?.lastCwd || '')
            .replace(/\/$/, '');
        if (!cwd) return null;
        let best = null;
        for (const p of projects) {
            const path = (p.path || '').replace(/\/$/, '');
            if (!path) continue;
            if (cwd === path || cwd.startsWith(path + '/')) {
                if (!best || path.length > best.length) best = path;
            }
        }
        return best;
    }

    _toProjectItem(project, matches) {
        const n = project.session_count || 0;
        const metaTpl = n === 1
            ? S.quick_switcher.project.session_count_one
            : S.quick_switcher.project.session_count_many;
        return {
            id: `project:${project.path}`,
            type: 'project',
            label: project.name,
            description: project.path,
            icon: 'folder',
            meta: n > 0 ? metaTpl.replace('{n}', n) : '',
            data: { path: project.path, name: project.name, sessionCount: n },
            matches,
        };
    }

    _sessionTitle(session) {
        return session.description || session.name || S.quick_switcher.session.untitled;
    }

    _toSessionItem(session, matches) {
        const n = session.message_count || 0;
        const metaTpl = n === 1
            ? S.quick_switcher.session.message_count_one
            : S.quick_switcher.session.message_count_many;
        return {
            id: `session:${session.id}`,
            type: 'session',
            label: this._sessionTitle(session),
            description: this._relativeTime(session.last_activity),
            icon: 'message-square',
            meta: metaTpl.replace('{n}', n),
            data: {
                sessionId: session.id,
                projectPath: this._focusedProject.path,
            },
            matches,
        };
    }

    _relativeTime(iso) {
        if (!iso) return '';
        const t = Date.parse(iso);
        if (Number.isNaN(t)) return '';
        const diff = Date.now() - t;
        const min = Math.round(diff / 60_000);
        if (min < 1) return S.quick_switcher.session.just_now;
        if (min < 60) return S.quick_switcher.session.minutes_ago.replace('{n}', min);
        const hrs = Math.round(min / 60);
        if (hrs < 24) return S.quick_switcher.session.hours_ago.replace('{n}', hrs);
        const days = Math.round(hrs / 24);
        return S.quick_switcher.session.days_ago.replace('{n}', days);
    }

    // ── Drill-in / drill-out ───────────────────────────────────────────

    supportsDrillIn(item) {
        return item?.type === 'project';
    }

    drillIn(item) {
        if (!this.supportsDrillIn(item)) return false;
        this._focusedProject = { path: item.data.path, name: item.data.name };
        // Warm the full-list cache in the background so the first search
        // keystroke doesn't wait for the all-sessions fetch.
        this._loadAllSessions(item.data.path);
        return true;
    }

    drillOut() {
        if (!this._focusedProject) return false;
        this._lastFocusedPath = this._focusedProject.path;
        this._focusedProject = null;
        return true;
    }

    isDrilledIn() {
        return !!this._focusedProject;
    }

    getDrillInPlaceholder() {
        if (!this._focusedProject) return null;
        return S.quick_switcher.placeholders.project_sessions
            .replace('{project}', this._focusedProject.name);
    }

    // ── Execute / context menu ────────────────────────────────────────

    async execute(item, opts = {}) {
        if (item.type === 'session') {
            this._openSession(item.data.sessionId, item.data.projectPath, { background: !!opts.background });
            return;
        }
        // Project item — same behaviour as before.
        window.app?.createNewSession?.(item.data.path, { toast: null });
    }

    _openSession(sessionId, projectPath, { background }) {
        window.dispatchEvent(new CustomEvent('welcome:open-session-new-tab', {
            detail: { sessionId, projectPath, background },
        }));
    }

    getContextMenuItems(item) {
        if (item.type === 'session') {
            const { sessionId, projectPath } = item.data;
            const QM = S.quick_switcher.context_menu.session;
            return [
                { label: QM.open, action: () => this._openSession(sessionId, projectPath, { background: false }) },
                { label: QM.open_background, action: () => this._openSession(sessionId, projectPath, { background: true }) },
                { type: 'separator' },
                { label: QM.copy_id, action: async () => { if (await copyToClipboard(sessionId)) showToast(S.toast.copied); } },
            ];
        }

        const { path } = item.data;
        const QM = S.quick_switcher.context_menu.project;
        return [
            { label: QM.open, action: () => window.app?.createNewSession?.(path, { toast: null }) },
            { type: 'separator' },
            { label: QM.copy_path, action: async () => { if (await copyToClipboard(path)) showToast(S.toast.copied); } },
        ];
    }

    onReset() {
        // Picker re-opened — forget any drill-in state so the user starts fresh.
        this._focusedProject = null;
        this._lastFocusedPath = null;
    }
}
