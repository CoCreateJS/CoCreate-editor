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

async function fixture(run, source = '<p>abc</p>') {
    const page = await browser.newPage();
    try {
        await page.goto(origin);
        await page.evaluate(async source => {
            const { createEditorCore } = await import('/editorCore.js');
            const code = await import('/editors/code.js');
            window.core = createEditorCore({ eventTarget: window });
            window.editor = document.createElement('div');
            editor.setAttribute('editor', 'code');
            editor.setAttribute('language', 'html');
            editor.contentEditable = 'true';
            document.body.append(editor);
            await core.initEditor(editor, { mode: 'code', language: 'html', source });
            window.code = code;
            window.snapshot = () => ({
                source: editor.editor.getSource(),
                storedSource: (core.getEditorDetails(editor) || []).map(detail => detail.value).join(''),
                selection: code.getSelection(editor),
                tokenTags: editor.querySelectorAll('.token-tag').length
            });
            window.selectSource = position => {
                editor.focus();
                code.setSelection(editor, { start: position, end: position });
            };
            window.errors = [];
            editor.addEventListener('editor-error', event => errors.push(event.detail.error.message));
        }, source);
        await run(page);
        assert.deepEqual(await page.evaluate(() => errors), []);
    } finally { await page.close(); }
}

test('HTML code edits keep the caret and refresh tokenization', async () => {
    await fixture(async page => {
        await page.evaluate(() => selectSource(4));
        await page.keyboard.type('<b>');
        await page.waitForFunction(() => editor.editor.getSource() === '<p>a<b>bc</p>');
        const result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '<p>a<b>bc</p>');
        assert.equal(result.storedSource, result.source);
        assert.equal(result.selection.start, 7);
        assert.equal(result.tokenTags, 3);
    });
});

test('Enter in HTML code keeps the caret after the newline for the next character', async () => {
    await fixture(async page => {
        await page.evaluate(() => selectSource(5));
        await page.keyboard.press('Enter');
        await page.keyboard.type('X');
        const result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '<p>ab\nXc</p>');
        assert.equal(result.storedSource, result.source);
        assert.equal(result.selection.start, 7);
    }, '<p>abc</p>');
});

test('Enter at the end of an HTML text token stays after the newline', async () => {
    await fixture(async page => {
        await page.evaluate(() => selectSource(6));
        await page.keyboard.press('Enter');
        await page.keyboard.type('X');
        const result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '<p>abc\nX</p>');
        assert.equal(result.storedSource, result.source);
        assert.equal(result.selection.start, 8);
    }, '<p>abc</p>');
});

test('Enter at a token boundary retains the post-break caret through a CRDT echo', async () => {
    await fixture(async page => {
        await page.evaluate(() => {
            window.updates = [];
            editor.editor.updateText = update => updates.push(update);
            selectSource(6);
        });
        await page.keyboard.press('Enter');
        const update = await page.evaluate(() => updates.shift());
        assert.deepEqual({ start: update.start, length: update.length, value: update.value },
            { start: 6, length: 0, value: '\n' });
        await page.evaluate(async update => {
            await core.receiveUpdate({ elements: [editor], ...update });
        }, update);
        await page.keyboard.type('X');
        const typedUpdate = await page.evaluate(() => updates.shift());
        assert.deepEqual({ start: typedUpdate.start, length: typedUpdate.length, value: typedUpdate.value },
            { start: 7, length: 0, value: 'X' });
        await page.evaluate(async update => {
            await core.receiveUpdate({ elements: [editor], ...update });
        }, typedUpdate);
        const result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '<p>abc\nX</p>');
        assert.equal(result.storedSource, result.source);
        assert.equal(result.selection.start, 8);
    }, '<p>abc</p>');
});

test('a terminal newline creates a visible next line and typing follows it', async () => {
    await fixture(async page => {
        await page.evaluate(() => selectSource(10));
        await page.keyboard.press('Enter');
        let result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '<p>abc</p>\n');
        assert.equal(result.selection.start, 11);
        await page.keyboard.type('X');
        result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '<p>abc</p>\nX');
        assert.equal(result.storedSource, result.source);
        assert.equal(result.selection.start, 12);
    }, '<p>abc</p>');
});

test('Tab inserts a source tab and advances the caret instead of leaving the editor', async () => {
    await fixture(async page => {
        await page.evaluate(() => selectSource(5));
        await page.keyboard.press('Tab');
        let result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '<p>ab\tc</p>');
        assert.equal(result.selection.start, 6);
        await page.keyboard.type('X');
        result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '<p>ab\tXc</p>');
        assert.equal(result.storedSource, result.source);
        assert.equal(result.selection.start, 7);
    }, '<p>abc</p>');
});
