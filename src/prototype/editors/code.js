import parseCode, { normalizeCodeLanguage } from "./parsers/code.js";

/** Build code editor state using the selected language parser. */
export async function createCodeEditor(source, language = "text", editor = null) {
    language = normalizeCodeLanguage(language);
    return { type: "code", language, source, details: await parseCode(source, language, editor), editor };
}

export { normalizeCodeLanguage, parseCode };
export default createCodeEditor;
