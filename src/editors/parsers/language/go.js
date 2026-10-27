import { createLanguageDetails } from "./createLanguageDetails.js";
// Lightweight Go tokens preserve source without resolving package or type
// information.
const rules = [
    {
        name: "comment",
        pattern: /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/y,
        content: raw => raw.startsWith("//")
            ? [2, raw.length]
            : [2, raw.endsWith("*/") ? raw.length - 2 : raw.length]
    },
    {
        name: "string",
        pattern: /"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|`[^`]*(?:`|$)/y,
        content: raw => [1, raw.length > 1 && raw.at(-1) === raw[0] ? raw.length - 1 : raw.length]
    },
    {
        name: "keyword",
        pattern: /\b(?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\b/y
    },
    { name: "literal", pattern: /\b(?:false|iota|nil|true)\b/y },
    {
        name: "type",
        pattern: /\b(?:any|bool|byte|complex64|complex128|error|float32|float64|int|int8|int16|int32|int64|rune|string|uint|uint8|uint16|uint32|uint64|uintptr)\b/y
    },
    {
        name: "number",
        pattern: /\b(?:0[xX][\da-fA-F](?:_?[\da-fA-F])*(?:\.[\da-fA-F](?:_?[\da-fA-F])*)?(?:[pP][+-]?\d(?:_?\d)*)?|0[bB][01](?:_?[01])*|0[oO][0-7](?:_?[0-7])*|\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?(?:[eE][+-]?\d(?:_?\d)*)?)[iI]?/y
    },
    { name: "function", pattern: /[A-Za-z_]\w*(?=\s*\()/y },
    {
        name: "operator",
        pattern: /&\^=|<<=|>>=|&&|\|\||<-|:=|\.\.\.|\+\+|--|==|!=|<=|>=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|&\^|<<|>>|[=+\-*\/%&|^!~<>:]/y
    },
    { name: "punctuation", pattern: /[{}()[\],;.]/y }
];

export function parseCode(source, editor = null) {
    return createLanguageDetails(source, "go", rules, editor);
}

export default rules;
