const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startBrowser } = require('./helpers/browser.cjs');
let fixture;
before(async () => { fixture = await startBrowser({ bundle: true }); });
after(async () => { await fixture?.close(); });

async function withDOM(run, source = '<main><p class="first" title="A" style="color: red">alpha</p><p class="second">beta</p></main>') {
    return fixture.run(async (page, requests) => {
        await page.evaluate(source => {
            window.host = document.createElement('div');
            host.id = 'host';
            host.setAttribute('editor', 'dom');
            host.setAttribute('crdt', 'false');
            host.setAttribute('value', source);
            document.body.append(host);
            window.errors = [];
            document.addEventListener('editor-error', event => errors.push(event.detail.error.message));
        }, source);
        await page.waitForFunction(() => host.editor?.initialized);
        await run(page, requests);
        assert.deepEqual(await page.evaluate(() => errors), []);
    });
}

test('the browser entry defers runtime and parsers until an editor appears', () => fixture.run(async (page, requests) => {
    assert.equal(requests.some(request => /editor-(runtime|parser)/.test(request)), false);
    await page.evaluate(() => {
        const textarea = document.createElement('textarea');
        textarea.setAttribute('editor', 'text');
        textarea.setAttribute('crdt', 'false');
        textarea.value = 'plain';
        document.body.append(textarea);
    });
    await page.waitForFunction(() => document.querySelector('textarea').editor?.initialized);
    assert.equal(requests.some(request => request.includes('editor-runtime')), true);
    assert.equal(requests.some(request => request.includes('editor-parser-dom')), false);
}));

test('query controls load their own module without loading the host runtime', () => fixture.run(async (page, requests) => {
    await page.evaluate(() => {
        window.apiTarget = document.createElement('div');
        apiTarget.id = 'api-target';
        apiTarget.editor = { external: true };
        window.apiControl = document.createElement('input');
        apiControl.setAttribute('editor-query', '#api-target');
        document.body.append(apiTarget, apiControl);
    });
    await page.waitForFunction(() => apiControl.editor === apiTarget.editor);
    assert.equal(requests.some(request => request.includes('editor-input-binding')), true);
    assert.equal(requests.some(request => request.includes('editor-runtime')), false);
}));

test('DOM nodes share editor objects whose offsets derive from source segment lengths', () => withDOM(async page => {
    assert.deepEqual(await page.evaluate(() => {
        const nodes = host.editor.nodes;
        let position = 0;
        const valid = nodes.every(node => {
            const matches = node.getStart() === position && node.length === node.value.length &&
                !Object.hasOwn(node, 'start') && !Object.hasOwn(node, 'end') && node.element === host &&
                (node.sourceOnly || node.liveNode?.editor === node);
            position += node.length;
            return matches;
        });
        const paragraph = host.querySelector('p');
        const attribute = paragraph.getAttributeNode('class');
        return [valid, position === host.editor.getSource().length,
            paragraph.editor.getAttribute('class') === attribute.editor,
            attribute.editor.parentNode === paragraph.editor];
    }), [true, true, true, true]);
}));

test('attribute APIs retain native elements and update the source through the host', () => withDOM(async page => {
    assert.deepEqual(await page.evaluate(async () => {
        const paragraph = host.querySelector('p'), editor = paragraph.editor;
        const classAttribute = paragraph.getAttributeNode('class');
        await editor.setAttribute('class', 'changed');
        await editor.setAttribute('data-id', '7');
        await editor.removeAttribute('title');
        return [host.querySelector('p') === paragraph, paragraph.editor === editor,
            paragraph.getAttributeNode('class') === classAttribute,
            paragraph.className, paragraph.getAttribute('data-id'), paragraph.hasAttribute('title'),
            host.editor.getSource().includes('class="changed"')];
    }), [true, true, true, 'changed', '7', false, true]);
}));

