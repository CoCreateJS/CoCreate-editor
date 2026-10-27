import { bindEditorDetailsLiveDOM } from "./createEditorDetails.js";

const states = new WeakMap();
const childContainer = node => node?.localName === "template" && node.content ? node.content : node;
const breakPlaceholder = "data-cocreate-dom-break";

function bind(detail, node, property) {
    if (property === "liveDOM") bindEditorDetailsLiveDOM(detail, node);
    else detail[property] = node;
}

function textValue(detail, document) {
    if (["script", "style"].includes(detail.parentDetails?.tag) || !detail.value.includes("&")) {
        detail.renderEntities = null;
        return detail.value;
    }
    if (detail.decodedSource === detail.value) {
        detail.renderEntities = detail.decodedEntities;
        return detail.decodedValue;
    }
    const decoder = document.createElement("textarea");
    const entities = [];
    let difference = 0;
    // Decode references individually so literal markup and line breaks are preserved.
    const value = detail.value.replace(/&(?:#(?:x[\da-f]+|\d+)|[a-z][\da-z]*);?/ig, (entity, start) => {
        decoder.innerHTML = entity;
        const decoded = decoder.textContent;
        if (decoded !== entity) entities.push({ start, end: start + entity.length,
            renderStart: start - difference, renderEnd: start - difference + decoded.length });
        difference += entity.length - decoded.length;
        return decoded;
    });
    detail.decodedSource = detail.value;
    detail.decodedValue = value;
    detail.decodedEntities = detail.renderEntities = entities;
    return value;
}

function elementNode(document, tag) {
    if (tag !== "script") return document.createElement(tag);
    const template = document.createElement("template");
    template.innerHTML = "<script></script>";
    return template.content.firstChild;
}

