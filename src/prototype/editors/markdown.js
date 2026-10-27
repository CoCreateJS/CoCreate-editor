import parseMarkdown from "./parsers/markdown.js";
import { bindEditorDetailsLiveDOM } from "./utilities/createEditorDetails.js";

const renderedState = new WeakMap();
const isVisibleText = detail => ["text", "codeText", "whitespace", "tab", "lineBreak"].includes(detail.kind);

/** Build Markdown editor state from source and its flat detail records. */
export async function createMarkdownEditor(source, editor = null) {
    const details = await parseMarkdown(source, editor);
    return { type: "markdown", source, details, editor,
        update: updateMarkdownEditorDetails };
}

function appendSourceText(parent, detail) {
    const text = parent.ownerDocument.createTextNode(detail.value);
    if (detail.token) {
        const span = parent.ownerDocument.createElement("span");
        span.className = `token-${detail.token}`;
        span.append(text);
        parent.append(span);
    } else parent.append(text);
    bindEditorDetailsLiveDOM(detail, text);
}

function appendInline(parent, records, heading = false, listItem = false, lineBreakMode = "skip") {
    const stack = [parent];
    let skipHeadingSpace = heading;
    let listMarkerSeen = false;
    let skipListSpace = false;
    let skipQuoteSpace = false;
    let skipImageText = false;
    for (const detail of records) {
        const syntax = detail.syntax;
        if (syntax === "image-close") { skipImageText = false; continue; }
        if (skipImageText) continue;
        if (detail.kind === "element" && /^h[1-6]$/.test(detail.tag || "")) {
            bindEditorDetailsLiveDOM(detail, parent);
            continue;
        }
        if (skipHeadingSpace && detail.kind === "whitespace") {
            skipHeadingSpace = false;
            continue;
        }
        if (listItem && detail.kind === "whitespace" &&
            (!listMarkerSeen || skipListSpace)) {
            if (listMarkerSeen) skipListSpace = false;
            continue;
        }
        if (skipQuoteSpace && detail.kind === "whitespace") {
            skipQuoteSpace = false;
            continue;
        }
        if (detail.kind === "delimiter" && syntax) {
            if (syntax === "list-marker") {
                listMarkerSeen = true;
                skipListSpace = true;
                continue;
            }
            if (syntax === "blockquote") {
                skipQuoteSpace = true;
                continue;
            }
            if (syntax === "image-open") {
                const image = parent.ownerDocument.createElement("img");
                image.alt = detail.alt || "";
                const safeSource = safeMarkdownUrl(detail.destination, parent.ownerDocument, true);
                if (safeSource) image.src = safeSource;
                stack.at(-1).append(image);
                skipImageText = true;
                continue;
            }
            if (syntax === "link-open") {
                const anchor = parent.ownerDocument.createElement("a");
                const safeHref = safeMarkdownUrl(detail.destination, parent.ownerDocument);
                if (safeHref) anchor.href = safeHref;
                stack.at(-1).append(anchor);
                stack.push(anchor);
                continue;
            }
            if (syntax === "link-close") {
                if (stack.length > 1 && stack.at(-1).localName === "a") stack.pop();
                continue;
            }
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
        if (detail.kind === "lineBreak") {
            if (lineBreakMode !== "skip") {
                if (detail.syntax === "hardBreak" || lineBreakMode === "code") {
                    if (lineBreakMode === "code") {
                        appendSourceText(stack.at(-1), detail);
                    } else {
                        const br = parent.ownerDocument.createElement("br");
                        stack.at(-1).append(br);
                        bindEditorDetailsLiveDOM(detail, br);
                    }
                } else {
                    const text = parent.ownerDocument.createTextNode(" ");
                    stack.at(-1).append(text);
                    bindEditorDetailsLiveDOM(detail, text);
                }
            }
            continue;
        }
        if (["blockquote", "list-marker", "link-destination-open", "link-destination",
            "hardBreakMarker", "link-close", "image-open", "image-close",
            "setext-heading", "thematic-break", "fence-open", "fence-close"].includes(syntax)) continue;
        if (!["text", "codeText", "whitespace", "tab"].includes(detail.kind)) continue;
        appendSourceText(stack.at(-1), detail);
    }
}

function safeMarkdownUrl(value, ownerDocument, image = false) {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
        const url = new URL(value, ownerDocument.baseURI);
        const allowed = image ? ["http:", "https:"] : ["http:", "https:", "mailto:", "tel:"];
        if (!allowed.includes(url.protocol)) return "";
        // Preserve relative paths in the DOM; URL resolution above is only a
        // protocol safety check.
        return value;
    } catch { return ""; }
}

