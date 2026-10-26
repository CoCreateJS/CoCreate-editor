import parseDOM from "./parsers/dom.js";
import { updateEditorDetails } from "./utilities/updateEditorDetails.js";
import { planDOMEdit } from "./utilities/planDOMEdit.js";
import { renderDOM } from "./utilities/renderDOM.js";

/** DOM parsing and edit planning share the same length-only detail contract. */
export function createDOMEditor(source, editor = null) {
    return { type: "dom", source, details: parseDOM(source, editor), editor, update: updateDOMEditorDetails };
}

export function updateDOMEditorDetails(details, update, { editor = details[0]?.editor, parse } = {}) {
    return updateEditorDetails(details, update, {
        editor,
        planner: (items, start, end, value, context) => planDOMEdit(items, start, end, value, { ...context, editor, parse }),
        render: renderDOM
    });
}

export function renderEditor(element, source, details) {
    return renderDOM(element, { editorDetails: details });
}

export function getSource(element) {
    return element.innerHTML;
}

export { parseDOM };
export default createDOMEditor;
