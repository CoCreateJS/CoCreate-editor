const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(__dirname, '../src');
let server, browser, origin;

before(async () => {
    server = http.createServer((req, res) => {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        res.setHeader('Content-Type', 'application/javascript');
        if (pathname.endsWith('.css')) return res.end('');
        if (pathname === '/text-utils.js') return res.end('export const checkValue=()=>true; export const getAttributes=el=>Object.fromEntries(["array","object","key"].map(name=>[name,el.getAttribute(name)]));');
        if (pathname === '/crdt.js') return res.end('export default {getText:async()=>{window.textReads=(window.textReads||0)+1;return window.initialText??""},updateText(data){window.crdtOperations.push(data)}};');
        if (pathname === '/observer.js') return res.end('export default {init(config){(window.observerConfigs ||= []).push(config)}};');
        if (pathname === '/actions.js') return res.end('export default {init(){}};');
        if (pathname === '/updateText') return res.end('export const insertAdjacentElement=()=>{},removeElement=()=>{},setInnerText=()=>{},setAttribute=()=>{},removeAttribute=()=>{},setClass=()=>{},setStyle=()=>{},replaceInnerText=()=>{};');
        if (pathname === '/events-adapter.js') return res.end(fs.readFileSync(
            path.resolve(__dirname, '../../CoCreate-events/src/index.js'), 'utf8'
        ).replace(/^import .*;\r?\n/gm, '').replace('CoCreateEvents.init();', ''));
        if (pathname === '/utils-selection.js')
            return res.end('export function getSelectionRects() { return []; }');
        const file = path.resolve(root, '.' + pathname);
        if (!file.startsWith(root + '/'))
            return res.writeHead(404).end();
        if (!fs.existsSync(file)) return res.writeHead(404).end();
        res.end(fs.readFileSync(file, 'utf8').replaceAll(
            '"@cocreate/utils/selection"', '"/utils-selection.js"'
        ).replaceAll('"@cocreate/utils"', '"/text-utils.js"')
            .replaceAll('"@cocreate/crdt"', '"/crdt.js"')
            .replaceAll('"@cocreate/observer"', '"/observer.js"')
            .replaceAll('"@cocreate/actions"', '"/actions.js"')
            .replace('import "@cocreate/element-prototype";', ''));
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

async function fixture(run) {
    const page = await browser.newPage();
    try {
        await page.goto(origin + '/editors/html.js');
        await page.evaluate(async () => {
            const [html, markdown, code, updates, ranges, attribute] = await Promise.all([
                import('/editors/html.js'), import('/editors/markdown.js'),
                import('/editors/code.js'), import('/updates.js'),
                import('/editors/utilities/ranges.js'),
                import('/editors/utilities/setAttribute.js')
            ]);
            Object.assign(window, {
                createHTMLDOM: html.default, createMarkdownDOM: markdown.default,
                createCodeDOM: code.default, ...updates, ...ranges,
                setHTMLAttribute: attribute.setHTMLAttribute
            });
            document.body.replaceChildren();
            window.check = (condition, message) => { if (!condition) throw new Error(message); };
            window.paired = root => {
                const liveRoot = root.liveNode;
                const doc = liveRoot.ownerDocument;
                const editorElement = (liveRoot === doc.documentElement || liveRoot === doc.body)
                    ? doc.defaultView.frameElement || liveRoot : liveRoot;
                for (const node of [root, ...root.querySelectorAll('*')]) {
                    check(!!node.editorPosition, `Missing position: ${node.nodeName}`);
                    check(node.editorPosition === node.liveNode?.editorPosition,
                        `Unshared position: ${node.nodeName}`);
                    check(getSourceRange(node.liveNode) === node.editorPosition,
                        'Live range lookup must use the shared object');
                    check(node.editorPosition.editorElement === editorElement,
                        `Wrong editor owner: ${node.nodeName}`);
                    check(![...node.liveNode.attributes].some(attr => /^data-(source|md)-/.test(attr.name)),
                        'Source positions must not become live attributes');
                }
            };
            window.host = (value, type, language = 'javascript') => {
                const element = document.createElement('div');
                element.setAttribute('editor', type);
                if (type === 'code') element.setAttribute('editor-language', language);
                document.body.append(element);
                element.value = value;
                element.editor = { dom: type === 'html' ? createHTMLDOM(value, document, element)
                    : type === 'markdown' ? createMarkdownDOM(value, element)
                    : createCodeDOM(value, element, language) };
                return element;
            };
        });
        await run(page);
    } finally { await page.close(); }
}

test('HTML shares positions and preserves object identity through attribute and sibling shifts', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        const value = '<section title="x"><p>A</p><p>B</p></section>';
        const element = host(value, 'html');
        const section = element.firstChild, second = section.lastChild;
        const sectionPosition = section.editorPosition, secondPosition = second.editorPosition;
        const staged = createHTMLDOM(value, document);
        const independent = staged.body.querySelector('section').editorPosition;
        paired(element.editor.dom.body);
        const next = value.replace('title="x"', 'title="longer"');
        updateHTML(element, { previous: value, string: next });
        check(element.firstChild === section && section.lastChild === second, 'Live nodes should be retained');
        check(section.editorPosition === sectionPosition && second.editorPosition === secondPosition,
            'Retained nodes must preserve position objects');
        check(secondPosition.start === next.indexOf('<p>B'), 'Following sibling must shift');
        check(sectionPosition.contentStart === next.indexOf('><p>') + 1, 'Content boundary must shift');
        check(section.title === 'longer', 'Attribute should render');
        check(independent.end === value.length, 'Staging must not share mutable positions with the persistent tree');
        paired(element.editor.dom.body);
        const last = next.replace('<p>B</p>', '<h2>B</h2>');
        updateHTML(element, { previous: next, string: last });
        check(section.lastChild.tagName === 'H2', 'Replaced node should render');
        check(section.lastChild.editorPosition !== secondPosition, 'Replacement must have its own object');
        paired(element.editor.dom.body);
        return true;
    }), true);
}));

