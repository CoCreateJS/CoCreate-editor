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
        if (pathname === '/observer.js') return res.end('export default {init(config){(window.observerConfigs ||= []).push(...(Array.isArray(config) ? config : [config]))}};');
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

async function fixture(run, renderers = true) {
    const page = await browser.newPage();
    const requests = [];
    page.on("request", request => requests.push(new URL(request.url()).pathname));
    try {
        await page.goto(origin + '/selection.js');
        await page.evaluate(async renderers => {
            document.body.replaceChildren();
            window.check = (condition, message) => { if (!condition) throw new Error(message); };
            window.attributeObserver = {
                async callback(mutation) {
                    const configs = (window.observerConfigs || []).filter(config =>
                        config.types.includes('attributes') &&
                        (!config.attributeFilter || config.attributeFilter.includes(mutation.attributeName)) &&
                        (!config.selector || mutation.target.matches(config.selector)));
                    await Promise.all(configs.map(config => config.callback(mutation)));
                }
            };
            if (!renderers) return;
            const [dom, markdown, code, updates, details, nodeData, attribute] = await Promise.all([
                import('/editors/dom.js'), import('/editors/markdown.js'),
                import('/editors/code.js'), import('/updates.js'),
                import('/editors/utilities/details.js'), import('/editors/utilities/nodeData.js'),
                import('/editors/utilities/setAttribute.js')
            ]);
            await Promise.all([code.loadLanguage('html'), code.loadLanguage('javascript')]);
            Object.assign(window, {
                updateDOM: (element, change) => updates.updateProjection(element, change, dom.mode),
                updateMarkdown: (element, change) => updates.updateProjection(element, change, markdown.mode),
                updateCode: (element, change) => updates.updateProjection(element, change, code.mode),
                createDOM: dom.default, createMarkdownDOM: markdown.default,
                createCodeDOM: code.default, ...updates, ...details, ...nodeData,
                setHTMLAttribute: attribute.setHTMLAttribute
            });
            document.body.replaceChildren();
            window.check = (condition, message) => { if (!condition) throw new Error(message); };
            window.paired = root => {
                const liveRoot = getLiveNode(root);
                const doc = liveRoot.ownerDocument;
                const editorElement = (liveRoot === doc.documentElement || liveRoot === doc.body)
                    ? doc.defaultView.frameElement || liveRoot : liveRoot;
                for (const node of [root, ...root.querySelectorAll('*')]) {
                    const details = getEditorDetails(node), live = getLiveNode(node);
                    check(!!details, `Missing EditorDetails: ${node.nodeName}`);
                    check(details === live?.editorDetails,
                        `Unshared EditorDetails: ${node.nodeName}`);
                    check(["start", "end", "contentStart", "contentEnd"].every(name =>
                        Number.isInteger(details[name])),
                        `Missing editor boundary fields: ${node.nodeName}`);
                    check(details.detachDOM === node && details.liveDOM === live,
                        'EditorDetails must point to the detached and live elements');
                    check(!Object.hasOwn(node, 'editorDetails'),
                        'Detached elements must not store EditorDetails');
                    check(!['liveNode', '_sourceMap', '_mdMap'].some(name => Object.hasOwn(node, name)),
                        'Detached elements must not contain editor references or mapping properties');
                    check(details.editorElement === editorElement,
                        `Wrong editor owner: ${node.nodeName}`);
                    check(editorElement.editor.editorDetails.includes(details),
                        `The live element and editor index must share the same details object: ${node.nodeName} ${details.start}-${details.end}; index=${editorElement.editor.editorDetails.map(item => `${item.kind}:${item.start}-${item.end}`).join(',')}`);
                    check(![...node.attributes].some(attr =>
                        /^(?:data-editor-placeholder|data-(?:source|md)-)/.test(attr.name)),
                        'Detached markup must not contain editor-only attributes');
                }
                const details = editorElement.editor.editorDetails;
                check(details.every((item, index) => index === 0 ||
                    details[index - 1].start <= item.start),
                    'EditorDetails index must be sorted by source start');
            };
            window.host = (value, type, language = 'javascript') => {
                const element = document.createElement('div');
                element.setAttribute('editor', type);
                if (type === 'code') element.setAttribute('editor-language', language);
                document.body.append(element);
                element.value = value;
                element.editor = {};
                element.editor.dom = type === 'dom' ? createDOM(value, document, element)
                    : type === 'markdown' ? createMarkdownDOM(value, element)
                    : createCodeDOM(value, element, language);
                return element;
            };
        }, renderers);
        await run(page, requests);
    } finally { await page.close(); }
}

test('DOM editor shares EditorDetails and preserves object identity through attribute and sibling shifts', () => fixture(async page => {
    assert.equal(await page.evaluate(async () => {
        const { getEditorRange } = await import('/selection.js');
        const value = '<section title="x"><p>A</p><p>B</p></section>';
        const element = host(value, 'dom');
        const section = element.firstChild, second = section.lastChild;
        const sectionPosition = section.editorDetails, secondPosition = second.editorDetails;
        const staged = createDOM(value, document);
        const independent = getEditorDetails(staged.body.querySelector('section'));
        paired(element.editor.dom.body);
        const next = value.replace('title="x"', 'title="longer"');
        updateDOM(element, { previous: value, string: next });
        check(element.firstChild === section && section.lastChild === second, 'Live nodes should be retained');
        check(section.editorDetails === sectionPosition && second.editorDetails === secondPosition,
            'Retained nodes must preserve position objects');
        check(secondPosition.start === next.indexOf('<p>B'), 'Following sibling must shift');
        check(element.editor.findDetailsByStart(secondPosition.start) === secondPosition,
            'The sorted EditorDetails index should find a record by source start');
        check(sectionPosition.contentStart === next.indexOf('><p>') + 1, 'Content boundary must shift');
        check(section.title === 'longer', 'Attribute should render');
        const range = getEditorRange(element, next.indexOf('A') + 1);
        check(element.contains(range.startContainer), 'Source lookup should resolve to the live DOM');
        check(independent.end === value.length, 'Staging must not share mutable positions with the persistent tree');
        paired(element.editor.dom.body);
        const last = next.replace('<p>B</p>', '<h2>B</h2>');
        updateDOM(element, { previous: next, string: last });
        check(section.lastChild.tagName === 'H2', 'Replaced node should render');
        check(section.lastChild.editorDetails !== secondPosition, 'Replacement must have its own object');
        paired(element.editor.dom.body);
        return true;
    }), true);
}));

test('rendered updates normalize changes and retain source selections in every editor mode', () => fixture(async page => {
    assert.equal(await page.evaluate(async () => {
        const { getSelection } = await import('/selection.js');
        for (const [type, value, update] of [
            ['dom', '<p>alpha</p><p>tail</p>', updateDOM],
            ['markdown', 'alpha\n\ntail', updateMarkdown],
            ['code', 'alpha\ntail', updateCode]
        ]) {
            const element = host(value, type);
            element.contentEditable = 'true';
            element.setAttribute('value', value);
            element.focus();
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                if (node.data.includes('tail')) break;
            }
            const offset = node.data.indexOf('tail') + 2;
            document.getSelection().setBaseAndExtent(node, offset, node, offset);
            const next = value.replace('alpha', 'alphabet');
            update(element, { previous: value, string: next, start: 0, length: 0, value: 'stale' });
            check(getSelection(element)?.anchor === next.indexOf('tail') + 2,
                `${type}: the caret should follow the source change`);
            check(element.value === next && element.editor.inputValue === next && element.getAttribute('value') === next,
                `${type}: source values should agree after rendering`);
            paired(type === 'dom' ? element.editor.dom.body : element.editor.dom);
        }
        return true;
    }), true);
}));

test('DOM updates keep following siblings and selection when a tag breaks and is repaired', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        const value = '<p>first</p><p>second</p>';
        const element = host(value, 'dom');
        const second = element.lastChild, position = second.editorDetails;
        element.contentEditable = 'true';
        element.focus();
        document.getSelection().setBaseAndExtent(second.firstChild, 3, second.firstChild, 3);
        const broken = value.replace('</p>', '</p');
        updateDOM(element, { previous: value, string: broken });
        check(element.firstChild.nodeType === 3 && element.firstChild.data === '<p>first</p',
            'The damaged element should become literal source text');
        check(element.lastChild === second && position.start === broken.indexOf('<p>second'),
            'The following sibling should retain its identity and current range');
        check(document.getSelection().anchorNode === second.firstChild && document.getSelection().anchorOffset === 3,
            'Recovery should preserve the caret in the following sibling');
        paired(element.editor.dom.body);
        updateDOM(element, { previous: broken, string: value });
        check(element.firstChild.tagName === 'P' && element.lastChild === second,
            'Repair should render the first element without replacing its sibling');
        check(second.editorDetails === position && position.start === value.indexOf('<p>second'),
            'The sibling range object should survive repair');
        paired(element.editor.dom.body);
        return true;
    }), true);
}));

