import { bindEditorInput } from "./events.js";
import { getSelection, setSelection } from "./selection.js";
import observer from "@cocreate/observer";

const bindings = new WeakMap();
const queryBindings = new WeakMap();
const projectionSelector = "[editor-query], [editor-attribute], [editor-property]";
let queryElementsPromise;

function attributeRange(editor, part) {
    const source = editor.value;
    if (part === "name") {
        const end = source.search(/[\t\n\f\r ]|=/);
        return { start: 0, end: end < 0 ? source.length : end };
    }
    const equals = source.indexOf("=");
    if (equals < 0) return { start: source.length, end: source.length };
    let start = equals + 1;
    while (/[\t\n\f\r ]/.test(source[start] || "")) start++;
    const quote = source[start] === "\"" || source[start] === "'" ? source[start++] : "";
    if (quote) {
        const close = source.indexOf(quote, start);
        return { start, end: close < 0 ? source.length : close };
    }
    let end = start;
    while (end < source.length && !/[\t\n\f\r >]/.test(source[end])) end++;
    return { start, end };
}

function getAttributeEditor(target, name) {
    const native = target?.getAttributeNode?.(name);
    return native?.editor || target?.editor?.getAttribute?.(name) || null;
}

function getTextEditor(target) {
    const targetEditor = target?.editor;
    if (targetEditor?.kind === "text") return targetEditor;
    if (targetEditor?.kind !== "element") return null;
    const details = targetEditor.element?.editor?.nodes;
    if (!Array.isArray(details)) return null;
    for (const detail of details) {
        if (detail.kind !== "text" || detail.sourceOnly) continue;
        for (let parent = detail.parentNode; parent; parent = parent.parentNode)
            if (parent === targetEditor) return detail;
    }
    return null;
}

function readPart(detail, part) {
    if (!detail) return "";
    const range = attributeRange(detail, part);
    return detail.value.slice(range.start, range.end);
}

function readStyleProperty(detail, property) {
    const name = property?.toLowerCase();
    return (detail?.getStyles?.().find(style => style.property.toLowerCase() === name)?.value || "")
        .replace(/\s*!important\s*$/i, "").trim();
}

function editorAttribute(input) {
    for (const attribute of input.attributes || []) {
        if (attribute.name.startsWith("editor.") && attribute.name !== "editor.query")
            return attribute.name.slice(7);
    }
    return null;
}

function isStateControl(input) {
    return ["checkbox", "radio", "date", "datetime", "datetime-local", "file", "month", "time", "week"]
        .includes(input.type?.toLowerCase());
}

function setControlValue(input, value) {
    input.setValue(value);
}

function readControlValue(input) {
    return input.getValue();
}

function readElementTag(target) {
    return target?.editor?.tag || target?.editor?.liveNode?.localName || target?.localName || "";
}

function reportControlUpdate(input, update) {
    try {
        return Promise.resolve(typeof update === "function" ? update() : update).catch(error => {
            const EventConstructor = input.ownerDocument?.defaultView?.CustomEvent || CustomEvent;
            input.dispatchEvent(new EventConstructor("editor-error", { bubbles: true, detail: { error } }));
        });
    } catch (error) {
        const EventConstructor = input.ownerDocument?.defaultView?.CustomEvent || CustomEvent;
        input.dispatchEvent(new EventConstructor("editor-error", { bubbles: true, detail: { error } }));
        return Promise.resolve();
    }
}

async function findTarget(context, selector) {
    if (!selector) return null;
    queryElementsPromise ||= import("@cocreate/utils/browser").then(module => module.queryElements)
        .catch(error => { queryElementsPromise = undefined; throw error; });
    const queryElements = await queryElementsPromise;
    return queryElements({ element: context, selector })?.[0] || null;
}

