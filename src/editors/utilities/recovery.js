import { getSourceRange } from "./ranges.js";

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
export function brokenHTMLRanges(previousRoot, staging, change) {
    if (!previousRoot) return [];
    const start = change.start, end = start + change.length;
    const touched = [];
    for (const node of [previousRoot, ...previousRoot.querySelectorAll("*")]) {
        const range = getSourceRange(node);
        if (range && touchesTag(range, start, end)) touched.push({ node, range });
    }
    if (!touched.length) return [];
    const rendered = [];
    for (const node of staging.querySelectorAll("*")) {
        const range = getSourceRange(node);
        if (range) rendered.push(range);
    }
    const damaged = [];
    for (const { node, range } of touched) {
        const from = mapped(range.start, change), to = mapped(range.end, change);
        // Replacements can repair a tag while changing its length or even its
        // name. A complete new element covering the old boundary wins over
        // the old element's exact end position.
        const repaired = rendered.some(candidate =>
            Math.min(from, start) <= candidate.start &&
            candidate.start <= from && from < candidate.end &&
            candidate.end <= to
        );
        if (from < to && !repaired)
            damaged.push({ node, start: from, end: to });
    }
    const outermost = damaged.filter(({ node }) =>
        !damaged.some(other => other.node !== node && other.node.contains(node))
    ).sort((a, b) => a.start - b.start);
    const ranges = [];
    for (const { start, end } of outermost) {
        const last = ranges.at(-1);
        if (last && start < last.end) last.end = Math.max(last.end, end);
        else ranges.push({ start, end });
    }
    return ranges;
}
