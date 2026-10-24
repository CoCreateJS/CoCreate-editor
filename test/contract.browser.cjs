const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
    path = require("node:path"),
    http = require("node:http");
const { chromium } = require(
    process.env.PLAYWRIGHT_MODULE || "playwright-core"
);
const root = process.env.EDITOR_DIST || path.resolve(__dirname, "../dist");
let browser, server, base;
before(async () => {
    server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://localhost");
        if (url.pathname === "/") {
            res.setHeader("Content-Type", "text/html");
            res.end(
                '<!doctype html><html><head><link rel="stylesheet" href="/CoCreate-editor.css"></head><body><script src="/CoCreate-editor.js"></script></body></html>'
            );
            return;
        }
        const file = path.resolve(root, "." + url.pathname);
        if (!file.startsWith(root + "/")) {
            res.writeHead(403).end();
            return;
        }
        fs.readFile(file, (err, data) => {
            if (err) {
                res.writeHead(404).end();
                return;
            }
            res.setHeader(
                "Content-Type",
                file.endsWith(".js")
                    ? "application/javascript"
                    : file.endsWith(".css")
                      ? "text/css"
                      : "application/octet-stream"
            );
            res.end(data);
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox"],
        ...(process.env.CHROMIUM_PATH
            ? { executablePath: process.env.CHROMIUM_PATH }
            : {})
    });
});
after(async () => {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
});
async function page() {
    const p = await browser.newPage();
    await p.goto(base);
    await p.waitForFunction(() => CoCreate.editor?.create);
    return p;
}

test("component initial value uses Element Prototype, then Editor owns getValue/setValue", async () => {
    const p = await page();
    try {
        const initial = await p.evaluate(() => {
            const host = document.createElement("div");
            host.id = "editor";
            host.setAttribute("component", "");
            host.setValue("**Initial**");
            const before = {
                markup: host.innerHTML,
                attribute: host.getAttribute("value"),
                value: host.getValue()
            };
            host.setAttribute("editor", "markdown");
            document.body.append(host);
            return before;
        });
        assert.deepEqual(initial, {
            markup: "",
            attribute: null,
            value: "**Initial**"
        });
        await p.waitForSelector("#editor.cocreate-editor");
        assert.match(
            await p.locator("#editor.cocreate-editor").innerHTML(),
            /<strong[^>]*>Initial<\/strong>/
        );
        await p.evaluate(() =>
            document.querySelector("#editor").setValue("**Updated**")
        );
        assert.match(
            await p.locator("#editor.cocreate-editor").innerHTML(),
            /<strong[^>]*>Updated<\/strong>/
        );
        await p.locator("#editor.cocreate-editor").fill("Typed");
        assert.match(
            await p.evaluate(() =>
                document.querySelector("#editor").getValue()
            ),
            /Typed/
        );
        assert.equal(await p.locator("#editor").getAttribute("value"), null);
    } finally {
        await p.close();
    }
});

test("only the marked host initializes; query attributes do not target other elements", async () => {
    const p = await page();
    try {
        await p.evaluate(() => {
            const target = document.createElement("div");
            target.id = "target";
            target.textContent = "Own value";
            const unrelated = document.createElement("div");
            unrelated.id = "unrelated";
            const control = document.createElement("span");
            control.setAttribute("editor-query", "$document #unrelated");
            document.body.append(target, unrelated, control);
            target.setAttribute("editor-query", "$document #unrelated");
            target.setAttribute("editor", "markdown");
        });
        await p.waitForSelector("#target.cocreate-editor");
        assert.equal(await p.locator("#unrelated.cocreate-editor").count(), 0);
        assert.equal(await p.locator(".cocreate-editor").count(), 1);
        assert.match(
            await p.locator("#target.cocreate-editor").innerText(),
            /Own value/
        );
    } finally {
        await p.close();
    }
});

test("the built-in placeholder appears once, follows value changes, and can be disabled", async () => {
    const p = await page();
    try {
        await p.evaluate(() => {
            const host = document.createElement("div");
            host.id = "editor";
            host.setAttribute("component", "");
            host.setAttribute("placeholder", "Message CoCreate AI…");
            host.setAttribute("editor", "markdown");
            document.body.append(host);
        });
        await p.waitForSelector("#editor.cocreate-editor");
        const count = () =>
            p.evaluate(
                () =>
                    [...document.querySelectorAll("#editor, #editor *")].filter(
                        (node) =>
                            getComputedStyle(node, "::before").content.includes(
                                "Message CoCreate AI"
                            )
                    ).length
            );
        assert.equal(await p.locator("#editor.cocreate-editor").count(), 1);
        assert.equal(await count(), 1);
        await p.locator("#editor.cocreate-editor").fill("Typed");
        assert.equal(await count(), 0);
        await p.evaluate(() => document.querySelector("#editor").setValue(""));
        assert.equal(await count(), 1);
        await p.evaluate(() => {
            CoCreate.editor.destroy(document.querySelector("#editor"));
            document.querySelector("#editor").remove();
            const host = document.createElement("div");
            host.id = "editor";
            host.setAttribute("editor", "markdown");
            host.setAttribute("placeholder", "Message CoCreate AI…");
            host.setAttribute("editor-placeholder", "false");
            document.body.append(host);
        });
        await p.waitForSelector("#editor.cocreate-editor");
        assert.equal(await count(), 0);
    } finally {
        await p.close();
    }
});

async function editor(p, value = "", type = "markdown") {
    await p.evaluate(
        async ({ value, type }) => {
            const e = document.createElement("div");
            e.id = "editor";
            e.setAttribute("component", "");
            e.setAttribute("editor", type);
            e.setValue(value);
            document.body.append(e);
            await CoCreate.editor.create(e);
        },
        { value, type }
    );
    return p.locator("#editor.cocreate-editor");
}
async function value(p) {
    return p.evaluate(() => document.querySelector("#editor").getValue());
}

test("native input fulfills syntax and keeps Markdown as the exact source", async () => {
    const p = await page();
    try {
        const host = await editor(p);
        await host.pressSequentially("Hello **bold**");
        assert.equal(await value(p), "Hello **bold**");
        assert.equal(await host.locator("strong").innerText(), "bold");
        await p.keyboard.press("Backspace");
        assert.equal(await value(p), "Hello **bol**");
        await p.keyboard.press("Control+z");
        assert.equal(await value(p), "Hello **bold**");
        await p.keyboard.press("Control+Shift+z");
        assert.equal(await value(p), "Hello **bol**");
    } finally {
        await p.close();
    }
});

test("native Enter and cross-paragraph Backspace update source", async () => {
    const p = await page();
    try {
        const host = await editor(p, "First");
        await host.focus();
        await p.keyboard.press("End");
        await p.keyboard.press("Enter");
        await p.keyboard.type("Second");
        assert.match(await value(p), /^First\n+Second$/);
        await p.keyboard.press("Home");
        await p.keyboard.press("Backspace");
        assert.equal(await value(p), "FirstSecond");
    } finally {
        await p.close();
    }
});

test("source selections replace multiple blocks, preserve untouched nodes, and support custom syntax", async () => {
    const p = await page();
    try {
        await editor(p, "First\n\nSecond\n\nLast");
        await p.evaluate(async () => {
            window.lastBlock = document.querySelector(
                "#editor.cocreate-editor"
            ).lastChild;
            const e = document.querySelector("#editor");
            await CoCreate.editor.replaceRange(e, "New", { from: 0, to: 5 });
        });
        assert.equal(
            await p.evaluate(
                () =>
                    window.lastBlock ===
                    document.querySelector("#editor.cocreate-editor").lastChild
            ),
            true
        );
        await p.evaluate(async () => {
            const e = document.querySelector("#editor");
            await CoCreate.editor.setSelection(e, 1, 9);
            await CoCreate.editor.insert(e, "X");
        });
        assert.equal(await value(p), "NXnd\n\nLast");
        await p.evaluate(() => {
            CoCreate.editor.addSyntax({
                name: "custom",
                pattern: /##@\$(.+?)\$@##/g,
                tag: "mark",
                content: (m) => m[1],
                offset: () => 4
            });
            document.querySelector("#editor").setValue("##@$custom$@##");
        });
        assert.equal(await p.locator("#editor mark").innerText(), "custom");
    } finally {
        await p.close();
    }
});

