export const editorDetailsPrototype = {};

const detailsByNode = new WeakMap();
const references = new Set(["editorElement", "liveDOM", "detachDOM", "parentDetails"]);

export function getEditorDetails(node) {
    return node?.editorDetails || detailsByNode.get(node);
}

export function setEditorDetails(node, details) {
    const { start, contentStart, contentEnd, end } = details;
    if (![start, contentStart, contentEnd, end].every(Number.isInteger) ||
        start < 0 || start > contentStart || contentStart > contentEnd || contentEnd > end)
        throw new RangeError("Invalid editor source boundaries.");

    const value = getEditorDetails(node) || Object.create(editorDetailsPrototype);
    const detachDOM = node.editorDetails === value ? value.detachDOM : node;
    for (const key of Object.keys(value))
        if (!references.has(key) && !Object.hasOwn(details, key)) delete value[key];
    Object.assign(value, details, { detachDOM });
    detailsByNode.set(node, value);
    return value;
}

export function copyEditorDetails(source, target) {
    const details = getEditorDetails(source);
    if (!details) return;
    const { editorElement, liveDOM, detachDOM, parentDetails, ...sourceDetails } = details;
    const value = setEditorDetails(target, sourceDetails);
    if (target.editorDetails) {
        Object.assign(target.editorDetails, value, {
            editorElement: target.editorDetails.editorElement || editorElement,
            liveDOM: target,
            detachDOM,
            parentDetails: target.editorDetails.parentDetails || parentDetails
        });
        detailsByNode.set(target, target.editorDetails);
    }
}

export function attachEditorDetails(detachDOM, liveDOM, editorElement) {
    const details = getEditorDetails(detachDOM);
    if (!details) return;
    const nestedEditor = liveDOM !== editorElement &&
        (liveDOM.editor?.init || liveDOM.editor?.loading);
    if (nestedEditor) {
        const index = editorElement?.editor?.editorDetails;
        if (index) {
            const position = index.indexOf(details);
            if (position >= 0) index.splice(position, 1);
        }
        details.detachDOM = detachDOM;
        details.liveDOM = liveDOM;
        details.editorElement = editorElement;
        return details;
    }
    const previous = liveDOM.editorDetails;
    if (previous && previous !== details && previous.editorElement !== editorElement) {
        const index = previous.editorElement?.editor?.editorDetails;
        if (index) {
            const position = index.indexOf(previous);
            if (position >= 0) index.splice(position, 1);
        }
    }
    details.detachDOM = detachDOM;
    details.liveDOM = liveDOM;
    details.editorElement = editorElement;
    liveDOM.editorDetails = details;
    detailsByNode.set(liveDOM, details);
    return details;
}

export function rebuildEditorDetails(editorElement, root) {
    if (!editorElement || !root) return [];
    editorElement.editor ||= {};
    const first = root.nodeType === 9 ? root.documentElement : root;
    const details = [];
    const visit = (node, parentDetails) => {
        let nextParent = parentDetails;
        const item = getEditorDetails(node);
        if (item && item.editorElement === editorElement && item.liveDOM?.editorDetails === item) {
            item.parentDetails = parentDetails;
            details.push(item);
            nextParent = item;
        }
        for (const child of node.childNodes || []) visit(child, nextParent);
    };
    if (first) visit(first, null);
    details.sort(compareDetails);
    editorElement.editor.editorDetails = details;
    editorElement.editor.findDetailsByStart ||= start =>
        findEditorDetailsByStart(editorElement, start);
    editorElement.editor.findDetailsIndex ||= (start, end = start) =>
        findEditorDetailsIndex(editorElement, start, end);
    editorElement.editor.findDetailsContaining ||= (start, end = start) =>
        findEditorDetailsContaining(editorElement, start, end);
    return details;
}

const compareDetails = (a, b) => a.start - b.start || b.end - a.end;

function lowerBound(details, start) {
    let low = 0, high = details.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (details[middle].start < start) low = middle + 1;
        else high = middle;
    }
    return low;
}

function upperBound(details, start) {
    let low = 0, high = details.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (details[middle].start <= start) low = middle + 1;
        else high = middle;
    }
    return low;
}

