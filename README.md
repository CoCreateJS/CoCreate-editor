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

Elements initialize automatically. An `editor` or `editor-language` attribute
activates an editor surface; `contenteditable="false"` disables it. Native
inputs and textareas retain their browser editing behavior. Code mode supports
HTML tokens and basic JavaScript tokens; other languages render as plain code text.

Use `editor="code" editor-language="html"` to display literal HTML source with
styleable tag, punctuation, attribute, quote, attribute-value, text, entity,
comment, and doctype spans. Classes use the `code-` prefix, such as `code-tag`
and `code-attribute`. Complete tag syntax creates tokens; unfinished or broken
tags and comments remain literal text until completed. Script and style bodies
remain literal code text. Source HTML is never executed or normalized.

Language definitions live in `src/editors/language/`: `html.js` contains the
HTML scanner and `javascript.js` contains the JavaScript rules. The shared code
renderer and source mapping remain in `src/editors/code.js`.

Change `editor-language` on an initialized code surface to refresh its tokens
immediately. The current source, selection, history, and CRDT binding are retained:

```js
element.setAttribute("editor-language", "javascript");
element.setAttribute("editor-language", "text");
```

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

Build and open `demo/index.html` to try each editor mode and the HTML attribute
API. The browser tests run with Node's test runner:

```sh
yarn build
yarn test
```

The browser tests require `playwright-core` and Chromium. `PLAYWRIGHT_MODULE`
and `CHROMIUM_PATH` can select existing installations.
