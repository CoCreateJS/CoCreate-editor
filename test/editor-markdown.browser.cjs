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

async function fixture(run, source = '') {
    const page = await browser.newPage();
    try {
        await page.goto(origin);
        await page.evaluate(async source => {
            const { createEditorCore } = await import('/core.js');
            const markdown = await import('/editors/markdown.js');
            window.core = createEditorCore({ eventTarget: window });
            window.editor = document.createElement('div');
            editor.setAttribute('editor', 'markdown');
            editor.contentEditable = 'true';
            editor.style.whiteSpace = 'pre-wrap';
            editor.style.minHeight = '3em';
            document.body.append(editor);
            await core.initEditor(editor, { source });
            window.markdown = markdown;
            window.operations = [];
            window.lastSource = source;
            core.events.on('editor-update', ({ result }) => { lastSource = result.source; });
            window.snapshot = () => ({
                source: editor.editor.getSource(),
                storedSource: (core.getEditorDetails(editor) || []).map(detail => detail.value).join(''),
                html: editor.innerHTML,
                selection: markdown.getSelection(editor),
                details: core.getEditorDetails(editor)
            });
            window.selectSource = (start, end = start) => {
                editor.focus();
                markdown.setSelection(editor, { start, end });
            };
            window.errors = [];
            editor.addEventListener('editor-error', event => errors.push(event.detail.error.message));
        }, source);
        await run(page);
        assert.deepEqual(await page.evaluate(() => errors), []);
    } finally { await page.close(); }
}

test('typing a heading marker, its space, and text promotes the line once to h1', async () => {
    await fixture(async page => {
        await page.evaluate(() => selectSource(0));
        await page.keyboard.type('#');
        let result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '#');
        assert.equal(result.storedSource, result.source);
        assert.equal(await page.locator('h1').count(), 0);
        assert.equal(await page.locator('p').textContent(), '#');

        await page.keyboard.type(' ');
        result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '# ');
        assert.equal(result.storedSource, result.source);
        assert.equal(await page.locator('h1').count(), 0);
        assert.equal(await page.locator('p').textContent(), '# ');
        assert.equal(result.selection.start, 2);

        await page.keyboard.type('T');
        assert.equal(await page.locator('h1').count(), 1);
        await page.keyboard.type('itle');
        result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '# Title');
        assert.equal(result.storedSource, result.source);
        assert.equal(result.selection.start, 7);
        assert.equal(await page.locator('h1').count(), 1);
        assert.equal(await page.locator('h1').textContent(), 'Title');
    });
});

test('double heading markers stay visible through their space and then produce h2', async () => {
    await fixture(async page => {
        await page.evaluate(() => selectSource(0));
        await page.keyboard.type('## ');
        let result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '## ');
        assert.equal(await page.locator('h1,h2').count(), 0);
        assert.equal(await page.locator('p').textContent(), '## ');
        await page.keyboard.type('Heading');
        result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '## Heading');
        assert.equal(result.storedSource, result.source);
        assert.equal(await page.locator('h1').count(), 0);
        assert.equal(await page.locator('h2').count(), 1);
        assert.equal(await page.locator('h2').textContent(), 'Heading');
    });
});

test('a heading stays single when typing hash characters into its visible content', async () => {
    await fixture(async page => {
        await page.evaluate(() => selectSource(2));
        await page.keyboard.type('# ');
        const result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '# # Heading');
        assert.equal(result.storedSource, result.source);
        assert.equal(await page.locator('h1').count(), 1);
        assert.equal(await page.locator('h1').textContent(), '# Heading');
        assert.equal(result.selection.start, 4);
    }, '# Heading');
});

test('heading marker edits reparse: adding one promotes and removing it returns a paragraph', async () => {
    await fixture(async page => {
        await page.evaluate(() => selectSource(0));
        await page.keyboard.type('# ');
        assert.equal(await page.locator('h1').count(), 0);
        await page.keyboard.type('T');
        assert.equal(await page.locator('h1').count(), 1);
        await page.evaluate(() => core.receiveUpdate({ elements: [editor], start: 0, length: 2, value: '' }));
        let result = await page.evaluate(() => snapshot());
        assert.equal(result.source, 'T');
        assert.equal(await page.locator('h1').count(), 0);
        assert.equal(await page.locator('p').count(), 1);
        assert.equal(await page.locator('p').textContent(), 'T');
    });
});

test('Markdown edits preserve selection and synchronize new details on incoming CRDT updates', async () => {
    await fixture(async page => {
        await page.evaluate(() => selectSource(9));
        await page.keyboard.type('X');
        let result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '# HeadingX');
        assert.equal(result.storedSource, result.source);
        assert.equal(result.selection.start, 10);
        await page.evaluate(() => core.receiveUpdate({ elements: [editor], start: 0, length: 0, value: '# ' }));
        result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '# # HeadingX');
        assert.equal(result.storedSource, result.source);
        assert.equal(result.selection.start, 12);
        assert.equal(await page.locator('h1').count(), 1);
    }, '# Heading');
});

