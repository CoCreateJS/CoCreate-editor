import { createLanguageDetails } from "./createLanguageDetails.js";
// Ordered rules let comments and strings own their contents before keywords,
// numbers, operators, and punctuation are considered. Template expressions are
// kept inside the string token; this is intentionally a lightweight tokenizer.
const rules = [
    {
        name: "comment",
        pattern: /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/y,
        content: raw => [2, raw.startsWith("/*") && raw.endsWith("*/")
            ? raw.length - 2 : raw.length]
    },
    {
        name: "string",
        pattern: /"(?:\\.|[^"\\\n])*(?:"|(?=\n|$))|'(?:\\.|[^'\\\n])*(?:'|(?=\n|$))|`(?:\\.|[^`\\])*(?:`|$)/y,
        content: raw => {
            let slashes = 0;
            for (let i = raw.length - 2; i >= 0 && raw[i] === "\\"; i--)
                slashes++;
            const closed = raw.length > 1 && raw.at(-1) === raw[0] &&
                slashes % 2 === 0;
            return [1, raw.length - (closed ? 1 : 0)];
        }
    },
    {
        name: "keyword",
        pattern: /\b(?:as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|import|in|instanceof|let|new|of|return|set|static|super|switch|this|throw|try|typeof|var|void|while|with|yield)\b/y
    },
    { name: "literal", pattern: /\b(?:false|null|true)\b/y },
    {
        name: "number",
        pattern: /(?:\b(?:0[xX][\da-fA-F](?:_?[\da-fA-F])*n?|0[bB][01](?:_?[01])*n?|0[oO][0-7](?:_?[0-7])*n?|\d(?:_?\d)*n|\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?(?:[eE][+-]?\d(?:_?\d)*)?)|\.\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)?)/y
    },
    {
        name: "operator",
        pattern: />>>=|===|!==|>>>|\*\*=|&&=|\|\|=|\?\?=|<<=|>>=|\.\.\.|=>|==|!=|<=|>=|\+\+|--|\*\*|&&|\|\||\?\?|\?\.|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<|>>|[=+\-*\/%&|^!~<>?:]/y
    },
    { name: "punctuation", pattern: /[{}()[\],;.]/y }
];

export function parseCode(source, editor = null) {
    return createLanguageDetails(source, "javascript", rules, editor);
}

export default rules;
