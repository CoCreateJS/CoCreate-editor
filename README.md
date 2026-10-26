# CoCreate Editor

CoCreate Editor provides plain text, code, Markdown, and DOM editing from a
canonical source string. DOM, Markdown, and code modes render detached DOM
projections and track source positions on corresponding live elements.

## Modes

```html
<div contenteditable="true">Plain text</div>
<div editor="code" editor-language="javascript">const value = 1;</div>
<div editor="markdown"># Markdown</div>
<div editor="dom" value="&lt;p&gt;HTML source&lt;/p&gt;"></div>
<textarea editor="text">Native text input</textarea>
```

Elements initialize automatically. Plain text is built into the engine. DOM,
Markdown, and code renderers load through dynamic imports when requested by an
element. Code has no default syntax language: an absent or empty
`editor-language`, or `editor-language="text"`, renders plain text. HTML, CSS,
JavaScript, JSON, Python, TypeScript, SQL, Bash, YAML, C, Go, Java, and PHP language
modules load only when explicitly selected. The `js`, `py`, `ts`, and `sh` aliases share their
corresponding language modules; `yml` aliases YAML. Unsupported languages stay
plain text without a request.
Loaded modes and languages are reused across elements.

The public entry watches for editor surfaces and loads `Core.js` only when one
is present, added, or configured. Parser calls load their renderer directly and
do not load the editing core or CRDT. In editing mode, code starts its own
language observer and scans code elements.

## Render source without an editor

Use `CoCreate.editor.render` to turn stored source into detached DOM without
initializing an editable surface. The call is asynchronous because renderers and
languages load on demand. It returns an element for text, Markdown, and code;
DOM mode returns an `HTMLDocument` so full document structure remains available.

```js
const rendered = await CoCreate.editor.render(message.markdown, {
    mode: "markdown"
});
container.replaceChildren(rendered);

const html = rendered.innerHTML;
```

For code, pass the language explicitly. The language is never inferred or loaded
by default:

```js
const renderedCode = await CoCreate.editor.render(source, {
    mode: "code",
    language: "javascript"
});
```

For direct parser APIs, use `parseMarkdown` or `parseCode`. Both resolve to the
same detached DOM containers returned by `render` and can be serialized with
normal DOM properties when needed:

```js
const markdownDOM = await CoCreate.editor.parseMarkdown(message.markdown);
const highlightedDOM = await CoCreate.editor.parseCode(source, "javascript");

const markdownHTML = markdownDOM.innerHTML;
const highlightedHTML = highlightedDOM.outerHTML;
```

`parseCode` defaults to plain text when no language is supplied. Its selected
language is loaded on demand, just as it is when initializing a code editor.

The mode can also be passed as a string, for example
`CoCreate.editor.render(source, "markdown")`. DOM mode returns a document;
access `document.body` to append its rendered body or use
`document.documentElement.outerHTML` to serialize the complete result.

An `editor` or `editor-language` attribute
activates an editor surface; `contenteditable="false"` disables it. Native
inputs and textareas retain their browser editing behavior. Code mode supports
HTML, CSS, JavaScript, JSON, Python, TypeScript, SQL, Bash, YAML, C, Go, Java, and PHP syntax tokens; other languages render as plain code text.

Use `editor="code" editor-language="html"` to display literal HTML source with
styleable tag, punctuation, attribute, quote, attribute-value, text, entity,
comment, and doctype spans. Classes use the `code-` prefix, such as `code-tag`
and `code-attribute`. Complete tag syntax creates tokens; unfinished or broken
tags and comments remain literal text until completed. Script and style bodies
remain literal code text. Source HTML is never executed or normalized.

Language definitions live in `src/editors/language/`: `html.js` contains the
HTML scanner; `css.js`, `javascript.js`, `python.js`, `typescript.js`, `sql.js`,
`bash.js`, `yaml.js`, `c.js`, `go.js`, `java.js`, and `php.js` contain lightweight token rules; and `json.js`
distinguishes object keys, strings, numbers, literals, and punctuation.
The shared code renderer and source mapping remain in `src/editors/code.js`.

