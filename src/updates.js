import { getSelection, ownsFocus } from "./selection.js";
import { invalidatePositionIndex, pointAtSource } from "./editors/utilities/projection.js";
import { replaceMirror } from "./editors/utilities/mirror.js";
import { indexedSelection, applyIndexedDOM } from "./editors/utilities/indexedDOM.js";
import { getLiveNode } from "./editors/utilities/nodeData.js";
import { rebuildEditorDetails } from "./editors/utilities/details.js";

function projectionRoot(tree) {
    return tree?.nodeType === 9 ? tree.body : tree;
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
    return ownsFocus(element) ? indexedSelection(element) || getSelection(element) : null;
}

function restoreSelection(detached, selection, change) {
    if (!selection) return;
    const anchor = mapPosition(selection.anchor, change);
    const head = mapPosition(selection.head, change);
    const [anchorNode, anchorOffset] = pointAtSource(detached, anchor);
    const [headNode, headOffset] = pointAtSource(detached, head);
    const liveAnchor = getLiveNode(anchorNode);
    const liveHead = getLiveNode(headNode);
    if (liveAnchor && liveHead)
        liveAnchor.ownerDocument.getSelection().setBaseAndExtent(liveAnchor, anchorOffset, liveHead, headOffset);
}

// Each renderer supplies its syntax and tree shape; every update follows this lifecycle.
export function updateProjection(element, change, {
    render, root = projectionRoot, apply = applyIndexedDOM, prepareLive, afterMirror
}, reset = false) {
    const { string } = change;
    change = normalizedChange(change);
    const selection = selectionFor(element);
    const detached = reset ? null : element.editor.dom;
    const previousRoot = root(detached, element);
    const staging = render(string, element, change, previousRoot);
    if (detached) apply(detached, staging, element, change);
    else element.editor.dom = staging;

    const stagedRoot = root(element.editor.dom, element);
    invalidatePositionIndex(stagedRoot);
    const live = element.tagName === "IFRAME" ? root(element.contentDocument, element) : element;
    prepareLive?.(live, element);
    invalidatePositionIndex(live);
    if (!detached) {
        replaceMirror(stagedRoot, live, element);
        rebuildEditorDetails(element, stagedRoot);
    }
    afterMirror?.(stagedRoot, live, element);
    restoreSelection(stagedRoot, selection, change);
    element.editor.inputValue = string;
    element.value = string;
    if (element.hasAttribute("value")) element.setAttribute("value", string);
}
