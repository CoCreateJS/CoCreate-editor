import * as rich from "./editor.js";
import * as iframe from "./iframe.js";
export const isFrame = (element) => element?.tagName === "IFRAME";
const native = new WeakMap();
export const isNative = (element) =>
    ["INPUT", "TEXTAREA"].includes(element?.tagName);
export function supported(element) {
    return (
        element instanceof element.ownerDocument.defaultView.HTMLElement &&
        (!isNative(element) ||
            element.tagName === "TEXTAREA" ||
            ["text", "search", "url", "tel", "email", "password"].includes(
                element.type
            ))
    );
}
export function create(element) {
    if (!supported(element)) throw new TypeError("Unsupported editor element.");
    if (isFrame(element)) return iframe.create(element);
    if (!isNative(element)) return rich.create(element);
    if (
        element.hasAttribute("editor") &&
        !["", "text"].includes(element.getAttribute("editor"))
    )
        throw new TypeError('Inputs and textareas use editor="text".');
    if (native.has(element)) return native.get(element).ready;
    const original = Object.fromEntries(
        ["getValue", "getValueAsync", "setValue"].map((name) => [
            name,
            Object.getOwnPropertyDescriptor(element, name)
        ])
    );
    const record = {
        original,
        value: element.value,
        abort: new AbortController()
    };
    native.set(element, record);
    Object.defineProperties(element, {
        getValue: { configurable: true, value: () => element.value },
        getValueAsync: { configurable: true, value: async () => element.value },
        setValue: {
            configurable: true,
            value: (value, dispatch = false) => {
                setValue(element, value);
                if (dispatch)
                    element.dispatchEvent(
                        new Event("input", { bubbles: true })
                    );
            }
        }
    });
    const changed = () => {
        if (record.composing) return;
        const before = record.value;
        record.value = element.value;
        if (before !== record.value)
            element.dispatchEvent(
                new CustomEvent("editor-source-change", {
                    detail: { before, value: record.value }
                })
            );
    };
    const on = (target, name, fn) =>
        target.addEventListener(name, fn, { signal: record.abort.signal });
    on(element, "input", changed);
    on(element, "compositionstart", () => (record.composing = true));
    on(element, "compositionend", () => {
        record.composing = false;
        changed();
    });
    on(element, "keydown", (event) => {
        if (
            !record.composing &&
            (event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            ["z", "y"].includes(event.key.toLowerCase()) &&
            element.__cocreateEditor?.history
        ) {
            event.preventDefault();
            element.__cocreateEditor.history(
                event.shiftKey || event.key.toLowerCase() === "y"
            );
        }
    });
    // The browser applies reset after dispatching the reset event.
    if (element.form)
        on(element.form, "reset", (event) =>
            queueMicrotask(() => {
                if (!event.defaultPrevented && native.has(element)) changed();
            })
        );
    record.ready = Promise.resolve({ element, host: element });
    element.dispatchEvent(
        new CustomEvent("editor-ready", {
            bubbles: true,
            detail: { editor: { element, host: element } }
        })
    );
    return record.ready;
}
export function destroy(element) {
    if (isFrame(element)) return iframe.destroy(element);
    const record = native.get(element);
    if (!record) return rich.destroy(element);
    native.delete(element);
    record.abort.abort();
    for (const [name, descriptor] of Object.entries(record.original)) {
        if (descriptor) Object.defineProperty(element, name, descriptor);
        else delete element[name];
    }
}
export const getValue = (element) =>
    isFrame(element)
        ? iframe.getValue(element)
        : isNative(element)
          ? element.value
          : rich.getValue(element);
export function setValue(element, value, options = {}) {
    if (isFrame(element)) return iframe.setValue(element, value, options);
    if (!isNative(element)) return rich.setValue(element, value, options);
    const record = native.get(element);
    if (!record) throw new Error("Editor has not initialized.");
    const before = record.value;
    element.value = String(value ?? "");
    record.value = element.value;
    if (!options.silent && before !== record.value)
        element.dispatchEvent(
            new CustomEvent("editor-source-change", {
                detail: { before, value: record.value }
            })
        );
}
export function heal(element) {
    if (isFrame(element)) return iframe.heal(element);
    if (!isNative(element)) return rich.heal(element);
}
export function setType(element) {
    if (isFrame(element)) return iframe.create(element);
    return isNative(element) ? create(element) : rich.setType(element);
}
export async function getSelection(element) {
    if (isFrame(element)) return iframe.getSelection(element);
    if (!isNative(element)) return rich.getSelection(element);
    if (!native.has(element)) await create(element);
    const from = element.selectionStart ?? element.value.length,
        to = element.selectionEnd ?? from;
    const backward = element.selectionDirection === "backward";
    return {
        from,
        to,
        anchor: backward ? to : from,
        head: backward ? from : to,
        empty: from === to,
        type: "text"
    };
}
export async function setSelection(element, anchor, head = anchor) {
    if (isFrame(element)) return iframe.setSelection(element, anchor, head);
    if (!isNative(element)) return rich.setSelection(element, anchor, head);
    await create(element);
    if (
        !Number.isInteger(anchor) ||
        !Number.isInteger(head) ||
        Math.min(anchor, head) < 0 ||
        Math.max(anchor, head) > element.value.length
    )
        throw new RangeError("Invalid editor source range.");
    element.focus();
    if (element.selectionStart !== null)
        element.setSelectionRange(
            Math.min(anchor, head),
            Math.max(anchor, head),
            anchor > head ? "backward" : "forward"
        );
}
export async function replaceRange(element, value, { from, to }) {
    if (isFrame(element))
        return iframe.replaceRange(element, value, { from, to });
    if (!isNative(element))
        return rich.replaceRange(element, value, { from, to });
    await create(element);
    if (
        !Number.isInteger(from) ||
        !Number.isInteger(to) ||
        from < 0 ||
        to < from ||
        to > element.value.length
    )
        throw new RangeError("Invalid editor source range.");
    setValue(
        element,
        element.value.slice(0, from) + String(value) + element.value.slice(to)
    );
    await setSelection(
        element,
        Math.min(element.value.length, from + String(value).length)
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
}
export const insertPos = (element, value, position) =>
    replaceRange(element, value, { from: position, to: position });
export async function insert(element, value) {
    return replaceRange(element, value, await getSelection(element));
}
