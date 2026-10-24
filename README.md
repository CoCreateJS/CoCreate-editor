# CoCreate Editor

One canonical source string, native text fields, and contenteditable rendering for
plain text, Markdown, or HTML. Markdown and HTML remain separate source formats.

## Initialize

```html
<div contenteditable="true">Plain text by default</div>
<div editor="markdown" placeholder="Write Markdown"></div>
<div editor="html" placeholder="Write HTML"></div>
<input editor="text" value="Optional native adapter" />
<textarea editor="text">Native multiline text</textarea>
```

Contenteditable elements initialize automatically without CRDT. `editor="text"`
is the default; `markdown` and `html` select their renderer. Explicit `editor`
attributes activate editable surfaces without generating nested containers.
Native inputs and textareas stay ordinary browser controls unless explicitly
marked `editor="text"` or `crdt="true"`. Supported input types are text, search,
tel, url, email, and password. Native fields always edit literal text. Unsupported
controls such as number, checkbox, and file inputs are left alone.

Use `CoCreate.editor` and `editor="text|markdown|html"`. `editor-placeholder="false"`
disables the surface placeholder. Build outputs are `CoCreate-editor.js/.css` and
`CoCreate-editor.min.js/.css`; the package is `@cocreate/editor`. The component lives
in `CoCreate-modules/CoCreate-editor`. The GitLab repository is
[CoCreate Editor](https://gitlab.com/cocreatejs/CoCreate-editor).

Initialization reads existing component storage or a custom `getValue()`.
Plain-text DOM hosts start from `textContent`, without serializing HTML entities.
Newer writes win over asynchronous initial reads. `getValue()`, `getValueAsync()`,
and `.value` expose canonical text. `setValue(source)` updates it; its optional
second argument `true` emits `input`. Native `.value` retains normal browser
behavior: use `setValue()` or dispatch `input` to synchronize programmatic changes.
Native form reset also updates the binding.

Dynamic hosts and changes to `editor` or binding attributes are observed. Changing
format reinterprets the source without converting it. `readonly`/`disabled` disable
editable surfaces at initialization. `editor-placeholder="false"` disables their
placeholder. Surrounding application components own toolbars.

## Optional CRDT

```html
<div editor="markdown" crdt="true" array="messages" object="message-id" key="body"></div>
<textarea crdt="true" array="messages" object="message-id" key="body"></textarea>
```

These two elements share the same serialized source, with different projections.
Only explicit `crdt="true"` plus valid `array`, `object`, and `key` values activates
collaboration. Local editing works without a CRDT engine. Pending object IDs wait
for their real ID. Changing identity detaches the old binding; disabling CRDT leaves
local editing active.

The `@cocreate/crdt` dependency is loaded only when needed, or an existing
`CoCreate.crdt` engine is reused. Applications may provide it with
`editor.setCrdt(engine)`. The engine owns convergence, persistence, shared selection
references, and collaborative undo/redo. The adapter sends UTF-16 source splices,
rebases queued local edits over incoming source updates, and updates other bound
fields without rebroadcasting remote edits. Initial loading also retains local edits.
`read`, `save`, `crud`, `namespace`, and `room` are passed through to the engine.
CRDT errors emit `editor-error`; failed pending writes are retained in memory and
require resolving the engine/connection error and rebinding before sending again.

CoCreate Text yields listeners and DOM updates to claimed editor fields, avoiding
duplicate handling. Iframe editor hosts use the inner document surface rather than attaching duplicate
CoCreate Text handlers. Surface selection uses its owning document/window. Remote cursor UI remains
an application/cursors-component concern; the editor publishes source selections.

Call `destroy(element)` before permanently removing a host to release listeners
and collaboration bindings. It restores the previous value API and host attributes.

## Iframe documents

```html
<iframe editor="html" title="Page editor"></iframe>
```

```js
const editorInstance = await editor.create(frame);
frame.setValue('<!doctype html><html><head><title>Page</title></head><body><p>Edit here</p></body></html>');
const source = frame.getValue();
const doc = editorInstance.document; // frame.contentDocument
const surface = editorInstance.host; // doc.documentElement (<html>)
```

The iframe is the public reference. Its Document owns the live `<html>`, `<head>`,
and `<body>` structure; only the `<html>` element receives `contenteditable`.
Same-origin access is required. `iframe[contenteditable]` and `iframe[crdt="true"]`
also initialize; iframe source mode is HTML. Native inputs and textareas inside the
page keep their native behavior. No editable wrapper is generated inside the frame.

Source initializes from component/custom value storage, exact `srcdoc` text, or the
current document if neither is supplied. Subsequent editing retains the canonical
string, including doctype spelling, tag spelling, and attributes, without repeatedly
serializing the live DOM. Detached rendering creates a staging Document. Healing
patches the live document while retaining its `<html>` reference and matching
subtrees. Body text edits preserve head content and doctype; head/style content is
excluded from the editable text projection. Source selections include the complete
HTML prefix rather than starting at the body.

Iframe `getValue`, `setValue`, source operations, local history, and optional CRDT
use the same public APIs. Each native inner input edit is published on the iframe
reference. A frame load reconnects listeners and renders the current source into
the new accessible Document; `editorInstance.document` and `.host` follow it.
`editor-document-change` reports the new document and surface. Destroy detaches
editing and restores the previous editing attributes while retaining the document.

Nested surfaces remain a simple ownership boundary. Parent input, paste,
composition, and undo handling ignore native controls and explicit nested
`contenteditable`/`editor` surfaces, including elements with their own
`array`/`object`/`key`. The parent also checks the selection because browsers may
target input at the outer body. Nested surfaces are atomic in the parent's text
projection. Healing preserves their live contents and handlers when their structural
identity remains the same. Their source template stays in the parent source string;
live field values belong to the nested component. This renderer does not initialize
nested components on the parent's behalf.

Staging Documents are detached and have no live window. Their nodes are not passed
to component initialization observers. Each staging render derives from canonical
source, so runtime field changes do not alter the skeleton. The current skeleton is
retained on the editor; new live nodes are cloned with their source maps rather
than moved out of it. More precise insertion
and text patch strategies can evolve independently of these ownership rules.

HTML void element names are centralized in `src/config.js` as `voidElements`:
area, base, br, col, embed, hr, img, input, link, meta, param, source, track, and wbr.
They receive source ranges and an atomic projection marker, never consume a closing
tag, and accept both `<br>` and `<br />` without rewriting the source. Full-document
mode also supports structural, layout, head, form, and table tags. The existing
balanced-tag parser remains in use; this is not full HTML5 error recovery or a test
of every website-builder interaction. Code/pre contents remain literal. Generated
script projections are inert; event-handler attributes are omitted from the live
projection while their original source text is retained.

## Editing and healing

Native `input` drives editing without intercepting `beforeinput`. A projection
maps visible characters to source ranges. This includes HTML entities: one visible
`&` can address the entire `&amp;` source range. Source edits render into a detached
element, then reconciliation patches the live div while preserving matching nodes.
`heal(element)` explicitly repairs live DOM from canonical text. A completed edit
bubbles one input event from the original host. Blur emits `change`; initialization
emits `editor-ready` or `editor-error`.

Composition remains in live DOM until `compositionend`. Programmatic source writes
or type changes during composition take effect when it finishes. Ctrl/Cmd+Z,
Shift+Ctrl/Cmd+Z, and Ctrl/Cmd+Y use collaborative history when bound, otherwise a 100-entry local source history, one
entry per input event. Programmatic source writes clear local undo history. Paste
uses plain text as source: Markdown in Markdown mode, HTML in HTML mode.

Enter is normalized to a literal `\n` in both source formats, including while a
syntax match or quoted HTML attribute is unfinished. It never saves browser-created
paragraph wrappers or placeholder breaks. In Markdown mode a single newline is a
visible soft line break in the editor; a blank line separates paragraphs. In HTML
mode newlines remain text, and explicitly typed `<br>` is a separate source token
that renders a break. Any break nodes needed for caret placement are projection
artifacts only. A future toolbar can insert the chosen source syntax explicitly.

## Shared syntax configuration

`src/config.js` is the shared definition list. Each definition declares a rendered
`tag` (or trusted `create(match)` callback), plus optional `markdown` and `html`
sections. An absent section means that definition does not match in that language.

```js
const remove = editor.addSyntax({
    name: 'highlight',
    tag: 'mark',
    markdown: {
        scope: 'inline',
        pattern: /%%(.+?)%%/g,
        content: match => match[1],
        offset: () => 2
    },
    html: { tags: ['highlight'] }
});
// Markdown source: %%hello%%
// HTML source: <highlight>hello</highlight>
// Both project to <mark>hello</mark> in their respective modes.
```

Markdown sections define a regex, content(match), and offset(match) for a contiguous
source substring. `scope: 'block'` supports custom single-line blocks. Built-in block
kinds supply structural consumption for headings, lists, quotes, and fences.
HTML sections list accepted source tag names in `tags`. HTML parsing handles nested
paired tags, quoted attributes, entities, and configured void elements. Complete
allowed tags render; unsupported or unfinished markup stays visible as text.

`addSyntax()` inserts a custom definition ahead of ordinary defaults and returns a
removal function. `updateSyntax(name, definition)` replaces a definition's language
sections and output. Updating or removing definitions automatically refreshes active
editors from source, preserving selection. The earlier flat Markdown-only
`addSyntax({pattern, content, offset, tag, name})` shape still works. Treat the
exported `syntaxRules` list as read-only; use these APIs to notify active editors.

Code boundaries are protected independently of configurable rule precedence.
Markdown code spans (including unfinished spans) and fenced code blocks exclude
other matches. HTML `<code>` and `<pre>` contents are literal, including unfinished
regions. Entities in HTML code decode for display but retain their original source
ranges. Nested HTML tags inside code/pre are displayed as text. Custom definitions
cannot replace the reserved code/fence rules or claim their HTML tag names.

HTML attributes default to class/title; links also accept href. A definition's
`html.attributes` can opt into additional supported attributes. The shared attribute
policy accepts class, title, role, rel, ARIA/data attributes, and safe link hrefs;
event handlers, styles, and internal mapping attributes are excluded. Links allow
HTTP, HTTPS, and mailto. Trusted create callbacks should return the wrapper for
mapped content; use delegated events because reconciliation preserves live nodes.

## JavaScript and source operations

```js
import editor from '@cocreate/editor';
await editor.create(element);
element.setValue('**Hello**');
const source = element.getValue();
const markdownHTML = editor.render('**Hello**', 'markdown');
const htmlProjection = editor.render('<strong>Hello</strong>', 'html');
editor.heal(element);
```

`setRenderer(parser)` optionally supplies a separate `render(source)` implementation
for the public Markdown-to-HTML function only; editable surfaces use mapped language
renderers. HTML-mode public rendering always uses the configured HTML projection.

All positions are UTF-16 offsets in canonical source, not DOM or ProseMirror indexes:

- `getSelection(element)` returns `{anchor, head, from, to, empty, type}`.
- `setSelection(element, anchor, head = anchor)` places a source selection.
- `insert(element, source)` replaces the selection.
- `insertPos(element, source, position)` inserts at a source offset.
- `replaceRange(element, source, {from, to})` replaces a source range.

Positions inside hidden syntax or entities normalize to adjacent visible positions.
`create()` resolves to `{element, host}`; ordinary surfaces use `host === element`, while iframes use their document element. Rendered surfaces also expose `staging()`; native fields do not create staging DOM.

`sourceChange(before, after)` computes `{start, length, value}`. `applySourceChange`
applies a source splice. `applyChange(element, change)` accepts a canonical
`change.string` or a splice and updates silently. The optional CRDT binding uses these source coordinates for broadcasting and remote updates.

## Current scope

Markdown supports paragraphs, headings, flat lists, blockquotes, fenced code,
horizontal rules, links, inline code, strong text, emphasis, and custom rules.
Nested lists, tables, images, reference links, complex emphasis, and full
CommonMark/GFM conformance remain future work. HTML supports the configured small
element set rather than a complete browser HTML parser; malformed markup stays
literal where unmatched. Neither language changes the other's source syntax.

`demo/index.html` demonstrates plain text, Markdown, HTML, native text fields, and
iframe document editing.

## Build and tests

`npm install`, then `npm start` produces development files for the demo.
`npm run build` produces minified JS/CSS. Browser tests run with `npm test` after
`npx playwright-core install chromium`. `CHROMIUM_PATH` can select an existing
browser; `PLAYWRIGHT_MODULE` can select an external Playwright installation.
