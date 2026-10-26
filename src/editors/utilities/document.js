import { copyEditorDetails } from "./details.js";
import { reconcile } from "./projection.js";

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

export function reconcileDocument(live, staged, changed) {
    const root = live.documentElement;
    const next = staged.documentElement;
    copyEditorDetails(next, root);
    for (const attr of [...root.attributes])
        if (!owned.has(attr.name) && attr.name !== "class" && !next.hasAttribute(attr.name)) {
            root.removeAttribute(attr.name);
            changed?.add(root);
        }
    for (const attr of next.attributes)
        if (!owned.has(attr.name) && attr.name !== "class" && root.getAttribute(attr.name) !== attr.value) {
            root.setAttribute(attr.name, attr.value);
            changed?.add(root);
        }
    if (!root.classList.contains("cocreate-editor") && root.className !== next.className) {
        root.className = next.className;
        changed?.add(root);
    }
    reconcile(root, next, changed);

    const before = live.doctype;
    const after = staged.doctype;
    if (before?.name !== after?.name || before?.publicId !== after?.publicId || before?.systemId !== after?.systemId) {
        before?.remove();
        if (after) live.insertBefore(live.importNode(after, true), root);
    }
}