Change `editor-language` on an initialized code surface to refresh its tokens
after its language module is ready. The current source, selection, history, and
CRDT binding are retained:

```js
element.setAttribute("editor-language", "javascript");
element.setAttribute("editor-language", "text");
```

Mode and language imports are asynchronous. To initialize an element explicitly
and wait until it is ready:

```js
await CoCreate.editor.initElement(element);
while (element.editor.loading) await element.editor.loading;
```

Loading failures emit `editor-error`. If a mode or language changes while a
module is loading, the latest choice and source take precedence.

The source contains explicit dynamic imports, so consuming projects can build
their own chunks without depending on this repository's `dist` filenames. The
local Webpack build names the mode chunks `editor-dom`, `editor-markdown`, and
`editor-code`, and language chunks `editor-language-html`, `editor-language-css`,
`editor-language-javascript`, `editor-language-json`, `editor-language-python`,
`editor-language-typescript`, `editor-language-sql`, `editor-language-bash`,
`editor-language-yaml`, `editor-language-c`, `editor-language-go`, and
`editor-language-java`, and `editor-language-php`. Serve the entry bundle alongside all generated chunks;
use an HTTP server for the demo.

## Element editor API

Bound editors expose the CRDT methods through `element.editor`:

```js
await element.editor.getText();
await element.editor.updateText({ start: 5, length: 0, value: "!" });
await element.editor.undoText();
await element.editor.redoText();
await element.editor.updateSelection({ selection: { anchor: 0, head: 5 } });
```

Local editors expose `updateText({ start, length, value })`, `undo()`, and
`redo()` using their local source and history.

Rendered live elements expose an `editorDetails` object with their source
boundaries and `liveDOM` / `detachDOM` references. Each record is the same object
stored in the owning editor's `editorDetails` array, sorted by source `start`;
`element.editor.findDetailsByStart(start)` performs a binary-search lookup.
The detached rendered tree stays clean: editor details, source maps, and links
to live nodes are held in `WeakMap`s instead of DOM properties or attributes.

All three modes index their rendered elements and text through the same record
contract and absolute source maps. DOM mode also indexes comments and literal
remnants of broken markup. `element.editor.findDetailsContaining(start, end = start)` finds
the deepest record containing a source range using binary search and parent
record links. `element.editor.findDetailsIndex(start, end = start)` returns its
zero-based index in that same array, or `-1` when no record contains the range.
Subtree selection locates the start/end bounds with binary search, then scans
that slice once using parent-record membership.
The four boundaries distinguish opening tags, content, and
closing tags; damaged wrappers become indexed literal text through their old
source boundary and can become elements again when repaired.

DOM, Markdown, and code updates first produce a shared plan with separate `added`,
`removed`, and `retained` arrays and ordered child sequences. Planning leaves the existing
nodes, position objects, and index unchanged. All removed objects stay in the
plan, including descendants; `removeRoots` identifies the outermost nodes
whose removal removes those descendants. Applying the plan prepares the new
live nodes, removes those roots, updates retained objects, and inserts the
ordered sequences using their stored references. Content edits parse only
the enclosing element. Edits that escape that element's syntax boundary use a
document-wide parse and the same array-driven mutation path. Native input/IME
nodes are collected through mutation-record references and reconciled through
that document plan, without scanning for untracked nodes. Existing DOM trees
are not queried or traversed to discover affected nodes. Retained details and
the editor's array keep their identities; later source offsets and text maps
are shifted as needed. Maintaining these absolute offsets still takes work
proportional to the following records and maps.

Markdown details also carry `definition` (the matched syntax-rule reference),
`syntax` (rule name, completion state, and opening/closing marker ranges), and
one-based `firstLine` / `lastLine` references for the source endpoints. Block
records carry `lines`: source line ranges, numbers, candidate rules, and prefix
markers. Line and marker offsets are relative to their owning record's `start`,
so those references move with the shared record when earlier text shifts.

