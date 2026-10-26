import { createEditorEvents, bindEditorInput } from "./events.js";
import { getSelection, setSelection } from "./selection.js";
import { updateStoredEditorDetails, getStoredEditorDetails, deleteStoredEditorDetails,
    parseAndStoreEditorDetails, parseAndStoreTextDetails, parseAndStoreMarkdownDetails,
    parseAndStoreCodeDetails, loadEditor, updateEditorDetails } from "./editors/index.js";

function readSource(element, mode) {
    if (typeof element.editor?.getSource === "function") return element.editor.getSource();
    if (typeof element.value === "string") return element.value;
    return element.textContent || "";
}

function modeFor(element, requested) {
    if (requested) return requested;
    const type = element.getAttribute?.("editor")?.trim().toLowerCase();
    if (["dom", "markdown", "code"].includes(type)) return type;
    if (element.hasAttribute?.("editor-language")) return "code";
    return "text";
}

function mapOffset(offset, start, deletedLength, insertedLength) {
    if (offset < start) return offset;
    if (offset >= start + deletedLength) return offset + insertedLength - deletedLength;
    return start + insertedLength;
}

function applyTextSource(element, source, update) {
    const selection = getSelection(element);
    if (typeof element.value === "string") element.value = source;
    else element.textContent = source;
    if (selection) setSelection(element, {
        start: mapOffset(selection.start, update.start, update.length ?? 0, update.value.length),
        end: mapOffset(selection.end, update.start, update.length ?? 0, update.value.length)
    });
}

function dispatch(element, type, detail) {
    const EventConstructor = element.ownerDocument?.defaultView?.CustomEvent || globalThis.CustomEvent;
    if (EventConstructor) element.dispatchEvent(new EventConstructor(type, { bubbles: true, detail }));
}

/** Connect source input, selection/diff helpers, and editor-detail updates. */
export function createPrototypeCore({ updateText, eventTarget = globalThis.window } = {}) {
    const events = createEditorEvents();
    const activeEditors = new Map();

    function initEditor(element, options = {}) {
        if (!element || (typeof element !== "object" && typeof element !== "function"))
            throw new TypeError("An editor element is required.");
        const mode = modeFor(element, options.mode);
        const language = options.language || element.getAttribute?.("editor-language") || "text";
        const current = activeEditors.get(element);
        if (current && !options.force && current.mode === mode && current.language === language)
            return current.ready;
        current?.input?.disconnect?.();
        const source = String(options.source ?? readSource(element, mode));
        const modulePromise = loadEditor(mode);
        const detailsPromise = mode === "dom" ? parseAndStoreEditorDetails(element, source)
            : mode === "markdown" ? parseAndStoreMarkdownDetails(element, source)
                : mode === "code" ? parseAndStoreCodeDetails(element, source, language)
                    : parseAndStoreTextDetails(element, source);

        const state = { element, mode, language, source, details: null, input: null, ready: null, module: null };
        activeEditors.set(element, state);
        state.ready = Promise.all([modulePromise, detailsPromise]).then(([module, details]) => {
            if (activeEditors.get(element) !== state) return details;
            state.module = module;
            state.details = details;
            if (element.ownerDocument) module.renderEditor?.(element, source, details);
            element.editor ||= {};
            if (element.ownerDocument && module.getSource)
                element.editor.getSource = () => module.getSource(element);
            state.input = bindEditorInput(element, {
                readValue: options.readValue || (() => element.ownerDocument
                    ? module.getSource?.(element) ?? readSource(element, mode)
                    : readSource(element, mode)),
                mapSelection: mode === "text",
                onUpdate: change => {
                    const submit = options.updateText || updateText || element.editor?.updateText;
                    if (typeof submit !== "function") {
                        const previous = state.source;
                        const source = previous.slice(0, change.start) + change.value +
                            previous.slice(change.start + change.length);
                        const result = receiveUpdate({ elements: [element], ...change, string: source, local: true });
                        events.emit("text-update", { element, ...change, string: source });
                        dispatch(element, "editor-source-change", { before: previous, value: source });
                        return result;
                    }
                    return submit({ element, start: change.start, length: change.length, value: change.value });
                },
                onSelection: selection => events.emit("selection-change", { element, selection })
            });
            state.input.setValue(source);
            events.emit("editor-init", { element, mode, language, details });
            return details;
        });
        return state.ready;
    }

    async function receiveUpdate(update) {
        if (!update || typeof update !== "object")
            throw new TypeError("A CRDT update object is required.");
        const explicit = update.elements ? [...update.elements] : [];
        const targets = explicit.length ? explicit : [...activeEditors.keys()].filter(element =>
            (!update.array || element.getAttribute?.("array") === update.array) &&
            (!update.object || element.getAttribute?.("object") === update.object) &&
            (!update.key || element.getAttribute?.("key") === update.key));
        const results = [];
        for (const element of targets) {
            if (!getStoredEditorDetails(element)) continue;
            const result = updateStoredEditorDetails(element, update);
            const state = activeEditors.get(element);
            if (state) {
                state.source = result.source;
                state.input?.setValue(result.source);
                // The details transaction has already applied the change to
                // referenced live DOM nodes. Plain text surfaces need their
                // value/textContent synchronized separately; rendered modes
                // must keep the nodes managed by their details array.
                if (state.mode === "text" && !update.local) {
                    applyTextSource(element, result.source, update);
                }
                state.details = result.editorDetails;
            }
            const output = { ...result, editorDetails: state?.details || result.editorDetails };
            events.emit("editor-update", { element, update, result: output });
            dispatch(element, "editor-details-change", { update, result: output });
            results.push(output);
        }
        return results;
    }

    async function init(root = globalThis.document) {
        if (!root?.querySelectorAll) return [];
        const selector = "textarea, input, [contenteditable], [editor], [editor-language]";
        const elements = [...root.querySelectorAll(selector)].filter(element => {
            if (element.getAttribute("contenteditable") === "false") return false;
            if (element.tagName !== "INPUT") return true;
            return ["", "text", "search", "tel", "url", "email"]
                .includes(element.getAttribute("type")?.toLowerCase() || "");
        });
        return Promise.all(elements.map(element => initEditor(element)));
    }

    function destroyEditor(element) {
        const state = activeEditors.get(element);
        if (!state) return false;
        state.input?.disconnect();
        activeEditors.delete(element);
        deleteStoredEditorDetails(element);
        events.emit("editor-destroy", { element });
        return true;
    }

    const onCRDTUpdate = event => receiveUpdate(event.detail).catch(error => {
        if (event.detail?.elements) for (const element of event.detail.elements)
            dispatch(element, "editor-error", { error });
    });
    eventTarget?.addEventListener?.("cocreate-crdt-update", onCRDTUpdate);

    return {
        events,
        init,
        initEditor,
        receiveUpdate,
        destroyEditor,
        updateEditorDetails,
        getEditorDetails: getStoredEditorDetails,
        getSelection,
        disconnect() {
            eventTarget?.removeEventListener?.("cocreate-crdt-update", onCRDTUpdate);
            for (const element of activeEditors.keys()) destroyEditor(element);
            events.clear();
        }
    };
}

export * from "./editors/index.js";
export default createPrototypeCore;
