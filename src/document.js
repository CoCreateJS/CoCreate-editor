import { renderHTML } from "./html.js";
import { reconcile } from "./projection.js";

export function serializeDocument(doc) {
    const type = doc.doctype;
    const declaration = type
        ? new doc.defaultView.XMLSerializer().serializeToString(type)
        : "";
    return declaration + doc.documentElement.outerHTML;
}
export function renderDocument(source, ownerDocument = document) {
    const fragment = renderHTML(source, { documentMode: true });
    const staged = ownerDocument.implementation.createHTMLDocument("");
    const root = [...fragment.children].find((node) => node.tagName === "HTML");
    if (root)
        staged.replaceChild(staged.adoptNode(root), staged.documentElement);
    else {
        const head = [...fragment.children].find(
            (node) => node.tagName === "HEAD"
        );
        const body = [...fragment.children].find(
            (node) => node.tagName === "BODY"
        );
        if (head) staged.documentElement.replaceChild(head, staged.head);
        if (body) staged.documentElement.replaceChild(body, staged.body);
        for (const node of [...fragment.childNodes]) staged.body.append(node);
    }
    if (!staged.head)
        staged.documentElement.prepend(staged.createElement("head"));
    if (!staged.body)
        staged.documentElement.append(staged.createElement("body"));
    if (!staged.body.hasAttribute("data-source-content-start")) {
        staged.body.dataset.sourceContentStart = "0";
        staged.body.dataset.sourceContentEnd = String(source.length);
    }
    if (!staged.body.childNodes.length) {
        const br = staged.createElement("br");
        br.dataset.editorPlaceholder = "";
        staged.body.append(br);
    }
    staged.doctype?.remove();
    if (fragment.sourceDoctype) {
        const parsed =
            new ownerDocument.defaultView.DOMParser().parseFromString(
                fragment.sourceDoctype,
                "text/html"
            );
        if (parsed.doctype)
            staged.insertBefore(
                staged.importNode(parsed.doctype, true),
                staged.documentElement
            );
    }
    return staged;
}
const owned = new Set([
    "contenteditable",
    "role",
    "aria-multiline",
    "aria-label",
    "aria-required",
    "aria-invalid",
    "data-empty",
    "data-placeholder"
]);
export function reconcileDocument(live, staged) {
    const root = live.documentElement,
        next = staged.documentElement;
    for (const attr of [...root.attributes]) {
        if (
            !owned.has(attr.name) &&
            attr.name !== "class" &&
            !next.hasAttribute(attr.name)
        )
            root.removeAttribute(attr.name);
    }
    for (const attr of next.attributes)
        if (!owned.has(attr.name) && attr.name !== "class")
            root.setAttribute(attr.name, attr.value);
    root.className = [next.className, "cocreate-editor"]
        .filter(Boolean)
        .join(" ");
    reconcile(root, next);
    const before = live.doctype,
        after = staged.doctype;
    if (
        before?.name !== after?.name ||
        before?.publicId !== after?.publicId ||
        before?.systemId !== after?.systemId
    ) {
        before?.remove();
        if (after) live.insertBefore(live.importNode(after, true), root);
    }
}
