import { isVoidElement } from "../parsers/voidElements.js";

/**
 * Constructor for one editor object in the experimental length-only model.
 *
 * Parsers supply the semantic fields (`kind`, `nodeType`, `value`, and
 * `parentNode`). This module owns record invariants and shared behavior so
 * parsers do not need to know how editor objects are assembled.
 */

export const editorPrototype = Object.create(null);
export const elementEditorPrototype = Object.create(editorPrototype);
const collectionsByEditor = new WeakMap();
const editorsByNode = new WeakMap();
let inputBindingPromise;

function loadInputBinding() {
    inputBindingPromise ||= import(/* webpackChunkName: "editor-input-binding" */ "../../inputBinding.js")
        .catch(error => { inputBindingPromise = undefined; throw error; });
    return inputBindingPromise;
}

export const getEditorForNode = node => node?.editor || editorsByNode.get(node);

const validAttributeName = /^[A-Za-z_:][\w:.-]*$/;
const validStyleProperty = /^(?:--[\w-]+|-?[A-Za-z][\w-]*)$/;

// Split inline CSS only at delimiters outside strings, comments, and functions.
function styleParts(source) {
    const parts = [];
    let start = 0, quote = "", depth = 0, comment = false;
    for (let index = 0; index < source.length; index++) {
        const character = source[index], next = source[index + 1];
        if (comment) {
            if (character === "*" && next === "/") { comment = false; index++; }
        } else if (quote) {
            if (character === "\\") index++;
            else if (character === quote) quote = "";
        } else if (character === "/" && next === "*") { comment = true; index++; }
        else if (character === "\\\"" || character === "'") quote = character;
        else if (character === "(") depth++;
        else if (character === ")") depth = Math.max(0, depth - 1);
        else if (character === ";" && depth === 0) { parts.push({ start, end: index, delimiter: index + 1 }); start = index + 1; }
    }
    parts.push({ start, end: source.length, delimiter: source.length });
    return parts;
}

