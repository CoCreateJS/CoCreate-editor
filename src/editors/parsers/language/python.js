import { createLanguageDetails } from "./createLanguageDetails.js";
// Lightweight Python tokens. F-strings are kept whole, so their expressions
// remain string-colored instead of being parsed as nested Python syntax.
const rules = [
    {
        name: "comment",
        pattern: /#[^\r\n]*/y
    },
    {
        name: "string",
        pattern: /(?:[rRuUbBfF]{1,2})?(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*(?:"|(?=\n|$))|'(?:\\.|[^'\\\n])*(?:'|(?=\n|$)))/y,
        content: raw => {
            const quote = raw.search(/["']/);
            const delimiter = raw.startsWith('"""', quote) || raw.startsWith("'''", quote)
                ? 3 : 1;
            const closed = raw.length >= quote + delimiter * 2 &&
                (delimiter === 3
                    ? raw.endsWith(raw[quote].repeat(3))
                    : raw.at(-1) === raw[quote]);
            return [quote + delimiter, raw.length - (closed ? delimiter : 0)];
        }
    },
    { name: "decorator", pattern: /@[A-Za-z_]\w*/y },
    {
        name: "keyword",
        pattern: /\b(?:and|as|assert|async|await|break|case|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|match|nonlocal|not|or|pass|raise|return|try|type|while|with|yield)\b/y
    },
    { name: "literal", pattern: /\b(?:False|None|True)\b/y },
    {
        name: "number",
        pattern: /(?:\b(?:0[xX][\da-fA-F](?:_?[\da-fA-F])*|0[bB][01](?:_?[01])*|0[oO][0-7](?:_?[0-7])*|\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?(?:[eE][+-]?\d(?:_?\d)*)?[jJ]?)|\.\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)?[jJ]?)/y
    },
    { name: "function", pattern: /[A-Za-z_]\w*(?=\s*\()/y },
    {
        name: "operator",
        pattern: /\*\*=|\/\/=|>>=|<<=|:=|->|==|!=|<=|>=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|\*\*|\/\/|<<|>>|[=+\-*\/%&|^~<>@]/y
    },
    { name: "punctuation", pattern: /[{}()[\],.:;]/y }
];

export function parseCode(source, editor = null) {
    return createLanguageDetails(source, "python", rules, editor);
}

export default rules;