test("composition remains live until completion, then commits text", async () => {
    const p = await page();
    try {
        await editor(p, "Hello");
        const result = await p.evaluate(() => {
            const host = document.querySelector(".cocreate-editor"),
                e = document.querySelector("#editor");
            host.dispatchEvent(
                new CompositionEvent("compositionstart", { bubbles: true })
            );
            host.firstChild.firstChild.data = "Hello世界";
            host.dispatchEvent(
                new InputEvent("input", {
                    bubbles: true,
                    inputType: "insertCompositionText",
                    isComposing: true
                })
            );
            const during = { source: e.getValue(), live: host.textContent };
            host.dispatchEvent(
                new CompositionEvent("compositionend", {
                    bubbles: true,
                    data: "世界"
                })
            );
            return { during, after: e.getValue() };
        });
        assert.deepEqual(result, {
            during: { source: "Hello", live: "Hello世界" },
            after: "Hello世界"
        });
    } finally {
        await p.close();
    }
});

test("detached rendering heals live markup and preserves exact source on no-op input", async () => {
    const p = await page();
    try {
        await editor(p, "**Safe**");
        await p.evaluate(() => {
            const host = document.querySelector(".cocreate-editor");
            host.innerHTML = '<p onclick="bad()">Safe</p>';
            host.dispatchEvent(
                new InputEvent("input", {
                    bubbles: true,
                    inputType: "formatBold"
                })
            );
        });
        assert.equal(await value(p), "**Safe**");
        assert.equal(await p.locator("#editor strong").innerText(), "Safe");
        assert.equal(await p.locator("#editor [onclick]").count(), 0);
    } finally {
        await p.close();
    }
});

test("empty documents accept Enter followed by text, including emoji", async () => {
    const p = await page();
    try {
        const host = await editor(p);
        await host.focus();
        await p.keyboard.press("Enter");
        await p.keyboard.insertText("😀 hello");
        assert.equal(await value(p), "\n😀 hello");
        await p.keyboard.press("Backspace");
        assert.equal(await value(p), "\n😀 hell");
    } finally {
        await p.close();
    }
});

test("native replacement across blocks removes selected source and preserves the suffix", async () => {
    const p = await page();
    try {
        await editor(p, "One\n\nTwo\n\nThree");
        await p.evaluate(() =>
            CoCreate.editor.setSelection(
                document.querySelector("#editor"),
                1,
                7
            )
        );
        await p.keyboard.type("X");
        assert.equal(await value(p), "OXo\n\nThree");
    } finally {
        await p.close();
    }
});

test("renderer handles setext headings, code fences, and refuses raw HTML or script links", async () => {
    const p = await page();
    try {
        const host = await editor(
            p,
            "Title\n=====\n\n```js\nconst x = 1;\n```\n\n<script>alert(1)</script> [bad](javascript:alert)"
        );
        assert.equal(await host.locator("h1").innerText(), "Title");
        assert.match(await host.locator("pre").innerText(), /const x = 1;/);
        assert.equal(await host.locator("script").count(), 0);
        assert.equal(await host.locator("a").getAttribute("href"), "#");
    } finally {
        await p.close();
    }
});

test("long documents preserve canonical source and untouched nodes after one edit", async () => {
    const p = await page();
    try {
        const text = Array.from(
            { length: 600 },
            (_, i) => `Paragraph ${i}: **bold** text.`
        ).join("\n\n");
        await editor(p, text);
        await p.evaluate(
            () =>
                (window.untouched =
                    document.querySelector(".cocreate-editor").lastChild)
        );
        await p.evaluate(() =>
            CoCreate.editor.replaceRange(
                document.querySelector("#editor"),
                "Changed",
                { from: 0, to: 9 }
            )
        );
        assert.equal(await value(p), "Changed" + text.slice(9));
        assert.equal(
            await p.evaluate(
                () =>
                    window.untouched ===
                    document.querySelector(".cocreate-editor").lastChild
            ),
            true
        );
    } finally {
        await p.close();
    }
});

test("explicit healing restores text projection without changing source", async () => {
    const p = await page();
    try {
        await editor(p, "**Canonical**");
        await p.evaluate(() => {
            document.querySelector(".cocreate-editor").textContent = "Broken";
            CoCreate.editor.heal(document.querySelector("#editor"));
        });
        assert.equal(await value(p), "**Canonical**");
        assert.equal(
            await p.locator("#editor strong").innerText(),
            "Canonical"
        );
    } finally {
        await p.close();
    }
});

test("typing after completed syntax leaves subsequent text outside that syntax", async () => {
    const p = await page();
    try {
        const host = await editor(p);
        await host.pressSequentially("**bold**!");
        assert.equal(await value(p), "**bold**!");
        assert.equal(await host.locator("strong").innerText(), "bold");
    } finally {
        await p.close();
    }
});

test("browser IME composition commits without losing the composed characters", async () => {
    const p = await page();
    try {
        const host = await editor(p, "Hello ");
        await host.focus();
        await p.keyboard.press("End");
        const cdp = await p.context().newCDPSession(p);
        await cdp.send("Input.imeSetComposition", {
            text: "世界",
            selectionStart: 2,
            selectionEnd: 2
        });
        assert.equal(await value(p), "Hello ");
        await cdp.send("Input.insertText", { text: "世界" });
        assert.equal(await value(p), "Hello 世界");
        assert.equal(await host.innerText(), "Hello 世界");
    } finally {
        await p.close();
    }
});

test("multiline quote edits and emoji deletion use source offsets correctly", async () => {
    const p = await page();
    try {
        await editor(p, "> one\n> two");
        await p.evaluate(() =>
            CoCreate.editor.setSelection(document.querySelector("#editor"), 9)
        );
        await p.keyboard.type("X");
        assert.equal(await value(p), "> one\n> tXwo");
        await p.evaluate(() =>
            document.querySelector("#editor").setValue("😀")
        );
        await p.locator(".cocreate-editor").focus();
        await p.keyboard.press("End");
        await p.keyboard.press("Backspace");
        assert.equal(await value(p), "");
    } finally {
        await p.close();
    }
});

test("asynchronous initial reads cannot overwrite newer source writes", async () => {
    const p = await page();
    try {
        await p.evaluate(async () => {
            const e = document.createElement("div");
            e.id = "editor";
            let resolve;
            e.getValue = () =>
                new Promise((r) => {
                    resolve = r;
                });
            document.body.append(e);
            const ready = CoCreate.editor.create(e);
            e.setValue("Newer");
            resolve("Older");
            await ready;
        });
        assert.equal(await value(p), "Newer");
        assert.equal(await p.locator(".cocreate-editor").innerText(), "Newer");
    } finally {
        await p.close();
    }
});

test("plain-text paste replaces the source selection and cannot inject HTML", async () => {
    const p = await page();
    try {
        await editor(p, "Before After");
        await p.evaluate(async () => {
            await CoCreate.editor.setSelection(
                document.querySelector("#editor"),
                7,
                12
            );
            const clipboardData = new DataTransfer();
            clipboardData.setData("text/plain", "<img src=x onerror=bad()>");
            document.querySelector(".cocreate-editor").dispatchEvent(
                new ClipboardEvent("paste", {
                    bubbles: true,
                    cancelable: true,
                    clipboardData
                })
            );
        });
        assert.equal(await value(p), "Before <img src=x onerror=bad()>");
        assert.equal(await p.locator("#editor img").count(), 0);
    } finally {
        await p.close();
    }
});