function sourceLine(records) {
    return records.map(detail => detail.value).join("");
}

function tableCells(line) {
    return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
}

function tableCellRanges(line) {
    let start = line.search(/\S/);
    let end = line.length;
    while (end > start && /\s/.test(line[end - 1])) end--;
    if (line[start] === "|") start++;
    if (line[end - 1] === "|") end--;
    const ranges = [];
    let cellStart = start;
    for (let index = start; index <= end; index++) {
        if (index !== end && line[index] !== "|") continue;
        let left = cellStart;
        let right = index;
        while (left < right && /\s/.test(line[left])) left++;
        while (right > left && /\s/.test(line[right - 1])) right--;
        ranges.push({ start: left, end: right });
        cellStart = index + 1;
    }
    return ranges;
}

function appendTableCellText(cell, records, lineStart, range, starts, textMappings) {
    for (const detail of records) {
        const detailStart = starts.get(detail) - lineStart;
        const detailEnd = detailStart + detail.length;
        const from = Math.max(detailStart, range.start);
        const to = Math.min(detailEnd, range.end);
        if (from >= to || !isVisibleText(detail)) continue;
        const text = cell.ownerDocument.createTextNode(
            detail.value.slice(from - detailStart, to - detailStart));
        cell.append(text);
        textMappings.push({ node: text, detail, sourceStart: lineStart + from, length: to - from });
    }
}

function renderTable(root, headerRecords, delimiterRecords, bodyRows, starts, textMappings) {
    const document = root.ownerDocument;
    const table = document.createElement("table");
    const head = document.createElement("thead");
    const headerRow = document.createElement("tr");
    const headerSource = sourceLine(headerRecords);
    const headings = tableCells(headerSource);
    const headerRanges = tableCellRanges(headerSource);
    const alignments = headerRecords[0]?.tableAlignments || [];
    headings.forEach((value, index) => {
        const cell = document.createElement("th");
        appendTableCellText(cell, headerRecords, starts.get(headerRecords[0]), headerRanges[index], starts, textMappings);
        if (alignments[index]) cell.style.textAlign = alignments[index];
        headerRow.append(cell);
    });
    head.append(headerRow);
    table.append(head);
    const body = document.createElement("tbody");
    for (const records of bodyRows) {
        const row = document.createElement("tr");
        const rowSource = sourceLine(records);
        const values = tableCells(rowSource);
        const ranges = tableCellRanges(rowSource);
        values.forEach((value, index) => {
            const cell = document.createElement("td");
            appendTableCellText(cell, records, starts.get(records[0]), ranges[index], starts, textMappings);
            if (alignments[index]) cell.style.textAlign = alignments[index];
            row.append(cell);
        });
        body.append(row);
    }
    if (bodyRows.length) table.append(body);
    root.append(table);
}

const listKinds = new Set(["orderedList", "unorderedList"]);