test('Enter creates a source newline, places the caret on the next line, and backspace joins lines', async () => {
    await fixture(async page => {
        await page.evaluate(() => selectSource(9));
        await page.keyboard.press('Enter');
        let result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '# Heading\n');
        assert.equal(result.selection.start, 10);
        await page.keyboard.type('Next');
        result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '# Heading\nNext');
        assert.equal(result.selection.start, 14);
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Backspace');
        result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '# Heading');
        assert.equal(result.storedSource, result.source);
        assert.equal(await page.locator('h1').textContent(), 'Heading');
    }, '# Heading');
});

test('composition text after a hidden heading prefix updates the correct source range', async () => {
    await fixture(async page => {
        await page.evaluate(() => {
            selectSource(9);
            editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            const text = editor.querySelector('h1').firstChild;
            text.data += '漢';
            const selection = document.getSelection();
            selection.setBaseAndExtent(text, text.data.length, text, text.data.length);
            editor.dispatchEvent(new InputEvent('beforeinput', {
                bubbles: true, inputType: 'insertCompositionText', data: '漢', isComposing: true
            }));
            editor.dispatchEvent(new InputEvent('input', {
                bubbles: true, inputType: 'insertCompositionText', data: '漢', isComposing: true
            }));
            editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '漢' }));
        });
        await page.waitForFunction(() => editor.editor.getSource() === '# Heading漢');
        const result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '# Heading漢');
        assert.equal(result.storedSource, result.source);
        assert.equal(result.selection.start, 10);
        assert.equal(await page.locator('h1').textContent(), 'Heading漢');
    }, '# Heading');
});

test('README Markdown renders its headings, links, images, table, and code blocks', async () => {
    const readme = fs.readFileSync(path.join(__dirname, 'markdown.md'), 'utf8');
    await fixture(async page => {
        const result = await page.evaluate(() => ({
            source: editor.editor.getSource(),
            headings: [...editor.querySelectorAll('h1,h2')].map(node => node.textContent),
            links: [...editor.querySelectorAll('a')].map(node => node.href),
            images: [...editor.querySelectorAll('img')].map(node => node.alt),
            tables: editor.querySelectorAll('table').length,
            tableRows: editor.querySelectorAll('table tr').length,
            tableHeaders: editor.querySelectorAll('table th').length,
            unorderedLists: editor.querySelectorAll('ul').length,
            orderedLists: editor.querySelectorAll('ol').length,
            fencedCode: [...editor.querySelectorAll('pre code')].map(node => node.textContent),
            visibleMarkdownLinks: editor.textContent.includes('[CoCreateWS]')
        }));
        assert.equal(result.source, readme);
        assert.ok(result.headings.includes('CoCreateJS'));
        assert.ok(result.headings.includes('What the client provides'));
        assert.ok(result.links.length >= 15);
        assert.equal(result.images.length, 4);
        assert.equal(result.tables, 1);
        assert.equal(result.tableRows, 12);
        assert.equal(result.tableHeaders, 2);
        assert.ok(result.unorderedLists >= 5);
        assert.equal(result.orderedLists, 0);
        assert.ok(result.fencedCode.some(code => code.includes('Declarative HTML')));
        assert.ok(result.fencedCode.some(code => code.includes('<script src=')));
        assert.equal(result.visibleMarkdownLinks, false);
    }, readme);
});

test('fenced HTML uses the code tokenizer and remains editable as Markdown source', async () => {
    const source = '```html\n<div class="card">Hello</div>\n```';
    await fixture(async page => {
        const initial = await page.evaluate(() => ({
            source: editor.editor.getSource(),
            language: editor.querySelector('pre code')?.dataset.language,
            tags: [...editor.querySelectorAll('.token-tag')].map(node => node.textContent),
            attributes: [...editor.querySelectorAll('.token-attribute')].map(node => node.textContent),
            codeText: editor.querySelector('pre code')?.textContent
        }));
        assert.equal(initial.source, source);
        assert.equal(initial.language, 'html');
        assert.deepEqual(initial.tags, ['div', 'div']);
        assert.deepEqual(initial.attributes, ['class']);
        assert.equal(initial.codeText, '<div class="card">Hello</div>\n');

        await page.evaluate(position => selectSource(position), source.indexOf('Hello') + 2);
        await page.keyboard.type('X');
        const edited = await page.evaluate(() => ({
            source: editor.editor.getSource(),
            text: editor.querySelector('pre code')?.textContent,
            selection: markdown.getSelection(editor)
        }));
        assert.equal(edited.source, '```html\n<div class="card">HeXllo</div>\n```');
        assert.equal(edited.text, '<div class="card">HeXllo</div>\n');
        assert.equal(edited.selection.start, source.indexOf('Hello') + 3);
    }, source);
});