test("healing preserves selections and CRDT source changes remain silent", async () => {
    const p = await page();
    try {
        await editor(p, "First Second");
        const result = await p.evaluate(async () => {
            const e = document.querySelector("#editor");
            await CoCreate.editor.setSelection(e, 1, 4);
            CoCreate.editor.heal(e);
            const selected = await CoCreate.editor.getSelection(e);
            let events = 0;
            e.addEventListener("input", () => events++);
            CoCreate.editor.applyChange(e, {
                start: 6,
                length: 6,
                value: "Last"
            });
            return { selected, source: e.getValue(), events };
        });
        assert.equal(result.selected.anchor, 1);
        assert.equal(result.selected.head, 4);
        assert.equal(result.source, "First Last");
        assert.equal(result.events, 0);
    } finally {
        await p.close();
    }
});

test("destroy hands the latest source back to a generic component host", async () => {
    const p = await page();
    try {
        await editor(p, "**Initial**");
        const result = await p.evaluate(() => {
            const e = document.querySelector("#editor");
            e.setValue("**Latest**");
            CoCreate.editor.destroy(e);
            return {
                value: e.getValue(),
                editor: e.querySelector(".cocreate-editor") !== null
            };
        });
        assert.deepEqual(result, { value: "**Latest**", editor: false });
    } finally {
        await p.close();
    }
});

test("marked div is the editing surface and publishes each edit once", async () => {
    const p = await page();
    try {
        const host = await editor(p, "Initial");
        const result = await p.evaluate(async () => {
            const e = document.querySelector("#editor");
            const instance = await CoCreate.editor.create(e);
            window.inputEvents = [];
            e.addEventListener("input", () =>
                window.inputEvents.push(e.getValue())
            );
            return {
                same: instance.host === e,
                editable: e.contentEditable,
                nested: e.querySelectorAll(".cocreate-editor").length
            };
        });
        assert.deepEqual(result, { same: true, editable: "true", nested: 0 });
        await host.fill("Changed");
        assert.deepEqual(await p.evaluate(() => window.inputEvents), [
            "Changed"
        ]);
        await p.evaluate(() =>
            document.querySelector("#editor").setValue("Programmatic", true)
        );
        assert.deepEqual(await p.evaluate(() => window.inputEvents), [
            "Changed",
            "Programmatic"
        ]);
        assert.equal(await value(p), "Programmatic");
    } finally {
        await p.close();
    }
});

test("destroy preserves the host and restores its original editing attributes", async () => {
    const p = await page();
    try {
        const result = await p.evaluate(async () => {
            const e = document.createElement("div");
            e.id = "editor";
            e.className = "existing";
            e.setAttribute("contenteditable", "false");
            e.setAttribute("role", "group");
            e.setAttribute("aria-label", "Original");
            document.body.append(e);
            await CoCreate.editor.create(e);
            const editable = e.contentEditable;
            e.setValue("Source");
            CoCreate.editor.destroy(e);
            return {
                editable,
                connected: e.isConnected,
                className: e.className,
                role: e.getAttribute("role"),
                label: e.getAttribute("aria-label"),
                restored: e.contentEditable
            };
        });
        assert.deepEqual(result, {
            editable: "false",
            connected: true,
            className: "existing",
            role: "group",
            label: "Original",
            restored: "false"
        });
    } finally {
        await p.close();
    }
});

test("HTML mode renders complete allowed tags and preserves exact source spelling", async () => {
    const p = await page();
    try {
        const source =
            "<DIV class='box'><p title='a > b'>Hello <b>world</b> &amp; all.</p></DIV>";
        const host = await editor(p, source, "html");
        assert.equal(await host.locator("strong").innerText(), "world");
        assert.equal(await host.locator("p").getAttribute("title"), "a > b");
        assert.equal(await value(p), source);
        assert.match(await host.innerText(), /world & all/);
    } finally {
        await p.close();
    }
});

test("HTML syntax completes during native typing and following text stays outside the tag", async () => {
    const p = await page();
    try {
        const host = await editor(p, "", "html");
        await host.pressSequentially("<strong>Hello</strong>!");
        assert.equal(await value(p), "<strong>Hello</strong>!");
        assert.equal(await host.locator("strong").innerText(), "Hello");
        await p.evaluate(() =>
            CoCreate.editor.setSelection(document.querySelector("#editor"), 10)
        );
        await p.keyboard.type("X");
        assert.equal(await value(p), "<strong>HeXllo</strong>!");
    } finally {
        await p.close();
    }
});

test("HTML entities map one rendered character to its entire source range", async () => {
    const p = await page();
    try {
        await editor(p, "A &amp; B", "html");
        await p.evaluate(() =>
            CoCreate.editor.setSelection(
                document.querySelector("#editor"),
                2,
                7
            )
        );
        await p.keyboard.press("Backspace");
        assert.equal(await value(p), "A  B");
        await p.evaluate(() =>
            document.querySelector("#editor").setValue("A &#x1f600; B")
        );
        await p.evaluate(() =>
            CoCreate.editor.setSelection(document.querySelector("#editor"), 11)
        );
        await p.keyboard.press("Backspace");
        assert.equal(await value(p), "A  B");
    } finally {
        await p.close();
    }
});

test("HTML code and pre contents stay literal, including incomplete code regions", async () => {
    const p = await page();
    try {
        const host = await editor(
            p,
            "<code><b>literal</b> **raw** &lt;x&gt;</code><pre><em>raw</em></pre>",
            "html"
        );
        assert.equal(
            await host.locator("code").innerText(),
            "<b>literal</b> **raw** <x>"
        );
        assert.equal(await host.locator("pre").innerText(), "<em>raw</em>");
        assert.equal(await host.locator("strong,em").count(), 0);
        await p.evaluate(() =>
            document
                .querySelector("#editor")
                .setValue("<code><b>unfinished</b>")
        );
        assert.equal(await host.locator("strong").count(), 0);
        assert.equal(await host.innerText(), "<code><b>unfinished</b>");
    } finally {
        await p.close();
    }
});

test("Markdown code boundaries cannot be consumed by custom rules", async () => {
    const p = await page();
    try {
        const host = await editor(
            p,
            "`**literal**`\n\n```\n<strong>raw</strong>\n```"
        );
        await p.evaluate(() => {
            CoCreate.editor.addSyntax({
                name: "greedy",
                tag: "mark",
                markdown: {
                    scope: "inline",
                    pattern: /.+/g,
                    content: (m) => m[0],
                    offset: () => 0
                }
            });
        });
        assert.equal(await host.locator("code mark").count(), 0);
        assert.equal(await host.locator("strong").count(), 0);
        await p.evaluate(() =>
            document.querySelector("#editor").setValue("`**unfinished**")
        );
        assert.equal(await host.locator("strong,mark").count(), 0);
        assert.equal(await host.innerText(), "`**unfinished**");
    } finally {
        await p.close();
    }
});

test("one shared definition can support both formats and updates active editors", async () => {
    const p = await page();
    try {
        await editor(p, "%%hello%%");
        await p.evaluate(async () => {
            const e = document.createElement("div");
            e.id = "html-editor";
            e.setAttribute("editor", "html");
            document.body.append(e);
            await CoCreate.editor.create(e);
            e.setValue("<highlight>hello</highlight>");
            window.removeRule = CoCreate.editor.addSyntax({
                name: "highlight",
                tag: "mark",
                markdown: {
                    scope: "inline",
                    pattern: /%%(.+?)%%/g,
                    content: (m) => m[1],
                    offset: () => 2
                },
                html: { tags: ["highlight"] }
            });
        });
        assert.equal(await p.locator("#editor mark").innerText(), "hello");
        assert.equal(await p.locator("#html-editor mark").innerText(), "hello");
        await p.evaluate(() =>
            CoCreate.editor.updateSyntax("highlight", {
                tag: "s",
                markdown: {
                    scope: "inline",
                    pattern: /%%(.+?)%%/g,
                    content: (m) => m[1],
                    offset: () => 2
                },
                html: { tags: ["highlight"] }
            })
        );
        assert.equal(await p.locator("#editor s").innerText(), "hello");
        assert.equal(await p.locator("#html-editor s").innerText(), "hello");
        assert.equal(await value(p), "%%hello%%");
    } finally {
        await p.close();
    }
});