function styleValueRange(attributeSource) {
    const match = /^(\s*style\s*=\s*)(["'])([\s\S]*?)\2(\s*)$/i.exec(attributeSource);
    if (match) return { start: match[1].length + 1, end: match[1].length + 1 + match[3].length };
    const unquoted = /^(\s*style\s*=\s*)([^\s>]*)(\s*)$/i.exec(attributeSource);
    if (unquoted) return { start: unquoted[1].length, end: unquoted[1].length + unquoted[2].length };
    if (/^\s*style\s*$/i.test(attributeSource)) return { start: attributeSource.length, end: attributeSource.length };
    throw new TypeError("Style operations require a complete style attribute detail.");
}

function styleDeclarations(source) {
    return styleParts(source).map(part => {
        let quote = "", depth = 0, comment = false, colon = -1;
        for (let index = part.start; index < part.end; index++) {
            const character = source[index], next = source[index + 1];
            if (comment) { if (character === "*" && next === "/") { comment = false; index++; } }
            else if (quote) { if (character === "\\") index++; else if (character === quote) quote = ""; }
            else if (character === "/" && next === "*") { comment = true; index++; }
            else if (character === "\\\"" || character === "'") quote = character;
            else if (character === "(") depth++;
            else if (character === ")") depth = Math.max(0, depth - 1);
            else if (character === ":" && depth === 0) { colon = index; break; }
        }
        if (colon < 0) return { ...part, property: "" };
        return { ...part, colon, property: source.slice(part.start, colon).trim() };
    });
}

function submitUpdate(editor, update) {
    const root = editor.element?.editor || editor.element;
    if (typeof root?.updateText !== "function")
        throw new Error("The editor element does not expose editor.updateText().");
    return root.updateText(update);
}

function attributeEditor(elementEditor, name, nativeAttribute) {
    if (typeof name !== "string" || !validAttributeName.test(name))
        throw new TypeError("Attribute operations require a valid HTML attribute name.");
    const liveElement = elementEditor.liveNode;
    if (!liveElement || typeof liveElement.getAttributeNode !== "function")
        throw new Error("Element detail is not attached to a live DOM element.");
    const attribute = nativeAttribute || liveElement.getAttributeNode(name);
    if (!attribute) return null;

    let editor = getEditorForNode(attribute);
    const collection = collectionsByEditor.get(elementEditor);
    if (!editor && collection) {
        editor = collection.find(item => item.kind === "attribute" &&
            item.parentNode === elementEditor &&
            item.name?.toLowerCase() === attribute.name.toLowerCase());
        if (editor) bindEditorNode(editor, attribute);
    }
    return editor || null;
}

Object.assign(editorPrototype, {
    init({ input, query, context, attribute, part, target } = {}) {
        if (!input) throw new TypeError("An input element is required to bind an editor detail.");
        const isAttribute = this.kind === "attribute";
        return loadInputBinding().then(({ initEditorInput }) => initEditorInput(input, {
            context: context || this.element,
            target: target || (!query && (isAttribute ? this.parentNode?.liveNode : this.liveNode)),
            query,
            attribute: attribute || (isAttribute ? { name: this.name } : undefined),
            part
        }));
    },
    uninit(input) {
        return loadInputBinding().then(({ uninitEditorInput }) => uninitEditorInput(input));
    },
    getStart() {
        const collection = collectionsByEditor.get(this);
        if (!collection) throw new Error("Editor is not attached to an ordered editor collection.");
        let start = 0;
        for (const detail of collection) {
            if (detail === this) return start;
            start += detail.length;
        }
        throw new Error("Editor is no longer present in its ordered collection.");
    },
    updateText({ start = 0, length = 0, value }) {
        if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length < 0 ||
            start + length > this.length || typeof value !== "string")
            throw new RangeError("Editor update must be a valid range within this value and include a string value.");
        return submitUpdate(this, { start: this.getStart() + start, length, value });
    },
    setValue(value) {
        return this.updateText({ start: 0, length: this.length, value });
    },
    getStyles() {
        if (this.kind !== "attribute" || this.name?.toLowerCase() !== "style")
            throw new TypeError("Style operations are available on style attribute editors.");
        const range = styleValueRange(this.value);
        const source = this.value.slice(range.start, range.end);
        return styleDeclarations(source).filter(item => item.property).map(item => ({
            property: item.property,
            value: source.slice(item.colon + 1, item.end).trim()
        }));
    },
    setStyle(property, value) {
        if (this.kind !== "attribute" || this.name?.toLowerCase() !== "style")
            throw new TypeError("Style operations are available on style attribute editors.");
        if (typeof property !== "string" || !validStyleProperty.test(property.trim()))
            throw new TypeError("A valid CSS property name is required.");
        if (value == null) return this.removeStyle(property);
        if (typeof value !== "string" && typeof value !== "number")
            throw new TypeError("A CSS property value must be a string or number.");
        const range = styleValueRange(this.value), source = this.value.slice(range.start, range.end);
        const declarations = styleDeclarations(source);
        const existing = declarations.filter(item => item.property.toLowerCase() === property.trim().toLowerCase());
        if (existing.length) {
            const item = existing.at(-1), raw = source.slice(item.colon + 1, item.end);
            const leadingLength = /^\s*/.exec(raw)[0].length;
            const importantStart = /\s*!important\s*$/i.exec(raw)?.index ?? raw.length;
            let valueStart = item.colon + 1 + leadingLength;
            let valueEnd = item.colon + 1 + importantStart;
            while (valueEnd > valueStart && /\s/.test(source[valueEnd - 1])) valueEnd--;
            return this.updateText({ start: range.start + valueStart,
                length: valueEnd - valueStart, value: String(value) });
        }

        const separator = source.trim() ? (source.trimEnd().endsWith(";") ? " " : "; ") : "";
        const insertion = `${separator}${property.trim()}: ${String(value)}`;
        return this.updateText({ start: range.end, length: 0, value: insertion });
    },
    async removeStyle(property) {
        if (this.kind !== "attribute" || this.name?.toLowerCase() !== "style")
            throw new TypeError("Style operations are available on style attribute editors.");
        if (typeof property !== "string" || !validStyleProperty.test(property.trim()))
            throw new TypeError("A valid CSS property name is required.");
        const range = styleValueRange(this.value), source = this.value.slice(range.start, range.end);
        const declarations = styleDeclarations(source).filter(item =>
            item.property.toLowerCase() === property.trim().toLowerCase());
        if (!declarations.length) return;
        let result;
        for (const item of declarations.reverse()) {
            let start = item.start, end = item.delimiter;
            if (end === source.length && start > 0 && source[start - 1] === ";") start--;
            result = await this.updateText({ start: range.start + start, length: end - start, value: "" });
        }
        return result;
    },
    remove() {
        return this.updateText({ start: 0, length: this.length, value: "" });
    }
});

Object.assign(elementEditorPrototype, {
    /** Remove the complete element source range through the editor update API. */
    remove() {
        const range = this.getOuterRange();
        if (!range) return editorPrototype.remove.call(this);
        return submitUpdate(this, {
            start: range.start,
            length: range.end - range.start,
            value: ""
        });
    },
    /** Change an element's tag while preserving its attributes and child source. */
    async setTagName(name) {
        if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]*$/.test(name))
            throw new TypeError("A valid HTML tag name is required.");
        const previous = String(this.tag || "");
        if (!previous) throw new Error("Element detail has no tag name.");
        const next = name.toLowerCase();
        if (next === previous.toLowerCase()) return;
        const wasVoid = isVoidElement(previous.toLowerCase());
        const isVoid = isVoidElement(next);
        if (wasVoid !== isVoid)
            throw new TypeError("Tag changes must keep void and non-void elements in the same category.");

        const start = this.getStart();
        const endTag = collectionsByEditor.get(this)?.find(detail =>
            detail.kind === "elementEnd" && detail.parentNode === this &&
            detail.tag?.toLowerCase() === previous.toLowerCase());
        if (!wasVoid && !endTag)
            throw new Error("Cannot change a non-void element without a matching end tag.");

        const root = this.element?.editor || this.element;
        if (typeof root?.updateText !== "function")
            throw new Error("The editor element does not expose editor.updateText().");
        const openingStart = this.value[0] === "<" &&
            this.value.slice(1, previous.length + 1).toLowerCase() === previous.toLowerCase() ? 1 : -1;
        if (openingStart < 0) throw new Error("Could not locate the opening tag name in its source detail.");
        const closingStart = endTag?.getStart();
        const result = await root.updateText({ start: start + openingStart,
            length: previous.length, value: next });
        if (!endTag) return result;
        return root.updateText({ start: closingStart + (next.length - previous.length) + 2,
            length: previous.length, value: next });
    },
    /** Find a detail-local insertion point at one of this element's boundaries. */
    getInsertionPoint(position) {
        const collection = collectionsByEditor.get(this);
        if (!collection) throw new Error("Editor is not attached to an ordered editor collection.");
        if (position === "beforebegin") return { editor: this, offset: 0 };
        if (position !== "afterbegin" && position !== "beforeend" && position !== "afterend")
            return null;

        let openingDelimiter = null, closingTag = null;
        for (const detail of collection) {
            if (detail.parentNode !== this) continue;
            if (!openingDelimiter && detail.kind === "markup" && detail.value.includes(">"))
                openingDelimiter = detail;
            if (detail.kind === "elementEnd" && detail.tag === this.tag) {
                closingTag = detail;
                break;
            }
        }
        if (this.void || this.selfClosing)
            return position === "afterend" && openingDelimiter
                ? { editor: openingDelimiter, offset: openingDelimiter.length } : null;
        if (position === "afterbegin")
            return openingDelimiter ? { editor: openingDelimiter, offset: openingDelimiter.length } : null;
        if (!closingTag) return null;
        return { editor: closingTag, offset: position === "beforeend" ? 0 : closingTag.length };
    },
    /** Derive this element's inner source range from the flat detail ledger. */
    getContentRange() {
        const collection = collectionsByEditor.get(this);
        if (!collection) throw new Error("Editor is not attached to an ordered editor collection.");
        let position = 0, found = false, contentStart = null;
        for (const detail of collection) {
            const start = position;
            position += detail.length;
            if (detail === this) { found = true; continue; }
            if (!found) continue;
            if (contentStart === null && detail.parentNode === this && detail.kind === "markup" && detail.value.includes(">")) {
                contentStart = position;
                continue;
            }
            if (contentStart !== null && detail.kind === "elementEnd" && detail.parentNode === this)
                return { start: contentStart, end: start };
        }
        return contentStart === null ? null : { start: contentStart, end: contentStart };
    },
    /** Derive the complete outer source span, including its closing tag. */
    getOuterRange() {
        const collection = collectionsByEditor.get(this);
        if (!collection) throw new Error("Editor is not attached to an ordered editor collection.");
        const start = this.getStart();
        const content = this.getContentRange();
        if (!content) return null;
        let position = 0;
        for (const detail of collection) {
            position += detail.length;
            if (detail.kind === "elementEnd" && detail.parentNode === this)
                return { start, end: position };
        }
        return { start, end: content.end };
    },
    /** Return the matching attribute editor, or null when the attribute is absent. */
    getAttribute(name) {
        return attributeEditor(this, name);
    },
    /** Return this element's source-backed attribute details in source order. */
    getAttributes() {
        const collection = collectionsByEditor.get(this);
        if (!collection) throw new Error("Editor is not attached to an ordered editor collection.");
        return collection.filter(item => item.kind === "attribute" && item.parentNode === this);
    },
    setAttribute(name, value) {
        if (value == null) return this.removeAttribute(name);
        if (typeof name !== "string" || !validAttributeName.test(name))
            throw new TypeError("Attribute operations require a valid HTML attribute name.");
        if (!this.liveNode || typeof this.liveNode.getAttributeNode !== "function")
            throw new Error("Element detail is not attached to a live DOM element.");
        const text = String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        const nativeAttribute = this.liveNode?.getAttributeNode(name);
        if (nativeAttribute) {
            const editor = attributeEditor(this, name, nativeAttribute);
            if (!editor) throw new Error(`No editor is attached to attribute "${name}".`);
            return editor.setValue(`${nativeAttribute.name}="${text}"`);
        }
        return this.updateText({
            start: this.length,
            length: 0,
            value: ` ${name}="${text}"`
        });
    },
    removeAttribute(name) {
        if (typeof name !== "string" || !validAttributeName.test(name))
            throw new TypeError("Attribute operations require a valid HTML attribute name.");
        if (!this.liveNode || typeof this.liveNode.getAttributeNode !== "function")
            throw new Error("Element detail is not attached to a live DOM element.");
        const nativeAttribute = this.liveNode?.getAttributeNode(name);
        if (!nativeAttribute) return;
        const editor = attributeEditor(this, name, nativeAttribute);
        if (!editor) throw new Error(`No editor is attached to attribute "${name}".`);
        const collection = collectionsByEditor.get(this);
        const matching = collection?.filter(item => item.kind === "attribute" &&
            item.parentNode === this && item.name.toLowerCase() === name.toLowerCase());
        if (matching?.length > 1) {
            const first = matching[0], last = matching.at(-1), unwanted = new Set(matching);
            const between = collection.slice(collection.indexOf(first), collection.indexOf(last) + 1);
            return submitUpdate(this, { start: first.getStart(),
                length: between.reduce((length, item) => length + item.length, 0),
                value: between.filter(item => !unwanted.has(item)).map(item => item.value).join("") });
        }
        return editor.remove();
    }
});

