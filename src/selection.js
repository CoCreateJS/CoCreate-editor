import { getSelectionRects } from "@cocreate/utils/selection";
import { pointAtSource } from "./editors/utilities/projection.js";

// Read-only source/DOM coordinates. This module never changes either DOM or selection.
export const boundarySelector = "input, textarea, select, button, iframe, [contenteditable], [editor], [editor-language]";
export const isNative = element => ["INPUT", "TEXTAREA"].includes(element.tagName);
export const surface = element => element.tagName === "IFRAME" ? element.contentDocument.documentElement : element;
export function boundaryFor(node, root) {
    let element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element || !root.contains(element)) return null;
    while (element !== root) {
        if (element.matches(boundarySelector)) return element;
        element = element.parentElement;
    }
    return null;
}
const blocks = new Set([
    "P",
    "DIV",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "PRE",
    "BLOCKQUOTE",
    "UL",
    "OL",
    "LI",
    "HR"
]);
export function project(root, source = "") {
    let text = "";
    const spans = [],
        points = new WeakMap();
    function append(value, map) {
        for (let i = 0; i < value.length; i++) {
            text += value[i];
            spans.push(map?.(i) ?? null);
        }
    }
    function walk(node) {
        if (node.nodeType === 3) {
            const base = Number(
                node.parentElement?.closest("[data-md-start]")?.dataset
                    .mdStart || 0
            );
            const start = text.length;
            points.set(
                node,
                Array.from({ length: node.length + 1 }, (_, i) => start + i)
            );
            append(
                node.data,
                node._sourceMap
                    ? (i) => node._sourceMap[i]
                    : node._mdMap
                      ? (i) => [
                            base + node._mdMap[i],
                            base + node._mdMap[i] + 1
                        ]
                      : null
            );
            return;
        }
        if (
            node.nodeType !== 1 ||
            node.hasAttribute("data-editor-placeholder") ||
            node.tagName === "HEAD" ||
            node.tagName === "SCRIPT" ||
            node.tagName === "STYLE"
        )
            return;
        const offsets = [text.length];
        points.set(node, offsets);
        if (
            node.nodeName === "BR" ||
            node.nodeName === "HR" ||
            node.hasAttribute("data-source-void") ||
            (node !== root && node.matches(boundarySelector))
        ) {
            append(
                node.nodeName === "BR" ? "\n" : "\uFFFC",
                node.hasAttribute("data-source-start")
                    ? () => [
                          Number(node.dataset.sourceStart),
                          Number(node.dataset.sourceAfter)
                      ]
                    : null
            );
            return;
        }
        let previous;
        for (const child of node.childNodes) {
            const placeholder =
                child.nodeType === 1 &&
                (child.hasAttribute("data-editor-placeholder") ||
                    (child.nodeName === "BR" &&
                        child === node.lastChild &&
                        !child.hasAttribute("data-source-void") &&
                        !child.hasAttribute("data-md-after")));
            if (placeholder) {
                points.set(child, [text.length]);
                offsets.push(text.length);
                continue;
            }
            if (
                previous &&
                (blocks.has(child.nodeName) || blocks.has(previous.nodeName)) &&
                !text.endsWith("\n")
            )
                append("\n");
            offsets[offsets.length - 1] = text.length;
            walk(child);
            offsets.push(text.length);
            previous = child;
        }
    }
    walk(root);
    // Synthetic line breaks span the source gap between adjacent rendered characters.
    let previous = 0;
    for (let i = 0; i < spans.length; i++) {
        if (spans[i]) {
            previous = spans[i][1];
            continue;
        }
        let j = i + 1;
        while (j < spans.length && !spans[j]) j++;
        spans[i] = [previous, j < spans.length ? spans[j][0] : source.length];
        previous = spans[i][1];
    }
    return { text, spans, points };
}
export function sourceAt(projection, position, end = false) {
    if (!projection.spans.length) return 0;
    if (end && position > 0)
        return projection.spans[
            Math.min(position, projection.spans.length) - 1
        ][1];
    return projection.spans[Math.min(position, projection.spans.length - 1)][
        position >= projection.spans.length ? 1 : 0
    ];
}

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

// Focus belongs to the editing surface, not an independent nested control.
export function ownsFocus(element) {
    const root = surface(element), doc = root.ownerDocument;
    if (!doc.hasFocus() || boundaryFor(doc.activeElement, root)) return false;
    if (isNative(element)) return doc.activeElement === element;
    const selection = doc.getSelection();
    if (boundaryFor(selection?.anchorNode, root) || boundaryFor(selection?.focusNode, root)) return false;
    return doc.activeElement === root || root.contains(doc.activeElement);
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
