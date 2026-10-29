/**
 * Small browser entry point. Editor runtime and parser implementations are
 * fetched only when a matching editor appears or a parser API is called.
 */

import "./index.css";
import * as lengthEditorDetails from "./editors/utilities/lengthEditorDetails.js";
import observer from "@cocreate/observer";
import { queryElements } from "@cocreate/utils";

const editorSelector = ":is([editor], [contenteditable], input[crdt='true'], textarea[crdt='true']):not([contenteditable='false']):not([editor-query])";
const bindingSelector = "[editor-query], [editor-attribute], [editor-property]";
const activationSelector = `${editorSelector}, ${bindingSelector}`;
const languageSelector = "code[language]";
const parserLoaders = {
    dom: () => import(/* webpackChunkName: "editor-parser-dom" */ "./editors/parsers/dom.js"),
    markdown: () => import(/* webpackChunkName: "editor-parser-markdown" */ "./editors/parsers/markdown.js"),
    code: () => import(/* webpackChunkName: "editor-parser-code" */ "./editors/parsers/code.js")
};

let runtimePromise;
let runtimeModule;
let inputBindingPromise;
const parserPromises = new Map();
const languageStates = new WeakMap();

function codeNodeFor(element) {
    if (element.matches?.("code")) return element;
    return null;
}

function isEditorTarget(element) {
    return !!element.closest?.(editorSelector);
}

function clearLanguage(element) {
    const code = codeNodeFor(element);
    const state = code && languageStates.get(code);
    if (!code || !state) return;
    languageStates.delete(code);
    code.replaceChildren(code.ownerDocument.createTextNode(code.textContent || ""));
}

function languageError(element, error) {
    const EventConstructor = element.ownerDocument?.defaultView?.CustomEvent || globalThis.CustomEvent;
    if (EventConstructor) element.dispatchEvent(new EventConstructor("language-error", {
        bubbles: true, detail: { error }
    }));
}

async function formatLanguage(element) {
    if (isEditorTarget(element)) return;
    const language = element.getAttribute("language")?.trim();
    const code = codeNodeFor(element);
    if (!language || !code) return;

    const source = code.textContent || "";
    const previous = languageStates.get(code);
    if (previous?.language === language && previous.source === source) return previous.promise;

    const state = { language, source, promise: null };
    languageStates.set(code, state);
    state.promise = (async () => {
        const parser = await loadParser("code");
        const details = await parser.parseCode(source, language);
        if (languageStates.get(code) !== state ||
            element.getAttribute("language") !== language || code.textContent !== source) return;

        const fragment = code.ownerDocument.createDocumentFragment();
        for (const detail of details) {
            if (detail.token) {
                const span = code.ownerDocument.createElement("span");
                span.className = `token-${detail.token}`;
                span.textContent = detail.value;
                fragment.append(span);
            } else fragment.append(code.ownerDocument.createTextNode(detail.value));
        }
        code.replaceChildren(fragment);
    })().catch(error => {
        if (languageStates.get(code) === state) languageStates.delete(code);
        languageError(element, error);
    });
    return state.promise;
}

export async function initLanguage(root = globalThis.document) {
    if (!root) return [];
    const elements = new Set();
    if (root.matches?.(languageSelector) && !isEditorTarget(root)) elements.add(root);
    for (const element of queryElements({ element: root, selector: languageSelector }))
        if (!isEditorTarget(element)) elements.add(element);
    return Promise.all([...elements].map(formatLanguage));
}

function loadRuntime() {
    runtimePromise ||= import(/* webpackChunkName: "editor-runtime" */ "./core.js")
        .then(module => { runtimeModule = module; return module; })
        .catch(error => { runtimePromise = undefined; throw error; });
    return runtimePromise;
}

function loadInputBinding() {
    inputBindingPromise ||= import(/* webpackChunkName: "editor-input-binding" */ "./inputBinding.js")
        .catch(error => { inputBindingPromise = undefined; throw error; });
    return inputBindingPromise;
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

export async function init(root = globalThis.document) {
    const editors = await callRuntime("init", [root]);
    if (root?.matches?.(bindingSelector) || root?.querySelector?.(bindingSelector))
        await (await loadInputBinding()).init(root);
    await initLanguage(root);
    return editors;
}
export const initElements = (...args) => callRuntime("initElements", args);
export const initElement = (...args) => callRuntime("initElement", args);
export const createEditorCore = (...args) => callRuntime("createEditorCore", args);
export const createCore = createEditorCore;
export const createEditorEvents = (...args) => callRuntime("createEditorEvents", args);
export const bindEditorInput = (...args) => callRuntime("bindEditorInput", args);
export const getSelection = (...args) => callRuntime("getSelection", args);
export const setSelection = (...args) => callRuntime("setSelection", args);
export const textChange = (...args) => callRuntime("textChange", args);
export const initEditorInput = (...args) => callRuntime("initEditorInput", args);
export const uninitEditorInput = (...args) => callRuntime("uninitEditorInput", args);
export const initEditorQuery = (...args) => callRuntime("initEditorQuery", args);
export const uninitEditorQuery = (...args) => callRuntime("uninitEditorQuery", args);
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
export { lengthEditorDetails };

function reportError(element, error) {
    const EventConstructor = element.ownerDocument?.defaultView?.CustomEvent || globalThis.CustomEvent;
    if (EventConstructor) element.dispatchEvent(new EventConstructor("editor-error", {
        bubbles: true, detail: { error }
    }));
}

function activate(node) {
    const activateElement = element => {
        if (element.matches(editorSelector))
            loadRuntime().catch(error => reportError(element, error));
        if (element.matches(bindingSelector))
            loadInputBinding().catch(error => reportError(element, error));
    };
    if (node?.nodeType === 1) activateElement(node);
    node?.querySelectorAll?.(activationSelector).forEach(activateElement);
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
        attributeFilter: ["editor", "contenteditable", "editor-query",
            "editor-attribute", "editor-property", "crdt"]
    });
}

if (typeof document !== "undefined") {
    if (document.readyState === "loading")
        document.addEventListener("DOMContentLoaded", observeDocument, { once: true });
    else queueMicrotask(observeDocument);
}

const editor = {
    init, initElements, initElement, initLanguage, createEditorCore, createCore, createEditorEvents,
    bindEditorInput, getSelection, setSelection, textChange,
    initEditorInput, uninitEditorInput, initEditorQuery, uninitEditorQuery, destroyEditor,
    sendPosition, updateText, updateElement, loadEditor, loadParser, parseDOM,
    parseMarkdown, parseCode, autoLanguageDetection, createTextEditor, createDOMEditor,
    createMarkdownEditor, createCodeEditor, parseAndStoreEditorDetails,
    parseAndStoreMarkdownDetails, parseAndStoreCodeDetails, updateStoredEditorDetails,
    getStoredEditorDetails, deleteStoredEditorDetails, lengthEditorDetails
};

observer.init([
    {
        name: "CoCreateLanguageAddedNodes",
        types: ["addedNodes", "childList", "characterData"],
        selector: languageSelector,
        callback: mutation => { void initLanguage(mutation.target); }
    },
    {
        name: "CoCreateLanguageAttribute",
        types: ["attributes"],
        attributeFilter: ["language"],
        selector: "code",
        callback: mutation => {
            if (mutation.target.hasAttribute("language"))
                void initLanguage(mutation.target);
            else clearLanguage(mutation.target);
        }
    }
]);

if (typeof document !== "undefined")
    void initLanguage(document).catch(error => console.error("CoCreate language formatting failed", error));

export default editor;
