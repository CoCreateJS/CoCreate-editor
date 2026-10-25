import { boundaryFor, getSelection, isNative, project, sourceAt, sourceProjection, surface } from "./selection.js";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });
const normalize = value => value.replace(/\r\n?/g, "\n");

function difference(before, after, selection) {
    if (before === after) return { start: 0, end: 0, value: "" };
    // A known selection disambiguates edits in repeated text (for example aaa -> aaaa).
    if (selection) {
        const { start, end } = selection;
        const length = after.length - before.length + end - start;
        if (length >= 0 && before.slice(0, start) === after.slice(0, start) &&
            before.slice(end) === after.slice(start + length))
            return { start, end, value: after.slice(start, start + length) };
    }
    let start = 0, end = before.length, tail = after.length;
    while (start < end && start < tail && before[start] === after[start]) start++;
    while (end > start && tail > start && before[end - 1] === after[tail - 1]) { end--; tail--; }
    // Never split a surrogate pair when finding a minimal replacement.
    if (start > 0 && /[\uDC00-\uDFFF]/.test(before[start] || after[start] || "")) start--;
    if (/[\uDC00-\uDFFF]/.test(before[end] || after[tail] || "")) { end++; tail++; }
    return { start, end, value: after.slice(start, tail) };
}

function deletion(value, start, end, type) {
    if (start !== end || !/(Backward|Forward|EntireSoftLine)$/.test(type)) return { start, end };
    const backward = type.endsWith("Backward");
    if (/Line/.test(type)) {
        const lineStart = start ? value.lastIndexOf("\n", start - 1) + 1 : 0;
        const next = value.indexOf("\n", end);
        const lineEnd = next < 0 ? value.length : next;
        if (type === "deleteEntireSoftLine") return { start: lineStart, end: lineEnd };
        return backward ? { start: lineStart, end } : { start, end: lineEnd + (type === "deleteHardLineForward" && next >= 0 ? 1 : 0) };
    }
    const segments = [...(/Word/.test(type) ? words : graphemes).segment(value)];
    if (backward) {
        let index = segments.findLastIndex(part => part.index < start);
        if (/Word/.test(type)) while (index > 0 && /^\s+$/.test(segments[index].segment)) index--;
        return { start: segments[index]?.index ?? start, end };
    }
    let index = segments.findIndex(part => part.index + part.segment.length > end);
    if (/Word/.test(type)) while (index >= 0 && index < segments.length - 1 && /^\s+$/.test(segments[index].segment)) index++;
    const part = segments[index];
    return { start, end: part ? part.index + part.segment.length : end };
}

