import parseDOM, { isVoidElement } from "../parsers/dom.js";
import { getPotentialDOMTagFlags, matchCompleteDOMElements } from "../parsers/matchDOMTag.js";
import { detailsToSource, planDetailsEdit } from "./lengthEditorDetails.js";

const signature = detail => JSON.stringify([detail.kind, detail.nodeType, detail.tag, detail.name,
    !!detail.sourceOnly, detail.complete, detail.selfClosing]);

function indexDetails(details) {
    const ranges = [], units = [], roots = new Map(), subtrees = new Map();
    let position = 0;
    for (let index = 0; index < details.length; index++) {
        const detail = details[index];
        const root = detail.parentDetails ? roots.get(detail.parentDetails) || detail.parentDetails : detail;
        roots.set(detail, root);
        const range = { detail, index, start: position, end: position + detail.length };
        ranges.push(range);
        if (detail.kind === "element") subtrees.set(detail, { ...range, startIndex: index, endIndex: index + 1 });
        if (units.at(-1)?.root === root) {
            units.at(-1).end = range.end;
            units.at(-1).endIndex = index + 1;
        } else units.push({ root, start: range.start, end: range.end, startIndex: index, endIndex: index + 1 });
        position = range.end;
    }
    for (let index = ranges.length - 1; index >= 0; index--) {
        const range = ranges[index];
        const parent = subtrees.get(range.detail.parentDetails);
        if (!parent) continue;
        const child = subtrees.get(range.detail) || { end: range.end, endIndex: index + 1 };
        parent.end = Math.max(parent.end, child.end);
        parent.endIndex = Math.max(parent.endIndex, child.endIndex);
    }
    return { ranges, units, subtrees };
}

function sharedContainer(first, last) {
    const parents = new Set();
    for (let detail = last?.kind === "element" ? last : last?.parentDetails; detail; detail = detail.parentDetails)
        parents.add(detail);
    for (let detail = first?.kind === "element" ? first : first?.parentDetails; detail; detail = detail.parentDetails)
        if (parents.has(detail)) return detail;
    return null;
}

function needsMoreContext(parsed) {
    const closed = new Set(parsed.filter(detail => detail.kind === "elementEnd" &&
        detail.tag === detail.parentDetails?.tag).map(detail => detail.parentDetails));
    if (parsed.some(detail => detail.kind === "element" && !detail.parentDetails &&
        !detail.selfClosing && !isVoidElement(detail.tag) && !closed.has(detail))) return true;
    const last = parsed.at(-1);
    return last?.complete === false || (last?.kind === "text" && last.value.includes("<"));
}

function keepsContainer(parsed, container) {
    const root = parsed[0];
    if (root?.kind !== "element" || signature(root) !== signature(container)) return false;
    const roots = new Map();
    for (const detail of parsed) {
        const owner = detail.parentDetails ? roots.get(detail.parentDetails) : detail;
        roots.set(detail, owner);
        if (owner !== root) return false;
    }
    return true;
}

function hasTextAtSourcePosition(details, position) {
    let cursor = 0;
    let previous = null;
    for (const detail of details) {
        const end = cursor + detail.length;
        if (position < end) return detail.kind === "text";
        if (position === end) previous = detail;
        cursor = end;
    }
    return position === cursor && previous?.kind === "text";
}

function resolvesTextTag(details, matches, start, end, value) {
    const insertedEnd = start + value.length;
    const delta = value.length - (end - start);
    return matches.some(match => {
        // Map the new opening-tag offset back to the old source. If it was
        // inserted/replaced, the edit's old location must have been text.
        const openingStart = match.start;
        if (openingStart >= start && openingStart < insertedEnd)
            return hasTextAtSourcePosition(details, start);
        const previousStart = openingStart >= insertedEnd ? openingStart - delta : openingStart;
        return hasTextAtSourcePosition(details, previousStart);
    });
}

