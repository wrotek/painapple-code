/**
 * Performance instrumentation module.
 * Only loaded when ?perf=true is in the URL.
 * Wraps key functions with performance.mark/measure calls.
 *
 * Usage from Playwright:
 *   window.__perfCollect()  → returns all measures as array
 *   window.__perfClear()    → clears all marks/measures
 *   window.__perfEnabled    → true when loaded
 */

import { debug } from './config.js';

window.__perfEnabled = true;

// ── Wrap a method with performance marks ──
function wrapMethod(obj, methodName, label) {
    const original = obj[methodName];
    if (!original) return;
    obj[methodName] = function (...args) {
        const markStart = `${label}-start`;
        const markEnd = `${label}-end`;
        performance.mark(markStart);
        const result = original.apply(this, args);
        performance.mark(markEnd);
        performance.measure(label, markStart, markEnd);
        return result;
    };
}

// ── Instrument ChatController.renderMessages ──
function instrumentChatController() {
    const chatCtrl = window.app?.chatCtrl;
    if (!chatCtrl) return false;
    wrapMethod(chatCtrl, 'renderMessages', 'render-messages');
    wrapMethod(chatCtrl, '_renderMessagesIntoContainer', 'render-into-container');
    return true;
}

// ── Instrument SessionContainerPool.activate ──
function instrumentContainerPool() {
    const pool = window.app?.chatCtrl?._containerPool;
    if (!pool) return false;
    wrapMethod(pool, 'activate', 'pool-activate');
    return true;
}

// ── Instrument App._doSessionSwitch ──
function instrumentSessionSwitch() {
    const app = window.app;
    if (!app) return false;
    wrapMethod(app, '_doSessionSwitch', 'session-switch');
    return true;
}

// ── API: Collect all measures ──
window.__perfCollect = function () {
    return performance.getEntriesByType('measure').map(e => ({
        name: e.name,
        duration: Math.round(e.duration * 100) / 100,
        startTime: Math.round(e.startTime * 100) / 100,
    }));
};

// ── API: Clear all marks and measures ──
window.__perfClear = function () {
    performance.clearMarks();
    performance.clearMeasures();
};

// ── API: Get measures by name ──
window.__perfGet = function (name) {
    return performance.getEntriesByName(name, 'measure').map(e => ({
        duration: Math.round(e.duration * 100) / 100,
        startTime: Math.round(e.startTime * 100) / 100,
    }));
};

// ── Apply all instrumentation ──
function applyInstrumentation() {
    const results = {
        chatController: instrumentChatController(),
        containerPool: instrumentContainerPool(),
        sessionSwitch: instrumentSessionSwitch(),
    };
    debug.log('[Perf] Instrumentation applied:', results);
}

// App may not be ready yet, wait for it
if (window.app?.chatCtrl) {
    applyInstrumentation();
} else {
    // Poll briefly for app readiness
    let attempts = 0;
    const interval = setInterval(() => {
        if (window.app?.chatCtrl || ++attempts > 50) {
            clearInterval(interval);
            if (window.app?.chatCtrl) applyInstrumentation();
            else console.warn('[Perf] App not ready after 5s, skipping instrumentation');
        }
    }, 100);
}
