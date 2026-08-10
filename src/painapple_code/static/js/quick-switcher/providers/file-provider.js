/**
 * FileProvider — fuzzy file search over the current project.
 *
 * Reuses `/api/files/list` (cached server-side for 30s; we cache locally too
 * so reopening the switcher doesn't re-hit the network).
 *
 * Ranking blends fuzzy score with recency. The recency signal merges two
 * sources by pure timestamp: files Claude modified (shadow DB `turn_files`
 * via `/api/shadow-db/recent-files`) and files the user opened (client-side
 * `recent-opens.js`). Empty query shows the merged recent list first.
 */

import { BaseProvider } from './base-provider.js';
import { CONFIG } from '../../config.js';
import { scoreFuzzy } from '../fuzzy-scorer.js';
import { copyToClipboard, showToast } from '../../context-menu.js';
import { getRecentOpens } from '../../recent-opens.js';
import S from '../../strings.js';
import { basename, dirname, relativeTo, resolvePath, splitPath } from '../../path-utils.js';

const CACHE_TTL = 60_000;
const RECENT_TTL = 30_000;
const MAX_RESULTS = 20;
const EMPTY_QUERY_LIMIT = 15;
const RECENT_BOOST_HEAD = 50;
const RECENT_BOOST_TAIL = 2;
const RECENT_POOL_SIZE = 100;

/** Parse a DuckDB TIMESTAMPTZ string (e.g. "2026-06-30 14:22:10.123+00")
 *  to epoch ms, for comparison against client open-times (Date.now()).
 *  Returns 0 on failure so unknown timestamps sort oldest. */
function parseTs(s) {
    if (!s) return 0;
    let str = String(s).trim().replace(' ', 'T');
    // Normalize a bare hour offset ("+00" / "-05") to ISO "+00:00".
    str = str.replace(/([+-]\d{2})$/, '$1:00');
    let v = Date.parse(str);
    if (!isNaN(v)) return v;
    v = Date.parse(str + 'Z'); // assume UTC if no tz present
    return isNaN(v) ? 0 : v;
}

export class FileProvider extends BaseProvider {
    constructor() {
        super();
        this._cache = new Map();
        this._recentCache = new Map();
    }

    _getCwd() {
        return window.app?.activeSession?.cwd
            || window.app?.lastCwd
            || null;
    }

    async _load(cwd) {
        const cached = this._cache.get(cwd);
        if (cached && Date.now() - cached.t < CACHE_TTL) return cached.data;

        try {
            // Fetch both the .gitignore-respecting list (primary) and the full
            // list. Ignored files are scored under a stricter rule (see
            // getItems) so they only surface for exact / prefix matches —
            // typing "claude.md" finds CLAUDE.md, but fuzzy noise from
            // docs-ai/, tests/, etc. stays buried.
            const [r1, r2] = await Promise.all([
                fetch(`${CONFIG.API_BASE}/api/files/list?cwd=${encodeURIComponent(cwd)}`),
                fetch(`${CONFIG.API_BASE}/api/files/list?cwd=${encodeURIComponent(cwd)}&include_ignored=true`),
            ]);
            if (!r1.ok) return { tracked: [], ignored: [] };
            const trackedData = await r1.json();
            const tracked = trackedData.files || [];
            let ignored = [];
            if (r2.ok) {
                const allData = await r2.json();
                const trackedSet = new Set(tracked);
                ignored = (allData.files || []).filter(f => !trackedSet.has(f));
            }
            const data = { tracked, ignored };
            this._cache.set(cwd, { t: Date.now(), data });
            return data;
        } catch {
            return { tracked: [], ignored: [] };
        }
    }

