const { test } = require("node:test");
const assert = require("node:assert/strict");

let prototype;
let lengthEditorDetails;
test("load editor-details prototype", async () => {
    prototype = await import("../src/prototype/index.js");
    ({ lengthEditorDetails } = prototype);
});

test("DOM parser creates an ordered, source-preserving detail array", async () => {
    const source = '<main  class="page">\n\t<p>Hello <b>world</b></p><!-- end --></main>';
    const editor = { editor: { updateText() {} } };
    const details = await prototype.parseAndStoreEditorDetails(editor, source);

    assert.equal(lengthEditorDetails.detailsToSource(details), source);
    assert.equal(lengthEditorDetails.getDetailsLength(details), source.length);

    let position = 0;
    for (const detail of details) {
        assert.equal(detail.getStart(), position);
        assert.equal(detail.length, detail.value.length);
        assert.equal(detail.editor, editor);
        position += detail.length;
    }
    assert.equal(position, source.length);
    assert.equal(typeof details.find(detail => detail.kind === "element").setAttribute, "function");
    assert.equal(details.find(detail => detail.kind === "text").setAttribute, undefined);
});

test("DOM parser keeps each contiguous text run in one detail and edits it in place at its end", async () => {
    const source = "<p>alpha  beta\n\tgamma</p>\n<div>next line</div>";
    const details = await prototype.parseDOM(source);
    const text = details.filter(detail => detail.kind === "text");

    assert.deepEqual(text.map(detail => detail.value), ["alpha  beta\n\tgamma", "\n", "next line"]);
    assert.equal(lengthEditorDetails.detailsToSource(details), source);

    const target = text[0];
    const position = target.getStart() + target.length;
    const plan = lengthEditorDetails.planDetailsEdit(details, position, position, "!");
    assert.deepEqual(plan.added, []);
    assert.equal(plan.edited[0].detail, target);
    assert.equal(plan.edited[0].value, "alpha  beta\n\tgamma!");
});

test("detail updateText, setValue, and remove dispatch detail-relative CRDT edits", async () => {
    const operations = [];
    const editor = { editor: { updateText: operation => operations.push(operation) } };
    const details = await prototype.parseAndStoreEditorDetails(editor, "<p>alpha</p>");
    const text = details.find(detail => detail.kind === "text");
    const original = text.value;

    text.updateText({ start: 1, length: 2, value: "XY" });
    text.setValue("replacement");
    text.remove();

    assert.deepEqual(operations, [
        { start: text.getStart() + 1, length: 2, value: "XY" },
        { start: text.getStart(), length: text.length, value: "replacement" },
        { start: text.getStart(), length: text.length, value: "" }
    ]);
    assert.equal(text.value, original, "dispatching an edit must not mutate local details");
});

test("incoming CRDT updates edit values, refresh cached lengths, and keep the source in sync", async () => {
    const editor = { editor: { updateText() {} } };
    const source = "<p>alpha</p>";
    const details = await prototype.parseAndStoreEditorDetails(editor, source);
    const text = details.find(detail => detail.kind === "text");
    const start = text.getStart() + 1;
    const result = prototype.updateStoredEditorDetails(editor, {
        start,
        length: 3,
        value: "OMEGA",
        string: "<p>aOMEGAa</p>"
    });

    assert.equal(text.value, "aOMEGAa");
    assert.equal(text.length, text.value.length);
    assert.equal(result.edited[0].detail, text);
    assert.equal(lengthEditorDetails.detailsToSource(details), result.source);
    assert.equal(result.source, "<p>aOMEGAa</p>");
    assert.equal(text.getStart(), start - 1);
});

test("range deletion classifies removed records and preserves exact source balance", async () => {
    const editor = { editor: { updateText() {} } };
    const source = "<p>a b</p>";
    const details = await prototype.parseAndStoreEditorDetails(editor, source);
    const result = prototype.updateStoredEditorDetails(editor, {
        start: 3,
        length: 3,
        value: "",
        string: "<p></p>"
    });

    assert.equal(result.removed.length, 1, "the complete contiguous text run is one removable detail");
    assert.equal(lengthEditorDetails.detailsToSource(details), "<p></p>");
    assert.equal(lengthEditorDetails.getDetailsLength(details), 7);
});

test("element attribute APIs resolve attribute details and dispatch CRDT ranges", async () => {
    const operations = [];
    const editor = { editor: { updateText: operation => operations.push(operation) } };
    const details = await prototype.parseAndStoreEditorDetails(editor, '<div class="old"></div>');
    const element = details.find(detail => detail.kind === "element");
    const nativeAttribute = { name: "class", value: "old" };
    const liveElement = {
        getAttributeNode(name) {
            return name.toLowerCase() === "class" ? nativeAttribute : null;
        }
    };
    prototype.bindEditorDetailsLiveDOM(element, liveElement);

    const attribute = element.getAttribute("class");
    assert.equal(attribute.kind, "attribute");
    assert.equal(attribute.liveDOM, nativeAttribute);

    element.setAttribute("class", "new");
    attribute.remove();
    element.removeAttribute("class");
    element.setAttribute("role", "button");

    assert.deepEqual(operations, [
        { start: attribute.getStart(), length: attribute.length, value: 'class="new"' },
        { start: attribute.getStart(), length: attribute.length, value: "" },
        { start: attribute.getStart(), length: attribute.length, value: "" },
        { start: element.getStart() + element.length, length: 0, value: ' role="button"' }
    ]);
    assert.equal(element.getAttribute("missing"), null);
});

