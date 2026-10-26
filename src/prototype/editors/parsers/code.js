import { createLanguageDetails } from "./language/createLanguageDetails.js";

const languageLoaders = {
    html: () => import("./language/html.js"),
    javascript: () => import("./language/javascript.js"),
    css: () => import("./language/css.js"),
    json: () => import("./language/json.js"),
    python: () => import("./language/python.js"),
    typescript: () => import("./language/typescript.js"),
    sql: () => import("./language/sql.js"),
    bash: () => import("./language/bash.js"),
    yaml: () => import("./language/yaml.js"),
    c: () => import("./language/c.js"),
    go: () => import("./language/go.js"),
    java: () => import("./language/java.js"),
    php: () => import("./language/php.js")
};

const aliases = {
    js: "javascript",
    py: "python",
    ts: "typescript",
    sh: "bash",
    yml: "yaml"
};

export function normalizeCodeLanguage(language) {
    const value = String(language || "text").trim().toLowerCase();
    return aliases[value] || value;
}

/** Select a copied language parser and return its source-preserving details. */
export async function parseCode(source, language = "text", editor = null) {
    if (typeof source !== "string") throw new TypeError("Code source must be a string.");
    language = normalizeCodeLanguage(language);
    const loader = languageLoaders[language];
    if (!loader) return createLanguageDetails(source, language, [], editor);
    const module = await loader();
    return module.parseCode(source, editor);
}

export default parseCode;