test('language-only nested editors stay isolated during selection, reconciliation and text updates', () => fixture(async page => {
    assert.equal(await page.evaluate(async () => {
        const { project, getSelection, ownsFocus } = await import('/selection.js');
        const { reconcile } = await import('/editors/utilities/projection.js');
        const { updateTextElement } = await import('/editors/text.js');
        const element = document.createElement('div');
        element.contentEditable = 'true';
        element.innerHTML = 'A<span editor-language="javascript">child draft</span>Z';
        document.body.append(element);
        const nested = element.querySelector('span');
        element.focus();
        document.getSelection().setBaseAndExtent(nested.firstChild, 2, nested.firstChild, 4);
        check(project(element).text === 'A\uFFFCZ', 'Nested editor contents should occupy one source position');
        check(getSelection(element) === null && !ownsFocus(element),
            'A selection inside the child should not belong to its parent');
        const staging = document.createElement('div');
        staging.innerHTML = 'A<span editor-language="javascript">source template</span>Z';
        reconcile(element, staging);
        check(element.querySelector('span') === nested && nested.textContent === 'child draft',
            'Parent reconciliation should preserve the child editor and its contents');
        updateTextElement(element, 'XA\uFFFCZ', { start: 0, length: 0, value: 'X' });
        check(element.querySelector('span') === nested && nested.textContent === 'child draft',
            'Parent text edits should preserve the independent child surface');
        check(project(element).text === 'XA\uFFFCZ', 'Parent text should update around the child');
        return true;
    }), true);
}));

test('Markdown shares nested ranges and shifts retained blocks without replacing their position objects', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        const value = '# **one**\n\nnext\n';
        const element = host(value, 'markdown');
        const paragraph = element.lastChild, position = paragraph.editorDetails;
        const rootPosition = element.editorDetails;
        paired(element.editor.dom);
        const next = value.replace('one', 'longer');
        updateMarkdown(element, { previous: value, string: next });
        check(element.lastChild === paragraph && paragraph.editorDetails === position, 'Paragraph reference must survive');
        check(position.start === next.indexOf('next'), 'Paragraph source position must shift');
        check(element.editorDetails === rootPosition && rootPosition.end === next.length, 'Root position must update in place');
        const strong = element.querySelector('strong');
        check(strong.editorDetails.contentEnd - strong.editorDetails.contentStart === 6, 'Nested content range must update');
        paired(element.editor.dom);
        return true;
    }), true);
}));

test('code tokens and empty HTML placeholders expose positions on both trees', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        const value = 'const x = 1;\n', element = host(value, 'code');
        const number = element.querySelector('.code-number'), position = number.editorDetails;
        const next = value.replace('x', 'longName');
        updateCode(element, { previous: value, string: next });
        check(element.querySelector('.code-number') === number && number.editorDetails === position,
            'Token should keep its shared position object');
        check(position.start === next.indexOf('1'), 'Token source position must shift');
        paired(element.editor.dom);
        paired(host('', 'dom').editor.dom.body);
        paired(host('<div></div>', 'dom').editor.dom.body);
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
            const { start, end } = node.editorDetails;
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
        const rootPosition = element.editorDetails;
        const broken = value.replace('<h1>', '<h1');
        updateCode(element, { previous: value, string: broken });
        check(element.textContent === broken && element.firstChild.nodeType === 3 && element.firstChild.data.startsWith('<h1'),
            'Breaking a tag should turn it back into literal text');
        updateCode(element, { previous: broken, string: value });
        check(element.querySelectorAll('.code-tag').length === 4, 'Completing syntax should restore tokens');
        check(element.editorDetails === rootPosition, 'The EditorDetails object should survive token recovery');
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
        await initElement(element);
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
        frame.editor = {};
        frame.editor.dom = createDOM(value, document, frame.contentDocument.documentElement);
        const paragraph = frame.contentDocument.querySelector('p');
        const position = paragraph.editorDetails;
        paired(frame.editor.dom.documentElement);
        const next = value.replace('T</title>', 'Title</title>');
        updateDOM(frame, { previous: value, string: next });
        check(frame.contentDocument.querySelector('p') === paragraph && paragraph.editorDetails === position,
            'Document updates must retain the body node and its shared position object');
        check(position.start === next.indexOf('<p>'), 'Iframe positions must shift');
        paired(frame.editor.dom.documentElement);
        return true;
    }), true);
}));

