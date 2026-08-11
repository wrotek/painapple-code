import S from './strings.js';
import { debug } from './config.js';
import { escapeHtml } from './utils.js';
/**
 * EditorView - CodeMirror 6 wrapper backed by a self-hosted bundle.
 *
 * The bundle at /static/vendor/codemirror.js is built by tools/build-codemirror.sh
 * and committed to the repo, so the editor works offline and on flaky networks.
 */

let cmModules = null;
let loadingPromise = null;

async function loadCodeMirror() {
    if (cmModules) return cmModules;
    if (loadingPromise) return loadingPromise;

    loadingPromise = (async () => {
        debug.log('[EditorView] Loading CodeMirror 6 bundle...');

        const cm = await import('/static/vendor/codemirror.js');

        debug.log('[EditorView] CodeMirror 6 loaded successfully');

        cmModules = {
            EditorView: cm.EditorView,
            EditorState: cm.EditorState,
            Compartment: cm.Compartment,
            keymap: cm.keymap,
            lineNumbers: cm.lineNumbers,
            highlightActiveLine: cm.highlightActiveLine,
            highlightActiveLineGutter: cm.highlightActiveLineGutter,
            drawSelection: cm.drawSelection,
            dropCursor: cm.dropCursor,
            rectangularSelection: cm.rectangularSelection,
            crosshairCursor: cm.crosshairCursor,
            highlightSpecialChars: cm.highlightSpecialChars,
            defaultHighlightStyle: cm.defaultHighlightStyle,
            syntaxHighlighting: cm.syntaxHighlighting,
            indentOnInput: cm.indentOnInput,
            bracketMatching: cm.bracketMatching,
            foldGutter: cm.foldGutter,
            foldKeymap: cm.foldKeymap,
            defaultKeymap: cm.defaultKeymap,
            history: cm.history,
            historyKeymap: cm.historyKeymap,
            indentWithTab: cm.indentWithTab,
            toggleComment: cm.toggleComment,
            toggleBlockComment: cm.toggleBlockComment,
            closeBrackets: cm.closeBrackets,
            closeBracketsKeymap: cm.closeBracketsKeymap,
            search: cm.search,
            searchKeymap: cm.searchKeymap,
            highlightSelectionMatches: cm.highlightSelectionMatches,
            openSearchPanel: cm.openSearchPanel,
            closeSearchPanel: cm.closeSearchPanel,
            getSearchQuery: cm.getSearchQuery,
            findNext: cm.findNext,
            findPrevious: cm.findPrevious,
            setSearchQuery: cm.setSearchQuery,
            SearchQuery: cm.SearchQuery,
            replaceNext: cm.replaceNext,
            replaceAll: cm.replaceAll,
            appTheme: buildAppTheme(cm),
            appHighlighter: buildAppHighlighter(cm),
            highlightCode: cm.highlightCode,
            ensureSyntaxTree: cm.ensureSyntaxTree,
            foldNodeProp: cm.foldNodeProp,
            languages: {
                javascript: cm.javascript,
                typescript: cm.javascript,  // JS package handles TS with jsx option
                python: cm.python,
                html: cm.html,
                css: cm.css,
                scss: cm.css,
                less: cm.css,
                json: cm.json,
                markdown: cm.markdown,
                sql: cm.sql,
                rust: cm.rust,
                cpp: cm.cpp,
                c: cm.cpp,
                java: cm.java,
                kotlin: cm.kotlin,
                php: cm.php,
                xml: cm.xml,
                yaml: cm.yaml,
                // Legacy stream modes (wrapped factories from codemirror-entry.js)
                shell: cm.shell,
                fish: cm.shell,  // No fish mode; bash is close enough
                ruby: cm.ruby,
                go: cm.go,
                swift: cm.swift,
                csharp: cm.csharp,
                scala: cm.scala,
                dockerfile: cm.dockerfile,
                nginx: cm.nginx,
                toml: cm.toml,
                ini: cm.properties,
                env: cm.env,
                makefile: null,  // Not in @codemirror/legacy-modes
                text: null
            }
        };

        return cmModules;
    })();

    return loadingPromise;
}

/**
 * App UI theme — replaces the oneDark package theme so the editor chrome
 * matches the app (and the preview widget) instead of One Dark's own greys.
 */
