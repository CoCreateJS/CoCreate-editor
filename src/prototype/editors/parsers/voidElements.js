const voidElements = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr"
]);

export const isVoidElement = tag => voidElements.has(tag);
export default voidElements;