/** Bind a small input to one live DOM attribute through its editor detail. */
export async function initEditorInput(input, { context = input?.ownerDocument, query,
    target: initialTarget, attribute, part = "value" } = {}) {
    if (!input?.addEventListener) throw new TypeError("An input element is required.");
    const descriptor = typeof attribute === "string" ? { name: attribute } : attribute;
    const name = descriptor?.name || input.getAttribute("editor-attribute") || editorAttribute(input);
    const editorType = input.getAttribute("editor-type") || (name ? "attribute" : "text");
    const control = isStateControl(input);
    const mode = editorType === "attribute" || (name && editorType !== "element") ? "attribute"
        : editorType === "element" ? "element" : "text";
    part = descriptor?.part || input.getAttribute("editor-attribute-part") || part;
    const property = input.getAttribute("editor-property") || descriptor?.property || null;
    query ||= input.getAttribute("editor-query");
    if (mode === "attribute" && !name)
        throw new TypeError('Attribute controls require an editor.<name> attribute or editor-attribute.');
    if (mode === "attribute" && part !== "name" && part !== "value")
        throw new TypeError('Attribute part must be "name" or "value".');
    if (property && (mode !== "attribute" || name.toLowerCase() !== "style"))
        throw new TypeError('editor-property requires editor-attribute="style".');

    bindings.get(input)?.disconnect();
    const controller = new AbortController();
    let target = null;
    let detail = null;
    let inputBinding = null;
    let syncingControl = false;
    let writingMissingAttribute = false;
    let queuedAttributeValue = null;

    const readTargetValue = () => mode === "attribute"
        ? target?.getAttribute?.(name) ?? ""
        : mode === "element" ? readElementTag(target) : detail?.value || "";

    const syncControl = value => {
        if (!control) return;
        syncingControl = true;
        try { setControlValue(input, value); }
        finally { syncingControl = false; }
    };

    const writeControl = () => {
        if (syncingControl || !target || !control) return;
        const editor = target.editor;
        if (!editor) return;
        const value = readControlValue(input);
        if (mode === "attribute" && property)
            return reportControlUpdate(input, () => getAttributeEditor(target, name)?.setStyle(property, value));
        if (mode === "attribute")
            return reportControlUpdate(input, () => editor.setAttribute?.(name, value));
        if (mode === "element") {
            return reportControlUpdate(input, () => editor.setTagName?.(value));
        }
        if (mode === "text")
            return reportControlUpdate(input, () => getTextEditor(target)?.setValue(String(value ?? "")));
    };

    let generation = 0;
    const resolve = async () => {
        const currentGeneration = ++generation;
        const nextTarget = initialTarget || await findTarget(context, query);
        if (currentGeneration !== generation) return;
        target = nextTarget;
        detail = mode === "attribute" ? getAttributeEditor(target, name)
            : mode === "element" ? target?.editor : getTextEditor(target);
        const value = property ? readStyleProperty(detail, property)
            : mode === "attribute" ? readPart(detail, part)
            : mode === "element" ? readElementTag(target) : detail?.value || "";
        if (control) syncControl(readTargetValue());
        if (!control && typeof input.value === "string") input.value = value;
        inputBinding?.setValue(value);
    };

    const getCurrentDetail = () => target ? mode === "attribute"
        ? getAttributeEditor(target, name) : mode === "element" ? target.editor : getTextEditor(target) : detail;
    const write = change => {
        const current = getCurrentDetail();
        if (current) {
            if (property) return change.string
                ? current.setStyle(property, change.string)
                : current.removeStyle(property);
            const range = mode === "attribute" ? attributeRange(current, part)
                : { start: 0, end: current.length };
            return current.updateText({ start: range.start + change.start,
                length: change.length, value: change.value });
        }
        if (property && mode === "attribute" && target?.editor?.setAttribute) {
            return reportControlUpdate(input, () => change.string
                ? target.editor.setAttribute(name, `${property}: ${change.string}`)
                : target.editor.removeAttribute(name));
        }
        if (mode === "attribute" && target?.editor?.setAttribute) {
            queuedAttributeValue = change.string;
            if (!writingMissingAttribute) {
                const flush = () => {
                    const value = queuedAttributeValue;
                    queuedAttributeValue = null;
                    writingMissingAttribute = true;
                    reportControlUpdate(input, () => target?.editor?.setAttribute(name, value)).finally(() => {
                        if (queuedAttributeValue !== null) flush();
                        else writingMissingAttribute = false;
                    });
                };
                flush();
            }
            return;
        }
        if (mode !== "text" || target?.editor?.kind !== "element") return;
        const point = target.editor.getInsertionPoint("afterbegin");
        if (!point) return;
        const start = point.offset + change.start;
        if (start + change.length <= point.editor.length)
            return point.editor.updateText({ start, length: change.length, value: change.value });
        const root = target.editor.element;
        if (typeof root?.editor?.updateText === "function")
            return root.editor.updateText({ start: point.editor.getStart() + start,
                length: change.length, value: change.value });
    };

    if (control) input.addEventListener("change", writeControl, { signal: controller.signal });
    else inputBinding = bindEditorInput(input, {
        readValue: () => input.value,
        mapSelection: false,
        onUpdate: write
    });
    const onDetailsChange = event => {
        if (event.target !== target && !event.target?.contains?.(target)) return;
        const current = mode === "element" ? target?.editor : getCurrentDetail();
        if (!current) {
            if (control) syncControl("");
            if (!control && typeof input.value === "string") input.value = "";
            inputBinding?.setValue("");
            detail = null;
            return;
        }
        const update = event.detail?.update;
        const selection = getSelection(input);
        const oldRange = detail && mode !== "element" && !property ? mode === "attribute" ? attributeRange(detail, part)
            : { start: 0, end: detail.length } : null;
        let oldStart = null;
        try { if (detail && oldRange) oldStart = detail.getStart() + oldRange.start; } catch {}
        const value = property ? readStyleProperty(current, property)
            : mode === "attribute" ? readPart(current, part)
            : mode === "element" ? readElementTag(target) : current.value;
        const nextRange = mode === "element" || property ? null : mode === "attribute" ? attributeRange(current, part)
            : { start: 0, end: current.length };
        const nextStart = nextRange ? current.getStart() + nextRange.start : 0;
        if (control) syncControl(readTargetValue());
        if (!control && typeof input.value === "string" && input.value !== value) input.value = value;
        inputBinding?.setValue(value);
        if (!control && selection && update && Number.isInteger(oldStart) && nextRange) {
            const delta = update.value.length - (update.length ?? update.end - update.start);
            const shiftedStart = update.start + (update.length ?? update.end - update.start) <= oldStart
                ? oldStart + delta : oldStart;
            const map = offset => offset < update.start ? offset
                : offset >= update.start + (update.length ?? update.end - update.start)
                    ? offset + delta : update.start + update.value.length;
            setSelection(input, {
                start: Math.max(0, Math.min(value.length, map(shiftedStart + selection.start) - nextStart)),
                end: Math.max(0, Math.min(value.length, map(shiftedStart + selection.end) - nextStart))
            });
        }
        detail = current;
    };
    const binding = {
        input,
        get target() { return target; },
        get detail() { return getCurrentDetail(); },
        refresh: resolve,
        disconnect() {
            controller.abort();
            inputBinding?.disconnect();
            if (bindings.get(input) === binding) bindings.delete(input);
        }
    };
    bindings.set(input, binding);
    await resolve();
    const targetDocument = target?.ownerDocument;
    targetDocument?.addEventListener?.("editor-details-change", onDetailsChange, { signal: controller.signal });
    return binding;
}

