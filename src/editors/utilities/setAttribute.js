import { editorDetailsPrototype } from "./details.js";

const validName = /^[A-Za-z_:][\w:.-]*$/;

function checkName(name) {
    if (typeof name !== "string" || !validName.test(name))
        throw new TypeError("Attribute operations require a valid HTML attribute name.");
}

function openingTag(details) {
    const owner = details?.editorElement;
    const index = owner?.editor?.editorDetails || [];
    let low = 0, high = index.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (index[middle].start < details.start) low = middle + 1;
        else high = middle;
    }
    let current = false;
    for (let i = low; i < index.length && index[i].start === details.start; i++)
        if (index[i] === details) { current = true; break; }
    const source = String(owner?.value ?? "");
    if (!current || details.liveDOM?.editorDetails !== details || details.kind !== "element" ||
        (owner.editor.modeName && owner.editor.modeName !== "dom") ||
        !Number.isInteger(details.start) || !Number.isInteger(details.contentStart) ||
        details.start < 0 || details.start >= details.contentStart || details.contentStart > source.length)
        throw new RangeError("Attribute operations require a current HTML element record.");
    const tag = source.slice(details.start, details.contentStart);
    const match = /^<[A-Za-z][\w:-]*/.exec(tag);
    if (!match || match[0].slice(1).toLowerCase() !== details.tag?.toLowerCase() || tag.at(-1) !== ">")
        throw new RangeError("The target's opening tag does not match the current source.");
    const end = tag.length - (tag.endsWith("/>") ? 2 : 1);
    return { source, text: tag.slice(match[0].length, end),
        start: details.start + match[0].length, end: details.start + end };
}

