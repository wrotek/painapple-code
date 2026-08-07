// Build entry for src/painapple_code/static/vendor/codemirror.js — bundled by `npm run build:codemirror`.
// Mirrors the imports previously made from esm.sh in static/js/editor-view.js.
// Re-exporting via named exports keeps the bundle tree-shakeable if a caller
// switches to selective imports later.

export {
    EditorView,
    keymap,
    lineNumbers,
    highlightActiveLine,
    highlightActiveLineGutter,
    drawSelection,
    dropCursor,
    rectangularSelection,
    crosshairCursor,
    highlightSpecialChars
} from '@codemirror/view';

export { EditorState, Compartment } from '@codemirror/state';

export {
    defaultHighlightStyle,
    syntaxHighlighting,
    indentOnInput,
    bracketMatching,
    foldGutter,
    foldKeymap,
    // Headless fold-range computation for the preview widget's Code view
    // (highlightCodeToLines in editor-view.js) — same ranges the editor's
    // foldGutter derives, so preview fold arrows match Edit mode exactly.
    // foldNodeProp (not foldable()) because foldable reads syntaxTree(state),
    // which is a creation-time snapshot: ensureSyntaxTree's full tree never
    // reaches it without a view dispatch, so we walk the full tree ourselves.
    foldNodeProp,
    ensureSyntaxTree
} from '@codemirror/language';

// Lezer highlight primitives — editor-view.js builds the app's shared
// tagHighlighter from these (used by BOTH the CM editor and the preview
// widget's static Code view via highlightCodeToLines, so token classes
// match by construction).
import { tags } from '@lezer/highlight';
export { tags };
export { tagHighlighter, highlightCode } from '@lezer/highlight';

import { StreamLanguage } from '@codemirror/language';

export {
    defaultKeymap,
    history,
    historyKeymap,
    indentWithTab,
    // Comment commands — bound to Mod-/ and Shift-Alt-A in editor-view.js
    // (CM6 does not ship a pre-made commentKeymap array).
    toggleComment,
    toggleBlockComment
} from '@codemirror/commands';

export { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';

export {
    search,
    searchKeymap,
    highlightSelectionMatches,
    openSearchPanel,
    closeSearchPanel,
    getSearchQuery,
    findNext,
    findPrevious,
    setSearchQuery,
    SearchQuery,
    replaceNext,
    replaceAll
} from '@codemirror/search';

export { javascript } from '@codemirror/lang-javascript';
export { python } from '@codemirror/lang-python';
export { html } from '@codemirror/lang-html';
export { css } from '@codemirror/lang-css';
export { json } from '@codemirror/lang-json';
export { markdown } from '@codemirror/lang-markdown';
export { sql } from '@codemirror/lang-sql';
export { rust } from '@codemirror/lang-rust';
export { cpp } from '@codemirror/lang-cpp';
export { java } from '@codemirror/lang-java';
export { php } from '@codemirror/lang-php';
export { xml } from '@codemirror/lang-xml';
export { yaml } from '@codemirror/lang-yaml';

// Languages without a first-class @codemirror/lang-* package use the ported
// CM5 stream parsers from @codemirror/legacy-modes. Each is wrapped as a
// zero-arg factory so editor-view.js can call them like the lang-* functions
// above (cm.languages[lang]() → Extension).
import { shell as shellMode } from '@codemirror/legacy-modes/mode/shell';
import { ruby as rubyMode } from '@codemirror/legacy-modes/mode/ruby';
import { go as goMode } from '@codemirror/legacy-modes/mode/go';
import { swift as swiftMode } from '@codemirror/legacy-modes/mode/swift';
import { csharp as csharpMode, scala as scalaMode, kotlin as kotlinMode } from '@codemirror/legacy-modes/mode/clike';
import { dockerFile as dockerfileMode } from '@codemirror/legacy-modes/mode/dockerfile';
import { nginx as nginxMode } from '@codemirror/legacy-modes/mode/nginx';
import { toml as tomlMode } from '@codemirror/legacy-modes/mode/toml';
import { properties as propertiesMode } from '@codemirror/legacy-modes/mode/properties';

export const shell = () => StreamLanguage.define(shellMode);
export const ruby = () => StreamLanguage.define(rubyMode);
export const go = () => StreamLanguage.define(goMode);
export const swift = () => StreamLanguage.define(swiftMode);
export const csharp = () => StreamLanguage.define(csharpMode);
export const scala = () => StreamLanguage.define(scalaMode);
export const kotlin = () => StreamLanguage.define(kotlinMode);
export const dockerfile = () => StreamLanguage.define(dockerfileMode);
export const nginx = () => StreamLanguage.define(nginxMode);
export const toml = () => StreamLanguage.define(tomlMode);

// .env / .properties / .ini: the CM5 properties mode tags keys as "def" (→
// variableName.definition) and values as "quote" (→ an unstyled tag). "def"
// is hardcoded in CodeMirror's default token table, so a StreamParser
// tokenTable can't override it — instead we wrap token() and translate the
// returned token *strings*: keys → "attribute" (→ attributeName, green, the
// same hue the preview's hljs-attr uses) and values → "string" (green). This
// keeps code variable declarations — which also emit "def" in real languages
// — untouched, since only this mode is remapped. Sections stay "header".
function remapTokens(mode, map) {
    return {
        ...mode,
        token(stream, state) {
            const tok = mode.token(stream, state);
            return tok && (map[tok] || tok);
        }
    };
}
const propertiesParser = remapTokens(propertiesMode, { def: 'attribute', quote: 'string' });
export const properties = () => StreamLanguage.define(propertiesParser);
export const env = () => StreamLanguage.define(propertiesParser);
