function isJSON(source) {
    try {
        JSON.parse(source);
        return true;
    } catch {
        return false;
    }
}

function isHTML(source) {
    return /^(?:<!doctype\b|<!--|<[A-Za-z][\w:-]*(?:\s[^<>]*?)?\/?\s*>|<\/[A-Za-z][\w:-]*\s*>)/i.test(source);
}

function isCSS(source) {
    if (/^\s*@[\w-]+\b/m.test(source)) return true;
    const blocks = source.matchAll(/([^{}\n]+)\{([^{}]*)\}/g);
    for (const [, selector, body] of blocks) {
        const head = selector.trim();
        const declarations = body.match(/(?:^|;)\s*(?:--[\w-]+|[\w-]+)\s*:\s*[^;{}]+/g);
        if (declarations?.length &&
            /^(?:[A-Za-z][\w-]*|[.#*:[\]])[\w\s.#:[\]()*+>,~\-]*$/.test(head)) return true;
    }
    return false;
}

/**
 * Guess a supported tokenizer from source syntax. This is deliberately
 * conservative: ambiguous or incomplete snippets remain plain text.
 */
export function autoLanguageDetection(value) {
    if (typeof value !== "string") throw new TypeError("Code source must be a string.");
    const source = value.trim();
    if (!source) return "text";

    if (isJSON(source)) return "json";
    if (/^<\?php\b/i.test(source)) return "php";
    if (isHTML(source)) return "html";
    if (/^\s*(?:SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(?:TABLE|DATABASE|VIEW)|ALTER\s+TABLE)\b/i.test(source))
        return "sql";
    if (/^\s*(?:from\s+[\w.]+\s+import|async\s+def|def\s+\w+\s*\(|class\s+\w+\s*\([^)]*\)\s*:)/m.test(source))
        return "python";
    if (/^\s*#!.*\b(?:ba)?sh\b|^\s*(?:echo\s+|export\s+\w+=|then\s*$|fi\s*$)/m.test(source))
        return "bash";
    if (/^\s*package\s+\w+\s*;?\s*$/m.test(source) && /^\s*func\s+\w+/m.test(source))
        return "go";
    if (/^\s*public\s+(?:final\s+)?class\s+\w+|^\s*import\s+java\./m.test(source))
        return "java";
    if (/^\s*#include\s*[<"]|^\s*int\s+main\s*\(/m.test(source)) return "c";
    if (/^\s*(?:interface|namespace|enum)\s+\w+|^\s*type\s+\w+\s*=|\b(?:implements|readonly)\b/m.test(source))
        return "typescript";
    if (/\b(?:const|let|var|function|class|export|async|await|return|throw|new|console|document|window)\b|=>|===|!==/.test(source))
        return "javascript";
    if (isCSS(source)) return "css";
    if (/^\s*[\w.-]+\s*:\s*\S+/m.test(source) && !/[{};]/.test(source)) return "yaml";

    return "text";
}

export default autoLanguageDetection;
