import { createEditorDetailsCollection } from "./utilities/createEditorDetails.js";
import { bindEditorDetailsLiveDOM } from "./utilities/createEditorDetails.js";

/** Plain text has no syntax parser: its source is one text detail. */
export function createTextEditor(source, editor = null) {
    if (typeof source !== "string") throw new TypeError("Text source must be a string.");
    const collection = createEditorDetailsCollection({ editor, dom: false });
    if (source) collection.add({ kind: "text", nodeType: 3, value: source });
    return { type: "text", source, details: collection.toArray(), editor };
}

export function renderEditor(element, source, details) {
    const text = element.ownerDocument.createTextNode(source);
    element.replaceChildren(text);
    if (details[0]) bindEditorDetailsLiveDOM(details[0], text);
}

export function getSource(element) {
    return element.textContent || "";
}

export default createTextEditor;
