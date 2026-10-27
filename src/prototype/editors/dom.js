import parseDOM from "./parsers/dom.js";
import { updateEditorDetails } from "./utilities/updateEditorDetails.js";
import { planDOMEdit } from "./utilities/planDOMEdit.js";
import { renderDOM } from "./utilities/renderDOM.js";
import { bindDOMSource, getDOMSource, getDOMSelection, setDOMSelection,
    clearDOMSelection, prepareDOMRender, releaseDOMSource } from "./utilities/domSource.js";

/** DOM parsing and edit planning share the same length-only detail contract. */
export function createDOMEditor(source, editor = null) {
    return { type: "dom", source, details: parseDOM(source, editor), editor, update: updateDOMEditorDetails };
}

export function updateDOMEditorDetails(details, update, { editor = details[0]?.editor, parse } = {}) {
    return updateEditorDetails(details, update, {
        editor,
        planner: (items, start, end, value, context) => planDOMEdit(items, start, end, value, { ...context, editor, parse }),
        render(element, plan) {
            prepareDOMRender(element, plan);
            const result = renderDOM(element, plan);
            if (element) bindDOMSource(element, plan.editorDetails);
            return result;
        }
    });
}

export function renderEditor(element, source, details) {
    const result = renderDOM(element, { editorDetails: details });
    bindDOMSource(element, details);
    return result;
}

export { getDOMSource as getSource, getDOMSelection as getSelection,
    setDOMSelection as setSelection, clearDOMSelection as clearSelection, releaseDOMSource as destroyEditor };

export { parseDOM };
export default createDOMEditor;
