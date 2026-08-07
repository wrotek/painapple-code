/**
 * Debug Logs Widget - v3
 *
 * Browser dev tools replacement for iPad PWA.
 *
 * Two modes:
 * 1. Normal: Copy button on each entry for quick single-copy
 * 2. Selection: Click "Select" to enter multi-select mode with checkboxes
 *
 * Shortcut: Alt+D
 */

import S from '../strings.js';
import { escapeHtml, formatTimePrecise } from '../utils.js';
import { WidgetManager, WidgetBus } from '../widget-system/index.js';

// ─────────────────────────────────────────────────────────────────────
// Console Capture - Must happen FIRST
// ─────────────────────────────────────────────────────────────────────

const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console)
};

let isLoggingInternal = false;

// ─────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────

const CONFIG = {
    MAX_ENTRIES: 500,
    CONTEXT_LINES: 5,
    COLORS: {
        'console.log': { text: '#9ca3af', border: 'transparent' },
        'console.info': { text: '#3b82f6', border: '#3b82f6' },
        'console.warn': { text: '#f59e0b', border: '#f59e0b' },
        'console.error': { text: '#ef4444', border: '#ef4444' },
        'console.debug': { text: '#8b5cf6', border: '#8b5cf6' },
        'window.onerror': { text: '#dc2626', border: '#dc2626' },
        'unhandledrejection': { text: '#b91c1c', border: '#b91c1c' },
    },
    SEVERITY: {
        'console.error': 'error',
        'window.onerror': 'error',
        'unhandledrejection': 'error',
        'console.warn': 'warn',
        'console.info': 'info',
        'console.debug': 'debug',
        'console.log': 'log',
    }
};

// ─────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────

class DebugState {
    constructor() {
        this.entries = [];
        this.paused = false;
        this.autoScroll = true;
        this.searchQuery = '';
        this.activeFilter = 'all';
        this.errorCount = 0;
        this.warnCount = 0;
        this.unseenErrorCount = 0;
        this.currentContainer = null;

        // Selection
        this.selectionMode = false;
        this.selectedIds = new Set();
        this.lastSelectedId = null;
    }

