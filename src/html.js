import {
    syntaxRules,
    voidElements,
    codeRule,
    fenceRule,
    makeElement,
    applyAttributes
} from "./config.js";

const entities = /&(?:#(?:x[\da-fA-F]+|\d+)|[A-Za-z][A-Za-z\d]+);/g;
function text(parent, raw, start) {
    const node = document.createTextNode(""),
        spans = [];
    let value = "",
        last = 0,
        match;
    const append = (part, offset, entity = false) => {
        let decoded = part;
        if (entity) {
            const decoder = document.createElement("textarea");
            decoder.innerHTML = part;
            decoded = decoder.value;
        }
        for (let i = 0; i < decoded.length; i++)
            spans.push(
                entity
                    ? [offset, offset + part.length]
                    : [offset + i, offset + i + 1]
            );
        value += decoded;
    };
    const re = new RegExp(entities.source, "g");
    while ((match = re.exec(raw))) {
        append(raw.slice(last, match.index), start + last);
        append(match[0], start + match.index, true);
        last = re.lastIndex;
    }
    append(raw.slice(last), start + last);
    if (!value) return;
    node.data = value;
    node._sourceMap = spans;
    parent.append(node);
}
// A trailing newline needs an editable line after it, just like the Markdown projection.
function terminalLines(parent) {
    const last = parent.lastChild;
    if (
        !last &&
        parent.hasAttribute("data-source-content-start") &&
        !parent.hasAttribute("data-source-void") &&
        /^(?:P|DIV|H[1-6]|PRE|BLOCKQUOTE|LI)$/.test(parent.tagName)
    ) {
        const placeholder = document.createElement("br");
        placeholder.dataset.mdPlaceholder = "";
        parent.append(placeholder);
        return;
    }
    if (last?.nodeType !== 3 || !last._sourceMap) return;
    const count = (last.data.match(/\n+$/) || [""])[0].length;
    if (!count) return;
    const maps = last._sourceMap.slice(-count);
    last.data = last.data.slice(0, -count);
    last._sourceMap = last._sourceMap.slice(0, -count);
    if (!last.length) last.remove();
    for (const [start, end] of maps) {
        const br = document.createElement("br");
        br.dataset.sourceStart = start;
        br.dataset.sourceAfter = end;
        br.dataset.sourceVoid = "";
        parent.append(br);
    }
    const placeholder = document.createElement("br");
    placeholder.dataset.mdPlaceholder = "";
    parent.append(placeholder);
}
function tagInfo(raw) {
    const match = /^<(\/?)\s*([A-Za-z][\w-]*)([\s\S]*?)\s*(\/?)>$/.exec(raw);
    if (!match) return null;
    const closing = !!match[1],
        attrs = match[3];
    if (closing && (attrs.trim() || match[4])) return null;
    let rest = attrs;
    while (rest.trim()) {
        rest = rest.trimStart();
        const attribute =
            /^[A-Za-z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/.exec(
                rest
            );
        if (!attribute) return null;
        rest = rest.slice(attribute[0].length);
    }
    return { name: match[2].toLowerCase(), closing, attrs, self: !!match[4] };
}
const documentTags = new Set(
    "html head body title style script main header footer section article aside nav span a b i u s small mark sup sub time address dl dt dd table caption colgroup thead tbody tfoot tr th td form label button select option optgroup textarea fieldset legend figure figcaption picture audio video details summary dialog noscript template".split(
        " "
    )
);
function definition(name, documentMode = false) {
    if (name === "code") return codeRule;
    if (name === "pre") return fenceRule;
    const configured = syntaxRules.find((rule) =>
        rule.html?.tags.includes(name)
    );
    if (voidElements.includes(name))
        return configured
            ? { ...configured, html: { ...configured.html, void: true } }
            : { name, tag: name, html: { tags: [name], void: true } };
    if (configured) return configured;
    if (documentMode && documentTags.has(name))
        return {
            name,
            tag: name,
            literal: ["title", "style", "script", "textarea"].includes(name),
            html: { tags: [name] }
        };
}
function attrs(node, info, rule) {
    const allowed = rule.html.attributes || ["class", "title"];
    const attributes = {},
        re =
            /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    let match;
    while ((match = re.exec(info.attrs))) {
        const name = match[1].toLowerCase();
        if (!allowed.includes(name)) continue;
        const temp = document.createElement("span");
        text(temp, match[2] ?? match[3] ?? match[4], 0);
        attributes[name] = temp.textContent;
    }
    applyAttributes(node, attributes);
    if (node.tagName === "A") node.rel = "noopener noreferrer";
}
export function renderHTML(source, { documentMode = false } = {}) {
    const staging = document.createElement("div");
    const tokens = [],
        re =
            /<!--[\s\S]*?-->|<!DOCTYPE\s+(?:[^>"']|"[^"]*"|'[^']*')*>|<\/?[A-Za-z](?:[^<>"']|"[^"]*"|'[^']*')*>|&(?:#(?:x[\da-fA-F]+|\d+)|[A-Za-z][A-Za-z\d]+);|[^<&]+|[<&]/gi;
    let match;
    while ((match = re.exec(source)))
        tokens.push({
            raw: match[0],
            start: match.index,
            end: re.lastIndex,
            info: tagInfo(match[0])
        });
    const pairs = new Map(),
        stack = [];
    for (let i = 0; i < tokens.length; i++) {
        const info = tokens[i].info,
            rule = info && definition(info.name, documentMode);
        if (!rule) continue;
        if (rule.html.void) {
            if (!info.closing) pairs.set(i, i);
            continue;
        }
        if (!info.closing && rule.literal) {
            let close = i + 1;
            while (
                close < tokens.length &&
                !(
                    tokens[close].info?.closing &&
                    tokens[close].info.name === info.name
                )
            )
                close++;
            if (close < tokens.length) pairs.set(i, close);
            // Everything through the close (or EOF) is protected from tag matching.
            i = close;
            continue;
        }
        if (info.closing) {
            let found = stack.length - 1;
            while (found >= 0 && stack[found].name !== info.name) found--;
            if (found >= 0) {
                pairs.set(stack[found].index, i);
                stack.splice(found);
            }
        } else if (!info.self) stack.push({ name: info.name, index: i });
    }
    function range(parent, start, end) {
        for (let i = start; i < end; i++) {
            const token = tokens[i],
                info = token.info,
                rule = info && definition(info.name, documentMode),
                close = pairs.get(i);
            if (rule && !info.closing && rule.literal && close === undefined) {
                text(
                    parent,
                    source.slice(
                        token.start,
                        end < tokens.length ? tokens[end].start : source.length
                    ),
                    token.start
                );
                terminalLines(parent);
                return;
            }
            if (documentMode && /^<!doctype\s/i.test(token.raw)) {
                staging.sourceDoctype = token.raw;
                continue;
            }
            if (documentMode && token.raw.startsWith("<!--")) {
                parent.append(document.createComment(token.raw.slice(4, -3)));
                continue;
            }
            if (!rule || info.closing || close === undefined) {
                text(parent, token.raw, token.start);
                continue;
            }
            const node = makeElement(rule, info);
            attrs(node, info, rule);
            if (documentMode) {
                const raw = document.createElement("template");
                // Parse attributes only; source content is still rendered by the mapped parser.
                raw.innerHTML = `<span ${info.attrs}></span>`;
                for (const attribute of raw.content.firstChild?.attributes ||
                    []) {
                    const name = attribute.name;
                    if (
                        /^on/i.test(name) ||
                        /^srcdoc$/i.test(name) ||
                        /^data-(?:md|source)-/.test(name)
                    )
                        continue;
                    if (
                        [
                            "href",
                            "src",
                            "action",
                            "formaction",
                            "poster",
                            "data",
                            "srcset"
                        ].includes(name) &&
                        /(?:javascript|vbscript|data):/i.test(
                            attribute.value.replace(
                                /[\u0000-\u0020\u007f]/g,
                                ""
                            )
                        )
                    )
                        continue;
                    if (
                        name === "http-equiv" &&
                        attribute.value.toLowerCase() === "refresh"
                    )
                        continue;
                    node.setAttribute(name, attribute.value);
                }
                if (info.name === "script")
                    node.type = "application/x-cocreate-inert";
            }
            const closeToken = tokens[close];
            node.dataset.sourceStart = token.start;
            node.dataset.sourceAfter = closeToken.end;
            node.dataset.sourceContentStart = token.end;
            node.dataset.sourceContentEnd =
                close === i ? token.end : closeToken.start;
            if (rule.html.void) {
                node.dataset.sourceVoid = "";
                if (node.tagName === "HR") node.contentEditable = "false";
            } else if (
                documentMode &&
                ["style", "script"].includes(info.name)
            ) {
                const raw = source.slice(token.end, closeToken.start);
                const rawText = document.createTextNode(raw);
                rawText._sourceMap = Array.from(
                    { length: raw.length },
                    (_, i) => [token.end + i, token.end + i + 1]
                );
                node.append(rawText);
            } else if (rule.literal)
                text(
                    node,
                    source.slice(token.end, closeToken.start),
                    token.end
                );
            else range(node, i + 1, close);
            terminalLines(node);
            parent.append(node);
            i = close;
        }
    }
    range(staging, 0, tokens.length);
    terminalLines(staging);
    return staging;
}
