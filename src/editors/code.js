import { setSourceRange } from "./utilities/ranges.js";
import { reconcileMirror } from "./utilities/mirror.js";
import observer from "@cocreate/observer";
export const codeRules = {};
const tokenizers = {};
const languages = new Map();
const loaders = {
    html: () => import(/* webpackChunkName: "editor-language-html" */ "./language/html.js"),
    javascript: () => import(/* webpackChunkName: "editor-language-javascript" */ "./language/javascript.js"),
    css: () => import(/* webpackChunkName: "editor-language-css" */ "./language/css.js"),
    json: () => import(/* webpackChunkName: "editor-language-json" */ "./language/json.js"),
    python: () => import(/* webpackChunkName: "editor-language-python" */ "./language/python.js"),
    typescript: () => import(/* webpackChunkName: "editor-language-typescript" */ "./language/typescript.js"),
    sql: () => import(/* webpackChunkName: "editor-language-sql" */ "./language/sql.js"),
    bash: () => import(/* webpackChunkName: "editor-language-bash" */ "./language/bash.js"),
    yaml: () => import(/* webpackChunkName: "editor-language-yaml" */ "./language/yaml.js"),
    c: () => import(/* webpackChunkName: "editor-language-c" */ "./language/c.js"),
    go: () => import(/* webpackChunkName: "editor-language-go" */ "./language/go.js"),
    java: () => import(/* webpackChunkName: "editor-language-java" */ "./language/java.js"),
    php: () => import(/* webpackChunkName: "editor-language-php" */ "./language/php.js")
};

export function loadLanguage(language = "text") {
    language = language.trim().toLowerCase();
    if (language === "js") language = "javascript";
    if (language === "py") language = "python";
    if (language === "ts") language = "typescript";
    if (language === "sh") language = "bash";
    if (language === "yml") language = "yaml";
    if (!Object.hasOwn(loaders, language)) return Promise.resolve();
    if (!languages.has(language)) {
        const loading = loaders[language]().then(module => {
            if (language === "html" || language === "json") tokenizers[language] = module.default;
            else if (language === "css") codeRules.css = module.default;
            else if (language === "python") codeRules.python = codeRules.py = module.default;
            else if (language === "typescript") codeRules.typescript = codeRules.ts = module.default;
            else if (language === "sql") codeRules.sql = module.default;
            else if (language === "bash") codeRules.bash = codeRules.sh = module.default;
            else if (language === "yaml") codeRules.yaml = codeRules.yml = module.default;
            else if (["c", "go", "java", "php"].includes(language)) codeRules[language] = module.default;
            else codeRules.javascript = codeRules.js = module.default;
        }).catch(error => {
            languages.delete(language);
            throw error;
        });
        languages.set(language, loading);
    }
    return languages.get(language);
}

let observerStarted = false;
function codeLanguageChanged(target) {
    if (target.getAttribute("editor")?.trim().toLowerCase() !== "code" &&
        !target.hasAttribute("editor-language")) return;
    const language = target.getAttribute("editor-language")?.trim().toLowerCase() || "text";
    loadLanguage(language).then(() => {
        if (!target.isConnected ||
            (target.getAttribute("editor-language")?.trim().toLowerCase() || "text") !== language)
            return;
        const EventConstructor = target.ownerDocument.defaultView.CustomEvent;
        target.dispatchEvent(new EventConstructor("cocreate-editor-language-change", {
            detail: { element: target }
        }));
    }).catch(error => {
        const EventConstructor = target.ownerDocument.defaultView.CustomEvent;
        target.dispatchEvent(new EventConstructor("editor-error", {
            bubbles: true, detail: { error }
        }));
    });
}

function startCodeObserver() {
    if (observerStarted) return;
    observerStarted = true;
    observer.init({
        name: "CoCreateCodeLanguage",
        types: ["attributes"],
        attributeFilter: ["editor-language"],
        selector: ":is([contenteditable], [editor], [editor-language])",
        callback({ target }) { codeLanguageChanged(target); }
    });
    document.querySelectorAll("[editor='code'], [editor-language]")
        .forEach(codeLanguageChanged);
}

function* ruleTokens(source, definitions) {
    const rules = definitions.map(rule => ({
        ...rule,
        pattern: new RegExp(rule.pattern.source, rule.pattern.flags.replace(/[gy]/g, "") + "y")
    }));
    let position = 0;
    while (position < source.length) {
        let matched = false;
        for (const rule of rules) {
            rule.pattern.lastIndex = position;
            const match = rule.pattern.exec(source);
            if (!match?.[0].length) continue;
            const end = position + match[0].length;
            const [contentStart, contentEnd] = rule.content?.(match[0]) ?? [0, match[0].length];
            yield { name: rule.name, start: position, end,
                contentStart: position + contentStart, contentEnd: position + contentEnd };
            position = end;
            matched = true;
            break;
        }
        if (!matched) position++;
    }
}

function mappedText(parent, source, start, end) {
    if (start === end) return;
    const node = parent.ownerDocument.createTextNode(source.slice(start, end));
    node._sourceMap = Array.from({ length: end - start }, (_, i) =>
        [start + i, start + i + 1]);
    parent.append(node);
}

export default function createCodeDOM(source, liveRoot, language = "text") {
    source = String(source ?? "");
    const doc = liveRoot?.ownerDocument || document;
    const staging = doc.createElement("div");
    setSourceRange(staging, {
        start: 0, contentStart: 0, contentEnd: source.length, end: source.length,
        kind: "root", language, tag: "div"
    });
    const tokens = tokenizers[language] ? tokenizers[language](source) : ruleTokens(source, codeRules[language] || []);
    let plain = 0;
    for (const token of tokens) {
        mappedText(staging, source, plain, token.start);
        const node = doc.createElement("span");
        node.className = `code-token code-${token.name}`;
        mappedText(node, source, token.start, token.end);
        setSourceRange(node, {
            start: token.start, contentStart: token.contentStart ?? token.start,
            contentEnd: token.contentEnd ?? token.end, end: token.end,
            kind: "token", language, tag: "span", void: false
        });
        staging.append(node);
        plain = token.end;
    }
    mappedText(staging, source, plain, source.length);
    if (!source || source.endsWith("\n")) {
        const placeholder = doc.createElement("br");
        placeholder.dataset.editorPlaceholder = "";
        setSourceRange(placeholder, {
            start: source.length, contentStart: source.length,
            contentEnd: source.length, end: source.length,
            kind: "placeholder", tag: "br", void: true
        });
        staging.append(placeholder);
    }
    if (liveRoot) reconcileMirror(staging, liveRoot);
    return staging;
}

export const mode = {
    prepare: loadLanguage,
    start: startCodeObserver,
    render(source, element) {
        const language = element.getAttribute("editor-language")?.trim().toLowerCase() || "text";
        return createCodeDOM(source, undefined, language);
    }
};
