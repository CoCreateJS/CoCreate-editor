import "@cocreate/element-prototype";
import observer from "@cocreate/observer";
import crdt from "@cocreate/crdt";
import { getAttributes, checkValue } from "@cocreate/utils";
import createHTMLDOM from "./editors/html.js";
import createMarkdownDOM from "./editors/markdown.js";
import createCodeDOM from "./editors/code.js";
import { updateHTML, updateMarkdown, updateCode } from "./updates.js";
import { getEditorRange, getEditorSelectionRects, getSelection, isNative, ownsFocus } from "./selection.js";
import { updateTextElement } from "./editors/text.js";
import { setHTMLAttribute } from "./editors/utilities/setAttribute.js";
import createEvents from "./events.js";
import "./index.css";

const { initDocument, addEventListeners, removeEventListeners } = createEvents({
    updateText, sendPosition: reportPosition, clearPosition
});

const selector = `[realtime][array][object][key]`;
const validInputs = ["text", "search", "tel", "url", "email"];
let draftSerial = 0;
const selectors = [
    `input${selector}`,
    `textarea${selector}`,
    "input[crdt='true'][array][object][key]",
    "textarea[crdt='true'][array][object][key]",
    ":is([contenteditable], [editor], [editor-language]):not([contenteditable='false'])"
].join(", ");

function crdtBinding(element, data, editorSurface) {
    const { array, object, key } = data;
    return element.getAttribute("crdt") !== "false" &&
        (editorSurface || element.getAttribute("crdt") === "true" ||
            element.getAttribute("realtime") === "true") &&
        array && object && object !== "pending" && key &&
        !["_id", "organization_id", "storage", "database", "array"].includes(key) &&
        !key.startsWith("$") && checkValue(array) && checkValue(object) && checkValue(key);
}

function editorBinding(element, bound, data) {
    return JSON.stringify([
        bound ? element.getAttribute("realtime") === "true" ? "live" : "draft" : "local",
        data.array, data.object, data.key,
        element.getAttribute("editor"), element.getAttribute("editor-language"),
        element.getAttribute("cursors")
    ]);
}

function sourceValue(element) {
    return String((isNative(element) ? element.value :
        element.getAttribute("value") ?? element.value ?? element.getValue?.() ??
        (element.tagName === "IFRAME"
            ? element.contentDocument?.documentElement?.outerHTML
            : element.innerHTML)) ?? "");
}

export function init() {
    let elements = document.querySelectorAll(selectors);
    initElements(elements);
    _crdtUpdateListener();
    initDocument(document);
}

export function initElements(elements) {
    for (let element of elements) initElement(element);
}

function hydrateElement(element, value) {
    const type = element.getAttribute("editor")?.trim().toLowerCase();
    const code = !isNative(element) &&
        (type === "code" || element.hasAttribute("editor-language"));
    if (["html", "markdown"].includes(type) || code) {
        element.value = value;
        if (element.hasAttribute("value")) element.setAttribute("value", value);
        const liveRoot = element.tagName === "IFRAME"
            ? type === "html"
                ? element.contentDocument.documentElement
                : element.contentDocument.body
            : element;
        if (element.tagName === "IFRAME" &&
            element.contentDocument.documentElement.contentEditable !== "false")
            element.contentDocument.documentElement.contentEditable = "true";
        if (code && !["html", "markdown"].includes(type)) {
            liveRoot.classList.add("cocreate-editor-code");
            if (!liveRoot.style.whiteSpace) liveRoot.style.whiteSpace = "pre-wrap";
        }
        element.editor.dom = type === "html"
            ? createHTMLDOM(value, element.ownerDocument, liveRoot)
            : type === "markdown"
                ? createMarkdownDOM(value, liveRoot)
                : createCodeDOM(value, liveRoot,
                    element.getAttribute("editor-language")?.trim().toLowerCase() || "text");
    } else if (element.setValue) element.setValue(value);
    else if (isNative(element)) element.value = value;
    else {
        element.value = value;
        element.textContent = value;
    }
    addEventListeners(element);
}