function renderList(root, lineEntries, startIndex) {
    const [firstLine, firstRecords] = lineEntries[startIndex];
    const firstMarker = firstRecords.find(detail => detail.syntax === "list-marker");
    const baseIndent = firstMarker?.listIndent || 0;
    const baseKind = firstMarker?.blockKind || firstRecords.find(detail => listKinds.has(detail.blockKind))?.blockKind;
    const list = root.ownerDocument.createElement(baseKind === "orderedList" ? "ol" : "ul");
    if (baseKind === "orderedList" && Number.isInteger(firstMarker?.listStart) && firstMarker.listStart !== 1)
        list.start = firstMarker.listStart;

    let index = startIndex;
    let previousLine = firstLine - 1;
    let lastItem = null;
    while (index < lineEntries.length) {
        const [lineNumber, records] = lineEntries[index];
        const marker = records.find(detail => detail.syntax === "list-marker");
        const kind = marker?.blockKind || records.find(detail => listKinds.has(detail.blockKind))?.blockKind;
        if (!marker || !listKinds.has(kind) || lineNumber !== previousLine + 1) break;
        const indent = marker.listIndent || 0;
        if (indent < baseIndent) break;
        if (indent > baseIndent) {
            if (!lastItem) break;
            const child = renderList(lastItem, lineEntries, index);
            lastItem.append(child.node);
            index = child.nextIndex;
            previousLine = lineEntries[index - 1][0];
            continue;
        }
        if (kind !== baseKind) break;

        const item = root.ownerDocument.createElement("li");
        appendInline(item, records, false, true);
        list.append(item);
        lastItem = item;
        previousLine = lineNumber;
        index++;
    }
    return { node: list, nextIndex: index };
}