function editorProjection(receiver, editor) {
    if (Array.isArray(editor)) return editor;
    if (editor?.kind === "attribute") {
        const name = receiver.getAttribute?.("editor-attribute");
        return !name?.trim() || editor.name?.toLowerCase() === name.trim().toLowerCase() ? editor : null;
    }
    const attributeName = receiver.getAttribute?.("editor-attribute");
    if (attributeName?.trim())
        return editor?.getAttribute?.(attributeName.trim()) || null;
    if (receiver.hasAttribute?.("editor-attributes"))
        return editor?.getAttributes?.() || [];
    if (receiver.hasAttribute?.("editor-nodes"))
        return editor?.nodes || [];
    return editor;
}

function isEditorHost(element) {
    const editor = element?.editor;
    return Boolean(editor && editor.element === element && Array.isArray(editor.nodes) &&
        typeof editor.init === "function");
}

function clickedEditorSource(receiver, event) {
    const node = event.detail?.target || event.target;
    if (!node?.nodeType) return null;

    const requiresElementEditor = receiver.hasAttribute?.("editor-attribute") ||
        receiver.hasAttribute?.("editor-attributes");
    const requiresAttributeCollection = receiver.hasAttribute?.("editor-attributes");
    for (let current = node; current; current = current.parentNode) {
        const editor = current.editor;
        if (editor && (!requiresElementEditor || typeof editor.getAttribute === "function") &&
            (!requiresAttributeCollection || typeof editor.getAttributes === "function"))
            return { target: current, editor };
    }
    return null;
}

