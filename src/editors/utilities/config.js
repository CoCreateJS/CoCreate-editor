// HTML void names, plus obsolete param for compatibility. In the editor's
// source grammar these require an explicit /> completion marker.
export const voidElements = Object.freeze([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr"
]);
// Shared semantic definitions. A missing language entry means no support for that language.
// Structural consumption (paragraphs, fences, nesting) belongs to the language parser.
export const codeRule = Object.freeze({
    name: "code",
    tag: "code",
    literal: true,
    markdown: Object.freeze({ scope: "inline", pattern: /`+/g }),
    html: Object.freeze({ tags: ["code"] })
});
export const fenceRule = Object.freeze({
    name: "fence",
    tag: "pre",
    literal: true,
    markdown: Object.freeze({
        scope: "block",
        kind: "fence",
        pattern: /^ {0,3}(`{3,}|~{3,})/
    }),
    html: Object.freeze({ tags: ["pre"] })
});
export const syntaxRules = [
    codeRule,
    fenceRule,
    {
        name: "link",
        tag: "a",
        markdown: {
            scope: "inline",
            pattern: /\[([^\]]*)\]\(([^\s)]+)\)/g,
            content: (m) => m[1],
            offset: () => 1,
            attributes: (m) => ({ href: m[2], rel: "noopener noreferrer" })
        },
        html: { tags: ["a"], attributes: ["class", "title", "href"] }
    },
    {
        name: "strong",
        tag: "strong",
        markdown: {
            scope: "inline",
            pattern: /\*\*([\s\S]+?)\*\*|__([\s\S]+?)__/g,
            content: (m) => m[1] ?? m[2],
            offset: () => 2
        },
        html: { tags: ["strong", "b"] }
    },
    {
        name: "emphasis",
        tag: "em",
        markdown: {
            scope: "inline",
            pattern: /\*([^*\n]+?)\*|_([^_\n]+?)_/g,
            content: (m) => m[1] ?? m[2],
            offset: () => 1
        },
        html: { tags: ["em", "i"] }
    },
    ...Array.from({ length: 6 }, (_, i) => ({
        name: `heading${i + 1}`,
        tag: `h${i + 1}`,
        markdown: {
            scope: "block",
            kind: "heading",
            pattern: new RegExp(`^ {0,3}(#{${i + 1}})[ \\t]+(.*)$`)
        },
        html: { tags: [`h${i + 1}`] }
    })),
    {
        name: "setext1",
        tag: "h1",
        markdown: {
            scope: "block",
            kind: "setext",
            pattern: /^ {0,3}=+[ \t]*$/
        }
    },
    {
        name: "setext2",
        tag: "h2",
        markdown: {
            scope: "block",
            kind: "setext",
            pattern: /^ {0,3}-+[ \t]*$/
        }
    },
    {
        name: "quote",
        tag: "blockquote",
        markdown: { scope: "block", kind: "quote", pattern: /^ {0,3}> ?(.*)$/ },
        html: { tags: ["blockquote"] }
    },
    {
        name: "unordered",
        tag: "ul",
        markdown: {
            scope: "block",
            kind: "list",
            pattern: /^ {0,3}[-+*][ \t]+(.*)$/
        },
        html: { tags: ["ul"] }
    },
    {
        name: "ordered",
        tag: "ol",
        markdown: {
            scope: "block",
            kind: "list",
            pattern: /^ {0,3}\d{1,9}[.)][ \t]+(.*)$/
        },
        html: { tags: ["ol"] }
    },
    {
        name: "rule",
        tag: "hr",
        markdown: {
            scope: "block",
            kind: "rule",
            pattern: /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/
        },
        html: { tags: ["hr"], void: true }
    },
    { name: "paragraph", tag: "p", html: { tags: ["p"] } },
    { name: "container", tag: "div", html: { tags: ["div"] } },
    { name: "item", tag: "li", html: { tags: ["li"] } },
    { name: "break", tag: "br", html: { tags: ["br"], void: true } }
];
// Whitespace after a marker is not editable content on its own.
export function hasMarkdownContent(value) {
    return /\S/.test(String(value ?? ""));
}
export function blockMatch(line, kind) {
    // Fences take priority over configurable block definitions.
    const rules = [
        fenceRule,
        ...syntaxRules.filter((rule) => rule !== fenceRule)
    ];
    for (const rule of rules) {
        const md = rule.markdown;
        if (md?.scope !== "block" || (kind && md.kind !== kind)) continue;
        const match = new RegExp(
            md.pattern.source,
            md.pattern.flags.replace(/[gy]/g, "")
        ).exec(line);
        if (!match) continue;
        const content =
            md.kind === "heading"
                ? match[2]
                : ["quote", "list"].includes(md.kind)
                  ? match[1]
                  : !md.kind
                    ? md.content(match)
                    : undefined;
        // Fences, setext underlines and horizontal rules have structural syntax.
        const requiresContent =
            !md.kind || ["heading", "quote", "list"].includes(md.kind);
        if (requiresContent && !hasMarkdownContent(content)) continue;
        return { rule, match };
    }
    return null;
}
export function safeHref(raw) {
    try {
        const url = new URL(raw, location.href);
        return ["http:", "https:", "mailto:"].includes(url.protocol)
            ? url.href
            : "#";
    } catch {
        return "#";
    }
}
export function makeElement(rule, match) {
    const node = rule.create
        ? rule.create(match)
        : document.createElement(rule.tag);
    if (!(node instanceof HTMLElement))
        throw new TypeError(
            "Syntax create(match) must return an HTML element."
        );
    return node;
}
export function applyAttributes(node, attributes) {
    for (const [name, value] of Object.entries(attributes)) {
        if (
            /^(?:class|title|role|aria-[\w-]+|data-[\w-]+|rel)$/.test(name) &&
            !/^data-(?:md|source)-/.test(name)
        )
            node.setAttribute(name, value);
        else if (name === "href" && node.tagName === "A")
            node.setAttribute(name, safeHref(value));
    }
}
