// Paired nodes share source positions as properties. The live tree receives
// only presentation attributes.
const internalAttribute = name =>
    name === "data-editor-placeholder" || /^data-(?:source|md)-/.test(name);

function createLiveNode(detached, doc) {
    let live;
    if (detached.nodeType === 3) live = doc.createTextNode(detached.data);
    else if (detached.nodeType === 8) live = doc.createComment(detached.data);
    else live = doc.createElementNS(detached.namespaceURI, detached.localName);
    detached.liveNode = live;
    return live;
}

function syncAttributes(detached, live, root) {
    const attrs = new Map(
        [...detached.attributes]
            .filter(attr => !internalAttribute(attr.name))
            .map(attr => [attr.name, attr.value])
    );
    // The iframe document's editing state belongs to the editor, not its source.
    if (root && live.ownerDocument.documentElement === live &&
        live.getAttribute("contenteditable") === "true") attrs.set("contenteditable", "true");
    for (const attr of [...live.attributes])
        if (!attrs.has(attr.name) && !internalAttribute(attr.name)) live.removeAttribute(attr.name);
    for (const [name, value] of attrs)
        if (live.getAttribute(name) !== value) live.setAttribute(name, value);
}

function syncNode(detached, live, editorElement) {
    if (detached.editorPosition) detached.editorPosition.editorElement = editorElement;
    live.editorPosition = detached.editorPosition;
    if (detached.nodeType === 3 || detached.nodeType === 8) {
        if (live.data !== detached.data) live.data = detached.data;
        return;
    }
    syncAttributes(detached, live, false);
    if (!live.__cocreateEditor) reconcileMirror(detached, live, editorElement);
}

export function syncMirrorNode(detached) {
    const live = detached.liveNode;
    if (!live || !live.isConnected) return false;
    syncNode(detached, live, detached.editorPosition?.editorElement);
    return true;
}

export function reconcileMirror(detached, live, editorElement = detached.editorPosition?.editorElement) {
    if (!editorElement) {
        const doc = live.ownerDocument;
        editorElement = (live === doc.documentElement || live === doc.body)
            ? doc.defaultView.frameElement || live : live;
    }
    detached.liveNode = live;
    if (detached.editorPosition) detached.editorPosition.editorElement = editorElement;
    live.editorPosition = detached.editorPosition;
    if (detached.nodeType === 1 && live.ownerDocument.documentElement === live)
        syncAttributes(detached, live, true);
    let cursor = live.firstChild;
    for (const child of [...detached.childNodes]) {
        let target = child.liveNode;
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

export function reconcileDoctype(detached, live) {
    const before = live.doctype;
    const after = detached.doctype;
    if (before?.name === after?.name && before?.publicId === after?.publicId &&
        before?.systemId === after?.systemId) return;
    before?.remove();
    if (after) live.insertBefore(live.importNode(after, true), live.documentElement);
}
