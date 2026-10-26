/**
 * Experimental HTML source tokenizer for the length-only editor-details model.
 *
 * This is not the production renderer and does not create DOM nodes. It emits
 * a flat, ordered list of source segments. Every source character belongs to
 * exactly one segment, so joining `value` fields reproduces the input.
 * `parentDetails` links lexical segments to the nearest open element record;
 * those references are local derived state, not shared DOM references.
 *
 * This scanner preserves source, including malformed or incomplete markup. It
 * is intentionally a tokenizer rather than a browser HTML tree builder: browser
 * error recovery, namespaces, and implied elements are future parser work.
 */

import { createEditorDetailsCollection } from "../utilities/createEditorDetails.js";

const voidElements = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr"
]);
const rawTextElements = new Set(["script", "style", "textarea", "title"]);
const nameStart = /[A-Za-z]/;
const nameCharacter = /[A-Za-z0-9:_-]/;
const whitespace = /[\t\n\f\r ]/;

function createRecordFactory(collection) {
    return (kind, value, parentDetails, extra = {}) => collection.add({
        kind,
        nodeType: kind === "element" || kind === "elementEnd" ? 1
            : kind === "attribute" ? 2
                : kind === "text" || kind === "whitespace" || kind === "tab" || kind === "lineBreak" ? 3
                    : kind === "comment" ? 8
                    : null,
        value,
        parentDetails: parentDetails || null,
        ...extra
    });
}

function readName(source, start) {
    if (!nameStart.test(source[start] || "")) return start;
    let end = start + 1;
    while (end < source.length && nameCharacter.test(source[end])) end++;
    return end;
}

function readTagEnd(source, start) {
    let quote = "";
    for (let index = start; index < source.length; index++) {
        const character = source[index];
        if (quote) {
            if (character === quote) quote = "";
        } else if (character === "\"" || character === "'") quote = character;
        else if (character === ">") return index;
    }
    return -1;
}

function readAttributeEnd(source, start, limit) {
    let index = start;
    while (index < limit && !whitespace.test(source[index]) && source[index] !== "=" && source[index] !== ">") index++;
    if (index === start) return Math.min(start + 1, limit);

    const nameEnd = index;
    while (index < limit && whitespace.test(source[index])) index++;
    if (source[index] !== "=") return nameEnd;
    index++;
    while (index < limit && whitespace.test(source[index])) index++;

    const quote = source[index] === "\"" || source[index] === "'" ? source[index++] : "";
    if (quote) {
        while (index < limit && source[index] !== quote) index++;
        if (index < limit) index++;
    } else {
        while (index < limit && !whitespace.test(source[index]) && source[index] !== ">") index++;
    }
    return Math.max(index, nameEnd);
}

function pushText(record, source, start, end, parentDetails) {
    let index = start;
    while (index < end) {
        if (whitespace.test(source[index])) {
            const character = source[index];
            const kind = character === "\t" ? "tab"
                : character === "\n" || character === "\r" ? "lineBreak"
                    : "whitespace";
            record(kind, character, parentDetails);
            index++;
            continue;
        }
        let next = index + 1;
        while (next < end && !whitespace.test(source[next])) next++;
        record("text", source.slice(index, next), parentDetails);
        index = next;
    }
}

function pushRawMarkup(record, source, start, end, parentDetails, kind = "markup", complete = true) {
    const value = source.slice(start, end);
    record(kind, value, parentDetails, { complete });
}

