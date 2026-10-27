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

export const getEditorForNode = node => node?.editor || editorsByNode.get(node);

const validAttributeName = /^[A-Za-z_:][\w:.-]*$/;

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
    remove() {
        return this.updateText({ start: 0, length: this.length, value: "" });
    }
});

Object.assign(elementEditorPrototype, {
    /** Return the matching attribute editor, or null when the attribute is absent. */
    getAttribute(name) {
        return attributeEditor(this, name);
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
