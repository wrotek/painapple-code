/**
 * ReadFilesProvider — files Claude opened with the Read tool this session.
 *
 * Prefix `!`. Reads aren't persisted anywhere queryable (the shadow DB's
 * `turn_files` only tracks Edit/Write), so the server reconstructs them by
 * scanning the active session's messages.jsonl:
 *   GET /api/sessions/{storeId}/read-files
 *
 * Extends FileProvider to reuse open/execute + context-menu behaviour; only
 * the item source differs (session read-log instead of the project file list).
 * Empty query shows the full read list, most-recently-read first.
 */

import { FileProvider } from './file-provider.js';
import { CONFIG } from '../../config.js';
import { scoreFuzzy } from '../fuzzy-scorer.js';
import { basename, dirname, relativeTo, resolvePath } from '../../path-utils.js';

const CACHE_TTL = 20_000;
const MAX_RESULTS = 30;

export class ReadFilesProvider extends FileProvider {
    constructor() {
        super();
        this._readCache = new Map(); // storeId -> { t, files }
    }

    _storeId() {
        return window.app?.activeSession?.storeId || null;
    }

    /** Fetch the session's read log. Cached briefly so re-typing doesn't
     *  re-scan messages.jsonl on the server for every keystroke. */
    async _loadReads(storeId) {
        const cached = this._readCache.get(storeId);
        if (cached && Date.now() - cached.t < CACHE_TTL) return cached.files;

        let files = [];
        try {
            const r = await fetch(`${CONFIG.API_BASE}/api/sessions/${encodeURIComponent(storeId)}/read-files`);
            if (r.ok) {
                const data = await r.json();
                files = data.files || [];
            }
        } catch {
            // read-log is a nice-to-have; failing yields an empty list
        }
        this._readCache.set(storeId, { t: Date.now(), files });
        return files;
    }

    _toReadItem(f, cwd, matches) {
        const path = f.filePath;
        const name = basename(path);
        // read-files paths are already absolute (from tool_input.file_path);
        // keep both so FileProvider.execute / context-menu work unchanged.
        const absPath = resolvePath(cwd || '', path);
        const rel = cwd ? relativeTo(absPath, cwd) : path;
        return {
            id: `read-file:${absPath}`,
            type: 'read-file',
            label: name,
            description: dirname(path),
            icon: 'file',
            meta: f.readCount > 1 ? `${f.readCount}×` : null,
            data: { path: rel, cwd: cwd || '', absPath },
            matches: matches && matches.length ? matches : null,
        };
    }

    async getItems(query) {
        const storeId = this._storeId();
        if (!storeId) return [];

        const cwd = this._getCwd();
        const files = await this._loadReads(storeId);
        if (!files.length) return [];

        const q = query.trim();
        if (!q) {
            return files.slice(0, MAX_RESULTS).map(f => this._toReadItem(f, cwd, null));
        }

        const scored = [];
        for (const f of files) {
            const name = f.fileName || basename(f.filePath);
            const nameScore = scoreFuzzy(name, q);
            const pathScore = scoreFuzzy(f.filePath, q);
            if (!nameScore && !pathScore) continue;
            let score, matches;
            if (nameScore) {
                score = nameScore.score * 3 + (pathScore ? pathScore.score * 0.2 : 0);
                matches = nameScore.matches;
            } else {
                score = pathScore.score * 0.4;
                matches = [];
            }
            scored.push({ f, score, matches });
        }
        // Ties preserve recency (files arrive most-recent-first).
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, MAX_RESULTS).map(s => this._toReadItem(s.f, cwd, s.matches));
    }
}
