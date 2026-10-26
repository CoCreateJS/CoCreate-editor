import { createEditorDetailsCollection } from "../utilities/createEditorDetails.js";

const isWhitespace = character => /[ \t\f]/.test(character || "");

function isEscaped(source, position) {
    let count = 0;
    for (let index = position - 1; index >= 0 && source[index] === "\\"; index--) count++;
    return count % 2 === 1;
}

function getLines(source) {
    const lines = [];
    let start = 0;
    while (start < source.length) {
        let end = start;
        while (end < source.length && source[end] !== "\n" && source[end] !== "\r") end++;
        let breakEnd = end;
        if (source[breakEnd] === "\r" && source[breakEnd + 1] === "\n") breakEnd += 2;
        else if (breakEnd < source.length) breakEnd++;
        lines.push({ start, end, breakEnd, text: source.slice(start, end) });
        start = breakEnd;
    }
    if (!source.length || /[\r\n]$/.test(source))
        lines.push({ start: source.length, end: source.length, breakEnd: source.length, text: "" });
    return lines;
}

function addMark(marks, start, end, syntax, blockKind = "inline", extra = {}) {
    if (end > start) marks.push({ start, end, syntax, blockKind, ...extra });
}

function findCloseRun(line, token, from) {
    let index = line.indexOf(token, from);
    while (index >= 0) {
        if (!isEscaped(line, index)) return index;
        index = line.indexOf(token, index + token.length);
    }
    return -1;
}

function collectSyntax(source, lines) {
    const marks = [];
    const codeRanges = [];
    const lineKinds = [];
    let fence = null;
    let previousContent = false;

    for (const line of lines) {
        const { start, text } = line;
        const openFence = /^ {0,3}([~`]{3,})/.exec(text);
        if (fence) {
            const close = new RegExp("^ {0,3}" + (fence.char === "`" ? "`" : "~") +
                "{" + fence.length + ",}[ \\t]*$").exec(text);
            if (close) {
                const markerStart = text.search(fence.char === "`" ? /`/ : /~/);
                const run = close[0].trimStart();
                addMark(marks, start + markerStart, start + markerStart + run.length, "fence-close", "codeFence");
                fence = null;
                lineKinds.push("codeFence");
            } else {
                codeRanges.push({ start, end: line.end, kind: "codeText", blockKind: "codeFence" });
                lineKinds.push("codeFence");
            }
            previousContent = !!text.trim();
            continue;
        }
        if (openFence) {
            const markerStart = text.indexOf(openFence[1]);
            addMark(marks, start + markerStart, start + markerStart + openFence[1].length, "fence-open", "codeFence");
            lineKinds.push("codeFence");
            fence = { char: openFence[1][0], length: openFence[1].length };
            previousContent = !!text.trim();
            continue;
        }

        let blockKind = "paragraph";
        const heading = /^ {0,3}(#{1,6})(?=[ \t]|$)/.exec(text);
        const quote = /^ {0,3}>/.exec(text);
        const list = /^ {0,3}(?:[-+*]|[0-9]{1,9}[.)])(?=[ \t])/.exec(text);
        const rule = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.exec(text);
        const setext = /^( {0,3})(=+|-+)[ \t]*$/.exec(text);
        if (heading) {
            const offset = text.indexOf(heading[1]);
            addMark(marks, start + offset, start + offset + heading[1].length, "heading", "heading", {
                kind: "element",
                tag: `h${heading[1].length}`
            });
            blockKind = "heading";
        } else if (quote) {
            const offset = text.indexOf(">");
            addMark(marks, start + offset, start + offset + 1, "blockquote", "quote");
            blockKind = "quote";
        } else if (list) {
            const marker = list[0].trim();
            const offset = text.indexOf(marker);
            addMark(marks, start + offset, start + offset + marker.length, "list-marker", "list");
            blockKind = "list";
        } else if (rule) {
            for (let i = 0; i < text.length; i++)
                if (/[*_-]/.test(text[i])) addMark(marks, start + i, start + i + 1, "thematic-break", "rule");
            blockKind = "rule";
        } else if (setext && previousContent) {
            const offset = text.indexOf(setext[2]);
            addMark(marks, start + offset, start + offset + setext[2].length, "setext-heading", "setext");
            blockKind = "setext";
        }
        lineKinds.push(blockKind);

        // Inline code spans are paired first so their contents stay literal.
        const ticks = String.fromCharCode(96);
        let cursor = 0;
        while (cursor < text.length) {
            const open = text.indexOf(ticks, cursor);
            if (open < 0) break;
            let openEnd = open + 1;
            while (text[openEnd] === ticks) openEnd++;
            const run = text.slice(open, openEnd);
            if (isEscaped(text, open)) { cursor = openEnd; continue; }
            const close = findCloseRun(text, run, openEnd);
            if (close < 0) { cursor = openEnd; continue; }
            addMark(marks, start + open, start + openEnd, "code-open", "codeSpan");
            addMark(marks, start + close, start + close + run.length, "code-close", "codeSpan");
            codeRanges.push({ start: start + openEnd, end: start + close, kind: "codeText", blockKind: "codeSpan" });
            cursor = close + run.length;
        }

        const link = /!?\[([^\]]+)\]\(([^)]+)\)/g;
        let match;
        while ((match = link.exec(text))) {
            if (isEscaped(text, match.index)) continue;
            const image = match[0][0] === "!";
            const opening = match.index + (image ? 1 : 0);
            const middle = opening + match[1].length + 1;
            const closing = match.index + match[0].length - 1;
            addMark(marks, start + opening, start + opening + 1, image ? "image-open" : "link-open");
            addMark(marks, start + middle, start + middle + 2, "link-destination-open");
            addMark(marks, start + closing, start + closing + 1, "link-close");
        }

        for (const token of ["**", "__", "~~", "*", "_"]) {
            const stack = [];
            let offset = 0;
            while ((offset = text.indexOf(token, offset)) >= 0) {
                if (isEscaped(text, offset) || codeRanges.some(range =>
                    range.start <= start + offset && start + offset < range.end)) {
                    offset += token.length;
                    continue;
                }
                const before = text[offset - 1] || "";
                const after = text[offset + token.length] || "";
                const canOpen = !!after && !/\s/.test(after);
                const canClose = !!before && !/\s/.test(before);
                if (stack.length && canClose) {
                    const opener = stack.pop();
                    addMark(marks, start + opener, start + opener + token.length,
                        token === "~~" ? "strike-open" : token.length === 2 ? "strong-open" : "emphasis-open");
                    addMark(marks, start + offset, start + offset + token.length,
                        token === "~~" ? "strike-close" : token.length === 2 ? "strong-close" : "emphasis-close");
                } else if (canOpen) stack.push(offset);
                offset += token.length;
            }
        }
        previousContent = !!text.trim();
    }

    marks.sort((a, b) => a.start - b.start || b.end - a.end);
    const unique = [];
    for (const mark of marks) {
        const previous = unique.at(-1);
        if (previous && mark.start < previous.end) continue;
        unique.push(mark);
    }
    codeRanges.sort((a, b) => a.start - b.start);
    return { marks: unique, codeRanges, lineKinds };
}

