/**
 * Preview utility functions
 *
 * Pure helpers, file operations, size persistence, and toast notifications.
 */

import { state } from './preview-state.js';
import { CONFIG } from '../config.js';
import { escapeHtml } from '../utils.js';
import { basename } from '../path-utils.js';

export function getFileName(path) {
    return basename(path) || '';
}

export function getRelativePath(path, cwd) {
    if (!path) return '';
    if (cwd && path.startsWith(cwd + '/')) {
        return path.slice(cwd.length + 1);
    }
    return path;
}

export function getHighlightLanguage(lang) {
    const map = {
        javascript: 'javascript',
        typescript: 'typescript',
        python: 'python',
        ruby: 'ruby',
        go: 'go',
        rust: 'rust',
        java: 'java',
        c: 'c',
        cpp: 'cpp',
        csharp: 'csharp',
        php: 'php',
        swift: 'swift',
        kotlin: 'kotlin',
        html: 'xml',
        css: 'css',
        scss: 'scss',
        json: 'json',
        yaml: 'yaml',
        markdown: 'markdown',
        sql: 'sql',
        shell: 'bash',
        fish: 'bash',
        scala: 'scala',
        nginx: 'nginx',
        dockerfile: 'dockerfile',
        makefile: 'makefile',
        xml: 'xml',
        toml: 'ini',
        ini: 'ini',
        env: 'ini',
        text: 'plaintext'
    };
    const mapped = map[lang] || 'plaintext';
    // Fall back to plaintext for languages not in the hljs bundle (avoids console.error)
    if (mapped !== 'plaintext' && window.hljs && !window.hljs.getLanguage(mapped)) {
        return 'plaintext';
    }
    return mapped;
}

/**
 * Available languages for the selector dropdown
 */
export const AVAILABLE_LANGUAGES = [
    { value: 'text', label: 'Plain Text' },
    { value: 'javascript', label: 'JavaScript' },
    { value: 'typescript', label: 'TypeScript' },
    { value: 'python', label: 'Python' },
    { value: 'shell', label: 'Shell (Bash)' },
    { value: 'fish', label: 'Fish' },
    { value: 'ruby', label: 'Ruby' },
    { value: 'go', label: 'Go' },
    { value: 'rust', label: 'Rust' },
    { value: 'java', label: 'Java' },
    { value: 'c', label: 'C' },
    { value: 'cpp', label: 'C++' },
    { value: 'csharp', label: 'C#' },
    { value: 'php', label: 'PHP' },
    { value: 'swift', label: 'Swift' },
    { value: 'kotlin', label: 'Kotlin' },
    { value: 'html', label: 'HTML' },
    { value: 'css', label: 'CSS' },
    { value: 'scss', label: 'SCSS' },
    { value: 'json', label: 'JSON' },
    { value: 'yaml', label: 'YAML' },
    { value: 'markdown', label: 'Markdown' },
    { value: 'sql', label: 'SQL' },
    { value: 'scala', label: 'Scala' },
    { value: 'dockerfile', label: 'Dockerfile' },
    { value: 'makefile', label: 'Makefile' },
    { value: 'nginx', label: 'Nginx' },
    { value: 'xml', label: 'XML' },
    { value: 'toml', label: 'TOML' },
    { value: 'ini', label: 'INI' },
    { value: 'env', label: 'Env' }
];

export function getEffectiveLanguage() {
    return state.languageOverride || state.language || 'text';
}

/**
 * Auto-detect language from content for scratch pads.
 * Returns our internal language name (e.g. 'json', 'python') or null if unsure.
 */
