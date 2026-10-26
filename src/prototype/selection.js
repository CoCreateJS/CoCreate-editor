/** UTF-16 selection offsets for native text fields and plain text surfaces. */
export function getSelection(element) {
    if (Number.isInteger(element?.selectionStart) && Number.isInteger(element?.selectionEnd))
        return { start: element.selectionStart, end: element.selectionEnd };
    const root = element?.editor?.liveDOM || element;
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

export default getSelection;
