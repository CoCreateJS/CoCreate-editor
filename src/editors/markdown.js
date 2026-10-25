import {
    syntaxRules,
    hasMarkdownContent,
    codeRule,
    blockMatch,
    makeElement,
    applyAttributes
} from "./utilities/config.js";
import { setSourceRange } from "./utilities/ranges.js";
import { reconcileMirror } from "./utilities/mirror.js";
// Text-to-DOM renderer adapted from demo/v2.html. Maps use UTF-16 source offsets.
function closeFence(line, char, min) {
    return new RegExp(
        "^ {0,3}" + (char === "`" ? "`" : "~") + "{" + min + ",}[ \t]*$"
    ).test(line);
}
function scanBlocks(text) {
    const lines = text.split("\n"),
        starts = [];
    let p = 0;
    for (const line of lines) {
        starts.push(p);
        p += line.length + 1;
    }
    const out = [],
        blank = (s) => /^\s*$/.test(s),
        atx = (s) => !!blockMatch(s, "heading"),
        quote = (s) => !!blockMatch(s, "quote"),
        bullet = (s) => blockMatch(s, "list")?.rule.tag === "ul",
        ordered = (s) => blockMatch(s, "list")?.rule.tag === "ol",
        setext = (s) => !!blockMatch(s, "setext");
    let lastContent = lines.length - 1;
    while (lastContent >= 0 && blank(lines[lastContent])) lastContent--;
    let i = 0;
    while (i < lines.length) {
        if (blank(lines[i])) {
            i++;
            continue;
        }
        const start = starts[i],
            f = blockMatch(lines[i], "fence")?.match;
        if (f) {
            const c = f[1][0],
                n = f[1].length;
            i++;
            while (i < lines.length && !closeFence(lines[i], c, n)) i++;
            if (i < lines.length) i++;
        } else if (atx(lines[i]) || !!blockMatch(lines[i], "rule")) i++;
        else if (
            blockMatch(lines[i]) &&
            !["quote", "list", "setext"].includes(
                blockMatch(lines[i]).rule.markdown.kind
            )
        )
            i++;
        else if (quote(lines[i])) {
            while (i < lines.length && quote(lines[i])) i++;
        } else if (bullet(lines[i])) {
            while (i < lines.length && bullet(lines[i])) i++;
        } else if (ordered(lines[i])) {
            while (i < lines.length && ordered(lines[i])) i++;
        } else {
            i++;
            while (i < lines.length && !blank(lines[i])) {
                if (setext(lines[i])) {
                    i++;
                    break;
                }
                if (
                    atx(lines[i]) ||
                    !!blockMatch(lines[i], "rule") ||
                    !!blockMatch(lines[i], "fence") ||
                    quote(lines[i]) ||
                    bullet(lines[i]) ||
                    ordered(lines[i]) ||
                    (blockMatch(lines[i]) &&
                        !blockMatch(lines[i]).rule.markdown.kind)
                )
                    break;
                i++;
            }
        }
        const hasLaterContent = i <= lastContent;
        const end = !hasLaterContent
            ? text.length
            : i < lines.length
              ? starts[i - 1] + lines[i - 1].length
              : text.length;
        out.push({ text: text.slice(start, end), start, end });
    }
    return out;
}
function mappedText(parent, text, localStart) {
    const n = document.createTextNode(text);
    n._mdMap = Array.from({ length: text.length }, (_, i) => localStart + i);
    parent.append(n);
    return n;
}
function markdownRange(node, start, contentStart, contentEnd, end, blockStart = 0) {
    const sourceStart = blockStart + start;
    const sourceEnd = blockStart + end;
    const voidNode = /^(?:BR|HR)$/.test(node.tagName);
    setSourceRange(node, {
        start: sourceStart,
        contentStart: blockStart + contentStart,
        contentEnd: blockStart + contentEnd,
        end: sourceEnd,
        kind: "element", language: "markdown", tag: node.localName,
        void: voidNode
    });
    if (voidNode) {
        node.dataset.sourceStart = sourceStart;
        node.dataset.sourceAfter = sourceEnd;
        node.dataset.sourceVoid = "";
    }
}
// Text maps remain block-local for selection compatibility. Element ranges
// receive absolute source coordinates as each node is constructed.
function setBlockRange(root, block, contentStart = 0, contentEnd = block.text.length) {
    markdownRange(root, block.start, block.start + contentStart,
        block.start + contentEnd, block.end);
    return root;
}
function escaped(text, position) {
    let slashes = 0;
    for (let i = position - 1; i >= 0 && text[i] === "\\"; i--)
        slashes++;
    return slashes % 2 === 1;
}
function nextDelimiter(text, delimiter, from) {
    let position = text.indexOf(delimiter, from);
    while (position >= 0 && escaped(text, position))
        position = text.indexOf(delimiter, position + delimiter.length);
    return position;
}
// Keep source length unchanged so regex matches still use canonical offsets.
// Syntax inside a complete code span is data, even when an outer rule spans it.
function maskCodeSyntax(text) {
    const masked = text.split("");
    const ticks = /`+/g;
    let open;
    while ((open = ticks.exec(text))) {
        if (escaped(text, open.index)) continue;
        const closers = /`+/g;
        closers.lastIndex = ticks.lastIndex;
        let close;
        while ((close = closers.exec(text)) &&
            (close[0].length !== open[0].length || escaped(text, close.index))) {}
        if (!close) break;
        for (let i = ticks.lastIndex; i < close.index; i++)
            if (/[*_\[\]()]/.test(text[i])) masked[i] = "\uE000";
        ticks.lastIndex = closers.lastIndex;
    }
    return masked.join("");
}
function sourceMatch(match, source) {
    const original = Array.from(match, (_, i) =>
        match.indices[i] ? source.slice(...match.indices[i]) : undefined);
    original.index = match.index;
    original.input = source;
    if (match.indices.groups)
        original.groups = Object.fromEntries(Object.entries(match.indices.groups)
            .map(([name, range]) => [name, range ? source.slice(...range) : undefined]));
    return original;
}
function wholeDelimiter(match, text, rule) {
    if (!["strong", "emphasis"].includes(rule.name)) return true;
    const char = match[0][0], end = match.index + match[0].length;
    const width = rule.name === "strong" ? 2 : 1;
    // A surviving fragment of ** must not be reinterpreted as a single * pair.
    return !escaped(text, end - width) &&
        text[match.index - 1] !== char && text[end] !== char &&
        (rule.name !== "emphasis" || match[0][1] !== char);
}
// An unfinished outer construct owns its remaining source as literal text.
// Completed constructs before it can still render normally.
function unfinishedInlineStart(text, from) {
    const openers = /\*\*|__|\*|_|\[[^\]]*\]\(/g;
    openers.lastIndex = from;
    let match;
    while ((match = openers.exec(text))) {
        if (escaped(text, match.index)) continue;
        if (match[0].length === 1 && (match[0] === "*" || match[0] === "_") &&
            (/\s/.test(text[openers.lastIndex] ?? "") ||
                /[\p{L}\p{N}]/u.test(text[match.index - 1] ?? "")))
            continue;
        const closer = match[0][0] === "[" ? ")" : match[0];
        if (nextDelimiter(text, closer, openers.lastIndex) < 0) return match.index;
    }
    return text.length;
}
function inline(parent, text, base, blockStart, depth = 0) {
    if (depth > 20) {
        mappedText(parent, text, base);
        return;
    }
    const matchingText = maskCodeSyntax(text);
    let position = 0;
    while (position < text.length) {
        let literalStart = unfinishedInlineStart(matchingText, position);
        let best;
        const ticks = /`+/g;
        ticks.lastIndex = position;
        let opener;
        while ((opener = ticks.exec(text))) {
            if (escaped(text, opener.index)) continue;
            const closers = /`+/g;
            closers.lastIndex = ticks.lastIndex;
            let close;
            while ((close = closers.exec(text)) &&
                (close[0].length !== opener[0].length || escaped(text, close.index))) {}
            if (!close) {
                literalStart = Math.min(literalStart, opener.index);
                break;
            }
            const value = text.slice(ticks.lastIndex, close.index);
            if (hasMarkdownContent(value))
                best = {
                    rule: codeRule, match: opener, value,
                    offset: ticks.lastIndex, end: closers.lastIndex
                };
            ticks.lastIndex = closers.lastIndex;
            if (best) break;
        }
        for (const definition of syntaxRules) {
            if (
                !definition.markdown ||
                definition === codeRule ||
                definition.markdown.scope === "block"
            )
                continue;
            const rule = { ...definition, ...definition.markdown };
            const re = new RegExp(
                rule.pattern.source,
                rule.pattern.flags.replace(/[gyd]/g, "") + "gd"
            );
            re.lastIndex = position;
            let candidate;
            while ((candidate = re.exec(matchingText))) {
                const match = sourceMatch(candidate, text);
                if (!match[0].length) {
                    re.lastIndex++;
                    continue;
                }
                if (escaped(text, match.index)) continue;
                if (!wholeDelimiter(match, text, definition)) continue;
                if (definition.name === "link" &&
                    escaped(text, match.index + match[0].length - 1)) continue;
                const value = String(rule.content(match) ?? "");
                if (!hasMarkdownContent(value)) continue;
                if (match.index >= literalStart) break;
                if (!best || match.index < best.match.index)
                    best = { rule, match, value };
                break;
            }
        }
        if (!best || best.match.index >= literalStart) {
            mappedText(parent, text.slice(position), base + position);
            break;
        }
        const { rule, match, value } = best;
        if (match.index > position)
            mappedText(
                parent,
                text.slice(position, match.index),
                base + position
            );
        const node = makeElement(rule, match);
        if (rule !== codeRule)
            applyAttributes(node, rule.attributes?.(match) || {});
        const offset = rule === codeRule
            ? base + best.offset
            : base + match.index + rule.offset(match);
        if (rule.literal) mappedText(node, value, offset);
        else inline(node, value, offset, blockStart, depth + 1);
        const end = base + (best.end ?? match.index + match[0].length);
        node.dataset.mdAfter = end;
        markdownRange(node, base + match.index, offset,
            offset + value.length, end, blockStart);
        parent.append(node);
        position = end - base;
    }
}
function parseBlock(block) {
    const text = block.text,
        rootLine = text.split("\n")[0];
    let root, contentStart = 0, contentEnd = text.length;
    const node = (tag, definition, match) => {
        const x = definition
            ? makeElement(definition, match)
            : document.createElement(tag);
        if (definition)
            applyAttributes(x, definition.markdown.attributes?.(match) || {});
        x.classList.add("md-block");
        x.dataset.mdStart = block.start;
        x.dataset.mdEnd = block.end;
        return x;
    };
    const heading = blockMatch(rootLine, "heading");
    const h = heading?.match;
    const f = blockMatch(rootLine, "fence")?.match;
    const custom = blockMatch(rootLine);
    if (custom && !custom.rule.markdown.kind) {
        const root = makeElement(custom.rule, custom.match),
            md = custom.rule.markdown;
        root.dataset.mdStart = block.start;
        root.dataset.mdEnd = block.end;
        applyAttributes(root, md.attributes?.(custom.match) || {});
        const value = String(md.content(custom.match));
        if (custom.rule.literal)
            mappedText(root, value, md.offset(custom.match));
        else inline(root, value, md.offset(custom.match), block.start);
        return setBlockRange(root, block, md.offset(custom.match),
            md.offset(custom.match) + value.length);
    }
    const setext = text.split("\n");
    if (!h && setext.length >= 2 && !!blockMatch(setext[1], "setext")) {
        const underline = blockMatch(setext[1], "setext");
        root = node(underline.rule.tag, underline.rule, underline.match);
        contentEnd = rootLine.length;
        inline(root, rootLine, 0, block.start);
    } else if (h) {
        root = node(heading.rule.tag, heading.rule, h);
        const start = h.index + h[0].length - h[2].length;
        contentStart = start;
        contentEnd = start + h[2].length;
        inline(root, h[2], start, block.start);
    } else if (f) {
        const lines = text.split("\n"), bodyStart = rootLine.length + 1;
        const relativeClose = lines.slice(1).findIndex(
            (line) => closeFence(line, f[1][0], f[1].length)
        );
        const close = relativeClose < 0 ? -1 : relativeClose + 1;
        const body = close < 0 ? "" : lines.slice(1, close).join("\n");
        if (close < 0 || !hasMarkdownContent(body)) {
            // An incomplete fence protects its contents from every other rule.
            root = node("p");
            mappedText(root, text, 0);
        } else {
            root = node("pre");
            const code = document.createElement("code");
            contentStart = bodyStart;
            contentEnd = bodyStart + body.length;
            mappedText(code, body, bodyStart);
            markdownRange(code, 0, contentStart, contentEnd,
                lines.slice(0, close + 1).join("\n").length, block.start);
            const language = rootLine.slice(f[0].length).trim();
            if (/^[\w-]+$/.test(language)) code.classList.add(`language-${language}`);
            root.append(code);
        }
    } else if (blockMatch(rootLine, "quote")) {
        const quote = blockMatch(rootLine, "quote");
        root = node(quote.rule.tag, quote.rule, quote.match);
        const p = document.createElement("p");
        let offset = 0;
        for (const line of text.split("\n")) {
            const content = blockMatch(line, "quote")?.match[1] ?? line;
            const prefix = line.length - content.length;
            if (offset) mappedText(p, "\n", offset - 1);
            inline(p, content, offset + prefix, block.start);
            offset += line.length + 1;
        }
        markdownRange(p, 0, rootLine.length - quote.match[1].length,
            text.length, text.length, block.start);
        root.append(p);
    } else if (blockMatch(rootLine, "list") && !blockMatch(rootLine, "rule")) {
        const list = blockMatch(rootLine, "list"),
            tag = list.rule.tag;
        root = node(tag, list.rule, list.match);
        let offset = 0;
        for (const line of text.split("\n")) {
            const m = new RegExp(list.rule.markdown.pattern.source).exec(line);
            if (!m) continue;
            const li = document.createElement("li"),
                contentStart = m.index + m[0].length - m[1].length;
            inline(li, m[1], offset + contentStart, block.start);
            markdownRange(li, offset, offset + contentStart,
                offset + line.length, offset + line.length, block.start);
            root.append(li);
            offset += line.length + 1;
        }
    } else if (blockMatch(rootLine, "rule")) {
        const rule = blockMatch(rootLine, "rule");
        root = node(rule.rule.tag, rule.rule, rule.match);
        contentStart = contentEnd = rootLine.length;
        root.setAttribute("contenteditable", "false");
    } else {
        root = node("p");
        const trailing = (text.match(/\n+$/) || [""])[0].length;
        inline(root, trailing ? text.slice(0, -trailing) : text, 0, block.start);
        for (let i = 0; i < trailing; i++) {
            const br = document.createElement("br");
            br.dataset.mdAfter = text.length - trailing + i + 1;
            markdownRange(br, text.length - trailing + i,
                text.length - trailing + i, text.length - trailing + i + 1,
                text.length - trailing + i + 1, block.start);
            root.append(br);
        }
    }
    if (!root.matches("p")) {
        const trailing = (text.match(/\n+$/) || [""])[0].length;
        for (let i = 0; i < trailing; i++) {
            const br = document.createElement("br");
            br.dataset.mdAfter = text.length - trailing + i + 1;
            markdownRange(br, text.length - trailing + i,
                text.length - trailing + i, text.length - trailing + i + 1,
                text.length - trailing + i + 1, block.start);
            root.append(br);
        }
    }
    if (/\n$/.test(text)) {
        const placeholder = document.createElement("br");
        placeholder.dataset.editorPlaceholder = "";
        markdownRange(placeholder, text.length, text.length, text.length,
            text.length, block.start);
        root.append(placeholder);
    }
    root.dataset.mdStart = block.start;
    root.dataset.mdEnd = block.end;
    return setBlockRange(root, block, contentStart, contentEnd);
}
export default function createMarkdownDOM(source, liveRoot) {
    const staging = document.createElement("div");
    setSourceRange(staging, {
        start: 0, contentStart: 0, contentEnd: source.length, end: source.length,
        kind: "root", language: "markdown", tag: "div"
    });
    const blocks = scanBlocks(source);
    if (!blocks.length && source)
        staging.append(
            parseBlock({ text: source, start: 0, end: source.length })
        );
    else {
        if (blocks[0]?.start)
            staging.append(
                parseBlock({
                    text: source.slice(0, blocks[0].start),
                    start: 0,
                    end: blocks[0].start
                })
            );
        for (const block of blocks) staging.append(parseBlock(block));
    }
    if (liveRoot) reconcileMirror(staging, liveRoot);
    return staging;
}