export function detectContentLanguage(content) {
    if (!content || content.length < 10) return null;

    // Trim and take a sample for detection
    const sample = content.trim().slice(0, 4000);

    // Fast heuristic checks before running hljs
    if (/^\s*[\[{]/.test(sample)) {
        try { JSON.parse(sample); return 'json'; } catch { /* not valid JSON */ }
        // Partial JSON — still likely JSON if it starts with { or [
        if (/^\s*\{[\s\S]*"[^"]+"\s*:/.test(sample)) return 'json';
    }
    if (/^\s*(---\n|[\w_]+\s*:)/m.test(sample) && !/<\w/.test(sample)) return 'yaml';
    if (/^\s*<(!DOCTYPE|html|xml|svg|div|span)\b/i.test(sample)) return 'html';
    if (/^\s*(FROM|ARG|RUN|CMD|ENTRYPOINT|COPY|ADD|WORKDIR|EXPOSE|ENV|LABEL)\s/m.test(sample)) return 'dockerfile';
    if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s/im.test(sample)) return 'sql';
    if (/^\s*#!\s*\/.*\b(bash|sh|zsh)\b/.test(sample)) return 'shell';
    if (/^\s*#!\s*\/.*\bpython/.test(sample)) return 'python';

    // Fall back to hljs auto-detection
    if (!window.hljs) return null;
    const result = window.hljs.highlightAuto(sample);
    if (!result.language || (result.relevance || 0) < 5) return null;

    // Reverse-map hljs name → our internal name
    const reverseMap = {
        javascript: 'javascript', typescript: 'typescript', python: 'python',
        ruby: 'ruby', go: 'go', rust: 'rust', java: 'java',
        c: 'c', cpp: 'cpp', csharp: 'csharp', php: 'php',
        swift: 'swift', kotlin: 'kotlin', css: 'css', scss: 'scss',
        json: 'json', yaml: 'yaml', markdown: 'markdown', sql: 'sql',
        bash: 'shell', dockerfile: 'dockerfile', makefile: 'makefile',
        xml: 'html', ini: 'ini', scala: 'scala', nginx: 'nginx'
    };
    return reverseMap[result.language] || null;
}

/**
 * Add line numbers to content
 * @param {string} content - File content
 * @param {number[]|null} highlightLines - Lines to highlight
 * @param {object|null} lineRange - Range object { start, end } for visual markers
 */
export function addLineNumbers(content, highlightLines = null, lineRange = null) {
    const lines = content.split('\n');
    const highlightSet = new Set(highlightLines || []);

    return lines.map((line, i) => {
        const lineNum = i + 1;
        const isHighlighted = highlightSet.has(lineNum);

        const classes = ['preview-line'];
        if (isHighlighted) classes.push('highlighted');
        if (lineRange) {
            if (lineNum === lineRange.start) classes.push('range-start');
            if (lineNum === lineRange.end) classes.push('range-end');
        }

        // Empty .preview-fold keeps the gutter width identical to the
        // highlighted render (which fills in fold arrows) — no layout shift.
        return `<div class="${classes.join(' ')}" data-line="${lineNum}"><span class="line-number">${lineNum}</span><span class="preview-fold"></span><span class="line-content">${escapeHtml(line) || ' '}</span></div>`;
    }).join('');
}

/**
 * Fetch file content from API
 * @returns {{ content: string, mtime: number }}
 */
export async function fetchFile(path) {
    const response = await fetch(`${CONFIG.API_BASE}/api/file?path=${encodeURIComponent(path)}`);
    const data = await response.json();
    if (data.error) {
        throw new Error(data.error);
    }
    return { content: data.content, mtime: data.mtime };
}

/**
 * Lightweight stat check — returns mtime + size without reading content
 */
export async function statFile(path) {
    const response = await fetch(`${CONFIG.API_BASE}/api/file/stat?path=${encodeURIComponent(path)}`);
    return response.json();
}

// ═══════════════════════════════════════════════════════════════════════════
// SIZE PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════

const STORAGE_KEY = 'file-preview-size';
export const DEFAULT_WIDTH = 900;
export const DEFAULT_HEIGHT = 700;

export function loadSavedSize() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            const { width, height } = JSON.parse(saved);
            if (typeof width === 'number' && typeof height === 'number') {
                return { width, height };
            }
        }
    } catch (e) {
        console.warn('[FilePreviewWidget] Failed to load saved size:', e);
    }
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

export function saveSize(width, height) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ width, height }));
    } catch (e) {
        console.warn('[FilePreviewWidget] Failed to save size:', e);
    }
}

export function resetSize() {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
        console.warn('[FilePreviewWidget] Failed to reset size:', e);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════════════════

export function showToast(message) {
    const existing = document.querySelector('.preview-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'preview-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 2000);
}
