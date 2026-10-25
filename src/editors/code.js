import { setSourceRange } from "./utilities/ranges.js";
import { reconcileMirror } from "./utilities/mirror.js";

// Ordered rules: a complete comment or string owns its contents before
// keywords and numbers can match there. Additional languages can supply rules.
export const codeRules = {
    javascript: [
        {
            name: "comment",
            pattern: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y,
            content: raw => [2, raw.startsWith("/*") && raw.endsWith("*/")
                ? raw.length - 2 : raw.length]
        },
        {
            name: "string",
            pattern: /"(?:\\.|[^"\\\n])*(?:"|(?=\n|$))|'(?:\\.|[^'\\\n])*(?:'|(?=\n|$))|`(?:\\.|[^`\\])*(?:`|$)/y,
            content: raw => {
                let slashes = 0;
                for (let i = raw.length - 2; i >= 0 && raw[i] === "\\"; i--)
                    slashes++;
                const closed = raw.length > 1 && raw.at(-1) === raw[0] &&
                    slashes % 2 === 0;
                return [1, raw.length - (closed ? 1 : 0)];
            }
        },
        { name: "keyword", pattern: /\b(?:async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|static|super|switch|this|throw|try|typeof|var|void|while|yield)\b/y },
        { name: "number", pattern: /\b\d+(?:\.\d+)?\b/y }
    ]
};
codeRules.js = codeRules.javascript;

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
    const rules = (codeRules[language] || []).map(rule => ({
        ...rule,
        pattern: new RegExp(rule.pattern.source,
            rule.pattern.flags.replace(/[gy]/g, "") + "y")
    }));
    let position = 0, plain = 0;
    while (position < source.length) {
        let token;
        for (const rule of rules) {
            rule.pattern.lastIndex = position;
            const match = rule.pattern.exec(source);
            if (match?.[0].length) {
                token = { rule, end: position + match[0].length };
                break;
            }
        }
        if (!token) {
            position++;
            continue;
        }
        mappedText(staging, source, plain, position);
        const node = doc.createElement("span");
        node.className = `code-token code-${token.rule.name}`;
        mappedText(node, source, position, token.end);
        const [contentStart, contentEnd] = token.rule.content?.(
            source.slice(position, token.end)) ?? [0, token.end - position];
        setSourceRange(node, {
            start: position, contentStart: position + contentStart,
            contentEnd: position + contentEnd, end: token.end,
            kind: "token", language, tag: "span", void: false
        });
        staging.append(node);
        position = plain = token.end;
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
