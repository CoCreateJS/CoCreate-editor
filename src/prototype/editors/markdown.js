import parseMarkdown from "./parsers/markdown.js";

/** Build Markdown editor state from source and its flat detail records. */
export function createMarkdownEditor(source, editor = null) {
    return { type: "markdown", source, details: parseMarkdown(source, editor), editor };
}

export { parseMarkdown };
export default createMarkdownEditor;
