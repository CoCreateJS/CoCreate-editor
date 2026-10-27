/**
 * Small browser entry point. Editor runtime and parser implementations are
 * fetched only when a matching editor appears or a parser API is called.
 */

import "./index.css";

const editorSelector = ":is([editor], [editor-language], [contenteditable]):not([contenteditable='false']):not([editor-query]), input[editor-query], textarea[editor-query], input[realtime][array][object][key], textarea[realtime][array][object][key], input[crdt='true'][array][object][key], textarea[crdt='true'][array][object][key]";
const parserLoaders = {
    dom: () => import(/* webpackChunkName: "editor-parser-dom" */ "./editors/parsers/dom.js"),
    markdown: () => import(/* webpackChunkName: "editor-parser-markdown" */ "./editors/parsers/markdown.js"),
    code: () => import(/* webpackChunkName: "editor-parser-code" */ "./editors/parsers/code.js")
};

let runtimePromise;
let runtimeModule;
const parserPromises = new Map();

function loadRuntime() {
    runtimePromise ||= import(/* webpackChunkName: "editor-runtime" */ "./index.js")
        .then(module => { runtimeModule = module; return module; })
        .catch(error => { runtimePromise = undefined; throw error; });
    return runtimePromise;
}

export function loadParser(type) {
    const loader = parserLoaders[type];
    if (!loader) return Promise.reject(new TypeError(`Unknown editor parser: ${type}`));
    if (!parserPromises.has(type)) {
        parserPromises.set(type, loader().catch(error => {
            parserPromises.delete(type);
            throw error;
        }));
    }
    return parserPromises.get(type);
}

function callRuntime(name, args) {
    return loadRuntime().then(module => {
        const method = module.default?.[name] || module[name];
        if (typeof method !== "function") throw new TypeError(`Unknown editor API: ${name}`);
        return method(...args);
    });
}

export const parseDOM = async source => (await loadParser("dom")).default(source);
export const parseMarkdown = async source => (await loadParser("markdown")).default(source);
export const parseCode = async (source, language) => (await loadParser("code")).parseCode(source, language);
export const autoLanguageDetection = async source => (await loadParser("code")).autoLanguageDetection(source);

export const init = (...args) => callRuntime("init", args);
export const initElements = (...args) => callRuntime("initElements", args);
export const initElement = (...args) => callRuntime("initElement", args);
export const initEditorInput = (...args) => callRuntime("initEditorInput", args);
export const uninitEditorInput = (...args) => callRuntime("uninitEditorInput", args);
export const destroyEditor = (...args) => callRuntime("destroyEditor", args);
export const sendPosition = (...args) => callRuntime("sendPosition", args);
export const updateText = (...args) => callRuntime("updateText", args);
export const updateElement = (...args) => callRuntime("updateElement", args);
export const loadEditor = (...args) => callRuntime("loadEditor", args);
export const createTextEditor = (...args) => callRuntime("createTextEditor", args);
export const createDOMEditor = (...args) => callRuntime("createDOMEditor", args);
export const createMarkdownEditor = (...args) => callRuntime("createMarkdownEditor", args);
export const createCodeEditor = (...args) => callRuntime("createCodeEditor", args);
export const parseAndStoreEditorDetails = (...args) => callRuntime("parseAndStoreEditorDetails", args);
export const parseAndStoreMarkdownDetails = (...args) => callRuntime("parseAndStoreMarkdownDetails", args);
export const parseAndStoreCodeDetails = (...args) => callRuntime("parseAndStoreCodeDetails", args);
export const updateStoredEditorDetails = (...args) => callRuntime("updateStoredEditorDetails", args);
export const getStoredEditorDetails = editor => runtimeModule?.default?.getStoredEditorDetails?.(editor);
export const deleteStoredEditorDetails = (...args) => callRuntime("deleteStoredEditorDetails", args);

function reportError(element, error) {
    const EventConstructor = element.ownerDocument?.defaultView?.CustomEvent || globalThis.CustomEvent;
    if (EventConstructor) element.dispatchEvent(new EventConstructor("editor-error", {
        bubbles: true, detail: { error }
    }));
}

function matchesEditor(node) {
    return node?.nodeType === 1 && node.matches?.(editorSelector);
}

function activate(node) {
    if (matchesEditor(node)) loadRuntime().catch(error => reportError(node, error));
    node?.querySelectorAll?.(editorSelector).forEach(element =>
        loadRuntime().catch(error => reportError(element, error)));
}

function observeDocument() {
    if (typeof document === "undefined" || !document.documentElement) return;
    activate(document.documentElement);
    const Observer = document.defaultView?.MutationObserver || globalThis.MutationObserver;
    if (!Observer) return;
    const observer = new Observer(records => {
        for (const record of records) {
            if (record.type === "attributes") activate(record.target);
            else for (const node of record.addedNodes) activate(node);
        }
    });
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["editor", "editor-language", "contenteditable", "editor-query",
            "realtime", "array", "object", "key", "crdt"]
    });
}

if (typeof document !== "undefined") {
    if (document.readyState === "loading")
        document.addEventListener("DOMContentLoaded", observeDocument, { once: true });
    else queueMicrotask(observeDocument);
}

const prototype = {
    init, initElements, initElement, initEditorInput, uninitEditorInput, destroyEditor,
    sendPosition, updateText, updateElement, loadEditor, loadParser, parseDOM,
    parseMarkdown, parseCode, autoLanguageDetection, createTextEditor, createDOMEditor,
    createMarkdownEditor, createCodeEditor, parseAndStoreEditorDetails,
    parseAndStoreMarkdownDetails, parseAndStoreCodeDetails, updateStoredEditorDetails,
    getStoredEditorDetails, deleteStoredEditorDetails
};

export default prototype;
