const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const literal = /(?:true|false|null)(?![\w$])/y;
const punctuation = /[{}[\],:]/y;

export default function* jsonTokens(source) {
    let position = 0;
    while (position < source.length) {
        const character = source[position];

        if (character === '"') {
            const start = position++;
            let closed = false;
            while (position < source.length) {
                const current = source[position];
                if (current === "\\") {
                    position += Math.min(2, source.length - position);
                    continue;
                }
                if (current === '"') {
                    position++;
                    closed = true;
                    break;
                }
                if (current === "\n" || current === "\r") break;
                position++;
            }

            const end = position;
            let next = end;
            if (closed) {
                while (/[\t\n\r ]/.test(source[next] || "")) next++;
            }
            yield {
                name: closed && source[next] === ":" ? "property" : "string",
                start,
                end,
                contentStart: start + 1,
                contentEnd: closed ? end - 1 : end
            };
            continue;
        }

        number.lastIndex = position;
        const numeric = number.exec(source);
        if (numeric) {
            const start = position;
            position = number.lastIndex;
            yield { name: "number", start, end: position };
            continue;
        }

        literal.lastIndex = position;
        const word = literal.exec(source);
        if (word) {
            const start = position;
            position = literal.lastIndex;
            yield { name: "literal", start, end: position };
            continue;
        }

        punctuation.lastIndex = position;
        const mark = punctuation.exec(source);
        if (mark) {
            const start = position;
            position = punctuation.lastIndex;
            yield { name: "punctuation", start, end: position };
            continue;
        }

        position++;
    }
}
