import parseDOM from "./parsers/dom.js";

/** Build DOM-source details without changing the production DOM editor. */
export function createDOMEditor(source, editor = null) {
    return { type: "dom", source, details: parseDOM(source, editor), editor };
}

export { parseDOM };
export default createDOMEditor;
