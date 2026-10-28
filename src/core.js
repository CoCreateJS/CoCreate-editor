export * from "./editorCore.js";
export { createEditorEvents } from "./events.js";
export { bindEditorInput } from "./events.js";
export { getSelection, setSelection } from "./selection.js";
export { textChange } from "./textChange.js";

import { createEditorCore } from "./editorCore.js";
import * as editorAPI from "./editors/index.js";
import { createEditorEvents, bindEditorInput } from "./events.js";
import { getSelection, setSelection } from "./selection.js";
import { textChange } from "./textChange.js";
import observer from "@cocreate/observer";
const editorCore = createEditorCore();
const editorSelector = ":is([editor], [editor-language], [contenteditable], input[crdt='true'], textarea[crdt='true']):not([contenteditable='false']):not([editor-query])";
let inputBindingPromise;
let crdtPromise;
const crdtMethods = ["getText", "replaceText", "updateText", "undoText", "redoText",
    "updateSelection", "getSelection", "getSelections", "endRun"];
const crdtBindings = new WeakMap();

function loadCRDT() {
    crdtPromise ||= import(/* webpackChunkName: "editor-crdt" */ "@cocreate/crdt")
        .then(module => module.default || module)
        .catch(error => { crdtPromise = undefined; throw error; });
    return crdtPromise;
}

function readSource(element) {
    if (typeof element.editor?.getSource === "function") return element.editor.getSource();
    if ((element.tagName === "INPUT" || element.tagName === "TEXTAREA") &&
        typeof element.value === "string") return element.value;
    const attributeValue = element.getAttribute?.("value");
    if (attributeValue !== null && attributeValue !== undefined) return attributeValue;
    if (typeof element.getValue === "function") {
        const value = element.getValue();
        if (value !== undefined && value !== null) return value;
    }
    if (typeof element.value === "string") return element.value;
    if (element.tagName === "IFRAME")
        return element.contentDocument?.documentElement?.outerHTML || "";
    return element.textContent || "";
}

function crdtOptions(element) {
    return Object.fromEntries(["array", "object", "key", "realtime", "crud", "save",
        "read", "namespace", "room"].map(name => [name, element.getAttribute(name) ?? undefined]));
}

function clearCRDTAPI(element) {
    const binding = crdtBindings.get(element);
    if (!binding) return;
    for (const [name, installed] of Object.entries(binding.installed)) {
        if (element.editor?.[name] !== installed) continue;
        const previous = binding.previous[name];
        if (previous === undefined) delete element.editor[name];
        else element.editor[name] = previous;
    }
    crdtBindings.delete(element);
}

function attachCRDTAPI(element, engine) {
    clearCRDTAPI(element);
    const api = element.editor;
    const installed = {}, previous = {};
    for (const name of crdtMethods) {
        if (typeof engine[name] !== "function") continue;
        previous[name] = api[name];
        installed[name] = data => {
            return engine[name]({
                ...(data || {}), ...crdtOptions(element), element
            });
        };
        api[name] = installed[name];
    }
    crdtBindings.set(element, { installed, previous });
}

function loadInputBinding() {
    inputBindingPromise ||= import(/* webpackChunkName: "editor-input-binding" */ "./inputBinding.js")
        .catch(error => { inputBindingPromise = undefined; throw error; });
    return inputBindingPromise;
}

export async function initEditorInput(input, options) {
    const module = await loadInputBinding();
    return module.initEditorInput(input, options);
}

export async function uninitEditorInput(input) {
    const module = await loadInputBinding();
    return module.uninitEditorInput(input);
}

export async function initEditorQuery(element, options) {
    const module = await loadInputBinding();
    return module.initEditorQuery(element, options);
}

export async function uninitEditorQuery(element) {
    const module = await loadInputBinding();
    return module.uninitEditorQuery(element);
}

function emit(element, type, detail) {
    const EventConstructor = element.ownerDocument?.defaultView?.CustomEvent || globalThis.CustomEvent;
    if (EventConstructor) element.dispatchEvent(new EventConstructor(type, { bubbles: true, detail }));
}

