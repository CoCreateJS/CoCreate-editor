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
            const { createPrototypeCore } = await import('/prototype/core.js');
            const dom = await import('/prototype/editors/dom.js');
            const { planDOMEdit } = await import('/prototype/editors/utilities/planDOMEdit.js');
            const { applyEditorDetailsPlan } = await import('/prototype/editors/utilities/updateEditorDetails.js');
            const { renderDOM } = await import('/prototype/editors/utilities/renderDOM.js');
            window.editor = document.createElement('div');
            editor.setAttribute('editor', 'dom');
            editor.setAttribute('crdt', 'false');
            editor.contentEditable = 'true';
            editor.value = source;
            editor.editor = { detachedDOM: document.createElement('div') };
            document.body.append(editor);
            window.core = createPrototypeCore({ eventTarget: window });
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
            window.checkFresh = () => {
                const fresh = document.createElement('div');
                dom.renderEditor(fresh, sourceOf(), dom.parseDOM(sourceOf(), fresh));
                const structure = node => [node.nodeType, node.nodeType === 1 ? node.localName : node.data,
                    node.attributes ? [...node.attributes].map(attr => [attr.name, attr.value]).sort(([a], [b]) => a.localeCompare(b)) : [],
                    [...(node.localName === 'template' ? node.content : node).childNodes].map(structure)];
                const contents = root => JSON.stringify([...root.childNodes].map(structure));
                const actual = contents(editor);
                if (contents(fresh) !== actual) throw new Error('Incremental DOM differs from a fresh details render');
                if (contents(editor.editor.detachedDOM) !== actual) throw new Error('Live and detached DOM differ');
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
            return [editor.children.length, [...editor.children].map(node => node.tagName),
                details.filter(detail => detail.sourceOnly).every(detail => !detail.liveDOM && !detail.detachedDOM),
                details.filter(detail => !detail.sourceOnly).every(detail => detail.liveDOM && detail.detachedDOM && detail.liveDOM !== detail.detachedDOM),
                editor.textContent];
        }), [4, ['H3', 'INPUT', 'IMG', 'P'], true, true, 'Heading\n<div class="broken"\ntail']);
    });
});

test('a character insertion updates the existing text detail and both existing Text nodes', async () => {
    await fixture('<main><p>Hello world</p><i>tail</i></main>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const target = details.find(detail => detail.value === 'Hello world');
            const live = target.liveDOM, detached = target.detachedDOM, parent = target.parentDetails.liveDOM;
            const result = await apply({ start: target.getStart() + 5, length: 0, value: '!' });
            checkFresh();
            return [core.getEditorDetails(editor) === details, result.affected[0] === target,
                target.liveDOM === live, target.detachedDOM === detached, target.parentDetails.liveDOM === parent,
                result.added.length, result.removed.length, result.reparse, live.data, detached.data];
        }), [true, true, true, true, true, 0, 0, null, 'Hello! world', 'Hello! world']);
    });
});

test('attribute edits retain element/Attr references, preserve spacing, and remove only managed attributes', async () => {
    await fixture('<p class="old"  title="A &amp; B">text</p><i>tail</i>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const element = details.find(detail => detail.kind === 'element');
            const live = element.liveDOM, detached = element.detachedDOM;
            const attr = element.getAttribute('class'), liveAttr = attr.liveDOM, detachedAttr = attr.detachedDOM;
            await element.setAttribute('class', 'new value');
            const sameAttribute = attr.liveDOM === liveAttr && attr.detachedDOM === detachedAttr;
            await element.setAttribute('data-id', '7');
            await element.removeAttribute('title');
            checkFresh();
            return [element.liveDOM === live, element.detachedDOM === detached, sameAttribute,
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
            const live = text.liveDOM, detached = text.detachedDOM, oldParent = live.parentNode;
            await apply({ start: sourceOf().indexOf('<b>') + 1, length: 1, value: 'strong' });
            await apply({ start: sourceOf().indexOf('</b>') + 2, length: 1, value: 'strong' });
            checkFresh();
            return [editor.firstChild === anchor, details.includes(text), text.liveDOM === live, text.detachedDOM === detached,
                live.parentNode.tagName, detached.parentNode.tagName, oldParent.isConnected];
        }), [true, true, true, true, 'STRONG', 'STRONG', false]);
    });
});

