import S from './strings.js';
/**
 * Chat Search Module
 * Provides Ctrl+F search functionality within chat messages
 */

/**
 * ChatSearch - Search and highlight text within chat messages
 */
export class ChatSearch {
    /**
     * @param {HTMLElement} messagesContainer - Container with messages to search
     * @param {Object} elements - UI elements for search bar
     * @param {HTMLElement} elements.searchBar - The search bar container
     * @param {HTMLInputElement} elements.searchInput - The search input field
     * @param {HTMLElement} elements.countDisplay - Element showing "X of Y"
     * @param {HTMLButtonElement} elements.prevBtn - Previous match button
     * @param {HTMLButtonElement} elements.nextBtn - Next match button
     * @param {HTMLButtonElement} elements.closeBtn - Close search button
     * @param {Object} callbacks - Callback functions
     * @param {Function} callbacks.onClose - Called when search is closed (for focus management)
     */
    constructor(messagesContainer, elements, callbacks = {}) {
        this.messagesContainer = messagesContainer;
        this.els = elements;
        this.onClose = callbacks.onClose || (() => {});

        // State
        this.state = {
            active: false,
            query: '',
            matches: [],      // Array of {element, container}
            currentIndex: -1,
            debounceTimer: null
        };

        // Bind event listeners
        this._bindEvents();
    }

    /**
     * Bind UI event listeners
     */
    _bindEvents() {
        // Close button
        this.els.closeBtn?.addEventListener('click', () => this.close());

        // Prev/Next buttons
        this.els.prevBtn?.addEventListener('click', () => this.navigate(-1));
        this.els.nextBtn?.addEventListener('click', () => this.navigate(1));

        // Input events
        this.els.searchInput?.addEventListener('input', (e) => this._handleInput(e));
        this.els.searchInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.navigate(e.shiftKey ? -1 : 1);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
            }
        });
    }

    /**
     * Handle search input changes (debounced)
     */
    _handleInput(e) {
        const query = e.target.value;
        this.state.query = query;

        // Clear existing timer
        if (this.state.debounceTimer) {
            clearTimeout(this.state.debounceTimer);
        }

        // Debounce search
        this.state.debounceTimer = setTimeout(() => {
            this._performSearch();
        }, 150);
    }

    /**
     * Perform the search and highlight matches
     */
    _performSearch() {
        this._clearHighlights();
        this.state.matches = [];
        this.state.currentIndex = -1;

        const query = this.state.query.trim().toLowerCase();
        if (!query) {
            this._updateCount();
            return;
        }

        // Find all text nodes in messages
        const searchTargets = this.messagesContainer?.querySelectorAll(
            '.message-content, .tool-output, .thinking-text'
        );
        if (!searchTargets) return;

        searchTargets.forEach(container => {
            this._highlightInElement(container, query);
        });

        // Update count and navigate to first match
        this._updateCount();
        if (this.state.matches.length > 0) {
            this.state.currentIndex = 0;
            this._highlightCurrent();
        }
    }

    /**
     * Highlight matching text within an element
     */
    _highlightInElement(element, query) {
        const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
            null,
            false
        );

        const textNodes = [];
        while (walker.nextNode()) {
            textNodes.push(walker.currentNode);
        }

        textNodes.forEach(node => {
            const text = node.textContent;
            const lowerText = text.toLowerCase();
            let index = lowerText.indexOf(query);

            if (index === -1) return;

            // Create a document fragment with highlighted spans
            const fragment = document.createDocumentFragment();
            let lastIndex = 0;

            while (index !== -1) {
                // Add text before match
                if (index > lastIndex) {
                    fragment.appendChild(document.createTextNode(text.slice(lastIndex, index)));
                }

                // Add highlighted match
                const span = document.createElement('span');
                span.className = 'search-highlight';
                span.textContent = text.slice(index, index + query.length);
                fragment.appendChild(span);

                // Track match
                this.state.matches.push({
                    element: span,
                    container: element.closest('.message') || element
                });

                lastIndex = index + query.length;
                index = lowerText.indexOf(query, lastIndex);
            }

            // Add remaining text
            if (lastIndex < text.length) {
                fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
            }

            // Replace node
            node.parentNode.replaceChild(fragment, node);
        });
    }

    /**
     * Clear all search highlights
     */
    _clearHighlights() {
        const highlights = this.messagesContainer?.querySelectorAll('.search-highlight');
        highlights?.forEach(span => {
            const text = document.createTextNode(span.textContent);
            span.parentNode.replaceChild(text, span);
        });

        // Normalize to merge adjacent text nodes
        this.messagesContainer?.normalize();
    }

    /**
     * Highlight the current match and scroll to it
     */
    _highlightCurrent() {
        const match = this.state.matches[this.state.currentIndex];
        if (!match) return;

        match.element.classList.add('current');

        // Scroll the match into view
        match.element.scrollIntoView({
            behavior: 'smooth',
            block: 'center'
        });
    }

    /**
     * Update the match count display
     */
    _updateCount() {
        const count = this.state.matches.length;
        const current = this.state.currentIndex + 1;

        if (this.els.countDisplay) {
            if (count === 0 && this.state.query.trim()) {
                this.els.countDisplay.textContent = S.editor.search.no_results;
                this.els.countDisplay.classList.add('no-results');
            } else if (count > 0) {
                this.els.countDisplay.textContent = `${current} of ${count}`;
                this.els.countDisplay.classList.remove('no-results');
            } else {
                this.els.countDisplay.textContent = '';
                this.els.countDisplay.classList.remove('no-results');
            }
        }

        // Enable/disable nav buttons
        const hasMatches = count > 0;
        if (this.els.prevBtn) this.els.prevBtn.disabled = !hasMatches;
        if (this.els.nextBtn) this.els.nextBtn.disabled = !hasMatches;
    }

    // ─────────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────────

    /**
     * Toggle search bar visibility
     */
    toggle() {
        if (this.state.active) {
            this.close();
        } else {
            this.open();
        }
    }

    /**
     * Open the search bar
     */
    open() {
        this.state.active = true;
        this.els.searchBar?.classList.add('visible');
        this.els.searchInput?.focus();

        // If there's existing query, re-run search
        if (this.state.query) {
            this._performSearch();
        }
    }

    /**
     * Close the search bar and clear highlights
     */
    close() {
        // Only trigger callback if search was actually active
        const wasActive = this.state.active;

        this.state.active = false;
        this.els.searchBar?.classList.remove('visible');
        this._clearHighlights();
        this.state.matches = [];
        this.state.currentIndex = -1;
        this._updateCount();

        // Notify caller (for focus management)
        if (wasActive) {
            this.onClose();
        }
    }

    /**
     * Navigate between matches
     * @param {number} direction - 1 for next, -1 for previous
     */
    navigate(direction) {
        if (this.state.matches.length === 0) return;

        // Remove current highlight
        if (this.state.currentIndex >= 0) {
            this.state.matches[this.state.currentIndex]?.element.classList.remove('current');
        }

        // Calculate new index (wrap around)
        this.state.currentIndex += direction;
        if (this.state.currentIndex >= this.state.matches.length) {
            this.state.currentIndex = 0;
        } else if (this.state.currentIndex < 0) {
            this.state.currentIndex = this.state.matches.length - 1;
        }

        this._highlightCurrent();
        this._updateCount();
    }

    /**
     * Check if search is currently active
     */
    get active() {
        return this.state.active;
    }

    /**
     * Get current query
     */
    get query() {
        return this.state.query;
    }

    /**
     * Get match count
     */
    get matchCount() {
        return this.state.matches.length;
    }
}