    /** Files Claude modified, from the shadow DB. Cached (network-backed). */
    async _loadServerRecent(cwd) {
        const cached = this._recentCache.get(cwd);
        if (cached && Date.now() - cached.t < RECENT_TTL) return cached.list;

        const list = [];
        try {
            const r = await fetch(
                `${CONFIG.API_BASE}/api/shadow-db/recent-files?cwd=${encodeURIComponent(cwd)}&limit=${RECENT_POOL_SIZE}`
            );
            if (r.ok) {
                const data = await r.json();
                (data.files || []).forEach(f => {
                    list.push({
                        abs: resolvePath(cwd, f.path),
                        touchCount: f.touch_count,
                        lastTouched: f.last_touched_at,
                        ts: parseTs(f.last_touched_at),
                    });
                });
            }
        } catch {
            // recent-files is a nice-to-have; failing is fine
        }
        this._recentCache.set(cwd, { t: Date.now(), list });
        return list;
    }

    /** Merge Claude-modified files (cached) with the user's recent opens
     *  (read fresh from localStorage each call so a just-opened file surfaces
     *  immediately) into one recency-ranked map keyed by absolute path. A file
     *  present in both sources takes its most-recent event ("pure recency"). */
    async _loadRecent(cwd) {
        const server = await this._loadServerRecent(cwd);
        const map = new Map();
        for (const e of server) {
            map.set(e.abs, { ts: e.ts, touchCount: e.touchCount, lastTouched: e.lastTouched, opened: false });
        }
        for (const o of getRecentOpens()) {
            if (!o || !o.path) continue;
            const abs = resolvePath(cwd, o.path);
            const ex = map.get(abs);
            if (ex) {
                ex.opened = true;
                if (o.t > ex.ts) ex.ts = o.t;
            } else {
                map.set(abs, { ts: o.t, touchCount: 0, lastTouched: null, opened: true });
            }
        }
        const sorted = [...map.entries()].sort((a, b) => b[1].ts - a[1].ts);
        const out = new Map();
        sorted.forEach(([abs, info], i) => { info.rank = i; out.set(abs, info); });
        return out;
    }

    _recentBoost(rank) {
        if (rank == null) return 0;
        const span = RECENT_POOL_SIZE - 1;
        const ratio = Math.max(0, Math.min(1, (span - rank) / span));
        return RECENT_BOOST_TAIL + (RECENT_BOOST_HEAD - RECENT_BOOST_TAIL) * ratio;
    }

    async getItems(query) {
        const cwd = this._getCwd();
        if (!cwd) return [];

        const [{ tracked, ignored }, recent] = await Promise.all([this._load(cwd), this._loadRecent(cwd)]);
        if (!tracked.length && !ignored.length) return [];

        const q = query.trim();

        if (!q) {
            // Recent-files surface from tracked + ignored alike (CLAUDE.md, .env,
            // etc. are commonly edited despite being .gitignore'd). Fill-rows
            // stay tracked-only — avoids flooding the empty state with
            // gitignored junk like *.log / *.duckdb.
            const fileSet = new Set([...tracked, ...ignored].map(p => resolvePath(cwd, p)));
            const lookup = (abs) =>
                tracked.find(p => resolvePath(cwd, p) === abs)
                ?? ignored.find(p => resolvePath(cwd, p) === abs);
            const out = [];
            const used = new Set();
            for (const [abs, info] of recent) {
                if (!fileSet.has(abs)) continue;
                const rel = relativeTo(abs, cwd);
                out.push(this._toItem(lookup(abs) || rel, cwd, null, info));
                used.add(abs);
                if (out.length >= EMPTY_QUERY_LIMIT) break;
            }
            for (const p of tracked) {
                if (out.length >= EMPTY_QUERY_LIMIT) break;
                const abs = resolvePath(cwd, p);
                if (used.has(abs)) continue;
                if (splitPath(p, cwd).length > 2) continue;   // top two levels only
                out.push(this._toItem(p, cwd, null, null));
            }
            return out;
        }

        const qLower = q.toLowerCase();
        const scoreFile = (path, isIgnored) => {
            const filename = basename(path);
            const fnLower = filename.toLowerCase();

            // .gitignore'd files only count when the user is clearly aiming at
            // a specific name (exact basename or filename prefix). Without this
            // gate, fuzzy matches in docs-ai/, tests/, sessions/, etc. would
            // drown out tracked results.
            if (isIgnored && fnLower !== qLower && !fnLower.startsWith(qLower)) return null;

            const nameScore = scoreFuzzy(filename, q);
            const pathScore = scoreFuzzy(path, q);
            if (!nameScore && !pathScore) return null;

            // Heavily weight filename matches — that's what users type.
            // Fall back to path-only matches (e.g. directory-name queries)
            // at low weight so they still appear but never outrank filename hits.
            let score, nameMatches;
            if (nameScore) {
                score = nameScore.score * 3 + (pathScore ? pathScore.score * 0.2 : 0);
                nameMatches = nameScore.matches;
            } else {
                score = pathScore.score * 0.4;
                nameMatches = [];
            }

            // Exact (case-insensitive) filename match → guarantee top spot.
            if (fnLower === qLower) score += 1000;
            // Filename prefix match → strong boost (covers `clau`, `read`, etc.)
            else if (fnLower.startsWith(qLower)) score += 100;

            const depth = splitPath(path, cwd).length - 1;
            const info = recent.get(resolvePath(cwd, path)) || null;
            const boost = this._recentBoost(info?.rank);
            return { path, score: score - depth * 2 + boost, matches: nameMatches, info };
        };

        const scored = [];
        for (const path of tracked) {
            const r = scoreFile(path, false);
            if (r) scored.push(r);
        }
        for (const path of ignored) {
            const r = scoreFile(path, true);
            if (r) scored.push(r);
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, MAX_RESULTS).map(s => this._toItem(s.path, cwd, s.matches, s.info));
    }

