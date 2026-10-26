import { attachEditorDetails, getEditorDetails, rebuildEditorDetails } from "./details.js";
import {
    getLiveNode, getMarkdownMap, getSourceMap, isPlaceholder,
    markPlaceholder, setLiveNode, setMarkdownMap, setSourceMap, unmarkPlaceholder
} from "./nodeData.js";

function createLiveNode(detached, doc) {
    let live;
    if (detached.nodeType === 3) live = doc.createTextNode(detached.data);
    else if (detached.nodeType === 8) live = doc.createComment(detached.data);
    else live = doc.createElementNS(detached.namespaceURI, detached.localName);
    setLiveNode(detached, live);
    return live;
}

function syncAttributes(detached, live, root) {
    const attrs = new Map(
        [...detached.attributes].map(attr => [attr.name, attr.value])
    );
    // The iframe document's editing state belongs to the editor, not its source.
    if (root && live.ownerDocument.documentElement === live &&
        live.getAttribute("contenteditable") === "true") attrs.set("contenteditable", "true");
    for (const attr of [...live.attributes])
        if (!attrs.has(attr.name)) live.removeAttribute(attr.name);
    for (const [name, value] of attrs)
        if (live.getAttribute(name) !== value) live.setAttribute(name, value);
}

function syncNode(detached, live, editorElement) {
    setLiveNode(detached, live);
    attachEditorDetails(detached, live, editorElement);
    if (detached.nodeType === 3 || detached.nodeType === 8) {
        if (live.data !== detached.data) live.data = detached.data;
        setSourceMap(live, getSourceMap(detached));
        setMarkdownMap(live, getMarkdownMap(detached));
        return;
    }
    if (isPlaceholder(detached)) markPlaceholder(live);
    else unmarkPlaceholder(live);
    syncAttributes(detached, live, false);
    if (!live.__cocreateEditor) syncChildren(detached, live, editorElement);
}

function syncChildren(detached, live, editorElement) {
    let cursor = live.firstChild;
    for (const child of [...detached.childNodes]) {
        let target = getLiveNode(child);
        if (!target || target.ownerDocument !== live.ownerDocument ||
            target.nodeType !== child.nodeType || target.nodeName !== child.nodeName)
            target = createLiveNode(child, live.ownerDocument);
        syncNode(child, target, editorElement);
        if (target === cursor) cursor = cursor.nextSibling;
        else live.insertBefore(target, cursor);
    }
    while (cursor) {
        const next = cursor.nextSibling;
        cursor.remove();
        cursor = next;
    }
}

export function syncMirrorNode(detached) {
    const live = getLiveNode(detached);
    if (!live || !live.isConnected) return false;
    const editorElement = getEditorDetails(detached)?.editorElement;
    syncNode(detached, live, editorElement);
    return true;
}

export function reconcileMirror(detached, live, editorElement = getEditorDetails(detached)?.editorElement,
    rebuildIndex = true) {
    if (!editorElement) {
        const doc = live.ownerDocument;
        editorElement = (live === doc.documentElement || live === doc.body)
            ? doc.defaultView.frameElement || live : live;
    }
    setLiveNode(detached, live);
    attachEditorDetails(detached, live, editorElement);
    if (detached.nodeType === 1 && live.ownerDocument.documentElement === live)
        syncAttributes(detached, live, true);
    syncChildren(detached, live, editorElement);
    if (rebuildIndex) rebuildEditorDetails(editorElement, detached);
}

export function reconcileDoctype(detached, live) {
    const before = live.doctype;
    const after = detached.doctype;
    if (before?.name === after?.name && before?.publicId === after?.publicId &&
        before?.systemId === after?.systemId) return;
    before?.remove();
    if (after) live.insertBefore(live.importNode(after, true), live.documentElement);
}

// A new mode/language is a fresh rendering. Build its live nodes from the new
// detached tree and replace the contents directly; no old nodes are matched,
// patched, or traversed to decide what can be reused.
export function replaceMirror(detached, live, editorElement) {
    const doc = live.ownerDocument;
    const create = source => {
        const target = createLiveNode(source, doc);
        attachEditorDetails(source, target, editorElement);
        if (source.nodeType === 3 || source.nodeType === 8) {
            setSourceMap(target, getSourceMap(source));
            setMarkdownMap(target, getMarkdownMap(source));
        } else {
            for (const attribute of source.attributes) target.setAttribute(attribute.name, attribute.value);
            if (isPlaceholder(source)) markPlaceholder(target);
            for (const child of source.childNodes) target.appendChild(create(child));
        }
        return target;
    };
    const fragment = doc.createDocumentFragment();
    for (const child of detached.childNodes) fragment.appendChild(create(child));
    setLiveNode(detached, live);
    attachEditorDetails(detached, live, editorElement);
    if (live === doc.documentElement) syncAttributes(detached, live, true);
    live.replaceChildren(fragment);
}
