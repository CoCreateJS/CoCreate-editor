import '@cocreate/element-prototype';
import observer from '@cocreate/observer';
import { create, destroy, getValue, setValue, insert, insertPos, replaceRange, getSelection, setSelection } from './editor.js';
import { applyChange, applySourceChange, sourceChange } from './CRDT.js';
import './index.css';

let renderer;
export function setRenderer(instance) {
    if (!instance || typeof instance.render !== 'function')
        throw new TypeError('Markdown renderer must expose render(source).');
    renderer = instance;
}
export function render(value) {
    if (!renderer) throw new Error('Configure a Markdown renderer with setRenderer(instance).');
    return renderer.render(String(value ?? ''));
}

const selector = '[markdown]';

export function init(elements = document.querySelectorAll(selector)) {
    if (elements instanceof HTMLElement) elements = [elements];
    for (const element of elements) {
        if (!element.matches(selector)) continue;
        create(element).catch(error => element.dispatchEvent(new CustomEvent('markdown-error', {
            bubbles: true, detail: { error }
        })));
    }
}

observer.init({
    name: 'CoCreateMarkdownAddedNodes',
    types: ['addedNodes'],
    selector,
    callback: mutation => init(mutation.target)
});
observer.init({
    name: 'CoCreateMarkdownAttributes',
    types: ['attributes'],
    attributeFilter: ['markdown'],
    callback: mutation => {
        if (mutation.target.matches(selector)) init(mutation.target);
        else if (mutation.attributeName === 'markdown') destroy(mutation.target);
    }
});
init();

export { create, destroy, getValue, setValue, insert, insertPos, replaceRange, getSelection, setSelection, applyChange, applySourceChange, sourceChange };
export default { init, create, destroy, getValue, setValue, render, setRenderer, insert, insertPos, replaceRange, getSelection, setSelection, applyChange, applySourceChange, sourceChange };