/** Parse Markdown source into flat, source-preserving editor-detail records. */
export function parseMarkdown(source, editor = null) {
    if (typeof source !== "string") throw new TypeError("Markdown source must be a string.");
    const collection = createEditorDetailsCollection({ editor, dom: false });
    const lines = getLines(source);
    const { marks, codeRanges, lineKinds } = collectSyntax(source, lines);
    let position = 0;
    let lineIndex = 0;
    let markIndex = 0;
    let codeIndex = 0;
    const blockDetails = new Map();

    while (position < source.length) {
        while (lineIndex + 1 < lines.length && position >= lines[lineIndex].breakEnd) lineIndex++;
        while (markIndex < marks.length && marks[markIndex].end <= position) markIndex++;
        while (codeIndex < codeRanges.length && codeRanges[codeIndex].end <= position) codeIndex++;
        const line = lines[lineIndex];
        const mark = marks[markIndex]?.start === position ? marks[markIndex] : null;
        const code = codeRanges[codeIndex]?.start <= position && position < codeRanges[codeIndex]?.end
            ? codeRanges[codeIndex] : null;
        let kind, end, syntax, blockKind, tag;

        if (mark) {
            kind = mark.kind || "delimiter";
            end = mark.end;
            syntax = mark.syntax;
            blockKind = mark.blockKind;
            tag = mark.tag;
        } else if (source[position] === "\r" && source[position + 1] === "\n") {
            kind = "lineBreak";
            end = position + 2;
        } else if (source[position] === "\r" || source[position] === "\n") {
            kind = "lineBreak";
            end = position + 1;
        } else if (source[position] === "\t") {
            kind = "tab";
            end = position + 1;
        } else if (isWhitespace(source[position])) {
            kind = "whitespace";
            end = position + 1;
        } else {
            kind = code?.kind || "text";
            blockKind = code?.blockKind || lineKinds[lineIndex] || "paragraph";
            end = position + 1;
            const nextMark = marks[markIndex]?.start ?? source.length;
            const nextCode = code ? code.end : (codeRanges[codeIndex]?.start ?? source.length);
            while (end < source.length && source[end] !== "\r" && source[end] !== "\n" &&
                source[end] !== "\t" && !isWhitespace(source[end]) &&
                end < nextMark && end < nextCode) end++;
        }

        const detail = collection.add({
            kind,
            nodeType: 3,
            language: "markdown",
            value: source.slice(position, end),
            line: lineIndex + 1,
            column: position - line.start,
            tag,
            parentDetails: blockDetails.get(lineIndex) || null,
            ...(syntax ? { syntax } : {}),
            blockKind: blockKind || lineKinds[lineIndex] || "paragraph"
        });
        if (mark?.kind === "element") blockDetails.set(lineIndex, detail);
        position = end;
    }

    return collection.toArray();
}

export default parseMarkdown;
