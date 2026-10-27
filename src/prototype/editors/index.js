import { updateEditorDetails } from "./utilities/updateEditorDetails.js";
import { bindEditorNode } from "./utilities/createEditor.js";
import * as lengthEditorDetails from "./utilities/lengthEditorDetails.js";

const detailsByEditor = new WeakMap();
const updatesByEditor = new WeakMap();
const editorLoaders = {
    text: () => import("./text.js"),
    dom: () => import("./dom.js"),
    markdown: () => import("./markdown.js"),
    code: () => import("./code.js")
};
const parserLoaders = {
    dom: () => import("./parsers/dom.js"),
    markdown: () => import("./parsers/markdown.js"),
    code: () => import("./parsers/code.js")
};
const editorModuleCache = new Map();
const parserModuleCache = new Map();

function assertEditorKey(editor) {
    if ((typeof editor !== "object" || editor === null) && typeof editor !== "function")
        throw new TypeError("Editor must be an object to use as a WeakMap key.");
}

function load(type, loaders, cache) {
    const loader = loaders[type];
    if (!loader) throw new TypeError(`Unknown prototype editor or parser: ${type}`);
    if (!cache.has(type)) {
        const pending = loader().catch(error => {
            cache.delete(type);
            throw error;
        });
        cache.set(type, pending);
    }
    return cache.get(type);
}

function store(editor, state) {
    assertEditorKey(editor);
    detailsByEditor.set(editor, state.details);
    if (state.update) updatesByEditor.set(editor, state.update);
    else updatesByEditor.delete(editor);
    return state.details;
}

export function loadEditor(type) {
    return load(type, editorLoaders, editorModuleCache);
}

export function loadParser(type) {
    return load(type, parserLoaders, parserModuleCache);
}

export function normalizeCodeLanguage(language) {
    const aliases = { js: "javascript", py: "python", ts: "typescript", sh: "bash", yml: "yaml" };
    const value = String(language || "text").trim().toLowerCase();
    return aliases[value] || value;
}

export async function parseDOM(source) {
    const parser = await loadParser("dom");
    return parser.default(source);
}

export async function parseMarkdown(source) {
    const parser = await loadParser("markdown");
    return parser.default(source);
}

export async function parseCode(source, language) {
    const parser = await loadParser("code");
    return parser.parseCode(source, language);
}

export async function autoLanguageDetection(source) {
    const parser = await loadParser("code");
    return parser.autoLanguageDetection(source);
}

export async function createTextEditor(source, editor = null) {
    const module = await loadEditor("text");
    return module.createTextEditor(source, editor);
}

export async function createDOMEditor(source, editor = null) {
    const module = await loadEditor("dom");
    return module.createDOMEditor(source, editor);
}

export async function createMarkdownEditor(source, editor = null) {
    const module = await loadEditor("markdown");
    return module.createMarkdownEditor(source, editor);
}

export async function createCodeEditor(source, language, editor = null) {
    const module = await loadEditor("code");
    return module.createCodeEditor(source, language, editor);
}

export async function parseAndStoreEditorDetails(editor, source) {
    return store(editor, await createDOMEditor(source, editor));
}

export async function parseAndStoreMarkdownDetails(editor, source) {
    return store(editor, await createMarkdownEditor(source, editor));
}

export async function parseAndStoreCodeDetails(editor, source, language) {
    return store(editor, await createCodeEditor(source, language, editor));
}

export function getStoredEditorDetails(editor) {
    assertEditorKey(editor);
    return detailsByEditor.get(editor);
}

export function deleteStoredEditorDetails(editor) {
    assertEditorKey(editor);
    updatesByEditor.delete(editor);
    return detailsByEditor.delete(editor);
}

export function updateStoredEditorDetails(editor, update) {
    const details = getStoredEditorDetails(editor);
    if (!details) throw new Error("No prototype editor details are stored for this editor.");
    const updateDetails = updatesByEditor.get(editor) || updateEditorDetails;
    const result = updateDetails(details, update, { editor });
    if (result && typeof result.then === "function") return result.then(updated => {
        if (updated.editorDetails) detailsByEditor.set(editor, updated.editorDetails);
        return updated;
    });
    if (result.editorDetails) detailsByEditor.set(editor, result.editorDetails);
    return result;
}

export { lengthEditorDetails, updateEditorDetails, bindEditorNode };