function buildAppTheme(cm) {
    return cm.EditorView.theme({
        '&': {
            color: 'var(--text-primary)',
            backgroundColor: 'var(--bg-primary)'
        },
        '.cm-content': { caretColor: 'var(--text-primary)' },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text-primary)' },
        '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
            background: 'rgba(56, 139, 253, 0.30)'
        },
        '.cm-selectionMatch': { backgroundColor: 'rgba(56, 139, 253, 0.18)' },
        '&.cm-focused .cm-matchingBracket': { backgroundColor: 'rgba(97, 175, 239, 0.25)' },
        '.cm-gutters': {
            backgroundColor: 'transparent',
            color: 'var(--text-muted)',
            border: 'none'
        },
        '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.03)' },
        '.cm-activeLineGutter': { backgroundColor: 'rgba(255, 255, 255, 0.03)' },
        '.cm-panels': {
            backgroundColor: 'var(--bg-secondary, #161b22)',
            color: 'var(--text-primary)'
        }
    }, { dark: true });
}

/**
 * Shared syntax highlighter — emits stable .tok-* classes styled in CSS
 * (67-editor-view.css "SHARED TOKEN PALETTE"). Used by the CM editor via
 * syntaxHighlighting() AND by the preview widget's static Code view via
 * highlightCodeToLines(), so both surfaces classify and color tokens
 * identically — same parser, same highlighter, same CSS.
 */
function buildAppHighlighter(cm) {
    const t = cm.tags;
    // tagHighlighter matches child tags via each tag's parent set, so base
    // tags cover their whole family (controlKeyword → keyword, etc.).
    return cm.tagHighlighter([
        { tag: [t.keyword, t.meta], class: 'tok-keyword' },
        { tag: [t.string, t.regexp, t.attributeName], class: 'tok-string' },
        { tag: [t.number, t.bool, t.atom], class: 'tok-number' },
        { tag: t.comment, class: 'tok-comment' },
        // Bare t.propertyName needs its own rule. The parent-set lookup only
        // walks UP (t.null → t.keyword is covered by the keyword rule above),
        // so t.function(t.propertyName) below matches function-valued keys and
        // nothing else. JSON tags every object key as plain propertyName, whose
        // parent is t.name — which no rule claims — so keys rendered unstyled.
        { tag: t.propertyName, class: 'tok-property' },
        { tag: [t.function(t.variableName), t.function(t.propertyName), t.heading], class: 'tok-function' },
        { tag: [t.typeName, t.className, t.namespace], class: 'tok-type' },
        { tag: t.tagName, class: 'tok-tag' },
        { tag: [t.link, t.url], class: 'tok-link' },
        { tag: t.emphasis, class: 'tok-emphasis' },
        { tag: t.strong, class: 'tok-strong' },
        { tag: t.invalid, class: 'tok-invalid' }
    ]);
}

/**
 * Highlight a whole file with the shared highlighter. Returns
 * { lines, folds } — one HTML string per line (escaped, tokens wrapped in
 * .tok-* spans) plus the same fold ranges the editor's foldGutter derives
 * ([{ start, end }] in 1-based line numbers, end = last hidden line) — or
 * null when the language has no CM parser (caller falls back to hljs).
 * Used by the preview widget's Code view for exact render parity with Edit.
 */
export async function highlightCodeToLines(content, language) {
    // Very large files: skip the full-file parse, keep the cheap fallback
    if (!content || content.length > 1_500_000) return null;
    try {
        const cm = await loadCodeMirror();
        const ext = getLanguageExtension(cm, language);
        if (!ext.length) return null;
        const lang = ext[0];

        // Headless EditorState: one parse feeds BOTH highlighting and fold
        // ranges, and foldable() consults the language's own fold metadata —
        // identical results to the editor's fold gutter.
        const state = cm.EditorState.create({ doc: content, extensions: [lang] });
        const tree = cm.ensureSyntaxTree(state, content.length, 5000)
            || (lang.language || lang).parser.parse(content);

        const lines = [];
        let cur = '';
        cm.highlightCode(content, tree, cm.appHighlighter,
            (text, classes) => {
                cur += classes
                    ? `<span class="${classes}">${escapeHtml(text)}</span>`
                    : escapeHtml(text);
            },
            () => { lines.push(cur); cur = ''; });
        lines.push(cur);

        const folds = [];
        for (let i = 1; i <= state.doc.lines; i++) {
            const line = state.doc.line(i);
            const range = syntaxFoldAt(cm, state, tree, line.from, line.to);
            if (!range) continue;
            const endLine = state.doc.lineAt(range.to);
            // If the fold stops mid-line (e.g. before a closing brace), that
            // line stays visible — hide only the fully-contained lines.
            const end = range.to >= endLine.to ? endLine.number : endLine.number - 1;
            if (end > i) folds.push({ start: i, end });
        }

        return { lines, folds };
    } catch (e) {
        debug.log('[EditorView] highlightCodeToLines failed:', e);
        return null;
    }
}

