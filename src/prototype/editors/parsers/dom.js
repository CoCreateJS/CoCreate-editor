/**
 * Experimental HTML source tokenizer for the length-only editor-details model.
 *
 * This is not the production renderer and does not create DOM nodes. It emits
 * a flat, ordered list of source segments. Every source character belongs to
 * exactly one segment, so joining `value` fields reproduces the input.
 * `parentDetails` links lexical segments to the nearest open element record;
 * those references are local derived state, not shared DOM references.
 * Text content stays in contiguous runs. Whitespace inside an opening tag is
 * also a text detail, marked `sourceOnly`: it contributes length but has no
 * live Text node. Tag endings use the same source-only convention.
 *
 * This scanner preserves source, including malformed or incomplete markup. It
 * is intentionally a tokenizer rather than a browser HTML tree builder: browser
 * error recovery, namespaces, and implied elements are future parser work.
 */

import { getPotentialDOMTagFlags, matchCompleteDOMElements } from "./matchDOMTag.js";
import voidElements, { isVoidElement } from "./voidElements.js";
const rawTextElements = new Set(["script", "style", "textarea", "title"]);
const nameStart = /[A-Za-z]/;
const nameCharacter = /[A-Za-z0-9:_-]/;
const whitespace = /[\t\n\f\r ]/;

export { isVoidElement };

function createRecordFactory(collection) {
    const record = (kind, value, parentDetails, extra = {}) => collection.add({
        kind,
        nodeType: kind === "element" ? 1
            : kind === "attribute" ? 2
                : kind === "text" ? 3
                    : kind === "comment" ? 8
                    : null,
        ...(kind === "markup" || kind === "elementEnd" ? { sourceOnly: true } : {}),
        value,
        parentDetails: parentDetails || null,
        ...extra
    });
    record.details = collection.details;
    return record;
}

function readName(source, start) {
    if (!nameStart.test(source[start] || "")) return start;
    let end = start + 1;
    while (end < source.length && nameCharacter.test(source[end])) end++;
    return end;
}

function readTagEnd(source, start, stopAtTagStart = false) {
    let quote = "";
    for (let index = start; index < source.length; index++) {
        const character = source[index];
        if (quote) {
            if (character === quote) quote = "";
        } else if (character === "\"" || character === "'") quote = character;
        else if (character === ">") return { end: index, next: index + 1 };
        else if (stopAtTagStart && character === "<") return { end: -1, next: index };
    }
    return { end: -1, next: source.length };
}

function readAttributeEnd(source, start, limit) {
    let index = start;
    while (index < limit && !whitespace.test(source[index]) &&
        source[index] !== "=" && source[index] !== ">" && source[index] !== "/") index++;
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
    if (end <= start) return;
    const value = source.slice(start, end);
    const previous = record.details.at(-1);
    if (previous?.kind === "text" && !previous.sourceOnly && previous.parentDetails === parentDetails) {
        previous.value += value;
        previous.length = previous.value.length;
        Object.assign(previous, getPotentialDOMTagFlags(previous.value));
    } else record("text", value, parentDetails, getPotentialDOMTagFlags(value));
}

function pushRawMarkup(record, source, start, end, parentDetails, kind = "markup", complete = true) {
    const value = source.slice(start, end);
    record(kind, value, parentDetails, { complete });
}

/** Parse DOM/HTML source into flat, position-free source records. */
export function parseDOM(source) {
    if (typeof source !== "string") throw new TypeError("HTML source must be a string.");

    // Only promote non-void start tags when a matching close makes the element
    // resolvable. Unmatched tag syntax stays in text details for later repair.
    const resolvedStarts = new Set(matchCompleteDOMElements(source, 0, source.length)
        .filter(match => !match.closing && !match.selfClosing)
        .map(match => match.start));

    const details = [];
    const collection = { details, add(data) {
        const record = { ...data, length: data.value.length };
        details.push(record);
        return record;
    } };
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
            const { end: endAt } = readTagEnd(source, index + 2);
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
            let end = source.indexOf("<", index + 1);
            if (end < 0) end = source.length;
            pushText(record, source, index, end, parent());
            index = end;
            continue;
        }

        const tag = source.slice(nameStartIndex, nameEnd).toLowerCase();
        const { end: tagEnd, next } = readTagEnd(source, nameEnd, true);
        if (tagEnd < 0) {
            pushText(record, source, index, next, parent());
            index = next;
            continue;
        }
        const limit = tagEnd;

        if (closing) {
            let matchingIndex = openElements.length - 1;
            while (matchingIndex >= 0 && openElements[matchingIndex].tag !== tag) matchingIndex--;
            const matching = openElements[matchingIndex];
            const closeEnd = tagEnd + 1;
            if (!matching) {
                pushText(record, source, index, closeEnd, parent());
                index = closeEnd;
                continue;
            }
            record("elementEnd", source.slice(index, closeEnd), matching || parent(), {
                tag,
                complete: true
            });
            if (matching) openElements.length = matchingIndex;
            index = closeEnd;
            continue;
        }

        if (!isVoidElement(tag) && !resolvedStarts.has(index)) {
            const openEnd = tagEnd + 1;
            pushText(record, source, index, openEnd, parent());
            index = openEnd;
            continue;
        }

        const element = record("element", source.slice(index, nameEnd), parent(), {
            tag,
            complete: true,
            selfClosing: false
        });

        let cursor = nameEnd;
        let endingStart = tagEnd;
        while (cursor < limit) {
            if (whitespace.test(source[cursor])) {
                const start = cursor;
                while (cursor < limit && whitespace.test(source[cursor])) cursor++;
                record("text", source.slice(start, cursor), element, { sourceOnly: true });
                continue;
            }
            if (source[cursor] === "/" && cursor + 1 === limit) {
                endingStart = cursor;
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

        // The closing angle is source data, with no live node of its own.
        record("markup", source.slice(endingStart, tagEnd + 1), element);
        index = tagEnd + 1;

        if (!element.selfClosing && !voidElements.has(tag))
            openElements.push(element);
    }

    return details;
}

export default parseDOM;
