import { createLanguageDetails } from "./createLanguageDetails.js";
// Lightweight Bash tokens. Quoted strings are kept whole, including any
// substitutions inside double quotes, rather than parsing shell expansions.
const rules = [
    { name: "comment", pattern: /(?<![\w$])#[^\r\n]*/y },
    {
        name: "string",
        pattern: /'(?:[^'])*(?:'|$)|"(?:\\.|[^"\\])*(?:"|$)|`(?:\\.|[^`\\])*(?:`|$)/y,
        content: raw => {
            let slashes = 0;
            for (let i = raw.length - 2; i >= 0 && raw[i] === "\\"; i--)
                slashes++;
            const closed = raw.length > 1 && raw.at(-1) === raw[0] &&
                (raw[0] === "'" || slashes % 2 === 0);
            return [1, raw.length - (closed ? 1 : 0)];
        }
    },
    { name: "variable", pattern: /\$\{[^}]*\}|\$[A-Za-z_][\w]*|\$\d+|\$[@*#?$!\-]/y },
    {
        name: "keyword",
        pattern: /\b(?:case|coproc|do|done|elif|else|esac|fi|for|function|if|in|select|then|time|until|while)\b/y
    },
    { name: "number", pattern: /\b\d+\b/y },
    {
        name: "operator",
        pattern: /<<<|<<-|&&|\|\||\|&|>>|<<|>&|<&|;;|\$\(\(|\$\(|[|&;()<>{}=!+*\/%~\-]/y
    },
    { name: "punctuation", pattern: /[()[\]{},.:]/y }
];

export function parseCode(source, editor = null) {
    return createLanguageDetails(source, "bash", rules, editor);
}

export default rules;