    addEntry(source, message, data = null) {
        if (this.paused) return null;

        const id = `debug-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
        const severity = CONFIG.SEVERITY[source] || 'log';

        const entry = { id, timestamp: new Date(), source, message, data, severity };
        this.entries.push(entry);

        if (severity === 'error') {
            this.errorCount++;
            if (!WidgetManager.isOpen('debug-logs')) {
                this.unseenErrorCount++;
                WidgetBus.emit('debug:errors-changed', { unseen: this.unseenErrorCount });
            }
        }
        if (severity === 'warn') this.warnCount++;

        while (this.entries.length > CONFIG.MAX_ENTRIES) {
            const removed = this.entries.shift();
            if (removed.severity === 'error') this.errorCount--;
            if (removed.severity === 'warn') this.warnCount--;
            this.selectedIds.delete(removed.id);
        }

        return entry;
    }

    clear() {
        this.entries = [];
        this.errorCount = 0;
        this.warnCount = 0;
        this.unseenErrorCount = 0;
        this.selectedIds.clear();
        this.lastSelectedId = null;
        WidgetBus.emit('debug:errors-changed', { unseen: 0 });
    }

    getLatestError() {
        for (let i = this.entries.length - 1; i >= 0; i--) {
            if (this.entries[i].severity === 'error') return this.entries[i];
        }
        return null;
    }

    getFilteredEntries() {
        let filtered = this.entries;
        if (this.activeFilter === 'errors') {
            filtered = filtered.filter(e => e.severity === 'error');
        } else if (this.activeFilter === 'warnings') {
            filtered = filtered.filter(e => e.severity === 'warn');
        }
        if (this.searchQuery.trim()) {
            const q = this.searchQuery.toLowerCase();
            filtered = filtered.filter(e =>
                e.message.toLowerCase().includes(q) || e.source.toLowerCase().includes(q)
            );
        }
        return filtered;
    }

    toggleSelection(entryId, shiftKey = false) {
        const entries = this.getFilteredEntries();
        if (shiftKey && this.lastSelectedId) {
            const lastIdx = entries.findIndex(e => e.id === this.lastSelectedId);
            const currIdx = entries.findIndex(e => e.id === entryId);
            if (lastIdx !== -1 && currIdx !== -1) {
                const [start, end] = lastIdx < currIdx ? [lastIdx, currIdx] : [currIdx, lastIdx];
                for (let i = start; i <= end; i++) {
                    this.selectedIds.add(entries[i].id);
                }
            }
        } else {
            if (this.selectedIds.has(entryId)) {
                this.selectedIds.delete(entryId);
            } else {
                this.selectedIds.add(entryId);
            }
        }
        this.lastSelectedId = entryId;
    }

    selectAll() {
        const entries = this.getFilteredEntries();
        if (this.selectedIds.size === entries.length) {
            this.selectedIds.clear();
        } else {
            entries.forEach(e => this.selectedIds.add(e.id));
        }
    }

    clearSelection() {
        this.selectedIds.clear();
        this.lastSelectedId = null;
    }

    exitSelectionMode() {
        this.selectionMode = false;
        this.clearSelection();
    }

    getSelectedEntries() {
        return this.entries.filter(e => this.selectedIds.has(e.id));
    }

    getEntryWithContext(entryId) {
        const idx = this.entries.findIndex(e => e.id === entryId);
        if (idx === -1) return null;
        const start = Math.max(0, idx - CONFIG.CONTEXT_LINES);
        const end = Math.min(this.entries.length, idx + CONFIG.CONTEXT_LINES + 1);
        return {
            entry: this.entries[idx],
            before: this.entries.slice(start, idx),
            after: this.entries.slice(idx + 1, end)
        };
    }
}

const state = new DebugState();

// ─────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────

function formatEntry(entry) {
    let text = `${formatTimePrecise(entry.timestamp, {ms: true})} [${entry.source}] ${entry.message}`;
    if (entry.data) {
        const dataStr = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2);
        text += '\n' + dataStr.split('\n').map(l => '  ' + l).join('\n');
    }
    return text;
}

function formatConsoleArgs(args) {
    return args.map(arg => {
        if (arg === undefined) return 'undefined';
        if (arg === null) return 'null';
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return `${arg.name}: ${arg.message}${arg.stack ? '\n' + arg.stack : ''}`;
        try { return JSON.stringify(arg, null, 2); } catch { return String(arg); }
    }).join(' ');
}

function getSourceLabel(source) {
    return source.replace('console.', '').replace('window.', '').replace('unhandledrejection', 'promise');
}

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); return true; }
        finally { document.body.removeChild(ta); }
    }
}

function showToast(msg) {
    const container = state.currentContainer;
    if (!container) return;
    const existing = container.querySelector('.debug-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'debug-toast';
    toast.textContent = msg;
    container.querySelector('.debug-logs')?.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 200);
    }, 1500);
}

// ─────────────────────────────────────────────────────────────────────
// SVG Icons
// ─────────────────────────────────────────────────────────────────────

const ICON = {
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    checkSquare: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
    square: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    arrowDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
};

// ─────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────

function renderContent() {
    const container = state.currentContainer;
    if (!container) return;

    // Save scroll position before re-render
    const entriesEl = container.querySelector('.debug-entries');
    const savedScrollTop = entriesEl ? entriesEl.scrollTop : 0;

    const entries = state.getFilteredEntries();
    const latestError = state.getLatestError();
    const selected = state.selectedIds.size;
    const modeClass = state.selectionMode ? 'debug-logs--selection-mode' : '';

    // Error badge
    const errorBadge = state.errorCount > 0 ? `<span class="debug-badge debug-badge--error">${state.errorCount}</span>` : '';
    const warnBadge = state.warnCount > 0 ? `<span class="debug-badge debug-badge--warn">${state.warnCount}</span>` : '';

    // Error banner HTML
    const errorBannerHtml = latestError ? `
        <div class="debug-error-banner" data-id="${latestError.id}">
            <div class="debug-error-banner__icon">${ICON.alert}</div>
            <div class="debug-error-banner__content">
                <span class="debug-error-banner__label">Latest Error</span>
                <span class="debug-error-banner__message">${escapeHtml(latestError.message.split('\n')[0].slice(0, 100))}</span>
            </div>
            <button class="debug-error-banner__copy" data-copy-error-only="1" data-tooltip="Copy error">${ICON.copy}</button>
            <button class="debug-error-banner__copy debug-error-banner__copy--ctx" data-copy-error-ctx="1" data-tooltip="Copy with context"><span class="debug-ctx-label">ctx</span>${ICON.copy}</button>
        </div>
    ` : '';

    // Entries HTML
    let entriesHtml = '';
    if (entries.length === 0) {
        const msg = state.searchQuery ? 'No matches' : state.activeFilter !== 'all' ? `No ${state.activeFilter}` : 'No logs yet';
        entriesHtml = `<div class="debug-empty"><p>${msg}</p></div>`;
    } else {
        entriesHtml = entries.map(entry => {
            const colors = CONFIG.COLORS[entry.source] || CONFIG.COLORS['console.log'];
            const isSelected = state.selectedIds.has(entry.id);
            const sevClass = entry.severity !== 'log' ? `debug-entry--${entry.severity}` : '';
            const selClass = isSelected ? 'debug-entry--selected' : '';

            const leftEl = state.selectionMode
                ? `<div class="debug-entry__checkbox">${isSelected ? ICON.checkSquare : ICON.square}</div>`
                : `<button class="debug-entry__copy" data-copy-id="${entry.id}">${ICON.copy}</button>`;

            return `
                <div class="debug-entry ${sevClass} ${selClass}" data-entry-id="${entry.id}" style="--entry-border:${colors.border}">
                    ${leftEl}
                    <span class="debug-entry__time">${formatTimePrecise(entry.timestamp, {ms: true})}</span>
                    <span class="debug-entry__source" style="color:${colors.text}">${getSourceLabel(entry.source)}</span>
                    <span class="debug-entry__message">${escapeHtml(entry.message)}</span>
                </div>
            `;
        }).join('');
    }

    // Footer HTML
    let footerHtml;
    if (state.selectionMode && selected > 0) {
        footerHtml = `
            <div class="debug-footer debug-footer--selection">
                <div class="debug-footer__selection-info">
                    <button class="debug-btn-text" data-select-all="1">${selected === entries.length ? 'Deselect All' : 'Select All'}</button>
                    <span>${selected} selected</span>
                </div>
                <div class="debug-footer__actions">
                    <button class="debug-btn debug-btn--primary" data-copy-selected="1">${ICON.copy} Copy</button>
                    <button class="debug-btn" data-clear-selection="1">${ICON.x}</button>
                </div>
            </div>
        `;
    } else if (state.selectionMode) {
        footerHtml = `
            <div class="debug-footer debug-footer--selection">
                <span class="debug-footer__hint">Tap to select. Shift+tap for range.</span>
                <button class="debug-btn" data-exit-selection="1">${ICON.x} Cancel</button>
            </div>
        `;
    } else {
        const total = state.entries.length;
        const visible = entries.length;
        const countText = visible === total ? `${total} logs` : `${visible}/${total}`;
        footerHtml = `
            <div class="debug-footer debug-footer--left-aligned">
                <button class="debug-btn" data-toggle-select="1">${ICON.checkSquare} Select</button>
                <button class="debug-btn" data-copy-all="1" ${visible === 0 ? 'disabled' : ''}>${ICON.copy} Copy All</button>
                <button class="debug-btn" data-export="1" ${total === 0 ? 'disabled' : ''}>${ICON.download}</button>
                <span class="debug-footer__count">${countText}</span>
            </div>
        `;
    }

    container.innerHTML = `
        <div class="debug-logs ${modeClass}">
            <div class="debug-toolbar">
                <button class="debug-btn ${state.paused ? 'active' : ''}" data-toggle-pause="1">${state.paused ? ICON.play : ICON.pause}</button>
                <button class="debug-btn" data-clear="1">${ICON.trash}</button>
                <button class="debug-btn" data-scroll-bottom="1">${ICON.arrowDown}</button>
            </div>
            ${errorBannerHtml}
            <div class="debug-filters">
                <div class="debug-filter-buttons">
                    <button class="debug-filter ${state.activeFilter === 'all' ? 'active' : ''}" data-filter="all">All</button>
                    <button class="debug-filter debug-filter--error ${state.activeFilter === 'errors' ? 'active' : ''}" data-filter="errors">Errors${errorBadge}</button>
                    <button class="debug-filter debug-filter--warn ${state.activeFilter === 'warnings' ? 'active' : ''}" data-filter="warnings">Warns${warnBadge}</button>
                </div>
                <div class="debug-search">
                    ${ICON.search}
                    <input type="text" class="debug-search__input" placeholder="Search..." value="${escapeHtml(state.searchQuery)}">
                </div>
            </div>
            <div class="debug-entries">${entriesHtml}</div>
            ${footerHtml}
        </div>
    `;

    // Attach event listeners
    attachEventListeners(container);

    // Restore scroll position
    const newEntriesEl = container.querySelector('.debug-entries');
    if (newEntriesEl) {
        if (state.autoScroll) {
            // Auto-scroll to bottom for new entries
            newEntriesEl.scrollTop = newEntriesEl.scrollHeight;
        } else {
            // Restore previous scroll position
            newEntriesEl.scrollTop = savedScrollTop;
        }
    }
}

function attachEventListeners(container) {
    // Toolbar buttons
    container.querySelector('[data-toggle-select]')?.addEventListener('click', () => {
        state.selectionMode = !state.selectionMode;
        if (!state.selectionMode) state.clearSelection();
        state.autoScroll = false; // Preserve scroll on mode switch
        renderContent();
    });

    container.querySelector('[data-toggle-pause]')?.addEventListener('click', () => {
        state.paused = !state.paused;
        renderContent();
    });

    container.querySelector('[data-clear]')?.addEventListener('click', () => {
        state.clear();
        renderContent();
    });

    container.querySelector('[data-scroll-bottom]')?.addEventListener('click', () => {
        state.autoScroll = true;
        const el = container.querySelector('.debug-entries');
        if (el) el.scrollTop = el.scrollHeight;
    });

    // Error banner
    container.querySelector('[data-copy-error-only]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const latestError = state.getLatestError();
        if (latestError) {
            copyToClipboard(formatEntry(latestError));
            showToast(S.toast.error_copied);
        }
    });

    container.querySelector('[data-copy-error-ctx]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const latestError = state.getLatestError();
        if (latestError) {
            const ctx = state.getEntryWithContext(latestError.id);
            if (ctx) {
                const lines = [
                    ...ctx.before.map(formatEntry),
                    '>>> ' + formatEntry(ctx.entry) + ' <<<',
                    ...ctx.after.map(formatEntry)
                ];
                copyToClipboard(lines.join('\n'));
                showToast(S.toast.error_copied_context);
            }
        }
    });

    container.querySelector('.debug-error-banner')?.addEventListener('click', () => {
        const latestError = state.getLatestError();
        if (latestError) {
            state.activeFilter = 'all';
            renderContent();
            setTimeout(() => {
                const el = container.querySelector(`[data-entry-id="${latestError.id}"]`);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 50);
        }
    });

    // Filter buttons
    container.querySelectorAll('.debug-filter').forEach(btn => {
        btn.addEventListener('click', () => {
            state.activeFilter = btn.dataset.filter;
            state.autoScroll = false; // Preserve scroll on filter change
            renderContent();
        });
    });

    // Search input
    const searchInput = container.querySelector('.debug-search__input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            state.searchQuery = e.target.value;
            state.autoScroll = false; // Preserve scroll on search
            clearTimeout(attachEventListeners._searchTimeout);
            attachEventListeners._searchTimeout = setTimeout(() => {
                renderContent();
                const input = container.querySelector('.debug-search__input');
                if (input) {
                    input.focus();
                    input.setSelectionRange(input.value.length, input.value.length);
                }
            }, 150);
        });
    }

    // Entry copy buttons (normal mode)
    container.querySelectorAll('[data-copy-id]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.dataset.copyId;
            const entry = state.entries.find(e => e.id === id);
            if (entry) {
                copyToClipboard(formatEntry(entry));
                showToast(S.toast.copied);
            }
        });
    });

    // Entry rows
    container.querySelectorAll('.debug-entry').forEach(row => {
        row.addEventListener('click', (e) => {
            // Don't trigger if clicked on copy button
            if (e.target.closest('[data-copy-id]')) return;

            const id = row.dataset.entryId;

            if (state.selectionMode) {
                state.toggleSelection(id, e.shiftKey);
                state.autoScroll = false;
                renderContent();
            }
        });
    });

    // Footer actions
    container.querySelector('[data-select-all]')?.addEventListener('click', () => {
        state.selectAll();
        state.autoScroll = false;
        renderContent();
    });

    container.querySelector('[data-clear-selection]')?.addEventListener('click', () => {
        state.clearSelection();
        state.autoScroll = false;
        renderContent();
    });

    container.querySelector('[data-exit-selection]')?.addEventListener('click', () => {
        state.exitSelectionMode();
        state.autoScroll = false;
        renderContent();
    });

    container.querySelector('[data-copy-selected]')?.addEventListener('click', () => {
        const selected = state.getSelectedEntries();
        if (selected.length > 0) {
            copyToClipboard(selected.map(formatEntry).join('\n'));
            showToast(`Copied ${selected.length} logs!`);
        }
    });

    container.querySelector('[data-copy-all]')?.addEventListener('click', () => {
        const entries = state.getFilteredEntries();
        if (entries.length > 0) {
            copyToClipboard(entries.map(formatEntry).join('\n'));
            showToast(`Copied ${entries.length} logs!`);
        }
    });

    container.querySelector('[data-export]')?.addEventListener('click', () => {
        const text = state.entries.map(formatEntry).join('\n');
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `debug-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.txt`;
        a.click();
        URL.revokeObjectURL(url);
        showToast(S.toast.exported);
    });
}

// ─────────────────────────────────────────────────────────────────────
// Global API & Console Capture
// ─────────────────────────────────────────────────────────────────────

function debugLog(source, message, data = null) {
    isLoggingInternal = true;
    originalConsole.log(`[${source}] ${message}`, data || '');
    isLoggingInternal = false;

    const entry = state.addEntry(source, message, data);
    if (entry) scheduleUpdate();
}

function scheduleUpdate() {
    if (WidgetManager.isOpen('debug-logs')) {
        if (!scheduleUpdate._pending) {
            scheduleUpdate._pending = true;
            requestAnimationFrame(() => {
                scheduleUpdate._pending = false;
                renderContent();
            });
        }
    }
}

function createConsoleInterceptor(method) {
    return function(...args) {
        originalConsole[method](...args);
        if (isLoggingInternal || args.length === 0) return;
        state.addEntry(`console.${method}`, formatConsoleArgs(args), null);
        scheduleUpdate();
    };
}

function setupConsoleCapture() {
    console.log = createConsoleInterceptor('log');
    console.warn = createConsoleInterceptor('warn');
    console.error = createConsoleInterceptor('error');
    console.info = createConsoleInterceptor('info');
    console.debug = createConsoleInterceptor('debug');

    window.onerror = function(message, source, lineno, colno, error) {
        const loc = source ? `${source}:${lineno}:${colno}` : 'unknown';
        const stack = error?.stack || '';
        state.addEntry('window.onerror', `${message}\nat ${loc}${stack ? '\n' + stack : ''}`, null);
        scheduleUpdate();
        return false;
    };

    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        let msg;
        if (reason instanceof Error) {
            msg = `${reason.name}: ${reason.message}${reason.stack ? '\n' + reason.stack : ''}`;
        } else if (typeof reason === 'string') {
            msg = reason;
        } else {
            try { msg = JSON.stringify(reason); } catch { msg = String(reason); }
        }
        state.addEntry('unhandledrejection', msg, null);
        scheduleUpdate();
    });

    originalConsole.log('[DebugConsole] Console capture active - Alt+D to view');
}

window.debugLog = debugLog;

// ─────────────────────────────────────────────────────────────────────
// Widget Registration
// ─────────────────────────────────────────────────────────────────────

export function registerDebugWidget() {
    setupConsoleCapture();

    WidgetManager.register('debug-logs', {
        title: S.widgets.titles.debug,
        icon: 'terminal',
        type: 'floating',
        scope: 'global',
        shortcut: 'Alt+D',
        defaultSize: { width: 650, height: 420 },
        defaultPosition: { x: 20, y: window.innerHeight - 470 },
        allowedTypes: ['floating', 'bottom-sheet', 'sidebar-right'],

        render: (container, ctx) => {
            state.currentContainer = container;
            if (state.unseenErrorCount > 0) {
                state.unseenErrorCount = 0;
                WidgetBus.emit('debug:errors-changed', { unseen: 0 });
            }
            renderContent();
        },

        onClose: () => {
            state.currentContainer = null;
            state.exitSelectionMode();
        }
    });
}

// ─────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────

export { debugLog };
export const DebugWidget = {
    log: debugLog,
    clear: () => { state.clear(); renderContent(); },
    pause: () => { state.paused = true; },
    resume: () => { state.paused = false; },
    getUnseenErrorCount: () => state.unseenErrorCount,
};