export function replaceEditorDetailsSubtree(editorElement, detachDOM, previousRange) {
    const index = editorElement?.editor?.editorDetails;
    const rootDetails = getEditorDetails(detachDOM);
    if (!index || !rootDetails || rootDetails.editorElement !== editorElement)
        return rebuildEditorDetails(editorElement, detachDOM);

    const start = Math.min(previousRange?.start ?? rootDetails.start, rootDetails.start);
    const end = Math.max(previousRange?.end ?? rootDetails.end, rootDetails.end);
    const from = lowerBound(index, start);
    const to = upperBound(index, end);
    const retained = index.slice(from, to).filter(item =>
        !(item.detachDOM === detachDOM || detachDOM.contains(item.detachDOM))
    );
    const first = detachDOM.nodeType === 9 ? detachDOM.documentElement : detachDOM;
    const replacement = [];
    const parentDetails = rootDetails.parentDetails;
    const visit = (node, parent) => {
        let nextParent = parent;
        const item = getEditorDetails(node);
        if (item && item.editorElement === editorElement && item.liveDOM?.editorDetails === item) {
            item.parentDetails = parent;
            replacement.push(item);
            nextParent = item;
        }
        for (const child of node.childNodes || []) visit(child, nextParent);
    };
    if (first) visit(first, parentDetails);

    const merged = [];
    let left = 0, right = 0;
    while (left < retained.length && right < replacement.length)
        merged.push(compareDetails(retained[left], replacement[right]) <= 0
            ? retained[left++] : replacement[right++]);
    merged.push(...retained.slice(left), ...replacement.slice(right));
    index.splice(from, to - from, ...merged);
    return index;
}

export function findEditorDetailsByStart(editorElement, start) {
    const details = editorElement?.editor?.editorDetails || [];
    let low = 0;
    let high = details.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (details[middle].start < start) low = middle + 1;
        else high = middle;
    }
    let found;
    for (let i = low; i < details.length && details[i].start === start; i++) {
        if (!found || details[i].end - details[i].start < found.end - found.start)
            found = details[i];
    }
    return found;
}

// Return an array index, then let callers scan records through their end
// boundary. Only the predecessor's equal-start group and parent links can
// contain the requested range; the rest of the array is never filtered.
export function findEditorDetailsIndex(editorElement, start, end = start) {
    if (end < start) return -1;
    const details = editorElement?.editor?.editorDetails || [];
    const to = upperBound(details, start);
    if (!to) return -1;
    const from = lowerBound(details, details[to - 1].start);
    let found, foundDepth = -1;
    const seen = new Set(), depths = new Map();
    const depthOf = item => {
        const path = [];
        let current = item;
        while (current && !depths.has(current)) { path.push(current); current = current.parentDetails; }
        let depth = current ? depths.get(current) : -1;
        for (let i = path.length - 1; i >= 0; i--) depths.set(path[i], ++depth);
        return depths.get(item);
    };
    for (let i = to - 1; i >= from; i--) {
        for (let item = details[i]; item && !seen.has(item); item = item.parentDetails) {
            seen.add(item);
            if (item.editorElement !== editorElement || item.liveDOM?.editorDetails !== item ||
                item.start > start || item.end < end) continue;
            const depth = depthOf(item);
            if (depth > foundDepth || (depth === foundDepth && found?.kind === "root" && item.kind !== "root")) {
                found = item;
                foundDepth = depth;
            }
            break;
        }
    }
    if (!found) return -1;
    for (let i = lowerBound(details, found.start); i < details.length && details[i].start === found.start; i++)
        if (details[i] === found) return i;
    return -1;
}

export function findEditorDetailsContaining(editorElement, start, end = start) {
    return editorElement?.editor?.editorDetails?.[findEditorDetailsIndex(editorElement, start, end)];
}

export function editorDetailsSubtree(details, root) {
    const from = lowerBound(details, root.start), to = upperBound(details, root.end);
    const selected = new Set(), items = [];
    for (let i = from; i < to; i++) {
        const item = details[i];
        if (item === root || selected.has(item.parentDetails)) {
            selected.add(item);
            items.push(item);
        }
    }
    return items;
}

// Include the predecessor's ancestors (ranges that start before the edit),
// then records starting inside the edit. Complete covered nodes need no tag
// recovery; touchesTag decides which partial intersections are damaged.
export function editorDetailsAtChange(details, start, end) {
    const from = upperBound(details, start), to = lowerBound(details, end);
    const first = from ? lowerBound(details, details[from - 1].start) : from;
    const candidates = new Set(details.slice(first, Math.max(from, to)));
    const ancestors = new Set();
    for (let i = first; i < from; i++)
        for (let item = details[i].parentDetails; item && !ancestors.has(item); item = item.parentDetails) {
            ancestors.add(item);
            candidates.add(item);
        }
    return [...candidates];
}