test('ordered Markdown list markers render as an ordered list', async () => {
    await fixture(async page => {
        assert.equal(await page.locator('ol > li').count(), 2);
        assert.deepEqual(await page.locator('ol > li').allTextContents(), ['First', 'Second']);
    }, '1. First\n2. Second');
});

test('table cell text maps back to its Markdown source range when edited', async () => {
    const source = '| A | B |\n| --- | --- |\n| one | two |';
    await fixture(async page => {
        await page.evaluate(position => selectSource(position), source.indexOf('one') + 1);
        await page.keyboard.type('X');
        const result = await page.evaluate(() => snapshot());
        assert.equal(result.source, '| A | B |\n| --- | --- |\n| oXne | two |');
        assert.equal(result.storedSource, result.source);
        assert.equal(await page.locator('tbody td').first().textContent(), 'oXne');
        assert.equal(result.selection.start, source.indexOf('one') + 2);
    }, source);
});

test('fenced diagrams preserve significant spaces and line breaks', async () => {
    const diagram = [
        'Declarative HTML     Headless JavaScript     Existing Frameworks',
        '        \\                    |                       /',
        '         \\                   |                      /',
        '          +----------- CoCreateJS Client ----------+',
        '                              |',
        '             +----------------+----------------+',
        '             |                                 |',
        '       Local browser state             HTTP + WebSockets',
        '    IndexedDB · cache · PWA                    |',
        '                                                v',
        '                                           CoCreateWS',
        '                              CRUD · APIs · auth · files · realtime',
        '                                                |',
        '                              Databases · services · infrastructure'
    ].join('\n');
    const source = `\`\`\`text\n${diagram}\n\`\`\``;
    await fixture(async page => {
        const rendered = await page.locator('pre code').textContent();
        assert.equal(rendered, `${diagram}\n`);
        assert.equal(await page.evaluate(() => snapshot().source), source);
    }, source);
});

test('Setext underlines render h1 and h2 headings', async () => {
    const source = 'First title\n---\n\nSecond title\n===\n';
    await fixture(async page => {
        assert.equal(await page.locator('h2').textContent(), 'First title');
        assert.equal(await page.locator('h1').textContent(), 'Second title');
        assert.equal(await page.locator('p:not([data-markdown-placeholder-block])').count(), 0);
        assert.equal(await page.evaluate(() => snapshot().source), source);
    }, source);
});

test('paragraph soft wraps join and hard breaks remain visible', async () => {
    await fixture(async page => {
        assert.equal(await page.locator('p').count(), 2);
        assert.equal(await page.locator('p').first().textContent(), 'First line continues here');
        assert.equal(await page.locator('p').first().locator('br').count(), 0);
        assert.equal(await page.locator('p').last().locator('br').count(), 2);
    }, 'First line\ncontinues here\n\nHard break  \nSecond hard break\\\nFinal line');
});

test('multiline blockquotes group consecutive quoted lines', async () => {
    const source = '> First quoted line\n> second quoted line';
    await fixture(async page => {
        assert.equal(await page.locator('blockquote').count(), 1);
        assert.equal(await page.locator('blockquote p').count(), 1);
        assert.equal(await page.locator('blockquote').textContent(), 'First quoted line second quoted line');
        assert.equal(await page.evaluate(() => snapshot().source), source);
    }, source);
});

test('basic nested lists preserve their parent and child list structure', async () => {
    const source = '- Parent\n  - Child\n- Sibling';
    await fixture(async page => {
        assert.equal(await page.locator('[editor="markdown"] ul').count(), 2);
        assert.deepEqual(await page.locator('[editor="markdown"] > ul > li').allTextContents(), ['ParentChild', 'Sibling']);
        assert.equal(await page.locator('[editor="markdown"] ul > li > ul > li').textContent(), 'Child');
        assert.equal(await page.evaluate(() => snapshot().source), source);
    }, source);
});

test('ordered lists preserve their declared starting number', async () => {
    await fixture(async page => {
        assert.equal(await page.locator('ol').getAttribute('start'), '3');
        assert.deepEqual(await page.locator('ol > li').allTextContents(), ['Third', 'Fourth']);
    }, '3. Third\n4. Fourth');
});

test('bare URLs and email addresses remain plain unless explicitly linked', async () => {
    await fixture(async page => {
        assert.equal(await page.locator('a').count(), 0);
        assert.equal(await page.locator('p').textContent(), 'https://example.com name@example.com');
    }, 'https://example.com name@example.com');
});
