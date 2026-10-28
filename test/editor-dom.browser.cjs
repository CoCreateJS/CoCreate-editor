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
        if (pathname === '/') {
            res.setHeader('Content-Type', 'text/html');
            return res.end('<!doctype html><body></body>');
        }
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
async function fixture(source, run) {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    try {
        await page.goto(origin);
        await page.evaluate(async source => {
            const { createEditorCore } = await import('/editorCore.js');
            const dom = await import('/editors/dom.js');
            const { planDOMEdit } = await import('/editors/utilities/planDOMEdit.js');
            const { applyEditorDetailsPlan } = await import('/editors/utilities/updateEditorDetails.js');
            const { renderDOM } = await import('/editors/utilities/renderDOM.js');
            window.editor = document.createElement('div');
            editor.setAttribute('editor', 'dom');
            editor.setAttribute('crdt', 'false');
            editor.contentEditable = 'true';
            editor.style.minHeight = '2em';
            editor.value = source;
            editor.editor = { detachedNode: document.createElement('div') };
            document.body.append(editor);
            window.core = createEditorCore({ eventTarget: window });
            await core.initEditor(editor);
            window.details = core.getEditorDetails(editor);
            window.sourceOf = () => details.map(detail => detail.value).join('');
            window.apply = async change => {
                const before = sourceOf();
                const length = change.length ?? change.end - change.start;
                const string = before.slice(0, change.start) + change.value + before.slice(change.start + length);
                return (await core.receiveUpdate({ elements: [editor], ...change, string }))[0];
            };
            editor.editor.updateText = change => apply(change);
            window.sourceChildren = root => [...root.childNodes].filter(node =>
                !node.hasAttribute?.('data-cocreate-dom-break'));
            window.renderedHTML = root => {
                const copy = root.cloneNode(true);
                copy.querySelectorAll('[data-cocreate-dom-break]').forEach(node => node.remove());
                return copy.innerHTML;
            };
            window.checkFresh = () => {
                const fresh = document.createElement('div');
                dom.renderEditor(fresh, sourceOf(), dom.createDOMEditor(sourceOf(), fresh).details);
                const structure = node => [node.nodeType, node.nodeType === 1 ? node.localName : node.data,
                    node.attributes ? [...node.attributes].map(attr => [attr.name, attr.value]).sort(([a], [b]) => a.localeCompare(b)) : [],
                    sourceChildren(node.localName === 'template' ? node.content : node).map(structure)];
                const contents = root => JSON.stringify(sourceChildren(root).map(structure));
                const actual = contents(editor);
                if (contents(fresh) !== actual) throw new Error('Incremental DOM differs from a fresh details render: ' +
                    JSON.stringify({ source: sourceOf(), actual: renderedHTML(editor), expected: fresh.innerHTML }));
                if (contents(editor.editor.detachedNode) !== actual) throw new Error('Live and detached DOM differ');
            };
            Object.assign(window, { dom, planDOMEdit, applyEditorDetailsPlan, renderDOM });
            window.errors = [];
            editor.addEventListener('editor-error', event => errors.push(event.detail.error.message));
        }, source);
        await run(page);
        assert.deepEqual(await page.evaluate(() => errors), []);
    } finally { await page.close(); }
}

test('initial DOM comes from details, including broken source text, void nodes, and source-only whitespace', async () => {
    await fixture('<h3 class="a"  title="a b">Heading</h3>\n<div class="broken"\n<input disabled><img alt="x"><p>tail</p>', async page => {
        assert.deepEqual(await page.evaluate(() => {
            checkFresh();
            return [sourceChildren(editor).filter(node => node.nodeType === 1).length, sourceChildren(editor).filter(node => node.nodeType === 1).map(node => node.tagName),
                details.filter(detail => detail.sourceOnly).every(detail => !detail.liveNode && !detail.detachedNode),
                details.filter(detail => !detail.sourceOnly).every(detail => detail.liveNode && detail.detachedNode && detail.liveNode !== detail.detachedNode),
                editor.textContent];
        }), [4, ['H3', 'INPUT', 'IMG', 'P'], true, true, 'Heading\n<div class="broken"\ntail']);
    });
});

