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

const prototypeCore = createPrototypeCore();
const editorSelector = ":is(input, textarea, [contenteditable], [editor], [editor-language]):not([contenteditable='false'])";
let observerReady;

function emit(element, type, detail) {
    const EventConstructor = element.ownerDocument?.defaultView?.CustomEvent || globalThis.CustomEvent;
    if (EventConstructor) element.dispatchEvent(new EventConstructor(type, { bubbles: true, detail }));
}

export function initElement(element, { force = false } = {}) {
    if (!element) return Promise.reject(new TypeError("An editor element is required."));
    element.editor ||= {};
    if (element.editor.loading) return element.editor.loading;
    if (element.editor.init && !force) return Promise.resolve(prototypeCore.getEditorDetails(element));
    element.editor.init = false;
    const loading = prototypeCore.initEditor(element, { force }).then(details => {
        element.editor.init = true;
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
    return initElements(elements);
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
