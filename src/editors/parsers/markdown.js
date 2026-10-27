import parseCodeSource, { resolveCodeLanguage } from "./code.js";

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
    if (end <= start) return null;
    const mark = { start, end, syntax, blockKind, ...extra };
    marks.push(mark);
    return mark;
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
    const tableAlignments = new Map();
    const tableLines = new Set();
    const codeFences = [];
    const cells = value => value.trim().replace(/^\|/, "").replace(/\|$/, "")
        .split("|").map(cell => cell.trim());

    for (let index = 0; index + 1 < lines.length; index++) {
        const headerCells = cells(lines[index].text);
        const delimiterCells = cells(lines[index + 1].text);
        if (!lines[index].text.includes("|") || delimiterCells.length < 2 ||
            headerCells.length !== delimiterCells.length ||
            !delimiterCells.every(cell => /^:?-{3,}:?$/.test(cell))) continue;
        tableLines.add(index);
        tableLines.add(index + 1);
        tableAlignments.set(index, delimiterCells.map(cell =>
            cell.startsWith(":") && cell.endsWith(":") ? "center"
                : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : ""));
        let row = index + 2;
        while (row < lines.length && lines[row].text.includes("|")) tableLines.add(row++);
        index = row - 1;
    }
    let fence = null;
    let previousContent = false;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        const { start, text } = line;
        const openFence = /^ {0,3}([~`]{3,})/.exec(text);
        if (fence) {
            const close = new RegExp("^ {0,3}" + (fence.char === "`" ? "`" : "~") +
                "{" + fence.length + ",}[ \\t]*$").exec(text);
            if (close) {
                const markerStart = text.search(fence.char === "`" ? /`/ : /~/);
                const run = close[0].trimStart();
                addMark(marks, start + markerStart, start + markerStart + run.length, "fence-close", "codeFence");
                fence.bodyEnd = start;
                fence = null;
                lineKinds.push("codeFence");
            } else {
                codeRanges.push({ start, end: line.end, kind: "codeText", blockKind: "codeFence",
                    codeLanguage: fence.codeLanguage });
                lineKinds.push("codeFence");
            }
            previousContent = !!text.trim();
            continue;
        }
        if (openFence) {
            const markerStart = text.indexOf(openFence[1]);
            const info = text.slice(markerStart + openFence[1].length).trim();
            const codeLanguage = info.split(/[\t ]+/, 1)[0]?.toLowerCase() || "";
            const openMark = addMark(marks, start + markerStart, start + markerStart + openFence[1].length,
                "fence-open", "codeFence", { codeLanguage, codeInfo: info });
            lineKinds.push("codeFence");
            fence = { char: openFence[1][0], length: openFence[1].length, codeLanguage,
                openMark, bodyStart: line.breakEnd, bodyEnd: source.length };
            codeFences.push(fence);
            previousContent = !!text.trim();
            continue;
        }

        if (tableLines.has(lineIndex)) {
            const delimiterCells = cells(text);
            const isDelimiter = delimiterCells.length > 1 &&
                delimiterCells.every(cell => /^:?-{3,}:?$/.test(cell));
            lineKinds.push(isDelimiter ? "tableDelimiter"
                : lineIndex > 0 && tableLines.has(lineIndex - 1) ? "tableRow" : "tableHeader");
            continue;
        }

        let blockKind = "paragraph";
        // Keep an unfinished heading marker visible while the user is typing.
        // A marker and delimiter become a heading only once content exists.
        const heading = /^ {0,3}(#{1,6})(?=[ \t]+\S)/.exec(text);
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
            const ordered = /^\d/.test(marker);
            blockKind = ordered ? "orderedList" : "unorderedList";
            addMark(marks, start + offset, start + offset + marker.length, "list-marker", blockKind, {
                listTag: ordered ? "ol" : "ul",
                listIndent: offset,
                listStart: ordered ? Number.parseInt(marker, 10) : undefined
            });
        } else if (setext && previousContent) {
            const offset = text.indexOf(setext[2]);
            addMark(marks, start + offset, start + offset + setext[2].length, "setext-heading", "setext", {
                tag: setext[2][0] === "=" ? "h1" : "h2"
            });
            blockKind = "setext";
        } else if (rule) {
            for (let i = 0; i < text.length; i++)
                if (/[*_-]/.test(text[i])) addMark(marks, start + i, start + i + 1, "thematic-break", "rule");
            blockKind = "rule";
        }
        lineKinds.push(blockKind);

        // A trailing backslash or two spaces makes the following source line
        // break visible. Keep both marker and break positions source-backed.
        if (line.breakEnd > line.end && blockKind !== "setext") {
            const hardBreak = /( {2,}|\\)$/.exec(text);
            if (hardBreak) {
                const markerStart = hardBreak.index;
                const markerEnd = markerStart + hardBreak[0].length;
                if (hardBreak[0] === "\\" && isEscaped(text, markerStart)) {
                    // An even run of backslashes is literal, not a break marker.
                } else {
                    addMark(marks, start + markerStart, start + markerEnd,
                        "hardBreakMarker", blockKind);
                    addMark(marks, line.end, line.breakEnd,
                        "hardBreak", blockKind, { kind: "lineBreak" });
                }
            }
        }

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

        const matchedRanges = [];
        const nestedImageLink = /\[(!\[([^\]]*)\]\(([^)]+)\))\]\(([^)]+)\)/g;
        let match;
        while ((match = nestedImageLink.exec(text))) {
            if (isEscaped(text, match.index)) continue;
            const begin = match.index;
            const innerStart = begin + 1;
            const innerOpenEnd = innerStart + 2;
            const innerLabelEnd = innerOpenEnd + match[2].length;
            const innerDestinationOpen = innerLabelEnd + 1;
            const innerDestinationStart = innerDestinationOpen + 2;
            const innerDestinationEnd = innerDestinationStart + match[3].length;
            const outerDestinationOpen = begin + match[1].length + 1;
            const outerDestinationStart = outerDestinationOpen + 2;
            const outerDestinationEnd = outerDestinationStart + match[4].length;
            const imageGroup = `${start + innerStart}:image`;
            const linkGroup = `${start + begin}:link`;
            addMark(marks, start + begin, start + begin + 1, "link-open", "inline", {
                groupId: linkGroup, destination: match[4]
            });
            addMark(marks, start + innerStart, start + innerOpenEnd, "image-open", "inline", {
                groupId: imageGroup, destination: match[3], alt: match[2]
            });
            addMark(marks, start + innerDestinationOpen, start + innerDestinationStart,
                "link-destination-open", "inline", { groupId: imageGroup });
            addMark(marks, start + innerDestinationStart, start + innerDestinationEnd,
                "link-destination", "inline", { groupId: imageGroup });
            addMark(marks, start + innerDestinationEnd, start + innerDestinationEnd + 1,
                "image-close", "inline", { groupId: imageGroup });
            addMark(marks, start + outerDestinationOpen, start + outerDestinationStart,
                "link-destination-open", "inline", { groupId: linkGroup });
            addMark(marks, start + outerDestinationStart, start + outerDestinationEnd,
                "link-destination", "inline", { groupId: linkGroup });
            addMark(marks, start + outerDestinationEnd, start + outerDestinationEnd + 1,
                "link-close", "inline", { groupId: linkGroup });
            matchedRanges.push([begin, outerDestinationEnd + 1]);
        }

        const image = /!\[([^\]]*)\]\(([^)]+)\)/g;
        while ((match = image.exec(text))) {
            if (isEscaped(text, match.index) || matchedRanges.some(([from, to]) => from <= match.index && match.index < to)) continue;
            const opening = match.index;
            const middle = opening + 2 + match[1].length;
            const destinationStart = middle + 2;
            const destination = match[2].trim();
            const groupId = `${start + opening}:image`;
            const metadata = { groupId, destination, alt: match[1] };
            addMark(marks, start + opening, start + opening + 2, "image-open", "inline", metadata);
            addMark(marks, start + middle, start + middle + 2, "link-destination-open", "inline", metadata);
            addMark(marks, start + destinationStart, start + destinationStart + destination.length,
                "link-destination", "inline", metadata);
            addMark(marks, start + destinationStart + destination.length,
                start + destinationStart + destination.length + 1, "image-close", "inline", metadata);
            matchedRanges.push([opening, destinationStart + destination.length + 1]);
        }

        const link = /\[([^\]]+)\]\(([^)]+)\)/g;
        while ((match = link.exec(text))) {
            if (isEscaped(text, match.index) || matchedRanges.some(([from, to]) => from <= match.index && match.index < to)) continue;
            const opening = match.index;
            const middle = opening + match[1].length + 1;
            const destinationStart = middle + 2;
            const destination = match[2].trim();
            const groupId = `${start + opening}:link`;
            const metadata = { groupId, destination };
            addMark(marks, start + opening, start + opening + 1, "link-open", "inline", metadata);
            addMark(marks, start + middle, start + middle + 2, "link-destination-open", "inline", metadata);
            addMark(marks, start + destinationStart, start + destinationStart + destination.length,
                "link-destination", "inline", metadata);
            addMark(marks, start + destinationStart + destination.length,
                start + destinationStart + destination.length + 1, "link-close", "inline", metadata);
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

    if (fence) fence.bodyEnd = source.length;

    marks.sort((a, b) => a.start - b.start || b.end - a.end);
    const unique = [];
    for (const mark of marks) {
        const previous = unique.at(-1);
        if (previous && mark.start < previous.end) continue;
        unique.push(mark);
    }
    codeRanges.sort((a, b) => a.start - b.start);
    return { marks: unique, codeRanges, codeFences, lineKinds, tableAlignments };
}

