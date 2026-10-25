import * as rich from "./editor.js";
import { serializeDocument } from "./document.js";
const frames = new WeakMap();
const properties = ["value", "getValue", "getValueAsync", "setValue"];
function documentFor(frame) {
    const doc = frame.contentDocument;
    if (!doc?.documentElement)
        throw new Error(
            "The iframe editor requires an accessible same-origin document."
        );
    return doc;
}
export function create(frame) {
    const mode = frame.getAttribute("editor")?.trim().toLowerCase();
    if (mode && mode !== "html")
        throw new TypeError('Iframe documents use editor="html".');
    if (frames.has(frame)) return frames.get(frame).ready;
    const original = Object.fromEntries(
        properties.map((name) => [
            name,
            Object.getOwnPropertyDescriptor(frame, name)
        ])
    );
    const previousReader = frame.getValue;
    const hasValue =
        original.getValue ||
        original.value ||
        frame.hasAttribute("component") ||
        frame.hasAttribute("value");
    const record = {
        original,
        value: "",
        version: 0,
        abort: new AbortController(),
        root: null,
        document: null
    };
    record.publicEditor = {
        element: frame,
        get host() {
            return record.root;
        },
        get document() {
            return record.document;
        },
        staging: () => record.editor?.staging()
    };
    frames.set(frame, record);
    Object.defineProperties(frame, {
        value: {
            configurable: true,
            get: () => getValue(frame),
            set: (value) => setValue(frame, value)
        },
        getValue: { configurable: true, value: () => getValue(frame) },
        getValueAsync: {
            configurable: true,
            value: async () => {
                await record.ready;
                return getValue(frame);
            }
        },
        setValue: {
            configurable: true,
            value: (value, dispatch = false) => {
                setValue(frame, value);
                if (dispatch)
                    frame.dispatchEvent(new Event("input", { bubbles: true }));
            }
        }
    });
    const on = (target, type, listener) =>
        target.addEventListener(type, listener, {
            signal: record.abort.signal
        });
    on(frame, "editor-source-change", (event) => {
        record.value = event.detail.value;
    });
    const mount = async () => {
        const doc = documentFor(frame);
        if (doc === record.document && record.root) return record.publicEditor;
        if (record.root) {
            record.value = rich.getValue(record.root);
            delete record.root.__cocreateEditor;
            rich.destroy(record.root);
        }
        record.document = doc;
        record.root = doc.documentElement;
        // The inner surface and the outer reference share collaboration/history ownership.
        record.root.__cocreateEditor = frame.__cocreateEditor;
        record.root.dispatchEvent(
            new doc.defaultView.CustomEvent("cocreate-editor-claim", {
                bubbles: true
            })
        );
        record.editor = await rich.create(record.root, {
            documentMode: true,
            reference: frame,
            initialSource: record.value,
            editable:
                !frame.hasAttribute("readonly") &&
                !frame.hasAttribute("disabled") &&
                frame.getAttribute("contenteditable") !== "false"
        });
        if (frames.get(frame) !== record) return;
        frame.dispatchEvent(
            new CustomEvent("editor-document-change", {
                detail: { document: doc, host: record.root }
            })
        );
        return record.publicEditor;
    };
    const load = new Promise((resolve, reject) => {
        let started = false;
        const start = async () => {
            if (started || frames.get(frame) !== record) return;
            started = true;
            try {
                const doc = documentFor(frame);
                let initial;
                if (hasValue && typeof previousReader === "function") {
                    // Restore only during the initial reader's synchronous call.
                    const descriptor = Object.getOwnPropertyDescriptor(
                        frame,
                        "value"
                    );
                    if (original.value)
                        Object.defineProperty(frame, "value", original.value);
                    else delete frame.value;
                    try {
                        initial = previousReader.call(frame);
                    } finally {
                        Object.defineProperty(frame, "value", descriptor);
                    }
                } else
                    initial =
                        frame.getAttribute("srcdoc") ?? serializeDocument(doc);
                initial = await initial;
                if (frames.get(frame) !== record) {
                    resolve();
                    return;
                }
                if (!record.version) record.value = String(initial ?? "");
                resolve(await mount());
            } catch (error) {
                reject(error);
            }
        };
        on(frame, "load", () => {
            if (!started) start();
            else if (record.root)
                mount().catch((error) =>
                    frame.dispatchEvent(
                        new CustomEvent("editor-error", {
                            bubbles: true,
                            detail: { error }
                        })
                    )
                );
        });
        // src/srcdoc may still point at the initial about:blank document before load.
        const doc = frame.contentDocument;
        if (
            !frame.hasAttribute("srcdoc") &&
            (!frame.getAttribute("src") ||
                frame.getAttribute("src") === "about:blank")
        )
            start();
        else if (
            doc?.readyState === "complete" &&
            (frame.hasAttribute("srcdoc")
                ? doc.URL === "about:srcdoc"
                : doc.URL !== "about:blank")
        )
            start();
        record.abort.signal.addEventListener("abort", () => resolve(), {
            once: true
        });
        if (!doc && frame.isConnected) {
            try {
                void frame.contentWindow.location.href;
            } catch {
                reject(
                    new Error(
                        "The iframe editor requires an accessible same-origin document."
                    )
                );
            }
        }
    });
    record.ready = load.catch((error) => {
        destroy(frame);
        throw error;
    });
    return record.ready;
}
export function getValue(frame) {
    const record = frames.get(frame);
    return record?.root ? rich.getValue(record.root) : record?.value;
}
export function setValue(frame, value, options = {}) {
    const record = frames.get(frame);
    if (!record) throw new Error("Iframe editor has not initialized.");
    const before = getValue(frame);
    record.version++;
    record.value = String(value ?? "");
    if (record.root) rich.setValue(record.root, record.value, { silent: true });
    if (!options.silent && before !== record.value)
        frame.dispatchEvent(
            new CustomEvent("editor-source-change", {
                detail: { before, value: record.value }
            })
        );
}
export function surface(frame) {
    const root = frames.get(frame)?.root;
    if (!root) throw new Error("Iframe document has not finished loading.");
    return root;
}
export function destroy(frame) {
    const record = frames.get(frame);
    if (!record) return;
    frames.delete(frame);
    record.abort.abort();
    if (record.root) {
        delete record.root.__cocreateEditor;
        rich.destroy(record.root);
    }
    for (const [name, descriptor] of Object.entries(record.original)) {
        if (descriptor) Object.defineProperty(frame, name, descriptor);
        else delete frame[name];
    }
}
export function heal(frame) {
    return rich.heal(surface(frame));
}
export function getSelection(frame) {
    return rich.getSelection(surface(frame));
}
export function setSelection(frame, anchor, head) {
    return rich.setSelection(surface(frame), anchor, head);
}
export function replaceRange(frame, value, range) {
    return rich.replaceRange(surface(frame), value, range);
}