test('DOM editor setAttribute replaces, adds and removes complete attributes in source', () => fixture(async page => {
    assert.equal(await page.evaluate(async () => {
        const text = await import('/index.js');
        const value = '<section data-width="old"><p style = \'color: blue\' title></p></section>';
        const element = document.createElement('div');
        element.setAttribute('editor', 'dom');
        element.setAttribute('crdt', 'false');
        element.setAttribute('value', value);
        document.body.append(element);
        await text.initElement(element);
        const target = element.querySelector('p');
        check(typeof element.editor.setAttribute === 'function', 'DOM editor should expose setAttribute');
        await element.editor.setAttribute({ target, name: 'style', value: 'width: 20px; color: red' });
        check(element.value.includes("style = 'width: 20px; color: red'"), 'Existing quote style and spacing should be preserved');
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
        await initElement(element);
        await element.editor.updateText({ start: element.value.length, value: '\n// edited' });
        const source = element.value;
        const editor = element.editor, undo = editor.localUndo;
        let dom = editor.dom;
        const updateText = editor.updateText;
        element.focus();
        document.getSelection().setBaseAndExtent(element.querySelector('.code-number').firstChild, 1,
            element.querySelector('.code-keyword').firstChild, 2);
        const before = getSelection(element);
        const observer = attributeObserver;
        const language = async value => {
            if (value === null) element.removeAttribute('editor-language');
            else element.setAttribute('editor-language', value);
            await observer.callback({ target: element, attributeName: 'editor-language' });
            check(element.value === source, 'Language changes must preserve edited source');
            check(element.editor === editor && editor.updateText === updateText,
                'Language changes should retain the editor and its source binding');
            check(editor.dom !== dom, 'Every language change must create a fresh rendering');
            dom = editor.dom;
            check(editor.localUndo === undo && undo.length === 1, 'Language changes must preserve history');
            const after = getSelection(element);
            check(after.anchor === before.anchor && after.head === before.head, 'Source selection must survive retokenization');
            paired(editor.dom);
        };
        await language('text');
        check(!element.querySelector('.code-token') && getEditorDetails(dom).language === 'text', 'Plain language should remove token wrappers');
        await language('javascript');
        check(element.querySelector('.code-keyword')?.textContent === 'const', 'JavaScript tokens should return immediately');
        await language(null);
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
        await initElement(frame);
        const reads = window.textReads;
        const updateText = frame.editor.updateText;
        const observer = attributeObserver;
        for (const language of ['text', 'javascript']) {
            frame.setAttribute('editor-language', language);
            await observer.callback({ target: frame, attributeName: 'editor-language' });
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

test('modes and individual languages are requested only when needed and reused across elements', () => fixture(async (page, requests) => {
    await page.evaluate(async () => {
        window.api = (await import('/index.js')).default;
        window.makeEditor = async (name, language) => {
            const element = document.createElement('div');
            element.setAttribute('editor', name);
            if (language !== undefined) element.setAttribute('editor-language', language);
            element.setAttribute('crdt', 'false');
            element.value = '<h1>hello</h1>';
            document.body.append(element);
            await api.initElement(element);
            return element;
        };
        await makeEditor('text');
    });
    const modeRequests = () => requests.filter(path => /^\/editors\/(dom|markdown|code)\.js$/.test(path));
    const languageRequests = () => requests.filter(path => path.startsWith('/editors/language/'));
    assert.deepEqual(modeRequests(), []);
    assert.deepEqual(languageRequests(), []);
    await page.evaluate(async () => {
        window.codeEditor = await makeEditor('code');
        check(!codeEditor.querySelector('.code-token'), 'Code without a language should be plain text');
    });
    assert.deepEqual(modeRequests(), ['/editors/code.js']);
    assert.deepEqual(languageRequests(), []);
    await page.evaluate(async () => {
        codeEditor.setAttribute('editor-language', 'javascript');
        const observer = attributeObserver;
        await observer.callback({ target: codeEditor, attributeName: 'editor-language' });
        await makeEditor('code', 'js');
    });
    assert.deepEqual(languageRequests(), ['/editors/language/javascript.js']);
    await page.evaluate(async () => {
        const element = await makeEditor('code', 'html');
        check(!!element.querySelector('.code-tag'), 'HTML language should highlight source');
        await makeEditor('code', 'unknown');
        await makeEditor('code', 'constructor');
    });
    assert.deepEqual(languageRequests(), ['/editors/language/javascript.js', '/editors/language/html.js']);
    assert.deepEqual(modeRequests(), ['/editors/code.js']);
    await page.evaluate(async () => {
        const element = await makeEditor('dom');
        check(element.firstChild.tagName === 'H1', 'DOM mode should render elements');
        await makeEditor('markdown');
        await makeEditor('dom');
    });
    assert.deepEqual(modeRequests(), ['/editors/code.js', '/editors/dom.js', '/editors/markdown.js']);
    assert.equal(languageRequests().length, 2);
}, false));

test('a delayed mode cannot replace a newer mode or source update', () => fixture(async page => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/editors/code.js', async route => { await gate; await route.continue(); });
    await page.evaluate(async () => {
        window.api = (await import('/index.js')).default;
        window.element = document.createElement('div');
        element.setAttribute('editor', 'text');
        element.setAttribute('crdt', 'false');
        element.value = 'original';
        document.body.append(element);
        await api.initElement(element);
        window.observer = attributeObserver;
    });
    const requested = page.waitForRequest('**/editors/code.js');
    await page.evaluate(() => {
        element.setAttribute('editor', 'code');
        window.firstMode = observer.callback({ target: element, attributeName: 'editor' });
    });
    await requested;
    await page.evaluate(async () => {
        window.sourceUpdate = api.updateElement({ element, string: '# newest' });
        element.setAttribute('editor', 'markdown');
        await observer.callback({ target: element, attributeName: 'editor' });
        check(element.value === '# newest' && element.firstChild.tagName === 'H1',
            'The latest mode should render the pending source');
    });
    release();
    await page.evaluate(async () => {
        await Promise.all([firstMode, sourceUpdate]);
        check(element.editor.modeName === 'markdown' && element.value === '# newest',
            'The stale load should not overwrite the latest mode or value');
    });
}, false));

test('mode changes during initialization finish with the current mode', () => fixture(async page => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/editors/code.js', async route => { await gate; await route.continue(); });
    const requested = page.waitForRequest('**/editors/code.js');
    await page.evaluate(async () => {
        window.api = (await import('/index.js')).default;
        window.element = document.createElement('div');
        element.setAttribute('editor', 'code');
        element.setAttribute('editor-language', 'javascript');
        element.value = '<p>latest</p>';
        document.body.append(element);
        api.initElement(element);
    });
    await requested;
    await page.evaluate(() => {
        element.setAttribute('editor', 'dom');
        attributeObserver
            .callback({ target: element, attributeName: 'editor' });
    });
    release();
    await page.evaluate(async () => {
        while (element.editor.loading) await element.editor.loading;
        check(element.editor.modeName === 'dom' && element.firstChild.tagName === 'P',
            'Initialization should apply the most recently requested mode');
    });
}, false));

test('failed language loading reports an error and preserves source and history', () => fixture(async page => {
    await page.route('**/editors/language/javascript.js', route => route.abort());
    await page.evaluate(async () => {
        const api = (await import('/index.js')).default;
        const element = document.createElement('div');
        element.setAttribute('editor', 'code');
        element.value = 'const value = 1;';
        document.body.append(element);
        await api.initElement(element);
        await element.editor.updateText({ start: element.value.length, value: '// edit' });
        let errors = 0;
        element.addEventListener('editor-error', () => errors++);
        const observer = attributeObserver;
        element.setAttribute('editor-language', 'javascript');
        await observer.callback({ target: element, attributeName: 'editor-language' });
        check(errors === 1 && element.value.endsWith('// edit'), 'Load failures should report without discarding edits');
        element.removeAttribute('editor-language');
        await observer.callback({ target: element, attributeName: 'editor-language' });
        await element.editor.undo();
        check(element.value === 'const value = 1;', 'History should survive failed and recovered loads');
    });
}, false));

test('a delayed language does not overwrite a newer language choice', () => fixture(async page => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/editors/language/javascript.js', async route => { await gate; await route.continue(); });
    await page.evaluate(async () => {
        const api = (await import('/index.js')).default;
        window.element = document.createElement('div');
        element.setAttribute('editor', 'code');
        element.value = '<h1>hello</h1>';
        document.body.append(element);
        await api.initElement(element);
        window.observer = attributeObserver;
    });
    const requested = page.waitForRequest('**/editors/language/javascript.js');
    await page.evaluate(() => {
        element.setAttribute('editor-language', 'javascript');
        window.firstLanguage = observer.callback({ target: element, attributeName: 'editor-language' });
    });
    await requested;
    await page.evaluate(async () => {
        element.setAttribute('editor-language', 'html');
        await observer.callback({ target: element, attributeName: 'editor-language' });
        check(element.querySelectorAll('.code-tag').length === 2, 'The newer language should render first');
    });
    release();
    await page.evaluate(async () => {
        await firstLanguage;
        check(element.editor.modeKey === 'code:html' && element.querySelectorAll('.code-tag').length === 2,
            'A late language import should not replace the current highlighting');
    });
}, false));

test('switching between text and DOM modes preserves source selection and local history', () => fixture(async page => {
    await page.evaluate(async () => {
        const api = (await import('/index.js')).default;
        const { getSelection } = await import('/selection.js');
        const element = document.createElement('div');
        element.setAttribute('editor', 'text');
        element.value = '<p>alpha</p>';
        document.body.append(element);
        await api.initElement(element);
        await element.editor.updateText({ start: 8, value: '!' });
        const undo = element.editor.localUndo, updateText = element.editor.updateText;
        element.focus();
        document.getSelection().setBaseAndExtent(element.firstChild, 5, element.firstChild, 7);
        const before = getSelection(element);
        const observer = attributeObserver;
        for (const name of ['dom', 'text']) {
            element.setAttribute('editor', name);
            await observer.callback({ target: element, attributeName: 'editor' });
            const selection = getSelection(element);
            check(selection.anchor === before.anchor && selection.head === before.head,
                `${name}: source selection should survive switching modes`);
            check(element.editor.updateText === updateText && element.editor.localUndo === undo,
                'Switching modes should retain editing methods and history');
        }
        check(element.textContent === '<p>alpha!</p>', 'Text mode should show the canonical source');
        await element.editor.undo();
        check(element.value === '<p>alpha</p>' && element.textContent === element.value,
            'Undo should restore the edit from before the mode changes');
    });
}, false));

test('typing during an initial mode load is retained when its renderer arrives', () => fixture(async page => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/editors/code.js', async route => { await gate; await route.continue(); });
    const requested = page.waitForRequest('**/editors/code.js');
    await page.evaluate(async () => {
        window.api = (await import('/index.js')).default;
        window.element = document.createElement('div');
        element.setAttribute('editor', 'code');
        element.value = 'start';
        document.body.append(element);
        window.initializing = api.initElement(element);
    });
    await page.waitForFunction(() => element.editor?.init);
    await page.evaluate(() => {
        check(element.textContent === 'start' && element.editor.init,
            'The text source should be editable before the requested mode loads');
        element.focus();
        document.getSelection().setBaseAndExtent(element.firstChild, 5, element.firstChild, 5);
    });
    await requested;
    await page.keyboard.type('X');
    release();
    await page.waitForFunction(() => element.editor.modeName === 'code' && element.value === 'startX');
    await page.evaluate(async () => {
        check(element.textContent === 'startX', 'Loading should retain the edit made while waiting');
        await element.editor.undo();
        check(element.value === 'start', 'The edit made while loading should remain in local history');
    });
}, false));


test('indexed DOM changes remove broken subtrees and repair gap text without walking existing trees', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        let value = '<section><p><b>first</b></p><p>second</p></section>';
        const element = host(value, 'dom');
        const section = element.firstChild, first = section.firstChild, second = section.lastChild;
        const position = second.editorDetails, index = element.editor.editorDetails;
        const nestedTag = first.firstChild.tagName;
        element.contentEditable = 'true';
        element.focus();
        const caret = second.firstChild;
        document.getSelection().setBaseAndExtent(caret, 3, caret, 3);
        const removed = index.filter(item => item === first.editorDetails || item.parentDetails === first.editorDetails);
        const restores = [];
        const block = (node, name) => {
            const descriptor = Object.getOwnPropertyDescriptor(node, name);
            Object.defineProperty(node, name, { configurable: true, get() { throw new Error('Existing DOM traversal: ' + name); } });
            restores.push(() => descriptor ? Object.defineProperty(node, name, descriptor) : delete node[name]);
        };
        for (const item of index) {
            for (const name of ['children', 'childNodes', 'querySelector', 'querySelectorAll', 'contains']) block(item.detachDOM, name);
            for (const name of ['children', 'childNodes', 'querySelector', 'querySelectorAll']) block(item.liveDOM, name);
        }
        const apply = next => { updateDOM(element, { previous: value, string: next }); value = next; };
        try {
            apply(value.replace('</p>', '</p'));
            check(section.firstChild.nodeType === 3 && section.firstChild.data === '<p><b>first</b></p', 'Broken wrapper and its descendants must become literal text');
            const text = section.firstChild, details = text.editorDetails;
            check(details.kind === 'text' && details.liveDOM === text && details.detachDOM.nodeType === 3, 'Literal gap text must have a shared node record');
            check(index.includes(details) && removed.every(item => !index.includes(item)), 'Index must drop the entire damaged subtree');
            apply(value.replace('</p<p>', '</p><p>'));
            check(section.firstChild.tagName === 'P' && section.firstChild.firstChild.tagName === nestedTag, 'Repair must turn indexed literal text back into elements');
            check(!index.includes(details), 'Repaired text record must leave the index');
            check(section.lastChild === second && second.editorDetails === position && index === element.editor.editorDetails, 'Sibling, details, and index identities must survive');
            check(document.getSelection().anchorNode === caret && document.getSelection().anchorOffset === 3, 'The caret must survive without projecting or traversing either tree');
        } finally { restores.reverse().forEach(restore => restore()); }
        paired(element.editor.dom.body);
        return true;
    }), true);
}));

test('indexed DOM content edits parse only their enclosing element and shift later text maps', () => fixture(async page => {
    assert.equal(await page.evaluate(async () => {
        const { getEditorRange } = await import('/selection.js');
        const value = '<section><p>A &amp; B</p><p>tail</p></section>outside';
        const element = host(value, 'dom');
        const section = element.firstChild, paragraph = section.firstChild;
        const tail = section.lastChild, outside = element.lastChild;
        const outsideDetails = outside.editorDetails, rootDetails = element.editorDetails;
        const implementation = document.implementation;
        const create = implementation.createHTMLDocument;
        implementation.createHTMLDocument = () => { throw new Error('A content edit must not parse the whole document'); };
        const next = value.replace('A &amp; B', 'Alpha &amp; Beta');
        try { updateDOM(element, { previous: value, string: next }); }
        finally { implementation.createHTMLDocument = create; }
        check(element.firstChild === section && section.firstChild === paragraph && section.lastChild === tail, 'Content edits must retain existing element references');
        check(paragraph.textContent === 'Alpha & Beta', 'Entity decoding must preserve source mappings');
        check(outside === element.lastChild && outside.editorDetails === outsideDetails && outsideDetails.start === next.indexOf('outside'), 'Following gap text must shift in place');
        check(rootDetails.end === next.length && section.editorDetails.end === next.indexOf('outside'), 'Enclosing ranges must grow');
        const range = getEditorRange(element, next.indexOf('outside') + 3);
        check(range.startContainer === outside && range.startOffset === 3, 'Following text maps must use shifted source offsets');
        paired(element.editor.dom.body);
        return true;
    }), true);
}));

