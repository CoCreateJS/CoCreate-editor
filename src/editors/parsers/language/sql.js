import { createLanguageDetails } from "./createLanguageDetails.js";
// Generic SQL highlighting across common dialects; unquoted identifiers and
// dialect-specific grammar remain plain source text.
const rules = [
    {
        name: "comment",
        pattern: /--[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/y,
        content: raw => raw.startsWith("--")
            ? [2, raw.length]
            : [2, raw.endsWith("*/") ? raw.length - 2 : raw.length]
    },
    {
        name: "string",
        pattern: /'(?:''|\\.|[^'\\])*(?:'|$)/y,
        content: raw => [1, raw.length > 1 && raw.endsWith("'") ? raw.length - 1 : raw.length]
    },
    {
        name: "string",
        pattern: /(\$(?:[A-Za-z_]\w*)?\$)[\s\S]*?(?:\1|$)/y,
        content: raw => {
            const delimiter = raw.match(/^\$(?:[A-Za-z_]\w*)?\$/)[0];
            const closed = raw.length >= delimiter.length * 2 && raw.endsWith(delimiter);
            return [delimiter.length, raw.length - (closed ? delimiter.length : 0)];
        }
    },
    {
        name: "property",
        pattern: /"(?:""|[^"\n])*"|`(?:``|[^`\n])*`|\[(?:\]\]|[^\]\n])*\]/y,
        content: raw => [1, raw.length - 1]
    },
    { name: "parameter", pattern: /\$\d+|:[A-Za-z_]\w*|\?/y },
    { name: "literal", pattern: /\b(?:false|null|true|unknown)\b/iy },
    {
        name: "keyword",
        pattern: /\b(?:add|all|alter|and|any|as|asc|begin|between|by|case|cast|check|column|commit|constraint|create|cross|current_date|current_time|current_timestamp|database|default|delete|desc|distinct|drop|else|end|except|exists|false|fetch|for|foreign|from|full|grant|group|having|ilike|in|index|inner|insert|intersect|into|is|join|key|left|like|limit|not|null|offset|on|or|order|outer|over|partition|primary|references|returning|right|rollback|row|select|set|table|then|to|union|unique|update|using|values|view|when|where|with)\b/iy
    },
    {
        name: "number",
        pattern: /\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/y
    },
    { name: "function", pattern: /[A-Za-z_]\w*(?=\s*\()/y },
    {
        name: "operator",
        pattern: /->>|->|::|:=|<=|>=|<>|!=|==|\|\||&&|\+=|-=|\*=|\/=|[=<>+\-*\/%|&^~!]/y
    },
    { name: "punctuation", pattern: /[()[\]{},.;:]/y }
];

export function parseCode(source, editor = null) {
    return createLanguageDetails(source, "sql", rules, editor);
}

export default rules;