/** Resolve an editor query or use the editor object already assigned by a renderer. */
export async function initEditorQuery(receiver, { context = receiver?.ownerDocument, query } = {}) {
    if (!receiver?.addEventListener) throw new TypeError("An editor query receiver is required.");
    query ??= receiver.getAttribute("editor-query");
    if (typeof query === "string" && !query.trim()) query = "";

    const previousBinding = queryBindings.get(receiver);
    const switchedToDirectEditor = previousBinding?.query && !query;
    const assignedEditor = switchedToDirectEditor
        ? receiver.editor || null : previousBinding?.sourceEditor || receiver.editor || null;
    previousBinding?.disconnect({ preserveEditor: true });
    const controller = new AbortController();
    let target = null, queryTarget = null, currentEditor = null, sourceEditor = assignedEditor;
    let clickGeneration = 0;
    let ownsInputBinding = false;
    const isInput = receiver.matches?.("input, textarea, select");
    const setEditor = async (nextTarget, nextSourceEditor, {
        render = true, forceInit = false, initializeInput = false
    } = {}) => {
        target = nextTarget;
        sourceEditor = nextSourceEditor;
        const nextEditor = editorProjection(receiver, sourceEditor);
        const changed = currentEditor !== nextEditor;
        if ((changed || forceInit) && ownsInputBinding)
            currentEditor?.uninit?.(receiver);
        if (changed || forceInit) ownsInputBinding = false;
        currentEditor = nextEditor;
        receiver.editor = nextEditor;

        if (!nextEditor) return;
        if (receiver.hasAttribute?.("editor-attributes") || receiver.hasAttribute?.("editor-nodes")) {
            if (typeof receiver.renderValue !== "function")
                throw new TypeError("Editor attribute and node projections require renderValue().");
            if (render) await receiver.renderValue(nextEditor);
        } else if (isInput && (changed || forceInit) && typeof nextEditor.init === "function" &&
            ((receiver.getAttribute?.("editor-attribute")?.trim() ||
                receiver.getAttribute?.("editor-property")?.trim())
                ? nextEditor.kind === "attribute"
                : initializeInput && !receiver.hasAttribute?.("editor-attribute") &&
                    !receiver.hasAttribute?.("editor-property"))) {
            await nextEditor.init({ input: receiver, context, target });
            ownsInputBinding = true;
        }
    };
    let generation = 0;
    const resolve = async () => {
        const currentGeneration = ++generation;
        const nextTarget = query ? await findTarget(context, query)
            : (sourceEditor?.kind === "attribute" ? sourceEditor.parentNode?.liveNode
                : sourceEditor?.liveNode) || sourceEditor?.element || null;
        if (currentGeneration !== generation || controller.signal.aborted) return;
        if (query) queryTarget = nextTarget;
        const nextSourceEditor = query ? nextTarget?.editor || null : sourceEditor;
        await setEditor(nextTarget, nextSourceEditor);
    };
    const refreshProjection = async () => {
        if (controller.signal.aborted) return;
        if (!target) return resolve();
        await setEditor(target, query ? target.editor || sourceEditor : sourceEditor, { forceInit: true });
    };
    const holdClearedAttributeProjection = () => query && currentEditor?.kind === "attribute" &&
        !receiver.getAttribute?.("editor-attribute")?.trim();
    const binding = {
        receiver,
        query,
        get sourceEditor() { return sourceEditor; },
        get target() { return target; },
        get queryTarget() { return queryTarget; },
        get value() { return currentEditor; },
        refresh: resolve,
        refreshProjection,
        disconnect({ preserveEditor = false } = {}) {
            controller.abort();
            clickGeneration++;
            if (ownsInputBinding) currentEditor?.uninit?.(receiver);
            if (!preserveEditor && receiver.editor === currentEditor) receiver.editor = null;
            if (queryBindings.get(receiver) === binding) queryBindings.delete(receiver);
        }
    };
    queryBindings.set(receiver, binding);
    const document = context?.nodeType === 9 ? context
        : context?.ownerDocument || context?.document || receiver.ownerDocument;
    let clickHost = null;
    const attachHostClick = () => {
        if (!queryTarget || receiver.hasAttribute?.("editor-nodes") ||
            !isEditorHost(queryTarget) || clickHost === queryTarget) return;
        clickHost = queryTarget;
        queryTarget.addEventListener("click", onHostClick, { signal: controller.signal });
    };
    const onHostClick = event => {
        const selected = clickedEditorSource(receiver, event);
        if (!selected) return;
        const currentGeneration = ++clickGeneration;
        const previousEditor = currentEditor;
        Promise.resolve().then(() => typeof previousEditor?.uninit === "function"
            ? previousEditor.uninit(receiver) : undefined).then(() => {
            if (currentGeneration !== clickGeneration || controller.signal.aborted) return;
            ownsInputBinding = false;
            return setEditor(selected.target, selected.editor, {
                forceInit: true,
                initializeInput: true
            });
        }).catch(error => {
            const EventConstructor = receiver.ownerDocument?.defaultView?.CustomEvent || globalThis.CustomEvent;
            if (EventConstructor) receiver.dispatchEvent(new EventConstructor("editor-error", {
                bubbles: true, detail: { error }
            }));
        });
    };
    const onEditorReady = event => {
        if (query && (!queryTarget || !currentEditor)) {
            resolve().then(attachHostClick).catch(error => reportQueryObserverError(receiver, error));
            return;
        }
        if (!queryTarget || (event.target !== queryTarget && !queryTarget.contains?.(event.target))) return;
        attachHostClick();
        if (holdClearedAttributeProjection()) return;
        setEditor(target, target?.editor || sourceEditor).catch(error => {
            const EventConstructor = receiver.ownerDocument?.defaultView?.CustomEvent || globalThis.CustomEvent;
            if (EventConstructor) receiver.dispatchEvent(new EventConstructor("editor-error", {
                bubbles: true, detail: { error }
            }));
        });
    };
    const onDetailsChange = event => {
        if (!target || (event.target !== queryTarget && event.target !== target &&
            !queryTarget?.contains?.(event.target) && !event.target?.contains?.(target))) return;
        if (holdClearedAttributeProjection()) return;
        setEditor(target, query ? target?.editor || null : sourceEditor).catch(error => {
            const EventConstructor = receiver.ownerDocument?.defaultView?.CustomEvent || globalThis.CustomEvent;
            if (EventConstructor) receiver.dispatchEvent(new EventConstructor("editor-error", {
                bubbles: true, detail: { error }
            }));
        });
    };
    document?.addEventListener?.("editor-ready", onEditorReady, { signal: controller.signal });
    document?.addEventListener?.("editor-details-change", onDetailsChange, { signal: controller.signal });
    await resolve();
    attachHostClick();

    return binding;
}

