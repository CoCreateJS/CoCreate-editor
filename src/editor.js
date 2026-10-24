import { boundaryFor, selectionBoundary } from "./boundaries.js";
import { renderSource, valueType } from "./render.js";
import { renderDocument, reconcileDocument } from "./document.js";
import { subscribeSyntax } from "./config.js";
import { project, sourceAt, reconcile } from "./projection.js";
const records = new WeakMap();
export function create(element, options = {}) {
    if (records.has(element)) return records.get(element).ready;
    if (!(element instanceof element.ownerDocument.defaultView.HTMLElement))
        throw new TypeError("The editor expects an HTML element.");
    const original = Object.fromEntries(
        ["value", "getValue", "getValueAsync", "setValue"].map((name) => [
            name,
            Object.getOwnPropertyDescriptor(element, name)
        ])
    );

    const record = {
        value: "",
        type: options.documentMode ? "html" : valueType(element),
        documentMode: !!options.documentMode,
        editable: options.editable,
        reference: options.reference || element,
        version: 0,
        original,
        element,
        listeners: new AbortController()
    };
    records.set(element, record);
    // Capture writes before invoking the previous reader. Keep the original value
    // property intact until that reader has inspected it.
    Object.defineProperty(element, "setValue", {
        configurable: true,
        value: (value, dispatch = false) => {
            setValue(element, value);
            if (dispatch)
                element.dispatchEvent(new Event("input", { bubbles: true }));
        }
    });
    let initialValue;
    try {
        const plainDOM =
            record.type === "text" &&
            !original.getValue &&
            !original.value &&
            !element.hasAttribute("component") &&
            !element.hasAttribute("value");
        initialValue =
            options.initialSource !== undefined
                ? options.initialSource
                : plainDOM || typeof element.getValue !== "function"
                  ? element.textContent
                  : element.getValue();
        Object.defineProperties(element, {
            value: {
                configurable: true,
                get: () => record.value,
                set: (value) => setValue(element, value)
            },
            getValue: { configurable: true, value: () => record.value },
            getValueAsync: {
                configurable: true,
                value: async () => record.value
            }
        });
        if (!initialValue || typeof initialValue.then !== "function") {
            // Complete synchronous handoffs in this call stack, before rendering.
            if (record.version === 0) element.setValue(initialValue);
            record.ready = mount(record);
        } else {
            record.ready = Promise.resolve(initialValue).then((value) => {
                if (records.get(element) !== record) return;
                if (record.version === 0) element.setValue(value);
                return mount(record);
            });
        }
    } catch (error) {
        record.ready = Promise.reject(error);
    }
    record.ready = record.ready.catch((error) => {
        if (records.get(element) === record) destroy(element);
        throw error;
    });
    return record.ready;
}

export function setType(element) {
    const record = records.get(element);
    if (!record) return create(element);
    const type = valueType(element);
    if (type === record.type) return;
    record.type = type;
    if (!record.composing) record.replace?.(record.value);
}

export function getValue(element) {
    return records.get(element)?.value;
}

export function setValue(element, value, options = {}) {
    const record = records.get(element);
    if (!record) throw new Error("Editor has not been initialized.");
    const before = record.value;
    record.version++;
    if (record.undo) {
        record.undo.length = 0;
        record.redo.length = 0;
    }
    record.value = String(value ?? "");
    if (record.composing) record.pending = true;
    else record.replace?.(record.value);
    if (!options.silent) changed(record, before);
}

