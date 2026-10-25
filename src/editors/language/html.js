// Source-only HTML scanning. Tokens contain offsets; the renderer creates text
// nodes, so source tags and scripts never become executable DOM elements.
const whitespace = /[\t\n\f\r ]/;

function* contentTokens(source, start, end, name) {
    const raw = source.slice(start, end);
    const entities = /&(?:#[xX][\da-fA-F]+|#\d+|[A-Za-z][A-Za-z\d]*);/g;
    let match, previous = 0;
    while ((match = entities.exec(raw))) {
        if (previous < match.index) yield { name, start: start + previous, end: start + match.index };
        yield { name: "entity", start: start + match.index, end: start + entities.lastIndex };
        previous = entities.lastIndex;
    }
    if (start + previous < end) yield { name, start: start + previous, end };
}

export default function* htmlTokens(source) {
    const tagName = /[A-Za-z][\w:.-]*/y;
    const attributeName = /[^\t\n\f\r "'<>/=`]+/y;
    let position = 0, rawTag;
    while (position < source.length) {
        if (rawTag) {
            const closing = new RegExp(`</${rawTag}(?=[\\t\\n\\f\\r />])`, "gi");
            closing.lastIndex = position;
            const end = closing.exec(source)?.index ?? source.length;
            if (position < end) yield { name: "text", start: position, end };
            position = end;
            rawTag = null;
            if (position === source.length) break;
        }
        if (source.startsWith("<!--", position)) {
            const close = source.indexOf("-->", position + 4);
            const end = close < 0 ? source.length : close + 3;
            if (close >= 0) yield { name: "comment", start: position, end };
            position = end;
            continue;
        }
        if (/^<!doctype\b/i.test(source.slice(position, position + 10))) {
            let end = position + 2, quote;
            while (end < source.length) {
                const character = source[end++];
                if (quote) { if (character === quote) quote = null; }
                else if (character === '"' || character === "'") quote = character;
                else if (character === ">") break;
            }
            if (!quote && source[end - 1] === ">") yield { name: "doctype", start: position, end };
            position = end;
            continue;
        }
        const closing = source[position + 1] === "/";
        tagName.lastIndex = position + (closing ? 2 : 1);
        const tag = source[position] === "<" && tagName.exec(source);
        if (!tag) {
            // Leave partial syntax as literal mapped text until it is complete.
            if (source[position] === "<" && (position + 1 === source.length ||
                (source[position + 1] === "/" && position + 2 === source.length))) {
                position = source.length;
                break;
            }
            const next = source.indexOf("<", position + 1);
            const end = next < 0 ? source.length : next;
            yield* contentTokens(source, position, end, "text");
            position = end;
            continue;
        }
        // Buffer a whole tag. An unfinished bracket or quoted value must not
        // leave a partially tokenized tag in the projection.
        const tokens = [];
        tokens.push({ name: "punctuation", start: position, end: ++position });
        if (closing) tokens.push({ name: "punctuation", start: position, end: ++position });
        tokens.push({ name: "tag", start: position, end: tagName.lastIndex });
        position = tagName.lastIndex;
        let expectValue = false, complete = false, valid = true, hasAttribute = false, canAssign = false;
        while (position < source.length) {
            const character = source[position];
            if (whitespace.test(character)) { position++; continue; }
            if (character === "<") break;
            if (character === ">" || source.startsWith("/>", position)) {
                const selfClosing = character === "/";
                if (selfClosing) tokens.push({ name: "punctuation", start: position, end: ++position });
                tokens.push({ name: "punctuation", start: position, end: ++position });
                complete = valid && !expectValue && !(closing && (hasAttribute || selfClosing));
                if (complete && !closing && !selfClosing && /^(script|style)$/i.test(tag[0])) rawTag = tag[0];
                break;
            }
            if (character === "=") {
                if (!canAssign || expectValue || closing) valid = false;
                tokens.push({ name: "operator", start: position, end: ++position });
                expectValue = true;
                canAssign = false;
                continue;
            }
            if (character === '"' || character === "'") {
                if (!expectValue) valid = false;
                tokens.push({ name: "quote", start: position, end: ++position });
                const close = source.indexOf(character, position);
                const end = close < 0 ? source.length : close;
                for (const token of contentTokens(source, position, end, "attribute-value")) tokens.push(token);
                position = end;
                if (close >= 0) tokens.push({ name: "quote", start: position, end: ++position });
                expectValue = false;
                continue;
            }
            if (expectValue) {
                const start = position;
                while (position < source.length && !whitespace.test(source[position]) &&
                    source[position] !== ">" && source[position] !== "<" && !source.startsWith("/>", position)) position++;
                for (const token of contentTokens(source, start, position, "attribute-value")) tokens.push(token);
                expectValue = false;
                continue;
            }
            attributeName.lastIndex = position;
            const attribute = attributeName.exec(source);
            if (attribute) {
                if (!whitespace.test(source[position - 1])) valid = false;
                tokens.push({ name: "attribute", start: position, end: attributeName.lastIndex });
                position = attributeName.lastIndex;
                hasAttribute = true;
                canAssign = true;
            } else {
                valid = false;
                position++;
            }
        }
        if (complete) yield* tokens;
    }
}