test('a character insertion updates the existing text detail and both existing Text nodes', async () => {
    await fixture('<main><p>Hello world</p><i>tail</i></main>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const target = details.find(detail => detail.value === 'Hello world');
            const live = target.liveNode, detached = target.detachedNode, parent = target.parentNode.liveNode;
            const result = await apply({ start: target.getStart() + 5, length: 0, value: '!' });
            checkFresh();
            return [core.getEditorDetails(editor) === details, result.affected[0] === target,
                target.liveNode === live, target.detachedNode === detached, target.parentNode.liveNode === parent,
                result.added.length, result.removed.length, result.reparse, live.data, detached.data];
        }), [true, true, true, true, true, 0, 0, null, 'Hello! world', 'Hello! world']);
    });
});

test('attribute edits retain element/Attr references, preserve spacing, and remove only managed attributes', async () => {
    await fixture('<p class="old"  title="A &amp; B">text</p><i>tail</i>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const element = details.find(detail => detail.kind === 'element');
            const live = element.liveNode, detached = element.detachedNode;
            const attr = element.getAttribute('class'), liveAttr = attr.liveNode, detachedAttr = attr.detachedNode;
            await element.setAttribute('class', 'new value');
            const sameAttribute = attr.liveNode === liveAttr && attr.detachedNode === detachedAttr;
            await element.setAttribute('data-id', '7');
            await element.removeAttribute('title');
            checkFresh();
            return [element.liveNode === live, element.detachedNode === detached, sameAttribute,
                live.getAttribute('class'), live.getAttribute('data-id'), live.hasAttribute('title'),
                sourceOf().includes('class="new value"  ')];
        }), [true, true, true, 'new value', '7', false, true]);
    });
});

test('editing a child tag retains its enclosing parent and moves the same text nodes into the new child', async () => {
    await fixture('<main><b>keep</b><i>tail</i></main>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const text = details.find(detail => detail.value === 'keep');
            const anchor = editor.firstChild;
            const live = text.liveNode, detached = text.detachedNode, oldParent = live.parentNode;
            await apply({ start: sourceOf().indexOf('<b>') + 1, length: 1, value: 'strong' });
            await apply({ start: sourceOf().indexOf('</b>') + 2, length: 1, value: 'strong' });
            checkFresh();
            return [editor.firstChild === anchor, details.includes(text), text.liveNode === live, text.detachedNode === detached,
                live.parentNode.tagName, detached.parentNode.tagName, oldParent.isConnected];
        }), [true, true, true, true, 'STRONG', 'STRONG', false]);
    });
});

test('removing a wrapper reparents retained live/detached child nodes without recreating them', async () => {
    await fixture('<main><b>keep</b><i>tail</i></main>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const text = details.find(detail => detail.value === 'keep');
            const live = text.liveNode, detached = text.detachedNode;
            const parent = details[0], tail = details.find(detail => detail.value === 'tail');
            const tailLive = tail.liveNode;
            await apply({ start: sourceOf().indexOf('<b>'), length: 3, value: '' });
            await apply({ start: sourceOf().indexOf('</b>'), length: 4, value: '' });
            checkFresh();
            return [text.liveNode === live, text.detachedNode === detached,
                live.parentNode === parent.liveNode, detached.parentNode === parent.detachedNode,
                tail.liveNode === tailLive, tailLive.isConnected];
        }), [true, true, true, true, true, true]);
    });
});

test('breaking then repairing a tag uses the staged objects and preserves unaffected siblings', async () => {
    await fixture('<section><b>keep</b><i>tail</i></section>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const tail = details.find(detail => detail.value === 'tail');
            const live = tail.liveNode, detached = tail.detachedNode;
            const start = sourceOf().indexOf('>keep');
            const broken = await apply({ start, length: 1, value: '' });
            checkFresh();
            const literal = editor.textContent.includes('<bkeep');
            const repaired = await apply({ start, length: 0, value: '>' });
            checkFresh();
            return [literal, broken.removed.some(item => item.detail.tag === 'b'),
                repaired.added.some(detail => detail.tag === 'b'), tail.liveNode === live,
                tail.detachedNode === detached, renderedHTML(editor)];
        }), [true, true, true, true, true, '<section><b>keep</b><i>tail</i></section>']);
    });
});