function recordFor(element) {
    const record = records.get(element);
    if (!record?.host) throw new Error("Editor has not finished initializing.");
    return record;
}
function selection(record, projection = record.projection) {
    const sel = record.element.ownerDocument.defaultView.getSelection();
    if (
        !sel?.rangeCount ||
        !record.host.contains(sel.anchorNode) ||
        !record.host.contains(sel.focusNode) ||
        boundaryFor(sel.anchorNode, record.host) ||
        boundaryFor(sel.focusNode, record.host)
    )
        return null;
    const anchor =
        projection.points.get(sel.anchorNode)?.[sel.anchorOffset] ?? 0;
    const head =
        projection.points.get(sel.focusNode)?.[sel.focusOffset] ?? anchor;
    return { anchor, head };
}
function sourcePoint(record, node, offset, end = false) {
    if (node.nodeType === 3 && node._sourceMap) {
        return offset < node._sourceMap.length
            ? node._sourceMap[offset][0]
            : (node._sourceMap.at(-1)?.[1] ?? 0);
    }
    if (
        node.nodeType === 1 &&
        (node !== record.host || record.documentMode) &&
        node.hasAttribute("data-source-content-start") &&
        !node.textContent &&
        !node.querySelector("[data-source-void]")
    )
        return Number(node.dataset.sourceContentStart);
    if (
        node.nodeType === 1 &&
        offset > 0 &&
        node.childNodes[offset - 1]?.dataset?.sourceAfter
    )
        return Number(node.childNodes[offset - 1].dataset.sourceAfter);
    if (node.nodeType === 3 && node._mdMap) {
        const base = Number(
            node.parentElement.closest("[data-md-start]")?.dataset.mdStart || 0
        );
        return (
            base +
            (offset < node._mdMap.length
                ? node._mdMap[offset]
                : (node._mdMap.at(-1) ?? -1) + 1)
        );
    }
    if (node.nodeType === 1 && offset > 0) {
        const previous = node.childNodes[offset - 1];
        if (
            previous?.nodeType === 1 &&
            previous.hasAttribute("data-md-after")
        ) {
            return (
                Number(
                    previous.closest("[data-md-start]")?.dataset.mdStart || 0
                ) + Number(previous.dataset.mdAfter)
            );
        }
    }
    return sourceAt(
        record.projection,
        record.projection.points.get(node)?.[offset] ?? 0,
        end
    );
}
function rememberSelection(record) {
    const current = selection(record),
        sel = record.element.ownerDocument.defaultView.getSelection();
    if (current)
        record.lastSelection = {
            anchor: sourcePoint(record, sel.anchorNode, sel.anchorOffset),
            head: sourcePoint(
                record,
                sel.focusNode,
                sel.focusOffset,
                current.head > current.anchor
            ),
            visibleAnchor: current.anchor,
            visibleHead: current.head
        };
}
function selectSource(record, anchor, head = anchor) {
    const nodes = [];
    const walker = record.element.ownerDocument.createTreeWalker(
        record.host,
        4
    );
    let node;
    while ((node = walker.nextNode()))
        if (!boundaryFor(node, record.host) && (node._mdMap || node._sourceMap))
            nodes.push(node);
    function point(position) {
        for (const container of record.host.querySelectorAll(
            "[data-source-after]"
        )) {
            if (Number(container.dataset.sourceAfter) === position)
                return [
                    container.parentNode,
                    [...container.parentNode.childNodes].indexOf(container) + 1
                ];
            if (
                !container.textContent &&
                !container.hasAttribute("data-source-void") &&
                !container.querySelector("[data-source-void]") &&
                position >= Number(container.dataset.sourceContentStart) &&
                position <= Number(container.dataset.sourceContentEnd)
            )
                return [container, 0];
        }
        for (const br of record.host.querySelectorAll("[data-md-after]")) {
            const base = Number(
                br.closest("[data-md-start]")?.dataset.mdStart || 0
            );
            if (base + Number(br.dataset.mdAfter) === position)
                return [
                    br.parentNode,
                    [...br.parentNode.childNodes].indexOf(br) + 1
                ];
        }
        let last;
        for (const text of nodes) {
            const base = Number(
                text.parentElement.closest("[data-md-start]")?.dataset
                    .mdStart || 0
            );
            for (let i = 0; i < text.length; i++) {
                const span = text._sourceMap?.[i];
                if (
                    span
                        ? position < span[1]
                        : base + text._mdMap[i] >= position
                )
                    return [text, i];
                last = [text, i + 1];
            }
        }
        return last || [record.host, 0];
    }
    const sel = record.element.ownerDocument.defaultView.getSelection();
    sel.setBaseAndExtent(...point(anchor), ...point(head));
}
export function heal(element) {
    const record = recordFor(element);
    if (!record.composing) record.replace(record.value);
}
export async function getSelection(element) {
    if (!records.has(element)) await create(element);
    const record = recordFor(element),
        current = selection(record);
    const sel = record.element.ownerDocument.defaultView.getSelection();
    const anchor = current
        ? sourcePoint(record, sel.anchorNode, sel.anchorOffset)
        : record.value.length;
    const head = current
        ? sourcePoint(
              record,
              sel.focusNode,
              sel.focusOffset,
              current.head > current.anchor
          )
        : anchor;
    return {
        anchor,
        head,
        from: Math.min(anchor, head),
        to: Math.max(anchor, head),
        empty: anchor === head,
        type: "text"
    };
}
export async function setSelection(element, anchor, head = anchor) {
    await create(element);
    const record = recordFor(element);
    checkRange(record, Math.min(anchor, head), Math.max(anchor, head));
    record.host.focus();
    selectSource(record, anchor, head);
}
function checkRange(record, from, to) {
    if (
        !Number.isInteger(from) ||
        !Number.isInteger(to) ||
        from < 0 ||
        to < from ||
        to > record.value.length
    )
        throw new RangeError("Invalid editor source range.");
}
export async function replaceRange(element, value, { from, to }) {
    await create(element);
    const record = recordFor(element);
    checkRange(record, from, to);
    commit(
        record,
        record.value.slice(0, from) + String(value) + record.value.slice(to),
        from + String(value).length
    );
}
export async function insertPos(element, value, position) {
    return replaceRange(element, value, { from: position, to: position });
}
export async function insert(element, value) {
    const { from, to } = await getSelection(element);
    return replaceRange(element, value, { from, to });
}
function staging(record) {
    return record.documentMode
        ? renderDocument(record.value, record.host.ownerDocument)
        : renderSource(record.value, record.type);
}
function paint(record, caret) {
    const staged = (record.staged = staging(record));
    if (record.documentMode)
        reconcileDocument(record.host.ownerDocument, staged);
    else reconcile(record.host, staged);
    record.projection = project(record.host, record.value);
    record.host.toggleAttribute("data-empty", !record.value.length);
    if (caret !== undefined) {
        const clamp = (value) =>
            Math.max(0, Math.min(record.value.length, value));
        if (typeof caret === "object")
            selectSource(record, clamp(caret.anchor), clamp(caret.head));
        else selectSource(record, clamp(caret));
    }
    rememberSelection(record);
}
function publish(record) {
    record.host.removeAttribute("aria-invalid");
    if (record.handlingInput && record.host === record.reference) return;
    record.publishing = true;
    try {
        record.reference.dispatchEvent(new Event("input", { bubbles: true }));
    } finally {
        record.publishing = false;
    }
}
function changed(record, before) {
    if (before !== record.value)
        record.reference.dispatchEvent(
            new CustomEvent("editor-source-change", {
                detail: { before, value: record.value }
            })
        );
}
function commit(record, value, caret) {
    const before = record.value;
    if (value === record.value) {
        paint(record, caret);
        return;
    }
    record.undo.push({ value: record.value, selection: record.lastSelection });
    if (record.undo.length > 100) record.undo.shift();
    record.redo.length = 0;
    record.value = value;
    paint(record, caret);
    changed(record, before);
    publish(record);
}
function acceptInput(record) {
    if (record.composing) return;
    if (record.pending) {
        record.pending = false;
        paint(record);
        return;
    }
    const live = project(record.host),
        old = record.projection;
    const current = selection(record, live);
    let start = 0,
        oldEnd = old.text.length,
        newEnd = live.text.length;
    while (
        start < oldEnd &&
        start < newEnd &&
        old.text[start] === live.text[start]
    )
        start++;
    while (
        oldEnd > start &&
        newEnd > start &&
        old.text[oldEnd - 1] === live.text[newEnd - 1]
    ) {
        oldEnd--;
        newEnd--;
    }
    if (old.text === live.text) {
        paint(record);
        return;
    }
    let from =
            record.documentMode && !old.spans.length
                ? Number(
                      record.host.ownerDocument.body.dataset
                          .sourceContentStart || 0
                  )
                : sourceAt(old, start),
        to = oldEnd === start ? from : sourceAt(old, oldEnd, true);
    if (
        start === oldEnd &&
        record.lastSelection?.anchor === record.lastSelection?.head &&
        record.lastSelection?.visibleHead === start
    ) {
        from = to = record.lastSelection.head;
    }
    if (start === 0 && oldEnd === old.text.length && oldEnd > 0) {
        from = record.documentMode ? sourceAt(old, 0) : 0;
        to = record.documentMode
            ? sourceAt(old, oldEnd, true)
            : record.value.length;
    }
    const inserted = live.text.slice(start, newEnd);
    const value =
        record.value.slice(0, from) + inserted + record.value.slice(to);
    const caret =
        from + (current ? Math.max(0, current.head - start) : inserted.length);
    commit(record, value, Math.min(value.length, caret));
}
async function mount(record) {
    const { element } = record;
    if (records.get(element) !== record) return;
    const host = (record.host = element);
    record.editorClass = host.classList.contains("cocreate-editor");
    record.hostAttributes = new Map(
        [
            "contenteditable",
            "role",
            "aria-multiline",
            "aria-label",
            "aria-required",
            "aria-invalid",
            "data-empty",
            "data-placeholder"
        ].map((name) => [name, host.getAttribute(name)])
    );
    host.classList.add("cocreate-editor");
    if (record.editable !== undefined)
        host.contentEditable = String(record.editable);
    else if (
        element.hasAttribute("disabled") ||
        element.hasAttribute("readonly")
    )
        host.contentEditable = "false";
    else if (!host.hasAttribute("contenteditable"))
        host.contentEditable = "true";
    host.setAttribute("role", "textbox");
    host.setAttribute("aria-multiline", "true");
    host.setAttribute(
        "aria-label",
        element.getAttribute("aria-label") || "Editor"
    );
    host.setAttribute(
        "aria-required",
        String(element.hasAttribute("required"))
    );
    if (element.getAttribute("editor-placeholder") !== "false")
        host.dataset.placeholder = element.getAttribute("placeholder") || "";
    record.undo = [];
    record.redo = [];
    record.replace = () => {
        rememberSelection(record);
        paint(record, selection(record) ? record.lastSelection : undefined);
    };
    const { signal } = record.listeners;
    const on = (target, name, fn) =>
        target.addEventListener(name, fn, { signal });
    on(element.ownerDocument, "selectionchange", () => {
        rememberSelection(record);
    });
    const nativeControl = (event) =>
        !!(boundaryFor(event.target, host) || selectionBoundary(host));
    on(host, "compositionstart", (event) => {
        if (nativeControl(event)) return;
        record.composing = true;
    });
    on(host, "compositionend", (event) => {
        if (nativeControl(event)) return;
        record.composing = false;
        acceptInput(record);
    });
    on(host, "input", (event) => {
        if (record.publishing || nativeControl(event)) return;
        record.handlingInput = true;
        try {
            acceptInput(record);
        } finally {
            record.handlingInput = false;
        }
    });
    on(host, "keydown", (event) => {
        if (nativeControl(event)) return;
        rememberSelection(record);
        if (
            (event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            ["z", "y"].includes(event.key.toLowerCase()) &&
            !record.composing
        ) {
            event.preventDefault();
            const redo = event.shiftKey || event.key.toLowerCase() === "y";
            if (element.__cocreateEditor?.history) {
                element.__cocreateEditor.history(redo);
                return;
            }
            const from = redo ? record.redo : record.undo,
                to = redo ? record.undo : record.redo;
            if (!from.length) return;
            to.push({ value: record.value, selection: record.lastSelection });
            const next = from.pop();
            const before = record.value;
            record.value = next.value;
            paint(record, next.selection?.head ?? record.value.length);
            changed(record, before);
            publish(record);
        }
    });
    on(host, "paste", (event) => {
        if (nativeControl(event)) return;
        event.preventDefault();
        if (record.composing || !host.isContentEditable) return;
        insert(element, event.clipboardData?.getData("text/plain") || "");
    });
    on(host, "blur", () =>
        record.reference.dispatchEvent(new Event("change", { bubbles: true }))
    );
    record.unsubscribeSyntax = subscribeSyntax(() => {
        if (!record.composing) {
            try {
                record.replace(record.value);
            } catch (error) {
                element.dispatchEvent(
                    new CustomEvent("editor-error", {
                        bubbles: true,
                        detail: { error }
                    })
                );
            }
        }
    });
    paint(record);
    const editor = {
        element: record.reference,
        host,
        document: record.documentMode ? host.ownerDocument : undefined,
        staging: () => record.staged
    };
    record.reference.dispatchEvent(
        new CustomEvent("editor-ready", { bubbles: true, detail: { editor } })
    );
    return editor;
}
export function destroy(element) {
    const record = records.get(element);
    if (!record) return;
    records.delete(element);
    record.listeners.abort();
    record.unsubscribeSyntax?.();
    if (record.hostAttributes) {
        for (const [name, value] of record.hostAttributes) {
            if (value === null) element.removeAttribute(name);
            else element.setAttribute(name, value);
        }
        if (!record.editorClass) element.classList.remove("cocreate-editor");
    } else record.host?.remove();
    for (const [name, descriptor] of Object.entries(record.original)) {
        if (descriptor) Object.defineProperty(element, name, descriptor);
        else delete element[name];
    }
    if (record.host && !record.documentMode) {
        // Hand the current source back to the host's restored value API.
        if (typeof element.setValue === "function")
            element.setValue(record.value);
        else element.textContent = record.value;
    }
}
