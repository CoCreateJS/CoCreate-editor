import { getSelection } from "./selection.js";
import { textChange } from "./textChange.js";

/** Small event hub for the isolated prototype editor path. */
export function createEditorEvents() {
    const listeners = new Map();
    return {
        on(type, listener) {
            if (typeof listener !== "function") throw new TypeError("Listener must be a function.");
            let set = listeners.get(type);
            if (!set) listeners.set(type, set = new Set());
            set.add(listener);
            return () => set.delete(listener);
        },
        emit(type, detail) {
            for (const listener of listeners.get(type) || []) listener(detail);
        },
        clear(type) {
            if (type === undefined) listeners.clear();
            else listeners.delete(type);
        }
    };
}

/** Bind a text surface and turn browser input into positional source edits. */
export function bindEditorInput(element, { onUpdate, onSelection, readValue, mapSelection = true,
    getSelection: readSelection = () => getSelection(element), clearSelection, beforeInput, keyDown } = {}) {
    if (!element?.addEventListener) throw new TypeError("An event-capable editor element is required.");
    if (typeof onUpdate !== "function") throw new TypeError("onUpdate must be a function.");
    const read = readValue || (() => typeof element.value === "string"
        ? element.value : String(element.textContent || ""));
    let previous = String(read() ?? "");
    let selectionBeforeInput = null;
    let selectionBeforeComposition = null;
    let composing = false;
    const controller = new AbortController();
    const options = { signal: controller.signal };

    const beforeinput = event => {
        selectionBeforeInput = mapSelection ? readSelection(event) : null;
        beforeInput?.(event, selectionBeforeInput);
    };
    const keydown = event => {
        selectionBeforeInput = mapSelection ? readSelection(event) : null;
        keyDown?.(event, selectionBeforeInput);
    };
    const input = (event, sourceSelection = selectionBeforeInput) => {
        if (composing) return;
        const next = String(read(event, sourceSelection) ?? "");
        if (next === previous) return;
        const change = textChange(previous, next, sourceSelection);
        previous = next;
        selectionBeforeInput = null;
        Promise.resolve(onUpdate({ ...change, string: next })).catch(error => {
            element.dispatchEvent(new CustomEvent("editor-error", {
                bubbles: true, detail: { error }
            }));
        });
        onSelection?.(readSelection());
    };
    const selection = () => onSelection?.(readSelection());
    element.addEventListener("keydown", keydown, options);
    element.addEventListener("beforeinput", beforeinput, options);
    element.addEventListener("input", input, options);
    element.addEventListener("compositionstart", () => {
        composing = true;
        selectionBeforeComposition = mapSelection ? readSelection() : null;
    }, options);
    element.addEventListener("compositionend", event => {
        composing = false;
        const sourceSelection = selectionBeforeComposition;
        selectionBeforeComposition = null;
        queueMicrotask(() => input({ inputType: "insertCompositionText", data: event.data }, sourceSelection));
    }, options);
    element.addEventListener("select", selection, options);
    element.addEventListener("keyup", selection, options);
    element.addEventListener("pointerup", selection, options);
    if (clearSelection) element.addEventListener("pointerdown", clearSelection, options);

    return {
        setValue(value) { previous = String(value ?? ""); },
        disconnect() { controller.abort(); }
    };
}

export default createEditorEvents;
