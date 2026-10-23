// Source values remain Markdown; Milkdown owns the editable DOM.
const records = new WeakMap();
let modules;
const load = () => modules ||= Promise.all([
    import('@milkdown/crepe'),
    import('@milkdown/kit/core'),
    import('@milkdown/kit/utils')
]).catch(error => { modules = undefined; throw error; });

export function getFeatures(element, Feature) {
    const features = {};
    for (const name of Object.values(Feature)) {
        const value = element.getAttribute(`markdown-${name}`);
        if (value !== null) features[name] = value !== 'false';
    }
    return features;
}

export function create(element) {
    if (records.has(element)) return records.get(element).ready;
    if (!(element instanceof HTMLElement)) throw new TypeError('Markdown.create expects an HTML element.');
    const textarea = element instanceof HTMLTextAreaElement;
    const nativeValue = textarea && Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    const original = Object.fromEntries(['value', 'getValue', 'getValueAsync', 'setValue'].map(name =>
        [name, Object.getOwnPropertyDescriptor(element, name)]));

    const record = {
        value: '',
        version: 0,
        original, element, textarea, nativeValue,
        tabIndex: element.getAttribute('tabindex'),
        ariaHidden: element.getAttribute('aria-hidden'),
        sourceClass: element.classList.contains('markdown-source'),
        listeners: new AbortController()
    };
    records.set(element, record);
    // Capture writes before invoking the previous reader. Keep the original value
    // property intact until that reader has inspected it.
    Object.defineProperty(element, 'setValue', {
        configurable: true, value: (value, dispatch = false) => {
            setValue(element, value);
            if (dispatch) element.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });
    let initialValue;
    try {
        initialValue = element.getValue();
        Object.defineProperties(element, {
            value: { configurable: true, get: () => record.value, set: value => setValue(element, value) },
            getValue: { configurable: true, value: () => record.value },
            getValueAsync: { configurable: true, value: async () => record.value }
        });
        if (!initialValue || typeof initialValue.then !== 'function') {
            // Complete synchronous handoffs in this call stack, before loading Milkdown.
            if (record.version === 0) element.setValue(initialValue);
            record.ready = mount(record);
        } else {
            record.ready = Promise.resolve(initialValue).then(value => {
                if (records.get(element) !== record) return;
                if (record.version === 0) element.setValue(value);
                return mount(record);
            });
        }
    } catch (error) {
        record.ready = Promise.reject(error);
    }
    record.ready = record.ready.catch(error => {
        if (records.get(element) === record) destroy(element);
        throw error;
    });
    return record.ready;
}

export function getValue(element) {
    return records.get(element)?.value;
}

export function setValue(element, value) {
    const record = records.get(element);
    if (!record) throw new Error('Markdown editor has not been initialized.');
    record.version++;
    record.value = String(value ?? '');
    if (record.textarea) record.nativeValue.set.call(element, record.value);
    record.replace?.(record.value);
}

// These positions belong to the editor tree, not serialized Markdown.
async function run(element, callback) {
    const editor = await create(element);
    const [, core, utils] = await load();
    return editor.action(ctx => callback(ctx, core, utils));
}

export function insert(element, markdown, inline = false) {
    return run(element, (ctx, core, utils) => utils.insert(markdown, inline)(ctx));
}

export function insertPos(element, markdown, position, inline = false) {
    return run(element, (ctx, core, utils) => utils.insertPos(markdown, position, inline)(ctx));
}

export function replaceRange(element, markdown, range) {
    return run(element, (ctx, core, utils) => utils.replaceRange(markdown, range)(ctx));
}

export function getSelection(element) {
    return run(element, (ctx, core) => {
        const selection = ctx.get(core.editorViewCtx).state.selection;
        return { from: selection.from, to: selection.to, anchor: selection.anchor, head: selection.head,
            empty: selection.empty, type: selection.toJSON().type };
    });
}

export function setSelection(element, anchor, head = anchor) {
    return run(element, async (ctx, core) => {
        const { TextSelection } = await import('@milkdown/kit/prose/state');
        const view = ctx.get(core.editorViewCtx);
        const selection = TextSelection.create(view.state.doc, anchor, head);
        view.dispatch(view.state.tr.setSelection(selection));
        view.focus();
    });
}

async function mount(record) {
    const [{ Crepe }, core, utils] = await load();
    const { element, textarea } = record;
    if (records.get(element) !== record) return;
    const { editorViewCtx, editorViewOptionsCtx } = core;
    const host = document.createElement('div');
    host.className = 'markdown-editor';
    record.host = host;
    if (textarea) element.after(host);
    else element.replaceChildren(host);
    let replacing = false;
    const updateEmpty = doc => host.toggleAttribute('data-empty',
        doc.childCount === 1 && doc.firstChild.type.name === 'paragraph' && doc.firstChild.content.size === 0);
    const crepe = record.crepe = new Crepe({
        root: host,
        defaultValue: record.value,
        features: getFeatures(element, Crepe.Feature),
        featureConfigs: {
            [Crepe.Feature.Placeholder]: { text: element.getAttribute('placeholder') || '' }
        }
    });
    const editor = record.editor = crepe.editor;
    editor.config(ctx => {
        ctx.update(editorViewOptionsCtx, options => ({
            ...options,
            attributes: {
                role: 'textbox', 'aria-multiline': 'true',
                'aria-label': element.getAttribute('aria-label') || 'Markdown',
                'aria-required': String(element.hasAttribute('required'))
            },
            editable: () => !element.hasAttribute('disabled') && !element.hasAttribute('readonly'),
            dispatchTransaction(transaction) {
                const view = ctx.get(editorViewCtx);
                const previous = view.state.doc;
                view.updateState(view.state.applyTransaction(transaction).state);
                updateEmpty(view.state.doc);
                if (replacing || previous.eq(view.state.doc)) return;
                record.value = editor.action(utils.getMarkdown());
                if (textarea) record.nativeValue.set.call(element, record.value);
                view.dom.removeAttribute('aria-invalid');
                element.dispatchEvent(new Event('input', { bubbles: true }));
            },
            handleDOMEvents: {
                blur: () => {
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                    return false;
                }
            }
        }));
    });
    await crepe.create();
    if (records.get(element) !== record) { await editor.destroy(); return; }
    const view = editor.action(ctx => ctx.get(editorViewCtx));
    record.replace = value => {
        replacing = true;
        try {
            editor.action(utils.replaceAll(value, true));
            updateEmpty(view.state.doc);
            view.dom.removeAttribute('aria-invalid');
        } finally { replacing = false; }
    };
    const { signal } = record.listeners;
    element.addEventListener('focus', () => view.focus(), { signal });
    if (textarea) {
        element.form?.addEventListener('reset', event => queueMicrotask(() => {
            if (!event.defaultPrevented) setValue(element, record.nativeValue.get.call(element));
        }), { signal });
        element.addEventListener('invalid', event => {
            event.preventDefault();
            view.dom.setAttribute('aria-invalid', 'true');
            view.focus();
        }, { signal });
        element.tabIndex = -1;
        element.setAttribute('aria-hidden', 'true');
        element.classList.add('markdown-source');
    }
    record.replace(record.value);
    element.dispatchEvent(new CustomEvent('markdown-ready', { bubbles: true, detail: { editor } }));
    return editor;
}

export function destroy(element) {
    const record = records.get(element);
    if (!record) return;
    records.delete(element);
    record.listeners.abort();
    // A loading instance tears itself down after creation finishes.
    if (record.replace) record.editor.destroy();
    record.host?.remove();
    for (const [name, descriptor] of Object.entries(record.original)) {
        if (descriptor) Object.defineProperty(element, name, descriptor);
        else delete element[name];
    }
    if (record.textarea) {
        record.nativeValue.set.call(element, record.value);
        for (const [name, value] of [['tabindex', record.tabIndex], ['aria-hidden', record.ariaHidden]]) {
            if (value === null) element.removeAttribute(name);
            else element.setAttribute(name, value);
        }
        if (!record.sourceClass) element.classList.remove('markdown-source');
    }
}