test('Markdown shares nested ranges and shifts retained blocks without replacing their position objects', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        const value = '# **one**\n\nnext\n';
        const element = host(value, 'markdown');
        const paragraph = element.lastChild, position = paragraph.editorPosition;
        const rootPosition = element.editorPosition;
        paired(element.editor.dom);
        const next = value.replace('one', 'longer');
        updateMarkdown(element, { previous: value, string: next });
        check(element.lastChild === paragraph && paragraph.editorPosition === position, 'Paragraph reference must survive');
        check(position.start === next.indexOf('next'), 'Paragraph source position must shift');
        check(element.editorPosition === rootPosition && rootPosition.end === next.length, 'Root position must update in place');
        const strong = element.querySelector('strong');
        check(strong.editorPosition.contentEnd - strong.editorPosition.contentStart === 6, 'Nested content range must update');
        paired(element.editor.dom);
        return true;
    }), true);
}));

test('code tokens and empty HTML placeholders expose positions on both trees', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        const value = 'const x = 1;\n', element = host(value, 'code');
        const number = element.querySelector('.code-number'), position = number.editorPosition;
        const next = value.replace('x', 'longName');
        updateCode(element, { previous: value, string: next });
        check(element.querySelector('.code-number') === number && number.editorPosition === position,
            'Token should keep its shared position object');
        check(position.start === next.indexOf('1'), 'Token source position must shift');
        paired(element.editor.dom);
        paired(host('', 'html').editor.dom.body);
        paired(host('<div></div>', 'html').editor.dom.body);
        return true;
    }), true);
}));

test('HTML code tokens preserve exact source, entities and shared positions without creating source elements', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        const value = '<!DOCTYPE html>\n<!-- comment -->\n<h1 title="a > b &quot;yes&quot;" data-id=one disabled>Hello &amp; &#128512;</h1>\n<img src=photo.png />';
        const element = host(value, 'code', 'html');
        check(element.textContent === value && element.editor.dom.textContent === value, 'Tokenization must preserve every source character');
        check(!element.querySelector('h1, img'), 'Source tags must remain code text');
        check([...element.querySelectorAll('.code-tag')].map(node => node.textContent).join(',') === 'h1,h1,img', 'Tag names should have their own tokens');
        check(element.querySelector('.code-doctype')?.textContent === '<!DOCTYPE html>', 'DOCTYPE should be recognized');
        check(element.querySelector('.code-comment')?.textContent === '<!-- comment -->', 'Comments should be recognized');
        check(element.querySelector('.code-attribute-value')?.textContent === 'a > b ', 'Quoted brackets must remain inside the value');
        check(element.querySelector('.code-attribute')?.textContent === 'title', 'Attribute names should be separate tokens');
        check([...element.querySelectorAll('.code-entity')].map(node => node.textContent).join(',') === '&quot;,&quot;,&amp;,&#128512;', 'Entity spelling should be preserved');
        for (const node of element.querySelectorAll('.code-token')) {
            const { start, end } = node.editorPosition;
            check(value.slice(start, end) === node.textContent, 'Token position must address exact source');
        }
        paired(element.editor.dom);
        return true;
    }), true);
}));

