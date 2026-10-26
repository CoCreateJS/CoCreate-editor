import { bindEditorDetailsLiveDOM } from "./createEditorDetails.js";

function depth(detail) {
    let value = 0;
    for (let parent = detail.parentDetails; parent; parent = parent.parentDetails) value++;
    return value;
}

function parentNode(detail, editor) {
    return detail.parentDetails?.liveDOM ||
        editor?.editor?.liveDOM ||
        editor?.liveDOM ||
        (editor?.nodeType ? editor : null) ||
        null;
}

function nextLiveSibling(details, detail, parent) {
    const index = details.indexOf(detail);
    for (let i = index + 1; i < details.length; i++) {
        const candidate = details[i];
        if (candidate.parentDetails !== detail.parentDetails || !candidate.liveDOM) continue;
        if (candidate.kind === "element" || candidate.kind === "text" ||
            candidate.kind === "comment" || candidate.nodeType === 3)
            return candidate.liveDOM;
    }
    return parent?.lastChild || null;
}

function decodeAttribute(detail, element) {
    const template = element.ownerDocument.createElement("template");
    template.innerHTML = "<span " + detail.value + "></span>";
    const parsed = template.content.firstElementChild;
    if (!parsed || !detail.name || !parsed.hasAttribute(detail.name)) return null;
    return parsed.getAttribute(detail.name);
}

function removeDetail(detail) {
    if (detail.kind === "attribute") {
        const attribute = detail.liveDOM;
        const parent = detail.parentDetails?.liveDOM;
        if (attribute?.ownerElement) attribute.ownerElement.removeAttributeNode(attribute);
        else if (parent && detail.name) parent.removeAttribute(detail.name);
        return;
    }
    detail.liveDOM?.remove?.();
}

function updateDetail(detail) {
    if (detail.kind === "attribute") {
        const element = detail.parentDetails?.liveDOM;
        if (!element || !detail.name) return;
        const value = decodeAttribute(detail, element);
        if (value === null) element.removeAttribute(detail.name);
        else element.setAttribute(detail.name, value);
        const attribute = element.getAttributeNode(detail.name);
        if (attribute) bindEditorDetailsLiveDOM(detail, attribute);
        return;
    }
    if ((detail.nodeType === 3 || detail.nodeType === 8) && detail.liveDOM)
        detail.liveDOM.data = detail.kind === "comment"
            ? detail.value.slice(4, detail.value.endsWith("-->") ? -3 : undefined)
            : detail.value;
}

function createNode(detail, document) {
    if (detail.kind === "element" && detail.tag) return document.createElement(detail.tag);
    if (detail.kind === "comment")
        return document.createComment(detail.value.slice(4, detail.value.endsWith("-->") ? -3 : undefined));
    if (detail.nodeType === 3) return document.createTextNode(detail.value);
    return null;
}

function addDetail(detail, details, editor) {
    if (detail.kind === "attribute") {
        const parent = parentNode(detail, editor);
        if (!parent || !detail.name) return;
        const value = decodeAttribute(detail, parent);
        if (value !== null) {
            parent.setAttribute(detail.name, value);
            const attribute = parent.getAttributeNode(detail.name);
            if (attribute) bindEditorDetailsLiveDOM(detail, attribute);
        }
        return;
    }

    const parent = parentNode(detail, editor);
    const document = parent?.ownerDocument || editor?.ownerDocument;
    if (!document) return;
    const node = createNode(detail, document);
    if (!node) return;
    const before = nextLiveSibling(details, detail, parent);
    if (parent) parent.insertBefore(node, before);
    bindEditorDetailsLiveDOM(detail, node);
}

/**
 * Apply a completed details transaction to the already-referenced live nodes.
 * This is an internal update step, not a user-facing editor API.
 */
export function renderEditor(editor, { editorDetails, removed = [], edited = [], added = [] }) {
    const removals = removed.map(item => item.detail || item)
        .sort((a, b) => depth(b) - depth(a));
    for (const detail of removals) removeDetail(detail);
    for (const { detail } of edited) updateDetail(detail);

    const additions = [...added].sort((a, b) =>
        editorDetails.indexOf(a) - editorDetails.indexOf(b));
    for (const detail of additions) addDetail(detail, editorDetails, editor);
}

export default renderEditor;
