/**
 * CSV/TSV preview plugin
 *
 * Handles: .csv, .tsv
 * Parses text content client-side and renders as an interactive HTML table.
 * Adds a "Table" view mode; falls through to code view for 'code' mode.
 */

import { escapeHtml } from './plugin-helpers.js';

/**
 * Parse CSV/TSV content into rows of fields.
 * Handles quoted fields with embedded commas, newlines, and escaped quotes (RFC 4180).
 */
function parseCsv(text, delimiter = ',') {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;

    while (i < text.length) {
        const ch = text[i];

        if (inQuotes) {
            if (ch === '"') {
                if (i + 1 < text.length && text[i + 1] === '"') {
                    field += '"';
                    i += 2;
                } else {
                    inQuotes = false;
                    i++;
                }
            } else {
                field += ch;
                i++;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
                i++;
            } else if (ch === delimiter) {
                row.push(field);
                field = '';
                i++;
            } else if (ch === '\r') {
                // Handle \r\n or bare \r
                row.push(field);
                field = '';
                rows.push(row);
                row = [];
                i++;
                if (i < text.length && text[i] === '\n') i++;
            } else if (ch === '\n') {
                row.push(field);
                field = '';
                rows.push(row);
                row = [];
                i++;
            } else {
                field += ch;
                i++;
            }
        }
    }

    // Last field/row
    if (field || row.length > 0) {
        row.push(field);
        rows.push(row);
    }

    return rows;
}

/**
 * Detect delimiter: if TSV extension or more tabs than commas, use tab
 */
function detectDelimiter(path, content) {
    if (path?.toLowerCase().endsWith('.tsv')) return '\t';
    const firstLines = content.slice(0, 2000);
    const tabs = (firstLines.match(/\t/g) || []).length;
    const commas = (firstLines.match(/,/g) || []).length;
    return tabs > commas ? '\t' : ',';
}

function renderTable(rows) {
    if (rows.length === 0) return '<div class="csv-empty">Empty file</div>';

    const header = rows[0];
    const body = rows.slice(1);
    const colCount = header.length;
    const rowCount = body.length;

    const badge = `<div class="csv-badge">${rowCount} row${rowCount !== 1 ? 's' : ''} × ${colCount} col${colCount !== 1 ? 's' : ''}</div>`;

    const thead = `<thead><tr>${header.map((h, i) =>
        `<th data-col="${i}"><span class="csv-th-text">${escapeHtml(h.trim()) || `<span class="csv-col-index">${i + 1}</span>`}</span></th>`
    ).join('')}</tr></thead>`;

    const tbody = `<tbody>${body.map((row, ri) =>
        `<tr>${header.map((_, ci) =>
            `<td>${escapeHtml(row[ci]?.trim() ?? '')}</td>`
        ).join('')}</tr>`
    ).join('')}</tbody>`;

    return `
        ${badge}
        <div class="csv-table-wrapper">
            <table class="csv-table">${thead}${tbody}</table>
        </div>
    `;
}

export default {
    id: 'csv',

    match(path) {
        const ext = path?.split('.').pop()?.toLowerCase();
        return ext === 'csv' || ext === 'tsv';
    },

    needsFetch: true,
    editable: true,

    viewModes: [{
        mode: 'table',
        label: 'Table',
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>`,
    }],

    defaultViewMode: 'table',

    initState() {
        return { sortCol: -1, sortAsc: true };
    },

    renderBody(state, helpers) {
        if (state.viewMode !== 'table') return null;

        const content = state.content || '';
        const delimiter = detectDelimiter(state.currentPath, content);
        const rows = parseCsv(content, delimiter);

        // Apply sorting if active
        const ps = state.pluginState;
        if (ps.sortCol >= 0 && rows.length > 1) {
            const header = rows[0];
            const body = rows.slice(1);
            const col = ps.sortCol;
            body.sort((a, b) => {
                const va = a[col] ?? '';
                const vb = b[col] ?? '';
                // Try numeric comparison
                const na = parseFloat(va);
                const nb = parseFloat(vb);
                if (!isNaN(na) && !isNaN(nb)) {
                    return ps.sortAsc ? na - nb : nb - na;
                }
                return ps.sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
            });
            const sorted = [header, ...body];
            return `<div class="preview-body csv-preview-body">${renderTable(sorted)}</div>`;
        }

        return `<div class="preview-body csv-preview-body">${renderTable(rows)}</div>`;
    },

    setupEvents(container, state, helpers) {
        if (state.viewMode !== 'table') return;

        // Column header click → sort
        container.querySelectorAll('.csv-table th[data-col]').forEach(th => {
            th.style.cursor = 'pointer';
            th.addEventListener('click', () => {
                const col = parseInt(th.dataset.col, 10);
                const ps = state.pluginState;
                if (ps.sortCol === col) {
                    ps.sortAsc = !ps.sortAsc;
                } else {
                    ps.sortCol = col;
                    ps.sortAsc = true;
                }
                helpers.rerenderContent();
            });
        });
    },
};
