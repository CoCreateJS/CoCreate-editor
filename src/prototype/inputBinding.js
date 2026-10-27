import { bindEditorInput } from "./events.js";
import { getSelection, setSelection } from "./selection.js";

const bindings = new WeakMap();
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

function readPart(detail, part) {
    if (!detail) return "";
    const range = attributeRange(detail, part);
    return detail.value.slice(range.start, range.end);
}

async function findTarget(context, selector) {
    if (!selector) return null;
    queryElementsPromise ||= import("@cocreate/utils/browser").then(module => module.queryElements)
        .catch(error => { queryElementsPromise = undefined; throw error; });
    const queryElements = await queryElementsPromise;
    const special = selector.match(/(^|\s)(\$clickedElement|\$contentDocument|\$activeElement)(?=\s|$)/);
    if (special) {
        const tokenStart = special.index + special[1].length;
        const token = special[2];
        const prefix = selector.slice(0, tokenStart).trim();
        const suffix = selector.slice(tokenStart + token.length).trim();
        const base = prefix ? queryElements({ element: context, selector: prefix })?.[0] : context;
        if (!base) return null;
        const doc = base.nodeType === 9 ? base : base.contentDocument || base.ownerDocument || base.document;
        const result = token === "$contentDocument" ? base.contentDocument
            : token === "$activeElement" ? doc?.activeElement
                : base.tagName === "IFRAME"
                    ? base.clickedElement ?? base.contentDocument?.clickedElement
                    : doc?.clickedElement;
        return suffix ? findTarget(result, suffix) : result || null;
    }
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
    const name = descriptor?.name || input.getAttribute("editor-attribute");
    part = descriptor?.part || input.getAttribute("editor-attribute-part") || part;
    query ||= input.getAttribute("editor-query");
    if (!name) throw new TypeError("An attribute name is required.");
    if (part !== "name" && part !== "value") throw new TypeError('Attribute part must be "name" or "value".');

    bindings.get(input)?.disconnect();
    const controller = new AbortController();
    let target = null;
    let detail = null;
    let inputBinding = null;

    let generation = 0;
    const resolve = async () => {
        const currentGeneration = ++generation;
        const nextTarget = initialTarget || await findTarget(context, query);
        if (currentGeneration !== generation) return;
        target = nextTarget;
        detail = getAttributeEditor(target, name);
        const value = readPart(detail, part);
        if (typeof input.value === "string") input.value = value;
        inputBinding?.setValue(value);
    };

    const getCurrentDetail = () => target ? getAttributeEditor(target, name) : detail;
    const write = change => {
        const current = getCurrentDetail();
        if (!current) return;
        const range = attributeRange(current, part);
        return current.updateText({
            start: range.start + change.start,
            length: change.length,
            value: change.value
        });
    };

    inputBinding = bindEditorInput(input, {
        readValue: () => input.value,
        mapSelection: false,
        onUpdate: write
    });
    const document = context?.nodeType === 9 ? context
        : context?.tagName === "IFRAME" ? context.contentDocument
            : context?.ownerDocument || context?.document;
    const refresh = () => queueMicrotask(() => resolve().catch(() => {}));
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
        const current = getCurrentDetail();
        if (!current) {
            if (typeof input.value === "string") input.value = "";
            inputBinding?.setValue("");
            detail = null;
            return;
        }
        const update = event.detail?.update;
        const selection = getSelection(input);
        const oldRange = detail ? attributeRange(detail, part) : null;
        const oldStart = detail && oldRange ? detail.getStart() + oldRange.start : null;
        const value = readPart(current, part);
        const nextRange = attributeRange(current, part);
        const nextStart = current.getStart() + nextRange.start;
        if (typeof input.value === "string" && input.value !== value) input.value = value;
        inputBinding?.setValue(value);
        if (selection && update && Number.isInteger(oldStart)) {
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

export function uninitEditorInput(input) {
    const binding = bindings.get(input);
    if (!binding) return false;
    binding.disconnect();
    return true;
}

export default initEditorInput;