/** Bind an editor object to the ordered collection whose cumulative range it uses. */
export function bindEditor(editor, collection) {
    if (!editor || typeof editor !== "object")
        throw new TypeError("Editor must be an object.");
    if (!Array.isArray(collection))
        throw new TypeError("Editor collection must be an array.");
    collectionsByEditor.set(editor, collection);
    return editor;
}

/** Associate an editor object with a live or detached DOM node. */
export function bindEditorNode(editor, node, property = "liveNode") {
    if (!editor || typeof editor !== "object")
        throw new TypeError("Editor must be an object.");
    if (!node || typeof node !== "object")
        throw new TypeError("DOM node reference must be an object.");
    if (property !== "liveNode" && property !== "detachedNode")
        throw new TypeError('Editor node property must be "liveNode" or "detachedNode".');
    const previous = editor[property];
    if (previous && previous !== node && previous.editor === editor) {
        editorsByNode.delete(previous);
        delete previous.editor;
    }
    editor[property] = node;
    editorsByNode.set(node, editor);
    node.editor = editor;
    return editor;
}

/** Sum cached segment lengths to get the source length represented by a list. */
export function getEditorsLength(details) {
    if (!Array.isArray(details)) throw new TypeError("Editors must be an array.");
    let length = 0;
    for (const detail of details) length += detail.length;
    return length;
}