/** Parse DOM/HTML source into flat, position-free editor-detail records. */
export function parseDOM(source, editor = null) {
    if (typeof source !== "string") throw new TypeError("HTML source must be a string.");

    const collection = createEditorDetailsCollection({ editor, dom: true });
    const details = collection.details;
    const record = createRecordFactory(collection);
    const openElements = [];
    const parent = () => openElements.at(-1) || null;
    let index = 0;

    while (index < source.length) {
        const current = parent();

        // Raw-text/RCDATA contents treat `<` as text except for their own close.
        if (current && rawTextElements.has(current.tag)) {
            const closePattern = new RegExp(`</${current.tag}(?=[\\t\\n\\f\\r />])`, "ig");
            closePattern.lastIndex = index;
            const close = closePattern.exec(source);
            const end = close ? close.index : source.length;
            if (end > index) pushText(record, source, index, end, current);
            index = end;
            if (!close) break;
        }

        if (source[index] !== "<") {
            let end = source.indexOf("<", index);
            if (end < 0) end = source.length;
            pushText(record, source, index, end, parent());
            index = end;
            continue;
        }

        if (source.startsWith("<!--", index)) {
            const close = source.indexOf("-->", index + 4);
            const end = close < 0 ? source.length : close + 3;
            pushRawMarkup(record, source, index, end, parent(), "comment", close >= 0);
            index = end;
            continue;
        }

        if (source.startsWith("<!", index) || source.startsWith("<?", index)) {
            const endAt = readTagEnd(source, index + 2);
            const end = endAt < 0 ? source.length : endAt + 1;
            pushRawMarkup(record, source, index, end, parent(), "markup", endAt >= 0);
            index = end;
            continue;
        }

        const closing = source[index + 1] === "/";
        const nameStartIndex = index + (closing ? 2 : 1);
        const nameEnd = readName(source, nameStartIndex);
        if (nameEnd === nameStartIndex) {
            // A literal less-than sign or incomplete `<` remains source text.
            let end = index + 1;
            while (end < source.length && source[end] !== "<" && !whitespace.test(source[end])) end++;
            pushText(record, source, index, end, parent());
            index = end;
            continue;
        }

        const tag = source.slice(nameStartIndex, nameEnd).toLowerCase();
        const tagEnd = readTagEnd(source, nameEnd);
        const limit = tagEnd < 0 ? source.length : tagEnd;

        if (closing) {
            const matching = [...openElements].reverse().find(item => item.tag === tag) || null;
            const closeEnd = tagEnd < 0 ? source.length : tagEnd + 1;
            record("elementEnd", source.slice(index, closeEnd), matching || parent(), {
                tag,
                complete: tagEnd >= 0
            });
            if (matching) openElements.splice(openElements.indexOf(matching));
            index = closeEnd;
            continue;
        }

        const element = record("element", source.slice(index, nameEnd), parent(), {
            tag,
            complete: tagEnd >= 0,
            selfClosing: false
        });

        let cursor = nameEnd;
        while (cursor < limit) {
            if (whitespace.test(source[cursor])) {
                const character = source[cursor++];
                const kind = character === "\t" ? "tab"
                    : character === "\n" || character === "\r" ? "lineBreak"
                        : "whitespace";
                record(kind, character, element);
                continue;
            }
            if (source[cursor] === "/" && cursor + 1 === limit) {
                record("delimiter", source.slice(cursor, cursor + 1), element);
                element.selfClosing = true;
                cursor++;
                continue;
            }

            const attributeStart = cursor;
            const attributeEnd = readAttributeEnd(source, cursor, limit);
            if (attributeEnd <= cursor) break;
            const raw = source.slice(attributeStart, attributeEnd);
            const equals = raw.indexOf("=");
            const name = (equals < 0 ? raw : raw.slice(0, equals)).trim();
            record("attribute", raw, element, {
                name,
                complete: attributeEnd > attributeStart
            });
            cursor = attributeEnd;
        }

        if (tagEnd >= 0) {
            const delimiter = source.slice(tagEnd, tagEnd + 1);
            record("delimiter", delimiter, element);
            index = tagEnd + 1;
        } else {
            index = source.length;
        }

        if (!element.selfClosing && !voidElements.has(tag) && tagEnd >= 0)
            openElements.push(element);
    }

    return details;
}

export default parseDOM;
