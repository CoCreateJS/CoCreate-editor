import { isBoundary, boundaryIdentity, boundaryFor } from "./boundaries.js";
import { copySourceRange } from "./ranges.js";
const presentationAttribute = name =>
    name !== "data-editor-placeholder" && !/^data-(?:source|md)-/.test(name);
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
            const base = Number(
                node.parentElement?.closest("[data-md-start]")?.dataset
                    .mdStart || 0
            );
            const start = text.length;
            points.set(
                node,
                Array.from({ length: node.length + 1 }, (_, i) => start + i)
            );
            append(
                node.data,
                node._sourceMap
                    ? (i) => node._sourceMap[i]
                    : node._mdMap
                      ? (i) => [
                            base + node._mdMap[i],
                            base + node._mdMap[i] + 1
                        ]
                      : null
            );
            return;
        }
        if (
            node.nodeType !== 1 ||
            node.hasAttribute("data-editor-placeholder") ||
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
            node.hasAttribute("data-source-void") ||
            (node !== root && isBoundary(node))
        ) {
            append(
                node.nodeName === "BR" ? "\n" : "\uFFFC",
                node.hasAttribute("data-source-start")
                    ? () => [
                          Number(node.dataset.sourceStart),
                          Number(node.dataset.sourceAfter)
                      ]
                    : null
            );
            return;
        }
        let previous;
        for (const child of node.childNodes) {
            const placeholder =
                child.nodeType === 1 &&
                (child.hasAttribute("data-editor-placeholder") ||
                    (child.nodeName === "BR" &&
                        child === node.lastChild &&
                        !child.hasAttribute("data-source-void") &&
                        !child.hasAttribute("data-md-after")));
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
    copySourceRange(node, clone);
    clone._mdMap = node._mdMap;
    clone._sourceMap = node._sourceMap;
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
    copySourceRange(staged, live);
    if (live.nodeType === 3 || live.nodeType === 8) {
        if (live.data !== staged.data) {
            live.data = staged.data;
            changed?.add(live);
        }
        live._mdMap = staged._mdMap;
        live._sourceMap = staged._sourceMap;
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
            if (presentationAttribute(attr.name)) changed?.add(live);
        }
    for (const attr of staged.attributes)
        if (
            !owned.has(attr.name) &&
            live.getAttribute(attr.name) !== attr.value
        ) {
            live.setAttribute(attr.name, attr.value);
            if (presentationAttribute(attr.name)) changed?.add(live);
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
    copySourceRange(staged, live);
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
    for (const container of root.querySelectorAll("[data-source-after]")) {
        if (Number(container.dataset.sourceAfter) === position)
            return [container.parentNode, [...container.parentNode.childNodes].indexOf(container) + 1];
        if (!container.textContent && !container.hasAttribute("data-source-void") &&
            position >= Number(container.dataset.sourceContentStart) &&
            position <= Number(container.dataset.sourceContentEnd)) return [container, 0];
    }
    for (const br of root.querySelectorAll("[data-md-after]")) {
        const base = Number(br.closest("[data-md-start]")?.dataset.mdStart || 0);
        if (base + Number(br.dataset.mdAfter) === position)
            return [br.parentNode, [...br.parentNode.childNodes].indexOf(br) + 1];
    }
    const walker = root.ownerDocument.createTreeWalker(
        root,
        root.ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4
    );
    let node, last;
    while ((node = walker.nextNode())) {
        if (boundaryFor(node, root)) continue;
        const base = Number(node.parentElement.closest("[data-md-start]")?.dataset.mdStart || 0);
        for (let i = 0; i < node.length; i++) {
            const span = node._sourceMap?.[i];
            const mdOffset = node._mdMap?.[i];
            const offset = span ? span[0] : Number.isInteger(mdOffset) ? base + mdOffset : null;
            const end = span ? span[1] : offset === null ? null : offset + 1;
            if (offset === null) continue;
            if (offset <= position && position < end) return [node, i];
            last = [node, i + 1];
        }
        const end = node._sourceMap?.at(-1)?.[1] ??
            (node._mdMap?.length ? base + node._mdMap.at(-1) + 1 : undefined);
        if (position === end) return [node, node.length];
    }
    return last || [root, 0];
}