test('staging does not mutate either tree, and applying edits queries neither existing tree', async () => {
    await fixture('<main><p class="a">text</p><i>tail</i></main>', async page => {
        assert.deepEqual(await page.evaluate(() => {
            const beforeLive = renderedHTML(editor), beforeDetached = renderedHTML(editor.editor.detachedNode);
            const attribute = details.find(detail => detail.kind === 'attribute');
            const plan = planDOMEdit(details, attribute.getStart(), attribute.getStart() + attribute.length, 'class="b"');
            const stagedUnchanged = beforeLive === renderedHTML(editor) && beforeDetached === renderedHTML(editor.editor.detachedNode);
            const fail = () => { throw new Error('Existing DOM traversal was called'); };
            const walker = document.createTreeWalker;
            editor.querySelector = editor.querySelectorAll = fail;
            editor.editor.detachedNode.querySelector = editor.editor.detachedNode.querySelectorAll = fail;
            document.createTreeWalker = fail;
            try { applyEditorDetailsPlan(details, plan, { editor, render: renderDOM }); }
            finally { document.createTreeWalker = walker; }
            checkFresh();
            return [stagedUnchanged, editor.firstChild.firstChild.getAttribute('class'),
                editor.editor.detachedNode.firstChild.firstChild.getAttribute('class')];
        }), [true, 'b', 'b']);
    });
});

test('source text containing entities updates as decoded text on both trees', async () => {
    await fixture('<p>A &amp; B</p>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const text = details.find(detail => detail.kind === 'text' && !detail.sourceOnly);
            const live = text.liveNode;
            await apply({ start: text.getStart() + text.length, length: 0, value: ' &lt; C' });
            checkFresh();
            return [text.liveNode === live, live.data, text.detachedNode.data, text.value];
        }), [true, 'A & B < C', 'A & B < C', 'A &amp; B &lt; C']);
    });
});

test('full deletion clears both trees and later insertion can start from an empty array', async () => {
    await fixture('<p>x</p>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            await apply({ start: 0, length: sourceOf().length, value: '' });
            const empty = details.length === 0 && editor.childNodes.length === 0 && editor.editor.detachedNode.childNodes.length === 0;
            await apply({ start: 0, length: 0, value: '<input disabled><p>new</p>' });
            checkFresh();
            return [empty, renderedHTML(editor), renderedHTML(editor.editor.detachedNode)];
        }), [true, '<input disabled=""><p>new</p>', '<input disabled=""><p>new</p>']);
    });
});

test('delete: a single-character update preserves both existing Text nodes', async () => {
    await fixture('<p>Hello world</p><i>tail</i>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const text = details.find(detail => detail.value === 'Hello world');
            const live = text.liveNode, detached = text.detachedNode;
            const result = await apply({ start: text.getStart() + 5, length: 1, value: '' });
            checkFresh();
            return [text.liveNode === live, text.detachedNode === detached, live.data,
                result.added.length, result.removed.length, result.reparse];
        }), [true, true, 'Helloworld', 0, 0, null]);
    });
});