test('indexed DOM range lookup handles enclosing records, complete deletion, and equal-start insertion', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        let value = '<p>A</p>gap<p>B</p>';
        const element = host(value, 'dom'), first = element.firstChild, last = element.lastChild;
        const position = last.editorDetails;
        const gap = element.childNodes[1];
        check(element.editor.findDetailsContaining(value.indexOf('gap') + 1) === gap.editorDetails, 'Containing lookup must include text between elements');
        check(element.editor.findDetailsContaining(1, value.indexOf('gap')) === first.editorDetails, 'Range lookup must return the enclosing element');
        const apply = (start, length, insertion) => {
            const next = value.slice(0, start) + insertion + value.slice(start + length);
            updateDOM(element, { previous: value, string: next, start, length, value: insertion });
            value = next;
        };
        apply(0, 0, '<p>new</p>');
        check(element.childNodes[1] === first && element.lastChild === last, 'Insertion at a shared start must preserve the original following element');
        const removed = element.firstChild.editorDetails;
        apply(0, '<p>new</p><p>A</p>gap'.length, '');
        check(element.firstChild === last && last.editorDetails === position && position.start === 0, 'Fully covered nodes must be removed while retaining the following element');
        check(!element.editor.editorDetails.includes(removed) && !element.editor.editorDetails.includes(first.editorDetails), 'Discarded records must leave the array');
        paired(element.editor.dom.body);
        return true;
    }), true);
}));

test('indexed DOM parent updates preserve independently owned child editor content and details', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        const value = '<section><span editor="text">template</span><p>tail</p></section>';
        const element = host(value, 'dom');
        const child = element.firstChild.firstChild;
        child.__cocreateEditor = true;
        child.textContent = 'independent draft';
        child.editor = { init: true };
        const own = { owner: 'child' };
        child.editorDetails = own;
        const next = value.replace('tail', 'changed');
        updateDOM(element, { previous: value, string: next });
        check(element.firstChild.firstChild === child && child.textContent === 'independent draft' && child.editorDetails === own, 'A parent content edit must preserve the nested owner');
        const full = next.replace('<section>', '<section title="new">');
        updateDOM(element, { previous: next, string: full });
        check(element.firstChild.firstChild === child && child.textContent === 'independent draft' && child.editorDetails === own, 'A document plan must preserve the nested owner');
        check(element.editor.editorDetails.every(item => item.liveDOM.editorDetails === item && item.liveDOM.isConnected), 'The parent index must not include child-owned or detached records');
        return true;
    }), true);
}));

test('indexed DOM plans match fresh rendering across structural edits, entities, comments, and empty content', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        const values = [
            '<section><p>one</p><p>two</p></section>gap',
            '<section><p>one plus</p><p>two</p></section>gap',
            '<section title="x"><p>one plus</p><p>two</p></section>gap',
            '<section title="x"><p>one plus</p>between<p>two</p></section>gap',
            '<section title="x"><p></p>between<p>two</p></section>gap',
            '<section title="x"><p>\n</p>between<p>two</p></section>gap',
            '<section title="x"><p>\n\n</p>between<p>two</p></section>gap',
            '<section title="x"><p>&amp; &#x1F642;</p>between<p>two</p></section>gap',
            '<section title="x"><p>&amp; &#x1F642;</p><!--comment-->between<p>two</p></section>gap',
            '<section title="x"><p>&amp; &#x1F642;</p><!--changed-->between<p>two</p></section>gap',
            '<section title="x"><h2>&amp; &#x1F642;</h2>between<p>two</p></section>gap',
            '<section title="x">between<p>two</p></section>gap',
            '<section title="x">between</section>gap',
            '', 'plain &amp; text', '<p>plain &amp; text</p>',
            '<p>plain &amp; text</p><p>last</p>', '<p>last</p>',
            '<html lang="en"><head><title>Title</title></head><body><p>last</p></body></html>',
            '<html lang="fr"><head><title>Changed</title></head><body><p>last</p></body></html>'
        ];
        const element = host(values[0], 'dom');
        let previous = values[0];
        for (const string of values.slice(1)) {
            updateDOM(element, { previous, string });
            const fresh = createDOM(string, document);
            check(element.innerHTML === fresh.body.innerHTML, `Indexed plan differs from fresh rendering: ${string}; got ${element.innerHTML}; expected ${fresh.body.innerHTML}`);
            check(element.editor.dom.documentElement.outerHTML === fresh.documentElement.outerHTML, 'The unmirrored document and head must stay current too');
            const records = element.editor.editorDetails;
            check(records.every((item, i) => !i || records[i - 1].start <= item.start), 'Updated array must stay sorted');
            check(records.every(item => item.liveDOM.editorDetails === item && item.liveDOM.isConnected && getEditorDetails(item.detachDOM) === item), 'Every indexed node must retain the shared object and both references');
            paired(element.editor.dom.body);
            previous = string;
        }
        return true;
    }), true);
}));

test('indexed DOM document plans synchronize doctypes and synthetic equal-start containers', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        const frame = document.createElement('iframe');
        document.body.append(frame);
        let value = '<!doctype html><html><body><p>A</p></body></html>';
        frame.value = value;
        frame.editor = {};
        frame.editor.dom = createDOM(value, document, frame.contentDocument.documentElement);
        const apply = next => { updateDOM(frame, { previous: value, string: next }); value = next; };
        apply(value.replace('doctype html', 'doctype svg'));
        check(frame.contentDocument.doctype.name === 'svg' && frame.editor.dom.doctype.name === 'svg', 'Both documents must receive the new doctype');
        apply(value.replace('<html>', '<html class="first">'));
        apply(value.replace('class="first"', 'class="second"'));
        check(frame.contentDocument.documentElement.className === 'second', 'Source classes on the iframe document must update');
        const body = frame.contentDocument.body;
        apply(value.replace('<body>', '<body title="updated">'));
        check(frame.contentDocument.body === body && body.title === 'updated', 'Synthetic head at the same start must not hide the body record');
        const at = value.indexOf('<p>');
        check(frame.editor.findDetailsContaining(at, at + 2).tag === 'p', 'Containing lookup must select the actual source element');
        paired(frame.editor.dom.documentElement);
        return true;
    }), true);
}));


test('indexed DOM consumes native mutation references without leaving duplicate or moved nodes', () => fixture(async page => {
    assert.equal(await page.evaluate(async () => {
        const value = '<p>first</p><p>tail</p>';
        const element = host(value, 'dom');
        const first = element.firstChild, last = element.lastChild;
        const added = document.createTextNode('native');
        first.append(added);
        // Cover both queued records and records already delivered to the observer.
        await Promise.resolve();
        const next = value.replace('first', 'firstnative');
        updateDOM(element, { previous: value, string: next });
        check(first.textContent === 'firstnative' && !added.isConnected && element.lastChild === last, 'Native inserted nodes must not remain alongside the canonical update');
        const wrapper = document.createElement('div');
        element.append(wrapper);
        wrapper.append(last);
        const final = next.replace('firstnative', 'changed');
        updateDOM(element, { previous: next, string: final });
        check(!wrapper.isConnected && element.lastChild === last && last.parentNode === element, 'Known nodes moved by native DOM input must return through their stored references');
        paired(element.editor.dom.body);
        return true;
    }), true);
}));

test('indexed DOM boundary damage keeps node references, source maps, and ranges consistent', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        const value = '<section title="x"><p>A &amp; B</p>gap<p><b>tail</b></p></section>';
        const replacements = ['', '<', '>', '"', '</p>', '\n'];
        let seed = 1729;
        const random = size => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % size; };
        for (let i = 0; i < 120; i++) {
            const element = host(value, 'dom');
            const start = random(value.length + 1), length = Math.min(random(8), value.length - start);
            const insertion = replacements[random(replacements.length)];
            const string = value.slice(0, start) + insertion + value.slice(start + length);
            updateDOM(element, { previous: value, string, start, length, value: insertion });
            const records = element.editor.editorDetails;
            check(new Set(records).size === records.length, 'Each record must occur once in the array');
            for (const item of records) {
                check(0 <= item.start && item.start <= item.contentStart && item.contentStart <= item.contentEnd && item.contentEnd <= item.end && item.end <= string.length,
                    `Invalid source boundaries after edit ${start}:${length}:${insertion}`);
                check(item.liveDOM.editorDetails === item && getEditorDetails(item.detachDOM) === item && item.liveDOM.isConnected, 'All indexed references must stay live and shared');
                const map = getSourceMap(item.detachDOM);
                if (map) {
                    check(map === getSourceMap(item.liveDOM), 'Both text nodes must share the current map');
                    check(item.liveDOM.data === item.detachDOM.data && map.length === item.detachDOM.length, 'Text and map lengths must agree');
                    check(map.every(([from, to]) => item.start <= from && from <= to && to <= item.end), 'Text mappings must stay inside their source record');
                }
            }
            paired(element.editor.dom.body);
            element.remove();
        }
        return true;
    }), true);
}));


test('indexed DOM preserves selection direction across decoded entity spans', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        const value = '<p>A&#x1F642;B</p><p>tail</p>';
        const element = host(value, 'dom');
        element.contentEditable = 'true';
        element.focus();
        const text = element.firstChild.firstChild;
        // Both UTF-16 units map to the same complete entity in the source.
        document.getSelection().setBaseAndExtent(text, 2, text, 1);
        const next = value.replace('<p>', '<p title="new">');
        updateDOM(element, { previous: value, string: next });
        const selection = document.getSelection();
        check(selection.anchorNode === text && selection.focusNode === text && selection.anchorOffset === 3 && selection.focusOffset === 1,
            'Backward selections must retain their direction and encompass the complete source entity');
        return true;
    }), true);
}));