function renderRoot(root, details, property, plan) {
    const document = root.ownerDocument;
    const previous = states.get(root);
    const operations = { added: [], removed: [], updated: [], moved: [] };
    if (previous && plan.reparse === null && !plan.added?.length && !plan.removed?.length &&
        (plan.edited || []).every(({ detail, changes }) => detail.kind === "text" && !detail.sourceOnly &&
            detail[property]?.nodeType === 3 && !/[\r\n]$/.test(detail.value) &&
            !detail[property].nextSibling?.hasAttribute?.("data-cocreate-dom-break") &&
            Object.keys(changes || {}).every(key => ["value", "length", "potentialTags",
                "potentialOpenTag", "potentialClosingTag"].includes(key)))) {
        for (const { detail } of plan.edited || []) {
            const node = detail[property], value = textValue(detail, node.ownerDocument);
            if (node.data !== value) {
                operations.updated.push({ node, value });
                node.data = value;
            }
            detail.renderValue = value;
        }
        return operations;
    }
    const host = childContainer(root);
    const children = new Map([[host, []]]);
    const attributes = new Map();
    const nodes = new Set();
    const addedNodes = new Set();
    const starts = new Map();
    const append = (parent, node) => {
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(node);
        nodes.add(node);
    };
    let sourcePosition = 0;
    for (const detail of details) {
        starts.set(detail, sourcePosition);
        sourcePosition += detail.length;
        if (detail.sourceOnly) continue;
        const owner = detail.parentDetails?.[property] || root;
        const parent = detail.kind === "attribute" ? owner : childContainer(owner);
        const nodeDocument = parent.ownerDocument || document;
        let node = detail[property];
        if (detail.kind === "element") {
            if (node?.nodeType !== 1 || node.localName !== detail.tag) {
                node = elementNode(nodeDocument, detail.tag);
                operations.added.push(node);
                addedNodes.add(node);
            }
            bind(detail, node, property);
            append(parent, node);
            children.set(childContainer(node), []);
            attributes.set(node, new Map());
        } else if (detail.kind === "text" || detail.kind === "comment") {
            const comment = detail.kind === "comment";
            const value = comment ? detail.value.slice(4, detail.value.endsWith("-->") ? -3 : undefined)
                : textValue(detail, nodeDocument);
            if (node?.nodeType !== detail.nodeType) {
                node = comment ? nodeDocument.createComment(value) : nodeDocument.createTextNode(value);
                operations.added.push(node);
                addedNodes.add(node);
            } else if (node.data !== value) operations.updated.push({ node, value });
            if (!comment) detail.renderValue = value;
            bind(detail, node, property);
            append(parent, node);
        } else if (detail.kind === "attribute") {
            const desired = attributes.get(parent);
            if (!desired || desired.has(detail.name.toLowerCase())) continue;
            if (detail.attributeSource !== detail.value) {
                const template = document.createElement("template");
                template.innerHTML = `<span ${detail.value}></span>`;
                const attribute = template.content.firstChild?.getAttributeNode(detail.name);
                detail.attributeSource = detail.value;
                detail.parsedAttribute = attribute ? { name: attribute.name, value: attribute.value } : null;
            }
            if (detail.parsedAttribute) {
                const { name, value } = detail.parsedAttribute;
                desired.set(name.toLowerCase(), { detail, name, value });
            }
        }
    }

    // A terminal LF in a contenteditable text node often has no visible caret
    // line in Chromium. The BR is a projection-only anchor, not source data.
    for (const detail of details) {
        if (detail.kind !== "text" || detail.sourceOnly || !/[\r\n]$/.test(detail.value)) continue;
        const node = detail[property];
        const parent = childContainer(detail.parentDetails?.[property] || root);
        const ordered = children.get(parent);
        if (!node || ordered?.at(-1) !== node) continue;
        const placeholder = document.createElement("br");
        placeholder.setAttribute(breakPlaceholder, String(starts.get(detail) + detail.length));
        append(parent, placeholder);
        operations.added.push(placeholder);
        addedNodes.add(placeholder);
    }

    // Give contenteditable a real caret position after a final root element.
    // This BR is projection-only so the source and CRDT remain unchanged.
    const lastDetail = details.at(-1);
    const lastElement = lastDetail?.kind === "elementEnd" &&
        lastDetail.parentDetails && !lastDetail.parentDetails.parentDetails
        ? lastDetail.parentDetails : null;
    const rootChildren = children.get(host);
    if (lastElement?.[property] && rootChildren?.at(-1) === lastElement[property]) {
        const placeholder = document.createElement("br");
        placeholder.setAttribute(breakPlaceholder, String(sourcePosition));
        append(host, placeholder);
        operations.added.push(placeholder);
        addedNodes.add(placeholder);
    }

    // All final node/attribute lists exist before the first existing node changes.
    if (!previous) host.replaceChildren();
    else {
        // Parent removal only disconnects descendants; referenced survivors are moved below.
        for (const node of previous.nodes) if (!nodes.has(node)) {
            operations.removed.push(node);
            node.remove();
        }
        for (const [owner, oldAttributes] of previous.attributes) {
            const desired = attributes.get(owner);
            for (const [name, old] of oldAttributes) if (desired?.get(name)?.detail !== old.detail) {
                const attribute = old.detail[property];
                if (attribute?.ownerElement === owner) owner.removeAttributeNode(attribute);
            }
        }
    }
    for (const { node, value } of operations.updated) node.data = value;
    for (const [owner, desired] of attributes) for (const attribute of desired.values()) {
        if (owner.getAttribute(attribute.name) !== attribute.value)
            owner.setAttribute(attribute.name, attribute.value);
        bind(attribute.detail, owner.getAttributeNode(attribute.name), property);
    }
    for (const [parent, ordered] of children) {
        let before = null;
        for (let index = ordered.length - 1; index >= 0; index--) {
            const node = ordered[index];
            if (node.parentNode !== parent || node.nextSibling !== before) {
                parent.insertBefore(node, before);
                if (!addedNodes.has(node)) operations.moved.push(node);
            }
            before = node;
        }
    }
    states.set(root, { nodes, attributes });
    return operations;
}

/** Materialize a committed details array through references, without querying either tree. */
export function renderDOM(editor, plan) {
    const { editorDetails } = plan;
    const live = editor?.editor?.liveDOM || editor?.liveDOM || (editor?.nodeType ? editor : null);
    const detached = editor?.editor?.detachedDOM || editor?.detachedDOM;
    const result = {};
    if (live?.ownerDocument) result.liveDOM = renderRoot(live, editorDetails, "liveDOM", plan);
    if (detached?.ownerDocument && detached !== live)
        result.detachedDOM = renderRoot(detached, editorDetails, "detachedDOM", plan);
    return result;
}

export default renderDOM;
