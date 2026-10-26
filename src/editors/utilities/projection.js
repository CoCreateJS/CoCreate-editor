import { getParsedDetails } from "./indexedDOM.js";
import { isBoundary, boundaryIdentity, boundaryFor } from "./boundaries.js";
import { copyEditorDetails, getEditorDetails } from "./details.js";
import {
    getSourceMap, isPlaceholder, markPlaceholder,
    setSourceMap, unmarkPlaceholder
} from "./nodeData.js";
const positionIndexes = new WeakMap();

function depth(node) {
    let value = 0;
    const details = getEditorDetails(node);
    if (details) {
        for (let item = details; item; item = item.parentDetails) value++;
        return value;
    }
    while (node) { value++; node = node.parentNode; }
    return value;
}

function domForDetails(details, root) {
    const rootDetails = getEditorDetails(root);
    if (rootDetails?.detachDOM === root) return details.detachDOM;
    if (rootDetails?.liveDOM === root) return details.liveDOM;
    const liveDOM = details.liveDOM;
    return liveDOM && (liveDOM === root || root.contains?.(liveDOM))
        ? liveDOM : details.detachDOM;
}

function positionIndex(root) {
    let index = positionIndexes.get(root);
    if (index) return index;

    const rootDetails = getEditorDetails(root);
    const owner = rootDetails?.editorElement;
    if (getParsedDetails(owner?.editor?.dom).length) {
        const records = owner.editor.editorDetails.filter(item => {
            for (let current = item; current; current = current.parentDetails)
                if (current === rootDetails) return true;
            return false;
        });
        const elements = records.filter(item => item.detachDOM.nodeType === 1);
        const boundaries = elements.filter(item => item.positionBoundary)
            .sort((a, b) => a.end - b.end || depth(domForDetails(b, root)) - depth(domForDetails(a, root)));
        const textPositions = [], textParents = new Set(), childOffsets = new Map(), counts = new Map();
        let order = 0;
        for (const item of records) {
            const parent = item.parentDetails;
            const count = counts.get(parent) || 0;
            childOffsets.set(item, item.childIndex ?? count);
            counts.set(parent, count + 1);
            if (item.detachDOM.nodeType !== 3) continue;
            let nested = false;
            for (let current = parent; current && current !== rootDetails; current = current.parentDetails)
                if (isBoundary(current.detachDOM)) { nested = true; break; }
            if (nested) continue;
            const node = domForDetails(item, root), map = getSourceMap(item.detachDOM);
            if (node.length) for (let current = parent; current; current = current.parentDetails) textParents.add(current);
            if (map?.length) textPositions.push({ start: map[0][0], end: map.at(-1)[1],
                node, offset: 0, map, order: order++ });
        }
        textPositions.sort((a, b) => a.start - b.start || a.order - b.order);
        index = { elements, boundaries, textPositions, textParents, childOffsets };
        positionIndexes.set(root, index);
        return index;
    }

    // The live element and sorted editor index share each details object.
    const elements = [root, ...root.querySelectorAll("*")]
        .map(getEditorDetails)
        .filter(Boolean);
    const boundaries = elements.filter(range => range.positionBoundary)
        .sort((a, b) => a.end - b.end ||
            depth(domForDetails(b, root)) - depth(domForDetails(a, root)));
    const textPositions = [];
    const walker = root.ownerDocument.createTreeWalker(
        root,
        root.ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4
    );
    let node, order = 0;
    while ((node = walker.nextNode())) {
        if (boundaryFor(node, root)) continue;
        for (let offset = 0; offset < node.length; offset++) {
            const span = getSourceMap(node)?.[offset];
            if (!span) continue;
            textPositions.push({
                start: span[0],
                end: span[1],
                node,
                offset,
                order: order++
            });
        }
    }
    textPositions.sort((a, b) => a.start - b.start || a.order - b.order);
    index = { elements, boundaries, textPositions };
    positionIndexes.set(root, index);
    return index;
}

