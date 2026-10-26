const { test, before } = require('node:test');
const assert = require('node:assert/strict');
let parseDOM, renderEditor;
before(async () => {
    ({ parseDOM } = await import('../src/prototype/editors/parsers/dom.js'));
    ({ renderEditor } = await import('../src/prototype/editors/utilities/renderEditor.js'));
});

function assertSource(details, source) {
    assert.equal(details.map(detail => detail.value).join(''), source);
    let position = 0;
    for (let index = 0; index < details.length; index++) {
        const detail = details[index];
        assert.equal(detail.getStart(), position);
        assert.equal(detail.length, detail.value.length);
        assert.ok(detail.length > 0);
        assert.ok(!(detail.kind === 'text' && details[index - 1]?.kind === 'text'),
            'consecutive source text belongs to one detail');
        position += detail.length;
    }
    assert.equal(position, source.length);
}

test('DOM keeps tag whitespace separate from attributes without producing live text nodes', () => {
    const source = '<h1 \tclass="a b"  data-x = "c > d"\r\n >Hello  world\n!</h1>';
    const details = parseDOM(source);
    assertSource(details, source);
    assert.deepEqual(details.map(detail => [detail.kind, detail.value]), [
        ['element', '<h1'], ['text', ' \t'], ['attribute', 'class="a b"'],
        ['text', '  '], ['attribute', 'data-x = "c > d"'], ['text', '\r\n '],
        ['markup', '>'], ['text', 'Hello  world\n!'], ['elementEnd', '</h1>']
    ]);
    const element = details[0];
    assert.equal(element.nodeType, 1);
    for (const detail of details.slice(1)) assert.equal(detail.parentDetails, element);
    const spacing = details.filter(detail => detail.kind === 'text' && detail.sourceOnly);
    assert.equal(spacing.length, 3);
    assert.ok(spacing.every(detail => detail.nodeType === 3 && detail.liveDOM === null));
    assert.ok(details.filter(detail => ['markup', 'elementEnd'].includes(detail.kind))
        .every(detail => detail.sourceOnly && detail.nodeType === null));
});

test('DOM combines words, whitespace, entities, and literal less-than signs into text runs', () => {
    for (const source of ['one  two\n\tthree', '\r\n  \t', 'one < two < 3 and > four', '&amp; &#x1f642; text']) {
        const details = parseDOM(source);
        assertSource(details, source);
        assert.equal(details.length, 1);
        assert.equal(details[0].kind, 'text');
        assert.equal(details[0].sourceOnly, undefined);
    }
    const source = '<p>one two</p>\n\t<div>three four</div>';
    const details = parseDOM(source);
    assertSource(details, source);
    assert.deepEqual(details.filter(detail => detail.kind === 'text').map(detail => detail.value),
        ['one two', '\n\t', 'three four']);
});

test('incomplete opening and closing tags remain part of their contiguous text run', () => {
    for (const source of ['<', '<h1', 'before <h1 class="unfinished', '<p>inside</p']) {
        const details = parseDOM(source);
        assertSource(details, source);
        assert.equal(details.at(-1).kind, 'text');
    }
    assert.equal(parseDOM('before <h1 class="unfinished').length, 1);
});