test("Markdown details preserve delimiters, content, and individual whitespace nodes without DOM APIs", async () => {
    const tick = String.fromCharCode(96);
    const source = "# Heading **bold**\r\n- item [link](url)\n\n\tcode " + tick + "x * y" + tick + "\n";
    const editor = { editor: { updateText() {} } };
    const details = await prototype.parseAndStoreMarkdownDetails(editor, source);

    assert.equal(lengthEditorDetails.detailsToSource(details), source);
    assert.equal(lengthEditorDetails.getDetailsLength(details), source.length);
    const heading = details.find(detail => detail.syntax === "heading");
    assert.equal(heading.kind, "element");
    assert.equal(heading.tag, "h1");
    assert.equal(heading.nodeType, 3, "Markdown semantic tags are not DOM Element nodes");
    assert.equal(details[details.indexOf(heading) + 1].kind, "whitespace");
    assert.equal(details[details.indexOf(heading) + 1].parentDetails, heading);
    assert.ok(details.some(detail => detail.syntax === "strong-open"));
    assert.ok(details.some(detail => detail.syntax === "link-destination-open"));
    assert.ok(details.some(detail => detail.syntax === "code-open"));
    assert.ok(details.some(detail => detail.kind === "lineBreak" && detail.value === "\r\n"));
    assert.ok(details.some(detail => detail.kind === "tab" && detail.value === "\t"));
    assert.ok(details.filter(detail => detail.kind === "whitespace")
        .every(detail => detail.value.length === 1 && detail.length === 1));
    assert.ok(details.every(detail => detail.nodeType === 3 && detail.editor === editor));
    assert.equal(details[0].getAttribute, undefined);
});

test("code bridge selects language tokenizers and preserves every source character", async () => {
    const editor = { editor: { updateText() {} } };
    const javascript = 'const answer = "yes";\n';
    const jsDetails = await prototype.parseAndStoreCodeDetails(editor, javascript, "js");
    assert.equal(lengthEditorDetails.detailsToSource(jsDetails), javascript);
    assert.equal(lengthEditorDetails.getDetailsLength(jsDetails), javascript.length);
    assert.ok(jsDetails.some(detail => detail.token === "keyword" && detail.value === "const"));
    assert.ok(jsDetails.some(detail => detail.token === "string" && detail.value === '"yes"'));
    assert.ok(jsDetails.some(detail => detail.kind === "lineBreak" && detail.value === "\n"));
    assert.ok(jsDetails.every(detail => detail.editor === editor && detail.getAttribute === undefined));

    const html = '<p class="x">Hi</p>';
    const htmlDetails = await prototype.parseCode(html, "html", editor);
    assert.equal(lengthEditorDetails.detailsToSource(htmlDetails), html);
    assert.ok(htmlDetails.some(detail => detail.token === "tag" && detail.value === "p"));
    assert.ok(htmlDetails.some(detail => detail.token === "attribute" && detail.value === "class"));

    const plain = "one two\n";
    const plainDetails = await prototype.parseCode(plain, "text", editor);
    assert.equal(lengthEditorDetails.detailsToSource(plainDetails), plain);
    assert.ok(plainDetails.every(detail => !detail.token));
});

test("code bridge accepts every existing language module through the shared detail creator", async () => {
    const languages = [
        "javascript", "typescript", "html", "css", "json", "python", "sql",
        "bash", "yaml", "c", "go", "java", "php"
    ];
    for (const language of languages) {
        const source = 'const value = "x";\n';
        const details = await prototype.parseCode(source, language);
        assert.equal(lengthEditorDetails.detailsToSource(details), source, language);
        assert.equal(lengthEditorDetails.getDetailsLength(details), source.length, language);
        assert.ok(details.every(detail => detail.language === language && detail.length === detail.value.length), language);
    }
});

test("prototype core routes local input through updateText and incoming updates into details", async () => {
    const operations = [];
    class TextSurface extends EventTarget {
        constructor() {
            super();
            this.value = "abc";
            this.selectionStart = 1;
            this.selectionEnd = 1;
            this.editor = {};
        }
        getAttribute() { return null; }
        hasAttribute() { return false; }
    }
    const element = new TextSurface();
    const core = prototype.createPrototypeCore({ updateText: operation => operations.push(operation), eventTarget: null });
    const details = await core.initEditor(element, { mode: "text" });

    element.value = "aXbc";
    element.dispatchEvent(new Event("input"));
    await Promise.resolve();
    assert.deepEqual(operations, [{ element, start: 1, length: 0, value: "X" }]);

    await core.receiveUpdate({ elements: [element], start: 1, length: 0, value: "X", string: "aXbc" });

    const results = await core.receiveUpdate({
        elements: [element], start: 1, length: 1, value: "Y", string: "aYbc"
    });
    assert.equal(results.length, 1);
    assert.equal(lengthEditorDetails.detailsToSource(details), "aYbc");
    assert.equal(core.getEditorDetails(element), details);
    core.disconnect();
});

test("prototype local text edits update details without applying the edit twice to the surface", async () => {
    class TextSurface extends EventTarget {
        constructor() {
            super();
            this.value = "abc";
            this.selectionStart = 1;
            this.selectionEnd = 1;
        }
        getAttribute() { return null; }
        hasAttribute() { return false; }
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    }
    const element = new TextSurface();
    const core = prototype.createPrototypeCore({ eventTarget: null });
    const details = await core.initEditor(element, { mode: "text" });
    element.selectionStart = element.selectionEnd = 2;
    element.value = "aXbc";
    element.dispatchEvent(new Event("input"));
    await Promise.resolve();
    assert.equal(lengthEditorDetails.detailsToSource(details), "aXbc");
    assert.equal(element.value, "aXbc");
    assert.equal(element.selectionStart, 2);
    core.disconnect();
});
