function attributeSource(source, position, name, value) {
    const { start, contentStart, tag } = position;
    if (position.kind !== "element" || !tag ||
        !Number.isInteger(start) || !Number.isInteger(contentStart) ||
        start < 0 || contentStart > source.length || start >= contentStart)
        throw new RangeError("Attribute editing requires a current HTML element position.");

    const openingTag = source.slice(start, contentStart);
    const tagMatch = /^<[A-Za-z][\w:-]*/.exec(openingTag);
    if (!tagMatch || tagMatch[0].slice(1).toLowerCase() !== tag.toLowerCase() ||
        openingTag.at(-1) !== ">")
        throw new RangeError("The target's HTML start tag could not be found in the editor source.");

    const closing = openingTag.length - (openingTag.endsWith("/>") ? 2 : 1);
    let index = tagMatch[0].length;
    const wanted = name.toLowerCase();
    let found;
    while (index < closing) {
        const whitespaceStart = index;
        while (index < closing && /\s/.test(openingTag[index])) index++;
        if (index >= closing) break;
        const attrStart = index;
        while (index < closing && !/[\s=/>]/.test(openingTag[index])) index++;
        if (index === attrStart) throw new SyntaxError("Unable to parse the target's HTML attributes.");
        const attrName = openingTag.slice(attrStart, index);
        const attrNameEnd = index;
        while (index < closing && /\s/.test(openingTag[index])) index++;
        let attrEnd = attrNameEnd;
        if (openingTag[index] === "=") {
            index++;
            while (index < closing && /\s/.test(openingTag[index])) index++;
            const quote = openingTag[index] === "'" || openingTag[index] === '"'
                ? openingTag[index++] : null;
            if (quote) {
                while (index < closing && openingTag[index] !== quote) index++;
                if (index >= closing) throw new SyntaxError("Unclosed quoted HTML attribute.");
                index++;
            } else {
                while (index < closing && !/[\s>]/.test(openingTag[index])) index++;
            }
            attrEnd = index;
        }
        if (!found && attrName.toLowerCase() === wanted)
            found = { start: whitespaceStart, end: attrEnd };
    }

    const replacement = value == null ? null :
        `${name}="${String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
    if (found) {
        const attrStart = found.start + (openingTag.slice(found.start, found.end).match(/^\s*/) || [""])[0].length;
        const attributeOnly = replacement ?? "";
        const next = openingTag.slice(0, attrStart) + attributeOnly + openingTag.slice(found.end);
        return { start, length: openingTag.length, value: next };
    }
    if (replacement === null) return null;
    const insertAt = start + closing;
    const prefix = closing > 0 && /\s/.test(openingTag[closing - 1]) ? "" : " ";
    return { start: insertAt, length: 0, value: prefix + replacement };
}

export function setHTMLAttribute(editorElement, { target, name, value } = {}) {
    if (typeof name !== "string" || !/^[A-Za-z_:][\w:.-]*$/.test(name))
        throw new TypeError("setAttribute requires a valid HTML attribute name.");
    const position = target?.editorPosition;
    const source = String(editorElement.value ?? "");
    if (position?.editorElement !== editorElement ||
        !Number.isInteger(position.start) || !Number.isInteger(position.contentStart) ||
        position.start < 0 || position.contentStart > source.length)
        throw new RangeError("Attribute editing requires a current editor source position.");
    const change = attributeSource(source, position, name, value);
    if (!change) return;
    return editorElement.editor.updateText(change);
}
