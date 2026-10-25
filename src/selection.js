import { getSelectionRects } from "@cocreate/utils/selection";
import { pointAtSource, project, sourceAt } from "./editors/utilities/projection.js";
import { boundaryFor, isNative, surface } from "./editors/utilities/boundaries.js";

export { project, sourceAt } from "./editors/utilities/projection.js";
export { boundaryFor, boundarySelector, isNative, ownsFocus, surface } from "./editors/utilities/boundaries.js";

// Read-only source/DOM coordinates. This module never changes either DOM or selection.
export function sourceProjection(element, value = String(element.getValue?.() ?? element.value ?? "")) {
    const dom = element.editor?.dom;
    if (!dom) return null;
    return project(dom.nodeType === 9 ? dom.documentElement : dom, value);
}

// Prefer exact character ends, so typing at a line's end stays on that line.
export function sourceOffset(element, view, mapped, node, offset, end = false) {
    const visible = view.points.get(node)?.[offset];
    if (visible === undefined) return null;
    if (!mapped) return visible;
    if (!mapped.spans.length) {
        const dom = element.editor.dom;
        return Number((dom.body || dom).dataset?.sourceContentStart || 0);
    }
    if (node.nodeType === 3 && offset > 0 && (end || offset === node.length))
        return sourceAt(mapped, visible, true);
    return sourceAt(mapped, visible, end);
}

export function getSelection(element, range) {
    if (isNative(element)) {
        const start = element.selectionStart, end = element.selectionEnd;
        if (start === null || end === null) return null;
        const backward = element.selectionDirection === "backward";
        return { start, end, anchor: backward ? end : start, head: backward ? start : end };
    }
    const root = surface(element), doc = root.ownerDocument;
    const selection = range || doc.getSelection();
    if (!selection || (!range && !selection.rangeCount)) return null;
    const anchorNode = range ? range.startContainer : selection.anchorNode;
    const headNode = range ? range.endContainer : selection.focusNode;
    const anchorOffset = range ? range.startOffset : selection.anchorOffset;
    const headOffset = range ? range.endOffset : selection.focusOffset;
    if (!root.contains(anchorNode) || !root.contains(headNode) ||
        boundaryFor(anchorNode, root) || boundaryFor(headNode, root)) return null;
    const view = project(root), mapped = sourceProjection(element);
    const visibleAnchor = view.points.get(anchorNode)?.[anchorOffset];
    const visibleHead = view.points.get(headNode)?.[headOffset];
    const anchor = sourceOffset(element, view, mapped, anchorNode, anchorOffset, visibleAnchor > visibleHead);
    const head = sourceOffset(element, view, mapped, headNode, headOffset, visibleHead > visibleAnchor);
    if (anchor === null || head === null) return null;
    return { start: Math.min(anchor, head), end: Math.max(anchor, head), anchor, head,
        visibleStart: Math.min(visibleAnchor, visibleHead), visibleEnd: Math.max(visibleAnchor, visibleHead) };
}

export function getEditorRange(element, start, end = start) {
    const root = surface(element);
    const from = pointAtSource(root, start);
    const to = pointAtSource(root, end);
    const range = root.ownerDocument.createRange();
    range.setStart(from[0], from[1]);
    range.setEnd(to[0], to[1]);
    return range;
}

export function getEditorSelectionRects(element, anchor, head = anchor) {
    return getSelectionRects(element, anchor, head,
        (host, start, end) => getEditorRange(element, start, end));
}