/** Render source-backed Markdown details directly inside the editable host. */
export function renderEditor(element, source, details) {
    if (!element?.ownerDocument) {
        if (element) renderedState.delete(element);
        return;
    }
    const root = element.ownerDocument.createElement("div");
    const lines = new Map();
    const starts = new WeakMap();
    let sourcePosition = 0;
    for (const detail of details) {
        starts.set(detail, sourcePosition);
        sourcePosition += detail.length;
        if (!lines.has(detail.line)) lines.set(detail.line, []);
        lines.get(detail.line).push(detail);
    }

    const lineEntries = [...lines.entries()];
    const textMappings = [];
    let fenced = false, codeBlock;
    for (let lineIndex = 0; lineIndex < lineEntries.length; lineIndex++) {
        const [lineNumber, records] = lineEntries[lineIndex];
        const marker = records.find(detail => detail.syntax === "fence-open");
        const closeFence = records.some(detail => detail.syntax === "fence-close");
        const heading = records.find(detail => detail.kind === "element" && /^h[1-6]$/.test(detail.tag || ""));
        const blockKind = records.find(detail => detail.blockKind)?.blockKind || "paragraph";
        const hasContent = records.some(detail => ["text", "codeText"].includes(detail.kind));

        if (marker) {
            fenced = true;
            codeBlock = root.ownerDocument.createElement("pre");
            const code = root.ownerDocument.createElement("code");
            const language = marker.resolvedCodeLanguage || marker.codeLanguage;
            if (language) {
                code.dataset.language = language;
                code.classList.add(`language-${language}`);
            }
            codeBlock.append(code);
            root.append(codeBlock);
            continue;
        }
        if (fenced) {
            if (!closeFence && codeBlock) appendInline(codeBlock.firstChild, records, false, false, "code");
            if (closeFence) fenced = false;
            continue;
        }
        if (blockKind === "tableHeader") {
            const delimiter = lineEntries[lineIndex + 1]?.[1];
            if (delimiter?.some(detail => detail.blockKind === "tableDelimiter")) {
                const bodyRows = [];
                lineIndex++;
                let expectedLine = lineNumber + 2;
                while (lineEntries[lineIndex + 1]?.[0] === expectedLine &&
                    lineEntries[lineIndex + 1][1].some(detail => detail.blockKind === "tableRow")) {
                    bodyRows.push(lineEntries[++lineIndex][1]);
                    expectedLine++;
                }
                renderTable(root, records, delimiter, bodyRows, starts, textMappings);
                continue;
            }
        }
        if (blockKind === "unorderedList" || blockKind === "orderedList") {
            const result = renderList(root, lineEntries, lineIndex);
            root.append(result.node);
            lineIndex = result.nextIndex - 1;
            continue;
        }
        if (blockKind === "quote") {
            const quote = root.ownerDocument.createElement("blockquote");
            const paragraph = root.ownerDocument.createElement("p");
            const quoteRecords = [...records];
            while (lineEntries[lineIndex + 1]?.[0] === lineEntries[lineIndex][0] + 1 &&
                lineEntries[lineIndex + 1][1].some(detail => detail.blockKind === "quote")) {
                quoteRecords.push(...lineEntries[++lineIndex][1]);
            }
            const last = quoteRecords.at(-1);
            if (last?.kind === "lineBreak" && last.syntax !== "hardBreak") quoteRecords.pop();
            appendInline(paragraph, quoteRecords, false, false, "paragraph");
            quote.append(paragraph);
            root.append(quote);
            continue;
        }
        if (blockKind === "rule") {
            root.append(root.ownerDocument.createElement("hr"));
            continue;
        }
        if (blockKind === "setext") continue;
        if (!hasContent && !heading) continue;

        let paragraphRecords = records;
        let setextTag = null;
        const nextLine = lineEntries[lineIndex + 1];
        if (nextLine?.[0] === lineNumber + 1 &&
            nextLine[1].some(detail => detail.blockKind === "setext")) {
            setextTag = nextLine[1].find(detail => detail.tag === "h1" || detail.tag === "h2")?.tag || "h2";
            paragraphRecords = records.filter(detail => detail.kind !== "lineBreak");
            lineIndex++;
        } else if (blockKind === "paragraph") {
            paragraphRecords = [...records];
            while (lineEntries[lineIndex + 1]?.[0] === lineEntries[lineIndex][0] + 1 &&
                lineEntries[lineIndex + 1][1].some(detail => detail.blockKind === "paragraph") &&
                lineEntries[lineIndex + 1][1].some(detail => ["text", "codeText"].includes(detail.kind))) {
                paragraphRecords.push(...lineEntries[++lineIndex][1]);
            }
            const finalDetail = paragraphRecords.at(-1);
            if (finalDetail?.kind === "lineBreak" && finalDetail.syntax !== "hardBreak")
                paragraphRecords.pop();
        }
        const tag = heading?.tag || setextTag || (blockKind === "quote" ? "blockquote" : "p");
        const block = root.ownerDocument.createElement(tag);
        const content = block;
        appendInline(content, paragraphRecords, !!heading, false,
            blockKind === "paragraph" && !heading ? "paragraph" : "skip");
        if (!hasContent && heading) {
            const placeholder = root.ownerDocument.createElement("br");
            placeholder.setAttribute("data-markdown-placeholder", "");
            content.append(placeholder);
        }
        root.append(block);
    }
    if (source.endsWith("\n")) {
        const trailingBreak = [...details].reverse().find(detail => detail.kind === "lineBreak");
        const placeholder = root.ownerDocument.createElement("p");
        placeholder.setAttribute("data-markdown-placeholder-block", "");
        const line = root.ownerDocument.createElement("br");
        line.setAttribute("data-markdown-placeholder", "");
        placeholder.append(line);
        root.append(placeholder);
        if (trailingBreak) bindEditorDetailsLiveDOM(trailingBreak, placeholder);
    }
    element.replaceChildren(...root.childNodes);

    const textDetails = new WeakMap();
    const nodeDetails = new WeakMap();
    for (const detail of details) {
        if (detail.liveDOM) {
            nodeDetails.set(detail.liveDOM, detail);
            if (detail.liveDOM.nodeType === 3 && isVisibleText(detail))
                textMappings.push({ node: detail.liveDOM, detail,
                    sourceStart: starts.get(detail), length: detail.length });
        }
    }
    for (const mapping of textMappings) textDetails.set(mapping.node, mapping);
    textMappings.sort((a, b) => a.sourceStart - b.sourceStart);
    renderedState.set(element, { source, details, starts, textDetails, textMappings, nodeDetails });
}

