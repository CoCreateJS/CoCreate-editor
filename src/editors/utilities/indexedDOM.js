import { attachEditorDetails, getEditorDetails, setEditorDetails, copyEditorDetails,
    findEditorDetailsByStart, findEditorDetailsContaining, findEditorDetailsIndex, editorDetailsSubtree } from "./details.js";
import { reconcileDoctype } from "./mirror.js";
import { getSourceMap, setSourceMap, setLiveNode, isPlaceholder,
    markPlaceholder, unmarkPlaceholder } from "./nodeData.js";

const parsedDetails = new WeakMap();
const updateRegions = new WeakMap();
const observations = new WeakMap();
const rootOwnedAttributes = new Set(["contenteditable", "role", "aria-multiline",
    "aria-readonly", "aria-required", "aria-invalid", "data-empty", "data-placeholder"]);

// Native input and IME can add nodes before a source operation arrives. Keep
// those references from mutation records, rather than searching for stray nodes.
export function observeIndexedDOM(detached, element, liveRoot) {
    if (observations.has(detached)) return;
    const pending = [];
    const Observer = liveRoot.ownerDocument.defaultView.MutationObserver;
    const observer = new Observer(records => {
        if (element.editor?.dom !== detached) { observer.disconnect(); return; }
        for (const record of records) pending.push(record);
    });
    observer.observe(liveRoot, { childList: true, subtree: true });
    observations.set(detached, { observer, pending });
}

export function hasIndexedMutations(detached) {
    const observation = observations.get(detached);
    if (!observation) return false;
    for (const record of observation.observer.takeRecords()) observation.pending.push(record);
    return observation.pending.length > 0;
}

export const setUpdateRegion = (staging, details) => updateRegions.set(staging, details);

export const getParsedDetails = root => parsedDetails.get(root) || [];

function depth(item) {
    let value = 0;
    for (; item; item = item.parentDetails) value++;
    return value;
}
export function setParsedDetails(root, records) {
    records.sort((a, b) => a.start - b.start || b.end - a.end || depth(a) - depth(b));
    parsedDetails.set(root, records);
}

function identity(item, start = item.start) {
    return `${start}:${item.detachDOM.nodeType}:${item.detachDOM.nodeName}`;
}

function syncAttributes(source, target, root = false) {
    const owned = root ? rootOwnedAttributes : null;
    for (const attribute of [...target.attributes])
        if (!owned?.has(attribute.name) && !source.hasAttribute(attribute.name))
            target.removeAttribute(attribute.name);
    for (const attribute of source.attributes)
        if (!owned?.has(attribute.name) && target.getAttribute(attribute.name) !== attribute.value)
            target.setAttribute(attribute.name, attribute.value);
}

// Shared by the parser's reuse lookup and the final planner. A fully replaced
// record cannot be reused just because the replacement has the same spelling.
export function mappedRecordStart(item, { start, length, value }) {
    const end = start + length;
    if (length && start <= item.start && item.end <= end) return null;
    return item.start >= end ? item.start + value.length - length
        : item.start <= start ? item.start : null;
}

