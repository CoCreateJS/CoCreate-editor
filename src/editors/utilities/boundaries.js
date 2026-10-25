// Explicit surfaces own their content; inherited contenteditable does not create one.
export const boundarySelector =
    "input, textarea, select, button, iframe, [contenteditable], [editor], [editor-language]";
export const isNative = element => ["INPUT", "TEXTAREA"].includes(element.tagName);
export const surface = element => element.tagName === "IFRAME"
    ? element.contentDocument?.documentElement : element;
export function boundaryFor(node, root) {
    if (!node || !root.contains(node)) return null;
    let element = node?.nodeType === 1 ? node : node?.parentElement;
    while (element && element !== root) {
        if (element.matches(boundarySelector)) return element;
        element = element.parentElement;
    }
    return null;
}
export const isBoundary = (node) =>
    node?.nodeType === 1 && node.matches(boundarySelector);
export function boundaryIdentity(node) {
    return JSON.stringify([
        node.tagName,
        ...["id", "array", "object", "key", "editor", "contenteditable"].map(
            (name) => node.getAttribute(name)
        )
    ]);
}
export function selectionBoundary(root) {
    const selection = root.ownerDocument.defaultView.getSelection();
    return boundaryFor(selection?.focusNode, root);
}
export function ownsFocus(element) {
    const host = surface(element);
    if (!host) return false;
    const doc = host.ownerDocument;
    if (!doc.hasFocus() || boundaryFor(doc.activeElement, host)) return false;
    if (isNative(element)) return doc.activeElement === element;
    const selection = doc.getSelection();
    if (boundaryFor(selection?.anchorNode, host) || selectionBoundary(host)) return false;
    return doc.activeElement === host || host.contains(doc.activeElement);
}
