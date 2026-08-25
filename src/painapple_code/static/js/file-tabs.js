/**
 * File utility functions - language detection, file type checks, path helpers
 */

import { basename } from './path-utils.js';

/**
 * Image file extensions that should be opened in image preview
 */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'];

/**
 * Check if a file path is an image
 */
export function isImageFile(path) {
    const ext = path.split('.').pop().toLowerCase();
    return IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Check if a file path is an Excalidraw diagram
 */
export function isExcalidrawFile(path) {
    const lower = path?.toLowerCase();
    return lower?.endsWith('.excalidraw') || lower?.endsWith('.excalidraw.md');
}

/**
 * Check if a file path is a Vega-Lite chart
 */
export function isChartFile(path) {
    return path?.toLowerCase().endsWith('.vl.json');
}

/**
 * Detect programming language from file path
 */
export function detectLanguage(path) {
    const ext = path.split('.').pop().toLowerCase();
    const map = {
        js: 'javascript', jsx: 'javascript', mjs: 'javascript',
        ts: 'typescript', tsx: 'typescript',
        py: 'python',
        rb: 'ruby',
        go: 'go',
        rs: 'rust',
        java: 'java',
        c: 'c', h: 'c',
        cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp',
        cs: 'csharp',
        php: 'php',
        swift: 'swift',
        kt: 'kotlin',
        scala: 'scala',
        html: 'html', htm: 'html',
        css: 'css', scss: 'scss', less: 'less',
        json: 'json',
        yaml: 'yaml', yml: 'yaml',
        md: 'markdown', markdown: 'markdown',
        diff: 'diff', patch: 'diff',
        sql: 'sql',
        sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
        dockerfile: 'dockerfile',
        makefile: 'makefile',
        xml: 'xml',
        toml: 'toml',
        ini: 'ini',
        env: 'env',
        txt: 'text'
    };

    // Check for special filenames
    const filename = basename(path).toLowerCase();
    if (filename === 'dockerfile') return 'dockerfile';
    if (filename === 'makefile' || filename === 'gnumakefile') return 'makefile';
    if (filename.startsWith('.env')) return 'env';  // .env, .env.local, .env.production…

    return map[ext] || 'text';
}

/**
 * Get short language icon/label for tab display
 */
export function getLanguageIcon(lang) {
    const icons = {
        javascript: 'JS',
        typescript: 'TS',
        python: 'PY',
        ruby: 'RB',
        go: 'GO',
        rust: 'RS',
        java: 'JV',
        c: 'C',
        cpp: 'C++',
        csharp: 'C#',
        php: 'PHP',
        swift: 'SW',
        kotlin: 'KT',
        scala: 'SC',
        html: 'HTML',
        css: 'CSS',
        scss: 'SCSS',
        json: '{}',
        yaml: 'YML',
        markdown: 'MD',
        sql: 'SQL',
        shell: '$',
        dockerfile: 'DOC',
        makefile: 'MK',
        xml: 'XML',
        toml: 'TOML',
        ini: 'INI',
        text: 'TXT'
    };
    return icons[lang] || 'TXT';
}

/**
 * Get just the filename from a path
 */
export function getFileName(path) {
    return basename(path);
}
