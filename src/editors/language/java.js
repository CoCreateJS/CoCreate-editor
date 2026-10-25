// Lightweight Java tokens cover common source syntax and text blocks while
// leaving type resolution and the Java grammar to a real parser.
export default [
    {
        name: "comment",
        pattern: /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/y,
        content: raw => raw.startsWith("//")
            ? [2, raw.length]
            : [2, raw.endsWith("*/") ? raw.length - 2 : raw.length]
    },
    {
        name: "string",
        pattern: /"""[\s\S]*?(?:"""|$)|"(?:\\.|[^"\\\n])*(?:"|(?=\n|$))|'(?:\\.|[^'\\\n])*(?:'|(?=\n|$))/y,
        content: raw => {
            const delimiter = raw.startsWith('"""') ? 3 : 1;
            const closed = raw.length >= delimiter * 2 &&
                raw.endsWith(delimiter === 3 ? '"""' : raw[0]);
            return [delimiter, raw.length - (closed ? delimiter : 0)];
        }
    },
    { name: "annotation", pattern: /@[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/y },
    { name: "literal", pattern: /\b(?:false|null|true)\b/y },
    {
        name: "keyword",
        pattern: /\b(?:abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|exports|extends|final|finally|float|for|goto|if|implements|import|instanceof|int|interface|long|module|native|new|open|opens|package|permits|private|protected|provides|public|record|requires|return|sealed|short|static|strictfp|super|switch|synchronized|this|throw|throws|to|transient|transitive|try|uses|var|void|volatile|while|with|yield)\b/y
    },
    { name: "type", pattern: /\b[A-Z][A-Za-z\d_$]*\b/y },
    {
        name: "number",
        pattern: /\b(?:0[xX][\da-fA-F](?:_?[\da-fA-F])*(?:\.[\da-fA-F](?:_?[\da-fA-F])*)?(?:[pP][+-]?\d(?:_?\d)*)?[fFdDlL]?|0[bB][01](?:_?[01])*[lL]?|\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?(?:[eE][+-]?\d(?:_?\d)*)?[fFdDlL]?)/y
    },
    { name: "function", pattern: /[A-Za-z_$][\w$]*(?=\s*\()/y },
    {
        name: "operator",
        pattern: />>>=|>>>|<<=|>>=|>>>|\.\.\.|->|::|\+\+|--|&&|\|\||==|!=|<=|>=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<|>>|[=+\-*\/%&|^!~<>?:@]/y
    },
    { name: "punctuation", pattern: /[{}()[\],;.]/y }
];
