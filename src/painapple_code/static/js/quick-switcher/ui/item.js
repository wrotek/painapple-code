/**
 * Item rendering for the QuickSwitcher list.
 *
 * Pure HTML string generators — picker.js handles the DOM events.
 */

import { ICONS } from '../../widget-system/index.js';
import { escapeHtml } from '../../utils.js';
import { highlightMatches } from '../fuzzy-scorer.js';

const TYPE_FALLBACK_ICON = {
    file: ICONS.file,
    command: ICONS.terminal,
    panel: ICONS.sidebar,
    project: ICONS.folder,
};

const GENERIC_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/></svg>';

function resolveIcon(item) {
    if (!item.icon) return TYPE_FALLBACK_ICON[item.type] || GENERIC_ICON;
    if (typeof item.icon === 'string' && item.icon.startsWith('<svg')) return item.icon;
    if (ICONS[item.icon]) return ICONS[item.icon];
    return TYPE_FALLBACK_ICON[item.type] || GENERIC_ICON;
}

export function renderItem(item, index, isSelected) {
    const labelHtml = item.matches
        ? highlightMatches(item.label, item.matches, escapeHtml)
        : escapeHtml(item.label);

    const desc = item.description ? `<span class="qs-item-desc">${escapeHtml(item.description)}</span>` : '';
    const meta = item.meta ? `<span class="qs-item-meta">${escapeHtml(item.meta)}</span>` : '';
    const cls = `qs-item qs-item-${item.type || 'generic'}${isSelected ? ' selected' : ''}`;

    return `
        <div class="${cls}" role="option" data-index="${index}" id="qs-item-${index}" aria-selected="${isSelected}">
            <span class="qs-item-icon">${resolveIcon(item)}</span>
            <span class="qs-item-text">
                <span class="qs-item-label">${labelHtml}</span>
                ${desc}
            </span>
            ${meta}
        </div>
    `;
}

export function renderSection(title, count) {
    return `<div class="qs-section">${escapeHtml(title)}${count != null ? ` <span class="qs-section-count">${count}</span>` : ''}</div>`;
}

export function renderEmpty(text) {
    return `<div class="qs-empty">${escapeHtml(text)}</div>`;
}
