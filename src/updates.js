import { getSelection, ownsFocus } from "./selection.js";
import createHTMLDOM from "./editors/html.js";
import createMarkdownDOM from "./editors/markdown.js";
import createCodeDOM from "./editors/code.js";
import { pointAtSource, reconcile } from "./editors/utilities/projection.js";
import { reconcileDocument } from "./editors/utilities/document.js";
import { reconcileMirror, reconcileDoctype, syncMirrorNode } from "./editors/utilities/mirror.js";
import { affectedPath, outermostChanges } from "./editors/utilities/affected.js";
import { brokenHTMLRanges } from "./editors/utilities/recovery.js";

function liveRoot(element, html = false) {
    if (element.tagName !== "IFRAME") return element;
    return html ? element.contentDocument.documentElement : element.contentDocument.body;
}

function sourceChange(previous, string) {
    let start = 0;
    while (start < previous.length && start < string.length && previous[start] === string[start]) start++;
    let oldEnd = previous.length, newEnd = string.length;
    while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === string[newEnd - 1]) {
        oldEnd--; newEnd--;
    }
    return { start, length: oldEnd - start, value: string.slice(start, newEnd) };
}

function normalizedChange(change) {
    const { previous, string, start, length, value, operation } = change;
    const sameOperation = typeof previous === "string" && !!operation && operation.start === start &&
        operation?.length === length && operation?.value === value;
    const matchesContext = !sameOperation || (
        (operation.removedValue === undefined ||
            operation.removedValue === previous.slice(start, start + length)) &&
        (operation.previousCharacter === undefined ||
            operation.previousCharacter === (previous[start - 1] ?? "")) &&
        (operation.nextCharacter === undefined ||
            operation.nextCharacter === (previous[start + length] ?? ""))
    );
    if (
        typeof previous === "string" && Number.isInteger(start) &&
        Number.isInteger(length) && start >= 0 && length >= 0 &&
        start + length <= previous.length && typeof value === "string" && matchesContext &&
        previous.slice(0, start) + value + previous.slice(start + length) === string
    ) return change;

    return { ...change, ...sourceChange(String(previous ?? ""), string) };
}

function mapPosition(position, { start, length = 0, value = "" }) {
    if (position < start) return position;
    if (position >= start + length) return position + value.length - length;
    return start + value.length;
}

function selectionFor(element) {
    return ownsFocus(element) ? getSelection(element) : null;
}

function restoreSelection(detached, selection, change) {
    if (!selection) return;
    const anchor = mapPosition(selection.anchor, change);
    const head = mapPosition(selection.head, change);
    const [anchorNode, anchorOffset] = pointAtSource(detached, anchor);
    const [headNode, headOffset] = pointAtSource(detached, head);
    const liveAnchor = anchorNode.liveNode;
    const liveHead = headNode.liveNode;
    if (liveAnchor && liveHead)
        liveAnchor.ownerDocument.getSelection().setBaseAndExtent(liveAnchor, anchorOffset, liveHead, headOffset);
}

function applyToLive(root, live, path, changed) {
    for (const node of outermostChanges(root, path, changed)) {
        if (node === root || !node.liveNode || !live.contains(node.liveNode) ||
            !syncMirrorNode(node)) {
            reconcileMirror(root, live);
            return;
        }
    }
}

function updateProjection(element, change, render) {
    const { string } = change;
    change = normalizedChange(change);
    const selection = selectionFor(element);
    const staging = render(string);
    const detached = element.editor.dom;
    const path = detached ? affectedPath(detached, change) : [staging];
    const changed = new Set();
    if (detached) reconcile(detached, staging, changed);
    else element.editor.dom = staging;

    const live = liveRoot(element);
    applyToLive(element.editor.dom, live, path, changed);
    restoreSelection(element.editor.dom, selection, change);
    element.editor.inputValue = string;
    element.value = string;
    if (element.hasAttribute("value")) element.setAttribute("value", string);
}

export function updateMarkdown(element, change) {
    updateProjection(element, change, createMarkdownDOM);
}

export function updateCode(element, change) {
    const language = element.getAttribute("editor-language")?.trim().toLowerCase() || "text";
    updateProjection(element, change, source => createCodeDOM(source, undefined, language));
}

export function updateHTML(element, change) {
    const { string } = change;
    change = normalizedChange(change);
    const selection = selectionFor(element);
    const oldRoot = element.tagName === "IFRAME"
        ? element.editor.dom?.documentElement : element.editor.dom?.body;
    let staging = createHTMLDOM(string, element.ownerDocument);
    const literalRanges = brokenHTMLRanges(oldRoot, staging, change);
    if (literalRanges.length)
        staging = createHTMLDOM(string, element.ownerDocument, undefined, literalRanges);
    const path = oldRoot ? affectedPath(oldRoot, change) : [];
    const changed = new Set();
    if (element.editor.dom) reconcileDocument(element.editor.dom, staging, changed);
    else element.editor.dom = staging;

    const live = liveRoot(element, true);
    if (element.tagName === "IFRAME" && live.contentEditable !== "false") live.contentEditable = "true";
    const stagedRoot = element.tagName === "IFRAME"
        ? element.editor.dom.documentElement : element.editor.dom.body;
    applyToLive(stagedRoot, live, path, changed);
    if (element.tagName === "IFRAME") reconcileDoctype(element.editor.dom, live.ownerDocument);
    restoreSelection(stagedRoot, selection, change);
    element.editor.inputValue = string;
    element.value = string;
    if (element.hasAttribute("value")) element.setAttribute("value", string);
}
