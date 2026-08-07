/**
 * WidgetEventBus - Decoupled communication between widgets
 *
 * Standard events:
 * - file:open, file:preview, file:created, file:modified, file:deleted
 * - navigate:directory, navigate:file
 * - session:changed, session:message
 * - widget:opened, widget:closed, widget:transformed
 * - layout:changed, layout:saved
 */

import { debug } from '../config.js';

class WidgetEventBus {
    constructor() {
        this.listeners = new Map();
        this.onceListeners = new Map();

        // Debug mode - log all events
        this.debug = false;
    }

    /**
     * Subscribe to an event
     * @param {string} event - Event name
     * @param {Function} callback - Handler function
     * @returns {Function} Unsubscribe function
     */
    on(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event).add(callback);

        // Return unsubscribe function
        return () => this.off(event, callback);
    }

    /**
     * Subscribe to an event once
     * @param {string} event - Event name
     * @param {Function} callback - Handler function
     */
    once(event, callback) {
        if (!this.onceListeners.has(event)) {
            this.onceListeners.set(event, new Set());
        }
        this.onceListeners.get(event).add(callback);
    }

    /**
     * Unsubscribe from an event
     * @param {string} event - Event name
     * @param {Function} callback - Handler to remove
     */
    off(event, callback) {
        this.listeners.get(event)?.delete(callback);
        this.onceListeners.get(event)?.delete(callback);
    }

    /**
     * Emit an event
     * @param {string} event - Event name
     * @param {*} data - Event data
     */
    emit(event, data) {
        if (this.debug) {
            debug.log(`[WidgetBus] ${event}`, data);
        }

        // Regular listeners
        this.listeners.get(event)?.forEach(cb => {
            try {
                cb(data);
            } catch (e) {
                console.error(`[WidgetBus] Error in handler for "${event}":`, e);
            }
        });

        // Once listeners
        const onceHandlers = this.onceListeners.get(event);
        if (onceHandlers) {
            onceHandlers.forEach(cb => {
                try {
                    cb(data);
                } catch (e) {
                    console.error(`[WidgetBus] Error in once handler for "${event}":`, e);
                }
            });
            onceHandlers.clear();
        }
    }

    /**
     * Request/response pattern for queries
     * @param {string} event - Event name
     * @param {*} data - Request data
     * @param {number} timeout - Timeout in ms (default 5000)
     * @returns {Promise<*>} Response data
     */
    async request(event, data = {}, timeout = 5000) {
        return new Promise((resolve, reject) => {
            const responseEvent = `${event}:response:${Date.now()}:${Math.random().toString(36).slice(2)}`;

            const timer = setTimeout(() => {
                this.off(responseEvent, handler);
                reject(new Error(`Request timeout: ${event}`));
            }, timeout);

            const handler = (response) => {
                clearTimeout(timer);
                resolve(response);
            };

            this.once(responseEvent, handler);
            this.emit(event, { ...data, _responseEvent: responseEvent });
        });
    }

    /**
     * Respond to a request
     * @param {object} requestData - Original request data (must contain _responseEvent)
     * @param {*} response - Response data
     */
    respond(requestData, response) {
        if (requestData._responseEvent) {
            this.emit(requestData._responseEvent, response);
        }
    }

    /**
     * Clear all listeners
     */
    clear() {
        this.listeners.clear();
        this.onceListeners.clear();
    }

    /**
     * Get listener count for debugging
     */
    getListenerCount(event) {
        return (this.listeners.get(event)?.size || 0) +
               (this.onceListeners.get(event)?.size || 0);
    }
}

// Global singleton instance
export const WidgetBus = new WidgetEventBus();

// Also export class for testing
export { WidgetEventBus };
