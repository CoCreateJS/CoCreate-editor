import { isNative } from "./editors/utilities/boundaries.js";

const loaders = {
    dom: () => import(/* webpackChunkName: "editor-dom" */ "./editors/dom.js"),
    markdown: () => import(/* webpackChunkName: "editor-markdown" */ "./editors/markdown.js"),
    code: () => import(/* webpackChunkName: "editor-code" */ "./editors/code.js")
};
const modes = new Map();

export function modeSettings(element) {
    const type = element.getAttribute("editor")?.trim().toLowerCase();
    const name = isNative(element) ? "text" : ["dom", "markdown"].includes(type) ? type :
        type === "code" || element.hasAttribute("editor-language") ? "code" : "text";
    const language = name === "code"
        ? element.getAttribute("editor-language")?.trim().toLowerCase() || "text" : "text";
    return { name, language, key: `${name}:${language}` };
}

export async function loadMode({ name, language }, { editing = true } = {}) {
    if (name === "text") return null;
    if (!modes.has(name)) {
        const loading = loaders[name]().then(module => module.mode).catch(error => {
            modes.delete(name);
            throw error;
        });
        modes.set(name, loading);
    }
    const mode = await modes.get(name);
    if (editing) await mode.start?.();
    await mode.prepare?.(language);
    return mode;
}