test('indexed DOM builds complete mutation lists before changing either tree', () => fixture(async page => {
    assert.equal(await page.evaluate(async () => {
        const { mode } = await import('/editors/dom.js');
        const { planIndexedDOM, applyDOMUpdatePlan } = await import('/editors/utilities/indexedDOM.js');
        const value = '<section><p><b>first</b></p><p>second</p></section>';
        const element = host(value, 'dom'), root = element.editor.dom.body;
        const first = element.firstChild.firstChild, second = element.firstChild.lastChild;
        const index = element.editor.editorDetails;
        const snapshot = index.map(item => [item, item.start, item.contentStart, item.contentEnd, item.end, item.liveDOM, item.detachDOM]);
        const beforeLive = element.innerHTML, beforeDetached = root.innerHTML;
        const change = { start: value.indexOf('</p>') + 3, length: 1, value: '' };
        const string = value.slice(0, change.start) + value.slice(change.start + 1);
        const staging = mode.render(string, element, change, root);
        const plan = planIndexedDOM(element.editor.dom, staging, element, change);
        check(element.innerHTML === beforeLive && root.innerHTML === beforeDetached, 'Planning must not mutate either existing tree');
        check(index.length === snapshot.length && snapshot.every(([item, ...previous], i) => index[i] === item &&
            [item.start, item.contentStart, item.contentEnd, item.end, item.liveDOM, item.detachDOM].every((field, j) => field === previous[j])),
            'Planning must retain the array, positions, and both DOM references');
        check(plan.removed.includes(first.editorDetails) && plan.removed.some(item => item.liveDOM === first.firstChild), 'The removal list must retain all descendant objects');
        check(plan.removeRoots.length === 1 && plan.removeRoots[0] === first.editorDetails, 'Only the outermost removed node needs a DOM removal');
        check(plan.added.some(item => item.kind === 'text' && item.literal), 'Broken source must appear in the addition list as literal text');
        check(plan.retained.includes(second.editorDetails) && !plan.removed.includes(second.editorDetails), 'The retained list must preserve the following element');
        const additions = plan.added.slice(), removals = plan.removed.slice();
        applyDOMUpdatePlan(plan);
        check(element.firstChild.firstChild.nodeType === 3 && element.firstChild.lastChild === second, 'Commit must apply the planned sequence');
        check(additions.every(item => index.includes(item) && item.liveDOM.editorDetails === item && item.liveDOM.isConnected), 'Commit must insert the exact addition objects from the plan');
        check(removals.every(item => !index.includes(item) && !item.liveDOM.isConnected), 'Removal references must remain available after commit');
        paired(root);
        return true;
    }), true);
}));

test('indexed DOM numeric lookup stays consistent across equal starts, gaps, and retained subtree shifts', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        let value = '<section><p>one</p>gap<p>two</p></section>';
        const element = host(value, 'dom');
        const assertLookup = () => {
            const records = element.editor.editorDetails;
            for (let start = 0; start <= value.length; start++) {
                for (const end of [start, Math.min(value.length, start + 4), value.length]) {
                    const number = element.editor.findDetailsIndex(start, end);
                    const containing = records.filter(item => item.start <= start && end <= item.end);
                    const depth = item => { let n = 0; for (; item; item = item.parentDetails) n++; return n; };
                    const deepest = containing.sort((a, b) => depth(b) - depth(a) || b.start - a.start || (a.kind === 'root') - (b.kind === 'root'))[0];
                    check((number < 0 ? undefined : records[number]) === deepest, `Numeric lookup must identify the deepest record for ${start}-${end}`);
                    check(element.editor.findDetailsContaining(start, end) === deepest, 'Object and numeric lookup must agree');
                }
            }
        };
        assertLookup();
        const previous = value;
        value = value.replace('one', 'longer text');
        updateDOM(element, { previous, string: value });
        assertLookup();
        check(element.editor.findDetailsIndex(-1) === -1 && element.editor.findDetailsIndex(value.length + 1) === -1,
            'Positions outside the source must have no array index');
        check(element.editor.findDetailsIndex(5, 2) === -1, 'Reversed ranges must have no array index');
        return true;
    }), true);
}));

test('real observer lazily initializes added editors and refreshes languages and modes without rebinding', () => fixture(async (page, requests) => {
    await page.route('**/observer.js', route => route.fulfill({
        contentType: 'application/javascript',
        body: fs.readFileSync(path.resolve(__dirname, '../node_modules/@cocreate/observer/src/index.js'), 'utf8')
    }));
    await page.evaluate(async () => {
        window.api = (await import('/index.js')).default;
        const output = await api.render('<p>source</p>', { mode: 'code', language: 'html' });
        check(output.textContent === '<p>source</p>', 'Detached rendering must preserve source');
    });
    assert.equal(requests.includes('/Core.js'), false, 'Detached rendering must keep editing core unloaded');
    await page.evaluate(() => {
        window.element = document.createElement('div');
        element.setAttribute('editor', 'code');
        element.setAttribute('editor-language', 'javascript');
        element.setAttribute('crdt', 'false');
        element.value = 'const count = 42;';
        document.body.append(element);
    });
    await page.waitForFunction(() => element.editor?.modeKey === 'code:javascript' && element.querySelector('.code-number'));
    await page.evaluate(async () => {
        await element.editor.updateText({ start: element.value.length, value: '// edited' });
        window.methods = element.editor.updateText;
        window.undoHistory = element.editor.localUndo;
        window.source = element.value;
        element.setAttribute('editor-language', 'text');
    });
    await page.waitForFunction(() => element.editor.modeKey === 'code:text' && !element.querySelector('.code-token'));
    await page.evaluate(() => { element.setAttribute('editor-language', 'javascript'); });
    await page.waitForFunction(() => element.editor.modeKey === 'code:javascript' && element.querySelector('.code-number'));
    await page.evaluate(() => { element.setAttribute('editor', 'dom'); });
    await page.waitForFunction(() => element.editor.modeName === 'dom');
    await page.evaluate(() => {
        check(element.value === source && element.editor.updateText === methods && element.editor.localUndo === undoHistory,
            'Native observer callbacks must preserve source, editing methods, and history');
        element.setAttribute('editor', 'code');
    });
    await page.waitForFunction(() => element.editor.modeKey === 'code:javascript');
    await page.evaluate(async () => {
        await element.editor.undo();
        check(element.value === 'const count = 42;', 'History must remain usable after observed transitions');
        window.initialText = 'const total = 99;';
        window.frame = document.createElement('iframe');
        for (const [name, value] of Object.entries({ editor: 'code', 'editor-language': 'javascript',
            realtime: 'true', array: 'test', object: 'document', key: 'code' })) frame.setAttribute(name, value);
        window.crdtWrites = 0;
        window.bindingObserver = new MutationObserver(records => { crdtWrites += records.length; });
        bindingObserver.observe(frame, { attributes: true, attributeFilter: ['crdt'] });
        document.body.append(frame);
    });
    await page.waitForFunction(() => frame.editor?.modeKey === 'code:javascript' && frame.contentDocument.querySelector('.code-number'));
    await page.evaluate(() => {
        window.frameMethods = frame.editor.updateText;
        window.reads = window.textReads;
        frame.setAttribute('editor-language', 'text');
    });
    await page.waitForFunction(() => frame.editor.modeKey === 'code:text' && !frame.contentDocument.querySelector('.code-token'));
    await page.evaluate(() => { frame.setAttribute('editor-language', 'javascript'); });
    await page.waitForFunction(() => frame.editor.modeKey === 'code:javascript' && frame.contentDocument.querySelector('.code-number'));
    await page.evaluate(() => {
        check(frame.editor.updateText === frameMethods, 'Observed iframe language changes must preserve the editing method');
        check(window.textReads === reads && frame.value === initialText, 'Observed iframe language changes must avoid another source read');
        check(crdtWrites === 1, 'Initializing a bound editor must write the CRDT attribute only once');
        bindingObserver.disconnect();
    });
}, false));

test('language changes directly replace the entire rendering while preserving the CRDT binding', () => fixture(async page => {
    assert.equal(await page.evaluate(async () => {
        const api = (await import('/index.js')).default;
        window.initialText = 'const value = 42;';
        window.crdtOperations = [];
        const element = document.createElement('div');
        for (const [name, value] of Object.entries({ editor: 'code', 'editor-language': 'javascript',
            realtime: 'true', array: 'test', object: 'document', key: 'code' })) element.setAttribute(name, value);
        document.body.append(element);
        await api.initElement(element);
        const editor = element.editor, updateText = editor.updateText;
        const sourceBinding = editor.sourceBinding, reads = window.textReads;
        const replace = element.replaceChildren;
        let replacements = 0;
        element.replaceChildren = function(...nodes) { replacements++; return replace.apply(this, nodes); };
        element.insertBefore = () => { throw new Error('A language change must not reconcile the live children'); };
        Object.defineProperty(element, 'childNodes', { configurable: true, get() { throw new Error('A language change must not traverse the old live children'); } });
        for (const language of ['text', 'javascript']) {
            const oldDOM = editor.dom, oldIndex = editor.editorDetails;
            const oldFirst = element.firstChild;
            Object.defineProperty(oldDOM, 'childNodes', { configurable: true, get() { throw new Error('A language change must not reconcile the old detached tree'); } });
            oldDOM.querySelectorAll = () => { throw new Error('A language change must not query the old detached tree'); };
            element.setAttribute('editor-language', language);
            await attributeObserver.callback({ target: element, attributeName: 'editor-language' });
            check(editor.dom !== oldDOM && editor.editorDetails !== oldIndex, 'Every language change must rebuild the detached tree and index');
            check(!oldFirst.isConnected && oldIndex.every(item => !editor.editorDetails.includes(item)), 'The previous live nodes and detail objects must not be reused');
            check(editor.updateText === updateText && editor.sourceBinding === sourceBinding && window.textReads === reads,
                'Rendering changes must not rebuild or read the CRDT binding');
            check(element.value === initialText && !crdtOperations.length, 'Rendering changes must preserve canonical text without CRDT operations');
        }
        check(replacements === 2, 'Each language change must directly replace the contents once');
        delete element.childNodes;
        return true;
    }), true);
}));

