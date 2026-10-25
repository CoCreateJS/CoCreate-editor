// Ordered lexical rules for common CSS syntax. Values and selectors remain
// source text; the tokenizer adds lightweight highlighting without parsing or
// normalizing the stylesheet.
export default [
    {
        name: "comment",
        pattern: /\/\*[\s\S]*?(?:\*\/|$)/y,
        content: raw => [2, raw.endsWith("*/") ? raw.length - 2 : raw.length]
    },
    {
        name: "string",
        pattern: /"(?:\\.|[^"\\\n])*(?:"|(?=\n|$))|'(?:\\.|[^'\\\n])*(?:'|(?=\n|$))/y,
        content: raw => {
            let slashes = 0;
            for (let i = raw.length - 2; i >= 0 && raw[i] === "\\"; i--)
                slashes++;
            const closed = raw.length > 1 && raw.at(-1) === raw[0] &&
                slashes % 2 === 0;
            return [1, raw.length - (closed ? 1 : 0)];
        }
    },
    { name: "at-rule", pattern: /@[A-Za-z_-][\w-]*/y },
    { name: "keyword", pattern: /!important\b/y },
    {
        name: "property",
        pattern: /(?:--[\w-]+|-?[A-Za-z][\w-]*)(?=\s*:)/iy
    },
    { name: "function", pattern: /[A-Za-z_-][\w-]*(?=\s*\()/y },
    {
        name: "color",
        pattern: /#[\da-fA-F]{8}(?![\w-])|#[\da-fA-F]{6}(?![\w-])|#[\da-fA-F]{4}(?![\w-])|#[\da-fA-F]{3}(?![\w-])/y
    },
    {
        name: "number",
        pattern: /[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?(?:%|[A-Za-z]+)?/iy
    },
    {
        name: "keyword",
        pattern: /\b(?:auto|currentcolor|inherit|initial|none|revert(?:-layer)?|transparent|unset)\b/iy
    },
    { name: "selector", pattern: /#[\w-]+|\.[A-Za-z_-][\w-]*|:{1,2}[A-Za-z_-][\w-]*/y },
    { name: "operator", pattern: /[>+~*=\/|^$!]/y },
    { name: "punctuation", pattern: /[{}()[\],;:]/y }
];