// Plan entirely from records before mutating either tree. A record can only
// survive if its parent survives, so replacing a broken wrapper removes all of
// its descendants even if a descendant happens to match a new source position.
export function planIndexedDOM(detached, staging, element, change) {
    const region = updateRegions.get(staging);
    const documentTree = detached.nodeType === 9;
    const rootNode = documentTree ? element.tagName === "IFRAME" ? detached.documentElement : detached.body : detached;
    const stagedRoot = region ? getParsedDetails(staging).find(item => !item.parentDetails)?.detachDOM
        : documentTree ? element.tagName === "IFRAME" ? staging.documentElement : staging.body : staging;
    const oldRoot = region || getEditorDetails(rootNode), newRoot = getEditorDetails(stagedRoot);
    const previousRootEnd = oldRoot.end;
    const allPrevious = getParsedDetails(detached);
    const old = editorDetailsSubtree(allPrevious, oldRoot).filter(item => item.liveDOM);
    const next = editorDetailsSubtree(getParsedDetails(staging), newRoot);
    const nextSet = new Set(next);
    const end = change.start + change.length, delta = change.value.length - change.length;
    const observation = observations.get(detached);
    const nativeRemovals = new Set();
    if (observation) {
        for (const record of observation.observer.takeRecords()) observation.pending.push(record);
        const known = observation.pending.length ? new Set(allPrevious.map(item => item.liveDOM)) : null;
        for (const mutation of observation.pending) {
            if (getEditorDetails(mutation.target)?.editorElement !== element) continue;
            for (const node of mutation.addedNodes) if (!known.has(node)) nativeRemovals.add(node);
        }
    }
    const candidates = new Map();
    for (const item of old) {
        if (item === oldRoot) continue;
        const start = mappedRecordStart(item, change);
        if (start === null) continue;
        const key = identity(item, start);
        if (!candidates.has(key)) candidates.set(key, []);
        candidates.get(key).push(item);
    }
    const chosen = new Map(), retained = new Set(), updates = [], added = [];
    const children = new Map(), childOrder = new Map();
    const opaqueParsed = new Set(), opaqueDetails = new Set();
    for (const parsed of next) {
        if (opaqueParsed.has(parsed.parentDetails)) {
            opaqueParsed.add(parsed);
            continue;
        }
        const parent = parsed === newRoot && region ? oldRoot.parentDetails : chosen.get(parsed.parentDetails);
        const matches = candidates.get(identity(parsed));
        const previous = parsed === newRoot ? oldRoot : matches?.find(item =>
            !retained.has(item) && item.parentDetails === parent);
        const original = getEditorDetails(parsed.detachDOM);
        if (original !== parsed && original !== previous)
            throw new Error("A reused source record must retain its original details object.");
        const details = previous || parsed;
        chosen.set(parsed, details);
        if (previous) retained.add(previous);
        if (previous && previous.liveDOM !== element &&
            (previous.liveDOM.__cocreateEditor || previous.liveDOM.editor?.init || previous.liveDOM.editor?.loading)) {
            opaqueParsed.add(parsed);
            opaqueDetails.add(previous);
        }
        const { editorElement, liveDOM, detachDOM, parentDetails, ...values } = parsed;
        const map = getSourceMap(parsed.detachDOM);
        const shift = previous?.detachDOM === parsed.detachDOM ? parsed.start - previous.start : 0;
        updates.push({ details, parent, previous, values,
            node: parsed.detachDOM, sourceMap: map && shift
                ? map.map(([start, end]) => [start + shift, end + shift]) : map });
        if (!previous) added.push(details);
        if (parent && !(region && parsed === newRoot)) {
            if (!children.has(parent)) children.set(parent, []);
            children.get(parent).push(details);
            if (Number.isInteger(parsed.childIndex)) childOrder.set(details, parsed.childIndex);
        }
    }
    for (const items of children.values())
        if (items.some(item => childOrder.has(item)))
            items.sort((a, b) => childOrder.get(a) - childOrder.get(b));

    const discarded = old.filter(item => !retained.has(item));
    const protectedRecords = new Set(opaqueDetails), removed = [];
    for (const item of discarded) {
        if (protectedRecords.has(item.parentDetails)) protectedRecords.add(item);
        else removed.push(item);
    }
    const removedSet = new Set(removed);
    const removeRoots = removed.filter(item => !removedSet.has(item.parentDetails));
    return {
        detached, staging, element, region, documentTree, oldRoot, newRoot, previousRootEnd,
        allPrevious, old, nextSet, end, delta, observation,
        mutationCount: observation?.pending.length || 0,
        added, removed, retained: [...retained], removeRoots,
        nativeRemovals: [...nativeRemovals], updates, children
    };
}

