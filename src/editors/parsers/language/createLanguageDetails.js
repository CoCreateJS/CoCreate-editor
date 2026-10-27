function* tokenizeRules(source, definitions) {
    const rules = definitions.map(definition => ({
        definition,
        pattern: new RegExp(
            definition.pattern.source,
            definition.pattern.flags.replace(/[gy]/g, "") + "y"
        )
    }));

    let position = 0;
    while (position < source.length) {
        let matched = false;
        for (const rule of rules) {
            rule.pattern.lastIndex = position;
            const match = rule.pattern.exec(source);
            if (!match?.[0].length) continue;

            const content = rule.definition.content?.(match[0]);
            const contentStart = content?.[0] ?? 0;
            const contentEnd = content?.[1] ?? match[0].length;
            const end = position + match[0].length;
            yield {
                name: rule.definition.name,
                definition: rule.definition,
                start: position,
                end,
                contentStart: position + contentStart,
                contentEnd: position + contentEnd
            };
            position = end;
            matched = true;
            break;
        }
        if (!matched) position++;
    }
}

function addPlainSource(collection, source, start, end, language) {
    let position = start;
    while (position < end) {
        const character = source[position];
        let kind, next;
        if (character === "\r" && source[position + 1] === "\n") {
            kind = "lineBreak";
            next = position + 2;
        } else if (character === "\r" || character === "\n") {
            kind = "lineBreak";
            next = position + 1;
        } else if (character === "\t") {
            kind = "tab";
            next = position + 1;
        } else if (/[ \f]/.test(character)) {
            kind = "whitespace";
            next = position + 1;
        } else {
            kind = "text";
            next = position + 1;
            while (next < end && !/[\r\n\t \f]/.test(source[next])) next++;
        }

        collection.add({ kind, nodeType: 3, language, value: source.slice(position, next) });
        position = next;
    }
}

function addToken(collection, source, token, language) {
    const contentStart = token.contentStart ?? token.start;
    const contentEnd = token.contentEnd ?? token.end;
    if (!Number.isInteger(token.start) || !Number.isInteger(token.end) ||
        !Number.isInteger(contentStart) || !Number.isInteger(contentEnd) ||
        token.start < 0 || token.end < token.start || token.end > source.length ||
        contentStart < token.start || contentEnd < contentStart || contentEnd > token.end)
        throw new RangeError(`Invalid ${language} token range.`);

    collection.add({
        kind: "element",
        nodeType: 3,
        language,
        tag: "span",
        token: token.name || "text",
        value: source.slice(token.start, token.end),
        syntax: {
            rule: token.name || "text",
            opening: contentStart > token.start
                ? { start: 0, end: contentStart - token.start }
                : null,
            closing: contentEnd < token.end
                ? { start: contentEnd - token.start, end: token.end - token.start }
                : null
        },
        definition: token.definition || null
    });
}

/** Turn one language's token stream or lexical rules into plain source records. */
export function createLanguageDetails(source, language, tokenSource) {
    if (typeof source !== "string") throw new TypeError("Code source must be a string.");
    const records = [];
    const collection = { add(data) {
        const record = { ...data, length: data.value.length };
        records.push(record);
        return record;
    } };
    const tokens = Array.isArray(tokenSource)
        ? tokenizeRules(source, tokenSource)
        : tokenSource || [];

    let position = 0;
    for (const token of tokens) {
        if (!Number.isInteger(token.start) || !Number.isInteger(token.end) ||
            token.start < position || token.end < token.start || token.end > source.length)
            throw new RangeError(`Invalid ${language} token range.`);
        if (position < token.start)
            addPlainSource(collection, source, position, token.start, language);
        if (token.start < token.end) addToken(collection, source, token, language);
        position = token.end;
    }
    if (position < source.length)
        addPlainSource(collection, source, position, source.length, language);
    return records;
}

export default createLanguageDetails;
