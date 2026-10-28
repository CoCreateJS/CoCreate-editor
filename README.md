# CoCreate Editor

**An extensible collaborative editor for text, HTML/DOM, Markdown, and code.**

CoCreate Editor is a headless, declarative editing and rendering engine. Add an
editor with HTML attributes or initialize one through JavaScript. The host
application controls its layout, controls, and styling; the editor provides the
editable source surface, parsing, rendering, and source-to-DOM mapping.

Plain text, HTML/DOM, Markdown, and code share a positional editing model. The
source remains canonical while rendered elements and text are tracked as editor
objects. An application can connect those updates to CoCreate CRDT for
collaborative editing or use the editor locally.

## Editor types

| Type | Source | Rendered editing surface |
| --- | --- | --- |
| Text | Plain text | Editable text, input, or textarea |
| DOM | HTML source | Live DOM built from the HTML source |
| Markdown | Markdown source | Rendered Markdown |
| Code | Source in a supported language | Editable, syntax highlighted code |

The editor works in place: users edit the source through its rendered surface.
Applications can provide their own surrounding UI and use normal DOM styling,
CoCreate attributes, observers, and events to add application-specific
behavior.

## Declarative setup

Load the built browser bundle and its generated chunks from the same location:

```html
<link rel="stylesheet" href="./dist/CoCreate-editor.min.css">
<script src="./dist/CoCreate-editor.min.js"></script>
```

The loader watches for editor surfaces. It loads the editor runtime when it
finds one, then loads the selected mode and its dependencies on demand.

```html
<div contenteditable="true">Write text here.</div>

<div editor="dom" contenteditable="true">&lt;p&gt;Edit this paragraph&lt;/p&gt;</div>

<div editor="markdown" contenteditable="true"># Welcome</div>

<div editor="code" editor-language="javascript" contenteditable="true">
const value = 1;
</div>

<textarea editor="text">Edit this source</textarea>
```

`editor="text"` is also available when an explicit type is useful. An element
with `contenteditable="false"` is ignored. An HTML source surface starts from
its text content; Markdown and code use the same source-backed approach.

## Lazy loading

The initial bundle is a loader. The runtime is requested only when an editor
surface is found or an editor API is called. Parser APIs load parser code
directly without initializing the editor runtime or creating editor objects.
Editor modes and code languages are split into asynchronous chunks and cached
after first use. Code language modules load on demand: selecting a language
loads its tokenizer, while Markdown code fences resolve their labeled or
detected language during parsing. An absent or unsupported code-editor language
can also be resolved through language detection.

Supported code languages include HTML, CSS, JavaScript, JSON, Python,
TypeScript, SQL, Bash, YAML, C, Go, Java, and PHP. Common aliases include `js`,
`py`, `ts`, `sh`, and `yml`.

## Parser APIs

Parser calls return source records. They do not create editor objects or DOM;
the calling application decides what to do with the results.

```js
const domRecords = await CoCreate.editor.parseDOM('<p>Hello</p>');
const markdownRecords = await CoCreate.editor.parseMarkdown('# Hello');
const codeRecords = await CoCreate.editor.parseCode('const value = 1;', 'javascript');
```

Each record describes a source segment with fields such as `kind`, `value`,
and `length`. DOM records also describe element relationships and attributes;
Markdown and code records carry their syntax and token information.

To create editor objects explicitly, use the corresponding creation API:

```js
const domEditor = await CoCreate.editor.createDOMEditor('<p>Hello</p>');
const markdownEditor = await CoCreate.editor.createMarkdownEditor('# Hello');
const codeEditor = await CoCreate.editor.createCodeEditor('const value = 1;', 'javascript');

console.log(domEditor.details);
```

The editor mode uses those objects to render and update its live editing
surface. Plain text uses the native source value and does not need a detail
array.

## Editor objects and updates

The root editor exposes its ordered objects as `element.editor.nodes`. Rendered
DOM elements and source-backed attributes expose their corresponding editor
object as `.editor`. Objects carry their source `value`, cached `length`,
`kind`, and parent relationship; rendered objects also retain live-node
references.

```js
const rootEditor = document.querySelector('[editor="dom"]').editor;
const nodes = rootEditor.nodes;

const paragraph = nodes.find(node => node.kind === 'element' && node.tag === 'p');
console.log(paragraph.getStart());

// Element helpers create source edits at the correct opening-tag position.
await paragraph.setAttribute('class', 'intro');
```

Every update uses the positional `updateText({ start, length, value })`
contract. The editor applies the resulting source change to the matching
rendered objects. Element editor objects expose `getAttribute(name)`,
`getAttributes()`, `setAttribute(name, value)`, and `removeAttribute(name)`;
`getAttributes()` returns the element's source-backed attribute editor details
in source order. Attribute objects also support source-aware value updates and
removal.

An input or textarea can bind to the clicked element's text by default. Add
`editor-attribute` to bind to a specific attribute instead:

```html
<!-- Edits the clicked element's first source-backed text segment -->
<input editor-query="$clickedElement">

<!-- Edits the clicked element's class attribute -->
<input editor-query="$clickedElement" editor-attribute="class">

<!-- Edits the clicked element's inline color declaration -->
<input editor-query="$clickedElement" editor-attribute="style" editor-property="color">
```

An element with `editor-attributes` can render the clicked element's existing
attribute editor details. The binding passes those same source-backed objects
to the renderer's `renderValue()` method and refreshes them after editor changes:

```html
<div editor-query="$clickedElement" editor-attributes></div>
```

For example, a meta description is an attribute, so bind it with
`editor-attribute="content"`. The input binding module is loaded only when a
query-bound control is initialized.

## Styling and integrations

Rendered DOM is normal, styleable DOM. Code and Markdown token spans use
`token-*` classes (such as `.token-keyword`, `.token-string`, and `.token-tag`);
the generated stylesheet provides basic token colors that applications can
override.

Application behavior can live above the editor. Use DOM events, CoCreate
observers, and declarative attributes to attach controls or transform rendered
elements without adding plugin behavior to the parser or renderer.

## Build and demo

```sh
yarn build
```

Serve `demo/index.html` over HTTP to explore the editor and parser modes. The
demo starts in Editor mode without selecting an editor type; choosing Parser
opens Markdown immediately. It describes lazy loading as each mode and code
language is selected.