function configureCursorRenderer(element, live, data) {
    element.editor.getSelectionRects = (anchor, head = anchor) =>
        getEditorSelectionRects(element, anchor, head);
    element.editor.publishCursorBinding = () => configureCursorRenderer(
        element,
        element.getAttribute("realtime") === "true",
        getAttributes(element)
    );
    const enabled = live && element.getAttribute("crdt") === "true" &&
        element.getAttribute("cursors") !== "false";
    if (!enabled) {
        window.dispatchEvent(new CustomEvent("cocreate-editor-cursor-remove", {
            detail: { element }
        }));
        return;
    }
    window.dispatchEvent(new CustomEvent("cocreate-editor-cursor-init", {
        detail: {
            element,
            data: { array: data.array, object: data.object, key: data.key },
            getRange: getEditorRange,
            resolve: value => value,
            getSelections: () => element.editor.getSelections?.() ?? []
        }
    }));
}

window.addEventListener("cocreate-editor-cursor-request", () => {
    document.querySelectorAll(selectors).forEach(element =>
        element.editor?.publishCursorBinding?.()
    );
});

export function initElement(element) {
    if (element.__cocreateEditor || element.type === "number" ||
        element.type === "file" || element.getAttribute("type") === "file") return;
    const data = getAttributes(element);
    const { array, object, key, isCrud, isSave, isRead } = data;
    if (object === "pending") element.pendingObject = true;
    const isInputTypeValid = element.tagName === "INPUT" && validInputs.includes(element.type);
    const explicitEditor = element.hasAttribute("editor") || element.hasAttribute("editor-language");
    const editableHost = !["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(element.tagName) &&
        element.getAttribute("contenteditable") !== "false" &&
        (element.hasAttribute("contenteditable") || explicitEditor);
    if (!isInputTypeValid && element.tagName !== "TEXTAREA" && !editableHost) return;
    const bound = !!crdtBinding(element, data, editableHost || explicitEditor);
    if (!bound && !editableHost && !explicitEditor) {
        removeEventListeners(element);
        return;
    }
    if (editableHost && element.tagName !== "IFRAME" && !element.hasAttribute("contenteditable"))
        element.setAttribute("contenteditable", "true");
    if (bound) element.setAttribute("crdt", "true");
    element.editor ||= {};
    const binding = editorBinding(element, bound, data);
    if (element.editor.loading || (element.editor.init && element.editor.binding === binding)) return;
    removeEventListeners(element);
    element.editor.binding = binding;
    element.editor.undo = () => updateText({ element, undoRedo: "undo" });
    element.editor.redo = () => updateText({ element, undoRedo: "redo" });
    if (element.getAttribute("editor")?.trim().toLowerCase() === "html")
        element.editor.setAttribute = data => setHTMLAttribute(element, data);
    else delete element.editor.setAttribute;
    if (!bound) {
        element.editor.updateText = ({ start, length = 0, value }) =>
            updateText({ element, start, end: start + length, value });
        configureCursorRenderer(element, false, data);
        const value = sourceValue(element);
        element.editor.localUndo = [];
        element.editor.localRedo = [];
        hydrateElement(element, value);
        return;
    }
    const live = element.getAttribute("realtime") === "true";
    if (!live) element.editor.scope ||= `editor-${++draftSerial}`;
    for (const method of ["getText", "replaceText", "updateText", "undoText", "redoText", "updateSelection", "getSelection", "getSelections"]) {
        element.editor[method] = (data = {}) => {
            const { array, object, key, isCrud, isSave, isRead } = getAttributes(element);
            return crdt[method]({
                ...data, array, object, key, realtime: live,
                scope: live ? undefined : element.editor.scope,
                crud: live ? isCrud : "false", save: live ? isSave : "false",
                read: live ? isRead : "false",
                element: live ? undefined : element
            });
        };
    }
    let newObject = "";
    configureCursorRenderer(element, live, data);
    if (element.pendingObject) {
        newObject = sourceValue(element);
        delete element.pendingObject;
    }
    element.editor.loading = (async () => {
        const response = await crdt.getText({
            array, object, key, realtime: live, crud: isCrud,
            save: isSave, read: isRead, newObject
        });
        const value = live ? response : await crdt.getText({
            array, object, key, scope: element.editor.scope, realtime: false,
            read: "false", initialValue: response ?? sourceValue(element)
        });
        const current = getAttributes(element);
        if (!crdtBinding(element, current, editableHost || explicitEditor) ||
            editorBinding(element, true, current) !== binding) return;
        hydrateElement(element, String(value ?? ""));
    })().finally(() => {
        delete element.editor.loading;
        const current = getAttributes(element);
        const next = editorBinding(element,
            !!crdtBinding(element, current, editableHost || explicitEditor), current);
        if (next !== binding) initElement(element);
    });
}

export function sendPosition(element) {
    const editor = element.editor;
    if (!editor?.init || editor.composing || editor.pendingEdits ||
        element.getAttribute("crdt") !== "true" || !ownsFocus(element)) return;
    const selection = getSelection(element);
    if (!selection) return;
    const { anchor, head } = selection;
    return editor.updateSelection({ selection: { anchor, head } });
}

function reportError(element, error) {
    element.dispatchEvent(new CustomEvent("editor-error", { bubbles: true, detail: { error } }));
}

async function reportPosition(element) {
    try { await sendPosition(element); }
    catch (error) { reportError(element, error); }
}

async function clearPosition(element) {
    if (element.getAttribute("crdt") !== "true") return;
    try { await element.editor.updateSelection({ selection: null }); }
    catch (error) { reportError(element, error); }
}

async function updateText({ element, value, start, end, range, undoRedo, previous }) {
    // Preserve the legacy call shape until source manipulation helpers are replaced.
    if (range?.element) element = range.element;
    if (element?.tagName === "HTML" && !element.hasAttribute("array"))
        element = element.ownerDocument.defaultView.frameElement;
    if (!element?.editor?.init) return;
    if (element.getAttribute("crdt") !== "true") {
        const editor = element.editor;
        const before = undoRedo || typeof previous !== "string"
            ? String(element.value ?? "") : previous;
        let next;
        if (undoRedo === "undo") {
            if (!editor.localUndo.length) return;
            next = editor.localUndo.pop();
            editor.localRedo.push(before);
        } else if (undoRedo === "redo") {
            if (!editor.localRedo.length) return;
            next = editor.localRedo.pop();
            editor.localUndo.push(before);
            if (editor.localUndo.length > 100) editor.localUndo.shift();
        } else {
            if (!Number.isInteger(start) || !Number.isInteger(end) ||
                start < 0 || end < start || end > before.length) return;
            next = before.slice(0, start) + String(value ?? "") + before.slice(end);
            if (next === before) return;
            editor.localUndo.push(before);
            if (editor.localUndo.length > 100) editor.localUndo.shift();
            editor.localRedo.length = 0;
        }
        await updateElement({
            element, string: next, start, length: end - start,
            value: String(value ?? "")
        });
        element.dispatchEvent(new CustomEvent("editor-source-change", {
            bubbles: true, detail: { before, value: next }
        }));
        return;
    }
    const { array, object, key, isCrud, isSave } = getAttributes(element);
    if (!array || !object || !key) return;
    const live = element.getAttribute("realtime") === "true";

    const editor = element.editor;
    editor.pendingEdits = (editor.pendingEdits || 0) + 1;
    let pending = true;
    const settled = (publish = true) => {
        if (!pending) return;
        pending = false;
        editor.pendingEdits--;
        if (!editor.pendingEdits && publish) queueMicrotask(() => reportPosition(element));
    };
    const captureSelection = () => {
        try {
            const current = getAttributes(element);
            if (element.editor !== editor || !editor.init || editor.composing || editor.pendingEdits > 1 || !ownsFocus(element) ||
                current.array !== array || current.object !== object || current.key !== key) return null;
            const selection = getSelection(element);
            return selection ? { anchor: selection.anchor, head: selection.head } : null;
        } finally {
            // The text is committed locally; persistence/network completion need not delay presence.
            settled();
        }
    };
    const data = {
        array, object, key, realtime: live,
        scope: live ? undefined : editor.scope,
        crud: live ? isCrud : "false", save: live ? isSave : "false",
        captureSelection,
        element: live ? undefined : element
    };
    try {
        if (undoRedo === "undo") return await crdt.undoText(data);
        if (undoRedo === "redo") return await crdt.redoText(data);
        const length = end === undefined ? 0 : end - start;
        return await crdt.updateText({ ...data, value, start, length });
    } catch (error) {
        settled(false);
        throw error;
    } finally {
        settled();
    }
}

function _crdtUpdateListener() {
    window.addEventListener("cocreate-crdt-update", event => updateElements(event.detail));
}

function updateElements({ elements, array, object, key, value, start, length, string, operation, commit, scope }) {
    const targeted = !!elements;
    if (!elements) {
        let qs = `[array='${array}'][object='${object}'][key='${key}']`;
        elements = document.querySelectorAll(`:is(input, textarea, [contenteditable], [editor], [editor-language])${qs}`);
    }

    elements.forEach((element) => {
        if (element.getAttribute("crdt") !== "true") return;
        if (targeted && element.editor?.scope && element.editor.scope !== scope) return;
        if (element.editor?.scope && element.getAttribute("realtime") !== "true") {
            if (!targeted && commit && element.editor.init &&
                String(element.value ?? "") !== string)
                element.editor.replaceText({ value: string }).catch(error => reportError(element, error));
            if (!targeted) return;
        }

        updateElement({ element, array, object, key, value, start, length, string, operation });
    });
}

async function updateElement({ element, array, object, key, value, start, length, string, operation }) {
    if (element.__cocreateEditor) return;
    const type = element.getAttribute("editor")?.trim().toLowerCase();
    const code = !isNative(element) &&
        (type === "code" || element.hasAttribute("editor-language"));
    const rendersDOM = ["html", "markdown"].includes(type) || code;
    if (string === undefined) string = await crdt.getText({ array, object, key });
    if (element.__cocreateEditor) return;
    string ??= "";
    // inputValue is optimistic after local edits; the host still has the last
    // source actually rendered in its detached/live trees.
    const previous = rendersDOM ? String(element.value ?? "") : element.editor?.inputValue;

    if (!rendersDOM) {
        if (element.editor) element.editor.inputValue = string;
        if (!isNative(element)) element.value = string;
        updateTextElement(element, string, { start, length, value });
        return;
    }

    const change = { string, previous, start, length, value, operation };
    if (type === "html") updateHTML(element, change);
    else if (type === "markdown") updateMarkdown(element, change);
    else updateCode(element, change);
}

observer.init({
    name: "CoCreateTextAddedNodes",
    types: ["addedNodes"],
    selector: selectors,
    callback(mutation) {
        if (mutation.target.editor?.init || mutation.target.editor?.loading) return;
        initElement(mutation.target);
    }
});

observer.init({
    name: "CoCreateTextAttributes",
    types: ["attributes"],
    attributeFilter: ["array", "object", "key", "realtime", "crdt", "cursors", "editor", "editor-language", "contenteditable"],
    selector: selectors,
    callback(mutation) {
        const element = mutation.target;
        const editor = element.editor;
        const type = element.getAttribute("editor")?.trim().toLowerCase();
        if (mutation.attributeName === "editor-language" && editor?.init && !editor.loading &&
            !isNative(element) && !["html", "markdown"].includes(type) &&
            (type === "code" || element.hasAttribute("editor-language"))) {
            const root = element.tagName === "IFRAME" ? element.contentDocument.body : element;
            root.classList.add("cocreate-editor-code");
            if (!root.style.whiteSpace) root.style.whiteSpace = "pre-wrap";
            const string = String(element.value ?? "");
            updateCode(element, { string, previous: string });
            const data = getAttributes(element);
            editor.binding = editorBinding(element,
                !!crdtBinding(element, data, true), data);
            return;
        }
        initElement(mutation.target);
    }
});

init();

export default {
    initElements,
    initElement,
    updateText,
    updateElement
};
