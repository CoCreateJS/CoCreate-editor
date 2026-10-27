const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../src');
let server, browser, origin;

before(async () => {
    server = http.createServer((req, res) => {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (pathname === '/') return res.end('<!doctype html><body></body>');
        const file = path.resolve(root, '.' + pathname);
        if (!file.startsWith(root + '/') || !fs.existsSync(file)) return res.writeHead(404).end();
        res.setHeader('Content-Type', 'application/javascript');
        res.end(fs.readFileSync(file));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
        ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
});
after(async () => {
    await browser?.close();
    await new Promise(resolve => server?.close(resolve));
});

async function fixture(run, { source = 'alpha beta', tag = 'div', echo = false } = {}) {
    const page = await browser.newPage();
    try {
        await page.goto(origin);
        await page.evaluate(async ({ source, tag, echo }) => {
            const { createEditorCore } = await import('/core.js');
            const selection = await import('/selection.js');
            window.editor = document.createElement(tag);
            editor.setAttribute('editor', 'text');
            editor.value = source; // The demo also seeds contenteditable divs this way.
            if (tag === 'div') {
                editor.contentEditable = 'true';
                editor.style.whiteSpace = 'pre-wrap';
                editor.style.minHeight = '2em';
            }
            document.body.append(editor);
            window.core = createEditorCore({ eventTarget: window });
            await core.initEditor(editor);
            window.lastSource = source;
            core.events.on('editor-update', ({ result }) => { lastSource = result.source; });
            window.operations = [];
            if (echo) editor.editor.updateText = change => { operations.push(change); };
            window.select = (start, end = start) => {
                editor.focus();
                selection.setSelection(editor, { start, end });
            };
            window.snapshot = () => ({
                source: lastSource,
                surface: tag === 'div' ? editor.textContent : editor.value,
                selection: selection.getSelection(editor),
                hasDetails: core.getEditorDetails(editor) !== undefined
            });
            window.errors = [];
            editor.addEventListener('editor-error', event => errors.push(event.detail.error.message));
        }, { source, tag, echo });
        await run(page);
        assert.deepEqual(await page.evaluate(() => errors), []);
        assert.equal(await page.evaluate(() => snapshot().hasDetails), false);
    } finally { await page.close(); }
}

test('plain contenteditable keeps the caret after every typed character at any position', async () => {
    for (const position of [0, 5, 10]) await fixture(async page => {
        await page.evaluate(position => select(position), position);
        for (let index = 0; index < 3; index++) {
            await page.keyboard.type('XYZ'[index]);
            const result = await page.evaluate(() => snapshot());
            const expected = 'alpha beta'.slice(0, position) + 'XYZ'.slice(0, index + 1) + 'alpha beta'.slice(position);
            assert.equal(result.source, expected);
            assert.equal(result.surface, expected);
            assert.equal(result.selection.start, position + index + 1);
            assert.equal(result.selection.end, position + index + 1);
            assert.equal(result.hasDetails, false);
        }
    });
});

test('plain contenteditable supports replacement, backspace, delete, and typing after clearing', async () => {
    await fixture(async page => {
        await page.evaluate(() => select(6, 10));
        await page.keyboard.type('Z');
        assert.equal((await page.evaluate(() => snapshot())).selection.start, 7);
        await page.keyboard.press('Backspace');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Delete');
        assert.equal((await page.evaluate(() => snapshot())).source, 'alpha');
        await page.evaluate(() => select(0, 5));
        await page.keyboard.press('Backspace');
        await page.keyboard.type('<p>text</p>');
        const result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '<p>text</p>');
        assert.equal(result.surface, result.source);
        assert.equal(result.selection.start, 11);
        assert.equal(await page.evaluate(() => editor.children.length), 0);
    });
});

test('a local CRDT echo preserves the advanced caret and remote edits shift it once', async () => {
    await fixture(async page => {
        await page.evaluate(() => select(5));
        await page.keyboard.type('X');
        await page.evaluate(async () => {
            const change = operations.shift();
            await core.receiveUpdate({ elements: [editor], ...change });
        });
        assert.equal((await page.evaluate(() => snapshot())).selection.start, 6);
        await page.evaluate(() => core.receiveUpdate({ elements: [editor], start: 0, length: 0, value: 'AB' }));
        let result = await page.evaluate(() => snapshot());
        assert.equal(result.source, 'ABalphaX beta');
        assert.equal(result.surface, result.source);
        assert.equal(result.selection.start, 8);
        await page.evaluate(() => core.receiveUpdate({ elements: [editor], start: 0, length: 2, value: '' }));
        result = await page.evaluate(() => snapshot());
        assert.equal(result.source, 'alphaX beta');
        assert.equal(result.selection.start, 6);
    }, { echo: true });
});

for (const tag of ['input', 'textarea']) test(`${tag} preserves local and remote cursor positions`, async () => {
    await fixture(async page => {
        await page.evaluate(() => select(5));
        await page.keyboard.type('XY');
        let result = await page.evaluate(() => snapshot());
        assert.equal(result.source, 'alphaXY beta');
        assert.equal(result.surface, result.source);
        assert.equal(result.selection.start, 7);
        await page.evaluate(() => core.receiveUpdate({ elements: [editor], start: 0, length: 0, value: '!' }));
        result = await page.evaluate(() => snapshot());
        assert.equal(result.surface, '!alphaXY beta');
        assert.equal(result.selection.start, 8);
    }, { tag });
});

test('switching from DOM to text clears the stored details and keeps direct editing functional', async () => {
    await fixture(async page => {
        await page.evaluate(async () => {
            await core.initEditor(editor, { mode: 'dom', source: '<p>Hello</p>', force: true });
            if (!core.getEditorDetails(editor)?.length) throw new Error('DOM mode should have details');
            await core.initEditor(editor, { mode: 'text', source: 'plain again', force: true });
            select(5);
        });
        await page.keyboard.type('X');
        const result = await page.evaluate(() => snapshot());
        assert.equal(result.source, 'plainX again');
        assert.equal(result.surface, result.source);
        assert.equal(result.selection.start, 6);
        assert.equal(result.hasDetails, false);
    });
});

test('an empty text surface accepts incoming range updates and rejects mismatched source snapshots', async () => {
    await fixture(async page => {
        await page.evaluate(() => core.receiveUpdate({ elements: [editor], start: 0, end: 0, value: 'abc', string: 'abc' }));
        await page.evaluate(() => select(2));
        await page.evaluate(() => core.receiveUpdate({ elements: [editor], start: 0, end: 1, value: 'XY', string: 'XYbc' }));
        let result = await page.evaluate(() => snapshot());
        assert.equal(result.surface, 'XYbc');
        assert.equal(result.selection.start, 3);
        const rejected = await page.evaluate(async () => {
            try {
                await core.receiveUpdate({ elements: [editor], start: 0, length: 0, value: '!', string: 'wrong' });
                return false;
            } catch { return true; }
        });
        assert.equal(rejected, true);
        result = await page.evaluate(() => snapshot());
        assert.equal(result.source, 'XYbc');
        assert.equal(result.surface, result.source);
    }, { source: '' });
});

test('Enter and Shift+Enter preserve newlines and the caret through following typing', async () => {
    for (const position of [0, 5, 10]) await fixture(async page => {
        await page.evaluate(position => select(position), position);
        await page.keyboard.press('Enter');
        let result = await page.evaluate(() => snapshot());
        let expected = 'alpha beta'.slice(0, position) + '\n' + 'alpha beta'.slice(position);
        assert.equal(result.source, expected);
        assert.equal(result.selection.start, position + 1);
        await page.keyboard.type('XY');
        result = await page.evaluate(() => snapshot());
        expected = 'alpha beta'.slice(0, position) + '\nXY' + 'alpha beta'.slice(position);
        assert.equal(result.source, expected);
        assert.equal(result.surface, expected);
        assert.equal(result.selection.start, position + 3);
        await page.keyboard.press('Shift+Enter');
        await page.keyboard.type('Z');
        result = await page.evaluate(() => snapshot());
        assert.equal(result.source, 'alpha beta'.slice(0, position) + '\nXY\nZ' + 'alpha beta'.slice(position));
        assert.equal(result.surface, result.source);
        assert.equal(result.selection.start, position + 5);
    });
});

test('repeated Enter in an empty editor and newline selection replacement remain plain text', async () => {
    await fixture(async page => {
        await page.evaluate(() => select(0));
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        await page.keyboard.type('abc');
        let result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '\n\nabc');
        assert.equal(result.selection.start, 5);
        await page.evaluate(() => select(1, 4));
        await page.keyboard.press('Enter');
        await page.keyboard.type('X');
        result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '\n\nXc');
        assert.equal(result.selection.start, 3);
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Backspace');
        result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '\nc');
        assert.equal(result.surface, result.source);
    }, { source: '' });
});

test('newlines use positional CRDT updates and survive echoes and remote insertions', async () => {
    await fixture(async page => {
        await page.evaluate(() => select(10));
        await page.keyboard.press('Enter');
        const operation = await page.evaluate(() => {
            const { start, length, value } = operations[0];
            return { start, length, value };
        });
        assert.deepEqual(operation, { start: 10, length: 0, value: '\n' });
        await page.evaluate(() => core.receiveUpdate({ elements: [editor], ...operations.shift() }));
        assert.equal((await page.evaluate(() => snapshot())).selection.start, 11);
        await page.keyboard.type('X');
        await page.evaluate(() => core.receiveUpdate({ elements: [editor], ...operations.shift() }));
        await page.evaluate(() => core.receiveUpdate({ elements: [editor], start: 0, length: 0, value: '\n' }));
        const result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '\nalpha beta\nX');
        assert.equal(result.surface, result.source);
        assert.equal(result.selection.start, 13);
    }, { echo: true });
});