test('a broken opening tag in the middle stays text while following complete elements still parse', () => {
    const source = [
        '<h3 class="title  primary"  data-id="heading"   title="Edit this heading">Edit this heading</h3>',
        '<div class="broken"  data-note="missing closing angle"',
        '<input class="field  compact"  type="text"   placeholder="Type  here" disabled>',
        '<img class="preview  rounded"  src="example.png"   alt="Example  image">',
        '<p class="description  muted"  data-state="ready"   title="Two  spaces inside">HTML source is split into editor details.</p>'
    ].join('\n');
    const details = parseDOM(source);
    assertSource(details, source);
    const elements = details.filter(detail => detail.kind === 'element');
    assert.deepEqual(elements.map(detail => detail.tag), ['h3', 'input', 'img', 'p']);
    assert.ok(elements.every(detail => detail.parentDetails === null));
    const broken = details.find(detail => detail.kind === 'text' && detail.value.includes('<div'));
    assert.equal(broken.value, '\n<div class="broken"  data-note="missing closing angle"\n');
    assert.equal(broken.sourceOnly, undefined);
    assert.equal(broken.parentDetails, null);
    assert.ok(!details.some(detail => detail.kind === 'attribute' && detail.name === 'data-note'));
    assert.ok(details.some(detail => detail.sourceOnly && detail.value === '  '));
    assert.ok(details.some(detail => detail.sourceOnly && detail.value === '   '));
    assert.ok(details.some(detail => detail.kind === 'attribute' && detail.value === 'class="title  primary"'));
    for (const tag of ['input', 'img']) {
        const element = elements.find(detail => detail.tag === tag);
        assert.ok(details.some(detail => detail.kind === 'attribute' && detail.parentDetails === element));
        assert.ok(!details.some(detail => detail.kind === 'elementEnd' && detail.tag === tag));
    }
    assert.ok(details.some(detail => detail.kind === 'attribute' && detail.name === 'disabled' && detail.value === 'disabled'));
});

test('an angle bracket inside a quoted attribute stays inside that attribute', () => {
    const source = '<p title="before < after"  data-x="next">content</p>';
    const details = parseDOM(source);
    assertSource(details, source);
    assert.equal(details.find(detail => detail.kind === 'attribute').value, 'title="before < after"');
    assert.equal(details.filter(detail => detail.kind === 'element').length, 1);
});

test('DOM keeps quoted attribute contents whole and distinguishes boolean and unquoted slash syntax', () => {
    for (const source of ['<input disabled/>', '<input data-x=one/>', '<input disabled  checked >'])
        assertSource(parseDOM(source), source);
    const boolean = parseDOM('<input disabled/>');
    assert.equal(boolean.find(detail => detail.kind === 'attribute').name, 'disabled');
    assert.equal(boolean.at(-1).value, '/>');
    assert.equal(boolean[0].selfClosing, true);
    const unquoted = parseDOM('<input data-x=one/>');
    assert.equal(unquoted.find(detail => detail.kind === 'attribute').value, 'data-x=one/');
    assert.equal(unquoted.at(-1).value, '>');
    assert.equal(unquoted[0].selfClosing, false);
});

test('DOM preserves raw text and comment boundaries without parsing their inner markup', () => {
    const source = '<script>const x = "<b>";\n  x < y;</script>after<!-- <b> -->tail';
    const details = parseDOM(source);
    assertSource(details, source);
    assert.equal(details.filter(detail => detail.kind === 'element').length, 1);
    assert.deepEqual(details.filter(detail => detail.kind === 'text').map(detail => detail.value),
        ['const x = "<b>";\n  x < y;', 'after', 'tail']);
    assert.equal(details.find(detail => detail.kind === 'comment').value, '<!-- <b> -->');
});

test('source-only tag spacing is never constructed as a live Text node by the renderer', () => {
    const details = parseDOM('<p   class="x">content</p>');
    const spacing = details.find(detail => detail.sourceOnly && detail.kind === 'text');
    const editor = { liveDOM: { ownerDocument: {
        createTextNode() { assert.fail('tag spacing must not produce a live Text node'); }
    } } };
    renderEditor(editor, { editorDetails: [spacing], added: [spacing] });
    assert.equal(spacing.liveDOM, null);
});

test('DOM details cover exact source lengths across deterministic combinations of incomplete markup', () => {
    const parts = ['<', '>', '/', ' ', '\t', '\r\n', 'p', 'class', '=', '"', "'", '&amp;', 'text', '🙂', '<!--', '-->'];
    let seed = 379;
    for (let sample = 0; sample < 500; sample++) {
        let source = '';
        for (let item = 0; item < 25; item++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            source += parts[seed % parts.length];
        }
        assertSource(parseDOM(source), source);
    }
});