function inlineSource(node) {
    if (node.nodeType === 3) return node.data;
    const content = [...node.childNodes].map(inlineSource).join("");
    switch (node.localName) {
        case "strong": case "b": return `**${content}**`;
        case "em": case "i": return `*${content}*`;
        case "del": case "s": return `~~${content}~~`;
        case "code": return `\`${content}\``;
        case "br": return node.hasAttribute("data-markdown-placeholder") ? "" : "\n";
        default: return content;
    }
}

/** Serialize the editable Markdown projection back to canonical Markdown source. */
export function getSource(element) {
    const state = renderedState.get(element);
    if (state) return state.pendingSource ?? state.source;
    const blocks = [];
    for (const node of element.childNodes) {
        if (node.nodeType === 1 && node.hasAttribute("data-markdown-placeholder-block")) continue;
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

function pointOffset(state, root, node, offset) {
    if (!node) return null;
    const textMapping = state.textDetails.get(node);
    if (textMapping) return textMapping.sourceStart + Math.min(offset, textMapping.length);

    let ancestor = node.nodeType === 1 ? node : node.parentNode;
    while (ancestor && ancestor !== root) {
        const detail = state.nodeDetails.get(ancestor);
        if (detail) {
            const start = state.starts.get(detail);
            if (detail.kind === "lineBreak") return start + detail.length;
            if (detail.kind === "element" && /^h[1-6]$/.test(detail.tag || "")) {
                let contentStart = start + detail.length;
                for (let index = state.details.indexOf(detail) + 1; index < state.details.length; index++) {
                    const next = state.details[index];
                    if (next.line !== detail.line || !["whitespace", "tab"].includes(next.kind)) break;
                    contentStart += next.length;
                }
                return contentStart;
            }
            return start;
        }
        ancestor = ancestor.parentNode;
    }
    return null;
}

/** Read native selection offsets in Markdown source coordinates. */
export function getSelection(element, range) {
    const state = renderedState.get(element);
    if (!range && state?.pendingSelection) return state.pendingSelection;
    const selection = range || element.ownerDocument?.getSelection?.();
    if (!state || !selection) return null;
    const anchorNode = range?.startContainer || selection.anchorNode;
    const anchorOffset = range?.startOffset ?? selection.anchorOffset;
    const focusNode = range?.endContainer || selection.focusNode;
    const focusOffset = range?.endOffset ?? selection.focusOffset;
    const anchor = pointOffset(state, element, anchorNode, anchorOffset);
    const head = pointOffset(state, element, focusNode, focusOffset);
    if (anchor === null || head === null) return null;
    return { start: Math.min(anchor, head), end: Math.max(anchor, head), anchor, head };
}

function insertValue(inputType, event) {
    if (["insertParagraph", "insertLineBreak"].includes(inputType)) return "\n";
    if (["insertText", "insertReplacementText", "insertCompositionText", "insertFromPaste",
        "insertFromDrop", "insertFromYank"].includes(inputType))
        return typeof event.data === "string" ? event.data
            : event.dataTransfer?.getData("text/plain") || event.clipboardData?.getData("text/plain") || null;
    return null;
}

function deletedLength(source, position, inputType) {
    if (inputType.endsWith("Backward")) {
        if (position <= 0) return 0;
        const previous = source.charCodeAt(position - 1);
        return previous >= 0xdc00 && previous <= 0xdfff && position > 1 &&
            source.charCodeAt(position - 2) >= 0xd800 && source.charCodeAt(position - 2) <= 0xdbff ? 2 : 1;
    }
    if (position >= source.length) return 0;
    const current = source.charCodeAt(position);
    return current >= 0xd800 && current <= 0xdbff && position + 1 < source.length &&
        source.charCodeAt(position + 1) >= 0xdc00 && source.charCodeAt(position + 1) <= 0xdfff ? 2 : 1;
}

/** Read native edits in source coordinates, including edits beside hidden syntax. */
export function readInputSource(element, event, selection) {
    const state = renderedState.get(element);
    if (!state || !event || !selection) return getSource(element);
    const { start, end } = selection;
    const value = insertValue(event.inputType, event);
    let removed = end - start;
    let inserted = value;
    if (value === null && /^delete/.test(event.inputType || "")) {
        inserted = "";
        if (!removed) removed = deletedLength(state.source, start, event.inputType);
    }
    if (typeof inserted !== "string") return getSource(element);
    const previousSource = state.pendingSource ?? state.source;
    const source = previousSource.slice(0, start) + inserted + previousSource.slice(start + removed);
    const caret = start + inserted.length;
    state.pendingSource = source;
    state.pendingSelection = { start: caret, end: caret, anchor: caret, head: caret };
    return source;
}

/** Place a source selection back into the rendered Markdown projection. */
export function setSelection(element, { start, end = start, anchor = start, head = end } = {}) {
    const state = renderedState.get(element);
    const selection = element.ownerDocument?.getSelection?.();
    if (!state || !selection || !Number.isInteger(start) || !Number.isInteger(end)) return false;

    const point = offset => {
        let previous = null;
        for (const detail of state.details) {
            if (detail.kind === "lineBreak" && detail.liveDOM &&
                state.starts.get(detail) + detail.length === offset &&
                detail.liveDOM.hasAttribute("data-markdown-placeholder-block"))
                return [detail.liveDOM, 0];
        }
        for (const mapping of state.textMappings) {
            const { node, sourceStart: detailStart, length } = mapping;
            const detailEnd = detailStart + length;
            if (detailStart <= offset && offset <= detailEnd) {
                return [node, Math.min(offset - detailStart, node.data.length)];
            }
            if (detailStart > offset) break;
            previous = [node, node.data.length];
        }

        // Hidden block syntax has no text node. Put the caret at the start of
        // its rendered element so typing continues in the source content.
        for (const detail of state.details) {
            if (detail.kind !== "element" || !/^h[1-6]$/.test(detail.tag || "") || !detail.liveDOM) continue;
            const contentStart = pointOffset(state, element, detail.liveDOM, 0);
            if (contentStart === offset) {
                const text = detail.liveDOM.firstChild;
                return text?.nodeType === 3 ? [text, 0] : [detail.liveDOM, 0];
            }
        }
        if (previous) return previous;
        return [element, 0];
    };

    const [anchorNode, anchorOffset] = point(anchor);
    const [headNode, headOffset] = point(head);
    selection.removeAllRanges();
    if (selection.setBaseAndExtent) selection.setBaseAndExtent(anchorNode, anchorOffset, headNode, headOffset);
    else {
        const range = element.ownerDocument.createRange();
        range.setStart(anchorNode, anchorOffset);
        range.setEnd(headNode, headOffset);
        selection.addRange(range);
    }
    return true;
}

/** Reparse and render the resulting source so edits and initial load agree. */
export async function updateEditor(element, update, previousSource) {
    const { start, value } = update;
    const end = Number.isInteger(update.end) ? update.end : start + update.length;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start ||
        end > previousSource.length || typeof value !== "string")
        throw new RangeError("Markdown update must contain a valid source range and string value.");
    const source = previousSource.slice(0, start) + value + previousSource.slice(end);
    if (typeof update.string === "string" && update.string !== source)
        throw new RangeError("CRDT update does not match the previous Markdown source.");
    const editorDetails = await parseMarkdown(source, element);
    renderEditor(element, source, editorDetails);
    return { previousSource, source, editorDetails, start, end, value };
}

export function updateMarkdownEditorDetails(details, update, { editor } = {}) {
    return updateEditor(editor, update, details.map(detail => detail.value).join(""));
}

export { parseMarkdown };
export default createMarkdownEditor;
