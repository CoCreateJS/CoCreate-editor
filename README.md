# CoCreate Markdown

A browser plugin for declarative Markdown editing and HTML rendering. Based on
CoCreate-copilot-client's client package layout and extracted from CoCreate-app's
Milkdown adapter. Published package name: `@cocreate/markdown`.

## Editors

Import the package once, or lazy-load it when `[markdown]` appears. Its observer
initializes existing and added elements and attributes. Every element gets its
own editor, with repeated initialization sharing that instance.

```html
<div markdown key="content" aria-label="Post content"></div>
<textarea markdown key="notes" aria-label="Notes"></textarea>
<div markdown component key="content" aria-label="Message"></div>
```

Initialization installs the editor's `setValue()` first, then calls the element's
existing `getValue()`, replaces the getters, and passes the captured source through
the new setter. Synchronous reads complete this handoff in the same call stack,
before loading Milkdown. The existing CoCreate value API determines where the initial source
comes from, for every host type. Asynchronous initial reads are supported; newer
writes take precedence while an initial read is pending. Existing child markup
is replaced by the editor after its source has been read. Textareas preserve native values
and native form submission, reset, and validation. `component` is handled only by
Element Prototype before initialization: Markdown reads the initial value through
the existing `getValue()` and then owns its value methods. Markdown does not
inspect `component` or implement component storage behavior. Generic containers integrate
with CoCreate through their value methods; they are not native form controls.

`element.getValue()` and `getValueAsync()` return Markdown. `element.setValue(text)`
and `element.value = text` update the visual editor, including writes made while
its dependencies load. `setValue(text, true)` also emits an `input` event.
Typing emits bubbling `input`; blur emits `change`. Existing field keys and
CRUD attributes stay on the original element. Value methods are restored by
`destroy(element)`.

Standard `placeholder`, `aria-label`, `required`, `readonly`, and `disabled`
attributes configure the editor. Set feature attributes before initialization. `true` enables a feature and `false`
disables it; an empty attribute also enables it. Missing attributes preserve Crepe's
defaults. Changing feature attributes on an existing editor does not rebuild it.

| Attribute | Default |
| --- | --- |
| `markdown-block-edit` | true |
| `markdown-toolbar` | true |
| `markdown-link-tooltip` | true |
| `markdown-image-block` | true |
| `markdown-table` | true |
| `markdown-code-mirror` | true |
| `markdown-latex` | true |
| `markdown-list-item` | true |
| `markdown-cursor` | true |
| `markdown-placeholder` | true |
| `markdown-top-bar` | false |
| `markdown-ai` | false |

The AI feature is its UI switch, not a configured AI connection. It still needs
provider/handler configuration before use. Layout and scrolling belong to the
surrounding component; the shared editor uses Crepe's frame theme.
Editor readiness emits `markdown-ready`; initialization failures emit
`markdown-error` with `detail.error`. Removing `markdown` destroys the editor.
Call `destroy(element)` before permanently removing a host from the document.

## JavaScript

```js
import markdown from '@cocreate/markdown';

await markdown.create(element);
markdown.setValue(element, '**Hello**');
const source = markdown.getValue(element);
// The host application supplies its configured Markdown parser.
markdown.setRenderer(markdownParser);
const html = markdown.render(source);
markdown.destroy(element);
```

`setRenderer(instance)` accepts a configured parser exposing `render(source)`.
Rendering uses that same instance, preserving its table rules and syntax highlighting.
The package does not bundle a second Markdown parser; configure the renderer before
calling `render`. The host application controls parser options such as raw HTML.
Milkdown supports CommonMark and GFM; align renderer extensions as needed.
Source remains Markdown rather than serialized HTML.

CoCreate-app links this package and declares its lazy import in `CoCreate.config.js`.
Its renderer plugin attaches markdown-it on `markdownLoaded`, or immediately if the
module is already available. Editor styles and Crepe themes are imported by the
package and load with its lazy CSS chunk. `[markdown]` initializes the marked
element itself. There is no query-target initialization: use the host
`getValue()` and `setValue()` methods from CRUD, Events, or application code.

## Package status

CoCreate-app uses this package for its Markdown composer in place of its old
app-local Milkdown adapter. No automatic CRDT
binding is included. CoCreate-text's source operations and Milkdown transactions
need a dedicated bridge; do not attach direct HTML morphing to Milkdown's DOM.

Build with `npm install` and `npm run build`. Bundled files are emitted in `dist`.
The main bundle exposes `CoCreate.markdown`; include its CSS and generated chunks
alongside it. The license follows the client package template (AGPL-3.0).

## Editor positions and CRDT source positions

The following methods await editor readiness and target one editor element:

- `insert(element, markdown, inline = false)` inserts at the current selection.
- `insertPos(element, markdown, position, inline = false)` inserts at an editor position.
- `replaceRange(element, markdown, { from, to })` replaces an editor range.
- `getSelection(element)` returns the editor selection's positions and type.
- `setSelection(element, anchor, head = anchor)` places a text caret or selection.

These positions are ProseMirror document positions. They are not DOM child indexes
or offsets in the serialized Markdown string. The caret is local; Crepe's cursor
feature does not by itself broadcast or render other people's cursors.

`src/CRDT.js` is the source-operation boundary for CoCreate CRDT:

- `sourceChange(before, after)` returns a contiguous `{ start, length, value }` splice.
- `applySourceChange(source, change)` applies a splice to a Markdown string.
- `applyChange(element, event.detail)` accepts a CoCreate CRDT source update after
  editor initialization. It uses the canonical `string` when present, including
  an empty string, or applies the source splice to the current Markdown.

`applyChange` updates through the editor API, without generating another input
event. This first source-update API reparses the resulting Markdown document;
it does not map source offsets to incremental ProseMirror transactions. Current
whole-value updates recreate editor state, including its selection and undo
history. This is an operation API foundation, not automatic CRDT synchronization:
`crdt="true"` wiring, outgoing operation routing, initialization ownership, and
remote cursor mapping remain to be implemented. The package does not import or
initialize CoCreate-text or Milkdown's Yjs collaboration plugin.