test("Markdown-only definitions do not run in HTML mode and vice versa", async () => {
    const p = await page();
    try {
        const host = await editor(p, "**bold** <strong>HTML</strong>", "html");
        assert.equal(await host.locator("strong").innerText(), "HTML");
        assert.match(await host.innerText(), /\*\*bold\*\*/);
        await p.evaluate(() => {
            CoCreate.editor.addSyntax({
                name: "html-only",
                tag: "mark",
                html: { tags: ["highlight"] }
            });
            document
                .querySelector("#editor")
                .setAttribute("editor", "markdown");
            document
                .querySelector("#editor")
                .setValue("**bold** <highlight>literal</highlight>");
        });
        await p.waitForFunction(
            () =>
                document.querySelector("#editor strong")?.textContent === "bold"
        );
        assert.equal(await host.locator("mark").count(), 0);
        assert.match(await host.innerText(), /<highlight>literal<\/highlight>/);
    } finally {
        await p.close();
    }
});

test("changing editor changes the projection without converting the source", async () => {
    const p = await page();
    try {
        const host = await editor(p, "<strong>HTML</strong>");
        assert.equal(await host.locator("strong").count(), 0);
        await p.evaluate(() =>
            document.querySelector("#editor").setAttribute("editor", "html")
        );
        await host.locator("strong").waitFor();
        assert.equal(await value(p), "<strong>HTML</strong>");
        await p.evaluate(() =>
            document.querySelector("#editor").setAttribute("editor", "markdown")
        );
        await p.waitForFunction(
            () => !document.querySelector("#editor strong")
        );
        assert.equal(await value(p), "<strong>HTML</strong>");
    } finally {
        await p.close();
    }
});

test("HTML rendering keeps unsupported tags literal and drops executable attributes", async () => {
    const p = await page();
    try {
        const host = await editor(
            p,
            '<script>bad()</script><a href="javascript:bad()" onclick="bad()">link</a><strong onmouseover="bad()">text</strong>',
            "html"
        );
        assert.equal(
            await host.locator("script,[onclick],[onmouseover]").count(),
            0
        );
        assert.equal(await host.locator("a").getAttribute("href"), "#");
        assert.match(await host.innerText(), /<script>bad\(\)<\/script>/);
    } finally {
        await p.close();
    }
});

test("native fields initialize without wrappers; invalid value types report an error", async () => {
    const p = await page();
    try {
        const result = await p.evaluate(async () => {
            const textarea = document.createElement("textarea");
            textarea.setAttribute("editor", "text");
            document.body.append(textarea);
            let rejected = false;
            try {
                await CoCreate.editor.create(textarea);
            } catch {
                rejected = true;
            }
            const e = document.createElement("div");
            e.setAttribute("editor", "bad");
            let error = false;
            e.addEventListener("editor-error", () => (error = true));
            document.body.append(e);
            await new Promise((resolve) => setTimeout(resolve, 30));
            return {
                rejected,
                error,
                textareaClass: textarea.className,
                wrappers: document.querySelectorAll(".cocreate-editor").length
            };
        });
        assert.deepEqual(result, {
            rejected: false,
            error: true,
            textareaClass: "",
            wrappers: 0
        });
    } finally {
        await p.close();
    }
});

test("updating and removing a shared registration heals both languages", async () => {
    const p = await page();
    try {
        const host = await editor(p, "%%hello%%");
        await p.evaluate(() => {
            window.remove = CoCreate.editor.addSyntax({
                name: "test-rule",
                tag: "mark",
                markdown: {
                    pattern: /%%(.+?)%%/g,
                    content: (m) => m[1],
                    offset: () => 2
                }
            });
        });
        assert.equal(await host.locator("mark").innerText(), "hello");
        await p.evaluate(() =>
            CoCreate.editor.updateSyntax("test-rule", {
                tag: "s",
                html: { tags: ["custom-tag"] }
            })
        );
        assert.equal(await host.locator("mark,s").count(), 0);
        assert.equal(await host.innerText(), "%%hello%%");
        await p.evaluate(() => {
            CoCreate.editor.updateSyntax("test-rule", {
                tag: "s",
                markdown: {
                    pattern: /%%(.+?)%%/g,
                    content: (m) => m[1],
                    offset: () => 2
                }
            });
            window.remove();
        });
        assert.equal(await host.locator("s").count(), 0);
    } finally {
        await p.close();
    }
});

test("configured Markdown block rules render and update without engine changes", async () => {
    const p = await page();
    try {
        const host = await editor(p, "!!! Custom block\n\nNormal");
        await p.evaluate(() =>
            CoCreate.editor.addSyntax({
                name: "callout",
                tag: "mark",
                markdown: {
                    scope: "block",
                    pattern: /^!!! (.*)$/,
                    content: (m) => m[1],
                    offset: () => 4
                }
            })
        );
        assert.equal(await host.locator("mark").innerText(), "Custom block");
        assert.match(await host.innerText(), /Normal/);
    } finally {
        await p.close();
    }
});

test("HTML mode supports native Enter, empty paired elements, and composition", async () => {
    const p = await page();
    try {
        const host = await editor(p, "<p>First</p>", "html");
        await p.evaluate(() =>
            CoCreate.editor.setSelection(document.querySelector("#editor"), 8)
        );
        await p.keyboard.press("Enter");
        await p.keyboard.type("Second");
        assert.equal(await value(p), "<p>First\nSecond</p>");
        await p.evaluate(() =>
            document.querySelector("#editor").setValue("<p></p>")
        );
        await p.evaluate(() =>
            CoCreate.editor.setSelection(document.querySelector("#editor"), 3)
        );
        await p.keyboard.type("X");
        assert.equal(await value(p), "<p>X</p>");
        const cdp = await p.context().newCDPSession(p);
        await cdp.send("Input.imeSetComposition", {
            text: "世界",
            selectionStart: 2,
            selectionEnd: 2
        });
        assert.equal(await value(p), "<p>X</p>");
        await cdp.send("Input.insertText", { text: "世界" });
        assert.equal(await value(p), "<p>X世界</p>");
        assert.equal(await host.innerText(), "X世界");
    } finally {
        await p.close();
    }
});

test("public rendering respects selected format and protected definitions reject overrides", async () => {
    const p = await page();
    try {
        const result = await p.evaluate(() => {
            const output = CoCreate.editor.render("<b>x</b> **y**", "html");
            const markdown = CoCreate.editor.render(
                "<b>x</b> **y**",
                "markdown"
            );
            let protectedCode = false;
            try {
                CoCreate.editor.addSyntax({
                    name: "override",
                    tag: "span",
                    html: { tags: ["code"] }
                });
            } catch {
                protectedCode = true;
            }
            return { output, markdown, protectedCode };
        });
        assert.match(result.output, /<strong[^>]*>x<\/strong>/);
        assert.match(result.output, /\*\*y\*\*/);
        assert.match(result.markdown, /&lt;b&gt;x&lt;\/b&gt;/);
        assert.match(result.markdown, /<strong[^>]*>y<\/strong>/);
        assert.equal(result.protectedCode, true);
    } finally {
        await p.close();
    }
});

