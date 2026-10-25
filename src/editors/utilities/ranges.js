// Source coordinates are UTF-16 half-open ranges. They describe canonical text,
// independently of attributes or runtime changes on a projected/live element.
export function getSourceRange(node) {
    return node.editorPosition;
}

export function copySourceRange(source, target) {
    const range = getSourceRange(source);
    if (range) setSourceRange(target, range);
}

export function setSourceRange(node, range) {
    const { start, contentStart, contentEnd, end } = range;
    if (![start, contentStart, contentEnd, end].every(Number.isInteger) ||
        start < 0 || start > contentStart || contentStart > contentEnd || contentEnd > end)
        throw new RangeError("Invalid element source boundaries.");
    const value = node.editorPosition ||= {};
    for (const key of Object.keys(value))
        if (key !== "editorElement" && key !== "element" && !Object.hasOwn(range, key))
            delete value[key];
    Object.assign(value, range, { element: node });
    return value;
}
