/**
 * Wheel + touch swipe handlers for the Settings widget — horizontal
 * scroll/swipe cycles through tabs, matching the behaviour the main app
 * already provides via `gestures.js` for sessions.
 *
 * `setupConfigGestures` takes a `cycleTab` callback rather than reaching
 * back into the orchestrator, so this module has no circular dependency
 * on config-widget.js. Module-level state (handler refs, accumulator,
 * cooldown flags) is fine because at most one Settings widget is open at
 * a time.
 */

// Configuration (matching gestures.js values)
const gestureConfig = {
    wheelThreshold: 120,
    wheelResetDelay: 150,
    wheelCooldownTime: 400,
    touchThreshold: 130,
    touchMaxTime: 500,
    touchAngleThreshold: 2.0,
    touchCooldownTime: 400,
};

let wheelHandler = null;
let touchStartHandler = null;
let touchEndHandler = null;

// Wheel gesture state
let wheelAccumulator = 0;
let wheelTimeout = null;
let wheelCooldown = false;

// Touch gesture state
let touchStartX = 0;
let touchStartY = 0;
let touchStartTime = 0;
let touchCooldown = false;

function makeWheelHandler(cycleTab) {
    return function handleConfigWheel(e) {
        // Only care about significant horizontal movement
        const isHorizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 5;
        if (!isHorizontal) return;

        // Prevent default to stop any scroll behavior
        e.preventDefault();

        if (wheelCooldown) return;

        // Accumulate horizontal movement
        wheelAccumulator += e.deltaX;

        // Clear existing timeout
        if (wheelTimeout) {
            clearTimeout(wheelTimeout);
        }

        // Check if threshold exceeded
        if (Math.abs(wheelAccumulator) >= gestureConfig.wheelThreshold) {
            const direction = wheelAccumulator > 0 ? 1 : -1;  // 1 = next (swipe left), -1 = prev (swipe right)
            cycleTab(direction);

            // Reset and set cooldown
            wheelAccumulator = 0;
            wheelCooldown = true;
            setTimeout(() => {
                wheelCooldown = false;
            }, gestureConfig.wheelCooldownTime);
        }

        // Reset accumulator after delay (gesture ended)
        wheelTimeout = setTimeout(() => {
            wheelAccumulator = 0;
        }, gestureConfig.wheelResetDelay);
    };
}

function handleConfigTouchStart(e) {
    if (e.touches.length !== 1) return;  // Single finger only
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();
}

function makeTouchEndHandler(cycleTab) {
    return function handleConfigTouchEnd(e) {
        if (touchCooldown) return;
        if (!touchStartTime) return;

        const touch = e.changedTouches[0];
        const deltaX = touch.clientX - touchStartX;
        const deltaY = touch.clientY - touchStartY;
        const deltaTime = Date.now() - touchStartTime;

        // Reset
        touchStartTime = 0;

        // Must be fast enough
        if (deltaTime > gestureConfig.touchMaxTime) return;

        // Must be horizontal enough
        const absX = Math.abs(deltaX);
        const absY = Math.abs(deltaY);
        if (absY !== 0 && absX / absY < gestureConfig.touchAngleThreshold) return;

        // Must exceed threshold
        if (absX < gestureConfig.touchThreshold) return;

        // Trigger tab switch: swipe left = next, swipe right = prev
        const direction = deltaX < 0 ? 1 : -1;
        cycleTab(direction);

        // Set cooldown
        touchCooldown = true;
        setTimeout(() => {
            touchCooldown = false;
        }, gestureConfig.touchCooldownTime);
    };
}

/**
 * Attach wheel + touch handlers to a Settings container that should
 * forward horizontal gestures into tab cycling. `cycleTab` receives a
 * direction (1 next, -1 prev).
 */
export function setupConfigGestures(container, cycleTab) {
    // Wheel events for trackpad
    wheelHandler = makeWheelHandler(cycleTab);
    container.addEventListener('wheel', wheelHandler, { passive: false });

    // Touch events for mobile/tablet
    touchStartHandler = handleConfigTouchStart;
    touchEndHandler = makeTouchEndHandler(cycleTab);
    container.addEventListener('touchstart', touchStartHandler, { passive: true });
    container.addEventListener('touchend', touchEndHandler, { passive: true });
}

export function cleanupConfigGestures(container) {
    if (wheelHandler) {
        container.removeEventListener('wheel', wheelHandler);
        wheelHandler = null;
    }
    if (touchStartHandler) {
        container.removeEventListener('touchstart', touchStartHandler);
        touchStartHandler = null;
    }
    if (touchEndHandler) {
        container.removeEventListener('touchend', touchEndHandler);
        touchEndHandler = null;
    }

    // Reset state
    wheelAccumulator = 0;
    wheelCooldown = false;
    touchStartTime = 0;
    touchCooldown = false;
    if (wheelTimeout) {
        clearTimeout(wheelTimeout);
        wheelTimeout = null;
    }
}