export function initElement(element, { force = false } = {}) {
    if (!element) return Promise.reject(new TypeError("An editor element is required."));
    element.editor ||= {};
    element.editor.element = element;
    if (element.tagName === "IFRAME") {
        const document = element.contentDocument;
        if (document?.body) {
            element.editor.liveNode = document.body;
            if (document.documentElement?.contentEditable !== "false" &&
                document.body.contentEditable !== "false")
                document.body.contentEditable = "true";
        }
    }
    attachEditorAPI(element);
    if (element.editor.loading) return element.editor.loading;
    if (element.editor.initialized && !force) return Promise.resolve(editorCore.getEditorDetails(element));
    element.editor.initialized = false;
    const loading = (async () => {
        const crdtEnabled = element.getAttribute("crdt") === "true";
        let source;
        if (crdtEnabled) {
            const engine = await loadCRDT();
            attachCRDTAPI(element, engine);
            const fallback = String(readSource(element) ?? "");
            const data = crdtOptions(element);
            const localSeed = data.read === "false" && fallback
                ? { ...data, read: "true", newObject: fallback }
                : data;
            const response = await engine.getText({ ...localSeed, element });
            source = response ?? fallback;
            source = String(source ?? "");
        } else {
            clearCRDTAPI(element);
            source = String(readSource(element) ?? "");
        }
        const details = await editorCore.initEditor(element, { force, source });
        element.editor.initialized = true;
        emit(element, "editor-ready", { details, mode: element.getAttribute("editor") || "text" });
        return details;
    })().catch(error => {
        emit(element, "editor-error", { error });
        throw error;
    }).finally(() => {
        if (element.editor.loading === loading) delete element.editor.loading;
    });
    element.editor.loading = loading;
    return loading;
}

function attachEditorAPI(element) {
    const api = element.editor;
    const nodesDescriptor = Object.getOwnPropertyDescriptor(api, "nodes");
    if (!nodesDescriptor || nodesDescriptor.configurable) {
        Object.defineProperty(api, "nodes", {
            configurable: true,
            enumerable: true,
            get: () => editorCore.getEditorDetails(element) || []
        });
    }
    if (typeof api.init !== "function") api.init = options => {
        const settings = options || {};
        const input = settings.input || element;
        const target = settings.target || (!settings.query && element.getAttributeNode
            ? element : undefined);
        return initEditorInput(input, {
            context: settings.context || element,
            target,
            query: settings.query,
            attribute: settings.attribute,
            part: settings.part
        });
    };
    if (typeof api.uninit !== "function") api.uninit = input =>
        uninitEditorInput(input || element);
    return api;
}

export function initElements(elements) {
    return Promise.all([...elements].map(element => initElement(element)));
}

export async function init(root = globalThis.document) {
    if (!root?.querySelectorAll) return [];
    const elements = [...root.querySelectorAll(editorSelector)];
    if (root.matches?.(editorSelector)) elements.unshift(root);
    return initElements(elements);
}

const editor = {
    createCore: createEditorCore,
    createEditorCore,
    init,
    initElements,
    initElement,
    destroyEditor: element => {
        clearCRDTAPI(element);
        return editorCore.destroyEditor(element);
    },
    ...editorAPI,
    createEditorEvents,
    bindEditorInput,
    initEditorInput,
    uninitEditorInput,
    initEditorQuery,
    uninitEditorQuery,
    getSelection,
    setSelection,
    textChange
};

observer.init([
    {
        name: "CoCreateEditorAddedNodes",
        types: ["addedNodes"],
        selector: editorSelector,
        callback: mutation => initElement(mutation.target)
    },
    {
        name: "CoCreateEditorAttributes",
        types: ["attributes"],
        attributeFilter: ["editor", "editor-language", "contenteditable", "crdt",
            "realtime", "read", "save", "crud", "namespace", "room"],
        selector: editorSelector,
        callback: mutation => initElement(mutation.target, { force: true })
    }
]);

export default editor;

init().catch(error => {
    console.error("CoCreate editor initialization failed", error);
});
