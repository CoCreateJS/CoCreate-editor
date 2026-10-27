import { isVoidElement } from "./voidElements.js";

const tagPattern = /^<(\/?)\s*([A-Za-z][\w-]*)([\s\S]*?)\s*(\/?)>$/;
const attributePattern = /^[A-Za-z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/;
const rawTextElements = new Set(["script", "style", "textarea", "title"]);

function readTag(source, start) {
    let quote = "";
    let end = start + 1;
    for (; end < source.length; end++) {
        const character = source[end];
        if (quote) {
            if (character === quote) quote = "";
        } else if (character === "\"" || character === "'") quote = character;
        else if (character === "<" || character === ">") break;
    }
    if (source[end] !== ">") return null;

    const value = source.slice(start, end + 1);
    const match = tagPattern.exec(value);
    if (!match) return null;
    const [, slash, rawName, rawAttributes, selfClosing] = match;
    const name = rawName.toLowerCase();
    const closing = !!slash;
    const self = !!selfClosing;
    if (closing && (rawAttributes.trim() || self) ||
        (isVoidElement(name) ? closing : self)) return null;

    let attributes = rawAttributes;
    while (attributes) {
        const whitespace = /^\s+/.exec(attributes);
        if (!whitespace) return null;
        attributes = attributes.slice(whitespace[0].length);
        if (!attributes) break;
        const attribute = attributePattern.exec(attributes);
        if (!attribute) return null;
        attributes = attributes.slice(attribute[0].length);
    }
    return { start, end: end + 1, value, name, closing, self };
}

function findTagTokens(source) {
    const tokens = [];
    let cursor = 0;
    while (cursor < source.length) {
        const start = source.indexOf("<", cursor);
        if (start < 0) break;
        if (source.startsWith("<!--", start)) {
            const close = source.indexOf("-->", start + 4);
            cursor = close < 0 ? source.length : close + 3;
            continue;
        }
        if (source.startsWith("<!", start) || source.startsWith("<?", start)) {
            const end = source.indexOf(">", start + 2);
            cursor = end < 0 ? source.length : end + 1;
            continue;
        }

        const token = readTag(source, start);
        if (!token) { cursor = start + 1; continue; }
        tokens.push(token);
        cursor = token.end;

        if (!token.closing && !token.self && rawTextElements.has(token.name)) {
            const close = new RegExp(`</${token.name}\\s*>`, "ig");
            close.lastIndex = cursor;
            const match = close.exec(source);
            if (!match) break;
            const closing = readTag(source, match.index);
            if (closing) tokens.push(closing);
            cursor = match.index + match[0].length;
        }
    }
    return tokens;
}

/** Return valid tag-token candidates with offsets local to the supplied text. */
export function findPotentialDOMTags(source) {
    if (typeof source !== "string") throw new TypeError("DOM tag source must be a string.");
    const tags = findTagTokens(source).map(token => ({
        tag: token.name,
        kind: token.closing ? "closing" : "opening",
        start: token.start,
        end: token.end,
        complete: true
    }));

    // Preserve a trailing incomplete tag as a candidate too. It remains text
    // until its delimiter is completed and the normal matcher can resolve it.
    const partial = /<(\/?)\s*([A-Za-z][\w:-]*)(?=[\t\n\f\r />]|$)([^<>]*)$/i.exec(source);
    if (partial) {
        const start = partial.index;
        if (!tags.some(tag => tag.start === start)) tags.push({
            tag: partial[2].toLowerCase(),
            kind: partial[1] ? "closing" : "opening",
            start,
            end: source.length,
            complete: false
        });
    }

    return tags.sort((left, right) => left.start - right.start);
}

export function getPotentialDOMTagFlags(source) {
    const potentialTags = findPotentialDOMTags(source);
    return {
        potentialTags,
        potentialOpenTag: potentialTags.some(item => item.kind === "opening"),
        potentialClosingTag: potentialTags.some(item => item.kind === "closing")
    };
}

/** Find complete elements intersecting an edit; void tags complete by themselves. */
export function matchCompleteDOMElements(source, start, end = start) {
    if (typeof source !== "string" || !Number.isInteger(start) || !Number.isInteger(end) ||
        start < 0 || end < start || end > source.length)
        throw new RangeError("Expected a valid source range for DOM element matching.");

    const tokens = findTagTokens(source);
    const lexicalEnds = new Map();
    const pending = new Map();
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (isVoidElement(token.name)) continue;
        let openings = pending.get(token.name);
        if (!openings) pending.set(token.name, openings = []);
        if (!token.closing) openings.push(index);
        else if (openings.length) lexicalEnds.set(openings.pop(), index);
    }

    const stack = [];
    const complete = [];
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (isVoidElement(token.name)) {
            if (!token.closing) complete.push(token);
            continue;
        }
        if (!token.closing) {
            stack.push({ token, index });
            continue;
        }

        let found = stack.length - 1;
        while (found >= 0 && stack[found].token.name !== token.name) found--;
        if (found < 0) continue;
        const entry = stack[found];
        const crossed = stack.slice(found + 1).some(child => lexicalEnds.get(child.index) > index);
        if (!crossed) complete.push({
            start: entry.token.start, end: token.end,
            contentStart: entry.token.end,
            contentEnd: token.start,
            value: source.slice(entry.token.start, token.end), tag: token.name,
            closing: false, selfClosing: false
        });
        stack.splice(found);
    }

    return complete.filter(element => start === end
        ? element.start <= start && start < element.end
        : element.start < end && start < element.end);
}

export default matchCompleteDOMElements;