test('removing a wrapper reparents retained live/detached child nodes without recreating them', async () => {
    await fixture('<main><b>keep</b><i>tail</i></main>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const text = details.find(detail => detail.value === 'keep');
            const live = text.liveDOM, detached = text.detachedDOM;
            const parent = details[0], tail = details.find(detail => detail.value === 'tail');
            const tailLive = tail.liveDOM;
            await apply({ start: sourceOf().indexOf('<b>'), length: 3, value: '' });
            await apply({ start: sourceOf().indexOf('</b>'), length: 4, value: '' });
            checkFresh();
            return [text.liveDOM === live, text.detachedDOM === detached,
                live.parentNode === parent.liveDOM, detached.parentNode === parent.detachedDOM,
                tail.liveDOM === tailLive, tailLive.isConnected];
        }), [true, true, true, true, true, true]);
    });
});

test('breaking then repairing a tag uses the staged objects and preserves unaffected siblings', async () => {
    await fixture('<section><b>keep</b><i>tail</i></section>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const tail = details.find(detail => detail.value === 'tail');
            const live = tail.liveDOM, detached = tail.detachedDOM;
            const start = sourceOf().indexOf('>keep');
            const broken = await apply({ start, length: 1, value: '' });
            checkFresh();
            const literal = editor.textContent.includes('<bkeep');
            const repaired = await apply({ start, length: 0, value: '>' });
            checkFresh();
            return [literal, broken.removed.some(item => item.detail.tag === 'b'),
                repaired.added.some(detail => detail.tag === 'b'), tail.liveDOM === live,
                tail.detachedDOM === detached, editor.innerHTML];
        }), [true, true, true, true, true, '<section><b>keep</b><i>tail</i></section>']);
    });
});

test('staging does not mutate either tree, and applying edits queries neither existing tree', async () => {
    await fixture('<main><p class="a">text</p><i>tail</i></main>', async page => {
        assert.deepEqual(await page.evaluate(() => {
            const beforeLive = editor.innerHTML, beforeDetached = editor.editor.detachedDOM.innerHTML;
            const attribute = details.find(detail => detail.kind === 'attribute');
            const plan = planDOMEdit(details, attribute.getStart(), attribute.getStart() + attribute.length, 'class="b"');
            const stagedUnchanged = beforeLive === editor.innerHTML && beforeDetached === editor.editor.detachedDOM.innerHTML;
            const fail = () => { throw new Error('Existing DOM traversal was called'); };
            const walker = document.createTreeWalker;
            editor.querySelector = editor.querySelectorAll = fail;
            editor.editor.detachedDOM.querySelector = editor.editor.detachedDOM.querySelectorAll = fail;
            document.createTreeWalker = fail;
            try { applyEditorDetailsPlan(details, plan, { editor, render: renderDOM }); }
            finally { document.createTreeWalker = walker; }
            checkFresh();
            return [stagedUnchanged, editor.firstChild.firstChild.getAttribute('class'),
                editor.editor.detachedDOM.firstChild.firstChild.getAttribute('class')];
        }), [true, 'b', 'b']);
    });
});

test('source text containing entities updates as decoded text on both trees', async () => {
    await fixture('<p>A &amp; B</p>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const text = details.find(detail => detail.kind === 'text' && !detail.sourceOnly);
            const live = text.liveDOM;
            await apply({ start: text.getStart() + text.length, length: 0, value: ' &lt; C' });
            checkFresh();
            return [text.liveDOM === live, live.data, text.detachedDOM.data, text.value];
        }), [true, 'A & B < C', 'A & B < C', 'A &amp; B &lt; C']);
    });
});