test('query receivers resolve explicit elements and rebind when their query changes', () => withDOM(async page => {
    await page.evaluate(async () => {
        window.input = document.createElement('input');
        input.setAttribute('editor-query', '#host .first');
        input.setAttribute('editor-attribute', 'title');
        document.body.append(input);
        await CoCreate.editor.initEditorQuery(input);
    });
    await page.waitForFunction(() => input.editor?.name === 'title' && input.value === 'A');
    await page.evaluate(() => {
        input.setAttribute('editor-attribute', 'class');
        input.setAttribute('editor-query', '#host .second');
    });
    await page.waitForFunction(() => input.editor === host.querySelector('.second').getAttributeNode('class').editor);
    assert.equal(await page.evaluate(() => input.value), 'second');
}));

test('attribute projections assign original editor objects and pass them to renderValue', () => withDOM(async page => {
    await page.evaluate(async () => {
        window.renderer = document.createElement('div');
        renderer.setAttribute('editor-query', '#host .first');
        renderer.setAttribute('editor-attributes', '');
        renderer.renderValue = values => { renderer.rendered = values; };
        document.body.append(renderer);
        await CoCreate.editor.initEditorQuery(renderer);
    });
    await page.waitForFunction(() => Array.isArray(renderer.editor));
    assert.deepEqual(await page.evaluate(() => {
        const expected = host.querySelector('.first').editor.getAttributes();
        return [renderer.editor === renderer.rendered,
            renderer.editor.length === expected.length,
            renderer.editor.every((item, index) => item === expected[index])];
    }), [true, true, true]);
}));

test('editor-nodes projects the host collection and stays on that collection through clicks', () => withDOM(async page => {
    await page.evaluate(async () => {
        window.renderer = document.createElement('div');
        renderer.setAttribute('editor-query', '#host');
        renderer.setAttribute('editor-nodes', '');
        renderer.renderValue = values => { renderer.rendered = values; };
        document.body.append(renderer);
        await CoCreate.editor.initEditorQuery(renderer);
    });
    await page.waitForFunction(() => renderer.editor === host.editor.nodes);
    await page.locator('#host .first').click();
    assert.equal(await page.evaluate(() => renderer.editor === host.editor.nodes && renderer.rendered === renderer.editor), true);
}));

test('host click changes the bound attribute while an explicit element query remains fixed', () => withDOM(async page => {
    await page.evaluate(async () => {
        for (const [id, query] of [['following', '#host'], ['fixed', '#host .first']]) {
            const input = document.createElement('input');
            input.id = id;
            input.setAttribute('editor-query', query);
            input.setAttribute('editor-attribute', 'class');
            document.body.append(input);
            await CoCreate.editor.initEditorQuery(input);
        }
    });
    await page.waitForFunction(() => document.querySelector('#fixed').editor?.name === 'class');
    await page.locator('#host .second').click();
    await page.waitForFunction(() => document.querySelector('#following').value === 'second');
    assert.deepEqual(await page.evaluate(() => [document.querySelector('#following').value, document.querySelector('#fixed').value]), ['second', 'first']);
}));

test('rendered inputs initialize their assigned attribute editor without editor-query', () => withDOM(async page => {
    await page.evaluate(async () => {
        window.input = document.createElement('input');
        input.editor = host.querySelector('.first').editor.getAttribute('title');
        input.setAttribute('editor-attribute', 'title');
        document.body.append(input);
        await CoCreate.editor.initEditorQuery(input);
    });
    assert.equal(await page.evaluate(() => input.value), 'A', 'the assigned attribute must seed the input value');
    await page.locator('body > input').fill('updated');
    await page.waitForFunction(() => host.querySelector('.first').title === 'updated');
    assert.equal(await page.evaluate(() => host.editor.getSource().includes('title="updated"')), true);
}));