// Handlers submit source operations; the owner chooses local rendering or CRDT.
export default function createEvents({ updateText, sendPosition, clearPosition }) {
    const documents = new WeakSet();
    const listeners = new WeakMap();

    function initDocument(doc) {
        if (documents.has(doc)) return;
        documents.add(doc);
        doc.addEventListener("selectionchange", () => {
            const active = doc.activeElement;
            const root = active?.closest("[contenteditable], [editor], [editor-language], input, textarea");
            const target = root || doc.documentElement;
            const record = listeners.get(target);
            if (record?.enabled() && !record.element.editor.composing)
                sendPosition(record.element);
        });
        doc.addEventListener("cocreate-editor-claim", event => removeEventListeners(event.target));
        // Delegate reset so a long-lived form never holds a removed editor alive.
        doc.addEventListener("reset", event => {
            if (event.target.tagName !== "FORM") return;
            queueMicrotask(() => {
                if (event.defaultPrevented) return;
                for (const field of event.target.elements) listeners.get(field)?.acceptInput();
            });
        }, true);
    }

    function addEventListeners(element) {
        const target = surface(element);
        if (listeners.has(target)) return;
        const editor = element.editor;
        const abort = new target.ownerDocument.defaultView.AbortController();
        const record = { element, abort, pending: null };
        const enabled = () => element.getAttribute("crdt") === "true" ||
            element.hasAttribute("editor") || element.hasAttribute("editor-language") ||
            (element.hasAttribute("contenteditable") &&
                element.getAttribute("contenteditable") !== "false");
        record.enabled = enabled;
        const on = (node, type, handler) => node.addEventListener(type, handler, { signal: abort.signal });
        const readValue = () => String(element.getValue?.() ?? element.value ?? "");
        editor.inputValue = readValue();
        const writable = () => !element.matches(":disabled") && !element.hasAttribute("readonly") &&
            (isNative(element) || target.getAttribute("contenteditable") !== "false");
        const owns = event => {
            if (event.stopCCText || event.defaultPrevented || !enabled() ||
                boundaryFor(event.target, target)) return false;
            if (event.type === "input" && Object.prototype.hasOwnProperty.call(event.detail || {}, "value"))
                return event.target === target || event.target === element;
            if (event.type === "focusout") return true;
            const selection = target.ownerDocument.getSelection();
            return !boundaryFor(selection?.anchorNode, target) && !boundaryFor(selection?.focusNode, target);
        };
        const report = () => { if (!editor.composing) sendPosition(element); };
        const submit = data => {
            if (data.start === data.end && !data.value && !data.undoRedo) return;
            const previous = editor.inputValue;
            if (!data.undoRedo) editor.inputValue = editor.inputValue.slice(0, data.start) + (data.value || "") + editor.inputValue.slice(data.end);
            return Promise.resolve(updateText({ element, ...data, previous })).catch(error => {
                element.dispatchEvent(new CustomEvent("editor-error", { bubbles: true, detail: { error } }));
            });
        };
        const snapshot = () => ({
            view: isNative(element) ? null : project(target),
            mapped: isNative(element) ? null : sourceProjection(element),
            selection: getSelection(element)
        });
        const acceptInput = event => {
            const wholeValue = event && Object.prototype.hasOwnProperty.call(event.detail || {}, "value");
            if (!wholeValue && (editor.composing || event?.isComposing)) return;
            if (isNative(element) || wholeValue) {
                if (wholeValue) editor.composing = false;
                const value = readValue();
                const before = record.pending;
                let selection = wholeValue ? null : before?.selection;
                if (!wholeValue && event?.inputType?.startsWith("delete") && element.selectionStart !== null) {
                    const start = element.selectionStart;
                    selection = { start, end: start + editor.inputValue.length - value.length };
                }
                const change = difference(editor.inputValue, value, selection);
                record.pending = null;
                submit(change);
                return;
            }
            const before = record.pending;
            record.pending = null;
            if (!before) return;
            const view = project(target);
            if (before.view.text === view.text) return;
            const preferred = before.selection && { start: before.selection.visibleStart, end: before.selection.visibleEnd };
            const change = difference(before.view.text, view.text, preferred);
            const mapped = before.mapped;
            let start = mapped ? sourceAt(mapped, change.start) : change.start;
            let end = mapped ? sourceAt(mapped, change.end, true) : change.end;
            if (change.start === change.end) {
                end = start;
                if (before.selection?.visibleStart === change.start) start = end = before.selection.start;
            }
            submit({ start, end, value: change.value });
        };
        const history = (event, redo) => {
            if (!event.cancelable) return;
            event.preventDefault();
            submit({ undoRedo: redo ? "redo" : "undo" });
        };
        const handlers = {
            keydown(event) {
                if (!writable() || editor.composing || event.isComposing || event.keyCode === 229) return;
                const key = event.key.toLowerCase();
                if ((event.ctrlKey || event.metaKey) && !event.altKey &&
                    (key === "z" || (key === "y" && !event.shiftKey))) {
                    history(event, key === "y" || event.shiftKey);
                } else if (key === "tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
                    const selection = getSelection(element);
                    if (!selection || !event.cancelable) return;
                    event.preventDefault();
                    submit({ ...selection, value: "\t" });
                }
            },
            beforeinput(event) {
                if (!writable() || editor.composing || event.isComposing) return;
                const type = event.inputType;
                record.pending = null;
                if (type?.startsWith("format") && event.cancelable) { event.preventDefault(); return; }
                if (type === "historyUndo" || type === "historyRedo") {
                    if (!event.cancelable) record.pending = snapshot();
                    history(event, type === "historyRedo");
                    return;
                }
                // Native fields let the browser apply edits, then report one input difference.
                if (isNative(element) || !event.cancelable) { record.pending = snapshot(); return; }
                const range = event.getTargetRanges?.()[0];
                const selection = getSelection(element, range);
                if (!selection) return;
                let value;
                if (type === "insertParagraph" || type === "insertLineBreak") value = "\n";
                else if (type?.startsWith("insert")) value = event.data ?? event.dataTransfer?.getData("text/plain");
                else if (type?.startsWith("delete")) value = "";
                if (value === undefined || value === null) { record.pending = snapshot(); return; }
                event.preventDefault();
                record.pending = null;
                const positions = type.startsWith("delete")
                    ? deletion(editor.inputValue, selection.start, selection.end, type) : selection;
                submit({ ...positions, value: normalize(value) });
            },
            input: acceptInput,
            compositionstart() { editor.composing = true; record.pending = snapshot(); },
            compositionend() {
                // Some browsers deliver the final input after compositionend.
                queueMicrotask(() => {
                    if (abort.signal.aborted) return;
                    editor.composing = false;
                    acceptInput();
                    report();
                });
            },
            paste(event) {
                if (isNative(element) || !writable() || editor.composing || !event.cancelable) return;
                const selection = getSelection(element);
                if (!selection || !event.clipboardData) return;
                const value = normalize(event.clipboardData.getData("text/plain"));
                event.preventDefault();
                if (value) submit({ ...selection, value });
            },
            cut(event) {
                if (isNative(element) || !writable() || editor.composing || !event.cancelable) return;
                const selection = getSelection(element);
                if (!selection || selection.start === selection.end || !event.clipboardData) return;
                event.clipboardData.setData("text/plain", target.ownerDocument.getSelection().toString());
                event.preventDefault();
                submit({ ...selection, value: "" });
            },
            focusout(event) {
                if (target.contains(event.relatedTarget) && !boundaryFor(event.relatedTarget, target)) return;
                if (editor.composing) queueMicrotask(() => {
                    if (abort.signal.aborted) return;
                    editor.composing = false;
                    acceptInput();
                });
                clearPosition(element);
            },
            pointerup: report, keyup: report, select: report
        };
        try {
            for (const [type, handler] of Object.entries(handlers)) on(target, type, event => {
                if (!owns(event)) return;
                const reset = Object.prototype.hasOwnProperty.call(event.detail || {}, "value");
                if (type === "input" && reset) handler(event);
                else if (writable() || ["focusout", "pointerup", "keyup", "select"].includes(type)) handler(event);
            });
            record.acceptInput = () => { if (enabled()) acceptInput(); };
            // Shared iframe setters dispatch on the iframe, user edits on its document.
            if (target !== element) on(element, "input", event => { if (owns(event)) acceptInput(event); });
            listeners.set(target, record);
            initDocument(target.ownerDocument);
            editor.init = true;
        } catch (error) {
            abort.abort();
            listeners.delete(target);
            throw error;
        }
    }

    function removeEventListeners(element) {
        const target = surface(element), record = listeners.get(target);
        if (!record) return;
        record.abort.abort();
        listeners.delete(target);
        record.element.editor.composing = false;
        record.element.editor.init = false;
    }

    return { initDocument, addEventListeners, removeEventListeners };
}
