import { getEditorDetails } from "./details.js";

// Select the deepest rendered container whose content contains the old source
// range. Crossing a child's tag leaves its parent as the safe update boundary.
export function affectedPath(root, { start, length }, editorElement) {
    const end = start + length;
    const details = editorElement?.editor?.editorDetails;
    if (details?.length) {
        let low = 0, high = details.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (details[middle].start <= start) low = middle + 1;
            else high = middle;
        }
        const item = details[low - 1];
        if (item) {
            const path = [];
            for (let current = item; current; current = current.parentDetails) {
                if (current.contentStart <= start && end <= current.contentEnd)
                    path.push(current.detachDOM);
            }
            if (path.at(-1) === root) return path;
        }
    }
    const path = [root];
    let current = root;
    while (true) {
        const child = [...current.children].find(node => {
            const range = getEditorDetails(node);
            return range && range.contentStart <= start && end <= range.contentEnd;
        });
        if (!child) return path;
        path.unshift(child);
        current = child;
    }
}

// The parser may also change a sibling when a delimiter or tag is completed.
// Keep only outermost changed nodes; removing one removes its whole subtree.
export function outermostChanges(root, path, changed) {
    const boundary = path.find(node => node === root || root.contains(node)) || root;
    const nodes = new Set([boundary]);
    for (const node of changed)
        if (node && (node === root || root.contains(node))) nodes.add(node);
    const candidates = [...nodes];
    return candidates.filter(node =>
        !candidates.some(other => other !== node && other.contains(node))
    );
}