test('removed query inputs stop submitting edits to the source', () => withDOM(async page => {
    await page.evaluate(async () => {
        window.input = document.createElement('input');
        input.setAttribute('editor-query', '#host .first');
        input.setAttribute('editor-attribute', 'title');
        document.body.append(input);
        await CoCreate.editor.initEditorQuery(input);
    });
    await page.waitForFunction(() => input.value === 'A');
    await page.evaluate(() => input.remove());
    await page.waitForFunction(() => input.editor === null);
    await page.evaluate(() => {
        input.value = 'detached';
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    assert.equal(await page.evaluate(() => host.querySelector('.first').title), 'A');
}));

test('iframe host clicks use the forwarded target without changing query resolution', () => fixture.run(async page => {
    await page.evaluate(async () => {
        window.frame = document.createElement('iframe');
        frame.id = 'frame';
        document.body.append(frame);
        frame.setAttribute('editor', 'dom');
        frame.setAttribute('crdt', 'false');
        frame.setAttribute('value', '<p class="inside">frame</p>');
        await CoCreate.editor.initElement(frame);
        window.input = document.createElement('input');
        input.setAttribute('editor-query', '#frame');
        input.setAttribute('editor-attribute', 'class');
        document.body.append(input);
        await CoCreate.editor.initEditorQuery(input);
        frame.dispatchEvent(new CustomEvent('click', {
            detail: { target: frame.contentDocument.querySelector('p') }, bubbles: true
        }));
    });
    await page.waitForFunction(() => input.value === 'inside');
    assert.equal(await page.evaluate(() => input.editor === frame.contentDocument.querySelector('p').getAttributeNode('class').editor), true);
}));


test('a query added after host-only initialization activates its binding automatically', () => withDOM(async page => {
    await page.evaluate(() => {
        window.lateInput = document.createElement('input');
        lateInput.setAttribute('editor-query', '#host .first');
        lateInput.setAttribute('editor-attribute', 'title');
        document.body.append(lateInput);
    });
    await page.waitForFunction(() => lateInput.editor?.name === 'title' && lateInput.value === 'A');
}));

test('the binding module scans existing controls when their markup causes it to load', () => fixture.run(async page => {
    await page.waitForFunction(() => document.querySelector('#initial-control').value === 'initial');
    assert.equal(await page.evaluate(() => {
        const input = document.querySelector('#initial-control');
        return input.editor === document.querySelector('#initial-host p').getAttributeNode('title').editor;
    }), true);
}, { markup: `<!doctype html><body>
    <div id="initial-host" editor="dom" crdt="false">&lt;p title="initial"&gt;text&lt;/p&gt;</div>
    <input id="initial-control" editor-query="#initial-host p" editor-attribute="title">
</body>` }));

test('after its initial scan the binding module observes controls added later', () => withDOM(async page => {
    await page.evaluate(() => {
        window.firstInput = document.createElement('input');
        firstInput.setAttribute('editor-query', '#host .first');
        firstInput.setAttribute('editor-attribute', 'title');
        document.body.append(firstInput);
    });
    await page.waitForFunction(() => firstInput.value === 'A');
    await page.evaluate(() => {
        window.secondInput = document.createElement('input');
        secondInput.setAttribute('editor-query', '#host .second');
        secondInput.setAttribute('editor-attribute', 'class');
        document.body.append(secondInput);
    });
    await page.waitForFunction(() => secondInput.value === 'second');
}));

test('a rendered attribute control can trigger the binding module without editor-query', () => withDOM(async page => {
    await page.evaluate(() => {
        window.directInput = document.createElement('input');
        directInput.editor = host.querySelector('.first').editor.getAttribute('title');
        directInput.setAttribute('editor-attribute', 'title');
        document.body.append(directInput);
    });
    await page.waitForFunction(() => directInput.value === 'A');
    await page.locator('body > input').fill('rendered');
    await page.waitForFunction(() => host.querySelector('.first').title === 'rendered');
}));

test('a rendered style property can trigger the binding module without editor-query', () => withDOM(async page => {
    await page.evaluate(() => {
        window.propertyInput = document.createElement('input');
        propertyInput.editor = host.querySelector('.first').editor.getAttribute('style');
        propertyInput.setAttribute('editor-property', 'color');
        document.body.append(propertyInput);
    });
    await page.waitForFunction(() => propertyInput.value === 'red');
    await page.locator('body > input').fill('blue');
    await page.waitForFunction(() => host.querySelector('.first').style.color === 'blue');
}));

test('adding editor-query to an existing input activates the binding module', () => withDOM(async page => {
    await page.evaluate(() => {
        window.markedInput = document.createElement('input');
        document.body.append(markedInput);
    });
    await page.evaluate(() => {
        markedInput.setAttribute('editor-attribute', 'title');
        markedInput.setAttribute('editor-query', '#host .first');
    });
    await page.waitForFunction(() => markedInput.value === 'A');
}));

test('explicit initialization delegates scoped host and control scans to their modules', () => fixture.run(async page => {
    assert.deepEqual(await page.evaluate(async () => {
        const root = document.createElement('section');
        const scopedHost = document.createElement('div');
        scopedHost.id = 'scoped-host';
        scopedHost.setAttribute('editor', 'dom');
        scopedHost.setAttribute('crdt', 'false');
        scopedHost.setAttribute('value', '<p title="scoped">text</p>');
        const input = document.createElement('input');
        input.setAttribute('editor-query', '#scoped-host p');
        input.setAttribute('editor-attribute', 'title');
        root.append(scopedHost, input);
        await CoCreate.editor.init(root);
        return [input.value, input.editor === scopedHost.querySelector('p').getAttributeNode('title').editor];
    }), ['scoped', true]);
}));

test('parser calls load individual languages on demand and reuse loaded modules', () => fixture.run(async (page, requests) => {
    const parsed = await page.evaluate(async () => {
        const records = await CoCreate.editor.parseCode('const answer = 42;', 'javascript');
        return records.map(record => record.value).join('');
    });
    assert.equal(parsed, 'const answer = 42;');
    const firstRequests = requests.filter(request => request.endsWith('.js')).length;
    await page.evaluate(() => CoCreate.editor.parseCode('let next = 1;', 'javascript'));
    assert.equal(requests.filter(request => request.endsWith('.js')).length, firstRequests);
    await page.evaluate(() => CoCreate.editor.parseCode('answer = 42', 'python'));
    assert.ok(requests.filter(request => request.endsWith('.js')).length > firstRequests);
    assert.equal(requests.some(request => request.includes('editor-runtime')), false);
}));

test('observed mode changes preserve source while moving from DOM details to native text', () => withDOM(async page => {
    const source = await page.evaluate(() => host.editor.getSource());
    await page.evaluate(() => host.setAttribute('editor', 'text'));
    await page.waitForFunction(() => host.editor.initialized && CoCreate.editor.getStoredEditorDetails(host) === undefined);
    assert.equal(await page.evaluate(() => host.textContent), source);
    assert.equal(await page.evaluate(() => host.editor.getSource()), source);
}));

test('remote source updates preserve following editor references and derive their new offsets', () => withDOM(async page => {
    assert.deepEqual(await page.evaluate(async () => {
        const first = host.querySelector('.first').editor;
        const second = host.querySelector('.second').editor;
        const before = second.getStart();
        const source = host.editor.getSource(), start = source.indexOf('alpha');
        const updated = new Promise(resolve => host.addEventListener('editor-details-change', resolve, { once: true }));
        window.dispatchEvent(new CustomEvent('cocreate-crdt-update', { detail: {
            elements: [host], start, length: 5, value: 'longer text',
            string: source.slice(0, start) + 'longer text' + source.slice(start + 5)
        } }));
        await updated;
        return [host.querySelector('.first').editor === first,
            host.querySelector('.second').editor === second,
            second.getStart() === before + 6,
            host.querySelector('.first').textContent];
    }), [true, true, true, 'longer text']);
}));
