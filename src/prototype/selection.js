/** UTF-16 selection offsets for native text fields and plain text surfaces. */
export function getSelection(element) {
    if (Number.isInteger(element?.selectionStart) && Number.isInteger(element?.selectionEnd))
        return { start: element.selectionStart, end: element.selectionEnd };
    const root = element?.editor?.liveNode || element;
    const selection = root?.ownerDocument?.getSelection?.();
    if (!selection?.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode))
        return null;
    const offsetOf = (target, targetOffset) => {
        const range = root.ownerDocument.createRange();
        try {
            range.selectNodeContents(root);
            range.setEnd(target, targetOffset);
            return range.toString().length;
        } catch {
            return null;
        }
    };
    const anchor = offsetOf(selection.anchorNode, selection.anchorOffset);
    const focus = offsetOf(selection.focusNode, selection.focusOffset);
    return anchor === null || focus === null ? null : {
        start: Math.min(anchor, focus), end: Math.max(anchor, focus), anchor, head: focus
    };
}

export function setSelection(element, { start, end = start } = {}) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start)
        return false;
    if (typeof element?.setSelectionRange === "function") {
        element.setSelectionRange(start, end);
        return true;
    }
    const root = element?.editor?.liveNode || element;
    const doc = root?.ownerDocument;
    if (!doc?.createTreeWalker || !doc.getSelection) return false;
    const point = offset => {
        const walker = doc.createTreeWalker(root, 4);
        let node;
        while ((node = walker.nextNode())) {
            if (offset <= node.data.length) return [node, offset];
            offset -= node.data.length;
        }
        const last = root.lastChild;
        return last?.nodeType === 3 ? [last, last.data.length] : [root, root.childNodes.length];
    };
    const [startNode, startOffset] = point(start);
    const [endNode, endOffset] = point(end);
    const range = doc.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
}

export default getSelection;
