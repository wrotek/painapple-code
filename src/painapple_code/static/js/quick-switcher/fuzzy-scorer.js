/**
 * Fuzzy scorer — VS Code-style scoring with match indices.
 *
 * scoreFuzzy(text, query) → {score, matches} | null
 *   - matches: indices into `text` of matched chars (for highlighting)
 *   - returns null if not all query chars matched
 */

const WORD_BOUNDARY_CHARS = '/._- ';

export function scoreFuzzy(text, query) {
    if (!query) return { score: 0, matches: [] };
    if (!text) return null;

    const tLower = text.toLowerCase();
    const qLower = query.toLowerCase();

    // A contiguous occurrence of the whole query must always outrank a
    // subsequence scattered across words ("clone" → "Clone Session", not
    // "Cycle Effort One-Shot"). The greedy walk below can't guarantee that,
    // so check for a substring first.
    const substring = scoreSubstring(text, tLower, query, qLower);
    if (substring) return substring;

    let score = 0;
    let qIdx = 0;
    const matches = [];
    let consec = 0;

    for (let i = 0; i < text.length && qIdx < query.length; i++) {
        if (tLower[i] !== qLower[qIdx]) {
            consec = 0;
            continue;
        }

        score += 1;
        score += Math.min(consec, 2) * 3;
        consec++;

        if (text[i] === query[qIdx]) score += 1;

        if (i === 0) {
            score += 8;
        } else {
            const prev = text[i - 1];
            if (WORD_BOUNDARY_CHARS.includes(prev)) {
                score += 5;
            } else if (prev === prev.toLowerCase() && text[i] === text[i].toUpperCase() && text[i] !== text[i].toLowerCase()) {
                score += 2;
            }
        }

        matches.push(i);
        qIdx++;
    }

    if (qIdx !== query.length) return null;
    score -= text.length * 0.1;
    return { score, matches };
}

/**
 * Score the query as an exact (case-insensitive) substring of the text.
 * The base of 100 + 8/char keeps any substring hit above what the greedy
 * subsequence walk can reach, per its per-char maximums.
 * Returns null if the query doesn't occur contiguously.
 */
function scoreSubstring(text, tLower, query, qLower) {
    let best = null;
    for (let idx = tLower.indexOf(qLower); idx !== -1; idx = tLower.indexOf(qLower, idx + 1)) {
        let score = 100 + qLower.length * 8;
        if (idx === 0) {
            score += 20;
        } else if (WORD_BOUNDARY_CHARS.includes(text[idx - 1])) {
            score += 10;
        }
        for (let k = 0; k < qLower.length; k++) {
            if (text[idx + k] === query[k]) score += 1;
        }
        score -= text.length * 0.1;
        if (!best || score > best.score) {
            const matches = [];
            for (let k = 0; k < qLower.length; k++) matches.push(idx + k);
            best = { score, matches };
        }
        if (idx === 0) break;
    }
    return best;
}

/**
 * Score against multiple haystacks; pick the best one.
 * Returns the result tagged with `field` (the haystack name with the win).
 */
export function scoreFuzzyMulti(haystacks, query) {
    let best = null;
    for (const [field, text] of Object.entries(haystacks)) {
        const r = scoreFuzzy(text, query);
        if (!r) continue;
        if (!best || r.score > best.score) best = { ...r, field };
    }
    return best;
}

/**
 * Render text with <mark> wrapping the matched indices.
 * `escape` is required — pass an HTML-escape fn.
 */
export function highlightMatches(text, matches, escape) {
    if (!matches || !matches.length) return escape(text);
    let out = '';
    let last = 0;
    const set = new Set(matches);
    for (let i = 0; i < text.length; i++) {
        if (set.has(i)) {
            if (i > last) out += escape(text.slice(last, i));
            out += `<mark>${escape(text[i])}</mark>`;
            last = i + 1;
        }
    }
    if (last < text.length) out += escape(text.slice(last));
    return out;
}
