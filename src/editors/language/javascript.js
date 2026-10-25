// Ordered rules: comments and strings own their contents before keywords
// and numbers can match inside them.
export default [
    {
        name: "comment",
        pattern: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y,
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
    { name: "keyword", pattern: /\b(?:async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|static|super|switch|this|throw|try|typeof|var|void|while|yield)\b/y },
    { name: "number", pattern: /\b\d+(?:\.\d+)?\b/y }
];
