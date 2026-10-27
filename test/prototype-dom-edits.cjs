const { test, before } = require('node:test');
const assert = require('node:assert/strict');
let parseDOM, planDOMEdit, applyEditorDetailsPlan, updateDOMEditorDetails;
before(async () => {
    ({ parseDOM } = await import('../src/prototype/editors/parsers/dom.js'));
    ({ planDOMEdit } = await import('../src/prototype/editors/utilities/planDOMEdit.js'));
    ({ applyEditorDetailsPlan } = await import('../src/prototype/editors/utilities/updateEditorDetails.js'));
    ({ updateDOMEditorDetails } = await import('../src/prototype/editors/dom.js'));
});
const sourceOf = details => details.map(detail => detail.value).join('');
const snapshot = details => details.map(detail => ({ kind: detail.kind, value: detail.value, length: detail.length,
    nodeType: detail.nodeType, tag: detail.tag, name: detail.name, sourceOnly: !!detail.sourceOnly,
    complete: detail.complete, selfClosing: detail.selfClosing,
    parent: detail.parentDetails ? details.indexOf(detail.parentDetails) : -1 }));
function assertMatchesFullParse(details, source) {
    assert.equal(sourceOf(details), source);
    assert.deepEqual(snapshot(details), snapshot(parseDOM(source)));
    let position = 0;
    for (const detail of details) {
        assert.equal(detail.getStart(), position);
        assert.equal(detail.length, detail.value.length);
        for (const key of ['start', 'end', 'contentStart', 'contentEnd']) assert.equal(Object.hasOwn(detail, key), false);
        position += detail.length;
    }
    assert.equal(position, source.length);
}
function apply(details, start, length, value, extra = {}) {
    const source = sourceOf(details);
    const next = source.slice(0, start) + value + source.slice(start + length);
    const result = updateDOMEditorDetails(details, { start, length, value, string: next }, extra);
    assertMatchesFullParse(details, next);
    return result;
}

test('insert: a text character edits one existing object and its cached length without calling the parser', () => {
    const details = parseDOM('<main><p>Hello world</p><i>tail</i></main>');
    const text = details.find(detail => detail.value === 'Hello world');
    const old = [...details];
    const start = text.getStart() + 5;
    let calls = 0;
    const plan = planDOMEdit(details, start, start, '!', { parse() { calls++; throw new Error('unexpected parse'); } });
    assert.equal(calls, 0);
    assert.equal(sourceOf(details), '<main><p>Hello world</p><i>tail</i></main>');
    assert.deepEqual(plan.affected, [text]);
    assert.equal(plan.edited[0].detail, text);
    assert.deepEqual(plan.added, []);
    assert.deepEqual(plan.removed, []);
    assert.equal(plan.reparse, null);
    let rendered = false;
    applyEditorDetailsPlan(details, plan, { render(editor, committed) {
        rendered = true;
        assert.equal(committed.editorDetails, details);
        assert.equal(text.value, 'Hello! world');
        assert.equal(text.length, 12);
    } });
    assert.ok(rendered);
    assert.deepEqual(details, old);
    assertMatchesFullParse(details, '<main><p>Hello! world</p><i>tail</i></main>');
});

test('delete: removing one text character retains the same object and updates only its cached length', () => {
    const details = parseDOM('<p>Hello world</p><i>tail</i>');
    const text = details.find(detail => detail.value === 'Hello world');
    const tail = details.find(detail => detail.value === 'tail');
    const result = apply(details, text.getStart() + 5, 1, '');
    assert.equal(text.value, 'Helloworld');
    assert.equal(text.length, 10);
    assert.equal(result.edited[0].detail, text);
    assert.equal(result.reparse, null);
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.removed, []);
    assert.ok(details.includes(tail));
});

test('selection delete: parse the surviving parent source and stage broken children as text', () => {
    const source = '<section><b>left</b> between <i>right</i></section><p>outside</p>';
    const details = parseDOM(source);
    const anchor = details[0];
    const outside = details.find(detail => detail.value === 'outside');
    const start = source.indexOf('eft');
    const end = source.indexOf('right') + 2;
    const result = apply(details, start, end - start, '');
    assert.equal(result.reparse.anchor, anchor);
    assert.ok(result.affected.length > 1);
    assert.ok(result.removed.length > 0);
    assert.ok(details.includes(anchor));
    assert.ok(details.includes(outside));
    assert.ok(details.some(detail => detail.kind === 'text' && detail.value === 'lght'));
});