    _toItem(path, cwd, nameMatches, recentInfo) {
        const name = basename(path);
        const dir = dirname(path);
        const absPath = resolvePath(cwd, path);
        return {
            id: `file:${absPath}`,
            type: 'file',
            label: name,
            description: dir,
            icon: 'file',
            recent: recentInfo || null,
            data: { path, cwd, absPath, recent: recentInfo || null },
            matches: nameMatches && nameMatches.length ? nameMatches : null,
        };
    }

    async execute(item, opts = {}) {
        const { absPath } = item.data;
        const tabCtrl = window.app?.tabCtrl;

        if (opts.background && tabCtrl?.openFilePreviewTab) {
            tabCtrl.openFilePreviewTab(absPath, null, { background: true });
            return;
        }
        if (opts.newTab && tabCtrl?.openFilePreviewTab) {
            tabCtrl.openFilePreviewTab(absPath, null, { newTab: true });
            return;
        }
        if (window.app?.previewFile) {
            window.app.previewFile(absPath);
        } else {
            window.open(`/view?path=${encodeURIComponent(absPath)}`, '_blank');
        }
    }

    getContextMenuItems(item) {
        const { path, cwd, absPath } = item.data;
        const filename = basename(absPath);
        const tabCtrl = window.app?.tabCtrl;
        const M = S.context_menus.file;
        const QM = S.quick_switcher.context_menu.file;
        return [
            { label: M.preview, action: () => window.app?.previewFile?.(absPath) },
            { label: M.open_in_new_tab, action: () => tabCtrl?.openFilePreviewTab(absPath, null, { newTab: true }) },
            { label: M.open_in_background, action: () => tabCtrl?.openFilePreviewTab(absPath, null, { background: true }) },
            { type: 'separator' },
            { label: M.compare, action: () => window.DiffViewerWidget?.openCompareWizard?.(absPath, cwd) },
            { label: M.show_history, action: () => window.app?.showFileHistory?.(path, cwd) },
            { type: 'separator' },
            { label: M.copy_path, action: async () => { if (await copyToClipboard(path)) showToast(S.toast.copied); } },
            { label: M.copy_full_path, action: async () => { if (await copyToClipboard(absPath)) showToast(S.toast.copied); } },
            { label: QM.copy_filename, action: async () => { if (await copyToClipboard(filename)) showToast(S.toast.copied); } },
        ];
    }
}
