import { applyIndexedDOM, getParsedDetails, setParsedDetails, setUpdateRegion, observeIndexedDOM, hasIndexedMutations } from "./utilities/indexedDOM.js";
import { brokenHTMLRanges } from "./utilities/recovery.js";
import { setHTMLAttribute, getHTMLAttributes, getHTMLAttribute, removeHTMLAttribute } from "./utilities/setAttribute.js";
import {
    syntaxRules,
    voidElements,
    codeRule,
    fenceRule,
    makeElement,
    applyAttributes
} from "./utilities/config.js";
import { getEditorDetails, setEditorDetails, findEditorDetailsContaining } from "./utilities/details.js";
import { reconcileMirror, reconcileDoctype } from "./utilities/mirror.js";
import { getSourceMap, markPlaceholder, setSourceMap } from "./utilities/nodeData.js";

const entities = /&(?:#(?:x[\da-fA-F]+|\d+)|[A-Za-z][A-Za-z\d]+);/g;
function text(parent, raw, start, literal = false) {
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
    const re = new RegExp(literal ? "(?!)" : entities.source, "g");
    while ((match = re.exec(raw))) {
        append(raw.slice(last, match.index), start + last);
        append(match[0], start + match.index, true);
        last = re.lastIndex;
    }
    append(raw.slice(last), start + last);
    if (!value) return;
    node.data = value;
    setSourceMap(node, spans);
    setEditorDetails(node, {
        start, contentStart: start, contentEnd: start + raw.length,
        end: start + raw.length, kind: "text", literal
    });
    parent.append(node);
    return node;
}
function appendPlaceholder(parent, position) {
    const node = parent.ownerDocument.createElement("br");
    markPlaceholder(node);
    setEditorDetails(node, {
        start: position, contentStart: position, contentEnd: position, end: position,
        kind: "placeholder", tag: "br", void: true
    });
    parent.append(node);
    return node;
}
// A trailing newline needs an editable line after it, just like the Markdown projection.
function terminalLines(parent, record = () => {}) {
    const last = parent.lastChild;
    const position = getEditorDetails(parent);
    if (
        !last &&
        position && !position.void &&
        /^(?:P|DIV|H[1-6]|PRE|BLOCKQUOTE|LI)$/.test(parent.tagName)
    ) {
        record(appendPlaceholder(parent, position.contentStart));
        return;
    }
    const sourceMap = getSourceMap(last);
    if (last?.nodeType !== 3 || !sourceMap) return;
    const count = (last.data.match(/\n+$/) || [""])[0].length;
    if (!count) return;
    const maps = sourceMap.slice(-count);
    last.data = last.data.slice(0, -count);
    setSourceMap(last, sourceMap.slice(0, -count));
    const details = getEditorDetails(last);
    if (details) details.end = details.contentEnd = maps[0][0];
    if (!last.length) last.remove();
    for (const [start, end] of maps) {
        const br = document.createElement("br");
        setEditorDetails(br, { start, contentStart: start, contentEnd: end, end,
            kind: "newline", void: true, positionBoundary: true });
        parent.append(br);
        record(br);
    }
    record(appendPlaceholder(parent, maps.at(-1)[1]));
}
function tagInfo(raw) {
    const match = /^<(\/?)\s*([A-Za-z][\w-]*)([\s\S]*?)\s*(\/?)>$/.exec(raw);
    if (!match) return null;
    const closing = !!match[1],
        attrs = match[3];
    if (closing && (attrs.trim() || match[4])) return null;
    const name = match[2].toLowerCase(), self = !!match[4];
    // Only the factual whitelist can use />. A bare void start tag stays text;
    // a slash never makes a normal/custom HTML element self-closing.
    if (voidElements.includes(name) ? closing || !self : self) return null;
    let rest = attrs;
    while (rest) {
        const space = /^\s+/.exec(rest);
        if (!space) return null;
        rest = rest.slice(space[0].length);
        if (!rest) break;
        const attribute =
            /^[A-Za-z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/.exec(
                rest
            );
        if (!attribute) return null;
        rest = rest.slice(attribute[0].length);
    }
    return { name, closing, attrs, self };
}

// Decide complete tokens before constructing any projected elements. An
// unfinished syntax remains literal through its recovery boundary, without
// consuming complete enclosing elements.
function tokenize(source, documentMode) {
    const tokens = [], ancestors = [];
    const parentBoundary = (start, unfinishedName) => {
        let end = source.length;
        for (const name of new Set(unfinishedName ? [...ancestors, unfinishedName] : ancestors)) {
            const closing = new RegExp(`</${name}\\s*>`, "gi");
            closing.lastIndex = start;
            const match = closing.exec(source);
            if (match) end = Math.min(end, match.index);
        }
        return end;
    };
    const push = (start, end, complete = false) => {
        const raw = source.slice(start, end);
        const token = { raw, start, end, complete, info: complete ? tagInfo(raw) : null };
        tokens.push(token);
        const info = token.info;
        if (info && !voidElements.includes(info.name)) {
            if (!info.closing) ancestors.push(info.name);
            else {
                const index = ancestors.lastIndexOf(info.name);
                if (index >= 0) ancestors.splice(index);
            }
        }
        return token;
    };
    let start = 0;
    while (start < source.length) {
        const limit = source.length;
        if (source[start] !== "<") {
            const next = source.indexOf("<", start);
            const end = next < 0 ? source.length : next;
            push(start, end);
            start = end;
            continue;
        }
        if (source.startsWith("<!--", start)) {
            const close = source.indexOf("-->", start + 4);
            const complete = close >= 0 && close + 3 <= limit;
            const end = complete ? close + 3 : Math.min(limit, parentBoundary(start + 4));
            push(start, end, complete);
            start = end;
            continue;
        }
        if (!/^<\/?[A-Za-z]/.test(source.slice(start, start + 3)) &&
            !/^<!doctype(?:\s|>)/i.test(source.slice(start, start + 11))) {
            push(start, start + 1);
            start++;
            continue;
        }
        let quote = null, end = start + 1;
        for (; end < limit; end++) {
            const char = source[end];
            if (quote) {
                if (char === quote) quote = null;
            } else if (char === '"' || char === "'") quote = char;
            else if (char === ">" || char === "<") break;
        }
        // A new unquoted opener is a recovery boundary, not part of this tag.
        let complete = end < limit && source[end] === ">";
        if (complete) end++;
        // Only malformed/unfinished tags recover at an enclosing close. A
        // complete quoted value may legitimately contain a literal </parent>.
        if (!complete || !tagInfo(source.slice(start, end))) {
            const unfinishedName = /^<([A-Za-z][\w-]*)/.exec(source.slice(start, end))?.[1].toLowerCase();
            const boundary = parentBoundary(start + 1, unfinishedName);
            if (boundary < end) {
                end = boundary;
                complete = false;
            }
        }
        const token = push(start, end, complete);
        start = end;
        const info = token.info, rule = info && definition(info.name, documentMode);
        if (rule?.literal && !rule.html.void && !info.closing) {
            // Code/raw-text bodies have their own fence. Tag-like strings or
            // unmatched quotes inside them must not hide their closing tag.
            const closing = new RegExp(`</${info.name}\\s*>`, "gi");
            closing.lastIndex = end;
            const close = closing.exec(source);
            const bodyLimit = source.length;
            if (!close || close.index > bodyLimit) {
                const boundary = parentBoundary(end);
                if (boundary > end) push(end, boundary);
                start = boundary;
            } else {
                if (close.index > end) push(end, close.index);
                push(close.index, closing.lastIndex, true);
                start = closing.lastIndex;
            }
        }
    }
    return tokens;
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
    if (configured)
        return { ...configured, html: { ...configured.html, void: false } };
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
function renderHTML(source, { documentMode = true, literalRanges = [] } = {}) {
    const staging = document.createElement("div");
    const records = [];
    const record = node => { if (node) records.push(getEditorDetails(node)); };
    const writeText = (parent, ...args) => record(text(parent, ...args));
    const finishLines = parent => terminalLines(parent, record);
    const tokens = tokenize(source, documentMode);
    const pairs = new Map(),
        broken = new Map(),
        lexicalEnds = new Map(),
        pending = new Map(),
        stack = [];
    // Locate same-name closes independently of nesting. An unfinished child
    // inside a complete parent is literal content, not a crossed parent tag.
    // A child whose close is *after* its parent's close is genuinely crossed.
    for (let i = 0; i < tokens.length; i++) {
        const info = tokens[i].info;
        if (!info || voidElements.includes(info.name)) continue;
        let openings = pending.get(info.name);
        if (!openings) pending.set(info.name, openings = []);
        if (!info.closing) openings.push(i);
        else if (openings.length) lexicalEnds.set(openings.pop(), i);
    }
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i], parsed = token.info,
            shape = token.complete && /^<(\/?)([A-Za-z][\w-]*)\b/.exec(token.raw),
            info = parsed || (shape && {
                name: shape[2].toLowerCase(), closing: !!shape[1],
                self: /\/>$/.test(token.raw)
            }),
            rule = info && definition(info.name, documentMode);
        if (!info) continue;
        if (voidElements.includes(info.name)) {
            if (parsed && !info.closing) pairs.set(i, i);
            continue;
        }
        if (parsed && !info.closing && rule?.literal) {
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
            // Closed raw regions protect their body tokens. Unfinished regions
            // remain literal within the enclosing content boundary.
            if (close < tokens.length) i = close;
            continue;
        }
        if (info.closing) {
            let found = stack.length - 1;
            while (found >= 0 && stack[found].name !== info.name) found--;
            if (found >= 0) {
                const entry = stack[found];
                const crossed = stack.slice(found + 1).some(
                    (child) => lexicalEnds.get(child.index) > i
                );
                // Unmatched children stay text inside this wrapper. Only an
                // invalid wrapper or an actual crossing makes it literal too.
                if (!crossed && entry.valid && parsed)
                    pairs.set(entry.index, i);
                else broken.set(entry.index, i);
                stack.splice(found);
            }
        } else if (!info.self)
            stack.push({ name: info.name, index: i, valid: !!parsed });
    }
    function range(parent, start, end) {
        let literalRemainder = false;
        for (let i = start; i < end; i++) {
            const token = tokens[i],
                info = token.info,
                rule = info && definition(info.name, documentMode),
                close = pairs.get(i) < end ? pairs.get(i) : undefined;
            const brokenEnd = broken.get(i);
            const forced = literalRanges.find(range => range.start === token.start);
            if (forced) {
                const finish = Math.min(forced.end, end < tokens.length ? tokens[end].start : source.length);
                writeText(parent, source.slice(forced.start, finish), forced.start, true);
                while (i + 1 < end && tokens[i + 1].start < finish) i++;
                // A normalized replacement can end inside a token. Preserve
                // its surviving suffix instead of dropping it with that token.
                if (tokens[i].end > finish)
                    writeText(parent, source.slice(finish, tokens[i].end), finish, true);
                continue;
            }
            // A malformed opening tag owns its remaining source through its
            // matching close. Keep its descendants literal; the current range
            // ends before a valid enclosing parent's close.
            const malformedName = !info && /^<([A-Za-z][\w-]*)\b/.exec(token.raw)?.[1]?.toLowerCase();
            if (malformedName) {
                let depth = 0, closing = -1;
                for (let j = i + 1; j < end; j++) {
                    const candidate = tokens[j].info;
                    if (candidate?.name !== malformedName) continue;
                    if (!candidate.closing) depth++;
                    else if (depth) depth--;
                    else { closing = j; break; }
                }
                const finish = closing < 0
                    ? (end < tokens.length ? tokens[end].start : source.length)
                    : tokens[closing].end;
                writeText(parent, source.slice(token.start, finish), token.start, true);
                if (closing < 0) return;
                i = closing;
                continue;
            }
            if (brokenEnd !== undefined && brokenEnd < end) {
                writeText(parent, source.slice(token.start, tokens[brokenEnd].end), token.start, true);
                i = brokenEnd;
                continue;
            }
            if (rule && !info.closing && close === undefined && !rule.html.void) {
                writeText(
                    parent,
                    source.slice(
                        token.start,
                        end < tokens.length ? tokens[end].start : source.length
                    ),
                    token.start,
                    true
                );
                finishLines(parent);
                return;
            }
            if (documentMode && token.complete && /^<!doctype\s/i.test(token.raw)) {
                staging.sourceDoctype = token.raw;
                continue;
            }
            if (documentMode && token.complete && token.raw.startsWith("<!--")) {
                const comment = document.createComment(token.raw.slice(4, -3));
                setEditorDetails(comment, { start: token.start, contentStart: token.start,
                    contentEnd: token.end, end: token.end, kind: "comment" });
                parent.append(comment);
                record(comment);
                continue;
            }
            if (!rule && close !== undefined) {
                writeText(parent, source.slice(token.start, tokens[close].end), token.start, true);
                i = close;
                continue;
            }
            if (!rule || info.closing || close === undefined) {
                if (close === undefined && /^<[A-Za-z]/.test(token.raw))
                    literalRemainder = true;
                writeText(parent, token.raw, token.start,
                    literalRemainder || token.raw.startsWith("<"));
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
            setEditorDetails(node, {
                start: token.start,
                contentStart: token.end,
                contentEnd: close === i ? token.end : closeToken.start,
                end: closeToken.end,
                kind: "element",
                tag: info.name,
                void: !!rule.html.void,
                positionBoundary: true
            });
            record(node);
            if (rule.html.void) {
                if (node.tagName === "HR") node.contentEditable = "false";
            } else if (
                documentMode &&
                ["style", "script"].includes(info.name)
            ) {
                const raw = source.slice(token.end, closeToken.start);
                const rawText = document.createTextNode(raw);
                setSourceMap(rawText, Array.from(
                    { length: raw.length },
                    (_, i) => [token.end + i, token.end + i + 1]
                ));
                setEditorDetails(rawText, { start: token.end, contentStart: token.end,
                    contentEnd: closeToken.start, end: closeToken.start, kind: "text", literal: true });
                node.append(rawText);
                record(rawText);
            } else if (rule.literal)
                writeText(
                    node,
                    source.slice(token.end, closeToken.start),
                    token.end
                );
            else range(node, i + 1, close);
            finishLines(node);
            parent.append(node);
            i = close;
        }
    }
    range(staging, 0, tokens.length);
    finishLines(staging);
    const attached = records.filter(item => item.detachDOM.parentNode);
    for (const item of attached) item.parentDetails = getEditorDetails(item.detachDOM.parentNode) || null;
    setParsedDetails(staging, attached);
    return staging;
}

export default function createDOM(source, ownerDocument = document, liveRoot, literalRanges) {
    const fragment = renderHTML(source, { literalRanges });
    const staged = ownerDocument.implementation.createHTMLDocument("");
    const root = [...fragment.children].find((node) => node.tagName === "HTML");
    if (root)
        staged.replaceChild(staged.adoptNode(root), staged.documentElement);
    else {
        const head = [...fragment.children].find(
            (node) => node.tagName === "HEAD"
        );
        const body = [...fragment.children].find(
            (node) => node.tagName === "BODY"
        );
        if (head) staged.documentElement.replaceChild(head, staged.head);
        if (body) staged.documentElement.replaceChild(body, staged.body);
        for (const node of [...fragment.childNodes]) staged.body.append(node);
    }
    if (!staged.head)
        staged.documentElement.prepend(staged.createElement("head"));
    if (!staged.body)
        staged.documentElement.append(staged.createElement("body"));
    for (const node of [staged.documentElement, staged.body])
        if (!getEditorDetails(node)) setEditorDetails(node, {
            start: 0, contentStart: 0, contentEnd: source.length, end: source.length,
            kind: "root", tag: node.localName
        });
    if (!getEditorDetails(staged.head)) {
        const start = getEditorDetails(staged.documentElement).contentStart;
        setEditorDetails(staged.head, {
            start, contentStart: start, contentEnd: start, end: start,
            kind: "root", tag: "head"
        });
    }
    let placeholder;
    if (!staged.body.childNodes.length)
        placeholder = appendPlaceholder(staged.body, getEditorDetails(staged.body).contentEnd);
    staged.doctype?.remove();
    if (fragment.sourceDoctype) {
        const parsed =
            new ownerDocument.defaultView.DOMParser().parseFromString(
                fragment.sourceDoctype,
                "text/html"
            );
        if (parsed.doctype)
            staged.insertBefore(
                staged.importNode(parsed.doctype, true),
                staged.documentElement
            );
    }
    const records = getParsedDetails(fragment).filter(item => item.detachDOM.parentNode);
    if (placeholder) records.push(getEditorDetails(placeholder));
    for (const node of [staged.documentElement, staged.head, staged.body]) {
        const item = getEditorDetails(node);
        if (!records.includes(item)) records.push(item);
    }
    for (const item of records) item.parentDetails = getEditorDetails(item.detachDOM.parentNode) || null;
    setParsedDetails(staged, records);
    if (liveRoot) {
        const iframeDocument = liveRoot === liveRoot.ownerDocument.documentElement;
        reconcileMirror(iframeDocument ? staged.documentElement : staged.body, liveRoot);
        if (iframeDocument) reconcileDoctype(staged, liveRoot.ownerDocument);
        observeIndexedDOM(staged, getEditorDetails(iframeDocument ? staged.documentElement : staged.body).editorElement, liveRoot);
    }
    return staged;
}


// Only the enclosing element is parsed for a content edit. Its unchanged tags
// provide the same recovery boundary as the full parser. If new syntax escapes
// that boundary, use the document plan instead.
function renderRegion(source, element, change) {
    const end = change.start + change.length;
    let boundary = findEditorDetailsContaining(element, change.start, end);
    while (boundary && !(boundary.kind === "element" && !boundary.void &&
        boundary.contentStart <= change.start && end <= boundary.contentEnd))
        boundary = boundary.parentDetails;
    if (!boundary || ["html", "head", "body"].includes(boundary.tag)) return;
    const offset = boundary.start, finish = boundary.end + change.value.length - change.length;
    const raw = source.slice(offset, finish);
    const parse = literalRanges => {
        const staging = renderHTML(raw, { literalRanges });
        const records = getParsedDetails(staging);
        for (const item of records) {
            for (const name of ["start", "contentStart", "contentEnd", "end"]) item[name] += offset;
            const map = getSourceMap(item.detachDOM);
            if (map) setSourceMap(item.detachDOM, map.map(([start, end]) => [start + offset, end + offset]));
        }
        return staging;
    };
    let staging = parse();
    const literal = brokenHTMLRanges(element.editor.editorDetails, getParsedDetails(staging), change)
        .filter(range => offset <= range.start && range.end <= finish)
        .map(range => ({ start: range.start - offset, end: range.end - offset }));
    if (literal.length) staging = parse(literal);
    const roots = getParsedDetails(staging).filter(item => !item.parentDetails);
    if (roots.length !== 1 || roots[0].kind !== "element" || roots[0].tag !== boundary.tag ||
        roots[0].start !== offset || roots[0].end !== finish) return;
    setUpdateRegion(staging, boundary);
    return staging;
}

export const mode = {
    render(source, element, change, previousRoot) {
        const region = previousRoot && !hasIndexedMutations(element.editor.dom) && renderRegion(source, element, change);
        if (region) return region;
        let staging = createDOM(source, element.ownerDocument);
        const literalRanges = brokenHTMLRanges(
            element.editor?.editorDetails || [], getParsedDetails(staging), change
        );
        if (literalRanges.length)
            staging = createDOM(source, element.ownerDocument, undefined, literalRanges);
        return staging;
    },
    root: (tree, element) => element.tagName === "IFRAME" ? tree?.documentElement : tree?.body,
    apply: applyIndexedDOM,
    prepareLive(live, element) {
        if (element.tagName === "IFRAME" && live.contentEditable !== "false") live.contentEditable = "true";
    },
    afterMirror(root, live, element) {
        observeIndexedDOM(root.ownerDocument, element, live);
        if (element.tagName === "IFRAME") reconcileDoctype(root.ownerDocument, live.ownerDocument);
    },
    attributes: getHTMLAttributes,
    getAttribute: getHTMLAttribute,
    setAttribute: setHTMLAttribute,
    removeAttribute: removeHTMLAttribute
};
