import parseDOM, { isVoidElement } from "./parsers/dom.js";
import { matchCompleteDOMElements } from "./parsers/matchDOMTag.js";
import { createEditorsFromRecords } from "./utilities/createEditor.js";
import { updateEditorDetails } from "./utilities/updateEditorDetails.js";
import { planDOMEdit } from "./utilities/planDOMEdit.js";
import { renderDOM } from "./utilities/renderDOM.js";
import { bindDOMSource, getDOMSource, getDOMSelection, setDOMSelection,
    clearDOMSelection, beforeDOMInput, prepareDOMRender, releaseDOMSource,
    setDOMSelectionOverride } from "./utilities/domSource.js";

/** DOM parsing and edit planning share the same length-only detail contract. */
export function createDOMEditor(source, editor = null) {
    return { type: "dom", source,
        details: createEditorsFromRecords(parseDOM(source), editor, { dom: true }),
        element: editor, update: updateDOMEditorDetails };
}

export function updateDOMEditorDetails(details, update, { editor = details[0]?.element, parse } = {}) {
    const parseDetails = parse || (source =>
        createEditorsFromRecords(parseDOM(source), editor, { dom: true }));
    const result = updateEditorDetails(details, update, {
        editor, parse: parseDetails,
        planner: (items, start, end, value, context) => planDOMEdit(items, start, end, value,
            { ...context, editor, parse: parseDetails }),
        render(element, plan) {
            prepareDOMRender(element, plan);
            const result = renderDOM(element, plan);
            if (element) bindDOMSource(element, plan.editorDetails);
            return result;
        }
    });
    if (update?.local && update.value === ">") {
        const caret = update.start + update.value.length;
        const completed = matchCompleteDOMElements(result.source, update.start, caret)
            .filter(item => !isVoidElement(item.tag) && item.end === caret)
            .sort((a, b) => b.start - a.start)[0];
        if (completed) {
            let position = 0;
            const target = result.editorDetails.find(detail => {
                const matches = position === completed.start && detail.kind === "element" &&
                    detail.tag === completed.tag;
                position += detail.length;
                return matches;
            });
            if (target?.liveNode?.parentNode) {
                const parent = target.liveNode.parentNode;
                const index = [...parent.childNodes].indexOf(target.liveNode);
                setDOMSelectionOverride(editor, parent, completed.end, index + 1);
            }
        }
    }
    return result;
}

export function renderEditor(element, source, details) {
    const result = renderDOM(element, { editorDetails: details });
    bindDOMSource(element, details);
    return result;
}

export function getInputElement(element) {
    return element?.tagName === "IFRAME"
        ? element.editor?.liveNode || element.contentDocument?.body
        : element;
}

export { getDOMSource as getSource, getDOMSelection as getSelection,
    setDOMSelection as setSelection, clearDOMSelection as clearSelection,
    beforeDOMInput as beforeInput, releaseDOMSource as destroyEditor };

export { parseDOM };
export default createDOMEditor;