test("configuration updates during composition preserve the composing text", async () => {
    const p = await page();
    try {
        const host = await editor(p, "Hello ");
        await host.focus();
        await p.keyboard.press("End");
        const cdp = await p.context().newCDPSession(p);
        await cdp.send("Input.imeSetComposition", {
            text: "世界",
            selectionStart: 2,
            selectionEnd: 2
        });
        await p.evaluate(() =>
            CoCreate.editor.addSyntax({
                name: "html-reference",
                tag: "mark",
                html: { tags: ["reference"] }
            })
        );
        assert.equal(await host.innerText(), "Hello 世界");
        await cdp.send("Input.insertText", { text: "世界" });
        assert.equal(await value(p), "Hello 世界");
    } finally {
        await p.close();
    }
});

test("Enter inside an unfinished HTML tag or attribute stays source text until completion", async () => {
    const p = await page();
    try {
        const host = await editor(p, '<p title="hello', "html");
        await host.focus();
        await p.keyboard.press("End");
        await p.keyboard.press("Enter");
        assert.equal(await value(p), '<p title="hello\n');
        assert.equal(await host.locator("p").count(), 0);
        await p.keyboard.type('world">Text</p>');
        assert.equal(await value(p), '<p title="hello\nworld">Text</p>');
        assert.equal(
            await host.locator("p").getAttribute("title"),
            "hello\nworld"
        );
        assert.equal(await host.locator("p").innerText(), "Text");
        await p.evaluate(() =>
            document.querySelector("#editor").setValue("<strong")
        );
        await host.focus();
        await p.keyboard.press("End");
        await p.keyboard.press("Enter");
        await p.keyboard.type(">Hello</strong>");
        assert.equal(await value(p), "<strong\n>Hello</strong>");
        assert.equal(await host.locator("strong").innerText(), "Hello");
    } finally {
        await p.close();
    }
});

test("Markdown Enter remains a source newline and blank lines delimit paragraphs", async () => {
    const p = await page();
    try {
        const host = await editor(p, "**hello");
        await host.focus();
        await p.keyboard.press("End");
        await p.keyboard.press("Enter");
        assert.equal(await value(p), "**hello\n");
        assert.equal(await host.locator("strong").count(), 0);
        await p.keyboard.type("world**");
        assert.equal(await value(p), "**hello\nworld**");
        assert.equal(await host.locator("strong").innerText(), "hello\nworld");
        await p.evaluate(() =>
            document.querySelector("#editor").setValue("One\n\nTwo")
        );
        assert.equal(await host.locator("p").count(), 2);
    } finally {
        await p.close();
    }
});

test("HTML literal bodies retain Enter as a string and explicit br remains distinct source syntax", async () => {
    const p = await page();
    try {
        const source = "<pre>code</pre>",
            host = await editor(p, source, "html");
        await p.evaluate(() =>
            CoCreate.editor.setSelection(document.querySelector("#editor"), 9)
        );
        await p.keyboard.press("Enter");
        await p.keyboard.type("<b>raw</b>");
        assert.equal(await value(p), "<pre>code\n<b>raw</b></pre>");
        assert.equal(await host.locator("strong,b").count(), 0);
        await p.evaluate(() =>
            document.querySelector("#editor").setValue("<p>A<br>B</p>")
        );
        assert.equal(await value(p), "<p>A<br>B</p>");
        assert.equal(await host.locator("br[data-source-void]").count(), 1);
    } finally {
        await p.close();
    }
});

test("contenteditable defaults to literal text and explicit editor modes switch without converting source", async () => {
    const p = await page();
    try {
        await p.evaluate(async () => {
            const e = document.createElement("div");
            e.id = "plain";
            e.contentEditable = "true";
            e.textContent = "**bold** <b>HTML</b>";
            document.body.append(e);
            await CoCreate.editor.create(e);
        });
        assert.equal(await p.locator("#plain strong, #plain b").count(), 0);
        await p.locator("#plain").press("End");
        await p.locator("#plain").press("Enter");
        await p.locator("#plain").pressSequentially("tail");
        assert.equal(
            await p.evaluate(() => document.querySelector("#plain").getValue()),
            "**bold** <b>HTML</b>\ntail"
        );
        await p.evaluate(() =>
            document.querySelector("#plain").setAttribute("editor", "markdown")
        );
        await p.waitForSelector("#plain strong");
        assert.equal(
            await p.evaluate(() => document.querySelector("#plain").getValue()),
            "**bold** <b>HTML</b>\ntail"
        );
    } finally {
        await p.close();
    }
});

test("native adapters preserve form reset, exact text, selection and ordinary unbound fields", async () => {
    const p = await page();
    try {
        await p.evaluate(async () => {
            document.body.insertAdjacentHTML(
                "beforeend",
                '<form id="form"><input id="ordinary" value="ordinary"><textarea id="native" editor="text">initial</textarea><input id="number" type="number" crdt="true"></form>'
            );
            await CoCreate.editor.create(document.querySelector("#native"));
        });
        await p.locator("#native").fill("**literal**\n<b>code</b>");
        assert.deepEqual(
            await p.evaluate(async () => {
                const e = document.querySelector("#native");
                await CoCreate.editor.setSelection(e, 2, 5);
                return {
                    value: e.getValue(),
                    selection: await CoCreate.editor.getSelection(e),
                    children: e.children.length,
                    ordinary:
                        !!document.querySelector("#ordinary").__cocreateEditor,
                    number: !!document.querySelector("#number").__cocreateEditor
                };
            }),
            {
                value: "**literal**\n<b>code</b>",
                selection: {
                    anchor: 2,
                    head: 5,
                    from: 2,
                    to: 5,
                    empty: false,
                    type: "text"
                },
                children: 0,
                ordinary: false,
                number: false
            }
        );
        await p.evaluate(() => document.querySelector("#form").reset());
        assert.equal(await p.locator("#native").inputValue(), "initial");
        assert.equal(
            await p.evaluate(() =>
                document.querySelector("#native").getValue()
            ),
            "initial"
        );
    } finally {
        await p.close();
    }
});

async function collaborative(p, delay = false) {
    await p.evaluate((delay) => {
        const documents = new Map();
        window.sent = [];
        window.presence = [];
        window.historyCalls = [];
        window.remote = (key, string) => {
            documents.set(key, string);
            window.dispatchEvent(
                new CustomEvent("cocreate-crdt-update", {
                    detail: { array: "messages", object: "one", key, string }
                })
            );
        };
        CoCreate.editor.setCrdt({
            getText: (data) =>
                delay
                    ? new Promise(
                          (resolve) =>
                              (window.loadEditor = () => {
                                  documents.set(data.key, "remote");
                                  resolve("remote");
                              })
                      )
                    : Promise.resolve(documents.get(data.key) || ""),
            async updateText(data) {
                await Promise.resolve();
                data = { ...data };
                const before = documents.get(data.key) || "";
                const string = CoCreate.editor.applySourceChange(before, data);
                documents.set(data.key, string);
                window.sent.push({
                    start: data.start,
                    length: data.length,
                    value: data.value
                });
                window.dispatchEvent(
                    new CustomEvent("cocreate-crdt-update", {
                        detail: { ...data, string }
                    })
                );
            },
            undoText: (data) => window.historyCalls.push("undo"),
            redoText: (data) => window.historyCalls.push("redo"),
            updateSelection: (data) => window.presence.push(data.selection)
        });
        window.makeShared = (tag, id, mode) => {
            const e = document.createElement(tag);
            e.id = id;
            e.setAttribute("array", "messages");
            e.setAttribute("object", "one");
            e.setAttribute("key", "body");
            e.setAttribute("crdt", "true");
            if (mode) e.setAttribute("editor", mode);
            document.body.append(e);
            return e;
        };
    }, delay);
}

