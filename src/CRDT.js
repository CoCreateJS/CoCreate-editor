// CoCreate CRDT offsets address serialized editor, not editor tree positions.
import { getValue, setValue } from "./adapters.js";

export function sourceChange(before, after) {
    let start = 0;
    while (
        start < before.length &&
        start < after.length &&
        before[start] === after[start]
    )
        start++;
    let oldEnd = before.length,
        newEnd = after.length;
    while (
        oldEnd > start &&
        newEnd > start &&
        before[oldEnd - 1] === after[newEnd - 1]
    ) {
        oldEnd--;
        newEnd--;
    }
    return { start, length: oldEnd - start, value: after.slice(start, newEnd) };
}

export function applySourceChange(source, { start, length = 0, value = "" }) {
    if (
        !Number.isInteger(start) ||
        !Number.isInteger(length) ||
        start < 0 ||
        length < 0 ||
        start + length > source.length
    )
        throw new RangeError("Invalid editor source range.");
    return source.slice(0, start) + value + source.slice(start + length);
}

// Accept the existing CoCreate CRDT event payload. A canonical string takes
// precedence over the individual splice when supplied by the engine.
export function applyChange(element, change) {
    const value =
        typeof change.string === "string"
            ? change.string
            : applySourceChange(getValue(element), change);
    setValue(element, value, { silent: true });
    return value;
}
