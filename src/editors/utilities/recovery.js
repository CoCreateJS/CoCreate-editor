import { editorDetailsAtChange } from "./details.js";

const overlaps = (start, end, from, to) => start < to && from < end;

function touchesTag(range, start, end) {
    if (start === end)
        return (range.start < start && start < range.contentStart) ||
            (range.contentEnd < start && start < range.end);
    if (start <= range.start && range.end <= end) return false;
    return overlaps(start, end, range.start, range.contentStart) ||
        overlaps(start, end, range.contentEnd, range.end);
}

function mapped(position, { start, length, value }) {
    if (position <= start) return position;
    if (position >= start + length) return position + value.length - length;
    return start + value.length;
}

// Preserve the old element's lexical boundary when its tag becomes incomplete.
// This prevents an unfinished close from consuming intact following siblings.
export function brokenHTMLRanges(previous, rendered, change) {
    if (!previous?.length) return [];
    const start = change.start, end = start + change.length;
    const touched = editorDetailsAtChange(previous, start, end).filter(range => range.kind === "element" && touchesTag(range, start, end));
    rendered = rendered.filter(range => range.kind === "element");
    const damaged = [];
    for (const range of touched) {
        const from = mapped(range.start, change), to = mapped(range.end, change);
        // Replacements can repair a tag while changing its length or even its
        // name. If the edit consumes the old end, a replacement may close in
        // the unchanged suffix beyond mapped(end), e.g. when adjacent markup
        // was deleted and the shared suffix begins inside the new close tag.
        const repaired = rendered.some(candidate => (
            Math.min(from, start) <= candidate.start &&
            candidate.start <= from && from < candidate.end &&
            (candidate.end <= to || range.end < end)
        ) || (
            // Removing a close and the following opener can merge siblings.
            // A new complete wrapper may now own that surviving closing tag.
            start <= range.start && range.contentStart <= end &&
            candidate.start < from && candidate.contentStart <= from && candidate.end === to
        ));
        if (from < to && !repaired)
            damaged.push({ range, start: from, end: to });
    }
    const damagedDetails = new Set(damaged.map(item => item.range));
    const outermost = damaged.filter(({ range }) => {
        for (let parent = range.parentDetails; parent; parent = parent.parentDetails)
            if (damagedDetails.has(parent)) return false;
        return true;
    }).sort((a, b) => a.start - b.start);
    const ranges = [];
    for (const { start, end } of outermost) {
        const last = ranges.at(-1);
        if (last && start < last.end) last.end = Math.max(last.end, end);
        else ranges.push({ start, end });
    }
    return ranges;
}
