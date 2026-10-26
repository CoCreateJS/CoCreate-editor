import observer from "@cocreate/observer";
import { loadMode } from "./modes.js";
import "./index.css";

const selector = "[realtime][array][object][key]";
const selectors = [
    `input${selector}`,
    `textarea${selector}`,
    "input[crdt='true'][array][object][key]",
    "textarea[crdt='true'][array][object][key]",
    ":is([contenteditable], [editor], [editor-language]):not([contenteditable='false'])"
].join(", ");

let corePromise;

function loadCore() {
    if (!corePromise) {
        corePromise = import(/* webpackChunkName: "editor-core" */ "./Core.js")
            .then(module => module.default)
            .catch(error => {
                corePromise = undefined;
                throw error;
            });
    }
    return corePromise;
}

function reportError(element, error) {
    const EventConstructor = element.ownerDocument.defaultView.CustomEvent;
    element.dispatchEvent(new EventConstructor("editor-error", {
        bubbles: true, detail: { error }
    }));
}

function loadForMutation({ target, attributeName }) {
    const wasLoaded = !!corePromise;
    return loadCore().then(core => {
        // Code owns language changes once its renderer is active. If a language
        // attribute turns a text surface into a code editor, initialize it here.
        if (!wasLoaded) return core.initElement(target);
        if (attributeName === "editor-language" &&
            !target.editor?.loading &&
            (target.getAttribute("editor")?.trim().toLowerCase() !== "code" ||
                target.editor?.modeName !== "code"))
            return core.initElement(target);
    }).catch(error => reportError(target, error));
}

observer.init([
    {
        name: "CoCreateEditorLoaderAddedNodes",
        types: ["addedNodes"],
        selector: selectors,
        callback: loadForMutation
    },
    {
        name: "CoCreateEditorLoaderAttributes",
        types: ["attributes"],
        attributeFilter: ["array", "object", "key", "realtime", "crdt", "editor", "editor-language", "contenteditable"],
        selector: selectors,
        callback: loadForMutation
    }
]);

function start() {
    if (document.querySelector(selectors)) loadCore().catch(() => {});
}

/** Render source to detached DOM without initializing an editable surface. */
export async function render(source, options = {}) {
    const settings = typeof options === "string" ? { mode: options } : options || {};
    const name = String(settings.mode || "text").trim().toLowerCase();
    const language = String(settings.language || "text").trim().toLowerCase();
    const value = String(source ?? "");

    if (!["text", "dom", "markdown", "code"].includes(name))
        throw new TypeError(`Unsupported render mode: ${name}`);

    if (name === "text") {
        const output = document.createElement("div");
        output.textContent = value;
        return output;
    }

    const host = document.createElement("div");
    if (name === "code" && language !== "text")
        host.setAttribute("editor-language", language);
    const renderer = await loadMode({ name, language }, { editing: false });
    return renderer.render(value, host);
}

/** Parse Markdown source into its detached rendered DOM element. */
export function parseMarkdown(source) {
    return render(source, { mode: "markdown" });
}

/** Parse code source into detached syntax-highlighted DOM for a language. */
export function parseCode(source, language = "text") {
    return render(source, { mode: "code", language });
}

export async function init() {
    const core = await loadCore();
    return core.init();
}

export async function initElements(elements) {
    const core = await loadCore();
    return core.initElements(elements);
}

export async function initElement(element) {
    const core = await loadCore();
    return core.initElement(element);
}

export async function sendPosition(element) {
    const core = await loadCore();
    return core.sendPosition(element);
}

export async function updateText(data) {
    const core = await loadCore();
    return core.updateText(data);
}

export async function updateElement(data) {
    const core = await loadCore();
    return core.updateElement(data);
}

start();

export default {
    init,
    initElements,
    initElement,
    sendPosition,
    render,
    parseMarkdown,
    parseCode,
    updateText,
    updateElement
};