test('editor details attributes expose decoded values and exact source ranges', () => fixture(async page => {
    assert.equal(await page.evaluate(async () => {
        const api = await import('/index.js');
        const source = `<p title='class="fake" > &copy=x &copy;' data-id = "A &amp; B" disabled data-x=plain empty="" data-id-2="other"></p>`;
        const element = document.createElement('div');
        element.setAttribute('editor', 'dom');
        element.setAttribute('crdt', 'false');
        element.value = source;
        document.body.append(element);
        await api.initElement(element);
        const target = element.firstChild, details = target.editorDetails;
        const attributes = details.attributes;
        check(Array.isArray(attributes) && attributes.map(item => item.name).join(',') === 'title,data-id,disabled,data-x,empty,data-id-2', 'Attributes must be ordered source records');
        for (const item of attributes) {
            check(source.slice(item.nameStart, item.nameEnd) === item.name, 'Name coordinates must reference the canonical source');
            check(item.value === target.getAttribute(item.name), 'Values must match decoded HTML attribute values');
            if (item.valueStart !== null) check(source.slice(item.valueStart, item.valueEnd) === item.rawValue, 'Value coordinates must span encoded source characters');
            if (item.quote) check(source[item.quoteStart] === item.quote && source[item.quoteEnd] === item.quote, 'Quote coordinates must be exact');
            if (item.equals !== null) check(source[item.equals] === '=', 'Equal-sign coordinates must be exact');
        }
        check(details.getAttribute('CLASS') === null, 'Attribute names inside quoted values must not match');
        check(details.getAttribute('DATA-ID').value === 'A & B', 'Named lookup must match complete names case-insensitively');
        check(details.getAttribute('disabled').valueStart === null && details.getAttribute('empty').valueStart === details.getAttribute('empty').valueEnd, 'Boolean and empty quoted attributes must be distinguishable');
        check(element.editor.attributes({ target }).length === attributes.length && element.editor.getAttribute({ target, name: 'data-x' }).value === 'plain', 'Editor helpers must expose the same parser');
        check(details.getAttributes().length === attributes.length && !Object.keys(details).includes('attributes'), 'Helpers must stay off serialized detail fields');
        await details.setAttribute('title', details.getAttribute('title').value);
        check(element.value === source, 'An unchanged logical value must preserve its original entity spelling');
        return true;
    }), true);
}));

test('attribute setters submit precise source edits and preserve formatting and shared details', () => fixture(async page => {
    assert.equal(await page.evaluate(async () => {
        const api = await import('/index.js');
        const element = document.createElement('div');
        element.setAttribute('editor', 'dom');
        element.setAttribute('crdt', 'false');
        element.value = `<p class = 'old' data-x=plain disabled></p>`;
        document.body.append(element);
        await api.initElement(element);
        const target = element.firstChild, details = target.editorDetails;
        const update = element.editor.updateText, operations = [];
        element.editor.updateText = operation => { operations.push(operation); return update(operation); };
        const before = details.getAttribute('class');
        await details.setAttribute('class', "it's & new");
        check(operations[0].start === before.valueStart && operations[0].length === before.valueEnd - before.valueStart && operations[0].value === 'it&#39;s &amp; new', 'Only the existing value characters should be replaced');
        check(element.value.includes("class = 'it&#39;s &amp; new'") && target.getAttribute('class') === "it's & new", 'Whitespace and quote style must survive');
        await details.setAttribute('data-x', '');
        check(element.value.includes('data-x=""') && details.getAttribute('data-x').value === '', 'An empty unquoted value must become quoted');
        await details.setAttribute('disabled', '');
        check(element.value.includes('disabled=""'), 'A boolean attribute must accept an explicit empty value');
        await details.setAttribute('title', 'added');
        check(target.getAttribute('title') === 'added', 'A missing attribute must be inserted into the opening tag');
        await details.setAttribute('data-x', 'path/');
        check(target.getAttribute('data-x') === 'path/', 'Slash-ending values must not damage the opening tag');
        const titleEnd = details.getAttribute('title').valueEnd;
        await details.setAttribute('title', 'added!');
        check(operations.at(-1).start === titleEnd && operations.at(-1).length === 0 && operations.at(-1).value === '!', 'Appending to a value must submit a character insertion');
        const count = operations.length;
        await details.setAttribute('title', 'added!');
        await details.removeAttribute('missing');
        check(operations.length === count, 'No-op edits must not create source operations');
        await element.editor.removeAttribute({ target, name: 'title' });
        check(!target.hasAttribute('title') && details.getAttribute('title') === null, 'Removal must update both source and live DOM');
        check(target.editorDetails === details && element.editor.editorDetails.includes(details), 'Attribute edits must preserve the shared details object and its methods');
        paired(element.editor.dom.body);
        return true;
    }), true);
}));

test('attribute helpers refresh shifted positions, remove duplicates, and reject stale or foreign targets', () => fixture(async page => {
    assert.equal(await page.evaluate(async () => {
        const api = await import('/index.js');
        const element = document.createElement('div');
        element.setAttribute('editor', 'dom');
        element.setAttribute('crdt', 'false');
        element.value = `<p class=a data-middle='keep' CLASS=b></p><p title="second"></p>`;
        document.body.append(element);
        await api.initElement(element);
        const first = element.firstChild.editorDetails, second = element.lastChild.editorDetails;
        const previousStart = second.getAttribute('title').nameStart;
        await first.removeAttribute('class');
        check(!element.firstChild.hasAttribute('class') && first.attributes.map(item => item.name).join(',') === 'data-middle', 'Removing a duplicated name must remove every occurrence');
        check(element.value.includes("data-middle='keep'") && second.getAttribute('title').nameStart < previousStart, 'Unrelated formatting and current shifted coordinates must survive');
        await second.setAttribute('title', 'updated');
        check(element.lastChild.getAttribute('title') === 'updated', 'A retained details object must edit at its new source position');
        const start = second.start, length = second.end - second.start;
        await element.editor.updateText({ start, length, value: '<p title="replacement"></p>' });
        let rejected = false;
        try { second.setAttribute('title', 'wrong'); } catch (error) { rejected = error instanceof RangeError; }
        check(rejected && element.lastChild.getAttribute('title') === 'replacement', 'A removed record must not edit an identical tag at the same old position');
        const foreign = host('<p title="foreign"></p>', 'dom');
        rejected = false;
        try { element.editor.setAttribute({ target: foreign.firstChild, name: 'title', value: 'wrong' }); } catch (error) { rejected = error instanceof RangeError; }
        check(rejected, 'Editor helpers must reject targets owned by another editor');
        paired(element.editor.dom.body);
        return true;
    }), true);
}));

test('iframe attribute helpers send exact positions to the existing CRDT binding', () => fixture(async page => {
    assert.equal(await page.evaluate(async () => {
        const api = await import('/index.js');
        window.initialText = '<html><body><p class="old">text</p></body></html>';
        window.crdtOperations = [];
        const frame = document.createElement('iframe');
        for (const [name, value] of Object.entries({ editor: 'dom', realtime: 'true', array: 'test', object: 'document', key: 'html' })) frame.setAttribute(name, value);
        document.body.append(frame);
        await api.initElement(frame);
        const target = frame.contentDocument.querySelector('p'), details = target.editorDetails;
        const attribute = details.getAttribute('class'), reads = window.textReads;
        await details.setAttribute('class', 'new');
        const operation = crdtOperations[0];
        check(operation.start === attribute.valueStart && operation.length === 3 && operation.value === 'new', 'The CRDT must receive the value-only source range');
        check(operation.array === 'test' && operation.object === 'document' && operation.key === 'html' && window.textReads === reads, 'The existing iframe CRDT binding must be reused');
        check(details.editorElement === frame, 'The selected element must resolve its owner through its shared record');
        return true;
    }), true);
}));


test('attribute helpers preserve self-closing tags and distinguish empty values from removal', () => fixture(async page => {
    assert.equal(await page.evaluate(async () => {
        const api = await import('/index.js');
        const element = document.createElement('div');
        element.setAttribute('editor', 'dom');
        element.setAttribute('crdt', 'false');
        element.value = '<input value=x/>';
        document.body.append(element);
        await api.initElement(element);
        const target = element.firstChild, details = target.editorDetails;
        await details.setAttribute('value', 'path/');
        check(element.value === '<input value="path/"/>' && element.firstChild === target, 'A slash-ending value must not consume the self-closing marker');
        await details.setAttribute('data-empty', '');
        check(target.hasAttribute('data-empty') && details.getAttribute('data-empty').value === '', 'An empty value must keep the attribute present');
        await details.removeAttribute('data-empty');
        check(!target.hasAttribute('data-empty') && element.value.endsWith('/>'), 'Removal must preserve the self-closing marker');
        await details.setAttribute('title', 'a\r\nb & c');
        const title = details.getAttribute('title');
        check(title.value === target.getAttribute('title') && title.rawValue.includes('\r\n'), 'Logical values must normalize line endings while ranges preserve raw source');
        paired(element.editor.dom.body);
        return true;
    }), true);
}));