test('unfinished HTML code stays literal and complete tokens recover after edits', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        for (const value of ['<', '</', '<h1', '</h1', '<h1 title=', '<h1 title="unfinished >', '<!-- unfinished', '<!DOCTYPE html']) {
            const element = host(value, 'code', 'html');
            check(element.textContent === value, 'Incomplete syntax must preserve source');
            check(!element.querySelector('.code-token'), `Incomplete syntax must stay literal: ${value}`);
            paired(element.editor.dom);
        }
        const value = '<h1>hello</h1>\n<h1>hello</h1>';
        const element = host(value, 'code', 'html');
        const rootPosition = element.editorPosition;
        const broken = value.replace('<h1>', '<h1');
        updateCode(element, { previous: value, string: broken });
        check(element.textContent === broken && element.firstChild.nodeType === 3 && element.firstChild.data.startsWith('<h1'),
            'Breaking a tag should turn it back into literal text');
        updateCode(element, { previous: broken, string: value });
        check(element.querySelectorAll('.code-tag').length === 4, 'Completing syntax should restore tokens');
        check(element.editorPosition === rootPosition, 'The editor position object should survive token recovery');
        check(element.textContent === value, 'Recovery must not repair or normalize the source');
        paired(element.editor.dom);
        return true;
    }), true);
}));

test('HTML code treats script and style bodies as literal text without executing or tokenizing inner markup', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        const script = '<script>window.codeExecuted = true; const markup = "<h1>";</script>';
        const style = '<style>.example::after { content: "<h1>"; }</style>';
        const element = host(script + style, 'code', 'html');
        check(element.textContent === script + style, 'Raw text bodies must preserve their source');
        check(element.querySelectorAll('.code-tag').length === 4, 'Raw text must not become nested HTML tokens');
        check(!element.querySelector('script, style, h1') && !window.codeExecuted, 'Code mode must not execute source');
        paired(element.editor.dom);
        return true;
    }), true);
}));

test('typing and deleting HTML delimiters updates code tokens and preserves the source caret', () => fixture(async page => {
    await page.evaluate(async () => {
        const { initElement } = await import('/index.js');
        const element = document.createElement('div');
        element.setAttribute('editor', 'code');
        element.setAttribute('editor-language', 'html');
        element.setAttribute('crdt', 'false');
        element.value = '';
        document.body.append(element);
        initElement(element);
        element.focus();
        window.htmlCode = element;
    });
    await page.keyboard.type('<h1');
    assert.equal(await page.evaluate(() => htmlCode.querySelectorAll('.code-token').length), 0);
    await page.keyboard.type('>hello</h1>');
    assert.equal(await page.evaluate(() => htmlCode.querySelectorAll('.code-tag').length), 2);
    await page.keyboard.press('Backspace');
    assert.equal(await page.evaluate(() => htmlCode.querySelectorAll('.code-tag').length), 1);
    await page.keyboard.type('>');
    assert.equal(await page.evaluate(async () => {
        const { getSelection } = await import('/selection.js');
        check(htmlCode.value === '<h1>hello</h1>' && htmlCode.textContent === htmlCode.value, 'Typing must preserve the source');
        check(getSelection(htmlCode).head === htmlCode.value.length, 'Retokenization must preserve the typing caret');
        paired(htmlCode.editor.dom);
        return true;
    }), true);
}));

test('iframe document elements share current positions after a document update', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        const frame = document.createElement('iframe');
        document.body.append(frame);
        const value = '<html><head><title>T</title></head><body><p>A</p></body></html>';
        frame.value = value;
        frame.editor = { dom: createHTMLDOM(value, document, frame.contentDocument.documentElement) };
        const paragraph = frame.contentDocument.querySelector('p');
        const position = paragraph.editorPosition;
        paired(frame.editor.dom.documentElement);
        const next = value.replace('T</title>', 'Title</title>');
        updateHTML(frame, { previous: value, string: next });
        check(frame.contentDocument.querySelector('p') === paragraph && paragraph.editorPosition === position,
            'Document updates must retain the body node and its shared position object');
        check(position.start === next.indexOf('<p>'), 'Iframe positions must shift');
        paired(frame.editor.dom.documentElement);
        return true;
    }), true);
}));

