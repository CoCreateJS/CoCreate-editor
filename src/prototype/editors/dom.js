import parseDOM, { isVoidElement } from "./parsers/dom.js";
import { matchCompleteDOMElements } from "./parsers/matchDOMTag.js";
import { createEditorDetailsFromRecords } from "./utilities/createEditorDetails.js";
import { updateEditorDetails } from "./utilities/updateEditorDetails.js";
import { planDOMEdit } from "./utilities/planDOMEdit.js";
import { renderDOM } from "./utilities/renderDOM.js";
import { bindDOMSource, getDOMSource, getDOMSelection, setDOMSelection,
    clearDOMSelection, beforeDOMInput, prepareDOMRender, releaseDOMSource,
    setDOMSelectionOverride } from "./utilities/domSource.js";

/** DOM parsing and edit planning share the same length-only detail contract. */
export function createDOMEditor(source, editor = null) {
    return { type: "dom", source,
        details: createEditorDetailsFromRecords(parseDOM(source), editor, { dom: true }),
        editor, update: updateDOMEditorDetails };
}

export function updateDOMEditorDetails(details, update, { editor = details[0]?.editor, parse } = {}) {
    const parseDetails = parse || (source =>
        createEditorDetailsFromRecords(parseDOM(source), editor, { dom: true }));
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
            if (target?.liveDOM) {
                const root = editor?.editor?.liveDOM || editor?.liveDOM || editor;
                if (completed.contentStart === completed.contentEnd)
                    setDOMSelectionOverride(root, target.liveDOM, completed.contentStart, 0);
                else if (target.liveDOM.parentNode) {
                    const parent = target.liveDOM.parentNode;
                    const index = [...parent.childNodes].indexOf(target.liveDOM);
                    setDOMSelectionOverride(root, parent, completed.end, index + 1);
                }
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

export { getDOMSource as getSource, getDOMSelection as getSelection,
    setDOMSelection as setSelection, clearDOMSelection as clearSelection,
    beforeDOMInput as beforeInput, releaseDOMSource as destroyEditor };

export { parseDOM };
export default createDOMEditor;
