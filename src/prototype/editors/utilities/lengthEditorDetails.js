/**
 * Experimental, length-only editor detail operations.
 *
 * This module is deliberately not imported by the production editor. Records
 * form a flat, ordered ledger whose values concatenate to the source string.
 * Positions are derived by accumulating `length`; they are never stored on a
 * record. DOM nodes and CRDT updates are intentionally left to a future adapter.
 *
 * Offsets and lengths use JavaScript string (UTF-16 code unit) coordinates,
 * matching String.length and the editor's existing source offsets.
 */

import {
    createEditorDetails,
    findEditorDetailIndex as findDetailIndex,
    findEditorDetailsInRange as findDetailsInRange,
    getEditorDetailsLength
} from "./createEditorDetails.js";

export {
    findDetailIndex,
    findDetailsInRange,
    getEditorDetailsLength as getDetailsLength
};

function assertRecord(record, index) {
    if (!record || typeof record.value !== "string")
        throw new TypeError(`Editor detail ${index} must have a string value.`);
    if (record.length !== record.value.length)
        throw new RangeError(`Editor detail ${index} length must equal value.length.`);
}

function assertRecords(records) {
    if (!Array.isArray(records))
        throw new TypeError("Editor details must be an array.");
    records.forEach(assertRecord);
}

function textRecord(value, template) {
    return createEditorDetails({
        kind: "text",
        nodeType: 3,
        value,
        editor: template?.editor || null,
        parentDetails: template?.parentDetails || null
    });
}

/**
 * Plan a source replacement without mutating details or touching the DOM.
 * Untouched and edited records retain identity; fully removed records are
 * collected separately. Changed values are staged here and applied by the
 * update-event handler, which also refreshes each cached length.
 */
export function planDetailsEdit(details, start, end, value = "") {
    assertRecords(details);
    if (typeof value !== "string") throw new TypeError("Inserted value must be a string.");
    const totalLength = getEditorDetailsLength(details);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > totalLength)
        throw new RangeError("Expected a valid half-open source range.");

    const retained = [];
    const removed = [];
    const edited = [];
    const added = [];
    const nextDetails = [];
    const ranges = [];
    let cursor = 0;
    for (const detail of details) {
        ranges.push({ detail, start: cursor, end: cursor + detail.length });
        cursor += detail.length;
    }

    if (start === end) {
        const containing = ranges.find(range => range.start <= start && start < range.end);
        if (containing && value) {
            const local = start - containing.start;
            edited.push({
                detail: containing.detail,
                value: containing.detail.value.slice(0, local) + value + containing.detail.value.slice(local)
            });
            for (const detail of details) nextDetails.push(detail);
            retained.push(...details.filter(detail => detail !== containing.detail));
        } else {
            const anchorIndex = findDetailIndex(details, start);
            const anchor = anchorIndex >= 0
                ? details[anchorIndex]
                : details[findDetailIndex(details, start, { bias: "left" })] || null;
            const insertionIndex = anchorIndex >= 0
                ? anchorIndex
                : anchor ? details.indexOf(anchor) + 1 : details.length;
            for (let index = 0; index <= details.length; index++) {
                if (value && index === insertionIndex) {
                    const inserted = textRecord(value, anchor);
                    added.push(inserted);
                    nextDetails.push(inserted);
                }
                if (index < details.length) {
                    nextDetails.push(details[index]);
                    retained.push(details[index]);
                }
            }
        }
        return { start, end, value, retained, removed, edited, added, nextDetails, sourceEdit: { start, end, value } };
    }

    const overlapping = ranges.filter(range => start < range.end && range.start < end);
    const first = overlapping[0];
    const last = overlapping.at(-1);
    let insertionPlaced = false;

    for (const range of ranges) {
        const { detail, start: detailStart, end: detailEnd } = range;
        if (!(start < detailEnd && detailStart < end)) {
            nextDetails.push(detail);
            retained.push(detail);
            continue;
        }

        const localStart = Math.max(start, detailStart) - detailStart;
        const localEnd = Math.min(end, detailEnd) - detailStart;
        const prefix = detail.value.slice(0, localStart);
        const suffix = detail.value.slice(localEnd);

        if (first === last) {
            const nextValue = prefix + value + suffix;
            if (nextValue) {
                edited.push({ detail, value: nextValue });
                nextDetails.push(detail);
                insertionPlaced = !!value;
            } else removed.push({ detail, start: detailStart, end: detailEnd });
            continue;
        }

        if (range === first) {
            if (prefix) {
                edited.push({ detail, value: prefix + value });
                nextDetails.push(detail);
                insertionPlaced = !!value;
                continue;
            }
            removed.push({ detail, start: detailStart, end: detailEnd });
            if (value) {
                const inserted = textRecord(value, detail);
                added.push(inserted);
                nextDetails.push(inserted);
                insertionPlaced = true;
            }
            continue;
        } else if (range === last) {
            if (suffix) {
                edited.push({ detail, value: suffix });
                nextDetails.push(detail);
            } else removed.push({ detail, start: detailStart, end: detailEnd });
            continue;
        } else removed.push({ detail, start: detailStart, end: detailEnd });
    }

    if (value && !insertionPlaced) {
        // The first affected record may be fully removed; insert before the
        // surviving suffix or at the end of the resulting sequence.
        const anchor = last?.detail || first?.detail || null;
        const addedText = textRecord(value, anchor);
        const suffixIndex = last ? nextDetails.indexOf(last.detail) : -1;
        if (suffixIndex >= 0) nextDetails.splice(suffixIndex, 0, addedText);
        else nextDetails.push(addedText);
        added.push(addedText);
    }

    return {
        start,
        end,
        value,
        retained,
        removed,
        edited,
        added,
        nextDetails,
        sourceEdit: { start, end, value }
    };
}

/** Return the concatenated source represented by the details. */
export function detailsToSource(details) {
    assertRecords(details);
    return details.map(detail => detail.value).join("");
}
