/**
 * Vega-Lite chart preview plugin
 *
 * Handles: .vl.json
 * Server converts to SVG via Node.js subprocess, rendered in panzoom canvas.
 */

import { CONFIG } from './plugin-helpers.js';
import { createPanzoomPlugin } from './panzoom-plugin.js';

export default createPanzoomPlugin({
    id: 'chart',
    match: (path) => path?.toLowerCase().endsWith('.vl.json'),
    canvasClass: 'chart-canvas',
    imgClass: 'chart-preview-img',
    bodyClass: 'preview-chart-body',
    hasDarkToggle: true,
    getSrc: (path, ps) => {
        const darkParam = ps.isDark ? '&dark=1' : '';
        return `${CONFIG.API_BASE}/api/file-raw?path=${encodeURIComponent(path)}${darkParam}`;
    },
});
