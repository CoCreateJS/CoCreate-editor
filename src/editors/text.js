import { boundaryFor, boundarySelector, getSelection, isNative, project } from "../selection.js";

// Apply CRDT's canonical text silently, preserving the current selection.
export function updateTextElement(element, string, change) {
    const native = isNative(element);
    const root = element.tagName === "IFRAME" ? element.contentDocument.body : element;
    const view = native ? null : project(root);
    const before = native ? element.value : view.text;
    if (before === string) return;

    let start = 0, end = before.length, after = string.length;
    if (change && before.slice(0, change.start) + (change.value ?? "") +
        before.slice(change.start + (change.length || 0)) === string) {
        start = change.start;
        end = start + (change.length || 0);
        after = start + (change.value?.length || 0);
    } else {
        // Reconcile browser-applied edits against CRDT's canonical string if needed.
        while (start < end && start < after && before[start] === string[start]) start++;
        while (end > start && after > start && before[end - 1] === string[after - 1]) { end--; after--; }
    }
    const value = string.slice(start, after);
    const position = offset => offset < start ? offset : offset >= end
        ? offset + value.length - (end - start) : start + value.length;

    if (native) {
        const selection = getSelection(element);
        const direction = element.selectionDirection;
        if (!selection) element.value = string;
        else {
            element.setRangeText(value, start, end, "preserve");
            element.setSelectionRange(position(selection.start), position(selection.end), direction);
        }
        return;
    }

    const doc = root.ownerDocument;
    const active = doc.activeElement;
    const selection = (active === root || root.contains(active)) ? getSelection(element) : null;
    if (root.childNodes.length === 1 && root.firstChild.nodeType === 3) {
        root.firstChild.replaceData(start, end - start, value);
    } else {
        // Browser-created line wrappers are presentation, not HTML source in text mode.
        // Retain independent nested surfaces when their placeholder is outside the edit.
        const children = [];
        let offset = 0;
        for (const node of root.querySelectorAll(boundarySelector)) {
            if (boundaryFor(node.parentElement, root)) continue;
            const previous = view.points.get(node)?.[0];
            if (previous === undefined || (previous >= start && previous < end)) continue;
            const next = position(previous);
            if (string[next] !== "\uFFFC") continue;
            if (next > offset) children.push(doc.createTextNode(string.slice(offset, next)));
            children.push(node);
            offset = next + 1;
        }
        if (offset < string.length || !children.length) children.push(doc.createTextNode(string.slice(offset)));
        root.replaceChildren(...children);
    }
    if (selection) {
        const point = offset => {
            let index = 0;
            for (const node of root.childNodes) {
                const length = node.nodeType === 3 ? node.length : 1;
                if (node.nodeType === 3 && offset <= length) return [node, offset];
                if (node.nodeType !== 3 && offset <= 1) return [root, index + offset];
                offset -= length;
                index++;
            }
            return [root, root.childNodes.length];
        };
        const [anchor, anchorOffset] = point(position(selection.anchor));
        const [head, headOffset] = point(position(selection.head));
        doc.getSelection().setBaseAndExtent(anchor, anchorOffset, head, headOffset);
    }
}
