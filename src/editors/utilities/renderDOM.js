import { bindEditorNode } from "./createEditor.js";

const states = new WeakMap();
const childContainer = node => node?.localName === "template" && node.content ? node.content : node;
const breakPlaceholder = "data-cocreate-dom-break";

function bind(detail, node, property) {
    bindEditorNode(detail, node, property);
}

function textValue(detail, document) {
    if (["script", "style"].includes(detail.parentNode?.tag) || !detail.value.includes("&")) {
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

function renderRoot(root, details, property, plan, documentRootDetail = null) {
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
        let position = 0;
        for (const detail of details) {
            position += detail.length;
            const placeholder = previous.placeholders.get(detail);
            if (placeholder && placeholder.getAttribute(breakPlaceholder) !== String(position))
                placeholder.setAttribute(breakPlaceholder, String(position));
        }
        return operations;
    }
    const host = childContainer(root);
    const children = new Map([[host, []]]);
    const attributes = new Map();
    const nodes = new Set();
    const addedNodes = new Set();
    const starts = new Map();
    const placeholders = new Map();
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
        const owner = detail.parentNode?.[property] || root;
        const parent = detail.kind === "attribute" ? owner : childContainer(owner);
        const nodeDocument = parent.ownerDocument || document;
        let node = detail[property];
        if (detail.kind === "element") {
            // A complete iframe source includes its own <html> record. Bind
            // that record to the browsing context's existing documentElement
            // instead of inserting a second <html> inside the render host.
            if (detail === documentRootDetail) node = root;
            // Keep the iframe's native head/body nodes when the source has
            // those top-level children, so document accessors and listeners
            // continue to refer to the reconciled nodes.
            else if (!node && detail.parentNode === documentRootDetail &&
                detail.tag === "head" && document.head?.parentNode === root) node = document.head;
            else if (!node && detail.parentNode === documentRootDetail &&
                detail.tag === "body" && document.body?.parentNode === root) node = document.body;
            if (node?.nodeType !== 1 || node.localName !== detail.tag) {
                node = elementNode(nodeDocument, detail.tag);
                operations.added.push(node);
                addedNodes.add(node);
            }
            bind(detail, node, property);
            if (node !== root) append(parent, node);
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
        const parent = childContainer(detail.parentNode?.[property] || root);
        const ordered = children.get(parent);
        if (!node || ordered?.at(-1) !== node) continue;
        const placeholder = document.createElement("br");
        placeholder.setAttribute(breakPlaceholder, String(starts.get(detail) + detail.length));
        placeholders.set(detail, placeholder);
        append(parent, placeholder);
        operations.added.push(placeholder);
        addedNodes.add(placeholder);
    }

    // Give contenteditable a real caret position after a final root element.
    // This BR is projection-only so the source and CRDT remain unchanged.
    const lastDetail = details.at(-1);
    const lastElement = lastDetail?.kind === "elementEnd" &&
        lastDetail.parentNode && !lastDetail.parentNode.parentNode
        ? lastDetail.parentNode : null;
    const rootChildren = children.get(host);
    if (lastElement?.[property] && rootChildren?.at(-1) === lastElement[property]) {
        const placeholder = document.createElement("br");
        placeholder.setAttribute(breakPlaceholder, String(sourcePosition));
        placeholders.set(lastDetail, placeholder);
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
    states.set(root, { nodes, attributes, placeholders });
    return operations;
}

/** Materialize a committed details array through references, without querying either tree. */
export function renderDOM(editor, plan) {
    const { editorDetails } = plan;
    const live = editor?.editor?.liveNode || editor?.editor?.element || editor?.liveNode ||
        (editor?.nodeType ? editor : null);
    const detached = editor?.editor?.detachedNode || editor?.detachedNode;
    const documentRootDetail = editorDetails.find(detail =>
        detail.kind === "element" && detail.tag === "html" && !detail.parentNode) || null;
    const result = {};
    if (live?.ownerDocument) {
        const root = documentRootDetail && live.ownerDocument.documentElement
            ? live.ownerDocument.documentElement : live;
        result.liveNode = renderRoot(root, editorDetails, "liveNode", plan, documentRootDetail);
    }
    if (detached?.ownerDocument && detached !== live) {
        const root = documentRootDetail && detached.ownerDocument.documentElement
            ? detached.ownerDocument.documentElement : detached;
        result.detachedNode = renderRoot(root, editorDetails, "detachedNode", plan,
            documentRootDetail ? documentRootDetail : null);
    }
    return result;
}

export default renderDOM;
