import { renderSource as renderMarkdown } from "./markdown.js";
import { renderHTML } from "./html.js";
export function valueType(element) {
    const type = (element.getAttribute("editor") || "text")
        .trim()
        .toLowerCase();
    if (!["text", "markdown", "html"].includes(type))
        throw new TypeError("editor must be text, markdown or html.");
    return type;
}
export function renderSource(source, type = "markdown") {
    if (type === "text") {
        const root = document.createElement("div");
        const text = document.createTextNode(source);
        text._sourceMap = Array.from({ length: source.length }, (_, i) => [
            i,
            i + 1
        ]);
        root.append(text);
        if (!source || source.endsWith("\n")) {
            const placeholder = document.createElement("br");
            placeholder.dataset.editorPlaceholder = "";
            root.append(placeholder);
        }
        return root;
    }
    if (type === "markdown") return renderMarkdown(source);
    if (type === "html") return renderHTML(source);
    throw new TypeError("Source type must be text, markdown or html.");
}