// A sticky token consumes complete quoted values, so attribute-looking text
// inside another value can never be mistaken for a name. Positions are absolute
// UTF-16 source offsets; name/value ends exclude delimiters and are exclusive.
function parseAttributes(details) {
    const section = openingTag(details);
    const { text, start: base } = section;
    const pattern = /\s+([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/gy;
    const attributes = [];
    let cursor = 0, decoder;
    while (cursor < text.length) {
        pattern.lastIndex = cursor;
        const match = pattern.exec(text);
        if (!match) {
            if (/^\s*$/.test(text.slice(cursor))) break;
            throw new SyntaxError("Unable to parse the target's HTML attributes.");
        }
        const end = pattern.lastIndex;
        const nameStart = match.index + /^\s*/.exec(match[0])[0].length;
        const nameEnd = nameStart + match[1].length;
        let position = nameEnd;
        while (position < end && /\s/.test(text[position])) position++;
        let equals = null, quote = null, quoteStart = null, quoteEnd = null;
        let valueStart = null, valueEnd = null, rawValue = "";
        if (text[position] === "=") {
            equals = base + position++;
            while (position < end && /\s/.test(text[position])) position++;
            if (text[position] === '"' || text[position] === "'") {
                quote = text[position];
                quoteStart = base + position++;
                quoteEnd = base + end - 1;
            }
            valueStart = base + position;
            valueEnd = base + end - (quote ? 1 : 0);
            rawValue = text.slice(position, end - (quote ? 1 : 0));
        }
        let value = rawValue;
        if (/[&\r\u0000]/.test(value)) {
            // Decode in attribute context, including ambiguous entities without
            // semicolons. The fixed attribute lives inside an inert template.
            decoder ||= details.liveDOM.ownerDocument.createElement("template");
            const delimiter = quote || '"';
            decoder.innerHTML = `<span data-value=${delimiter}${rawValue}${delimiter}></span>`;
            value = decoder.content.firstChild.getAttribute("data-value");
        }
        attributes.push({ name: match[1], value, rawValue,
            start: base + nameStart, end: base + end, whitespaceStart: base + match.index,
            nameStart: base + nameStart, nameEnd: base + nameEnd,
            valueStart, valueEnd, equals, quote, quoteStart, quoteEnd });
        cursor = end;
    }
    return { ...section, attributes };
}

function matching(attributes, name) {
    const wanted = name.toLowerCase();
    return attributes.filter(attribute => attribute.name.toLowerCase() === wanted);
}

function submit(details, source, start, end, value) {
    const previous = source.slice(start, end);
    let from = 0, oldEnd = previous.length, newEnd = value.length;
    while (from < oldEnd && from < newEnd && previous[from] === value[from]) from++;
    while (oldEnd > from && newEnd > from && previous[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd--; }
    if (from === oldEnd && from === newEnd) return;
    return details.editorElement.editor.updateText({
        start: start + from, length: oldEnd - from, value: value.slice(from, newEnd)
    });
}

function escaped(value, quote) {
    return value.replace(/&/g, "&amp;").replace(quote === "'" ? /'/g : /"/g,
        quote === "'" ? "&#39;" : "&quot;");
}

function readAttributes() {
    return parseAttributes(this).attributes;
}

function readAttribute(name) {
    checkName(name);
    return matching(this.attributes, name)[0] || null;
}

function removeAttribute(name) {
    checkName(name);
    const { source, attributes } = parseAttributes(this);
    const found = matching(attributes, name);
    if (!found.length) return;
    // Duplicate names are legal input to the source parser. Remove every
    // occurrence so an ignored duplicate cannot become the visible attribute.
    const start = found[0].whitespaceStart, end = found.at(-1).end;
    let value = "", cursor = start;
    for (const attribute of found) {
        value += source.slice(cursor, attribute.whitespaceStart);
        cursor = attribute.end;
    }
    value += source.slice(cursor, end);
    return submit(this, source, start, end, value);
}

function setAttribute(name, value) {
    checkName(name);
    if (value == null) return removeAttribute.call(this, name);
    value = String(value);
    const { source, attributes, text, end } = parseAttributes(this);
    const found = matching(attributes, name)[0];
    if (!found) {
        const prefix = /\s$/.test(text) ? "" : " ";
        return submit(this, source, end, end, `${prefix}${name}="${escaped(value, '"')}"`);
    }
    if (found.valueStart !== null && found.value === value) return;
    if (found.valueStart === null)
        return submit(this, source, found.nameEnd, found.nameEnd, `="${escaped(value, '"')}"`);
    const replacement = found.quote ? escaped(value, found.quote)
        : value && !value.endsWith("/") && /^[^\s"'=<>`]+$/.test(value) ? escaped(value, '"') : `"${escaped(value, '"')}"`;
    return submit(this, source, found.valueStart, found.valueEnd, replacement);
}

// Shared, non-enumerable methods stay off serialized ranges and survive
// in-place position updates. The values/offsets themselves are read on demand.
// Install only when HTML helpers are loaded; other modes keep this parser lazy.
if (!Object.hasOwn(editorDetailsPrototype, "attributes")) Object.defineProperties(editorDetailsPrototype, {
    attributes: { get: readAttributes },
    getAttributes: { value: readAttributes },
    getAttribute: { value: readAttribute },
    setAttribute: { value: setAttribute },
    removeAttribute: { value: removeAttribute }
});

function targetDetails(editorElement, target) {
    const details = target?.editorElement ? target : target?.editorDetails;
    if (!details || details.editorElement !== editorElement)
        throw new RangeError("The attribute target must belong to this editor.");
    return details;
}

export function getHTMLAttributes(editorElement, { target } = {}) {
    return readAttributes.call(targetDetails(editorElement, target));
}

export function getHTMLAttribute(editorElement, { target, name } = {}) {
    return readAttribute.call(targetDetails(editorElement, target), name);
}

export function setHTMLAttribute(editorElement, { target, name, value } = {}) {
    return setAttribute.call(targetDetails(editorElement, target), name, value);
}

export function removeHTMLAttribute(editorElement, { target, name } = {}) {
    return removeAttribute.call(targetDetails(editorElement, target), name);
}
