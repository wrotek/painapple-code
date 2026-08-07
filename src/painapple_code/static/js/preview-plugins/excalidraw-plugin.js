/**
 * Excalidraw preview plugin
 *
 * Handles: .excalidraw, .excalidraw.md
 * Server converts to SVG via Node.js subprocess, rendered in panzoom canvas.
 */

import { CONFIG } from './plugin-helpers.js';
import { createPanzoomPlugin } from './panzoom-plugin.js';

export default createPanzoomPlugin({
    id: 'excalidraw',
    match: (path) => {
        const lower = path?.toLowerCase();
        return lower?.endsWith('.excalidraw') || lower?.endsWith('.excalidraw.md');
    },
    canvasClass: 'excalidraw-canvas',
    imgClass: 'excalidraw-preview-img',
    bodyClass: 'preview-excalidraw-body',
    hasDarkToggle: true,
    getSrc: (path, ps) => {
        const darkParam = ps.isDark ? '&dark=1' : '';
        return `${CONFIG.API_BASE}/api/file-raw?path=${encodeURIComponent(path)}${darkParam}`;
    },
});