/**
 * Fold range for the line [lineStart, lineEnd] — a port of
 * @codemirror/language's syntaxFolding() that takes the tree explicitly.
 * The stock foldable() reads syntaxTree(state), which on a headless state is
 * a creation-time snapshot (only the first parse chunk); ensureSyntaxTree's
 * full tree never reaches it without a view dispatch. Walking our own full
 * tree yields the same ranges the editor's foldGutter shows.
 */
function syntaxFoldAt(cm, state, tree, lineStart, lineEnd) {
    if (!tree || tree.length < lineEnd) return null;
    let found = null;
    for (let iter = tree.resolveStack(lineEnd, 1); iter; iter = iter.next) {
        const cur = iter.node;
        if (cur.to <= lineEnd || cur.from > lineEnd) continue;
        if (found && cur.from < lineStart) break;
        const prop = cur.type.prop(cm.foldNodeProp);
        if (prop) {
            const value = prop(cur, state);
            if (value && value.from <= lineEnd && value.from >= lineStart && value.to > lineEnd) {
                found = value;
            }
        }
    }
    return found;
}

/**
 * Get language extension for a given language name
 */
function getLanguageExtension(cm, language) {
    const langFn = cm.languages[language];
    if (!langFn) return [];

    // Special case for TypeScript/JSX
    if (language === 'typescript') {
        return [langFn({ typescript: true })];
    }
    if (language === 'javascript') {
        return [langFn({ jsx: true })];
    }

    return [langFn()];
}

/**
 * Create a custom search panel: two rows (search / replace) with icon
 * buttons and pill toggles instead of the stock native checkboxes. The
 * replace row is collapsed by default; the leading chevron (or opening via
 * openSearch({ replace: true })) expands it.
 */