test("CRDT shares canonical source across native and rendered fields without echoing remote updates", async () => {
    const p = await page();
    try {
        await collaborative(p);
        await p.evaluate(async () => {
            await CoCreate.editor.create(makeShared("textarea", "native"));
            await CoCreate.editor.create(
                makeShared("div", "rendered", "markdown")
            );
        });
        await p.locator("#native").fill("**shared**");
        await p.waitForSelector("#rendered strong");
        assert.equal(
            await p.evaluate(() =>
                document.querySelector("#rendered").getValue()
            ),
            "**shared**"
        );
        assert.equal(await p.evaluate(() => sent.length), 1);
        await p.evaluate(() => remote("body", "**remote**"));
        assert.equal(await p.locator("#native").inputValue(), "**remote**");
        assert.equal(await p.locator("#rendered strong").innerText(), "remote");
        assert.equal(await p.evaluate(() => sent.length), 1);
        await p.locator("#rendered").press("Control+z");
        await p.waitForFunction(() => historyCalls.length === 1);
        assert.equal(await p.evaluate(() => historyCalls[0]), "undo");
        await p.evaluate(() =>
            document.querySelector("#native").setValue("programmatic")
        );
        await p.waitForFunction(() => sent.length === 2);
        assert.equal(
            await p.evaluate(() =>
                document.querySelector("#rendered").getValue()
            ),
            "programmatic"
        );
    } finally {
        await p.close();
    }
});

test("CRDT load rebases edits made while canonical source is being fetched", async () => {
    const p = await page();
    try {
        await collaborative(p, true);
        await p.evaluate(() => {
            makeShared("textarea", "native");
        });
        await p.waitForFunction(() => typeof loadEditor === "function");
        await p.locator("#native").fill("local");
        await p.evaluate(() => loadEditor());
        await p.waitForFunction(() => sent.length === 1);
        assert.equal(await p.locator("#native").inputValue(), "remotelocal");
        assert.deepEqual(await p.evaluate(() => sent[0]), {
            start: 6,
            length: 0,
            value: "local"
        });
    } finally {
        await p.close();
    }
});

test("changing CRDT identity detaches old field updates and disabling CRDT keeps local editing", async () => {
    const p = await page();
    try {
        await collaborative(p);
        await p.evaluate(async () => {
            await CoCreate.editor.create(makeShared("textarea", "native"));
        });
        await p.evaluate(() =>
            document.querySelector("#native").setAttribute("key", "other")
        );
        await p.waitForTimeout(30);
        await p.evaluate(() => remote("body", "old field"));
        assert.equal(await p.locator("#native").inputValue(), "");
        await p.evaluate(() =>
            document.querySelector("#native").setAttribute("crdt", "false")
        );
        await p.waitForTimeout(30);
        await p.locator("#native").fill("local only");
        assert.equal(await p.evaluate(() => sent.length), 0);
        assert.equal(await p.locator("#native").inputValue(), "local only");
    } finally {
        await p.close();
    }
});

test("real CoCreate CRDT engine synchronizes source, remote operations and collaborative undo", async () => {
    const p = await page();
    try {
        const enginePath = path.dirname(require.resolve("@cocreate/crdt"));
        const source = ["sequence.js", "selection.js", "runs.js", "index.js"]
            .map((name) => {
                return fs
                    .readFileSync(path.join(enginePath, name), "utf8")
                    .replace(/^import .*;\r?\n/gm, "")
                    .replace(/^export default (.*);/m, "const api = $1;")
                    .replace(/^export /gm, "");
            })
            .join("\n");
        await p.evaluate((source) => {
            let counter = 0;
            const listeners = {};
            window.enginePackets = [];
            const crud = {
                socket: {
                    clientId: "local",
                    frameId: "local",
                    listen: (name, fn) => (listeners[name] = fn),
                    send: (packet) =>
                        enginePackets.push(structuredClone(packet))
                },
                send: async () => ({ object: [] }),
                getValueFromObject: (object, key) => object?.[key]
            };
            const engine = new Function(
                "crud",
                "ulid",
                "ulidDecode",
                "localStorage",
                "window",
                source + "\nreturn api;"
            )(
                crud,
                () => String(++counter).padStart(26, "0"),
                (id) => Number(id.slice(0, 10)),
                { getItem: () => "user" },
                window
            );
            window.realEngine = engine;
            window.receiveEngine = (data) => listeners.crdt({ data });
            CoCreate.editor.setCrdt(engine);
            window.sharedField = {
                array: "notes",
                object: "one",
                key: "body",
                read: "false",
                crud: "false",
                save: "false"
            };
            for (const [tag, id, mode] of [
                ["textarea", "native", "text"],
                ["div", "rendered", "html"]
            ]) {
                const e = document.createElement(tag);
                e.id = id;
                e.setAttribute("editor", mode);
                e.setAttribute("crdt", "true");
                for (const [key, value] of Object.entries(sharedField))
                    e.setAttribute(key, value);
                document.body.append(e);
            }
        }, source);
        await p.waitForFunction(
            () => document.querySelector("#rendered").__cocreateEditor?.history
        );
        await p.locator("#native").fill("<p>A &amp; B</p>");
        await p.waitForSelector("#rendered p");
        assert.equal(await p.locator("#rendered p").innerText(), "A & B");
        assert.equal(
            await p.evaluate(() => realEngine.getText(sharedField)),
            "<p>A &amp; B</p>"
        );
        await p.locator("#native").press("Control+z");
        await p.waitForFunction(
            () => document.querySelector("#native").value === ""
        );
        await p.locator("#native").press("Control+Shift+z");
        await p.waitForFunction(
            () => document.querySelector("#native").value === "<p>A &amp; B</p>"
        );
        await p.evaluate(() =>
            receiveEngine({
                ...sharedField,
                frameId: "peer",
                clientId: "peer",
                id: "00000000000000000000000099",
                start: 3,
                length: 1,
                value: "Remote"
            })
        );
        await p.waitForFunction(
            () =>
                document.querySelector("#native").value ===
                "<p>Remote &amp; B</p>"
        );
        assert.equal(await p.locator("#rendered p").innerText(), "Remote & B");
        assert.equal(
            await p.evaluate(
                () =>
                    enginePackets.filter(
                        (packet) => packet.data.type !== "selection"
                    ).length
            ),
            3
        );
    } finally {
        await p.close();
    }
});

test("a remote update rebases a local operation before asynchronous engine application", async () => {
    const p = await page();
    try {
        await collaborative(p);
        await p.evaluate(async () => {
            await CoCreate.editor.create(makeShared("textarea", "native"));
        });
        await p.evaluate(() => {
            const e = document.querySelector("#native");
            e.value = "A";
            e.dispatchEvent(new Event("input", { bubbles: true }));
            remote("body", "R");
        });
        await p.waitForFunction(() => sent.length === 1);
        assert.equal(await p.locator("#native").inputValue(), "RA");
        assert.deepEqual(await p.evaluate(() => sent[0]), {
            start: 1,
            length: 0,
            value: "A"
        });
    } finally {
        await p.close();
    }
});

test("disabling an implicit contenteditable host stays disabled without reinitialization", async () => {
    const p = await page();
    try {
        await p.evaluate(async () => {
            const e = document.createElement("div");
            e.id = "implicit";
            e.contentEditable = "true";
            e.textContent = "plain";
            document.body.append(e);
            await CoCreate.editor.create(e);
            e.contentEditable = "false";
        });
        await p.waitForFunction(
            () => !document.querySelector("#implicit").__cocreateEditor
        );
        assert.equal(
            await p.locator("#implicit").getAttribute("contenteditable"),
            "false"
        );
        assert.equal(await p.locator("#implicit").getAttribute("class"), "");
    } finally {
        await p.close();
    }
});

