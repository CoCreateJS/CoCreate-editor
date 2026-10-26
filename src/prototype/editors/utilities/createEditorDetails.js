/**
 * Constructor for the experimental length-only editor-detail records.
 *
 * Parsers supply the semantic fields (`kind`, `nodeType`, `value`, and
 * `parentDetails`). This module owns record invariants and shared behavior so
 * parsers do not need to know how editor-detail objects are assembled.
 */

export const editorDetailsPrototype = Object.create(null);
export const elementEditorDetailsPrototype = Object.create(editorDetailsPrototype);
const collectionsByDetail = new WeakMap();
const detailsByLiveDOM = new WeakMap();

const validAttributeName = /^[A-Za-z_:][\w:.-]*$/;

function attributeDetail(elementDetails, name, nativeAttribute) {
    if (typeof name !== "string" || !validAttributeName.test(name))
        throw new TypeError("Attribute operations require a valid HTML attribute name.");
    const liveElement = elementDetails.liveDOM;
    if (!liveElement || typeof liveElement.getAttributeNode !== "function")
        throw new Error("Element detail is not attached to a live DOM element.");
    const attribute = nativeAttribute || liveElement.getAttributeNode(name);
    if (!attribute) return null;

    let detail = detailsByLiveDOM.get(attribute);
    const collection = collectionsByDetail.get(elementDetails);
    if (!detail && collection) {
        detail = collection.find(item => item.kind === "attribute" &&
            item.parentDetails === elementDetails &&
            item.name?.toLowerCase() === attribute.name.toLowerCase());
        if (detail) bindEditorDetailsLiveDOM(detail, attribute);
    }
    return detail || null;
}

Object.assign(editorDetailsPrototype, {
    getStart() {
        const collection = collectionsByDetail.get(this);
        if (!collection) throw new Error("Editor detail is not attached to a details collection.");
        let start = 0;
        for (const detail of collection) {
            if (detail === this) return start;
            start += detail.length;
        }
        throw new Error("Editor detail is no longer present in its details collection.");
    },
    updateText({ start = 0, length = 0, value }) {
        if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length < 0 ||
            start + length > this.length || typeof value !== "string")
            throw new RangeError("Detail update must be a valid range within this value and include a string value.");
        const editor = this.editor?.editor || this.editor;
        if (typeof editor?.updateText !== "function")
            throw new Error("The editor element does not expose editor.updateText().");
        return editor.updateText({ start: this.getStart() + start, length, value });
    },
    setValue(value) {
        return this.updateText({ start: 0, length: this.length, value });
    },
    remove() {
        return this.updateText({ start: 0, length: this.length, value: "" });
    }
});

Object.assign(elementEditorDetailsPrototype, {
    /** Return the matching attribute detail, or null when the attribute is absent. */
    getAttribute(name) {
        return attributeDetail(this, name);
    },
    setAttribute(name, value) {
        if (value == null) return this.removeAttribute(name);
        if (typeof name !== "string" || !validAttributeName.test(name))
            throw new TypeError("Attribute operations require a valid HTML attribute name.");
        if (!this.liveDOM || typeof this.liveDOM.getAttributeNode !== "function")
            throw new Error("Element detail is not attached to a live DOM element.");
        const text = String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        const nativeAttribute = this.liveDOM?.getAttributeNode(name);
        if (nativeAttribute) {
            const detail = attributeDetail(this, name, nativeAttribute);
            if (!detail) throw new Error(`No editor detail is attached to attribute "${name}".`);
            return detail.setValue(`${nativeAttribute.name}="${text}"`);
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
        if (!this.liveDOM || typeof this.liveDOM.getAttributeNode !== "function")
            throw new Error("Element detail is not attached to a live DOM element.");
        const nativeAttribute = this.liveDOM?.getAttributeNode(name);
        if (!nativeAttribute) return;
        const detail = attributeDetail(this, name, nativeAttribute);
        if (!detail) throw new Error(`No editor detail is attached to attribute "${name}".`);
        return detail.remove();
    }
});

/** Bind an existing detail to the ordered array whose cumulative range it uses. */
export function bindEditorDetails(detail, collection) {
    if (!detail || typeof detail !== "object")
        throw new TypeError("Editor detail must be an object.");
    if (!Array.isArray(collection))
        throw new TypeError("Editor details collection must be an array.");
    collectionsByDetail.set(detail, collection);
    return detail;
}

/** Associate a detail with its local live DOM node (an Element or Attr). */
export function bindEditorDetailsLiveDOM(detail, node) {
    if (!detail || typeof detail !== "object")
        throw new TypeError("Editor detail must be an object.");
    if (!node || typeof node !== "object")
        throw new TypeError("Live DOM reference must be an object.");
    detail.liveDOM = node;
    detailsByLiveDOM.set(node, detail);
    return detail;
}

/** Sum cached segment lengths to get the source length represented by a list. */
export function getEditorDetailsLength(details) {
    if (!Array.isArray(details)) throw new TypeError("Editor details must be an array.");
    let length = 0;
    for (const detail of details) length += detail.length;
    return length;
}

/** Locate the detail containing a source offset by accumulating segment lengths. */
export function findEditorDetailIndex(details, offset, { bias = "right" } = {}) {
    if (!Array.isArray(details)) throw new TypeError("Editor details must be an array.");
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

export function findEditorDetailAt(details, offset, options) {
    const index = findEditorDetailIndex(details, offset, options);
    return index < 0 ? undefined : details[index];
}

/** Return the details intersecting a half-open source range. */
export function findEditorDetailsInRange(details, start, end = start) {
    if (!Array.isArray(details)) throw new TypeError("Editor details must be an array.");
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start)
        throw new RangeError("Expected a valid half-open source range.");
    if (end > getEditorDetailsLength(details))
        throw new RangeError("Range extends past the editor details.");

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
export function createEditorDetails(data, collection, { dom = data?.dom === true } = {}) {
    if (!data || typeof data !== "object")
        throw new TypeError("Editor detail data must be an object.");
    if (typeof data.value !== "string")
        throw new TypeError("Editor detail value must be a string.");
    if (collection !== undefined && !Array.isArray(collection))
        throw new TypeError("Editor details collection must be an array.");

    const prototype = dom && data.nodeType === 1 && data.kind === "element"
        ? elementEditorDetailsPrototype
        : editorDetailsPrototype;
    const detail = Object.assign(Object.create(prototype), data, {
        length: data.value.length,
        editor: data.editor || null,
        liveDOM: data.liveDOM || null,
        parentDetails: data.parentDetails || null
    });
    if (collection) {
        collection.push(detail);
        bindEditorDetails(detail, collection);
    }
    return detail;
}

/** Create an ordered collection with a record-construction method. */
export function createEditorDetailsCollection({ editor = null, dom = false } = {}) {
    const details = [];
    return {
        details,
        dom,
        add(data) {
            return createEditorDetails({ ...data, editor: data.editor || editor }, details, { dom });
        },
        toArray() {
            return details;
        }
    };
}

export default createEditorDetails;