for (const [label, value] of [['selection delete', ''], ['selection insert', '<em>middle</em>']]) {
    test(`${label}: parse the surviving parent source, retain its node, and update both trees`, async () => {
        await fixture('<main><section><b>left</b> between <i>right</i></section><p>outside</p></main>', async page => {
            assert.deepEqual(await page.evaluate(async value => {
                const anchor = details.find(detail => detail.tag === 'section');
                const live = anchor.liveNode, detached = anchor.detachedNode;
                const outside = details.find(detail => detail.value === 'outside');
                const outsideLive = outside.liveNode, outsideDetached = outside.detachedNode;
                const source = sourceOf();
                const start = source.indexOf('eft'), end = source.indexOf('right') + 2;
                const result = await apply({ start, end, value });
                checkFresh();
                return [result.reparse.start <= start && result.reparse.end >= end, anchor.liveNode === live, anchor.detachedNode === detached,
                    outside.liveNode === outsideLive, outside.detachedNode === outsideDetached,
                    result.affected.length > 1, result.removed.length > 0,
                    value ? result.added.some(detail => detail.tag === 'em') : sourceOf().includes('<b>lght')];
            }, value), [true, true, true, true, true, true, true, true]);
        });
    });
}

test('successive CRDT character events use cumulative positions and preserve shared detail references', async () => {
    await fixture('<p>AB</p>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const text = details.find(detail => detail.value === 'AB');
            const live = text.liveNode, detached = text.detachedNode;
            const start = text.getStart() + 1;
            for (const [position, value] of [[start, 'X'], [start + 1, 'Y']]) {
                const done = new Promise(resolve => {
                    const off = core.events.on('editor-update', () => { off(); resolve(); });
                });
                const before = sourceOf();
                window.dispatchEvent(new CustomEvent('cocreate-crdt-update', { detail: {
                    elements: [editor], start: position, length: 0, value,
                    string: before.slice(0, position) + value + before.slice(position)
                } }));
                await done;
            }
            checkFresh();
            return [sourceOf(), text.liveNode === live, text.detachedNode === detached, live.data,
                details.every(detail => !Object.hasOwn(detail, 'start') && !Object.hasOwn(detail, 'end'))];
        }), ['<p>AXYB</p>', true, true, 'AXYB', true]);
    });
});

test('text split and merge reuse surviving native Text nodes in both projections', async () => {
    await fixture('<p>hello world</p>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const text = details.find(detail => detail.value === 'hello world');
            const live = text.liveNode, detached = text.detachedNode;
            await apply({ start: text.getStart() + 5, length: 0, value: '<b></b>' });
            checkFresh();
            const splitReuses = text.liveNode === live && text.detachedNode === detached && text.value === 'hello';
            const suffix = details.find(detail => detail.value === ' world');
            const suffixLive = suffix.liveNode, suffixDetached = suffix.detachedNode;
            await apply({ start: sourceOf().indexOf('<b>'), length: 7, value: '' });
            checkFresh();
            const merged = details.find(detail => detail.value === 'hello world');
            return [splitReuses,
                (merged.liveNode === live && merged.detachedNode === detached) ||
                (merged.liveNode === suffixLive && merged.detachedNode === suffixDetached),
                renderedHTML(editor)];
        }), [true, true, '<p>hello world</p>']);
    });
});

test('removeAttribute removes duplicate source attributes while retaining other attributes and spacing', async () => {
    await fixture('<p class="first"  title="keep" class="second"  CLASS="third">text</p>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const element = details.find(detail => detail.kind === 'element');
            const live = element.liveNode, detached = element.detachedNode;
            const title = element.getAttribute('title'), titleNode = title.liveNode;
            await element.removeAttribute('class');
            checkFresh();
            return [live.hasAttribute('class'), detached.hasAttribute('class'),
                details.filter(detail => detail.kind === 'attribute' && detail.name.toLowerCase() === 'class').length,
                title.liveNode === titleNode, live.getAttribute('title'), sourceOf()];
        }), [false, false, 0, true, 'keep', '<p   title="keep"   >text</p>']);
    });
});

test('template children initialize in content and retain their references across source edits', async () => {
    await fixture('<template class="example"><p>A &amp; B</p></template><i>tail</i>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const template = details.find(detail => detail.tag === 'template');
            const text = details.find(detail => detail.value === 'A &amp; B');
            const live = text.liveNode, detached = text.detachedNode;
            const initialized = template.liveNode.content.firstChild?.tagName === 'P' &&
                template.liveNode.content.textContent === 'A & B' && template.liveNode.childNodes.length === 0;
            await apply({ start: text.getStart() + text.length, length: 0, value: '!' });
            checkFresh();
            return [initialized, text.liveNode === live, text.detachedNode === detached,
                template.liveNode.content.textContent, template.detachedNode.content.textContent];
        }), [true, true, true, 'A & B!', 'A & B!']);
    });
});

