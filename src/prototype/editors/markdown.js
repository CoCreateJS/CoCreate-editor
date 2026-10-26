import parseMarkdown from "./parsers/markdown.js";
import { bindEditorDetailsLiveDOM } from "./utilities/createEditorDetails.js";

/** Build Markdown editor state from source and its flat detail records. */
export function createMarkdownEditor(source, editor = null) {
    return { type: "markdown", source, details: parseMarkdown(source, editor), editor };
}

function appendInline(parent, records, heading = false) {
    const stack = [parent];
    let skipHeadingSpace = heading;
    for (const detail of records) {
        const syntax = detail.syntax;
        if (detail.kind === "element" && /^h[1-6]$/.test(detail.tag || "")) {
            bindEditorDetailsLiveDOM(detail, parent);
            continue;
        }
        if (skipHeadingSpace && detail.kind === "whitespace") {
            skipHeadingSpace = false;
            continue;
        }
        if (detail.kind === "delimiter" && syntax) {
            const openTag = syntax === "strong-open" ? "strong"
                : syntax === "emphasis-open" ? "em"
                    : syntax === "strike-open" ? "del"
                        : syntax === "code-open" ? "code" : null;
            if (openTag) {
                const inline = parent.ownerDocument.createElement(openTag);
                stack.at(-1).append(inline);
                stack.push(inline);
            } else if (/-close$/.test(syntax) && stack.length > 1) stack.pop();
            continue;
        }
        if (detail.kind === "lineBreak") continue;
        if (["blockquote", "list-marker", "link-open", "link-destination-open", "link-close",
            "setext-heading", "thematic-break", "fence-open", "fence-close"].includes(syntax)) continue;
        if (!["text", "codeText", "whitespace", "tab"].includes(detail.kind)) continue;
        const text = parent.ownerDocument.createTextNode(detail.value);
        stack.at(-1).append(text);
        bindEditorDetailsLiveDOM(detail, text);
    }
}

/** Render source-backed Markdown details directly inside the editable host. */
export function renderEditor(element, source, details) {
    const root = element.ownerDocument.createElement("div");
    const lines = new Map();
    for (const detail of details) {
        if (!lines.has(detail.line)) lines.set(detail.line, []);
        lines.get(detail.line).push(detail);
    }

    let fenced = false, codeBlock;
    for (const records of lines.values()) {
        const marker = records.find(detail => detail.syntax === "fence-open");
        const closeFence = records.some(detail => detail.syntax === "fence-close");
        const heading = records.find(detail => detail.kind === "element" && /^h[1-6]$/.test(detail.tag || ""));
        const blockKind = records.find(detail => detail.blockKind)?.blockKind || "paragraph";
        const hasContent = records.some(detail => ["text", "codeText"].includes(detail.kind));

        if (marker) {
            fenced = true;
            codeBlock = root.ownerDocument.createElement("pre");
            codeBlock.append(root.ownerDocument.createElement("code"));
            root.append(codeBlock);
            continue;
        }
        if (fenced) {
            if (!closeFence && codeBlock) appendInline(codeBlock.firstChild, records);
            if (closeFence) fenced = false;
            continue;
        }
        if (blockKind === "rule") {
            root.append(root.ownerDocument.createElement("hr"));
            continue;
        }
        if (!hasContent) continue;

        const tag = heading?.tag || (blockKind === "quote" ? "blockquote"
            : blockKind === "list" ? "ul" : "p");
        const block = root.ownerDocument.createElement(tag);
        const content = blockKind === "list" ? root.ownerDocument.createElement("li") : block;
        if (blockKind === "list") block.append(content);
        appendInline(content, records, !!heading);
        root.append(block);
    }
    element.replaceChildren(...root.childNodes);
}

function inlineSource(node) {
    if (node.nodeType === 3) return node.data;
    const content = [...node.childNodes].map(inlineSource).join("");
    switch (node.localName) {
        case "strong": case "b": return `**${content}**`;
        case "em": case "i": return `*${content}*`;
        case "del": case "s": return `~~${content}~~`;
        case "code": return `\`${content}\``;
        case "br": return "\n";
        default: return content;
    }
}

/** Serialize the editable Markdown projection back to canonical Markdown source. */
export function getSource(element) {
    const blocks = [];
    for (const node of element.childNodes) {
        if (node.nodeType === 3) {
            if (node.data.trim()) blocks.push(node.data);
            continue;
        }
        const content = [...node.childNodes].map(inlineSource).join("");
        if (/^H[1-6]$/.test(node.tagName)) blocks.push(`${"#".repeat(Number(node.tagName[1]))} ${content}`);
        else if (node.tagName === "BLOCKQUOTE")
            blocks.push(content.split("\n").map(line => `> ${line}`).join("\n"));
        else if (node.tagName === "UL" || node.tagName === "OL")
            blocks.push([...node.querySelectorAll(":scope > li")].map((item, index) =>
                `${node.tagName === "UL" ? "-" : `${index + 1}.`} ${[...item.childNodes].map(inlineSource).join("")}`
            ).join("\n"));
        else if (node.tagName === "PRE") blocks.push(`\`\`\`\n${node.textContent}\n\`\`\``);
        else if (node.tagName === "HR") blocks.push("---");
        else blocks.push(content);
    }
    return blocks.join("\n\n");
}

export { parseMarkdown };
export default createMarkdownEditor;