test('an attribute edit reparses its enclosing element, including its wrapper, while staging all changes', () => {
    const source = '<main><p class="a">first</p><p class="b">second</p><p>tail</p></main>';
    const details = parseDOM(source);
    const before = snapshot(details);
    const attribute = details.find(detail => detail.value === 'class="b"');
    const parent = attribute.parentDetails;
    const oldReferences = [...details];
    const calls = [];
    const start = attribute.getStart() + 'class="'.length;
    const plan = planDOMEdit(details, start, start + 1, 'new', { parse(value, editor) {
        calls.push(value);
        return parseDOM(value, editor);
    } });
    assert.deepEqual(calls, ['<p class="new">second</p>']);
    assert.equal(plan.reparse.containers[0], parent);
    assert.deepEqual(snapshot(details), before, 'planning must not mutate original values, lengths, or parents');
    assert.ok(plan.affected.includes(attribute));
    applyEditorDetailsPlan(details, plan, { render() {} });
    assert.equal(attribute.value, 'class="new"');
    assert.ok(oldReferences.every(detail => details.includes(detail)));
    assertMatchesFullParse(details, source.replace('class="b"', 'class="new"'));
});

test('completing broken markup adds parsed objects and retains old references until commit', () => {
    const details = parseDOM('<h3>A</h3>\n<div class="x"\n<p>B</p>');
    const broken = details.find(detail => detail.kind === 'text' && detail.value.includes('<div'));
    const liveReference = {};
    broken.liveDOM = liveReference;
    const original = sourceOf(details);
    const start = original.indexOf('"x"') + 3;
    const plan = planDOMEdit(details, start, start, '>');
    assert.equal(sourceOf(details), original);
    assert.equal(broken.liveDOM, liveReference);
    assert.ok(plan.removed.some(item => item.detail === broken) || plan.edited.some(item => item.detail === broken));
    assert.ok(plan.added.some(detail => detail.kind === 'element' && detail.tag === 'div'));
    applyEditorDetailsPlan(details, plan, { render() {} });
    assertMatchesFullParse(details, original.slice(0, start) + '>' + original.slice(start));
});

test('removing and repairing a tag character stages structural changes while retaining unrelated objects', () => {
    const source = '<section><b>keep</b><i>tail</i></section>';
    const details = parseDOM(source);
    const tail = details.find(detail => detail.value === 'tail');
    const start = source.indexOf('>keep');
    const broken = apply(details, start, 1, '');
    assert.ok(broken.removed.some(item => item.detail.kind === 'element' && item.detail.tag === 'b'));
    assert.ok([...broken.added, ...broken.edited.map(item => item.detail)]
        .some(detail => detail.kind === 'text' && detail.value.includes('<bkeep')));
    assert.ok(details.includes(tail));
    const repaired = apply(details, start, 0, '>');
    assert.ok(repaired.added.some(detail => detail.kind === 'element' && detail.tag === 'b'));
    assert.ok(details.includes(tail));
    assert.equal(sourceOf(details), source);
});

test('selection insert: a replacement across siblings finds their shared enclosing parent', () => {
    const source = '<main><section><b>left</b> between <i>right</i></section><p>outside</p></main>';
    const details = parseDOM(source);
    const outside = details.find(detail => detail.value === 'outside');
    const start = source.indexOf('eft');
    const end = source.indexOf('right') + 2;
    const result = apply(details, start, end - start, '<em>replacement</em>');
    assert.equal(result.reparse.containers[0].tag, 'section');
    assert.ok(result.affected.length > 1);
    assert.ok(result.added.some(detail => detail.tag === 'em'));
    assert.ok(details.includes(outside));
});

test('deleting a container opening and closing tag reparents the same child detail', () => {
    const source = '<main><b>keep</b><i>tail</i></main>';
    const details = parseDOM(source);
    const text = details.find(detail => detail.value === 'keep');
    const outer = details[0];
    apply(details, source.indexOf('<b>'), 3, '');
    assert.ok(details.includes(text));
    assert.equal(text.parentDetails, outer);
    apply(details, sourceOf(details).indexOf('</b>'), 4, '');
    assert.ok(details.includes(text));
    assert.equal(text.parentDetails, outer);
});

test('lexical changes that alter later ownership include the necessary enclosing source', () => {
    for (const [source, needle, length, value] of [
        ['<main><p>a</p><i>b</i></main><u>c</u>', '</p>', 4, ''],
        ['<main><p>a</p><i>b</i></main><u>c</u>', 'a', 1, '</main>'],
        ['<main><p title="x">a</p><i>b</i></main><u>c</u>', '"x"', 3, '"x'],
        ['<p>a</p><i>b</i><u>c</u>', '</p>', 4, ''],
        ['<p>a</p><i>b</i><u>c</u>', '<i>', 0, '<!--']
    ]) {
        const details = parseDOM(source);
        apply(details, source.indexOf(needle), length, value);
    }
});

