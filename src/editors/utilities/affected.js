import { getSourceRange } from "./ranges.js";

// Select the deepest rendered container whose content contains the old source
// range. Crossing a child's tag leaves its parent as the safe update boundary.
export function affectedPath(root, { start, length }) {
    const end = start + length;
    const path = [root];
    let current = root;
    while (true) {
        const child = [...current.children].find(node => {
            const range = getSourceRange(node);
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