test("iframe contenteditable hosts initialize with an inner HTML editing surface", async () => {
    const p = await page();
    try {
        await p.evaluate(() => {
            const frame = document.createElement("iframe");
            frame.id = "builder";
            frame.setAttribute("contenteditable", "true");
            frame.setAttribute("crdt", "true");
            document.body.append(frame);
        });
        await p.waitForTimeout(40);
        assert.deepEqual(
            await p.evaluate(() => {
                const frame = document.querySelector("#builder");
                return {
                    claimed: !!frame.__cocreateEditor,
                    className: frame.className,
                    editable: frame.getAttribute("contenteditable"),
                    accessible: !!frame.contentDocument.body
                };
            }),
            {
                claimed: true,
                className: "",
                editable: "true",
                accessible: true
            }
        );
    } finally {
        await p.close();
    }
});

test("initial local text seeds an empty CRDT document before edits made during loading", async () => {
    const p = await page();
    try {
        await collaborative(p);
        await p.evaluate(async () => {
            const e = makeShared("textarea", "native");
            e.value = "initial";
            await CoCreate.editor.create(e);
        });
        await p.waitForFunction(() => sent.length === 1);
        assert.equal(await p.locator("#native").inputValue(), "initial");
        assert.deepEqual(await p.evaluate(() => sent[0]), {
            start: 0,
            length: 0,
            value: "initial"
        });
    } finally {
        await p.close();
    }
});

async function frameEditor(p, source) {
    await p.evaluate(async (source) => {
        const frame = document.createElement("iframe");
        frame.id = "document-editor";
        frame.setAttribute("editor", "html");
        frame.srcdoc = source;
        document.body.append(frame);
        await CoCreate.editor.create(frame);
    }, source);
    return p.frameLocator("#document-editor");
}

test("iframe uses Document with html/head/body and preserves exact source and doctype", async () => {
    const p = await page();
    const source =
        '<!DOCTYPE html>\n<html lang="en"><head><title>Builder</title><meta charset="utf-8"></head><body><main id="main"><p>Hello &amp; world</p></main></body></html>';
    try {
        const frame = await frameEditor(p, source);
        assert.equal(
            await frame.locator("html").getAttribute("contenteditable"),
            "true"
        );
        assert.equal(await frame.locator("p").innerText(), "Hello & world");
        assert.deepEqual(
            await p.evaluate(async () => {
                const e = document.querySelector("#document-editor"),
                    editor = await CoCreate.editor.create(e);
                return {
                    source: e.getValue(),
                    sameDocument: editor.document === e.contentDocument,
                    host: editor.host === e.contentDocument.documentElement,
                    doctype: e.contentDocument.doctype.name,
                    title: e.contentDocument.title
                };
            }),
            {
                source,
                sameDocument: true,
                host: true,
                doctype: "html",
                title: "Builder"
            }
        );
        await frame.locator("p").click();
        await p.keyboard.press("End");
        await p.keyboard.type("!");
        assert.equal(
            await p.evaluate(() =>
                document.querySelector("#document-editor").getValue()
            ),
            source.replace("world", "world!")
        );
        assert.equal(await frame.locator("title").textContent(), "Builder");
    } finally {
        await p.close();
    }
});

test("iframe selections use full source offsets and inner input publishes once on outer reference", async () => {
    const p = await page();
    const source =
        "<!doctype html><html><head><title>Hidden</title></head><body><p>A &amp; B</p><p>Keep</p></body></html>";
    try {
        await frameEditor(p, source);
        await p.evaluate(async (source) => {
            const e = document.querySelector("#document-editor");
            window.frameInputs = 0;
            e.addEventListener("input", () => frameInputs++);
            window.keptParagraph = e.contentDocument.querySelectorAll("p")[1];
            await CoCreate.editor.setSelection(
                e,
                source.indexOf("&amp;"),
                source.indexOf("&amp;") + 5
            );
        }, source);
        await p.keyboard.insertText("and");
        assert.deepEqual(
            await p.evaluate(() => {
                const e = document.querySelector("#document-editor");
                return {
                    source: e.getValue(),
                    inputs: frameInputs,
                    same:
                        e.contentDocument.querySelectorAll("p")[1] ===
                        keptParagraph
                };
            }),
            { source: source.replace("&amp;", "and"), inputs: 1, same: true }
        );
    } finally {
        await p.close();
    }
});

test("void elements without slash do not consume following siblings and preserve source spelling", async () => {
    const p = await page();
    const source =
        '<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet"></head><body><p>A<br>B<img alt="picture">C<input value="field">D<wbr>E<hr>F</p></body></html>';
    try {
        const frame = await frameEditor(p, source);
        assert.equal(
            await frame
                .locator("p > br, p > img, p > input, p > wbr, p > hr")
                .count(),
            5
        );
        assert.equal(
            await p.evaluate(() =>
                document.querySelector("#document-editor").getValue()
            ),
            source
        );
        await p.evaluate(async () => {
            const e = document.querySelector("#document-editor"),
                source = e.getValue();
            await CoCreate.editor.replaceRange(e, "Z", {
                from: source.indexOf("C<input"),
                to: source.indexOf("C<input") + 1
            });
        });
        assert.equal(
            await p.evaluate(() =>
                document.querySelector("#document-editor").getValue()
            ),
            source.replace("C<input", "Z<input")
        );
    } finally {
        await p.close();
    }
});

test("iframe load replaces its document and remounts the current canonical source", async () => {
    const p = await page();
    try {
        const frame = await frameEditor(
            p,
            "<!doctype html><html><head></head><body><p>Original</p></body></html>"
        );
        await p.evaluate(() => {
            const e = document.querySelector("#document-editor");
            window.oldDocument = e.contentDocument;
            e.setValue(
                "<!doctype html><html><head><title>Saved</title></head><body><p>Current</p></body></html>"
            );
            e.srcdoc = "<html><body>replacement document</body></html>";
        });
        await p.waitForFunction(() => {
            const e = document.querySelector("#document-editor");
            return (
                e.contentDocument !== oldDocument &&
                e.contentDocument.querySelector("p")?.textContent === "Current"
            );
        });
        await frame.locator("p").click();
        await p.keyboard.press("End");
        await p.keyboard.type("!");
        assert.equal(
            await p.evaluate(() =>
                document.querySelector("#document-editor").getValue()
            ),
            "<!doctype html><html><head><title>Saved</title></head><body><p>Current!</p></body></html>"
        );
        await p.evaluate(() =>
            CoCreate.editor.destroy(document.querySelector("#document-editor"))
        );
        assert.equal(await frame.locator("p").innerText(), "Current!");
        assert.equal(
            await frame.locator("html").getAttribute("contenteditable"),
            null
        );
    } finally {
        await p.close();
    }
});

test("iframe and textarea synchronize full HTML source using the existing CRDT binding", async () => {
    const p = await page();
    try {
        await collaborative(p);
        await p.evaluate(async () => {
            const frame = makeShared("iframe", "document-editor", "html");
            await CoCreate.editor.create(frame);
            await CoCreate.editor.create(makeShared("textarea", "native"));
        });
        const source =
            "<!doctype html><html><head><title>Shared</title></head><body><p>Hello</p></body></html>";
        await p.locator("#native").fill(source);
        const frame = p.frameLocator("#document-editor");
        await frame.locator("p").waitFor();
        await frame.locator("p").click();
        await p.keyboard.press("End");
        await p.keyboard.insertText("!");
        await p.waitForFunction(
            (source) =>
                document.querySelector("#native").value ===
                source.replace("Hello", "Hello!"),
            source
        );
        assert.equal(await frame.locator("title").textContent(), "Shared");
        await p.evaluate(() =>
            remote(
                "body",
                "<!doctype html><html><head></head><body><p>Remote</p></body></html>"
            )
        );
        assert.equal(await frame.locator("p").innerText(), "Remote");
        assert.equal(
            await p.evaluate(() =>
                document.querySelector("#document-editor").getValue()
            ),
            "<!doctype html><html><head></head><body><p>Remote</p></body></html>"
        );
    } finally {
        await p.close();
    }
});

