// Lightweight PHP tokens cover common embedded and standalone source syntax.
// PHP/HTML transitions and interpolations inside strings are not parsed.
export default [
    {
        name: "comment",
        pattern: /\/\/[^\r\n]*|#(?!\[)[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/y,
        content: raw => raw.startsWith("/*")
            ? [2, raw.endsWith("*/") ? raw.length - 2 : raw.length]
            : [2, raw.length]
    },
    {
        name: "string",
        pattern: /"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|`(?:\\.|[^`\\])*(?:`|$)/y,
        content: raw => {
            let slashes = 0;
            for (let i = raw.length - 2; i >= 0 && raw[i] === "\\"; i--)
                slashes++;
            const closed = raw.length > 1 && raw.at(-1) === raw[0] && slashes % 2 === 0;
            return [1, raw.length - (closed ? 1 : 0)];
        }
    },
    { name: "tag", pattern: /<\?(?:php\b|=)|\?>/iy },
    { name: "variable", pattern: /\$\{[^}]*\}|\$\$?[A-Za-z_][\w]*|\$[0-9]+/y },
    { name: "literal", pattern: /\b(?:false|null|true)\b/iy },
    {
        name: "keyword",
        pattern: /\b(?:__halt_compiler|abstract|and|as|break|callable|case|catch|class|clone|const|continue|declare|default|die|do|echo|else|elseif|empty|enddeclare|endfor|endforeach|endif|endswitch|endwhile|enum|eval|exit|extends|final|finally|fn|for|foreach|from|function|global|goto|if|implements|include|include_once|instanceof|insteadof|interface|isset|list|match|namespace|new|or|print|private|protected|public|readonly|require|require_once|return|static|switch|throw|trait|try|unset|use|var|while|xor|yield)\b/iy
    },
    { name: "type", pattern: /\b(?:array|bool|boolean|callable|float|int|integer|iterable|mixed|never|null|object|string|void)\b/iy },
    {
        name: "number",
        pattern: /\b(?:0[xX][\da-fA-F](?:_?[\da-fA-F])*|0[bB][01](?:_?[01])*|0[oO][0-7](?:_?[0-7])*|\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?(?:[eE][+-]?\d(?:_?\d)*)?)/y
    },
    { name: "function", pattern: /[A-Za-z_][\w]*(?=\s*\()/y },
    {
        name: "operator",
        pattern: /\?->|<=>|\?\?=|\*\*=|<<=|>>=|===|!==|\.\.\.|=>|->|::|\?\?|\+\+|--|&&|\|\||==|!=|<=|>=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<|>>|[=+\-*\/%&|^!~<>?:.]/y
    },
    { name: "punctuation", pattern: /[{}()[\],;]/y }
];
