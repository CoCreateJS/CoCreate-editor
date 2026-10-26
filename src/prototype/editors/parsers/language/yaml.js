import { createLanguageDetails } from "./createLanguageDetails.js";
// Common YAML configuration tokens. The source stays authoritative; this is a
// lightweight highlighter rather than a YAML parser or validator.
const rules = [
    { name: "comment", pattern: /(?<!\S)#[^\r\n]*/y },
    {
        name: "property",
        pattern: /"(?:\\.|[^"\\])*"(?=\s*:)|'(?:''|[^'])*'(?=\s*:)/y,
        content: raw => [1, raw.length - 1]
    },
    {
        name: "string",
        pattern: /"(?:\\.|[^"\\])*(?:"|$)|'(?:''|[^'])*(?:'|$)/y,
        content: raw => [1, raw.length > 1 && raw.at(-1) === raw[0] ? raw.length - 1 : raw.length]
    },
    { name: "tag", pattern: /!<[A-Za-z][^>]*>|![A-Za-z_][\w.-]*/y },
    { name: "variable", pattern: /[&*][A-Za-z_][\w-]*/y },
    {
        name: "date",
        pattern: /\b\d{4}-\d{2}-\d{2}(?:[Tt ][\d:.+-]+(?:[Zz]|[+-]\d{2}:?\d{2})?)?/y
    },
    { name: "literal", pattern: /(?:\b(?:false|null|true)\b|~)/iy },
    {
        name: "number",
        pattern: /[-+]?(?:0[xX][\da-fA-F]+|0[oO][0-7]+|0[bB][01]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|\.inf|\.nan)/iy
    },
    { name: "property", pattern: /[A-Za-z_][\w.-]*(?=\s*:)/y },
    { name: "operator", pattern: /---|\.\.\.|[|>]/y },
    { name: "punctuation", pattern: /[{}()[\],:?]/y }
];

export function parseCode(source, editor = null) {
    return createLanguageDetails(source, "yaml", rules, editor);
}

export default rules;
