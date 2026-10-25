import {
    syntaxRules,
    codeRule,
    blockMatch,
    makeElement,
    applyAttributes
} from "./config.js";
export { syntaxRules, addSyntax, updateSyntax } from "./config.js";
// Text-to-DOM renderer adapted from demo/v2.html. Maps use UTF-16 source offsets.
function closeFence(line, char, min) {
    return new RegExp(
        "^ {0,3}" + (char === "`" ? "`" : "~") + "{" + min + ",}[ \t]*$"
    ).test(line);
}
export function scanBlocks(text) {
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
function inline(parent, text, base, depth = 0, protectedSegment = false) {
    if (depth > 20) {
        mappedText(parent, text, base);
        return;
    }
    if (!protectedSegment) {
        const opener = /`+/g;
        let last = 0,
            match;
        while ((match = opener.exec(text))) {
            let escapes = 0;
            for (let i = match.index - 1; i >= 0 && text[i] === "\\"; i--)
                escapes++;
            if (escapes % 2) continue;
            if (match.index > last)
                inline(
                    parent,
                    text.slice(last, match.index),
                    base + last,
                    depth,
                    true
                );
            const closers = /`+/g;
            closers.lastIndex = opener.lastIndex;
            let close;
            while (
                (close = closers.exec(text)) &&
                close[0].length !== match[0].length
            ) {}
            if (!close) {
                mappedText(parent, text.slice(match.index), base + match.index);
                return;
            }
            const node = makeElement(codeRule, match);
            mappedText(
                node,
                text.slice(opener.lastIndex, close.index),
                base + opener.lastIndex
            );
            node.dataset.mdAfter = base + closers.lastIndex;
            parent.append(node);
            last = closers.lastIndex;
            opener.lastIndex = last;
        }
        if (last < text.length)
            inline(parent, text.slice(last), base + last, depth, true);
        return;
    }
    let position = 0;
    while (position < text.length) {
        let best;
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
                rule.pattern.flags.replace(/[gy]/g, "") + "g"
            );
            re.lastIndex = position;
            let match;
            while ((match = re.exec(text))) {
                if (!match[0].length) {
                    re.lastIndex++;
                    continue;
                }
                let escapes = 0;
                for (let j = match.index - 1; j >= 0 && text[j] === "\\"; j--)
                    escapes++;
                if (escapes % 2) continue;
                if (!best || match.index < best.match.index)
                    best = { rule, match };
                break;
            }
        }
        if (!best) {
            mappedText(parent, text.slice(position), base + position);
            break;
        }
        const { rule, match } = best;
        if (match.index > position)
            mappedText(
                parent,
                text.slice(position, match.index),
                base + position
            );
        const node = makeElement(rule, match);
        applyAttributes(node, rule.attributes?.(match) || {});
        const value = String(rule.content(match));
        const offset = base + match.index + rule.offset(match);
        if (rule.literal) mappedText(node, value, offset);
        else inline(node, value, offset, depth + 1);
        node.dataset.mdAfter = base + match.index + match[0].length;
        parent.append(node);
        position = match.index + match[0].length;
    }
}
export function parseBlock(block) {
    const text = block.text,
        rootLine = text.split("\n")[0];
    let root;
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
        else inline(root, value, md.offset(custom.match));
        return root;
    }
    const setext = text.split("\n");
    if (!h && setext.length >= 2 && !!blockMatch(setext[1], "setext")) {
        const underline = blockMatch(setext[1], "setext");
        root = node(underline.rule.tag, underline.rule, underline.match);
        inline(root, rootLine, 0);
    } else if (h) {
        root = node(heading.rule.tag, heading.rule, h);
        const start = rootLine.indexOf(h[2]);
        inline(root, h[2], start);
    } else if (f) {
        root = node("pre");
        const code = document.createElement("code"),
            lines = text.split("\n");
        let bodyStart = rootLine.length + 1,
            close = lines.length - 1;
        if (close > 0 && closeFence(lines[close], f[1][0], f[1].length)) {
            const body = lines.slice(1, close).join("\n");
            mappedText(code, body, bodyStart);
        } else {
            mappedText(code, lines.slice(1).join("\n"), bodyStart);
        }
        root.append(code);
    } else if (blockMatch(rootLine, "quote")) {
        const quote = blockMatch(rootLine, "quote");
        root = node(quote.rule.tag, quote.rule, quote.match);
        const p = document.createElement("p");
        let offset = 0;
        for (const line of text.split("\n")) {
            const content = blockMatch(line, "quote")?.match[1] ?? line;
            const prefix = line.length - content.length;
            if (offset) p.append(document.createTextNode("\n"));
            inline(p, content, offset + prefix);
            offset += line.length + 1;
        }
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
                contentStart = line.indexOf(m[1]);
            inline(li, m[1], offset + contentStart);
            root.append(li);
            offset += line.length + 1;
        }
    } else if (blockMatch(rootLine, "rule")) {
        const rule = blockMatch(rootLine, "rule");
        root = node(rule.rule.tag, rule.rule, rule.match);
        root.setAttribute("contenteditable", "false");
    } else {
        root = node("p");
        const trailing = (text.match(/\n+$/) || [""])[0].length;
        inline(root, trailing ? text.slice(0, -trailing) : text, 0);
        for (let i = 0; i < trailing; i++) {
            const br = document.createElement("br");
            br.dataset.mdAfter = text.length - trailing + i + 1;
            root.append(br);
        }
    }
    if (!root.matches("p")) {
        const trailing = (text.match(/\n+$/) || [""])[0].length;
        for (let i = 0; i < trailing; i++) {
            const br = document.createElement("br");
            br.dataset.mdAfter = text.length - trailing + i + 1;
            root.append(br);
        }
    }
    if (/\n$/.test(text)) {
        const placeholder = document.createElement("br");
        placeholder.dataset.mdPlaceholder = "";
        root.append(placeholder);
    }
    root.dataset.mdStart = block.start;
    root.dataset.mdEnd = block.end;
    return root;
}
export function renderSource(source) {
    const staging = document.createElement("div");
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
    return staging;
}
