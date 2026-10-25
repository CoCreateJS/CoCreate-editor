import { setSourceRange } from "./utilities/ranges.js";
import { reconcileMirror } from "./utilities/mirror.js";
import htmlTokens from "./language/html.js";
import javascript from "./language/javascript.js";

export const codeRules = { javascript, js: javascript };

function* ruleTokens(source, definitions) {
    const rules = definitions.map(rule => ({
        ...rule,
        pattern: new RegExp(rule.pattern.source, rule.pattern.flags.replace(/[gy]/g, "") + "y")
    }));
    let position = 0;
    while (position < source.length) {
        let matched = false;
        for (const rule of rules) {
            rule.pattern.lastIndex = position;
            const match = rule.pattern.exec(source);
            if (!match?.[0].length) continue;
            const end = position + match[0].length;
            const [contentStart, contentEnd] = rule.content?.(match[0]) ?? [0, match[0].length];
            yield { name: rule.name, start: position, end,
                contentStart: position + contentStart, contentEnd: position + contentEnd };
            position = end;
            matched = true;
            break;
        }
        if (!matched) position++;
    }
}

function mappedText(parent, source, start, end) {
    if (start === end) return;
    const node = parent.ownerDocument.createTextNode(source.slice(start, end));
    node._sourceMap = Array.from({ length: end - start }, (_, i) =>
        [start + i, start + i + 1]);
    parent.append(node);
}

export default function createCodeDOM(source, liveRoot, language = "text") {
    source = String(source ?? "");
    const doc = liveRoot?.ownerDocument || document;
    const staging = doc.createElement("div");
    setSourceRange(staging, {
        start: 0, contentStart: 0, contentEnd: source.length, end: source.length,
        kind: "root", language, tag: "div"
    });
    const tokens = language === "html" ? htmlTokens(source) : ruleTokens(source, codeRules[language] || []);
    let plain = 0;
    for (const token of tokens) {
        mappedText(staging, source, plain, token.start);
        const node = doc.createElement("span");
        node.className = `code-token code-${token.name}`;
        mappedText(node, source, token.start, token.end);
        setSourceRange(node, {
            start: token.start, contentStart: token.contentStart ?? token.start,
            contentEnd: token.contentEnd ?? token.end, end: token.end,
            kind: "token", language, tag: "span", void: false
        });
        staging.append(node);
        plain = token.end;
    }
    mappedText(staging, source, plain, source.length);
    if (!source || source.endsWith("\n")) {
        const placeholder = doc.createElement("br");
        placeholder.dataset.editorPlaceholder = "";
        setSourceRange(placeholder, {
            start: source.length, contentStart: source.length,
            contentEnd: source.length, end: source.length,
            kind: "placeholder", tag: "br", void: true
        });
        staging.append(placeholder);
    }
    if (liveRoot) reconcileMirror(staging, liveRoot);
    return staging;
}
