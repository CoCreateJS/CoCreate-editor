const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const root = path.resolve(__dirname, '../src');
let server, browser, origin;

before(async () => {
    server = http.createServer((request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        response.setHeader('Content-Type', 'text/javascript');
        if (pathname === '/') {
            response.setHeader('Content-Type', 'text/html');
            return response.end('<!doctype html><body></body>');
        }
        if (pathname === '/stubs/events.js')
            return response.end('export function bindEditorInput() { return { disconnect() {}, setValue() {} }; }');
        if (pathname === '/stubs/selection.js')
            return response.end('export function getSelection() { return null; } export function setSelection() {}');
        if (pathname === '/stubs/observer.js')
            return response.end('export default { init(config) { window.observerConfigs = config; } };');
        if (pathname === '/stubs/queryElements.js')
            return response.end('export function queryElements({ element, selector }) { return [...element.querySelectorAll(selector)]; }');

        const file = path.resolve(root, '.' + pathname);
        if (!file.startsWith(root + '/') || !fs.existsSync(file)) return response.writeHead(404).end();
        let source = fs.readFileSync(file, 'utf8');
        if (pathname === '/inputBinding.js') {
            source = source
                .replace('./events.js', '/stubs/events.js')
                .replace('./selection.js', '/stubs/selection.js')
                .replace('"@cocreate/observer"', '"/stubs/observer.js"')
                .replace('"@cocreate/utils/queryElements"', '"/stubs/queryElements.js"');
        }
        response.end(source);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
        ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
});

after(async () => {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
});

async function inBrowser(run) {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    try {
        await page.goto(origin);
        await page.evaluate(async () => {
            window.binding = await import('/inputBinding.js');
        });
        await run(page);
    } finally {
        await page.close();
    }
}

test('editor-query projects the resolved editor attribute and initializes that attribute binding', () => inBrowser(async page => {
    assert.deepEqual(await page.evaluate(async () => {
        const host = document.createElement('div');
        host.id = 'editor-host';
        document.body.append(host);
        const calls = [];
        const attribute = {
            kind: 'attribute', name: 'class',
            async init(options) { calls.push(['init', options.input, options.target]); },
            uninit(input) { calls.push(['uninit', input]); }
        };
        host.editor = {
            element: host,
            nodes: [],
            init() {},
            getAttribute(name) { return name === 'class' ? attribute : null; }
        };
        const input = document.createElement('input');
        input.setAttribute('editor-query', '#editor-host');
        input.setAttribute('editor-attribute', 'class');
        document.body.append(input);
        const binding = await window.binding.initEditorQuery(input, { context: document });
        return [input.editor === attribute, binding.target === host, calls.length,
            calls[0]?.[0], calls[0]?.[1] === input, calls[0]?.[2] === host,
            window.observerConfigs.some(item => item.name === 'CoCreateEditorQueryChanged' &&
                item.selector === '[editor-query]')];
    }), [true, true, 1, 'init', true, true, true]);
}));

test('host click switches the projected attribute, uninitializes the old binding, and initializes the selected one', () => inBrowser(async page => {
    assert.deepEqual(await page.evaluate(async () => {
        const host = document.createElement('div');
        host.id = 'editor-host';
        const selected = document.createElement('button');
        selected.textContent = 'select me';
        host.append(selected);
        document.body.append(host);
        const calls = [];
        const makeAttribute = label => ({ kind: 'attribute', name: 'class',
            async init() { calls.push(`${label}:init`); },
            uninit() { calls.push(`${label}:uninit`); }
        });
        const initial = makeAttribute('initial');
        const clicked = makeAttribute('clicked');
        const selectedEditor = { getAttribute(name) { return name === 'class' ? clicked : null; } };
        selected.editor = selectedEditor;
        host.editor = {
            element: host, nodes: [], init() {},
            getAttribute(name) { return name === 'class' ? initial : null; }
        };
        const input = document.createElement('input');
        input.setAttribute('editor-query', '#editor-host');
        input.setAttribute('editor-attribute', 'class');
        document.body.append(input);
        await window.binding.initEditorQuery(input, { context: document });
        selected.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
        return [input.editor === clicked, calls];
    }), [true, ['initial:init', 'initial:uninit', 'clicked:init']]);
}));

test('editor-attributes returns the same objects to renderValue and uninit disconnects the query binding', () => inBrowser(async page => {
    assert.deepEqual(await page.evaluate(async () => {
        const host = document.createElement('div');
        host.id = 'editor-host';
        document.body.append(host);
        const values = [{ name: 'class', value: 'sample' }, { name: 'title', value: 'label' }];
        host.editor = { element: host, nodes: [], init() {}, getAttributes: () => values };
        const renderer = document.createElement('div');
        renderer.setAttribute('editor-query', '#editor-host');
        renderer.setAttribute('editor-attributes', '');
        renderer.renderValue = value => { renderer.rendered = value; };
        document.body.append(renderer);
        await window.binding.initEditorQuery(renderer, { context: document });
        const sameArray = renderer.editor === values && renderer.rendered === values;
        const removedNodes = window.observerConfigs.find(item => item.name === 'CoCreateEditorBindingsRemovedNodes');
        await removedNodes.callback({ target: renderer });
        return [sameArray, removedNodes.selector.includes('[editor-query]'), renderer.editor === null];
    }), [true, true, true]);
}));
