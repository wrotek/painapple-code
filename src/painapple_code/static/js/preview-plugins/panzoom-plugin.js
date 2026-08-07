/**
 * Panzoom plugin factory
 *
 * Creates plugins for file types that render as images in a panzoom canvas.
 * Used by: image, excalidraw, chart plugins.
 */

import { CONFIG, escapeHtml, panzoomToolbarHtml, setupPanZoom, darkDefault } from './plugin-helpers.js';

/**
 * @param {object} opts
 * @param {string} opts.id - Plugin ID
 * @param {Function} opts.match - (path) => boolean
 * @param {string} opts.canvasClass - CSS class for the panzoom canvas container
 * @param {string} opts.imgClass - CSS class for the image element
 * @param {boolean} opts.hasDarkToggle - Show dark/light toggle button
 * @param {Function} opts.getSrc - (path, pluginState) => image URL string
 * @param {string} [opts.bodyClass] - Additional class on preview-body (e.g. 'preview-excalidraw-body')
 */
export function createPanzoomPlugin({ id, match, canvasClass, imgClass, hasDarkToggle, getSrc, bodyClass }) {
    return {
        id,
        match,
        needsFetch: false,
        editable: false,

        initState() {
            const s = { scale: 1, tx: 0, ty: 0 };
            if (hasDarkToggle) s.isDark = darkDefault;
            return s;
        },

        renderBody(state, helpers) {
            const ps = state.pluginState;
            const src = getSrc(state.currentPath, ps);
            const fileName = state.currentPath?.split('/').pop() || '';
            const bodyClasses = ['preview-body', canvasClass];
            if (bodyClass) bodyClasses.push(bodyClass);
            bodyClasses.push('panzoom-canvas');

            return `
                ${panzoomToolbarHtml(ps, { hasDarkToggle })}
                <div class="${bodyClasses.join(' ')}" data-bg="${ps.isDark ? 'dark' : 'light'}">
                    <img src="${src}" alt="${escapeHtml(fileName)}" class="${imgClass} panzoom-img" />
                </div>
            `;
        },

        setupEvents(container, state, helpers) {
            const ps = state.pluginState;
            setupPanZoom(container, ps, {
                canvasSelector: `.${canvasClass}`,
                imgSelector: `.${imgClass}`,
                stateCheck: () => state.plugin?.id === id,
                onDarkToggle: hasDarkToggle ? () => {
                    ps.isDark = !ps.isDark;
                    helpers.rerenderContent();
                } : undefined,
            });
        },
    };
}
