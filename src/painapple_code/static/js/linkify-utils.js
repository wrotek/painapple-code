/**
 * Shared utilities for linkification
 *
 * File path patterns: Used by components.js for markdown rendering
 * (positions can't be used for markdown because parsing transforms the text)
 *
 * URL patterns: Used by both components.js and tool-renderer.js
 *
 * Note: tool-renderer.js uses server-provided fileLinks positions for file paths,
 * so it only needs the URL patterns from this module.
 */

// Known file extensions for linkification
// IMPORTANT: Longer extensions MUST come before shorter prefixes (css before c, hpp before h, etc.)
// otherwise regex alternation will match the shorter one first (e.g., .c instead of .css)
export const FILE_EXTENSIONS = 'dockerignore|gitignore|graphql|makefile|prisma|svelte|astro|cmake|scss|sass|less|html|json|yaml|toml|bash|lock|conf|cpp|css|csv|cfg|hpp|htm|ini|jsx|log|sql|tsx|vue|xml|yml|env|txt|zsh|go|js|kt|md|py|rb|rs|sh|ts|c|h|java|swift';

/**
 * Build regex pattern for file paths (requires at least one /)
 * Matches: src/app.js, ./config.yaml, ../utils/helper.py, /home/user/file.txt
 */
export function buildPathPattern() {
    return new RegExp(
        '(' +
            '(?:~/|\\.{0,2}/)?' +        // Optional ~/ or ./ or ../ or /
            '(?:[\\w@.-]+/)' +            // At least one directory with /
            '(?:[\\w@.-]+/)*' +           // Additional directories
            '[\\w@.-]+' +                 // Final filename
            '(?:\\.(?:' + FILE_EXTENSIONS + '))?' +  // Optional extension
        ')' +
        '(:\\d+(?:[-:]\\d+)?|#L\\d+(?:-L\\d+)?)?',  // Optional :line or #Lline (GitHub-style)
        'g'
    );
}

/**
 * Build regex pattern for standalone filenames (no path separator)
 * Allows common filename characters including hyphens and numeric prefixes.
 *
 * Matches: server.py, app.js, CLAUDE.md, git-widget.js, app.test.ts, 21-tool-blocks.css
 * Rejects: 1.2.3 (pure version numbers) via validation function
 *
 * Note: False positives (files that don't exist) are handled by click-time
 * resolution - the preview will show "File not found" which is acceptable UX.
 */
export function buildStandalonePattern() {
    return new RegExp(
        // Word boundary start - not preceded by word char, dot, or slash
        '(?<![\\w./])' +
        // Filename: starts with letter, underscore, or digit
        // Allows hyphens, underscores, alphanumeric, and dots
        '(' +
            '[A-Za-z0-9_]' +             // Start with letter, digit, or underscore
            '[A-Za-z0-9_-]*' +           // Followed by alphanumeric, underscore, or hyphen
            '(?:\\.[A-Za-z0-9_-]+)*' +   // Optional .middle.parts (also allow hyphens)
            '\\.(?:' + FILE_EXTENSIONS + ')' +  // Required .extension
        ')' +
        '(:\\d+(?:[-:]\\d+)?|#L\\d+(?:-L\\d+)?)?' +  // Optional :line or #Lline (GitHub-style)
        '(?![\\w.])',                    // Word boundary end (not followed by word char or dot)
        'g'
    );
}

/**
 * Validate a standalone filename match to filter out false positives.
 * Called after regex match for additional filtering.
 *
 * Note: We allow hyphenated filenames (git-widget.js, my-component.ts) since
 * these are common in modern projects. Click-time resolution handles files
 * that don't exist by showing "File not found" in the preview.
 *
 * @param {string} filename - The matched filename (e.g., "server.py")
 * @param {string} precedingText - Text before the match for context
 * @returns {boolean} - True if this looks like a real file reference
 */
