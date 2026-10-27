import { createLanguageDetails } from "./language/createLanguageDetails.js";
import autoLanguageDetection from "./autoLanguageDetection.js";

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

/** Use a supported explicit label, otherwise infer from the source. */
export function resolveCodeLanguage(source, language) {
    const label = language == null ? "" : String(language).trim();
    const requested = label ? normalizeCodeLanguage(label) : "";
    if (label && requested === "text") return "text";
    return languageLoaders[requested] ? requested : autoLanguageDetection(source);
}

/** Load one language tokenizer so editors can reuse it for source updates. */
export async function loadCodeLanguage(language = "text") {
    language = normalizeCodeLanguage(language);
    const loader = languageLoaders[language];
    return loader ? loader() : null;
}

/** Select a copied language parser and return its source-preserving details. */
export async function parseCode(source, language, editor = null) {
    if (typeof source !== "string") throw new TypeError("Code source must be a string.");
    language = resolveCodeLanguage(source, language);
    const module = await loadCodeLanguage(language);
    if (!module) return createLanguageDetails(source, language, [], editor);
    return module.parseCode(source, editor);
}

export { autoLanguageDetection };

export default parseCode;
