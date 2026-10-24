import "@cocreate/element-prototype";
import observer from "@cocreate/observer";
import {
    create as createAdapter,
    destroy as destroyAdapter,
    heal,
    setType,
    getValue,
    setValue,
    insert,
    insertPos,
    replaceRange,
    getSelection,
    setSelection,
    supported
} from "./adapters.js";
import { bind, unbind, setCrdt } from "./binding.js";
import { applyChange, applySourceChange, sourceChange } from "./CRDT.js";
import { renderSource } from "./render.js";
import { addSyntax, updateSyntax, syntaxRules } from "./config.js";
import "./index.css";

let renderer;
export function setRenderer(instance) {
    if (!instance || typeof instance.render !== "function")
        throw new TypeError("Markdown renderer must expose render(source).");
    renderer = instance;
}
export function render(value, type = "markdown") {
    return renderer && type === "markdown"
        ? renderer.render(String(value ?? ""))
        : renderSource(String(value ?? ""), type).innerHTML;
}

const selector =
    '[editor], [contenteditable]:not([contenteditable="false"]), input[crdt="true"], textarea[crdt="true"], iframe[crdt="true"]';
const owners = new WeakMap();
export function create(element) {
    if (!supported(element)) throw new TypeError("Unsupported editor element.");
    if (owners.has(element)) return owners.get(element);
    const owner = {};
    element.__cocreateEditor = owner;
    element.dispatchEvent(
        new CustomEvent("cocreate-editor-claim", { bubbles: true })
    );
    try {
        const ready = Promise.resolve(createAdapter(element))
            .then(async (result) => {
                if (element.__cocreateEditor === owner) await bind(element);
                return result;
            })
            .catch((error) => {
                destroy(element);
                throw error;
            });
        owners.set(element, ready);
        return ready;
    } catch (error) {
        delete element.__cocreateEditor;
        throw error;
    }
}
export function destroy(element) {
    unbind(element);
    owners.delete(element);
    destroyAdapter(element);
    delete element.__cocreateEditor;
}
function report(element, error) {
    element.dispatchEvent(
        new CustomEvent("editor-error", { bubbles: true, detail: { error } })
    );
}
export function init(elements = document.querySelectorAll(selector)) {
    if (elements?.nodeType === 1) elements = [elements];
    for (const element of elements) {
        if (!element.matches(selector) || !supported(element)) continue;
        try {
            create(element).catch((error) => report(element, error));
        } catch (error) {
            report(element, error);
        }
    }
}
function attributeChanged(mutation) {
    const element = mutation.target;
    if (!element.matches(selector)) {
        const editable = element.getAttribute("contenteditable");
        destroy(element);
        // Preserve the user's activation change when restoring host attributes.
        if (editable === null) element.removeAttribute("contenteditable");
        else element.setAttribute("contenteditable", editable);
        return;
    }
    if (!owners.has(element)) {
        init(element);
        return;
    }
    try {
        if (mutation.attributeName === "editor")
            Promise.resolve(setType(element)).catch((error) =>
                report(element, error)
            );
        else if (mutation.attributeName !== "contenteditable")
            bind(element).catch((error) => report(element, error));
    } catch (error) {
        report(element, error);
    }
}
observer.init({
    name: "CoCreateEditorAddedNodes",
    types: ["addedNodes"],
    selector,
    callback: (mutation) => init(mutation.target)
});
observer.init({
    name: "CoCreateEditorAttributes",
    types: ["attributes"],
    attributeFilter: [
        "editor",
        "contenteditable",
        "crdt",
        "array",
        "object",
        "key",
        "read",
        "save",
        "crud",
        "namespace",
        "room"
    ],
    callback: attributeChanged
});
init();

export {
    heal,
    setType,
    getValue,
    setValue,
    insert,
    insertPos,
    replaceRange,
    getSelection,
    setSelection,
    applyChange,
    applySourceChange,
    sourceChange
};
export { addSyntax, updateSyntax, syntaxRules, setCrdt };
export default {
    setCrdt,
    addSyntax,
    updateSyntax,
    syntaxRules,
    init,
    create,
    destroy,
    heal,
    setType,
    getValue,
    setValue,
    render,
    setRenderer,
    insert,
    insertPos,
    replaceRange,
    getSelection,
    setSelection,
    applyChange,
    applySourceChange,
    sourceChange
};
