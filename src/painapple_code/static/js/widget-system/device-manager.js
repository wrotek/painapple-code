/**
 * DeviceManager - Device detection and responsive utilities
 *
 * Device types:
 * - phone: < 768px
 * - tablet: 768-1024px (or touch device < 1100px)
 * - desktop: >= 1024px (non-touch) or >= 1100px (any)
 */

class DeviceManagerClass {
    constructor() {
        this.callbacks = new Set();
        this.currentDevice = this.detectDevice();

        // Stability-based device change: viewport must remain at a new device type
        // for 1.5s before we apply the change. This prevents transient viewport
        // shrinkage during iOS app switch from triggering widget transformations
        // (floating → bottom-sheet), while still allowing sustained changes like
        // Split View or rotation to apply after a short delay.
        this._confirmTimeout = null;

        window.addEventListener('resize', () => this._scheduleDeviceCheck());
        window.addEventListener('orientationchange', () => this._scheduleDeviceCheck());

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                // Going to background — cancel any pending device change
                clearTimeout(this._confirmTimeout);
            } else {
                // Returning — schedule check after viewport stabilizes
                this._scheduleDeviceCheck();
            }
        });
    }

    /**
     * Schedule a device-type check after a stability delay.
     * Every call resets the timer, so transient viewport changes
     * (iOS app switch) never reach the threshold.
     */
    _scheduleDeviceCheck() {
        clearTimeout(this._confirmTimeout);
        this._confirmTimeout = setTimeout(() => {
            if (document.visibilityState === 'hidden') return;
            const newDevice = this.detectDevice();
            if (newDevice !== this.currentDevice) {
                const oldDevice = this.currentDevice;
                this.currentDevice = newDevice;
                this.notifyChange(newDevice, oldDevice);
            }
        }, 1500);
    }

    /**
     * Detect current device type
     * @returns {'phone' | 'tablet' | 'desktop'}
     */
    detectDevice() {
        const width = window.innerWidth;
        const isTouch = this.isTouchDevice();

        if (width < 768) {
            return 'phone';
        }

        if (width < 1024 || (width < 1100 && isTouch)) {
            return 'tablet';
        }

        return 'desktop';
    }

    /**
     * Check if device supports touch
     * @returns {boolean}
     */
    isTouchDevice() {
        return 'ontouchstart' in window ||
               navigator.maxTouchPoints > 0 ||
               // @ts-ignore
               navigator.msMaxTouchPoints > 0;
    }

    /**
     * Get current device type
     * @returns {'phone' | 'tablet' | 'desktop'}
     */
    getDevice() {
        return this.currentDevice;
    }

    /**
     * Check if current device matches
     * @param {'phone' | 'tablet' | 'desktop'} device
     * @returns {boolean}
     */
    is(device) {
        return this.currentDevice === device;
    }

    /**
     * Check if device is mobile (phone or tablet)
     * @returns {boolean}
     */
    isMobile() {
        return this.currentDevice === 'phone' || this.currentDevice === 'tablet';
    }

    /**
     * Subscribe to device changes
     * @param {Function} callback - (newDevice, oldDevice) => void
     * @returns {Function} Unsubscribe function
     */
    onChange(callback) {
        this.callbacks.add(callback);
        return () => this.callbacks.delete(callback);
    }

    /**
     * Notify subscribers of device change
     */
    notifyChange(newDevice, oldDevice) {
        this.callbacks.forEach(cb => {
            try {
                cb(newDevice, oldDevice);
            } catch (e) {
                console.error('[DeviceManager] Error in change callback:', e);
            }
        });
    }

    /**
     * Get viewport dimensions
     * @returns {{ width: number, height: number }}
     */
    getViewport() {
        return {
            width: window.innerWidth,
            height: window.innerHeight
        };
    }

    /**
     * Check if in portrait orientation
     * @returns {boolean}
     */
    isPortrait() {
        return window.innerHeight > window.innerWidth;
    }

    /**
     * Check if in landscape orientation
     * @returns {boolean}
     */
    isLandscape() {
        return window.innerWidth > window.innerHeight;
    }

    /**
     * Get safe area insets (for notched devices)
     * @returns {{ top: number, right: number, bottom: number, left: number }}
     */
    getSafeAreaInsets() {
        const computedStyle = getComputedStyle(document.documentElement);
        return {
            top: parseInt(computedStyle.getPropertyValue('--sat') || '0', 10),
            right: parseInt(computedStyle.getPropertyValue('--sar') || '0', 10),
            bottom: parseInt(computedStyle.getPropertyValue('--sab') || '0', 10),
            left: parseInt(computedStyle.getPropertyValue('--sal') || '0', 10)
        };
    }
}

// Global singleton
export const DeviceManager = new DeviceManagerClass();

// Also export class for testing
export { DeviceManagerClass };