function needsTagMatch(value, removed, detail) {
    return /[<>="'\/]/.test(value + removed) || !!detail?.potentialTags?.length ||
        (!!detail?.value?.includes("<") && /[<>]/.test(value + removed));
}

function planTextEdit(details, start, end, value) {
    let position = 0;
    for (const detail of details) {
        const next = position + detail.length;
        const contains = start < next || (start === next && detail.kind === "text");
        if (!contains) { position = next; continue; }
        if (detail.kind !== "text" || detail.sourceOnly || end > next) return null;
        const localStart = start - position;
        const localEnd = end - position;
        const nextValue = detail.value.slice(0, localStart) + value + detail.value.slice(localEnd);
        // Keep incomplete markup as text. Only a complete element, or a void
        // element, promotes that text into DOM details and triggers a reparse.
        const removed = detail.value.slice(localStart, localEnd);
        if (needsTagMatch(value, removed, detail) &&
            matchCompleteDOMElements(nextValue, localStart, localStart + value.length).length) return null;
        const retained = details.filter(item => item !== detail);
        return { affected: [detail], retained, added: [], reparse: null,
            edited: nextValue ? [{ detail, value: nextValue, changes: {
                value: nextValue, length: nextValue.length, ...getPotentialDOMTagFlags(nextValue)
            } }] : [],
            removed: nextValue ? [] : [{ detail, start: position, end: next }],
            nextDetails: nextValue ? [...details] : retained };
    }
    return null;
}

/** Stage a source edit using cumulative lengths; neither records nor DOM are mutated. */
export function planDOMEdit(details, start, end, value, { parse = parseDOM, editor = details[0]?.editor || null,
    previousSource: suppliedSource, source: suppliedNextSource } = {}) {
    const previousSource = suppliedSource ?? detailsToSource(details);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > previousSource.length)
        throw new RangeError("Expected a valid half-open source range.");
    if (typeof value !== "string") throw new TypeError("Inserted value must be a string.");
    const source = suppliedNextSource ?? previousSource.slice(0, start) + value + previousSource.slice(end);
    const base = { start, end, value, previousSource, source, baseDetails: [...details],
        baseValues: details.map(detail => detail.value),
        sourceEdit: { start, end, value } };
    if (source === previousSource) return { ...base, affected: [], retained: [...details], edited: [],
        removed: [], added: [], nextDetails: [...details], reparse: null };
    // A closing tag can resolve an opening tag stored in a different text
    // detail. Check the resulting source before taking the local text fast path.
    let changedText = false;
    let detailStart = 0;
    const removedSource = previousSource.slice(start, end);
    for (const detail of details) {
        const detailEnd = detailStart + detail.length;
        const affected = start === end
            ? detailStart <= start && start <= detailEnd
            : detailStart < end && start < detailEnd;
        if (affected && detail.kind === "text" && needsTagMatch(value, removedSource, detail)) {
            changedText = true;
            break;
        }
        detailStart = detailEnd;
    }
    const resolvedTags = changedText
        ? matchCompleteDOMElements(source, start, start + value.length)
        : [];
    const resolveText = resolvesTextTag(details, resolvedTags, start, end, value);
    if (!resolveText) {
        const textEdit = planTextEdit(details, start, end, value);
        if (textEdit) return { ...base, ...textEdit };
    }

    const raw = planDetailsEdit(details, start, end, value);
    const { ranges, units, subtrees } = indexDetails(details);
    const affected = start === end ? (raw.edited.length ? raw.edited.map(item => item.detail)
        : ranges.filter(range => range.start <= start && start < range.end).map(range => range.detail))
        : ranges.filter(range => range.start < end && start < range.end).map(range => range.detail);

    const firstMatch = units.findIndex(unit => start < unit.end);
    const first = firstMatch < 0 ? Math.max(0, units.length - 1) : firstMatch;
    let last = units.findIndex(unit => end <= unit.end);
    if (last < 0) last = units.length - 1;
    const left = Math.max(0, first - 1);
    let right = Math.min(units.length - 1, Math.max(first, last) + 1);
    const firstDetail = affected[0] || ranges.find(range => range.start <= start && start < range.end)?.detail;
    const lastDetail = affected.at(-1) || firstDetail;
    let container = resolveText ? null : sharedContainer(firstDetail, lastDetail);
    let parseStart, parseEnd, fromIndex, toIndex, externalParent, parsed, parseSource;
    const fragment = () => previousSource.slice(parseStart, start) + value + previousSource.slice(end, parseEnd);
    while (container) {
        const extent = subtrees.get(container);
        if (!extent) { container = null; break; }
        ({ start: parseStart, end: parseEnd, startIndex: fromIndex, endIndex: toIndex } = extent);
        externalParent = container.parentDetails;
        parseSource = fragment();
        parsed = parse(parseSource, editor);
        const ancestors = new Set();
        for (let parent = externalParent; parent; parent = parent.parentDetails) ancestors.add(parent.tag);
        const closesAncestor = parsed.some(detail => detail.kind === "elementEnd" &&
            detail.tag !== detail.parentDetails?.tag && ancestors.has(detail.tag));
        const joinsText = (parsed[0]?.kind === "text" && details[fromIndex - 1]?.kind === "text") ||
            (parsed.at(-1)?.kind === "text" && details[toIndex]?.kind === "text") ||
            (!parsed.length && details[fromIndex - 1]?.kind === "text" && details[toIndex]?.kind === "text");
        if (!needsMoreContext(parsed) && !closesAncestor && !joinsText) break;
        container = container.parentDetails;
    }
    if (!container) {
        parseStart = resolveText ? 0 : units[left]?.start ?? 0;
        parseEnd = resolveText ? previousSource.length : units[right]?.end ?? previousSource.length;
        fromIndex = resolveText ? 0 : units[left]?.startIndex ?? 0;
        toIndex = resolveText ? details.length : units[right]?.endIndex ?? details.length;
        externalParent = null;
        parseSource = fragment();
        parsed = parse(parseSource, editor);
    }
    if (!container && parseEnd < previousSource.length && needsMoreContext(parsed)) {
        // Lexical damage can change the parent/context of all later records.
        right = units.length - 1;
        parseEnd = previousSource.length;
        toIndex = details.length;
        parseSource = fragment();
        parsed = parse(parseSource, editor);
    }
    if (detailsToSource(parsed) !== parseSource) throw new Error("DOM parser did not preserve the edited source.");
    const anchor = container && keepsContainer(parsed, container) ? container : externalParent || editor;

    const staged = new Map(raw.edited.map(item => [item.detail, item.value]));
    const candidates = new Map(), old = new Set(details);
    let position = 0;
    for (const detail of raw.nextDetails) {
        const length = (staged.get(detail) ?? detail.value).length;
        if (old.has(detail)) candidates.set(`${position}:${length}:${signature(detail)}`, detail);
        position += length;
    }
    const delta = value.length - (end - start);
    for (const range of ranges) {
        if (range.end <= start)
            candidates.set(`${range.start}:${range.detail.length}:${signature(range.detail)}`, range.detail);
        else if (range.start >= end)
            candidates.set(`${range.start + delta}:${range.detail.length}:${signature(range.detail)}`, range.detail);
    }
    const pieces = [];
    for (const range of ranges) {
        if (range.detail.kind !== "text") continue;
        if (range.start < start) pieces.push({ detail: range.detail, start: range.start, end: Math.min(start, range.end) });
        if (end < range.end) pieces.push({ detail: range.detail, start: Math.max(end, range.start) + delta, end: range.end + delta });
    }
    const unchanged = new Map();
    const valueKey = detail => `${signature(detail)}:${JSON.stringify(detail.value)}`;
    for (let index = fromIndex; index < toIndex; index++) {
        const detail = details[index], key = valueKey(detail);
        unchanged.set(key, unchanged.has(key) ? null : detail);
    }
    const exact = new Map(), reserved = new Set();
    position = parseStart;
    for (const fresh of parsed) {
        const detail = candidates.get(`${position}:${fresh.length}:${signature(fresh)}`);
        if (detail) { exact.set(fresh, detail); reserved.add(detail); }
        position += fresh.length;
    }
    const matches = new Map(), used = new Set();
    let pieceIndex = 0;
    position = parseStart;
    for (const fresh of parsed) {
        let detail = exact.get(fresh);
        if (used.has(detail)) detail = null;
        if (!detail) {
            const copied = unchanged.get(valueKey(fresh));
            if (copied && !reserved.has(copied) && !used.has(copied)) detail = copied;
        }
        if (!detail && fresh.kind === "text") {
            while (pieceIndex < pieces.length && pieces[pieceIndex].end <= position) pieceIndex++;
            let best = 0;
            for (let index = pieceIndex; index < pieces.length && pieces[index].start < position + fresh.length; index++) {
                const piece = pieces[index];
                if (used.has(piece.detail) || !!piece.detail.sourceOnly !== !!fresh.sourceOnly) continue;
                const overlap = Math.min(piece.end, position + fresh.length) - Math.max(piece.start, position);
                if (overlap > best) { best = overlap; detail = piece.detail; }
            }
        }
        detail ||= fresh;
        matches.set(fresh, detail);
        used.add(detail);
        position += fresh.length;
    }
    const edited = [], added = [];
    for (const fresh of parsed) {
        const detail = matches.get(fresh);
        const parentDetails = matches.get(fresh.parentDetails) || externalParent || null;
        if (detail === fresh) {
            fresh.parentDetails = parentDetails;
            added.push(fresh);
        } else {
            const changes = {};
            for (const key of ["value", "length", "kind", "nodeType", "tag", "name", "sourceOnly", "complete", "selfClosing",
                "potentialTags", "potentialOpenTag", "potentialClosingTag"])
                if (detail[key] !== fresh[key]) changes[key] = fresh[key];
            if (detail.parentDetails !== parentDetails) changes.parentDetails = parentDetails;
            if (Object.keys(changes).length) edited.push({ detail, value: fresh.value, changes });
        }
    }
    const nextDetails = details.slice(0, fromIndex).concat(parsed.map(detail => matches.get(detail)), details.slice(toIndex));
    const kept = new Set(nextDetails), changed = new Set(edited.map(item => item.detail));
    const removed = ranges.filter(range => !kept.has(range.detail));
    return { ...base, affected: [...new Set([...affected, ...edited.map(item => item.detail), ...removed.map(item => item.detail)])],
        edited, added, nextDetails,
        retained: nextDetails.filter(detail => old.has(detail) && !changed.has(detail)),
        removed,
        reparse: { start: parseStart, end: parseEnd, source: parseSource,
            anchor,
            parentDetails: externalParent,
            containers: container ? [container] : units.slice(left, right + 1).map(unit => unit.root) } };
}

export default planDOMEdit;