export function uninitEditorQuery(receiver) {
    const binding = queryBindings.get(receiver);
    if (!binding) return false;
    binding.disconnect();
    return true;
}

export function refreshEditorQuery(receiver) {
    const binding = queryBindings.get(receiver);
    if (binding) return binding.refreshProjection();
    if (receiver?.hasAttribute?.("editor-query")) return initEditorQuery(receiver);
    return Promise.resolve(false);
}

export function uninitEditorInput(input) {
    const binding = bindings.get(input);
    if (!binding) return false;
    binding.disconnect();
    return true;
}

function reportQueryObserverError(element, error) {
    const EventConstructor = element.ownerDocument?.defaultView?.CustomEvent || globalThis.CustomEvent;
    if (EventConstructor) element.dispatchEvent(new EventConstructor("editor-error", {
        bubbles: true, detail: { error }
    }));
}

function initializeObservedProjection(element, context = element.ownerDocument) {
    if (queryBindings.has(element)) return Promise.resolve(queryBindings.get(element));
    const query = element.getAttribute("editor-query");
    const attribute = element.getAttribute("editor-attribute");
    const property = element.getAttribute("editor-property");
    const hasQuery = Boolean(query?.trim());
    const hasDirectAttribute = Boolean(attribute?.trim()) ||
        (element.editor?.kind === "attribute" && Boolean(property?.trim()));
    if (!hasQuery && !(element.editor && hasDirectAttribute)) return;
    return initEditorQuery(element, {
        context,
        query: hasQuery ? query : ""
    }).catch(error => reportQueryObserverError(element, error));
}