test('full deletion clears both trees and later insertion can start from an empty array', async () => {
    await fixture('<p>x</p>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            await apply({ start: 0, length: sourceOf().length, value: '' });
            const empty = details.length === 0 && editor.childNodes.length === 0 && editor.editor.detachedDOM.childNodes.length === 0;
            await apply({ start: 0, length: 0, value: '<input disabled><p>new</p>' });
            checkFresh();
            return [empty, editor.innerHTML, editor.editor.detachedDOM.innerHTML];
        }), [true, '<input disabled=""><p>new</p>', '<input disabled=""><p>new</p>']);
    });
});

test('delete: a single-character update preserves both existing Text nodes', async () => {
    await fixture('<p>Hello world</p><i>tail</i>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const text = details.find(detail => detail.value === 'Hello world');
            const live = text.liveDOM, detached = text.detachedDOM;
            const result = await apply({ start: text.getStart() + 5, length: 1, value: '' });
            checkFresh();
            return [text.liveDOM === live, text.detachedDOM === detached, live.data,
                result.added.length, result.removed.length, result.reparse];
        }), [true, true, 'Helloworld', 0, 0, null]);
    });
});

for (const [label, value] of [['selection delete', ''], ['selection insert', '<em>middle</em>']]) {
    test(`${label}: parse the surviving parent source, retain its node, and update both trees`, async () => {
        await fixture('<main><section><b>left</b> between <i>right</i></section><p>outside</p></main>', async page => {
            assert.deepEqual(await page.evaluate(async value => {
                const anchor = details.find(detail => detail.tag === 'section');
                const live = anchor.liveDOM, detached = anchor.detachedDOM;
                const outside = details.find(detail => detail.value === 'outside');
                const outsideLive = outside.liveDOM, outsideDetached = outside.detachedDOM;
                const source = sourceOf();
                const start = source.indexOf('eft'), end = source.indexOf('right') + 2;
                const result = await apply({ start, end, value });
                checkFresh();
                return [result.reparse.anchor === anchor, anchor.liveDOM === live, anchor.detachedDOM === detached,
                    outside.liveDOM === outsideLive, outside.detachedDOM === outsideDetached,
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
            const live = text.liveDOM, detached = text.detachedDOM;
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
            return [sourceOf(), text.liveDOM === live, text.detachedDOM === detached, live.data,
                details.every(detail => !Object.hasOwn(detail, 'start') && !Object.hasOwn(detail, 'end'))];
        }), ['<p>AXYB</p>', true, true, 'AXYB', true]);
    });
});

test('text split and merge reuse surviving native Text nodes in both projections', async () => {
    await fixture('<p>hello world</p>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const text = details.find(detail => detail.value === 'hello world');
            const live = text.liveDOM, detached = text.detachedDOM;
            await apply({ start: text.getStart() + 5, length: 0, value: '<b>' });
            checkFresh();
            const splitReuses = text.liveDOM === live && text.detachedDOM === detached && text.value === 'hello';
            const suffix = details.find(detail => detail.value === ' world');
            const suffixLive = suffix.liveDOM, suffixDetached = suffix.detachedDOM;
            await apply({ start: sourceOf().indexOf('<b>'), length: 3, value: '' });
            checkFresh();
            const merged = details.find(detail => detail.value === 'hello world');
            return [splitReuses,
                (merged.liveDOM === live && merged.detachedDOM === detached) ||
                (merged.liveDOM === suffixLive && merged.detachedDOM === suffixDetached),
                editor.innerHTML];
        }), [true, true, '<p>hello world</p>']);
    });
});

test('removeAttribute removes duplicate source attributes while retaining other attributes and spacing', async () => {
    await fixture('<p class="first"  title="keep" class="second"  CLASS="third">text</p>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const element = details.find(detail => detail.kind === 'element');
            const live = element.liveDOM, detached = element.detachedDOM;
            const title = element.getAttribute('title'), titleNode = title.liveDOM;
            await element.removeAttribute('class');
            checkFresh();
            return [live.hasAttribute('class'), detached.hasAttribute('class'),
                details.filter(detail => detail.kind === 'attribute' && detail.name.toLowerCase() === 'class').length,
                title.liveDOM === titleNode, live.getAttribute('title'), sourceOf()];
        }), [false, false, 0, true, 'keep', '<p   title="keep"   >text</p>']);
    });
});