test('a plain text update does not inspect attributes or mutate sibling structures', async () => {
    await fixture('<main><p class="a">text</p><i title="untouched">tail</i></main>', async page => {
        assert.equal(await page.evaluate(async () => {
            const text = details.find(detail => detail.value === 'text');
            const parent = text.parentNode.liveNode;
            const fail = () => { throw new Error('Plain text update touched unrelated DOM structure'); };
            const original = parent.getAttribute;
            parent.getAttribute = fail;
            parent.insertBefore = fail;
            try { await apply({ start: text.getStart() + text.length, length: 0, value: '!' }); }
            finally { parent.getAttribute = original; delete parent.insertBefore; }
            checkFresh();
            return text.liveNode.data;
        }), 'text!');
    });
});

test('detail APIs submit a source edit without mutating state until the update is returned', async () => {
    await fixture('<p class="old">text</p>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const element = details.find(detail => detail.kind === 'element');
            const attribute = element.getAttribute('class');
            const original = sourceOf(), live = attribute.liveNode, detached = attribute.detachedNode;
            const submitted = [];
            editor.editor.updateText = operation => { submitted.push(operation); return Promise.resolve('queued'); };
            const response = await element.setAttribute('class', 'new');
            const untouched = sourceOf() === original && attribute.value === 'class="old"' &&
                live.value === 'old' && detached.value === 'old';
            await apply(submitted[0]);
            checkFresh();
            return [response, submitted.length, submitted[0].start === attribute.getStart(), untouched,
                attribute.liveNode === live, attribute.detachedNode === detached, live.value, detached.value];
        }), ['queued', 1, true, true, true, true, 'new', 'new']);
    });
});

test('character reference decoding preserves literal CRLF and numeric carriage returns', async () => {
    await fixture('<p>first\r\n&amp; next &#13; last</p>', async page => {
        assert.deepEqual(await page.evaluate(() => {
            const text = details.find(detail => detail.kind === 'text' && !detail.sourceOnly);
            return [text.liveNode.data, text.detachedNode.data, text.value];
        }), ['first\r\n& next \r last', 'first\r\n& next \r last', 'first\r\n&amp; next &#13; last']);
    });
});

test('replacing a template wrapper reuses its descendant nodes when they move into the live document', async () => {
    await fixture('<main><template><p>keep</p></template><i>tail</i></main>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const paragraph = details.find(detail => detail.tag === 'p');
            const text = details.find(detail => detail.value === 'keep');
            const live = paragraph.liveNode, detached = paragraph.detachedNode;
            const liveText = text.liveNode, detachedText = text.detachedNode;
            const before = sourceOf(), start = before.indexOf('<template>');
            const end = before.indexOf('</template>') + '</template>'.length;
            const result = await apply({ start, end, value: '<p>keep</p>' });
            checkFresh();
            return [paragraph.liveNode === live, paragraph.detachedNode === detached,
                text.liveNode === liveText, text.detachedNode === detachedText,
                live.ownerDocument === document, live.parentNode.tagName,
                result.rendered.liveNode.added.filter(node => !node.hasAttribute?.('data-cocreate-dom-break')).length, renderedHTML(editor)];
        }), [true, true, true, true, true, 'MAIN', 0, '<main><p>keep</p><i>tail</i></main>']);
    });
});

