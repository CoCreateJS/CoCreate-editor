import { getEditorDetailsForNode } from "./createEditorDetails.js";
import { textChange } from "../../textChange.js";

const states = new WeakMap();
const sourceOf = details => details.map(detail => detail.value).join("");
const fingerprint = selection => [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset];
const matches = (a, b) => a?.every((value, index) => value === b[index]);

function sourceOffset(detail, offset) {
    let difference = 0;
    for (const entity of detail.renderEntities || []) {
        if (offset < entity.renderStart) break;
        if (offset < entity.renderEnd) return entity.start;
        difference += entity.end - entity.start - (entity.renderEnd - entity.renderStart);
    }
    return offset + difference;
}

function renderedOffset(detail, offset) {
    let difference = 0;
    for (const entity of detail.renderEntities || []) {
        if (offset < entity.start) break;
        if (offset < entity.end) return offset === entity.start ? entity.renderStart : entity.renderEnd;
        difference += entity.end - entity.start - (entity.renderEnd - entity.renderStart);
    }
    return offset - difference;
}

export function bindDOMSource(element, details) {
    const state = states.get(element) || {};
    state.details = details;
    const Observer = element.ownerDocument?.defaultView?.MutationObserver;
    if (!state.observer && Observer) {
        state.mutations = [];
        state.observer = new Observer(records => { for (const record of records) state.mutations.push(record); });
        state.observer.observe(element, { childList: true, characterData: true, subtree: true });
    }
    state.observer?.takeRecords();
    if (state.mutations) state.mutations.length = 0;
    states.set(element, state);
}

export function releaseDOMSource(element) {
    states.get(element)?.observer?.disconnect();
    states.delete(element);
}

function localText(detail) {
    const raw = detail.value, before = detail.renderValue ?? raw;
    const after = detail.liveDOM?.nodeType === 3 ? detail.liveDOM.data : before;
    const oldOffset = offset => sourceOffset(detail, offset);
    if (before === after) return { value: raw, offset: oldOffset };
    const change = textChange(before, after);
    const start = oldOffset(change.start), end = oldOffset(change.start + change.length);
    return { value: raw.slice(0, start) + change.value + raw.slice(end), offset(position) {
        if (position <= change.start) return oldOffset(position);
        if (position < change.start + change.value.length) return start + position - change.start;
        return oldOffset(position - change.value.length + change.length) + change.value.length - (end - start);
    } };
}

function remember(element, source) {
    const state = states.get(element), selection = element.ownerDocument?.getSelection();
    if (state && selection?.rangeCount) state.selection = { points: fingerprint(selection), source };
}

export function clearDOMSelection(element) {
    const state = states.get(element);
    if (state) state.selection = null;
}

/** Read source characters, preserving tag syntax and character references. */
export function getDOMSource(element, event, selection) {
    const state = states.get(element);
    if (!state) return element.innerHTML || "";
    const before = sourceOf(state.details);
    if (event?.target && event.target !== element) return before;
    let value;
    const type = event?.inputType || "";
    if (selection) {
        if (["insertParagraph", "insertLineBreak"].includes(type)) value = "\n";
        else if (type.startsWith("insert")) value = event.data ?? event.dataTransfer?.getData("text/plain");
        else if (type.startsWith("delete") && selection.end > selection.start) value = "";
    }
    if (typeof value === "string") {
        const caret = selection.start + value.length;
        remember(element, { start: caret, end: caret, anchor: caret, head: caret });
        // Native input can create a Text node that has no detail yet (e.g. an empty editor).
        const native = element.ownerDocument.getSelection();
        state.nativeNodes = [];
        state.nativeText = new Set();
        const mutations = [...(state.mutations || []), ...(state.observer?.takeRecords() || [])];
        if (state.mutations) state.mutations.length = 0;
        for (const record of mutations) {
            if (record.type === "characterData") {
                const detail = getEditorDetailsForNode(record.target);
                if (detail?.kind === "text" && !detail.sourceOnly) state.nativeText.add(detail);
            }
            for (const node of record.addedNodes || [])
                if (!getEditorDetailsForNode(node) && element.contains(node) && !state.nativeNodes.includes(node)) state.nativeNodes.push(node);
        }
        for (let node of [native?.anchorNode, native?.focusNode]) {
            let extra = null;
            while (node && node !== element && !getEditorDetailsForNode(node)) { extra = node; node = node.parentNode; }
            if (extra && element.contains(extra) && !state.nativeNodes.includes(extra)) state.nativeNodes.push(extra);
        }
        return before.slice(0, selection.start) + value + before.slice(selection.end);
    }
    // Some replacement/autocorrect input events omit `data`. Recover the
    // inserted source from browser-created nodes before falling back to the
    // previously bound Text-node references, which may now be detached.
    if (selection && type.startsWith("insert")) {
        const mutations = [...(state.mutations || []), ...(state.observer?.takeRecords() || [])];
        if (state.mutations) state.mutations.length = 0;
        const added = [];
        for (const record of mutations) {
            if (record.type !== "childList") continue;
            for (const node of record.addedNodes)
                if (element.contains(node) && !added.includes(node)) added.push(node);
        }
        const roots = added.filter(node => !added.some(other => other !== node && other.contains(node)))
            .sort((a, b) => a.compareDocumentPosition(b) & 4 ? -1 : 1);
        if (roots.length) {
            const inserted = roots.map(node => node.nodeType === 3 ? node.data
                : node.nodeType === 1 ? node.outerHTML : "").join("");
            if (inserted) {
                state.nativeNodes = roots;
                state.nativeText = new Set();
                const native = element.ownerDocument.getSelection();
                let insertedOffset = 0, foundCaret = false;
                for (const node of roots) {
                    if (node === native?.anchorNode) {
                        const range = element.ownerDocument.createRange();
                        range.selectNodeContents(node);
                        range.setEnd(native.anchorNode, native.anchorOffset);
                        insertedOffset += range.toString().length;
                        foundCaret = true;
                        break;
                    }
                    if (node.contains?.(native?.anchorNode)) {
                        const range = element.ownerDocument.createRange();
                        range.selectNodeContents(node);
                        range.setEnd(native.anchorNode, native.anchorOffset);
                        insertedOffset += range.toString().length;
                        foundCaret = true;
                        break;
                    }
                    insertedOffset += node.nodeType === 3 ? node.data.length
                        : node.nodeType === 1 ? node.outerHTML.length : 0;
                }
                const caret = selection.start + (foundCaret ? insertedOffset : inserted.length);
                remember(element, { start: caret, end: caret, anchor: caret, head: caret });
                return before.slice(0, selection.start) + inserted + before.slice(selection.end);
            }
        }
    }
    return state.details.map(detail => detail.kind === "text" && !detail.sourceOnly
        ? localText(detail).value : detail.value).join("");
}

