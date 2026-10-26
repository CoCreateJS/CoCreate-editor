import createTextEditor from "./text.js";
import createDOMEditor from "./dom.js";
import createMarkdownEditor from "./markdown.js";
import createCodeEditor from "./code.js";
import { updateEditorDetails } from "./utilities/updateEditorDetails.js";
import { bindEditorDetailsLiveDOM } from "./utilities/createEditorDetails.js";
import * as lengthEditorDetails from "./utilities/lengthEditorDetails.js";

const detailsByEditor = new WeakMap();

function assertEditorKey(editor) {
    if ((typeof editor !== "object" || editor === null) && typeof editor !== "function")
        throw new TypeError("Editor must be an object to use as a WeakMap key.");
}

function store(editor, state) {
    assertEditorKey(editor);
    detailsByEditor.set(editor, state.details);
    return state.details;
}

export function parseAndStoreEditorDetails(editor, source) {
    return store(editor, createDOMEditor(source, editor));
}

export function parseAndStoreTextDetails(editor, source) {
    return store(editor, createTextEditor(source, editor));
}

export function parseAndStoreMarkdownDetails(editor, source) {
    return store(editor, createMarkdownEditor(source, editor));
}

export async function parseAndStoreCodeDetails(editor, source, language = "text") {
    return store(editor, await createCodeEditor(source, language, editor));
}

export function getStoredEditorDetails(editor) {
    assertEditorKey(editor);
    return detailsByEditor.get(editor);
}

export function deleteStoredEditorDetails(editor) {
    assertEditorKey(editor);
    return detailsByEditor.delete(editor);
}

export function updateStoredEditorDetails(editor, update) {
    const details = getStoredEditorDetails(editor);
    if (!details) throw new Error("No prototype editor details are stored for this editor.");
    return updateEditorDetails(details, update);
}

export { createTextEditor, createDOMEditor, createMarkdownEditor, createCodeEditor };
export { lengthEditorDetails, updateEditorDetails, bindEditorDetailsLiveDOM };
