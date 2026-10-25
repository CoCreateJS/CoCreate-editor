// Lightweight C syntax tokens; preprocessing and declarations are highlighted
// lexically without attempting to resolve macros or types.
export default [
    {
        name: "comment",
        pattern: /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/y,
        content: raw => raw.startsWith("//")
            ? [2, raw.length]
            : [2, raw.endsWith("*/") ? raw.length - 2 : raw.length]
    },
    { name: "preprocessor", pattern: /#[ \t]*[A-Za-z_]\w*/y },
    {
        name: "string",
        pattern: /"(?:\\[\s\S]|[^"\\])*?(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)/y,
        content: raw => [1, raw.length > 1 && raw.at(-1) === raw[0] ? raw.length - 1 : raw.length]
    },
    {
        name: "keyword",
        pattern: /\b(?:_Alignas|_Alignof|_Atomic|_Bool|_Complex|_Generic|_Imaginary|_Noreturn|_Static_assert|_Thread_local|auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|restrict|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while)\b/y
    },
    { name: "literal", pattern: /\b(?:false|null|true|NULL)\b/y },
    {
        name: "number",
        pattern: /\b(?:0[xX][\da-fA-F]+(?:\.[\da-fA-F]*)?(?:[pP][+-]?\d+)?|0[bB][01]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)(?:[uU](?:ll|LL|l|L)?|(?:ll|LL|l|L)[uU]?)?/y
    },
    { name: "function", pattern: /[A-Za-z_]\w*(?=\s*\()/y },
    {
        name: "operator",
        pattern: /<<=|>>=|\.\.\.|->|\+\+|--|&&|\|\||==|!=|<=|>=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<|>>|[=+\-*\/%&|^!~<>?:]/y
    },
    { name: "punctuation", pattern: /[{}()[\],;.]/y }
];