function createSearchPanel(view) {
    const cm = cmModules;
    if (!cm) return { dom: document.createElement('div') };

    const ICONS = {
        chevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>',
        up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>',
        down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>',
        close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
    };

    const dom = document.createElement('div');
    dom.className = 'cm-search cm-panel';

    // ── Row 1: search ──────────────────────────────────────────────────
    const searchRow = document.createElement('div');
    searchRow.className = 'cm-search-row cm-search-main';

    // Expand/collapse chevron for the replace row
    const expandBtn = document.createElement('button');
    expandBtn.className = 'cm-search-icon-btn cm-search-expand';
    expandBtn.innerHTML = ICONS.chevronRight;
    expandBtn.setAttribute('data-tooltip', S.editor.search.toggle_replace);

    const searchField = document.createElement('input');
    searchField.className = 'cm-textfield';
    searchField.name = 'search';
    searchField.placeholder = S.editor.search.find_placeholder;
    searchField.setAttribute('main-field', 'true');
    searchField.setAttribute('autocomplete', 'off');

    // Match count display
    const countSpan = document.createElement('span');
    countSpan.className = 'cm-search-count';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'cm-search-icon-btn';
    prevBtn.innerHTML = ICONS.up;
    prevBtn.setAttribute('data-tooltip', S.editor.search.prev_tooltip);

    const nextBtn = document.createElement('button');
    nextBtn.className = 'cm-search-icon-btn';
    nextBtn.innerHTML = ICONS.down;
    nextBtn.setAttribute('data-tooltip', S.editor.search.next_tooltip);

    // Pill toggles (match case / regexp) — styled buttons, not checkboxes
    const caseBtn = document.createElement('button');
    caseBtn.className = 'cm-search-toggle';
    caseBtn.name = 'case';
    caseBtn.textContent = 'Aa';
    caseBtn.setAttribute('data-tooltip', S.editor.search.match_case);

    const reBtn = document.createElement('button');
    reBtn.className = 'cm-search-toggle';
    reBtn.name = 're';
    reBtn.textContent = '.*';
    reBtn.setAttribute('data-tooltip', S.editor.search.regexp);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'cm-search-icon-btn cm-search-close';
    closeBtn.name = 'close';
    closeBtn.innerHTML = ICONS.close;
    closeBtn.setAttribute('data-tooltip', S.editor.search.close_tooltip);

    searchRow.appendChild(expandBtn);
    searchRow.appendChild(searchField);
    searchRow.appendChild(countSpan);
    searchRow.appendChild(prevBtn);
    searchRow.appendChild(nextBtn);
    searchRow.appendChild(caseBtn);
    searchRow.appendChild(reBtn);
    searchRow.appendChild(closeBtn);

    // ── Row 2: replace (hidden until expanded) ─────────────────────────
    const replaceRow = document.createElement('div');
    replaceRow.className = 'cm-search-row cm-search-replace-row';

    const replaceField = document.createElement('input');
    replaceField.className = 'cm-textfield';
    replaceField.name = 'replace';
    replaceField.placeholder = S.editor.search.replace_placeholder;
    replaceField.setAttribute('autocomplete', 'off');

    const replaceBtn = document.createElement('button');
    replaceBtn.className = 'cm-button';
    replaceBtn.textContent = S.editor.search.replace_btn;

    const replaceAllBtn = document.createElement('button');
    replaceAllBtn.className = 'cm-button';
    replaceAllBtn.textContent = S.editor.search.replace_all_btn;

    replaceRow.appendChild(replaceField);
    replaceRow.appendChild(replaceBtn);
    replaceRow.appendChild(replaceAllBtn);

    dom.appendChild(searchRow);
    dom.appendChild(replaceRow);

    expandBtn.addEventListener('click', () => {
        const visible = dom.classList.toggle('replace-visible');
        if (visible) {
            replaceField.focus();
        } else {
            searchField.focus();
        }
    });

    // Count matches helper
    function countMatches() {
        const query = cm.getSearchQuery(view.state);
        if (!query.valid) {
            countSpan.textContent = '';
            return;
        }

        let count = 0;
        let currentMatch = 0;
        const cursor = query.getCursor(view.state.doc);
        const selection = view.state.selection.main;

        while (!cursor.next().done) {
            count++;
            // Check if this match contains the cursor position
            if (cursor.value.from <= selection.from && cursor.value.to >= selection.from) {
                currentMatch = count;
            }
        }

        if (count === 0) {
            countSpan.textContent = S.editor.search.no_results;
            countSpan.classList.add('no-results');
        } else {
            countSpan.textContent = currentMatch > 0 ? `${currentMatch} of ${count}` : `${count} found`;
            countSpan.classList.remove('no-results');
        }
    }

    const caseOn = () => caseBtn.classList.contains('active');
    const reOn = () => reBtn.classList.contains('active');

    // Update query from inputs
    function updateQuery() {
        const query = new cm.SearchQuery({
            search: searchField.value,
            caseSensitive: caseOn(),
            regexp: reOn()
        });
        view.dispatch({ effects: cm.setSearchQuery.of(query) });
        countMatches();
    }

    // Initialize from current query
    function syncFromState() {
        const query = cm.getSearchQuery(view.state);
        searchField.value = query.search || '';
        caseBtn.classList.toggle('active', query.caseSensitive);
        reBtn.classList.toggle('active', query.regexp);
        countMatches();
    }

    // Event handlers
    searchField.addEventListener('input', updateQuery);
    searchField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) {
                cm.findPrevious(view);
            } else {
                cm.findNext(view);
            }
            setTimeout(countMatches, 10);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cm.closeSearchPanel(view);
        }
    });

    replaceField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            // Replace and find next
            const query = cm.getSearchQuery(view.state);
            if (query.valid) {
                view.dispatch({
                    effects: cm.setSearchQuery.of(new cm.SearchQuery({
                        search: searchField.value,
                        replace: replaceField.value,
                        caseSensitive: caseOn(),
                        regexp: reOn()
                    }))
                });
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cm.closeSearchPanel(view);
        }
    });

    caseBtn.addEventListener('click', () => {
        caseBtn.classList.toggle('active');
        updateQuery();
    });
    reBtn.addEventListener('click', () => {
        reBtn.classList.toggle('active');
        updateQuery();
    });

    prevBtn.addEventListener('click', () => {
        cm.findPrevious(view);
        setTimeout(countMatches, 10);
    });

    nextBtn.addEventListener('click', () => {
        cm.findNext(view);
        setTimeout(countMatches, 10);
    });

    replaceBtn.addEventListener('click', () => {
        // Update query with replace value first
        const query = new cm.SearchQuery({
            search: searchField.value,
            replace: replaceField.value,
            caseSensitive: caseOn(),
            regexp: reOn()
        });
        view.dispatch({ effects: cm.setSearchQuery.of(query) });
        cm.replaceNext(view);
        setTimeout(countMatches, 10);
    });

    replaceAllBtn.addEventListener('click', () => {
        // Update query with replace value first
        const query = new cm.SearchQuery({
            search: searchField.value,
            replace: replaceField.value,
            caseSensitive: caseOn(),
            regexp: reOn()
        });
        view.dispatch({ effects: cm.setSearchQuery.of(query) });
        cm.replaceAll(view);
        setTimeout(countMatches, 10);
    });

    closeBtn.addEventListener('click', () => {
        cm.closeSearchPanel(view);
    });

    // Initialize
    syncFromState();

    return {
        dom,
        top: true,
        mount() {
            // openSearch({ replace: true }) stamps this flag before opening
            if (view.dom._searchWantReplace) {
                view.dom._searchWantReplace = false;
                dom.classList.add('replace-visible');
                replaceField.focus();
                return;
            }
            searchField.focus();
            searchField.select();
        }
    };
}