test('typing the missing angle and closing tag converts broken source text into a live div', async () => {
    const source = '<h3>Heading</h3>\n<div class="broken"  data-note="missing closing angle"\n<p>After</p>';
    await fixture(source, async page => {
        await page.evaluate(() => {
            delete editor.editor.updateText; // The local demo uses the existing input/update fallback.
            const broken = details.find(detail => detail.kind === 'text' && detail.value.includes('<div'));
            editor.focus();
            const caret = document.createRange();
            caret.setStart(broken.liveNode, broken.liveNode.data.lastIndexOf('\n'));
            caret.collapse(true);
            document.getSelection().removeAllRanges();
            document.getSelection().addRange(caret);
        });
        await page.keyboard.type('></div>');
        assert.deepEqual(await page.evaluate(() => {
            checkFresh();
            return [sourceOf(), !!editor.querySelector('div.broken'),
                editor.querySelector('div.broken')?.childNodes.length,
                editor.querySelector('p')?.parentNode === editor];
        }), [source.replace('angle"\n', 'angle"></div>\n'), true, 0, true]);
    });
});

test('typing HTML from an empty DOM editor keeps raw source and renders completed elements', async () => {
    await fixture('', async page => {
        await page.evaluate(() => {
            delete editor.editor.updateText;
            editor.focus();
            const caret = document.createRange();
            caret.setStart(editor, 0);
            caret.collapse(true);
            document.getSelection().removeAllRanges();
            document.getSelection().addRange(caret);
        });
        await page.keyboard.type('<b>Hello</b>!');
        assert.deepEqual(await page.evaluate(() => {
            checkFresh();
            return [sourceOf(), renderedHTML(editor)];
        }), ['<b>Hello</b>!', '<b>Hello</b>!']);
    });
});

test('real typing preserves single quotes, spacing, and encoded entities in the source', async () => {
    const source = '<p title=\'A &amp; B\'  class="keep">a &amp; b</p>';
    await fixture(source, async page => {
        await page.evaluate(() => {
            delete editor.editor.updateText;
            editor.focus();
            const text = details.find(detail => detail.value === 'a &amp; b');
            const caret = document.createRange();
            caret.setStart(text.liveNode, 3);
            caret.collapse(true);
            document.getSelection().removeAllRanges();
            document.getSelection().addRange(caret);
        });
        await page.keyboard.type('X');
        assert.deepEqual(await page.evaluate(() => {
            checkFresh();
            return [sourceOf(), editor.firstChild.textContent, dom.getSource(editor)];
        }), [source.replace('a &amp; b', 'a &amp;X b'), 'a &X b', source.replace('a &amp; b', 'a &amp;X b')]);
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Backspace');
        assert.deepEqual(await page.evaluate(() => {
            checkFresh();
            return [sourceOf(), editor.firstChild.textContent];
        }), [source.replace('a &amp; b', 'a  b'), 'a  b']);
    });
});

test('real typing submits the actual source position inside repeated text', async () => {
    await fixture('<p>aaaa</p>', async page => {
        await page.evaluate(() => {
            delete editor.editor.updateText;
            window.operations = [];
            core.events.on('text-update', operation => operations.push(operation));
            editor.focus();
            const text = details.find(detail => detail.value === 'aaaa');
            const caret = document.createRange();
            caret.setStart(text.liveNode, 1);
            caret.collapse(true);
            document.getSelection().removeAllRanges();
            document.getSelection().addRange(caret);
        });
        await page.keyboard.type('a');
        assert.deepEqual(await page.evaluate(() => [sourceOf(), operations[0].start, operations[0].length, operations[0].value]),
            ['<p>aaaaa</p>', 4, 0, 'a']);
    });
});

test('typing a completed div also preserves the source caret through the existing update callback', async () => {
    const source = '<div class="broken"  data-note="missing closing angle"';
    await fixture(source, async page => {
        await page.evaluate(() => {
            editor.focus();
            const broken = details[0];
            const caret = document.createRange();
            caret.setStart(broken.liveNode, broken.liveNode.length);
            caret.collapse(true);
            document.getSelection().removeAllRanges();
            document.getSelection().addRange(caret);
        });
        await page.keyboard.type('></div>!');
        assert.deepEqual(await page.evaluate(() => {
            checkFresh();
            return [sourceOf(), editor.querySelector('.broken')?.childNodes.length, editor.lastChild.data];
        }), [source + '></div>!', 0, '!']);
    });
});