test('Markdown plans broken inline ranges through shared records without walking existing DOM', () => fixture(async page => {
    assert.equal(await page.evaluate(async () => {
        const { mode } = await import('/editors/markdown.js');
        const { getParsedDetails, planIndexedDOM, applyDOMUpdatePlan } = await import('/editors/utilities/indexedDOM.js');
        const value = 'first **bold** tail\n\nfollowing';
        const element = host(value, 'markdown'), root = element.editor.dom;
        const first = element.firstChild, following = element.lastChild;
        const strong = first.querySelector('strong'), removed = strong.editorDetails;
        const index = element.editor.editorDetails, followingDetails = following.editorDetails;
        const caret = following.firstChild;
        element.contentEditable = 'true';
        element.focus();
        document.getSelection().setBaseAndExtent(caret, 3, caret, 3);
        const restores = [];
        const block = (node, name) => {
            const before = Object.getOwnPropertyDescriptor(node, name);
            Object.defineProperty(node, name, { configurable: true, get() { throw new Error('Old Markdown DOM traversal: ' + name); } });
            restores.push(() => before ? Object.defineProperty(node, name, before) : delete node[name]);
        };
        for (const item of index) {
            for (const name of ['children', 'childNodes', 'querySelector', 'querySelectorAll', 'contains']) block(item.detachDOM, name);
            for (const name of ['children', 'childNodes', 'querySelector', 'querySelectorAll']) block(item.liveDOM, name);
        }
        const change = { start: value.indexOf('** tail'), length: 1, value: '' };
        const string = value.slice(0, change.start) + value.slice(change.start + 1);
        try {
            const staging = mode.render(string, element, change, root);
            check(getParsedDetails(staging).length < index.length, 'A local inline edit must parse only its containing block');
            const plan = planIndexedDOM(root, staging, element, change);
            check(plan.removed.includes(removed) && plan.updates.some(item => item.values.kind === 'text' && item.values.literal), 'An incomplete inline range must produce removal and literal-text update records');
            check(strong.isConnected && strong.editorDetails === removed && index.includes(removed), 'Planning must leave the old DOM and records untouched');
            updateMarkdown(element, { previous: value, string, ...change });
            check(!strong.isConnected && !index.includes(removed), 'Commit must remove the broken formatting and its old record');
            check(element.lastChild === following && following.editorDetails === followingDetails && element.editor.editorDetails === index, 'The following block, details object, and array must survive');
            check(document.getSelection().anchorNode === caret && document.getSelection().anchorOffset === 3, 'Indexed updates must retain the caret without traversing either old tree');
            check(first.textContent === 'first **bold* tail', 'The remaining incomplete source must render as literal text');
            check(index.filter(item => item.kind === 'text').every(item => getSourceMap(item.detachDOM) === getSourceMap(item.liveDOM)), 'Text records must share absolute source maps on both trees');
        } finally { restores.reverse().forEach(restore => restore()); }
        const repaired = value;
        updateMarkdown(element, { previous: string, string: repaired });
        check(first.querySelector('strong') && element.lastChild === following, 'Repair must recreate formatting without replacing the following block');
        paired(root);
        return true;
    }), true);
}));

test('Markdown shared plans match fresh rendering across block changes and fence recovery', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        const values = [
            'plain **bold** tail\n\nnext', 'plain **bold* tail\n\nnext', 'plain **bold** tail\n\nnext',
            '# plain **bold** tail\n\nnext', 'Title\n-----\n\nnext',
            '> first **bold**\n> next\n\nend', '- first\n- second *em*\n\nend',
            '1. one\n2. two\n\nend', '```js\nconst x = 1;\n```\n\nend',
            '```js\nconst x = 1;\n``\n\nend', '```js\nconst x = 1;\n```\n\nend',
            'first\nsecond\n\nnext', 'first\n\n\nnext', 'first\n \n\nnext',
            'first\n\nnext', '\n\nstart', '', '\n', '---\n', 'a [link](https://example.com) and `code`\n\nend'
        ];
        const element = host(values[0], 'markdown');
        const index = element.editor.editorDetails;
        let previous = values[0];
        for (const string of values.slice(1)) {
            updateMarkdown(element, { previous, string });
            const fresh = createMarkdownDOM(string);
            check(element.innerHTML === fresh.innerHTML, `Markdown plan differs from fresh render for ${JSON.stringify(string)}: ${element.innerHTML} versus ${fresh.innerHTML}`);
            check(element.editor.editorDetails === index && new Set(index).size === index.length, 'Markdown must retain one sorted details array without duplicate objects');
            for (const item of index) {
                check(item.liveDOM.editorDetails === item && getEditorDetails(item.detachDOM) === item && item.liveDOM.isConnected, 'Every indexed Markdown node must have current shared references');
                check(0 <= item.start && item.start <= item.contentStart && item.contentStart <= item.contentEnd && item.contentEnd <= item.end && item.end <= string.length, 'Markdown boundaries must stay valid');
                const map = getSourceMap(item.detachDOM);
                if (map) check(map.length === item.detachDOM.length && map.every(([from,to], i) => string.slice(from,to) === item.detachDOM.data[i]), 'Absolute Markdown text maps must identify their exact source characters');
            }
            paired(element.editor.dom);
            previous = string;
        }
        return true;
    }), true);
}));

test('Markdown randomized edits preserve rendered output and exact source mappings', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        const source = '# **Title**\n\nfirst [link](url) and *em*\ncontinued\n\n> quote\n> next\n\n- one\n- two\n\n```js\ncode\n```\n\ntail\n';
        const replacements = ['', '*', '**', '_', '`', '```', '\n', '\n\n', '# ', '> ', '- ', '~~~'];
        let seed = 1039;
        const random = size => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % size; };
        for (let i = 0; i < 150; i++) {
            const element = host(source, 'markdown');
            const start = random(source.length + 1), length = Math.min(random(8), source.length - start), value = replacements[random(replacements.length)];
            const string = source.slice(0,start) + value + source.slice(start+length);
            updateMarkdown(element, { previous: source, string, start, length, value });
            check(element.innerHTML === createMarkdownDOM(string).innerHTML, `Markdown boundary mismatch at ${start}:${length}:${JSON.stringify(value)}`);
            const index = element.editor.editorDetails;
            check(index.every((item, j) => !j || index[j-1].start <= item.start), 'Markdown index must stay sorted');
            for (const item of index) {
                check(item.liveDOM.editorDetails === item && item.liveDOM.isConnected, 'Random edits must not leave stale Markdown records');
                check(item.firstLine === string.slice(0,item.start).split('\n').length && item.lastLine === string.slice(0,item.end).split('\n').length, 'Random edits must keep line references current');
                const map = getSourceMap(item.detachDOM);
                if (map) check(map === getSourceMap(item.liveDOM) && map.length === item.detachDOM.length && map.every(([from,to], offset) => string.slice(from,to) === item.detachDOM.data[offset]), 'Random edits must preserve current absolute text mappings');
            }
            element.remove();
        }
        return true;
    }), true);
}));

test('Markdown iframe updates use the shared planner without changing the document container', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        const frame = document.createElement('iframe');
        document.body.append(frame);
        const doc = frame.contentDocument;
        doc.head.innerHTML = '<meta name="retained" content="yes">';
        doc.body.className = 'editor-container';
        const value = '> first\n> **second**\n\ntail';
        frame.value = value;
        frame.editor = {};
        frame.editor.dom = createMarkdownDOM(value, doc.body);
        const head = doc.head, body = doc.body, tail = body.lastChild, position = tail.editorDetails;
        doc.documentElement.contentEditable = 'true';
        frame.contentWindow.focus();
        const caret = tail.firstChild;
        doc.getSelection().setBaseAndExtent(caret, 2, caret, 2);
        const next = value.replace('first', 'longer first');
        updateMarkdown(frame, { previous: value, string: next });
        check(doc.head === head && doc.body === body && body.className === 'editor-container' && head.firstChild.getAttribute('content') === 'yes', 'Markdown must preserve the iframe document and container attributes');
        check(body.lastChild === tail && tail.editorDetails === position && position.start === next.indexOf('tail'), 'Following iframe records must shift without replacement');
        check(doc.getSelection().anchorNode === caret && doc.getSelection().anchorOffset === 2, 'Iframe caret must follow the indexed source update');
        paired(frame.editor.dom);
        return true;
    }), true);
}));