test("iframe source writes during initial load win and destroy retains the live document", async () => {
    const p = await page();
    try {
        await p.evaluate(async () => {
            const frame = document.createElement("iframe");
            frame.id = "document-editor";
            frame.srcdoc =
                "<!doctype html><html><body><p>Old</p></body></html>";
            frame.setAttribute("editor", "html");
            document.body.append(frame);
            const ready = CoCreate.editor.create(frame);
            frame.setValue(
                "<!DOCTYPE html><html><head></head><body><p>New</p></body></html>"
            );
            await ready;
        });
        const frame = p.frameLocator("#document-editor");
        assert.equal(await frame.locator("p").innerText(), "New");
        await p.evaluate(() =>
            CoCreate.editor.destroy(document.querySelector("#document-editor"))
        );
        assert.equal(await frame.locator("p").innerText(), "New");
        assert.equal(
            await frame.locator("html").getAttribute("contenteditable"),
            null
        );
    } finally {
        await p.close();
    }
});

test("empty iframe body edits retain the head and doctype, and head entities display correctly", async () => {
    const p = await page();
    const source =
        "<!doctype html><html><head><title>A &amp; B</title></head><body></body></html>";
    try {
        const frame = await frameEditor(p, source);
        assert.equal(await frame.locator("title").textContent(), "A & B");
        await p.evaluate(async (source) => {
            await CoCreate.editor.setSelection(
                document.querySelector("#document-editor"),
                source.indexOf("</body>")
            );
        }, source);
        await p.keyboard.insertText("Hello");
        assert.equal(
            await p.evaluate(() =>
                document.querySelector("#document-editor").getValue()
            ),
            source.replace("<body></body>", "<body>Hello</body>")
        );
        assert.equal(
            await p.evaluate(
                () =>
                    document.querySelector("#document-editor").contentDocument
                        .doctype.name
            ),
            "html"
        );
    } finally {
        await p.close();
    }
});

test("native controls within an iframe keep typing and paste outside document source editing", async () => {
    const p = await page();
    const source =
        '<!doctype html><html><head></head><body><input value="initial"><textarea>initial</textarea><p>Document</p></body></html>';
    try {
        const frame = await frameEditor(p, source);
        await frame.locator("input").fill("field value");
        await frame.locator("textarea").fill("native text");
        assert.equal(await frame.locator("input").inputValue(), "field value");
        assert.equal(
            await frame.locator("textarea").inputValue(),
            "native text"
        );
        assert.equal(
            await p.evaluate(() =>
                document.querySelector("#document-editor").getValue()
            ),
            source
        );
        const prevented = await frame
            .locator("textarea")
            .evaluate((element) => {
                const event = new ClipboardEvent("paste", {
                    bubbles: true,
                    cancelable: true
                });
                element.dispatchEvent(event);
                return event.defaultPrevented;
            });
        assert.equal(prevented, false);
    } finally {
        await p.close();
    }
});

test("nested contenteditable input stays live while page source and staging stay unchanged", async () => {
    const p = await page();
    const source =
        '<!doctype html><html><head></head><body><div id="field" contenteditable="true" array="messages" object="one" key="field">Field</div><p>Page</p></body></html>';
    try {
        const frame = await frameEditor(p, source);
        await frame.locator("#field").click();
        await p.keyboard.press("End");
        await p.keyboard.insertText("!");
        assert.equal(await frame.locator("#field").innerText(), "Field!");
        assert.equal(
            await p.evaluate(() =>
                document.querySelector("#document-editor").getValue()
            ),
            source
        );
        assert.deepEqual(
            await p.evaluate(async () => {
                const e = document.querySelector("#document-editor"),
                    editor = await CoCreate.editor.create(e),
                    skeleton = editor.staging();
                return {
                    liveInitialized:
                        !!e.contentDocument.querySelector("#field")
                            .__cocreateEditor,
                    detached:
                        !skeleton.defaultView &&
                        skeleton !== e.contentDocument &&
                        !e.contentDocument.contains(skeleton.documentElement),
                    field: skeleton.querySelector("#field").textContent,
                    initialized:
                        !!skeleton.querySelector("#field").__cocreateEditor
                };
            }),
            {
                liveInitialized: false,
                detached: true,
                field: "Field",
                initialized: false
            }
        );
        await frame.locator("p").click();
        await p.keyboard.press("End");
        await p.keyboard.insertText("!");
        assert.equal(
            await p.evaluate(() =>
                document.querySelector("#document-editor").getValue()
            ),
            source.replace("Page", "Page!")
        );
        assert.equal(await frame.locator("#field").innerText(), "Field!");
        await p.evaluate(() =>
            CoCreate.editor.heal(document.querySelector("#document-editor"))
        );
        assert.equal(await frame.locator("#field").innerText(), "Field!");
    } finally {
        await p.close();
    }
});

test("nested contenteditable paste, composition and undo are left to their own surface", async () => {
    const p = await page();
    const source =
        '<!doctype html><html><head></head><body><div id="field" contenteditable="true">Field</div><p>Page</p></body></html>';
    try {
        const frame = await frameEditor(p, source);
        const result = await frame.locator("#field").evaluate((element) => {
            const view = element.ownerDocument.defaultView;
            const transfer = new view.DataTransfer();
            transfer.setData("text/plain", "paste");
            const paste = new view.ClipboardEvent("paste", {
                bubbles: true,
                cancelable: true,
                clipboardData: transfer
            });
            element.dispatchEvent(paste);
            const undo = new view.KeyboardEvent("keydown", {
                bubbles: true,
                cancelable: true,
                ctrlKey: true,
                key: "z"
            });
            element.dispatchEvent(undo);
            element.dispatchEvent(
                new view.CompositionEvent("compositionstart", { bubbles: true })
            );
            element.textContent = "Independent";
            element.dispatchEvent(
                new view.InputEvent("input", {
                    bubbles: true,
                    isComposing: true
                })
            );
            element.dispatchEvent(
                new view.CompositionEvent("compositionend", { bubbles: true })
            );
            return {
                paste: paste.defaultPrevented,
                undo: undo.defaultPrevented
            };
        });
        assert.deepEqual(result, { paste: false, undo: false });
        await p.evaluate(() =>
            CoCreate.editor.heal(document.querySelector("#document-editor"))
        );
        assert.equal(await frame.locator("#field").innerText(), "Independent");
        assert.equal(
            await p.evaluate(() =>
                document.querySelector("#document-editor").getValue()
            ),
            source
        );
    } finally {
        await p.close();
    }
});

test("page source updates preserve independent contenteditable nodes and their live handlers", async () => {
    const p = await page();
    const source =
        '<!doctype html><html><head></head><body><div id="field" contenteditable="true">Field</div></body></html>';
    try {
        const frame = await frameEditor(p, source);
        await p.evaluate(() => {
            const e = document.querySelector("#document-editor");
            window.nestedReference = e.contentDocument.querySelector("#field");
            window.fieldClicks = 0;
            nestedReference.textContent = "Live field";
            nestedReference.addEventListener("click", () => fieldClicks++);
            e.setValue(e.getValue().replace("<body>", "<body><p>Inserted</p>"));
        });
        await frame.locator("#field").click();
        assert.deepEqual(
            await p.evaluate(() => ({
                same:
                    document
                        .querySelector("#document-editor")
                        .contentDocument.querySelector("#field") ===
                    nestedReference,
                clicks: fieldClicks
            })),
            { same: true, clicks: 1 }
        );
        assert.equal(await frame.locator("#field").innerText(), "Live field");
    } finally {
        await p.close();
    }
});
