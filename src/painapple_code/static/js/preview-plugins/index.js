/**
 * Preview plugin registry
 *
 * Imports all preview plugins and exports them as an ordered array.
 * First match wins when dispatching by file path.
 */

import excalidraw from './excalidraw-plugin.js';
import chart from './chart-plugin.js';
import image from './image-plugin.js';
import csv from './csv-plugin.js';
import diff from './diff-plugin.js';
import markdown from './markdown-plugin.js';
import html from './html-plugin.js';
import jsonl from './jsonl-plugin.js';
import json from './json-plugin.js';

// Order matters: more specific matchers first, generic ones last.
// Excalidraw before image (since .excalidraw files shouldn't match image plugin).
// Chart before json (since .vl.json should go to chart, not json tree).
// JSONL before json (extensions are disjoint, but listing it earlier signals
// the more specific match.)
// Diff sits with the other text formats; .diff/.patch are disjoint from everything.
export const previewPlugins = [excalidraw, chart, image, csv, diff, markdown, html, jsonl, json];

/**
 * Find the plugin that handles a given file path.
 * @param {string} path - File path
 * @returns {object|null} - Plugin object or null for default code view
 */
export function findPlugin(path) {
    if (!path) return null;
    return previewPlugins.find(p => p.match(path)) || null;
}
