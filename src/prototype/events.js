/** Small event hub for the isolated prototype editor path. */
export function createEditorEvents() {
    const listeners = new Map();
    return {
        on(type, listener) {
            if (typeof listener !== "function") throw new TypeError("Listener must be a function.");
            let set = listeners.get(type);
            if (!set) listeners.set(type, set = new Set());
            set.add(listener);
            return () => set.delete(listener);
        },
        emit(type, detail) {
            for (const listener of listeners.get(type) || []) listener(detail);
        },
        clear(type) {
            if (type === undefined) listeners.clear();
            else listeners.delete(type);
        }
    };
}

export default createEditorEvents;