test('HTML editor setAttribute replaces, adds and removes complete attributes in source', () => fixture(async page => {
    assert.equal(await page.evaluate(async () => {
        const text = await import('/index.js');
        const value = '<section data-width="old"><p style = \'color: blue\' title></p></section>';
        const element = document.createElement('div');
        element.setAttribute('editor', 'html');
        element.setAttribute('crdt', 'false');
        element.setAttribute('value', value);
        document.body.append(element);
        text.initElement(element);
        const target = element.querySelector('p');
        check(typeof element.editor.setAttribute === 'function', 'HTML editor should expose setAttribute');
        await element.editor.setAttribute({ target, name: 'style', value: 'width: 20px; color: red' });
        check(element.value.includes('style="width: 20px; color: red"'), 'Existing quoted attribute should be replaced');
        check(element.value.includes('data-width="old"'), 'Attribute names should be matched as complete names');
        await element.editor.setAttribute({ target, name: 'aria-label', value: 'A "quoted" label' });
        check(element.value.includes('aria-label="A &quot;quoted&quot; label"'), 'Missing attributes should be added and escaped');
        await element.editor.setAttribute({ target, name: 'title', value: null });
        check(!element.value.includes('title'), 'Null values should remove the attribute');
        check(target.getAttribute('style') === 'width: 20px; color: red', 'The live DOM should reconcile from the updated source');
        paired(element.editor.dom.body);
        return true;
    }), true);
}));

test('observed code language changes retokenize current source while preserving selection and local history', () => fixture(async page => {
    assert.equal(await page.evaluate(async () => {
        const { initElement } = await import('/index.js');
        const { getSelection } = await import('/selection.js');
        const element = document.createElement('div');
        element.setAttribute('editor', 'code');
        element.setAttribute('editor-language', 'javascript');
        element.setAttribute('crdt', 'false');
        element.value = 'const total = 42;';
        document.body.append(element);
        initElement(element);
        await element.editor.updateText({ start: element.value.length, value: '\n// edited' });
        const source = element.value;
        const editor = element.editor, dom = editor.dom, undo = editor.localUndo;
        const updateText = editor.updateText;
        element.focus();
        document.getSelection().setBaseAndExtent(element.querySelector('.code-number').firstChild, 1,
            element.querySelector('.code-keyword').firstChild, 2);
        const before = getSelection(element);
        const observer = observerConfigs.find(config => config.types.includes('attributes'));
        const language = value => {
            if (value === null) element.removeAttribute('editor-language');
            else element.setAttribute('editor-language', value);
            observer.callback({ target: element, attributeName: 'editor-language' });
            check(element.value === source, 'Language changes must preserve edited source');
            check(element.editor === editor && editor.dom === dom && editor.updateText === updateText,
                'Language changes should retain the editor and its binding');
            check(editor.localUndo === undo && undo.length === 1, 'Language changes must preserve history');
            const after = getSelection(element);
            check(after.anchor === before.anchor && after.head === before.head, 'Source selection must survive retokenization');
            paired(editor.dom);
        };
        language('text');
        check(!element.querySelector('.code-token') && dom.editorPosition.language === 'text', 'Plain language should remove token wrappers');
        language('javascript');
        check(element.querySelector('.code-keyword')?.textContent === 'const', 'JavaScript tokens should return immediately');
        language(null);
        check(!element.querySelector('.code-token'), 'A code editor without a language should use plain code');
        await editor.undo();
        check(element.value === 'const total = 42;', 'Undo should still restore the edit from before the language change');
        return true;
    }), true);
}));

test('observed iframe code language changes preserve the CRDT binding without reading or writing source', () => fixture(async page => {
    assert.equal(await page.evaluate(async () => {
        const { initElement } = await import('/index.js');
        window.initialText = 'const total = 42;';
        window.crdtOperations = [];
        const frame = document.createElement('iframe');
        for (const [name, value] of Object.entries({ editor: 'code', 'editor-language': 'javascript',
            realtime: 'true', array: 'test', object: 'document', key: 'code' })) frame.setAttribute(name, value);
        document.body.append(frame);
        initElement(frame);
        await frame.editor.loading;
        const reads = window.textReads;
        const updateText = frame.editor.updateText;
        const observer = observerConfigs.find(config => config.types.includes('attributes'));
        for (const language of ['text', 'javascript']) {
            frame.setAttribute('editor-language', language);
            observer.callback({ target: frame, attributeName: 'editor-language' });
            check(frame.editor.updateText === updateText && window.textReads === reads,
                'Language changes must not rebind or reload CRDT');
            check(frame.value === initialText && !crdtOperations.length, 'Language changes must not submit source edits');
            check(!!frame.contentDocument.querySelector('.code-keyword') === (language === 'javascript'),
                'The iframe should reflect its current language');
            paired(frame.editor.dom);
        }
        return true;
    }), true);
}));