/** Locate the detail containing a source offset by accumulating segment lengths. */
export function findEditorIndex(details, offset, { bias = "right" } = {}) {
    if (!Array.isArray(details)) throw new TypeError("Editors must be an array.");
    if (!Number.isInteger(offset) || offset < 0)
        throw new RangeError("Offset must be a non-negative integer.");
    if (bias !== "left" && bias !== "right")
        throw new TypeError('Bias must be "left" or "right".');

    let cursor = 0;
    let previous = -1;
    for (let index = 0; index < details.length; index++) {
        const detail = details[index];
        const end = cursor + detail.length;
        if (offset < end) return index;
        if (offset === end) {
            if (bias === "left" && detail.length) return index;
            previous = index;
        }
        cursor = end;
    }
    return offset === cursor && bias === "left" ? previous : -1;
}

export function findEditorAt(details, offset, options) {
    const index = findEditorIndex(details, offset, options);
    return index < 0 ? undefined : details[index];
}

/** Return the details intersecting a half-open source range. */
export function findEditorsInRange(details, start, end = start) {
    if (!Array.isArray(details)) throw new TypeError("Editors must be an array.");
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start)
        throw new RangeError("Expected a valid half-open source range.");
    if (end > getEditorsLength(details))
        throw new RangeError("Range extends past the editor collection.");

    const matches = [];
    let cursor = 0;
    for (let index = 0; index < details.length; index++) {
        const detail = details[index];
        const next = cursor + detail.length;
        const intersects = start === end
            ? cursor <= start && start < next
            : cursor < end && start < next;
        if (intersects) matches.push({ detail, index, start: cursor, end: next });
        cursor = next;
        if (cursor >= end && start !== end) break;
    }
    return matches;
}