export function invalidatePositionIndex(root) {
    positionIndexes.delete(root);
}
// Read native editable DOM and retain coordinates for selection/source mapping.
const blocks = new Set([
    "P",
    "DIV",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "PRE",
    "BLOCKQUOTE",
    "UL",
    "OL",
    "LI",
    "HR"
]);
export function project(root, source = "") {
    let text = "";
    const spans = [],
        points = new WeakMap();
    function append(value, map) {
        for (let i = 0; i < value.length; i++) {
            text += value[i];
            spans.push(map?.(i) ?? null);
        }
    }
    function walk(node) {
        if (node.nodeType === 3) {
            const start = text.length;
            points.set(
                node,
                Array.from({ length: node.length + 1 }, (_, i) => start + i)
            );
            const map = getSourceMap(node);
            append(node.data, map ? i => map[i] : null);
            return;
        }
        if (
            node.nodeType !== 1 ||
            isPlaceholder(node) ||
            node.tagName === "HEAD" ||
            node.tagName === "SCRIPT" ||
            node.tagName === "STYLE"
        )
            return;
        const offsets = [text.length];
        points.set(node, offsets);
        if (
            node.nodeName === "BR" ||
            node.nodeName === "HR" ||
            getEditorDetails(node)?.void ||
            (node !== root && isBoundary(node))
        ) {
            append(
                node.nodeName === "BR" ? "\n" : "\uFFFC",
                getEditorDetails(node)
                    ? () => [getEditorDetails(node).start, getEditorDetails(node).end]
                    : null
            );
            return;
        }
        let previous;
        for (const child of node.childNodes) {
            const placeholder =
                child.nodeType === 1 &&
                (isPlaceholder(child) ||
                    (child.nodeName === "BR" &&
                        child === node.lastChild &&
                    !getEditorDetails(child)?.positionBoundary));
            if (placeholder) {
                points.set(child, [text.length]);
                offsets.push(text.length);
                continue;
            }
            if (
                previous &&
                (blocks.has(child.nodeName) || blocks.has(previous.nodeName)) &&
                !text.endsWith("\n")
            )
                append("\n");
            offsets[offsets.length - 1] = text.length;
            walk(child);
            offsets.push(text.length);
            previous = child;
        }
    }
    walk(root);
    // Synthetic line breaks span the source gap between adjacent rendered characters.
    let previous = 0;
    for (let i = 0; i < spans.length; i++) {
        if (spans[i]) {
            previous = spans[i][1];
            continue;
        }
        let j = i + 1;
        while (j < spans.length && !spans[j]) j++;
        spans[i] = [previous, j < spans.length ? spans[j][0] : source.length];
        previous = spans[i][1];
    }
    return { text, spans, points };
}
export function sourceAt(projection, position, end = false) {
    if (!projection.spans.length) return 0;
    if (end && position > 0)
        return projection.spans[
            Math.min(position, projection.spans.length) - 1
        ][1];
    return projection.spans[Math.min(position, projection.spans.length - 1)][
        position >= projection.spans.length ? 1 : 0
    ];
}
function key(node) {
    return isBoundary(node)
        ? boundaryIdentity(node)
        : node.nodeName + ":" + node.textContent;
}
function cloneMapped(node) {
    const clone = node.cloneNode(false);
    copyEditorDetails(node, clone);
    setSourceMap(clone, getSourceMap(node));
    if (isPlaceholder(node)) markPlaceholder(clone);
    else unmarkPlaceholder(clone);
    for (const child of node.childNodes) clone.appendChild(cloneMapped(child));
    return clone;
}
function patch(live, staged, changed) {
    if (
        live.nodeType !== staged.nodeType ||
        live.nodeName !== staged.nodeName
    ) {
        const parent = live.parentNode;
        live.replaceWith(cloneMapped(staged));
        changed?.add(parent);
        return;
    }
    if (isPlaceholder(staged)) markPlaceholder(live);
    else unmarkPlaceholder(live);
    copyEditorDetails(staged, live);
    if (live.nodeType === 3 || live.nodeType === 8) {
        if (live.data !== staged.data) {
            live.data = staged.data;
            changed?.add(live);
        }
        setSourceMap(live, getSourceMap(staged));
        return;
    }
    const boundary =
        isBoundary(live) &&
        isBoundary(staged) &&
        boundaryIdentity(live) === boundaryIdentity(staged);
    const owned =
        boundary && live.__cocreateEditor
            ? new Set([
                  "class",
                  "role",
                  "aria-multiline",
                  "aria-label",
                  "aria-required",
                  "aria-invalid",
                  "data-empty",
                  "data-placeholder"
              ])
            : new Set();
    for (const attr of [...live.attributes])
        if (!owned.has(attr.name) && !staged.hasAttribute(attr.name)) {
            live.removeAttribute(attr.name);
            changed?.add(live);
        }
    for (const attr of staged.attributes)
        if (
            !owned.has(attr.name) &&
            live.getAttribute(attr.name) !== attr.value
        ) {
            live.setAttribute(attr.name, attr.value);
            changed?.add(live);
        }
    if (owned.has("class")) {
        const previous = new Set(
            (live._editorTemplateClass || "").split(/\s+/)
        );
        const runtime = [...live.classList].filter(
            (name) => !previous.has(name)
        );
        const classes = [...new Set([...staged.classList, ...runtime])].join(
            " "
        );
        if (live.className !== classes) {
            live.className = classes;
            changed?.add(live);
        }
    }
    live._editorTemplateClass = staged.className;
    if (!boundary) reconcile(live, staged, changed);
}
export function reconcile(live, staged, changed) {
    copyEditorDetails(staged, live);
    const old = [...live.childNodes],
        next = [...staged.childNodes];
    let prefix = 0,
        suffix = 0;
    while (
        prefix < old.length &&
        prefix < next.length &&
        key(old[prefix]) === key(next[prefix])
    ) {
        patch(old[prefix], next[prefix], changed);
        prefix++;
    }
    while (
        suffix < old.length - prefix &&
        suffix < next.length - prefix &&
        key(old[old.length - 1 - suffix]) ===
            key(next[next.length - 1 - suffix])
    )
        suffix++;
    const count = Math.min(
        old.length - prefix - suffix,
        next.length - prefix - suffix
    );
    for (let i = 0; i < count; i++) patch(old[prefix + i], next[prefix + i], changed);
    for (let i = prefix + count; i < old.length - suffix; i++) {
        old[i].remove();
        changed?.add(live);
    }
    const anchor = suffix ? old[old.length - suffix] : null;
    for (let i = prefix + count; i < next.length - suffix; i++) {
        live.insertBefore(cloneMapped(next[i]), anchor);
        changed?.add(live);
    }
    for (let i = 0; i < suffix; i++)
        patch(old[old.length - suffix + i], next[next.length - suffix + i], changed);
}

