/**
 * Caret Position Helper
 *
 * Anchors floating popups (autocomplete, mention pickers) near the caret
 * inside a plain <textarea>. Native textareas expose no API for per-char
 * pixel coords, so we render a mirror <div> with identical styles and
 * measure a <span> placed at the target char index.
 *
 * Scoped re-position on scroll/resize is handled by the popup itself via
 * the cleanup callback returned from anchorAbove().
 */

/**
 * CSS properties that affect text layout and must be copied to the mirror
 * so span offsets match what the browser renders inside the textarea.
 */
const MIRROR_PROPS = [
    'boxSizing',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
    'fontStretch', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textTransform',
    'textIndent', 'textRendering', 'textAlign', 'tabSize', 'MozTabSize',
    'whiteSpace', 'overflowWrap', 'wordWrap', 'wordBreak',
    'direction',
];

let _mirror = null;

function getMirror() {
    if (_mirror && _mirror.isConnected) return _mirror;
    _mirror = document.createElement('div');
    _mirror.setAttribute('aria-hidden', 'true');
    Object.assign(_mirror.style, {
        position: 'absolute',
        top: '0',
        left: '0',
        visibility: 'hidden',
        pointerEvents: 'none',
        overflow: 'hidden',
        whiteSpace: 'pre-wrap',
        wordWrap: 'break-word',
    });
    document.body.appendChild(_mirror);
    return _mirror;
}

/**
 * Measure the pixel rect of the character at `charIndex` in `textarea`.
 * Returns {top, left, height, width} in viewport coordinates.
 */
export function measureCharRect(textarea, charIndex) {
    const mirror = getMirror();
    const cs = getComputedStyle(textarea);

    for (const prop of MIRROR_PROPS) {
        mirror.style[prop] = cs[prop];
    }
    mirror.style.width = textarea.clientWidth + 'px';
    mirror.style.height = 'auto';

    const value = textarea.value;
    const before = value.substring(0, charIndex);
    // Include the target char so the span has real glyph metrics.
    // Fall back to '.' if char is absent (caret at end of buffer).
    const targetChar = value.charAt(charIndex) || '.';
    const after = value.substring(charIndex + 1);

    mirror.textContent = before;
    const marker = document.createElement('span');
    marker.textContent = targetChar;
    mirror.appendChild(marker);
    // Preserve trailing content so wrap flow stays identical.
    mirror.appendChild(document.createTextNode(after + ' '));

    const taRect = textarea.getBoundingClientRect();
    const markerOffsetTop = marker.offsetTop;
    const markerOffsetLeft = marker.offsetLeft;
    const markerHeight = marker.offsetHeight;
    const markerWidth = marker.offsetWidth;

    mirror.textContent = '';

    return {
        top: taRect.top + markerOffsetTop - textarea.scrollTop,
        left: taRect.left + markerOffsetLeft - textarea.scrollLeft,
        height: markerHeight,
        width: markerWidth,
    };
}

/**
 * Anchor `popup` so its bottom edge sits just above the character at
 * `charIndex` in `textarea`. Flips to below-caret placement when there's
 * not enough room above.
 *
 * The popup must be absolutely positioned inside a relatively positioned
 * offsetParent. We write to `top`/`bottom` in the offsetParent's coords.
 *
 * Returns a cleanup function that removes the scroll/resize listeners.
 */
export function anchorAbove(popup, textarea, charIndex) {
    const update = () => {
        if (!popup.isConnected || !textarea.isConnected) return;

        const parent = popup.offsetParent;
        if (!parent) return;

        const parentRect = parent.getBoundingClientRect();
        const taRect = textarea.getBoundingClientRect();
        const caret = measureCharRect(textarea, charIndex);

        // Clamp caret Y into the textarea's visible band so a scrolled-away
        // anchor still yields a sensible popup position (near caret line,
        // not off-screen).
        const caretTopVP = Math.max(taRect.top, Math.min(caret.top, taRect.bottom - caret.height));
        const caretBottomVP = caretTopVP + caret.height;
        const caretLeftVP = caret.left;

        const spaceAbove = caretTopVP - 8;  // 8px margin from viewport top
        const popupHeight = popup.offsetHeight || 0;
        const popupWidth = popup.offsetWidth || 0;

        // Reset all so the chosen sides win cleanly.
        popup.style.top = '';
        popup.style.bottom = '';
        popup.style.left = '';
        popup.style.right = '';

        const placeBelow = spaceAbove < Math.min(popupHeight, 180);

        if (placeBelow) {
            const topInParent = caretBottomVP - parentRect.top + 4;
            popup.style.top = topInParent + 'px';
            popup.dataset.caretPlacement = 'below';
        } else {
            const bottomInParent = parentRect.bottom - caretTopVP + 4;
            popup.style.bottom = bottomInParent + 'px';
            popup.dataset.caretPlacement = 'above';
        }

        // Horizontal: anchor popup's left edge near caret column, but
        // clamp so it stays inside the viewport with an 8px gutter.
        const viewportW = window.innerWidth;
        const maxLeftVP = viewportW - popupWidth - 8;
        const minLeftVP = 8;
        // Nudge slightly left of caret so the first char of popup items
        // roughly lines up with the trigger glyph, not a gap to its right.
        const desiredLeftVP = Math.max(minLeftVP, Math.min(maxLeftVP, caretLeftVP - 12));
        const leftInParent = desiredLeftVP - parentRect.left;
        popup.style.left = leftInParent + 'px';
    };

    // Run now and on every frame for two ticks — once to get a measurement,
    // then again after the popup's real height is known post-render.
    update();
    requestAnimationFrame(update);

    const onScroll = () => requestAnimationFrame(update);
    const onResize = () => requestAnimationFrame(update);

    textarea.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });

    return () => {
        textarea.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onResize);
        window.removeEventListener('scroll', onScroll, { capture: true });
    };
}
