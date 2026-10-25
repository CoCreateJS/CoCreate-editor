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

DOM editors also expose `setAttribute`, which edits the canonical HTML source
and renders the result through the normal update path:

```js
await domEditor.editor.setAttribute({
    target: domEditor.querySelector(".widget"),
    name: "style",
    value: "width: 240px; color: rebeccapurple"
});

await domEditor.editor.setAttribute({
    target: domEditor.querySelector(".widget"),
    name: "aria-label",
    value: "Resizable widget"
});

await domEditor.editor.setAttribute({
    target: domEditor.querySelector(".widget"),
    name: "title",
    value: null // Remove the attribute.
});
```

The target must belong to that editor and have a current source position. The
method matches a complete attribute name within the target's opening tag,
preserves other source text, and escapes the value for a quoted HTML attribute.
Pass the complete new value for attributes such as `style`.

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
