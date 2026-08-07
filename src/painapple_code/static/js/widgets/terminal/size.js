/**
 * Floating-mode size config — persisted in localStorage and applied
 * live to the running widget (no reload needed). The Settings widget
 * reads/writes through the public TerminalWidget.{get,set,reset}ConfiguredSize
 * API; the orchestrator's header context menu uses these directly to
 * "save current size as default" and "restore default".
 */

import { WidgetManager } from '../../widget-system/index.js';

export const TERMINAL_SIZE_KEY = 'terminal-floating-size';
export const DEFAULT_TERMINAL_WIDTH = 900;
export const DEFAULT_TERMINAL_HEIGHT = 480;

export function getConfiguredSize() {
    try {
        const saved = localStorage.getItem(TERMINAL_SIZE_KEY);
        if (saved) {
            const { width, height } = JSON.parse(saved);
            if (typeof width === 'number' && typeof height === 'number') {
                return { width, height };
            }
        }
    } catch (e) { /* ignore */ }
    return { width: DEFAULT_TERMINAL_WIDTH, height: DEFAULT_TERMINAL_HEIGHT };
}

export function setConfiguredSize(width, height) {
    try {
        localStorage.setItem(TERMINAL_SIZE_KEY, JSON.stringify({ width, height }));
    } catch (e) { /* ignore */ }
    _applyLiveSize(width, height);
}

export function resetConfiguredSize() {
    try {
        localStorage.removeItem(TERMINAL_SIZE_KEY);
    } catch (e) { /* ignore */ }
    _applyLiveSize(DEFAULT_TERMINAL_WIDTH, DEFAULT_TERMINAL_HEIGHT);
}

/** Update the live floating widget's default and current size without reload */
function _applyLiveSize(width, height) {
    const widget = WidgetManager.widgets.get('terminal');
    if (widget && widget._defaultSize) {
        widget._defaultSize = { width, height };
        // Also resize if currently visible as floating
        if (widget.isVisible && widget.size) {
            widget.size = { width, height };
            widget.updateSize?.();
            widget.config.onResize?.();
        }
    }
}