A Markdown edit looks up the containing record and uses its stored line/block
references to select the parsing boundary. Safe same-line edits parse just that
block. Newline changes, changed structural markers, or syntax escaping that
boundary currently use a full source parse. Both paths build the same completed
record plan before changing either existing tree.

Code tokens retain their language, token category (`token`), matched rule or
custom tokenizer (`definition`), content/delimiter ranges (`syntax`), and line
references. Unhighlighted text is indexed too. Tokenization currently runs over
the full source so multiline and lookahead rules remain correct; unchanged
segments reuse their canonical detached nodes through independent metadata
snapshots. Only changed segments need candidate DOM construction. The common
planner commits the new ranges/maps and updates the existing live nodes.
All three modes now use this record-planning lifecycle; the old tree-based
rendering-update fallback is no longer used.

A mode or code-language change takes a separate full-render path: read the
current canonical value, build a fresh detached tree and live nodes, and replace
the live contents directly. The previous rendering and details index are not
reconciled or reused. The CRDT binding, current text, and undo history remain
intact; pending renders for a previous language cannot overwrite the new one.

Source-backed HTML elements expose attribute helpers on their shared
`editorDetails` object:

```js
const details = selectedElement.editorDetails;
const attributes = details.attributes;       // Array of source attribute records
const attribute = details.getAttribute("class"); // Matching record, or null
await details.setAttribute("class", "card active");
await details.setAttribute("data-label", ""); // Present with an empty value
await details.removeAttribute("data-label");
```

Each record contains `name`, decoded `value`, `rawValue`, `nameStart`, `nameEnd`,
`valueStart`, and `valueEnd`. Positions are absolute UTF-16 offsets in the
canonical source; ends are exclusive and value ranges exclude quotes. Boolean
attributes have `value: ""` and null value positions, while quoted empty values
have equal start/end positions. Records also expose the full attribute range
(`start`, `end`), `whitespaceStart`, `equals`, `quote`, `quoteStart`, and `quoteEnd`.
Attribute names match case-insensitively and source order/duplicate names are
preserved. `getAttributes()` is an alias for reading the `attributes` array.

The parser reads only the selected element's current opening tag. Returned
attribute records are snapshots; retain the shared element details and call its
helpers again when submitting an edit. Set/remove resolve current positions and
send the smallest source replacement through `updateText`, using the existing
local or CRDT binding. Existing spacing and quotes are preserved; unquoted values
are quoted when necessary. Removal deletes all occurrences of a duplicated name.
Stale, foreign, and non-HTML-source records cannot edit another element.

The owning DOM editor exposes the same operations with a target:

```js
const attributes = domEditor.editor.attributes({ target: selectedElement });
const attribute = domEditor.editor.getAttribute({ target: selectedElement, name: "class" });
await domEditor.editor.setAttribute({ target: selectedElement, name: "style", value: "width: 240px" });
await domEditor.editor.removeAttribute({ target: selectedElement, name: "title" });
```

Pass the complete new value for attributes such as `style`. Passing `null` to
`setAttribute` remains an alias for removal. Native element attribute APIs are
unchanged; these source-aware helpers live on the editor/details objects.

Without a valid CRDT binding, edits use local source and local undo/redo history.
Editors with a valid `array`, `object`, and `key` binding use CRDT; add
`realtime="true"` to share edits immediately. Set `crdt="false"` to keep the
editor local.

## Demo and tests

Build and serve `demo/index.html` to start with text and add each editor mode
on demand, inspect its source, or try the DOM attribute API. The demo uses the
production `.min.js` and `.min.css` build. The browser tests run with Node's test runner:

```sh
yarn build
yarn test
```

The browser tests require `playwright-core` and Chromium. `PLAYWRIGHT_MODULE`
and `CHROMIUM_PATH` can select existing installations.
