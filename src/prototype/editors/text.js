import { createEditorDetailsCollection } from "./utilities/createEditorDetails.js";

/** Plain text has no syntax parser: its source is one text detail. */
export function createTextEditor(source, editor = null) {
    if (typeof source !== "string") throw new TypeError("Text source must be a string.");
    const collection = createEditorDetailsCollection({ editor, dom: false });
    if (source) collection.add({ kind: "text", nodeType: 3, value: source });
    return { type: "text", source, details: collection.toArray(), editor };
}

export default createTextEditor;