// The complete lists and their references already exist here. Prepare shallow
// live nodes first, then commit removals, updates, and ordered insertions.
export function applyDOMUpdatePlan(plan) {
    const { detached, staging, element, region, documentTree, oldRoot, previousRootEnd,
        allPrevious, old, nextSet, end, delta, observation,
        updates, children, removeRoots, nativeRemovals } = plan;
    for (const entry of updates)
        entry.live = entry.previous ? entry.details.liveDOM : entry.node.cloneNode(false);
    for (const node of nativeRemovals) node.remove();
    for (const item of removeRoots) {
        item.liveDOM.remove();
        item.detachDOM.remove();
    }
    for (const entry of updates) {
        const { details, parent, previous, values, node, live, sourceMap } = entry;
        if (previous) setEditorDetails(details.detachDOM, values);
        else if (node.nodeType === 1) node.replaceChildren();
        details.parentDetails = parent || null;
        if (node.nodeType === 1) {
            if (previous && node !== details.detachDOM)
                syncAttributes(node, details.detachDOM, !region && details === oldRoot);
            if (region || details !== oldRoot || (documentTree && element.tagName === "IFRAME"))
                syncAttributes(node, live, !region && details === oldRoot);
            for (const target of [details.detachDOM, live])
                if (isPlaceholder(node)) markPlaceholder(target); else unmarkPlaceholder(target);
        } else {
            if (details.detachDOM.data !== node.data) details.detachDOM.data = node.data;
            if (live.data !== node.data) live.data = node.data;
            setSourceMap(details.detachDOM, sourceMap);
            setSourceMap(live, sourceMap);
        }
        setLiveNode(details.detachDOM, live);
        attachEditorDetails(details.detachDOM, live, element);
    }
    for (const [parent, items] of children) {
        let detachedAnchor = null, liveAnchor = null;
        for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i];
            if (item.detachDOM.parentNode !== parent.detachDOM || item.detachDOM.nextSibling !== detachedAnchor)
                parent.detachDOM.insertBefore(item.detachDOM, detachedAnchor);
            if (!parent.liveDOM.__cocreateEditor &&
                (item.liveDOM.parentNode !== parent.liveDOM || item.liveDOM.nextSibling !== liveAnchor))
                parent.liveDOM.insertBefore(item.liveDOM, liveAnchor);
            detachedAnchor = item.detachDOM;
            liveAnchor = item.liveDOM;
        }
    }
    let records = updates.map(entry => entry.details);
    if (region) {
        const replaced = new Set(old);
        const ancestors = new Set();
        for (let parent = region.parentDetails; parent; parent = parent.parentDetails) ancestors.add(parent);
        const remaining = allPrevious.filter(item => !replaced.has(item));
        for (const item of remaining) {
            if (ancestors.has(item) || (!item.liveDOM && item.tag === "html" &&
                item.start <= region.start && previousRootEnd <= item.contentEnd)) {
                item.contentEnd += delta;
                item.end += delta;
            } else if (item.start >= end) {
                for (const name of ["start", "contentStart", "contentEnd", "end"]) item[name] += delta;
                const map = getSourceMap(item.detachDOM);
                if (map && delta) {
                    const shifted = map.map(([start, end]) => [start + delta, end + delta]);
                    setSourceMap(item.detachDOM, shifted);
                    if (item.liveDOM) setSourceMap(item.liveDOM, shifted);
                }
            }
        }
        records = remaining.concat(records);
    }
    if (!region && documentTree && element.tagName !== "IFRAME") {
        // A div projects the body only. Keep the unmirrored document/head
        // records current too, without walking either document.
        const sourceHTML = getEditorDetails(staging.documentElement);
        copyEditorDetails(staging.documentElement, detached.documentElement);
        syncAttributes(staging.documentElement, detached.documentElement);
        detached.head.replaceWith(staging.head);
        const html = getEditorDetails(detached.documentElement);
        const unmirrored = getParsedDetails(staging).filter(item => item !== sourceHTML && !nextSet.has(item));
        for (const item of unmirrored)
            if (item.parentDetails === sourceHTML) item.parentDetails = html;
        oldRoot.parentDetails = html;
        records = records.concat(html, unmirrored);
    }
    setParsedDetails(detached, records);
    const index = element.editor.editorDetails;
    index.length = 0;
    for (const item of records) if (item.liveDOM?.editorDetails === item && item.editorElement === element) index.push(item);
    element.editor.findDetailsByStart ||= start => findEditorDetailsByStart(element, start);
    element.editor.findDetailsIndex ||= (start, end = start) => findEditorDetailsIndex(element, start, end);
    element.editor.findDetailsContaining ||= (start, end = start) =>
        findEditorDetailsContaining(element, start, end);
    // Keep the retained document and records as the next update's input.
    if (!region && documentTree) reconcileDoctype(staging, detached);
    if (observation) {
        observation.pending.splice(0, plan.mutationCount);
        observation.observer.takeRecords();
    }
    return plan;
}

export function applyIndexedDOM(detached, staging, element, change) {
    return applyDOMUpdatePlan(planIndexedDOM(detached, staging, element, change));
}

// Incoming source updates can capture the caret from node records directly;
// there is no need to project the live DOM to discover its source position.
export function indexedSelection(element) {
    if (!getParsedDetails(element.editor?.dom).length) return;
    const root = element.tagName === "IFRAME" ? element.contentDocument.documentElement : element;
    const selection = root.ownerDocument.getSelection();
    if (!selection?.rangeCount) return;
    const point = (node, offset, end) => {
        const details = getEditorDetails(node);
        if (!details || details.editorElement !== element) return;
        if (node.nodeType === 3) {
            const map = getSourceMap(node);
            if (!map?.length) return details.start;
            if (offset >= map.length || (end && offset > 0)) return map[Math.min(offset, map.length) - 1][1];
            return map[offset][0];
        }
        if (!offset) return details.contentStart;
        const children = element.editor.editorDetails.filter(item => item.parentDetails === details);
        const previous = children.find((item, index) => (item.childIndex ?? index) === offset - 1);
        return previous?.end ?? details.contentEnd;
    };
    let anchor = point(selection.anchorNode, selection.anchorOffset, false);
    let head = point(selection.focusNode, selection.focusOffset, false);
    if (selection.anchorNode !== selection.focusNode || selection.anchorOffset !== selection.focusOffset) {
        if (anchor > head || (selection.anchorNode === selection.focusNode && selection.anchorOffset > selection.focusOffset))
            anchor = point(selection.anchorNode, selection.anchorOffset, true);
        else head = point(selection.focusNode, selection.focusOffset, true);
    }
    if (anchor !== undefined && head !== undefined) return { anchor, head };
}