test('void element insertions and deletions do not consume following sibling objects', () => {
    const details = parseDOM('<main><p>before</p><p>after</p></main>');
    const tail = details.find(detail => detail.value === 'after');
    const start = sourceOf(details).indexOf('<p>after');
    const inserted = '<input class="a"  disabled><img src="x" alt="a b">';
    const result = apply(details, start, 0, inserted);
    assert.deepEqual(result.added.filter(detail => detail.kind === 'element').map(detail => detail.tag), ['input', 'img']);
    assert.ok(details.includes(tail));
    assert.equal(tail.parentDetails.tag, 'p');
    apply(details, start, inserted.length, '');
    assert.ok(details.includes(tail));
});

test('empty documents, full deletion, and stale plans leave a consistent length-only array', () => {
    const editor = {};
    const details = parseDOM('', editor);
    apply(details, 0, 0, '<p>x</p>', { editor });
    const staged = planDOMEdit(details, 3, 3, '!');
    apply(details, 3, 0, '?', { editor });
    assert.throws(() => applyEditorDetailsPlan(details, staged, { render() { assert.fail(); } }), /changed after/);
    apply(details, 0, sourceOf(details).length, '', { editor });
    assert.deepEqual(details, []);
    apply(details, 0, 0, 'plain', { editor });
    assert.ok(details.every(detail => detail.editor === editor));
});

test('incorrect resulting source or parser failure does not mutate any existing record', () => {
    const details = parseDOM('<p class="a">hello</p>');
    const before = snapshot(details);
    assert.throws(() => updateDOMEditorDetails(details, { start: 3, length: 0, value: '!', string: 'wrong' }), /does not match/);
    assert.throws(() => planDOMEdit(details, 3, 3, '!', { parse() { throw new Error('parse failed'); } }), /parse failed/);
    assert.deepEqual(snapshot(details), before);
});

test('successive source edits produce the same objects and parent structure as a complete parse', () => {
    const documents = [
        '<main><p class="x">hello</p> tail <b>world</b></main>',
        '<script>if (a < b) x="hi";</script><p>tail</p>',
        '<textarea>a &amp; b</textarea><i>after</i>',
        '<div>A<!-- x -->B</div><input disabled><p>C</p>',
        '<main><p>x</p><p>y</p><p>z</p></main>'
    ];
    const pieces = ['<', '>', '/', ' ', '\n', 'x', '"', "'", '=', '<b>', '</b>', '<!--', '-->', '&amp;', '</main>', '<script>', '</script>'];
    for (let trial = 1; trial <= 50; trial++) {
        let seed = trial * 3901, source = documents[trial % documents.length];
        const details = parseDOM(source);
        const next = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        for (let edit = 0; edit < 150; edit++) {
            const start = next() % (source.length + 1);
            const length = Math.min(next() % 9, source.length - start);
            const value = pieces[next() % pieces.length];
            source = apply(details, start, length, value).source;
        }
    }
});

test('inserting markup into a text run retains the original text object for a surviving portion', () => {
    const details = parseDOM('<p>hello world</p>');
    const text = details.find(detail => detail.value === 'hello world');
    const result = apply(details, text.getStart() + 5, 0, '<b>');
    assert.ok(details.includes(text));
    assert.equal(text.value, 'hello');
    assert.ok(result.edited.some(item => item.detail === text));
    assert.ok(result.added.some(detail => detail.kind === 'text' && detail.value === ' world'));
});

test('selection deletion that joins text runs retains one of the surviving text objects', () => {
    const source = '<p>left<b>middle</b>right</p>';
    const details = parseDOM(source);
    const left = details.find(detail => detail.value === 'left');
    const right = details.find(detail => detail.value === 'right');
    const start = source.indexOf('<b>'), end = source.indexOf('</b>') + 4;
    const result = apply(details, start, end - start, '');
    const survivor = details.find(detail => detail.value === 'leftright');
    assert.ok(survivor === left || survivor === right);
    assert.ok(result.edited.some(item => item.detail === survivor));
    assert.equal(result.added.filter(detail => detail.kind === 'text').length, 0);
});

test('an affected element can be replaced by a text/element sequence without parsing its parent', () => {
    const source = '<main><b>old</b><i>keep</i></main>';
    const details = parseDOM(source), parent = details[0];
    const affected = details.find(detail => detail.tag === 'b');
    const sibling = details.find(detail => detail.value === 'keep');
    const start = source.indexOf('<b>'), end = source.indexOf('</b>') + 4;
    const value = 'prefix<u>new</u>suffix', parsed = [];
    const result = apply(details, start, end - start, value, { parse(fragment, editor) {
        parsed.push(fragment);
        return parseDOM(fragment, editor);
    } });
    assert.deepEqual(parsed, [value]);
    assert.equal(result.reparse.start, start);
    assert.equal(result.reparse.end, end);
    assert.equal(result.reparse.anchor, parent);
    assert.ok(result.removed.some(item => item.detail === affected));
    assert.ok(details.includes(parent));
    assert.ok(details.includes(sibling));
    assert.ok(details.filter(detail => ['prefix', 'suffix'].includes(detail.value))
        .every(detail => detail.parentDetails === parent));
});