test('replacing a native selection with typed HTML preserves source offsets and keeps subsequent typing after the inserted tag', async () => {
    const source = '<main><b>left</b> between <i>right</i></main>';
    await fixture(source, async page => {
        await page.evaluate(() => {
            delete editor.editor.updateText;
            editor.focus();
            const left = details.find(detail => detail.value === 'left');
            const right = details.find(detail => detail.value === 'right');
            const selection = document.createRange();
            selection.setStart(left.liveNode, 1);
            selection.setEnd(right.liveNode, 2);
            document.getSelection().removeAllRanges();
            document.getSelection().addRange(selection);
        });
        await page.keyboard.insertText('<u>X</u>');
        await page.keyboard.type('!');
        assert.deepEqual(await page.evaluate(() => {
            checkFresh();
            return [sourceOf(), editor.querySelector('u')?.textContent];
        }), [source.slice(0, source.indexOf('eft')) + '<u>X</u>!' + source.slice(source.indexOf('right') + 2), 'X']);
    });
});

test('pasting a completed broken line preserves the completion through following edits', async () => {
    const original = '<h3>Heading</h3>\n<div class="broken"  data-note="missing closing angle"\n<p>After</p>';
    const completed = '<div class="broken"  data-note="missing closing angle"></div>';
    await fixture(original, async page => {
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.evaluate(async completed => {
            delete editor.editor.updateText;
            editor.focus();
            const broken = details.find(detail => detail.kind === 'text' && detail.value.includes('<div'));
            const range = document.createRange();
            range.setStart(broken.liveNode, 1);
            range.setEnd(broken.liveNode, broken.liveNode.length - 1);
            document.getSelection().removeAllRanges();
            document.getSelection().addRange(range);
            await navigator.clipboard.writeText(completed);
        }, completed);
        await page.keyboard.press('Control+v');
        await page.keyboard.type('!');
        assert.deepEqual(await page.evaluate(() => {
            checkFresh();
            return [sourceOf(), !!editor.querySelector('.broken'), editor.querySelector('p')?.parentNode === editor];
        }), [original.replace('<div class="broken"  data-note="missing closing angle"', completed + '!'), true, true]);
    });
});

test('a data-less input replacing a text node cannot make completed HTML revert to the old source', async () => {
    const original = '<h3>Heading</h3>\n<div class="broken"  data-note="missing closing angle"\n<p>After</p>';
    const completed = '<div class="broken"  data-note="missing closing angle"></div>';
    await fixture(original, async page => {
        await page.evaluate(completed => {
            delete editor.editor.updateText;
            editor.focus();
            const broken = details.find(detail => detail.kind === 'text' && detail.value.includes('<div'));
            const range = document.createRange();
            range.selectNodeContents(broken.liveNode);
            document.getSelection().removeAllRanges();
            document.getSelection().addRange(range);
            editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertReplacementText' }));
            const replacement = document.createTextNode('\n' + completed + '\n');
            broken.liveNode.replaceWith(replacement);
            const after = document.createRange(); after.setStart(replacement, completed.length + 1); after.collapse(true);
            document.getSelection().removeAllRanges(); document.getSelection().addRange(after);
            editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }));
        }, completed);
        await page.keyboard.type('!');
        assert.deepEqual(await page.evaluate(() => {
            checkFresh();
            return [sourceOf(), !!editor.querySelector('.broken')];
        }), [original.replace('<div class="broken"  data-note="missing closing angle"', completed + '!'), true]);
    });
});


test('the caret placeholder tracks the source end after a text update', async () => {
    await fixture('<p>alpha</p>', async page => {
        assert.equal(await page.evaluate(async () => {
            await apply({ start: sourceOf().indexOf('alpha') + 5, length: 0, value: '!' });
            return Number(editor.querySelector('[data-cocreate-dom-break]').getAttribute('data-cocreate-dom-break')) === sourceOf().length;
        }), true);
    });
});