export function isValidStandaloneFile(filename, precedingText = '') {
    // Reject version patterns like "1.0.0" or "v1.0"
    if (/^\d+\.\d+/.test(filename)) {
        return false;
    }

    // Reject if preceded by "v" or "version" (version indicator)
    // e.g., "version 1.0.0", "v2.0.0"
    if (/(?:^|[^a-zA-Z])v(?:ersion)?\s*$/i.test(precedingText)) {
        return false;
    }

    // Reject all-caps single words that are likely acronyms/constants
    // But allow things like "README.md", "CHANGELOG.md"
    const namePart = filename.split('.')[0];
    if (/^[A-Z]{1,3}$/.test(namePart)) {
        return false;
    }

    return true;
}

/**
 * Parse line info string into structured options for file preview.
 *
 * Supported formats:
 * - :42        → { line: 42 }
 * - :42:5      → { line: 42, col: 5 }
 * - :42-50     → { start: 42, end: 50 }
 * - #L42       → { line: 42 }
 * - #L42-L50   → { start: 42, end: 50 }
 * - (empty)    → null
 *
 * @param {string} lineInfo - Line info string (e.g., ':219-220', ':42', ':42:5')
 * @returns {object|null} - Parsed line info or null if empty/invalid
 */
export function parseLineInfo(lineInfo) {
    if (!lineInfo) return null;

    // Handle GitHub-style: #L42 or #L42-L50
    const githubMatch = lineInfo.match(/^#L(\d+)(?:-L(\d+))?$/);
    if (githubMatch) {
        const line = parseInt(githubMatch[1], 10);
        if (githubMatch[2]) {
            return { start: line, end: parseInt(githubMatch[2], 10) };
        }
        return { line };
    }

    // Handle standard: :42, :42:5, :42-50
    const standardMatch = lineInfo.match(/^:(\d+)(?:([-:])(\d+))?$/);
    if (standardMatch) {
        const first = parseInt(standardMatch[1], 10);
        if (standardMatch[3]) {
            const separator = standardMatch[2];
            const second = parseInt(standardMatch[3], 10);
            if (separator === '-') {
                // Line range: :42-50
                return { start: first, end: second };
            } else {
                // Line with column: :42:5
                return { line: first, col: second };
            }
        }
        return { line: first };
    }

    return null;
}

/**
 * Build URL pattern for linkification (higher priority than file paths)
 */
export function buildUrlPattern() {
    return /https?:\/\/[^\s<>"')\]]+/gi;
}

/**
 * Clean trailing punctuation and HTML entities from a URL match.
 * Handles both literal punctuation and HTML-encoded quotes that appear
 * when linkifying after marked.js has processed the text.
 * @param {string} url - The matched URL
 * @returns {{url: string, trimmed: number}} - Cleaned URL and chars trimmed
 */
export function cleanUrlTrailingPunct(url) {
    let trimmed = 0;

    // First, strip HTML quote entities that marked.js may have added
    // These appear when URLs are inside code blocks or quoted strings
    // Order matters: check longer patterns first
    const htmlEntities = [
        /&quot;$/,      // "
        /&#x27;$/,     // ' (hex)
        /&#39;$/,      // ' (decimal)
        /&apos;$/,     // ' (named)
        /&#x22;$/,     // " (hex)
        /&#34;$/,      // " (decimal)
    ];

    // Keep stripping entities until none match
    let changed = true;
    while (changed) {
        changed = false;
        for (const pattern of htmlEntities) {
            const match = url.match(pattern);
            if (match) {
                url = url.slice(0, -match[0].length);
                trimmed += match[0].length;
                changed = true;
                break; // Restart from beginning of patterns
            }
        }
    }

    // Then strip regular trailing punctuation
    const trailingPunct = /[.,;:!?)]+$/;
    const match = url.match(trailingPunct);
    if (match) {
        return {
            url: url.slice(0, -match[0].length),
            trimmed: trimmed + match[0].length
        };
    }
    return { url, trimmed };
}