export function prepareDOMRender(element, plan) {
    const state = states.get(element);
    for (const node of state?.nativeNodes || []) node.remove();
    const changed = new Set([...plan.edited.map(item => item.detail), ...plan.removed.map(item => item.detail || item)]);
    for (const detail of state?.nativeText || []) {
        if (!changed.has(detail) && detail.liveDOM?.nodeType === 3 && typeof detail.renderValue === "string")
            detail.liveDOM.data = detail.renderValue;
    }
    if (state) { state.nativeNodes = []; state.nativeText = null; }
}

function endOf(detail, details) {
    let position = 0, end = 0;
    for (const item of details) {
        for (let owner = item; owner; owner = owner.parentDetails) {
            if (owner === detail) { end = position + item.length; break; }
        }
        position += item.length;
    }
    return end;
}

export function getDOMSelection(element, range) {
    const state = states.get(element), native = element.ownerDocument?.getSelection();
    if (!state || !native) return null;
    if (!native.rangeCount) return element.ownerDocument.activeElement === element ? state.selection?.source || null : null;
    if (!element.contains(native.anchorNode) || !element.contains(native.focusNode)) return null;
    const collapsed = !range || (range.startContainer === range.endContainer && range.startOffset === range.endOffset);
    if (collapsed && state.selection && matches(state.selection.points, fingerprint(native))) return state.selection.source;
    const point = (node, offset) => {
        const detail = getEditorDetailsForNode(node);
        if (node.nodeType === 3 && state.details.includes(detail)) return detail.getStart() + localText(detail).offset(offset);
        const next = node.childNodes[offset], previous = node.childNodes[offset - 1];
        const nextDetail = getEditorDetailsForNode(next), previousDetail = getEditorDetailsForNode(previous);
        if (state.details.includes(nextDetail)) return nextDetail.getStart();
        if (state.details.includes(previousDetail)) return endOf(previousDetail, state.details);
        if (state.details.includes(detail)) {
            const ending = state.details.find(item => item.parentDetails === detail && item.kind === "markup");
            return ending ? ending.getStart() + ending.length : detail.getStart() + detail.length;
        }
        return offset ? sourceOf(state.details).length : 0;
    };
    const anchor = range ? point(range.startContainer, range.startOffset) : point(native.anchorNode, native.anchorOffset);
    const head = range ? point(range.endContainer, range.endOffset) : point(native.focusNode, native.focusOffset);
    return { start: Math.min(anchor, head), end: Math.max(anchor, head), anchor, head };
}

export function setDOMSelection(element, source) {
    const state = states.get(element), native = element.ownerDocument?.getSelection();
    if (!state || !native) return false;
    const point = offset => {
        let position = 0, previous = null, empty = null;
        for (const detail of state.details) {
            const node = detail.liveDOM;
            if (detail.kind === "element" && position <= offset && node?.isContentEditable && !node.childNodes.length)
                empty = node;
            if (!detail.sourceOnly && node?.nodeType === 3 && element.contains(node)) {
                if (offset <= position + detail.length) {
                    const local = Math.max(0, offset - position);
                    return [node, Math.min(node.length, renderedOffset(detail, local))];
                }
                previous = [node, node.length];
            }
            position += detail.length;
        }
        return empty ? [empty, 0] : previous || [element, 0];
    };
    const [anchor, anchorOffset] = point(source.anchor ?? source.start);
    const [focus, focusOffset] = point(source.head ?? source.end);
    native.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
    remember(element, source);
    return true;
}
