/**
 * Image preview plugin
 *
 * Handles: png, jpg, jpeg, gif, webp, svg, ico, bmp
 * Renders via panzoom canvas with /api/file-raw endpoint.
 */

import { CONFIG } from './plugin-helpers.js';
import { createPanzoomPlugin } from './panzoom-plugin.js';

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'];

export default createPanzoomPlugin({
    id: 'image',
    match: (path) => IMAGE_EXTENSIONS.includes(path?.split('.').pop()?.toLowerCase()),
    canvasClass: 'preview-image-body',
    imgClass: 'preview-image',
    hasDarkToggle: false,
    getSrc: (path) => `${CONFIG.API_BASE}/api/file-raw?path=${encodeURIComponent(path)}`,
});
