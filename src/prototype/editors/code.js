import parseCode, { normalizeCodeLanguage } from "./parsers/code.js";
import { bindEditorDetailsLiveDOM } from "./utilities/createEditorDetails.js";

/** Build code editor state using the selected language parser. */
export async function createCodeEditor(source, language = "text", editor = null) {
    language = normalizeCodeLanguage(language);
    return { type: "code", language, source, details: await parseCode(source, language, editor), editor };
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
    pre.append(code);
    element.replaceChildren(pre);
}

export function getSource(element) {
    return element.textContent || "";
}

export { normalizeCodeLanguage, parseCode };
export default createCodeEditor;
