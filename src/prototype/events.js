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
export function bindEditorInput(element, { onUpdate, onSelection, readValue, mapSelection = true } = {}) {
    if (!element?.addEventListener) throw new TypeError("An event-capable editor element is required.");
    if (typeof onUpdate !== "function") throw new TypeError("onUpdate must be a function.");
    const read = readValue || (() => typeof element.value === "string"
        ? element.value : String(element.textContent || ""));
    let previous = String(read() ?? "");
    let selectionBeforeInput = null;
    let composing = false;
    const controller = new AbortController();
    const options = { signal: controller.signal };

    const beforeinput = () => { selectionBeforeInput = mapSelection ? getSelection(element) : null; };
    const input = () => {
        if (composing) return;
        const next = String(read() ?? "");
        if (next === previous) return;
        const change = textChange(previous, next, selectionBeforeInput);
        previous = next;
        selectionBeforeInput = null;
        Promise.resolve(onUpdate({ ...change, string: next })).catch(error => {
            element.dispatchEvent(new CustomEvent("editor-error", {
                bubbles: true, detail: { error }
            }));
        });
        onSelection?.(getSelection(element));
    };
    const selection = () => onSelection?.(getSelection(element));
    element.addEventListener("beforeinput", beforeinput, options);
    element.addEventListener("input", input, options);
    element.addEventListener("compositionstart", () => { composing = true; }, options);
    element.addEventListener("compositionend", () => {
        composing = false;
        queueMicrotask(input);
    }, options);
    element.addEventListener("select", selection, options);
    element.addEventListener("keyup", selection, options);
    element.addEventListener("pointerup", selection, options);

    return {
        setValue(value) { previous = String(value ?? ""); },
        disconnect() { controller.abort(); }
    };
}

export default createEditorEvents;