/**
 * CodeMirror editor wrapper
 */
export class CodeEditor {
    constructor(container, options = {}) {
        this.container = container;
        this.options = options;
        this.view = null;
        this.isLoading = false;
        this.content = options.content || '';
        this.language = options.language || 'text';
        this.readOnly = options.readOnly !== false;  // Default to read-only
        this.lineWrapping = !!options.lineWrapping;
        this.wrapCompartment = null;
        this.onChangeCallback = options.onChange || null;
    }

    /**
     * Initialize the editor (loads CodeMirror if needed)
     */
    async init() {
        if (this.view) return this.view;
        if (this.isLoading) return null;

        this.isLoading = true;

        try {
            // Show loading state
            this.container.innerHTML = `<div class="cm-loading">${S.editor.loading}</div>`;

            const cm = await loadCodeMirror();

            // Clear loading state
            this.container.innerHTML = '';

            // Compartment for live-reconfigurable line wrapping
            this.wrapCompartment = new cm.Compartment();

            // Build extensions
            const extensions = [
                this.wrapCompartment.of(this.lineWrapping ? cm.EditorView.lineWrapping : []),
                cm.lineNumbers(),
                cm.highlightActiveLineGutter(),
                cm.highlightSpecialChars(),
                cm.history(),
                cm.foldGutter(),
                cm.drawSelection(),
                cm.dropCursor(),
                cm.EditorState.allowMultipleSelections.of(true),
                cm.indentOnInput(),
                cm.syntaxHighlighting(cm.appHighlighter),
                cm.bracketMatching(),
                cm.closeBrackets(),
                cm.rectangularSelection(),
                cm.crosshairCursor(),
                cm.highlightActiveLine(),
                cm.highlightSelectionMatches(),
                cm.search({ createPanel: createSearchPanel }),  // Custom search panel with match count
                cm.keymap.of([
                    cm.indentWithTab,
                    // Comment toggles — Mod-/ = Ctrl/Cmd+/ (line comment, the
                    // universal editor consensus); Shift-Alt-A = block comment.
                    { key: 'Mod-/', run: cm.toggleComment },
                    { key: 'Shift-Alt-a', run: cm.toggleBlockComment },
                    ...cm.closeBracketsKeymap,
                    ...cm.defaultKeymap,
                    ...cm.searchKeymap,
                    ...cm.historyKeymap,
                    ...cm.foldKeymap
                ]),
                cm.appTheme,
                // Language extension
                ...getLanguageExtension(cm, this.language)
            ];

            // Read-only mode
            if (this.readOnly) {
                extensions.push(cm.EditorState.readOnly.of(true));
                extensions.push(cm.EditorView.editable.of(false));
            }

            // Change listener
            if (this.onChangeCallback) {
                extensions.push(cm.EditorView.updateListener.of((update) => {
                    if (update.docChanged) {
                        this.onChangeCallback(update.state.doc.toString());
                    }
                }));
            }

            // Create the editor
            this.view = new cm.EditorView({
                state: cm.EditorState.create({
                    doc: this.content,
                    extensions
                }),
                parent: this.container
            });

            this.isLoading = false;
            return this.view;

        } catch (error) {
            console.error('[EditorView] Failed to load CodeMirror:', error);
            this.isLoading = false;
            this.container.innerHTML = `<div class="cm-error">${S.editor.load_failed.replace('{error}', error.message)}</div>`;
            throw error;
        }
    }

