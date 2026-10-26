// Minimal replacement in UTF-16 source coordinates.
export function textChange(before, after, selection) {
    if (selection && Number.isInteger(selection.start) && Number.isInteger(selection.end)) {
        const { start, end } = selection;
        const insertedLength = after.length - before.length + end - start;
        if (insertedLength >= 0 && before.slice(0, start) === after.slice(0, start) &&
            before.slice(end) === after.slice(start + insertedLength))
            return { start, length: end - start, value: after.slice(start, start + insertedLength) };
    }
    let start = 0, oldEnd = before.length, newEnd = after.length;
    while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
        oldEnd--;
        newEnd--;
    }
    const splitsPair = (text, position) => position > 0 &&
        /[\uD800-\uDBFF]/.test(text[position - 1]) && /[\uDC00-\uDFFF]/.test(text[position] || "");
    if (splitsPair(before, start) || splitsPair(after, start)) start--;
    if (splitsPair(before, oldEnd) || splitsPair(after, newEnd)) { oldEnd++; newEnd++; }
    return { start, length: oldEnd - start, value: after.slice(start, newEnd) };
}

export default textChange;
