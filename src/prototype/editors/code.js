import parseCode, { loadCodeLanguage, normalizeCodeLanguage, resolveCodeLanguage } from "./parsers/code.js";
import { createLanguageDetails } from "./parsers/language/createLanguageDetails.js";
import { bindEditorDetailsLiveDOM, createEditorDetailsFromRecords } from "./utilities/createEditorDetails.js";
import { getSelection as readSelection, setSelection as restoreSelection } from "../selection.js";

/** Build code editor state using the selected language parser. */
export async function createCodeEditor(source, language, editor = null) {
    language = resolveCodeLanguage(source, language);
    const parser = await loadCodeLanguage(language);
    const parse = value => createEditorDetailsFromRecords(parser
        ? parser.parseCode(value)
        : createLanguageDetails(value, language, []), editor);
    return {
        type: "code",
        language,
        source,
        details: parse(source, editor),
        editor,
        update: (details, update, context = {}) => updateCodeEditorDetails(details, update, {
            editor: context.editor || editor,
            parse
        })
    };
}

export function renderEditor(element, source, details) {
    const document = element.ownerDocument;
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    for (const detail of details) {
        if (detail.token) {
            const span = document.createElement("span");
            span.className = `token-${detail.token}`;
            const text = document.createTextNode(detail.value);
            span.append(text);
            code.append(span);
            bindEditorDetailsLiveDOM(detail, text);
        } else {
            const text = document.createTextNode(detail.value);
            code.append(text);
            bindEditorDetailsLiveDOM(detail, text);
        }
    }
    // Keep the caret on a visible empty line after a terminal source newline.
    // BR contributes no text, so source offsets remain the LF's UTF-16 offsets.
    if (/[\r\n]$/.test(source)) code.append(document.createElement("br"));
    pre.append(code);
    element.replaceChildren(pre);
}

export function getSource(element) {
    return element.textContent || "";
}

function insertSourceText(element, range, value, inputType) {
    if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end)) return;
    const source = getSource(element);
    const next = source.slice(0, range.start) + value + source.slice(range.end);
    element.textContent = next;
    restoreSelection(element, { start: range.start + value.length });
    const view = element.ownerDocument.defaultView;
    const inputEvent = view?.InputEvent
        ? new view.InputEvent("input", { bubbles: true, inputType, data: value })
        : new view.Event("input", { bubbles: true });
    element.dispatchEvent(inputEvent);
    // The input listener may synchronously re-tokenize and replace the spans.
    restoreSelection(element, { start: range.start + value.length });
}

/** Keep contenteditable paragraph markup out of code source and CRDT offsets. */
export function beforeInput(element, event, selection) {
    if (!element?.ownerDocument || !event.cancelable || event.defaultPrevented || event.isComposing ||
        (event.target !== element && !element.contains(event.target))) return;
    const isParagraph = ["insertParagraph", "insertLineBreak"].includes(event.inputType);
    const value = isParagraph ? "\n"
        : event.inputType === "insertText" && typeof event.data === "string" && /[\r\n]/.test(event.data)
            ? event.data.replace(/\r\n?/g, "\n") : null;
    const range = selection || readSelection(element);
    if (!value || !range || !Number.isInteger(range.start) || !Number.isInteger(range.end)) return;
    event.preventDefault();
    // The regular input pipeline submits this source change to the CRDT, which
    // then tokenizes and renders the canonical highlighted view.
    insertSourceText(element, range, value, event.inputType);
}

/** Insert a literal tab instead of letting the browser move focus. */
export function keyDown(element, event, selection) {
    if (event.key !== "Tab" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey ||
        !event.cancelable || event.defaultPrevented || event.isComposing ||
        (event.target !== element && !element.contains(event.target))) return;
    event.preventDefault();
    insertSourceText(element, selection || readSelection(element), "\t", "insertText");
}

/** Re-tokenize an updated source value and restore the rendered code projection. */
export function updateCodeEditorDetails(details, update, { editor, parse } = {}) {
    if (!Array.isArray(details) || typeof parse !== "function")
        throw new TypeError("Code updates require stored details and their language parser.");
    const { start, value } = update || {};
    const end = Number.isInteger(update?.end) ? update.end
        : Number.isInteger(update?.length) ? start + update.length : NaN;
    const previousSource = details.map(detail => detail.value).join("");
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start ||
        end > previousSource.length || typeof value !== "string")
        throw new RangeError("Code update must contain a valid source range and string value.");
    const source = previousSource.slice(0, start) + value + previousSource.slice(end);
    if (typeof update.string === "string" && update.string !== source)
        throw new RangeError("Code update does not match the stored source.");
    const editorDetails = parse(source, editor);
    if (editor?.ownerDocument) renderEditor(editor, source, editorDetails);
    return { previousSource, source, editorDetails, start, end, value };
}

export function getSelection(element) {
    return readSelection(element);
}

export function setSelection(element, selection) {
    return restoreSelection(element, selection);
}

export { normalizeCodeLanguage, parseCode };
export default createCodeEditor;
