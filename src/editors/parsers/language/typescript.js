import { createLanguageDetails } from "./createLanguageDetails.js";
// Lightweight TypeScript tokens cover ECMAScript syntax plus common type
// declarations and annotations. Generic and template syntax remain lexical.
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
    { name: "decorator", pattern: /@[A-Za-z_$][\w$]*/y },
    { name: "literal", pattern: /\b(?:false|null|true)\b/y },
    {
        name: "keyword",
        pattern: /\b(?:abstract|as|assert|asserts|async|await|break|case|catch|class|const|continue|debugger|declare|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|infer|instanceof|interface|is|keyof|let|module|namespace|new|of|override|private|protected|public|readonly|return|satisfies|set|static|super|switch|this|throw|try|type|typeof|unique|using|var|while|with|yield)\b/y
    },
    { name: "type", pattern: /\b(?:any|bigint|boolean|never|number|object|string|symbol|unknown|void)\b/y },
    {
        name: "number",
        pattern: /\b(?:0[xX][\da-fA-F](?:_?[\da-fA-F])*n?|0[bB][01](?:_?[01])*n?|0[oO][0-7](?:_?[0-7])*n?|\d(?:_?\d)*n|\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?(?:[eE][+-]?\d(?:_?\d)*)?)/y
    },
    { name: "function", pattern: /[A-Za-z_$][\w$]*(?=\s*\()/y },
    {
        name: "operator",
        pattern: />>>=|===|!==|>>>|\*\*=|&&=|\|\|=|\?\?=|<<=|>>=|\.\.\.|=>|==|!=|<=|>=|\+\+|--|\*\*|&&|\|\||\?\?|\?\.|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<|>>|[=+\-*\/%&|^!~<>?:]/y
    },
    { name: "punctuation", pattern: /[{}()[\],;.]/y }
];

export function parseCode(source, editor = null) {
    return createLanguageDetails(source, "typescript", rules, editor);
}

export default rules;
