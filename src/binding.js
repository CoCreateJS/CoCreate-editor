import { boundaryFor, selectionBoundary, ownsFocus } from "./boundaries.js";
import { getValue, setValue, getSelection, setSelection } from "./adapters.js";
import { sourceChange, applySourceChange } from "./CRDT.js";
let provider;
const sessions = new Map();
const instanceId = Math.random().toString(36).slice(2);
let serial = 0;
export function setCrdt(engine) {
    if (
        !engine ||
        !["getText", "updateText", "undoText", "redoText"].every(
            (name) => typeof engine[name] === "function"
        )
    )
        throw new TypeError("Invalid CoCreate CRDT engine.");
    provider = engine;
}
const report = (element, error) =>
    element.dispatchEvent(
        new CustomEvent("editor-error", { bubbles: true, detail: { error } })
    );
function identity(element) {
    if (element.getAttribute("crdt") !== "true") return null;
    const data = Object.fromEntries(
        [
            "array",
            "object",
            "key",
            "read",
            "save",
            "crud",
            "namespace",
            "room"
        ].map((name) => [name, element.getAttribute(name) ?? undefined])
    );
    if (!data.array || !data.object || !data.key || data.object === "pending")
        return null;
    if (
        ["_id", "organization_id", "storage", "database", "array"].includes(
            data.key
        ) ||
        data.key.startsWith("$")
    )
        return null;
    return data;
}
const keyOf = (data) => JSON.stringify([data.array, data.object, data.key]);
function mapPosition(position, change) {
    if (position < change.start) return position;
    if (position >= change.start + change.length)
        return position + change.value.length - change.length;
    return change.start + change.value.length;
}
function visible(session) {
    return session.queue.reduce(
        (value, operation) => applySourceChange(value, operation),
        session.value
    );
}
function paint(session) {
    const value = visible(session);
    for (const element of session.elements) {
        const before = getValue(element);
        if (before === value) continue;
        const change = sourceChange(before, value);
        const active = ownsFocus(element);
        const selection = active ? getSelection(element) : null;
        setValue(element, value, { silent: true });
        if (selection)
            selection
                .then(({ anchor, head }) => {
                    if (session.elements.has(element))
                        return setSelection(
                            element,
                            mapPosition(anchor, change),
                            mapPosition(head, change)
                        );
                })
                .catch((error) => report(element, error));
        element.dispatchEvent(new Event("input", { bubbles: true }));
    }
}
function receive(session, data) {
    if (typeof data.string !== "string") return;
    if (
        data.editorTransaction &&
        session.queue[0]?.token === data.editorTransaction
    ) {
        session.queue.shift();
    } else {
        // Rebase local edits still waiting for the engine over incoming source changes.
        let before = session.value,
            after = data.string;
        for (const operation of session.queue) {
            const delta = sourceChange(before, after);
            const nextBefore = applySourceChange(before, operation);
            const start = mapPosition(operation.start, delta);
            const end = mapPosition(operation.start + operation.length, delta);
            operation.start = start;
            operation.length = Math.max(0, end - start);
            after = applySourceChange(after, operation);
            if (operation.selection) {
                const shift = sourceChange(nextBefore, after);
                operation.selection = {
                    anchor: mapPosition(operation.selection.anchor, shift),
                    head: mapPosition(operation.selection.head, shift)
                };
            }
            before = nextBefore;
        }
    }
    session.value = data.string;
    paint(session);
}
async function pump(session) {
    if (
        !session.loaded ||
        session.sending ||
        session.failed ||
        !session.queue.length
    )
        return;
    session.sending = true;
    const operation = session.queue[0];
    try {
        // Getters are resolved by CoCreate CRDT after its asynchronous document load,
        // so a remote update can rebase this pending edit before it is applied.
        await session.engine.updateText({
            ...session.data,
            ...operation.data,
            editorTransaction: operation.token,
            get start() {
                return operation.start;
            },
            get length() {
                return operation.length;
            },
            get value() {
                return operation.value;
            },
            captureSelection: () => operation.selection ?? null
        });
        if (session.queue[0] === operation)
            throw new Error("CRDT did not acknowledge the editor operation.");
    } catch (error) {
        session.failed = true;
        for (const element of session.elements) report(element, error);
    } finally {
        session.sending = false;
        if (!session.elements.size && !session.queue.length)
            sessions.delete(session.key);
        else pump(session);
    }
}
export function unbind(element) {
    const owner = element.__cocreateEditor;
    owner?.unbind?.();
    if (owner) {
        delete owner.unbind;
        delete owner.history;
    }
}
function load(session) {
    session.ready = (async () => {
        session.engine =
            provider ||
            window.CoCreate?.crdt ||
            (await import("@cocreate/crdt")).default;
        const initial = String(
            (await session.engine.getText(session.data)) ?? ""
        );
        if (!initial && session.value) {
            session.queue.unshift({
                start: 0,
                length: 0,
                value: session.value,
                token: `editor-${instanceId}-${++serial}`,
                data: session.data
            });
            session.value = "";
        }
        receive(session, { string: initial });
        session.loaded = true;
        session.failed = false;
        paint(session);
        pump(session);
    })().catch((error) => {
        session.failed = true;
        throw error;
    });
}
export async function bind(element) {
    unbind(element);
    const data = identity(element);
    if (!data) return;
    const owner = element.__cocreateEditor;
    const key = keyOf(data);
    let session = sessions.get(key);
    if (!session) {
        session = {
            key,
            data,
            elements: new Set(),
            queue: [],
            value: getValue(element),
            loaded: false
        };
        sessions.set(key, session);
        load(session);
    } else if (session.failed) {
        session.failed = false;
        if (!session.loaded) load(session);
        else pump(session);
    }
    session.elements.add(element);
    const changed = (event) => {
        if (event.detail.before === event.detail.value) return;
        const operation = {
            ...sourceChange(event.detail.before, event.detail.value),
            token: `editor-${instanceId}-${++serial}`,
            data
        };
        // Selection coordinates always address canonical source text.
        session.queue.push(operation);
        getSelection(element).then(
            ({ anchor, head }) => (operation.selection = { anchor, head })
        );
        paint(session);
        pump(session);
    };
    element.addEventListener("editor-source-change", changed);
    let detached = false;
    owner.unbind = () => {
        detached = true;
        session.elements.delete(element);
        element.removeEventListener("editor-source-change", changed);
        if (!session.elements.size && !session.queue.length && !session.sending)
            sessions.delete(key);
    };
    owner.history = async (redo) => {
        try {
            await session.ready;
            if (session.queue.length || session.sending) return;
            await session.engine[redo ? "redoText" : "undoText"](data);
        } catch (error) {
            report(element, error);
        }
    };
    const presence = async () => {
        if (!session.loaded || !ownsFocus(element) || detached) return;
        const host =
            element.tagName === "IFRAME"
                ? element.contentDocument?.documentElement
                : element;
        if (
            !host ||
            selectionBoundary(host) ||
            boundaryFor(host.ownerDocument.activeElement, host)
        )
            return;
        try {
            const { anchor, head } = await getSelection(element);
            await session.engine.updateSelection?.({
                ...data,
                selection: { anchor, head }
            });
        } catch (error) {
            report(element, error);
        }
    };
    let selectionDocument =
        element.tagName === "IFRAME"
            ? element.contentDocument
            : element.ownerDocument;
    selectionDocument?.addEventListener("selectionchange", presence);
    const documentChanged = () => {
        selectionDocument?.removeEventListener("selectionchange", presence);
        selectionDocument = element.contentDocument;
        selectionDocument?.addEventListener("selectionchange", presence);
    };
    element.addEventListener("editor-document-change", documentChanged);
    element.addEventListener("select", presence);
    const dispose = owner.unbind;
    owner.unbind = () => {
        dispose();
        selectionDocument?.removeEventListener("selectionchange", presence);
        element.removeEventListener("editor-document-change", documentChanged);
        element.removeEventListener("select", presence);
    };
    try {
        await session.ready;
        if (!detached) paint(session);
    } catch (error) {
        if (!detached) report(element, error);
    }
}
window.addEventListener("cocreate-crdt-update", (event) => {
    const session = sessions.get(keyOf(event.detail));
    if (session) receive(session, event.detail);
});