// Map a canonical source offset back to a rendered text node without changing
// the document selection. Markdown delimiters are included in each text map.
export function pointAtSource(root, position) {
    const index = positionIndex(root);
    let low = 0, high = index.boundaries.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (index.boundaries[middle].end < position) low = middle + 1;
        else high = middle;
    }
    let boundary;
    for (let i = low; i < index.boundaries.length &&
        index.boundaries[i].end === position; i++)
        if (!boundary || depth(domForDetails(index.boundaries[i], root)) >
            depth(domForDetails(boundary, root)))
            boundary = index.boundaries[i];
    if (boundary) {
        const node = domForDetails(boundary, root);
        return [node.parentNode, (index.childOffsets?.get(boundary) ?? [...node.parentNode.childNodes].indexOf(node)) + 1];
    }

    let empty;
    for (const range of index.elements) {
        const node = domForDetails(range, root);
        if ((index.textParents ? !index.textParents.has(range) : !node.textContent) && !range.void &&
            range.contentStart <= position && position <= range.contentEnd &&
            (!empty || range.contentEnd - range.contentStart <
                empty.contentEnd - empty.contentStart)) empty = range;
    }
    if (empty) return [domForDetails(empty, root), 0];
    low = 0;
    high = index.textPositions.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (index.textPositions[middle].start < position) low = middle + 1;
        else high = middle;
    }
    const next = index.textPositions[low];
    if (next?.start === position) return [next.node, next.offset];
    const previous = index.textPositions[low - 1];
    if (previous?.map) {
        const map = previous.map;
        let from = 0, to = map.length;
        while (from < to) {
            const middle = (from + to) >>> 1;
            if (map[middle][0] < position) from = middle + 1;
            else to = middle;
        }
        if (map[from]?.[0] === position) return [previous.node, from];
        const offset = Math.max(0, from - 1);
        return [previous.node, position < map[offset][1] ? offset : offset + 1];
    }
    if (previous && position < previous.end)
        return [previous.node, previous.offset];
    if (previous) return [previous.node, previous.offset + 1];
    return next ? [next.node, next.offset] : [root, 0];
}