/** Parse Markdown source into flat, source-preserving records. */
export async function parseMarkdown(source) {
    if (typeof source !== "string") throw new TypeError("Markdown source must be a string.");
    const records = [];
    const collection = { add(data) {
        const record = { ...data, length: data.value.length };
        records.push(record);
        return record;
    } };
    const lines = getLines(source);
    const { marks, codeRanges, codeFences, lineKinds, tableAlignments } = collectSyntax(source, lines);
    const codeTokens = [];
    for (const fence of codeFences) {
        const body = source.slice(fence.bodyStart, fence.bodyEnd);
        const language = resolveCodeLanguage(body, fence.codeLanguage);
        fence.openMark.resolvedCodeLanguage = language;
        const details = await parseCodeSource(body, fence.codeLanguage || undefined);
        let tokenPosition = fence.bodyStart;
        for (const detail of details) {
            codeTokens.push({ start: tokenPosition, end: tokenPosition + detail.length,
                token: detail.token, language });
            tokenPosition += detail.length;
        }
    }
    let position = 0;
    let lineIndex = 0;
    let markIndex = 0;
    let codeIndex = 0;
    let codeTokenIndex = 0;
    const blockDetails = new Map();

    while (position < source.length) {
        while (lineIndex + 1 < lines.length && position >= lines[lineIndex].breakEnd) lineIndex++;
        while (markIndex < marks.length && marks[markIndex].end <= position) markIndex++;
        while (codeIndex < codeRanges.length && codeRanges[codeIndex].end <= position) codeIndex++;
        while (codeTokenIndex < codeTokens.length && codeTokens[codeTokenIndex].end <= position) codeTokenIndex++;
        const line = lines[lineIndex];
        const mark = marks[markIndex]?.start === position ? marks[markIndex] : null;
        const code = codeRanges[codeIndex]?.start <= position && position < codeRanges[codeIndex]?.end
            ? codeRanges[codeIndex] : null;
        const codeToken = codeTokens[codeTokenIndex]?.start <= position &&
            position < codeTokens[codeTokenIndex]?.end ? codeTokens[codeTokenIndex] : null;
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
            const nextCodeToken = codeToken ? codeToken.end : (codeTokens[codeTokenIndex]?.start ?? source.length);
            while (end < source.length && source[end] !== "\r" && source[end] !== "\n" &&
                source[end] !== "\t" && !isWhitespace(source[end]) &&
                end < nextMark && end < nextCode && end < nextCodeToken) end++;
        }

        const detail = collection.add({
            kind,
            nodeType: 3,
            language: "markdown",
            value: source.slice(position, end),
            line: lineIndex + 1,
            column: position - line.start,
            tag,
            parentNode: blockDetails.get(lineIndex) || null,
            ...(syntax ? { syntax } : {}),
            ...(mark ? Object.fromEntries(Object.entries(mark).filter(([key]) =>
                !["start", "end", "syntax", "blockKind", "kind", "tag"].includes(key))) : {}),
            ...(tableAlignments.has(lineIndex) ? { tableAlignments: tableAlignments.get(lineIndex) } : {}),
            blockKind: blockKind || lineKinds[lineIndex] || "paragraph",
            ...(code ? { codeLanguage: code.codeLanguage } : {}),
            ...(codeToken?.token ? { token: codeToken.token } : {}),
            ...(codeToken ? { resolvedCodeLanguage: codeToken.language } : {})
        });
        if (mark?.kind === "element") blockDetails.set(lineIndex, detail);
        position = end;
    }

    return records;
}

export default parseMarkdown;
