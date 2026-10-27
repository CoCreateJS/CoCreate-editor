if (typeof document !== "undefined") import("./index.css");

export * from "./core.js";
export { createEditorEvents } from "./events.js";
export { bindEditorInput } from "./events.js";
export { getSelection, setSelection } from "./selection.js";
export { textChange } from "./textChange.js";

import { createPrototypeCore } from "./core.js";
import * as editorAPI from "./editors/index.js";
import { createEditorEvents, bindEditorInput } from "./events.js";
import { getSelection, setSelection } from "./selection.js";
import { textChange } from "./textChange.js";
import { initEditorInput, uninitEditorInput } from "./inputBinding.js";

export { initEditorInput, uninitEditorInput };

const prototypeCore = createPrototypeCore();
const editorSelector = ":is(input, textarea, [contenteditable], [editor], [editor-language]):not([contenteditable='false']):not([editor-query][editor-attribute])";
let observerReady;

function emit(element, type, detail) {
    const EventConstructor = element.ownerDocument?.defaultView?.CustomEvent || globalThis.CustomEvent;
    if (EventConstructor) element.dispatchEvent(new EventConstructor(type, { bubbles: true, detail }));
}

export function initElement(element, { force = false } = {}) {
    if (!element) return Promise.reject(new TypeError("An editor element is required."));
    element.editor ||= {};
    element.editor.element = element;
    attachEditorAPI(element);
    if (element.editor.loading) return element.editor.loading;
    if (element.editor.initialized && !force) return Promise.resolve(prototypeCore.getEditorDetails(element));
    element.editor.initialized = false;
    const loading = prototypeCore.initEditor(element, { force }).then(details => {
        element.editor.initialized = true;
        emit(element, "editor-ready", { details, mode: element.getAttribute("editor") || "text" });
        return details;
    }).catch(error => {
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
            get: () => prototypeCore.getEditorDetails(element) || []
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

async function installObserver() {
    if (observerReady) return observerReady;
    observerReady = import("@cocreate/observer").then(({ default: observer }) => {
        observer.init([
            {
                name: "CoCreatePrototypeEditorAddedNodes",
                types: ["addedNodes"],
                selector: editorSelector,
                callback: mutation => initElement(mutation.target)
            },
            {
                name: "CoCreatePrototypeEditorAttributes",
                types: ["attributes"],
                attributeFilter: ["editor", "editor-language", "contenteditable"],
                selector: editorSelector,
                callback: mutation => initElement(mutation.target, { force: true })
            },
            {
                name: "CoCreatePrototypeEditorInputBindings",
                types: ["addedNodes", "attributes"],
                attributeFilter: ["editor-query", "editor-attribute", "editor-attribute-part"],
                selector: "input[editor-query][editor-attribute], textarea[editor-query][editor-attribute]",
                callback: mutation => {
                    const input = mutation.target;
                    initEditorInput(input, {
                        context: input.ownerDocument,
                        query: input.getAttribute("editor-query"),
                        attribute: {
                            name: input.getAttribute("editor-attribute"),
                            part: input.getAttribute("editor-attribute-part") || "value"
                        }
                    }).catch(error => emit(input, "editor-error", { error }));
                }
            }
        ]);
    }).catch(error => {
        observerReady = undefined;
        throw error;
    });
    return observerReady;
}

export async function init(root = globalThis.document) {
    if (!root?.querySelectorAll) return [];
    await installObserver();
    const elements = [...root.querySelectorAll(editorSelector)];
    const editors = await initElements(elements);
    const inputs = [...root.querySelectorAll("input[editor-query][editor-attribute], textarea[editor-query][editor-attribute]")];
    await Promise.all(inputs.map(input => initEditorInput(input, {
        context: root,
        query: input.getAttribute("editor-query"),
        attribute: {
            name: input.getAttribute("editor-attribute"),
            part: input.getAttribute("editor-attribute-part") || "value"
        }
    })));
    return editors;
}

const prototype = {
    createCore: createPrototypeCore,
    createPrototypeCore,
    init,
    initElements,
    initElement,
    destroyEditor: element => prototypeCore.destroyEditor(element),
    ...editorAPI,
    createEditorEvents,
    bindEditorInput,
    initEditorInput,
    uninitEditorInput,
    getSelection,
    setSelection,
    textChange
};

export default prototype;

if (typeof document !== "undefined") {
    const start = () => init().catch(error => {
        console.error("CoCreate prototype editor initialization failed", error);
    });
    if (document.readyState === "loading")
        document.addEventListener("DOMContentLoaded", start, { once: true });
    else queueMicrotask(start);
}