test('Markdown details retain line and delimiter references as source positions move', () => fixture(async page => {
    assert.equal(await page.evaluate(() => {
        let value = '# **title**\n\n> quote\n> next\n\n- one\n- two\n\n```js\ncode\n```\n';
        const element = host(value, 'markdown');
        const heading = element.firstChild.editorDetails;
        const strong = element.firstChild.firstChild.editorDetails;
        const quote = element.children[1].editorDetails;
        const list = element.children[2].editorDetails;
        const fence = element.lastChild.editorDetails;
        const markerSource = (item, marker) => marker && value.slice(item.start + marker.start, item.start + marker.end);
        const verify = () => {
            for (const item of element.editor.editorDetails) {
                check(item.firstLine === value.slice(0,item.start).split('\n').length && item.lastLine === value.slice(0,item.end).split('\n').length, 'Line numbers must describe each record current source coordinates');
                if (item.block) {
                    for (const line of item.lines) {
                        const start = item.start + line.start;
                        check(line.number === value.slice(0,start).split('\n').length && !value.slice(start,item.start+line.end).includes('\n'), 'Stored line ranges must remain current without DOM lookup');
                    }
                }
            }
            check(heading.syntax.rule === 'heading1' && markerSource(heading, heading.syntax.opening) === '#' && heading.syntax.closing === null, 'Headings must carry their prefix marker');
            check(strong.definition.name === 'strong' && markerSource(strong,strong.syntax.opening) === '**' && markerSource(strong,strong.syntax.closing) === '**', 'Inline records must carry their matching rule and delimiters');
            check(quote.lines.every(line => markerSource(quote,line.marker) === '>'), 'Quote records must retain per-line markers');
            check(list.lines.every(line => markerSource(list,line.marker) === '-'), 'List records must retain per-line markers');
            check(fence.syntax.rule === 'fence' && fence.syntax.complete && markerSource(fence,fence.syntax.opening) === '```' && markerSource(fence,fence.syntax.closing) === '```', 'Fences must reference both delimiter ranges');
        };
        verify();
        for (const source of ['---', '* * *']) {
            const rule = host(source, 'markdown').firstChild.editorDetails;
            check(rule.definition.name === 'rule' && rule.syntax.rule === 'rule' && source.slice(rule.syntax.opening.start,rule.syntax.opening.end) === source,
                'Ambiguous line patterns must retain the actual rule used for rendering');
        }
        const syntax = fence.syntax, lines = fence.lines;
        let previous = value;
        value = value.replace('title','longer title');
        updateMarkdown(element,{previous,string:value});
        check(element.lastChild.editorDetails === fence && fence.syntax === syntax && fence.lines === lines, 'An unaffected record must keep its relative marker and line references when its start shifts');
        verify();
        previous = value;
        value = '\n' + value;
        updateMarkdown(element,{previous,string:value,start:0,length:0,value:'\n'});
        check(element.lastChild.editorDetails === fence, 'A line insertion must retain the unaffected rendered block');
        verify();
        return true;
    }), true);
}));

test('code edits plan from shared records and reuse source nodes without walking existing trees', () => fixture(async page => {
    assert.equal(await page.evaluate(async () => {
        const { mode } = await import('/editors/code.js');
        const { getParsedDetails, planIndexedDOM } = await import('/editors/utilities/indexedDOM.js');
        const value = 'const item = 123;\nconst tail = "end";';
        const element = host(value, 'code', 'javascript'), root = element.editor.dom;
        const edited = element.querySelector('.code-number'), editedDetails = edited.editorDetails;
        const tail = element.querySelector('.code-string'), tailDetails = tail.editorDetails, caret = tail.firstChild;
        const index = element.editor.editorDetails, originalMap = getSourceMap(caret), originalStart = tailDetails.start;
        element.contentEditable = 'true'; element.focus();
        document.getSelection().setBaseAndExtent(caret, 2, caret, 2);
        const restores = [];
        const block = (node, name) => {
            const descriptor = Object.getOwnPropertyDescriptor(node,name);
            Object.defineProperty(node,name,{configurable:true,get(){throw new Error('Existing code DOM traversal: '+name)}});
            restores.push(()=>descriptor?Object.defineProperty(node,name,descriptor):delete node[name]);
        };
        for(const item of index) {
            for(const name of ['children','childNodes','querySelector','querySelectorAll','contains']) block(item.detachDOM,name);
            for(const name of ['children','childNodes','querySelector','querySelectorAll']) block(item.liveDOM,name);
        }
        const start=value.indexOf('123')+1, string=value.slice(0,start)+'4'+value.slice(start);
        const change={start,length:0,value:'4'};
        const create=document.createElement, createText=document.createTextNode;
        let created=0;
        document.createElement=function(...args){created++;return create.apply(this,args)};
        document.createTextNode=function(...args){created++;return createText.apply(this,args)};
        try {
            const staging=mode.render(string,element,change,root);
            const plan=planIndexedDOM(root,staging,element,change);
            check(!plan.added.length && !plan.removed.length && plan.retained.includes(editedDetails), 'Changing a number must retain its span and text records');
            check(getParsedDetails(staging).some(item=>item!==tailDetails && item.detachDOM===tailDetails.detachDOM), 'Unchanged source nodes must be represented by independent record snapshots');
            check(tailDetails.start===originalStart && getSourceMap(caret)===originalMap, 'Parsing and planning must leave positions and maps untouched');
            updateCode(element,{previous:value,string,...change});
            check(edited.editorDetails===editedDetails && edited.textContent==='1423' && edited.isConnected, 'The existing edited token must update in place');
            check(tail.editorDetails===tailDetails && tailDetails.start===originalStart+1 && element.editor.editorDetails===index, 'Following token positions and array identity must remain shared');
            check(document.getSelection().anchorNode===caret && document.getSelection().anchorOffset===2, 'Caret restoration must use indexed source maps');
            check(created===6, `Only two candidate roots and the changed token/text pairs should be constructed; got ${created}`);
        } finally {
            document.createElement=create; document.createTextNode=createText;
            restores.reverse().forEach(restore=>restore());
        }
        paired(root);
        return true;
    }),true);
}));

test('all code languages preserve fresh-render output, ranges and mappings through randomized edits', () => fixture(async page => {
    assert.equal(await page.evaluate(async () => {
        const code=await import('/editors/code.js');
        const cases={
            javascript:'const count = "text"; /* comment */\nlet other = 12;\n',
            typescript:'interface Item { value: number; }\nconst item: Item = { value: 12 };\n',
            css:'.a { color: #aabbcc; margin: 12px; }\n/* comment */\n',
            json:'{"name":"value", "n":12, "flag":true}\n',
            python:'def greet(x):\n    return "value" # comment\n',
            sql:'SELECT name FROM users WHERE id = 12; -- comment\n',
            bash:'#!/bin/sh\nname="value"\necho "$name" # comment\n',
            yaml:'name: value\ncount: 12\nitems:\n  - one\n',
            c:'#include <stdio.h>\nint main() { return 12; }\n',
            go:'package main\nfunc main() { value := "text" }\n',
            java:'class Item { int count = 12; String value = "text"; }\n',
            php:'<?php $value = "text"; echo $value; ?>\n',
            html:'<!doctype html><p class="a">x &amp; y</p><script>const x = "<p>";</script>\n'
        };
        await Promise.all(Object.keys(cases).map(language=>code.loadLanguage(language)));
        const replacements=['','"',"'",'`','/*','*/','\n','\\',':','<','>','123',' '];
        let seed=2903;
        const random=size=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%size};
        for(const [language,source] of Object.entries(cases)) {
            for(let i=0;i<35;i++) {
                const element=host(source,'code',language), index=element.editor.editorDetails;
                const start=random(source.length+1), length=Math.min(random(6),source.length-start), value=replacements[random(replacements.length)];
                const string=source.slice(0,start)+value+source.slice(start+length);
                updateCode(element,{previous:source,string,start,length,value});
                const fresh=createCodeDOM(string,undefined,language);
                check(element.textContent===string && element.innerHTML===fresh.innerHTML, `Code output mismatch: ${language} at ${start}:${length}:${JSON.stringify(value)}`);
                check(element.editor.editorDetails===index && new Set(index).size===index.length, 'Code must retain one unique details array');
                for(let j=0;j<index.length;j++) {
                    const item=index[j];
                    check(!j || index[j-1].start<=item.start,'Code records must remain ordered');
                    check(item.liveDOM.editorDetails===item && getEditorDetails(item.detachDOM)===item && item.liveDOM.isConnected,'Code records must retain current shared references');
                    check(0<=item.start && item.start<=item.contentStart && item.contentStart<=item.contentEnd && item.contentEnd<=item.end && item.end<=string.length,'Code boundaries must remain valid');
                    check(item.firstLine===string.slice(0,item.start).split('\n').length && item.lastLine===string.slice(0,item.end).split('\n').length,'Code line references must follow source edits');
                    const map=getSourceMap(item.detachDOM);
                    if(map) check(map===getSourceMap(item.liveDOM) && map.length===item.detachDOM.length && map.every(([from,to],offset)=>string.slice(from,to)===item.detachDOM.data[offset]),'Code text mappings must address exact current source characters');
                    if(item.kind==='token') check(item.definition && item.syntax.rule===item.token,'Tokens must reference the actual rule or tokenizer that rendered them');
                }
                paired(element.editor.dom);
                element.remove();
            }
        }
        for(const language of ['text','unknown','constructor','__proto__','toString']) {
            await code.loadLanguage(language);
            const element=host('plain <source> & value\n','code',language);
            check(element.textContent==='plain <source> & value\n' && !element.querySelector('.code-token'),'Unknown languages must safely render plain source');
            updateCode(element,{previous:element.value,string:'changed <source> & value\n'});
            check(element.textContent==='changed <source> & value\n','Plain-language edits must use the shared record path');
            element.remove();
        }
        return true;
    }),true);
}));

test('code rule changes outside the edited characters update retained token classifications', () => fixture(async page => {
    assert.equal(await page.evaluate(async () => {
        const code=await import('/editors/code.js');
        await Promise.all([code.loadLanguage('json'),code.loadLanguage('css')]);
        for(const [language,source,next] of [
            ['json','{"name"  12}','{"name": 12}'],
            ['css','.a { color red; }','.a { color: red; }'],
            ['javascript','const value = 12;\nconst tail = 5;','/* const value = 12;\nconst tail = 5;']
        ]) {
            const element=host(source,'code',language);
            updateCode(element,{previous:source,string:next});
            check(element.innerHTML===createCodeDOM(next,undefined,language).innerHTML,'Lookahead and multiline contexts must reclassify neighboring tokens');
            updateCode(element,{previous:next,string:source});
            check(element.innerHTML===createCodeDOM(source,undefined,language).innerHTML,'Repair must restore the correct token boundaries');
            paired(element.editor.dom);
        }
        return true;
    }),true);
}));
