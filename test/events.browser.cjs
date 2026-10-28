const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startBrowser } = require('./helpers/browser.cjs');
let fixture;
before(async () => { fixture = await startBrowser(); });
after(async () => { await fixture?.close(); });

async function withInput(run, source = 'abc') {
    return fixture.run(async page => {
        await page.evaluate(async source => {
            const { bindEditorInput, createEditorEvents } = await import('/events.js');
            window.input = document.createElement('textarea');
            input.value = source;
            document.body.append(input);
            window.updates = [];
            window.selections = [];
            window.errors = [];
            input.addEventListener('editor-error', event => errors.push(event.detail.error.message));
            window.attach = options => bindEditorInput(input, {
                onUpdate: change => updates.push(change),
                onSelection: selection => selections.push(selection),
                ...options
            });
            window.binding = attach();
            window.createEditorEvents = createEditorEvents;
            window.changes = () => updates.map(({ start, length, value, string }) => ({ start, length, value, string }));
            input.focus();
        }, source);
        await run(page);
    });
}

test('native replacement and deletion report positional source operations', () => withInput(async page => {
    await page.evaluate(() => input.setSelectionRange(1, 2));
    await page.keyboard.type('X');
    await page.keyboard.press('Delete');
    assert.deepEqual(await page.evaluate(() => changes()), [
        { start: 1, length: 1, value: 'X', string: 'aXc' },
        { start: 2, length: 1, value: '', string: 'aX' }
    ]);
}));

test('composition emits one edit at the original source selection', () => withInput(async page => {
    await page.evaluate(() => {
        input.setSelectionRange(1, 1);
        input.dispatchEvent(new CompositionEvent('compositionstart'));
        input.value = 'aaaaa';
        input.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: 'a' }));
    });
    assert.equal(await page.evaluate(() => updates.length), 0);
    await page.evaluate(() => input.dispatchEvent(new CompositionEvent('compositionend', { data: 'a' })));
    await page.waitForFunction(() => updates.length === 1);
    assert.deepEqual(await page.evaluate(() => changes()), [
        { start: 1, length: 0, value: 'a', string: 'aaaaa' }
    ]);
}, 'aaaa'));

test('repeated native deletion follows the caret', () => withInput(async page => {
    await page.evaluate(() => input.setSelectionRange(2, 2));
    await page.keyboard.press('Backspace');
    assert.deepEqual(await page.evaluate(() => changes()), [
        { start: 1, length: 1, value: '', string: 'aaaa' }
    ]);
}, 'aaaaa'));

test('setValue refreshes the comparison baseline without emitting a local edit', () => withInput(async page => {
    await page.evaluate(() => {
        input.value = 'remote';
        binding.setValue('remote');
        input.dispatchEvent(new Event('input'));
        input.setSelectionRange(6, 6);
    });
    assert.equal(await page.evaluate(() => updates.length), 0);
    await page.keyboard.type('!');
    assert.deepEqual(await page.evaluate(() => changes()), [
        { start: 6, length: 0, value: '!', string: 'remote!' }
    ]);
}));

test('disconnect removes input, composition, and selection callbacks', () => withInput(async page => {
    await page.evaluate(() => {
        binding.disconnect();
        input.value = 'changed';
        input.dispatchEvent(new Event('input'));
        input.dispatchEvent(new Event('select'));
        input.dispatchEvent(new CompositionEvent('compositionstart'));
        input.dispatchEvent(new CompositionEvent('compositionend', { data: '!' }));
    });
    assert.deepEqual(await page.evaluate(() => [updates.length, selections.length]), [0, 0]);
}));

test('sync and async submission errors emit editor-error', () => withInput(async page => {
    for (const asynchronous of [false, true]) {
        await page.evaluate(asynchronous => {
            binding.disconnect();
            input.value = 'abc';
            binding = attach({ onUpdate() {
                if (asynchronous) return Promise.reject(new Error('async failure'));
                throw new Error('sync failure');
            } });
            input.value = 'abcd';
            input.dispatchEvent(new Event('input'));
        }, asynchronous);
    }
    await page.waitForFunction(() => errors.length === 2);
    assert.deepEqual(await page.evaluate(() => errors), ['sync failure', 'async failure']);
}));

test('beforeinput and keyboard hooks receive the source selection', () => withInput(async page => {
    assert.deepEqual(await page.evaluate(() => {
        binding.disconnect();
        const hooks = [];
        binding = attach({
            beforeInput: (event, selection) => hooks.push([event.type, selection.start, selection.end]),
            keyDown: (event, selection) => hooks.push([event.type, selection.start, selection.end])
        });
        input.setSelectionRange(1, 2);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
        input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'a' }));
        return hooks;
    }), [['keydown', 1, 2], ['beforeinput', 1, 2]]);
}));

test('the event hub supports unsubscribe and selective clearing', () => withInput(async page => {
    assert.deepEqual(await page.evaluate(() => {
        const events = createEditorEvents(), calls = [];
        const off = events.on('update', data => calls.push(data));
        events.on('other', data => calls.push(data));
        events.emit('update', 'first');
        off();
        events.emit('update', 'ignored');
        events.clear('update');
        events.emit('other', 'second');
        events.clear();
        events.emit('other', 'ignored');
        return calls;
    }), ['first', 'second']);
}));