    /**
     * Update editor content
     */
    setContent(content, language = null) {
        this.content = content;
        if (language) this.language = language;

        if (this.view) {
            // Update content
            this.view.dispatch({
                changes: {
                    from: 0,
                    to: this.view.state.doc.length,
                    insert: content
                }
            });

            // If language changed, we need to recreate with new extensions
            // For now, just update content - language change would require reinit
        }
    }

    /**
     * Get current content
     */
    getContent() {
        if (this.view) {
            return this.view.state.doc.toString();
        }
        return this.content;
    }

    /**
     * Scroll to a specific line
     */
    scrollToLine(lineNumber) {
        if (!this.view || !cmModules) return;

        const line = this.view.state.doc.line(Math.min(lineNumber, this.view.state.doc.lines));
        this.view.dispatch({
            effects: cmModules.EditorView.scrollIntoView(line.from, { y: 'start' })
        });
    }

    /**
     * Set read-only mode
     */
    setReadOnly(readOnly) {
        this.readOnly = readOnly;
        // Would need to reconfigure - for Phase 5
    }

    /**
     * Toggle line wrapping at runtime (no editor reload)
     */
    setLineWrapping(enabled) {
        this.lineWrapping = !!enabled;
        if (this.view && this.wrapCompartment && cmModules) {
            this.view.dispatch({
                effects: this.wrapCompartment.reconfigure(
                    this.lineWrapping ? cmModules.EditorView.lineWrapping : []
                )
            });
        }
    }

    /**
     * Focus the editor
     */
    focus() {
        if (this.view) {
            this.view.focus();
        }
    }

    /**
     * Open the search panel (Cmd+F / Ctrl+F).
     * @param {object} options
     * @param {boolean} options.replace - Also expand + focus the replace row
     */
    openSearch({ replace = false } = {}) {
        if (!this.view || !cmModules) return;

        const panel = this.view.dom.querySelector('.cm-panel.cm-search');
        if (panel) {
            // Already open — just (re)focus the right field
            if (replace) panel.classList.add('replace-visible');
            const field = panel.querySelector(replace ? 'input[name="replace"]' : 'input[name="search"]');
            if (field) {
                field.focus();
                field.select?.();
            }
            return;
        }

        this.view.dom._searchWantReplace = replace;
        cmModules.openSearchPanel(this.view);
    }

    /**
     * Close the search panel and refocus editor
     */
    closeSearch() {
        if (this.view && cmModules) {
            cmModules.closeSearchPanel(this.view);
            this.view.focus();
        }
    }

    /**
     * Check if the search panel is currently open
     */
    isSearchOpen() {
        return !!this.view?.dom?.querySelector('.cm-search');
    }

    /**
     * Find next match (Cmd+G)
     */
    findNext() {
        if (this.view && cmModules) {
            cmModules.findNext(this.view);
        }
    }

    /**
     * Find previous match (Cmd+Shift+G)
     */
    findPrevious() {
        if (this.view && cmModules) {
            cmModules.findPrevious(this.view);
        }
    }

    /**
     * Destroy the editor
     */
    destroy() {
        if (this.view) {
            this.view.destroy();
            this.view = null;
        }
        this.container.innerHTML = '';
    }
}

/**
 * Check if CodeMirror is already loaded
 */
export function isCodeMirrorLoaded() {
    return cmModules !== null;
}

/**
 * Preload CodeMirror (can be called early to reduce first-open latency)
 */
export async function preloadCodeMirror() {
    return loadCodeMirror();
}