/**
 * Create one detail record and optionally append it to an ordered collection.
 * The caller determines source order; positions are intentionally not stored.
 */
export function createEditor(data, collection, { dom = data?.dom === true } = {}) {
    if (!data || typeof data !== "object")
        throw new TypeError("Editor data must be an object.");
    if (typeof data.value !== "string")
        throw new TypeError("Editor value must be a string.");
    if (collection !== undefined && !Array.isArray(collection))
        throw new TypeError("Editor collection must be an array.");

    const prototype = dom && data.nodeType === 1 && data.kind === "element"
        ? elementEditorPrototype
        : editorPrototype;
    const editor = Object.assign(Object.create(prototype), data, {
        length: data.value.length,
        element: data.element || null,
        liveNode: data.liveNode || null,
        detachedNode: data.detachedNode || null,
        parentNode: data.parentNode || null
    });
    if (collection) {
        collection.push(editor);
        bindEditor(editor, collection);
    }
    return editor;
}

/** Create an ordered collection with a record-construction method. */
export function createEditorCollection({ element = null, dom = false } = {}) {
    const details = [];
    return {
        details,
        dom,
        add(data) {
            return createEditor({ ...data, element: data.element || element }, details, { dom });
        },
        toArray() {
            return details;
        }
    };
}

/** Convert plain parser records into editor-owned details only when needed. */
export function createEditorsFromRecords(records, element = null, { dom = false } = {}) {
    if (!Array.isArray(records)) throw new TypeError("Parser records must be an array.");
    const details = [];
    const references = new WeakMap();
    for (const record of records) {
        const data = { ...record, element,
            parentNode: references.get(record.parentNode) || null };
        const editor = createEditor(data, details, { dom });
        references.set(record, editor);
    }
    return details;
}

export default createEditor;
