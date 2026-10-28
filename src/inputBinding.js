import { bindEditorInput } from "./events.js";
import { getSelection, setSelection } from "./selection.js";

const bindings = new WeakMap();
const attributeRenderBindings = new WeakMap();
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
    return ["checkbox", "radio", "date", "datetime-local", "month", "time", "week"]
        .includes(input.type?.toLowerCase());
}

function setControlValue(input, value) {
    if (typeof input.setValue === "function") input.setValue(value);
    else if (input.type === "radio") input.checked = String(input.value) === String(value ?? "");
    else if (input.type === "checkbox") input.checked = value === true || value === input.value ||
        (Array.isArray(value) && value.includes(input.value));
    else input.value = value ?? "";
}

function readControlValue(input) {
    if (typeof input.getValue === "function") return input.getValue();
    if (input.type === "radio") return input.checked ? input.value : "";
    return input.checked;
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
    input.editor ||= {};
    input.editor.element = input;
    if (typeof input.editor.init !== "function") input.editor.init = options => initEditorInput(input, options);
    if (typeof input.editor.uninit !== "function") input.editor.uninit = () => uninitEditorInput(input);
    const descriptor = typeof attribute === "string" ? { name: attribute } : attribute;
    const name = descriptor?.name || input.getAttribute("editor-attribute") || editorAttribute(input);
    const editorType = input.getAttribute("editor-type") || (name ? "attribute" : "text");
    const control = isStateControl(input);
    const fileInput = input.type?.toLowerCase() === "file";
    const mode = editorType === "attribute" || (name && editorType !== "element") ? "attribute"
        : editorType === "element" ? "element" : "text";
    part = descriptor?.part || input.getAttribute("editor-attribute-part") || part;
    const property = input.getAttribute("editor-property") || descriptor?.property || null;
    query ||= input.getAttribute("editor-query");
    if (fileInput) {
        bindings.get(input)?.disconnect();
        return null;
    }
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
        try {
            if (["date", "datetime-local", "month", "time", "week"].includes(input.type)) {
                setControlValue(input, value);
                return;
            }
            if (input.type === "radio") setControlValue(input, value);
            else if (mode === "attribute" && name.toLowerCase() === "class")
                setControlValue(input, String(value || "").split(/[\t\n\f\r ]+/).includes(input.value));
            else if (mode === "attribute") setControlValue(input, target?.hasAttribute?.(name) || false);
            else setControlValue(input, value !== null && value !== undefined && value !== "" && value !== false);
        } finally { syncingControl = false; }
    };

    const writeControl = () => {
        if (syncingControl || !target || !control) return;
        const editor = target.editor;
        if (!editor) return;
        if (["date", "datetime-local", "month", "time", "week"].includes(input.type)) {
            const value = readControlValue(input);
            if (mode === "attribute") return reportControlUpdate(input, () => editor.setAttribute?.(name, value));
            if (mode === "text") return reportControlUpdate(input,
                () => getTextEditor(target)?.setValue(String(value ?? "")));
            return;
        }
        if (mode === "element") {
            if (input.type === "radio" && input.checked && typeof editor.setTagName === "function")
                return reportControlUpdate(input, () => editor.setTagName(input.value));
            return;
        }
        if (mode === "text")
            return reportControlUpdate(input, () => getTextEditor(target)?.setValue(String(readControlValue(input) ?? "")));
        if (mode !== "attribute") return;
        const current = target.getAttribute(name);
        if (input.type === "radio") {
            if (input.checked) return reportControlUpdate(input,
                () => editor.setAttribute?.(name, readControlValue(input)));
            return;
        }
        if (name.toLowerCase() === "class") {
            const tokens = new Set(String(current || "").split(/[\t\n\f\r ]+/).filter(Boolean));
            if (input.checked) tokens.add(input.value);
            else tokens.delete(input.value);
            return reportControlUpdate(input, () => tokens.size
                ? editor.setAttribute?.(name, [...tokens].join(" "))
                : editor.removeAttribute?.(name));
        }
        return reportControlUpdate(input, () => input.checked
            ? editor.setAttribute?.(name, "") : editor.removeAttribute?.(name));
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
    const document = context?.nodeType === 9 ? context
        : context?.tagName === "IFRAME" ? context.contentDocument
            : context?.ownerDocument || context?.document;
    const refresh = event => {
        const clicked = event?.target;
        const control = clicked?.matches?.("input[editor-query], textarea[editor-query]")
            ? clicked : clicked?.closest?.("label")?.querySelector?.("input[editor-query], textarea[editor-query]");
        if (control) return;
        queueMicrotask(() => resolve().catch(() => {}));
    };
    document?.addEventListener?.("click", refresh, { signal: controller.signal });
    const frameDocuments = new WeakSet();
    const watchFrame = frame => {
        try {
            const frameDocument = frame.contentDocument;
            if (!frameDocument || frameDocuments.has(frameDocument)) return;
            frameDocuments.add(frameDocument);
            frameDocument.addEventListener("click", refresh, { signal: controller.signal });
        } catch { /* Cross-origin frames cannot expose click state to this editor. */ }
    };
    if (document?.querySelectorAll) {
        document.querySelectorAll("iframe").forEach(watchFrame);
        const MutationObserver = document.defaultView?.MutationObserver;
        if (MutationObserver && document.documentElement) {
            const observer = new MutationObserver(records => {
                for (const record of records) for (const node of record.addedNodes) {
                    if (node.tagName === "IFRAME") watchFrame(node);
                    node.querySelectorAll?.("iframe").forEach(watchFrame);
                }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
            controller.signal.addEventListener("abort", () => observer.disconnect(), { once: true });
        }
    }
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
    if (document && targetDocument !== document)
        document.addEventListener?.("editor-details-change", onDetailsChange, { signal: controller.signal });
    return binding;
}

/** Bind an attribute renderer to the clicked element's source-backed attributes. */
export async function initEditorAttributes(element, { context = element?.ownerDocument, query } = {}) {
    if (!element?.addEventListener) throw new TypeError("An attribute renderer element is required.");
    if (typeof element.renderValue !== "function")
        throw new TypeError("An attribute renderer must expose renderValue().");
    query ||= element.getAttribute("editor-query");
    if (!query) throw new TypeError('Attribute renderers require "editor-query".');

    attributeRenderBindings.get(element)?.disconnect();
    const controller = new AbortController();
    let target = null, generation = 0;
    const reportError = error => {
        const EventConstructor = element.ownerDocument?.defaultView?.CustomEvent || CustomEvent;
        element.dispatchEvent(new EventConstructor("editor-error", { bubbles: true, detail: { error } }));
    };
    const render = async nextTarget => {
        if (typeof nextTarget?.editor?.getAttributes !== "function") return;
        target = nextTarget;
        try {
            // Pass the existing editor objects through unchanged.
            await element.renderValue(target.editor.getAttributes());
        } catch (error) { reportError(error); }
    };
    const resolve = async () => {
        const currentGeneration = ++generation;
        const nextTarget = await findTarget(context, query);
        if (currentGeneration !== generation) return;
        return render(nextTarget);
    };
    const document = context?.nodeType === 9 ? context
        : context?.tagName === "IFRAME" ? context.contentDocument
            : context?.ownerDocument || context?.document;
    const refresh = event => {
        const clicked = event?.target;
        if (element === clicked || element.contains?.(clicked)) return;
        if (clicked?.matches?.("input[editor-query], textarea[editor-query]")) return;
        queueMicrotask(() => resolve().catch(reportError));
    };
    document?.addEventListener?.("click", refresh, { signal: controller.signal });
    const onDetailsChange = event => {
        if (!target || (event.target !== target && !event.target?.contains?.(target))) return;
        render(target);
    };
    document?.addEventListener?.("editor-details-change", onDetailsChange, { signal: controller.signal });
    const binding = {
        element,
        get target() { return target; },
        refresh: resolve,
        disconnect() {
            controller.abort();
            if (attributeRenderBindings.get(element) === binding) attributeRenderBindings.delete(element);
        }
    };
    attributeRenderBindings.set(element, binding);
    await resolve();
    return binding;
}

export function uninitEditorAttributes(element) {
    const binding = attributeRenderBindings.get(element);
    if (!binding) return false;
    binding.disconnect();
    return true;
}

export function uninitEditorInput(input) {
    const binding = bindings.get(input);
    if (!binding) return false;
    binding.disconnect();
    return true;
}

export default initEditorInput;
