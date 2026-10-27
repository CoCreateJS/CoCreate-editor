import { setSelection } from "../selection.js";
export { getSelection, setSelection } from "../selection.js";

function isTextField(element) {
    return element?.tagName === "INPUT" || element?.tagName === "TEXTAREA" ||
        (!element?.ownerDocument && typeof element?.value === "string");
}

/** Plain text uses the native surface directly, without editor details. */
export function createTextEditor(source, editor = null) {
    if (typeof source !== "string") throw new TypeError("Text source must be a string.");
    return { type: "text", source, editor };
}

export function renderEditor(element, source) {
    if (!element) return;
    if (isTextField(element)) {
        if (element.value !== source) element.value = source;
        return;
    }
    if (!element.ownerDocument) return;
    let text = element.firstChild;
    const existingPlaceholder = element.childNodes.length === 2 &&
        element.lastChild?.nodeName === "BR" ? element.lastChild : null;
    if (text?.nodeType !== 3 || (element.childNodes.length !== 1 && !existingPlaceholder)) {
        text = element.ownerDocument.createTextNode(source);
        element.replaceChildren(text);
    } else if (text.data !== source) {
        // A native input has already changed this node. Reassigning even the
        // same data resets the browser's caret, so only write incoming changes.
        text.data = source;
    }
    // Chromium does not create the trailing empty line box for a final LF in
    // contenteditable text. This placeholder gives the caret a real next line;
    // textContent still contains only the source newline.
    const placeholder = element.lastChild?.nodeName === "BR" ? element.lastChild : null;
    if (source.endsWith("\n")) {
        if (!placeholder) element.append(element.ownerDocument.createElement("br"));
    } else placeholder?.remove();
}

/** Apply an incoming source update; native local edits need no second write. */
export function updateEditor(element, update, previousSource) {
    const { start, value } = update;
    const end = Number.isInteger(update.end) ? update.end : start + update.length;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start ||
        end > previousSource.length || typeof value !== "string")
        throw new RangeError("Text update must contain a valid source range and string value.");
    const source = previousSource.slice(0, start) + value + previousSource.slice(end);
    if (typeof update.string === "string" && update.string !== source)
        throw new RangeError("CRDT update does not match the previous text value.");
    renderEditor(element, source);
    return { previousSource, source };
}

export function getSource(element) {
    return isTextField(element) ? element.value : element.textContent || "";
}

/** Keep native paragraph markup out of the plain-text source and offsets. */
export function beforeInput(element, event, selection) {
    if (isTextField(element) || !event.cancelable || event.defaultPrevented || event.isComposing ||
        event.target !== element || !selection ||
        !["insertParagraph", "insertLineBreak"].includes(event.inputType)) return;
    event.preventDefault();
    const source = getSource(element);
    renderEditor(element, source.slice(0, selection.start) + "\n" + source.slice(selection.end));
    setSelection(element, { start: selection.start + 1 });
    const InputEvent = element.ownerDocument.defaultView.InputEvent;
    element.dispatchEvent(new InputEvent("input", {
        bubbles: true, inputType: event.inputType, data: "\n"
    }));
}

export default createTextEditor;