test('template children initialize in content and retain their references across source edits', async () => {
    await fixture('<template class="example"><p>A &amp; B</p></template><i>tail</i>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const template = details.find(detail => detail.tag === 'template');
            const text = details.find(detail => detail.value === 'A &amp; B');
            const live = text.liveDOM, detached = text.detachedDOM;
            const initialized = template.liveDOM.content.firstChild?.tagName === 'P' &&
                template.liveDOM.content.textContent === 'A & B' && template.liveDOM.childNodes.length === 0;
            await apply({ start: text.getStart() + text.length, length: 0, value: '!' });
            checkFresh();
            return [initialized, text.liveDOM === live, text.detachedDOM === detached,
                template.liveDOM.content.textContent, template.detachedDOM.content.textContent];
        }), [true, true, true, 'A & B!', 'A & B!']);
    });
});

test('a plain text update does not inspect attributes or mutate sibling structures', async () => {
    await fixture('<main><p class="a">text</p><i title="untouched">tail</i></main>', async page => {
        assert.equal(await page.evaluate(async () => {
            const text = details.find(detail => detail.value === 'text');
            const parent = text.parentDetails.liveDOM;
            const fail = () => { throw new Error('Plain text update touched unrelated DOM structure'); };
            const original = parent.getAttribute;
            parent.getAttribute = fail;
            parent.insertBefore = fail;
            try { await apply({ start: text.getStart() + text.length, length: 0, value: '!' }); }
            finally { parent.getAttribute = original; delete parent.insertBefore; }
            checkFresh();
            return text.liveDOM.data;
        }), 'text!');
    });
});

test('detail APIs submit a source edit without mutating state until the update is returned', async () => {
    await fixture('<p class="old">text</p>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const element = details.find(detail => detail.kind === 'element');
            const attribute = element.getAttribute('class');
            const original = sourceOf(), live = attribute.liveDOM, detached = attribute.detachedDOM;
            const submitted = [];
            editor.editor.updateText = operation => { submitted.push(operation); return Promise.resolve('queued'); };
            const response = await element.setAttribute('class', 'new');
            const untouched = sourceOf() === original && attribute.value === 'class="old"' &&
                live.value === 'old' && detached.value === 'old';
            await apply(submitted[0]);
            checkFresh();
            return [response, submitted.length, submitted[0].start === attribute.getStart(), untouched,
                attribute.liveDOM === live, attribute.detachedDOM === detached, live.value, detached.value];
        }), ['queued', 1, true, true, true, true, 'new', 'new']);
    });
});

test('character reference decoding preserves literal CRLF and numeric carriage returns', async () => {
    await fixture('<p>first\r\n&amp; next &#13; last</p>', async page => {
        assert.deepEqual(await page.evaluate(() => {
            const text = details.find(detail => detail.kind === 'text' && !detail.sourceOnly);
            return [text.liveDOM.data, text.detachedDOM.data, text.value];
        }), ['first\r\n& next \r last', 'first\r\n& next \r last', 'first\r\n&amp; next &#13; last']);
    });
});

test('replacing a template wrapper reuses its descendant nodes when they move into the live document', async () => {
    await fixture('<main><template><p>keep</p></template><i>tail</i></main>', async page => {
        assert.deepEqual(await page.evaluate(async () => {
            const paragraph = details.find(detail => detail.tag === 'p');
            const text = details.find(detail => detail.value === 'keep');
            const live = paragraph.liveDOM, detached = paragraph.detachedDOM;
            const liveText = text.liveDOM, detachedText = text.detachedDOM;
            const before = sourceOf(), start = before.indexOf('<template>');
            const end = before.indexOf('</template>') + '</template>'.length;
            const result = await apply({ start, end, value: '<p>keep</p>' });
            checkFresh();
            return [paragraph.liveDOM === live, paragraph.detachedDOM === detached,
                text.liveDOM === liveText, text.detachedDOM === detachedText,
                live.ownerDocument === document, live.parentNode.tagName,
                result.rendered.liveDOM.added.length, editor.innerHTML];
        }), [true, true, true, true, true, 'MAIN', 0, '<main><p>keep</p><i>tail</i></main>']);
    });
});
