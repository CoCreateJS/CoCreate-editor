import { getEditorDetails, setEditorDetails } from "./utilities/details.js";
import { reconcileMirror } from "./utilities/mirror.js";
import { markPlaceholder, setSourceMap } from "./utilities/nodeData.js";
import observer from "@cocreate/observer";
import { applyIndexedDOM, getParsedDetails, setParsedDetails,
    observeIndexedDOM, mappedRecordStart } from "./utilities/indexedDOM.js";
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
    return loadLanguage(language).then(() => {
        if (!target.isConnected ||
            (target.getAttribute("editor-language")?.trim().toLowerCase() || "text") !== language)
            return;
        // Core owns refresh and history in this module's window, including
        // editors whose editable document lives inside an iframe.
        window.dispatchEvent(new CustomEvent("cocreate-editor-language-change", {
            detail: { element: target }
        }));
        return target.editor?.loading;
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
        callback({ target }) { return codeLanguageChanged(target); }
    });
}

function* ruleTokens(source, definitions) {
    const rules = definitions.map(rule => ({
        ...rule, definition: rule,
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
            yield { name: rule.name, definition: rule.definition, start: position, end,
                contentStart: position + contentStart, contentEnd: position + contentEnd };
            position = end;
            matched = true;
            break;
        }
        if (!matched) position++;
    }
}

// Tokens remain language-specific. Every renderer output is represented by
// the same flat range records, including text that has no highlighting rule.
function lineReferences(source) {
    const lines = [];
    let start = 0;
    while (true) {
        const newline = source.indexOf("\n", start);
        const end = newline < 0 ? source.length : newline;
        lines.push({ start, end, number: lines.length + 1 });
        if (newline < 0) return lines;
        start = newline + 1;
    }
}

function reusableRecords(root, change) {
    const parent = getEditorDetails(root), candidates = new Map(), children = new Map();
    for (const item of getParsedDetails(root)) {
        if (item.parentDetails === parent) {
            const start = mappedRecordStart(item, change);
            if (start !== null) candidates.set(`${start}:${item.kind}:${item.token || ""}`, item);
        } else if (item.kind === "text" && item.parentDetails?.kind === "token")
            children.set(item.parentDetails, item);
    }
    return { candidates, children };
}

function renderCode(source, liveRoot, language, previous) {
    source = String(source ?? "");
    language = String(language || "text").trim().toLowerCase();
    const doc = liveRoot?.ownerDocument || previous?.root.ownerDocument || document;
    const staging = doc.createElement("div"), records = [], lines = lineReferences(source);
    const tokenizer = Object.hasOwn(tokenizers, language) ? tokenizers[language] : null;
    const definitions = Object.hasOwn(codeRules, language) ? codeRules[language] : [];
    const reuse = previous && reusableRecords(previous.root, previous.change);
    const lineAt = position => {
        let low = 0, high = lines.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (lines[middle].start <= position) low = middle + 1;
            else high = middle;
        }
        return low;
    };
    const values = (kind, start, end) => ({ start, contentStart: start, contentEnd: end, end,
        kind, language, firstLine: lineAt(start), lastLine: lineAt(end) });
    const root = setEditorDetails(staging, { ...values("root", 0, source.length), tag: "div",
        lines, definition: tokenizer || definitions, parentDetails: null });
    records.push(root);

    const unchanged = (item, start, end) => item && item.end - item.start === end - start && (
        item.end <= previous.change.start || item.start >= previous.change.start + previous.change.length ||
        previous.source.slice(item.start,item.end) === source.slice(start,end)
    );
    const record = (node, fields, parent, reused = null) => {
        // Reused nodes get an independent metadata snapshot. Their canonical
        // record and source map are untouched until the complete plan commits.
        const item = reused
            ? Object.assign(Object.create(Object.getPrototypeOf(reused)), fields, { detachDOM: node, parentDetails: parent })
            : setEditorDetails(node, { ...fields, parentDetails: parent });
        records.push(item);
        return item;
    };
    const text = (parent, start, end, reused = null) => {
        if (start === end) return;
        const node = reused?.detachDOM || doc.createTextNode(source.slice(start,end));
        const item = record(node, values("text", start, end), parent, reused);
        if (!reused) {
            setSourceMap(node, Array.from({ length: end - start }, (_, i) => [start + i, start + i + 1]));
            parent.detachDOM.append(node);
        }
        return item;
    };
    const plain = (start, end) => {
        if (start === end) return;
        const old = reuse?.candidates.get(`${start}:text:`);
        text(root, start, end, unchanged(old,start,end) ? old : null);
    };

    const tokens = tokenizer ? tokenizer(source) : definitions.length ? ruleTokens(source, definitions) : [];
    let position = 0;
    for (const token of tokens) {
        plain(position, token.start);
        const old = reuse?.candidates.get(`${token.start}:token:${token.name}`);
        const child = old && reuse.children.get(old);
        const keep = unchanged(old,token.start,token.end) && child &&
            mappedRecordStart(child,previous.change) === token.start;
        const node = keep ? old.detachDOM : doc.createElement("span");
        if (!keep) node.className = `code-token code-${token.name}`;
        const contentStart = token.contentStart ?? token.start, contentEnd = token.contentEnd ?? token.end;
        const syntax = keep && old.contentStart - old.start === contentStart - token.start &&
            old.contentEnd - old.start === contentEnd - token.start ? old.syntax : {
                rule: token.name,
                opening: contentStart > token.start ? { start: 0, end: contentStart - token.start } : null,
                closing: contentEnd < token.end ? { start: contentEnd - token.start, end: token.end - token.start } : null
            };
        const item = record(node, { ...values("token", token.start, token.end),
            contentStart, contentEnd, token: token.name, tag: "span", void: false,
            definition: token.definition || tokenizer, syntax }, root, keep ? old : null);
        text(item, token.start, token.end, keep ? child : null);
        if (!keep) staging.append(node);
        position = token.end;
    }
    plain(position, source.length);
    if (!source || source.endsWith("\n")) {
        const old = reuse?.candidates.get(`${source.length}:placeholder:`);
        const node = old?.detachDOM || doc.createElement("br");
        record(node, { ...values("placeholder", source.length, source.length), tag: "br", void: true }, root, old);
        if (!old) { markPlaceholder(node); staging.append(node); }
    }
    setParsedDetails(staging, records);
    if (liveRoot) {
        reconcileMirror(staging, liveRoot);
        observeIndexedDOM(staging, root.editorElement, liveRoot);
    }
    return staging;
}

export default function createCodeDOM(source, liveRoot, language = "text") {
    return renderCode(source, liveRoot, language);
}

export const mode = {
    prepare: loadLanguage,
    start: startCodeObserver,
    render(source, element, change, previousRoot) {
        const language = element.getAttribute("editor-language")?.trim().toLowerCase() || "text";
        return renderCode(source, undefined, language, previousRoot && {
            root: previousRoot, change, source: String(element.value ?? "")
        });
    },
    apply: applyIndexedDOM,
    afterMirror(root, live, element) { observeIndexedDOM(root, element, live); }
};