/** Initialize the controls already present when this module is loaded. */
export function init(root = globalThis.document) {
    if (!root?.querySelectorAll) return Promise.resolve([]);
    const elements = [...root.querySelectorAll(projectionSelector)];
    if (root.matches?.(projectionSelector)) elements.unshift(root);
    return Promise.all(elements.map(element => initializeObservedProjection(element, root)));
}

function reinitializeObservedQuery(mutation) {
    const element = mutation.target;
    const query = element.getAttribute("editor-query");
    if (!query?.trim()) return;
    initEditorQuery(element, {
        context: element.ownerDocument,
        query
    }).catch(error => reportQueryObserverError(element, error));
}

function refreshObservedProjection(mutation) {
    const element = mutation.target;
    if (!element.getAttribute("editor-query")?.trim()) return;
    if (mutation.attributeName === "editor-attribute" &&
        !element.getAttribute("editor-attribute")?.trim()) return;
    if (mutation.attributeName === "editor-property" &&
        (!element.getAttribute("editor-property")?.trim() ||
            element.getAttribute("editor-attribute")?.trim().toLowerCase() !== "style")) return;
    refreshEditorQuery(element).catch(error => reportQueryObserverError(element, error));
}

function uninitializeRemovedElement(mutation) {
    if (mutation.move) return;
    const element = mutation.target;
    uninitEditorQuery(element);
    uninitEditorInput(element);
}

observer.init([
    {
        name: "CoCreateEditorProjectionAddedNodes",
        types: ["addedNodes"],
        selector: projectionSelector,
        callback: mutation => initializeObservedProjection(mutation.target)
    },
    {
        name: "CoCreateEditorBindingsRemovedNodes",
        types: ["removedNodes"],
        selector: "input, textarea, select, [editor-query], [editor-attribute], [editor-property], [editor-type]",
        callback: mutation => uninitializeRemovedElement(mutation)
    },
    {
        name: "CoCreateEditorQueryChanged",
        types: ["attributes"],
        attributeFilter: ["editor-query"],
        selector: "[editor-query]",
        callback: mutation => reinitializeObservedQuery(mutation)
    },
    {
        name: "CoCreateEditorAttributeChanged",
        types: ["attributes"],
        attributeFilter: ["editor-attribute"],
        selector: "[editor-query][editor-attribute]",
        callback: mutation => refreshObservedProjection(mutation)
    },
    {
        name: "CoCreateEditorPropertyChanged",
        types: ["attributes"],
        attributeFilter: ["editor-property"],
        selector: "[editor-query][editor-property]",
        callback: mutation => refreshObservedProjection(mutation)
    },
    {
        name: "CoCreateEditorAttributesProjectionChanged",
        types: ["attributes"],
        attributeFilter: ["editor-attributes"],
        selector: "[editor-query][editor-attributes]",
        callback: mutation => refreshObservedProjection(mutation)
    },
    {
        name: "CoCreateEditorAttributesProjectionRemoved",
        types: ["attributes"],
        attributeFilter: ["editor-attributes"],
        selector: "[editor-query]:not([editor-attributes])",
        callback: mutation => refreshObservedProjection(mutation)
    },
    {
        name: "CoCreateEditorNodesProjectionChanged",
        types: ["attributes"],
        attributeFilter: ["editor-nodes"],
        selector: "[editor-query][editor-nodes]",
        callback: mutation => reinitializeObservedQuery(mutation)
    },
    {
        name: "CoCreateEditorNodesProjectionRemoved",
        types: ["attributes"],
        attributeFilter: ["editor-nodes"],
        selector: "[editor-query]:not([editor-nodes])",
        callback: mutation => reinitializeObservedQuery(mutation)
    }
]);

init();

export default initEditorInput;
