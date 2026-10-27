// Run: CHROMIUM_PATH=/path/to/chrome node benchmarks/dom-full-parse.cjs
// Fresh full-source details on every edit; no DOM rendering or reconciliation.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../src');
const inputFile = process.argv[2] ? path.resolve(process.argv[2]) : null;
const inputSource = inputFile ? fs.readFileSync(inputFile, 'utf8') : null;

async function main() {
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (pathname === '/') return res.end('<!doctype html><body></body>');
        const file = path.resolve(root, '.' + pathname);
        if (!file.startsWith(root + '/') || !fs.existsSync(file)) return res.writeHead(404).end();
        res.setHeader('Content-Type', 'application/javascript');
        res.end(fs.readFileSync(file));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    const results = [];
    try {
        browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
            ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
        const targets = inputFile ? [inputSource.length] :
            [10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000];
        for (const target of targets) {
            const page = await browser.newPage();
            await page.goto(`http://127.0.0.1:${server.address().port}`);
            const result = await page.evaluate(async ({ target, inputSource }) => {
                const { parseDOM } = await import('/prototype/editors/parsers/dom.js');
                const block = i => `<section class="card  padded"  data-id="${i}">\n` +
                    `  <h3 title="Card ${i}">Heading ${i}</h3>\n` +
                    '  <p>Some ordinary text with  spaces, &amp; entities, and <strong>nested content</strong>.</p>\n' +
                    '  <input type="text"  disabled><img src="example.png" alt="Example image">\n' +
                    '  <!-- retained source comment -->\n</section>\n';
                let initial;
                let textAt, attributeAt;
                if (inputSource !== null) {
                    initial = inputSource;
                    const seeded = parseDOM(initial, document.createElement('div'));
                    const textDetail = seeded.find(detail => detail.kind === 'text' && !detail.sourceOnly &&
                        detail.value.trim().length > 20);
                    const attributeDetail = seeded.find(detail => detail.kind === 'attribute' &&
                        /=(["']).+\1/.test(detail.value));
                    if (!textDetail || !attributeDetail) throw new Error('Input file needs a text node and a quoted attribute to benchmark edits.');
                    textAt = textDetail.getStart() + Math.floor(textDetail.value.length / 2);
                    attributeAt = attributeDetail.getStart() + attributeDetail.value.search(/=["']/) + 2;
                } else {
                    const blocks = [];
                    let size = 0;
                    while (size < target) { const value = block(blocks.length); blocks.push(value); size += value.length; }
                    // Keep malformed markup between otherwise complete sections.
                    const middle = Math.floor(blocks.length / 2);
                    blocks.splice(middle, 0, '<div class="broken"  data-note="missing closing angle"\n');
                    initial = '<main>\n' + blocks.join('') + '</main>';
                    const brokenAt = initial.indexOf('<div class="broken"');
                    const completionAt = initial.indexOf('\n', brokenAt);
                    textAt = initial.indexOf('Some ordinary text', Math.floor(initial.length / 3)) + 5;
                    attributeAt = initial.indexOf('card  padded', Math.floor(initial.length / 3));
                }
                // Prepare cumulative edit states outside timing. For a supplied real
                // document, exercise content insertion and an attribute-value edit.
                const insert = (source, at, value) => source.slice(0, at) + value + source.slice(at);
                const sources = [insert(initial, textAt, 'A'), initial,
                    insert(initial, attributeAt, 'x'), initial,
                    insert(initial, textAt, 'B'), initial];
                const editor = document.createElement('div');
                let details;
                const validate = (records, source) => {
                    if (records.map(item => item.value).join('') !== source) throw new Error('Source round-trip failed');
                    const members = new Set(records);
                    for (const item of records) {
                        if (item.length !== item.value.length || item.length <= 0) throw new Error('Invalid cached length');
                        if (item.parentDetails && !members.has(item.parentDetails)) throw new Error('Invalid parent');
                        if (item.liveDOM || item.detachedDOM) throw new Error('Benchmark unexpectedly rendered nodes');
                    }
                };
                const coldStart = performance.now();
                details = parseDOM(initial, editor);
                const firstParseMs = performance.now() - coldStart;
                validate(details, initial);
                const detailCount = details.length;
                const elements = details.filter(item => item.kind === 'element').length;
                for (const source of sources) { details = parseDOM(source, editor); validate(details, source); }
                const samples = [];
                const iterations = target >= 1_000_000 ? 24 : 60;
                for (let i = 0; i < iterations; i++) {
                    const source = sources[i % sources.length];
                    const start = performance.now();
                    details = parseDOM(source, editor);
                    samples.push(performance.now() - start);
                }
                validate(details, sources[(iterations - 1) % sources.length]);
                const sorted = [...samples].sort((a, b) => a - b);
                const percentile = p => sorted[Math.ceil(sorted.length * p) - 1];
                return { targetBytes: target, sourceBytes: new TextEncoder().encode(initial).length,
                    sourceCharacters: initial.length, details: detailCount, elements, iterations,
                    firstParseMs, medianMs: percentile(0.5), p95Ms: percentile(0.95),
                    maxMs: sorted.at(-1), meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
                    over16ms: samples.filter(ms => ms > 16.7).length,
                    over50ms: samples.filter(ms => ms > 50).length, samplesMs: samples };
            }, { target, inputSource });
            assert.ok(result.details > 0);
            results.push(result);
            process.stderr.write(`${result.sourceBytes} bytes: median ${result.medianMs.toFixed(2)} ms, p95 ${result.p95Ms.toFixed(2)} ms\n`);
            await page.close();
        }
        process.stdout.write(JSON.stringify({ measuredAt: new Date().toISOString(),
            sourceFile: inputFile,
            browser: await browser.version(), node: process.version, cpu: os.cpus()[0].model,
            logicalCPUs: os.cpus().length, platform: `${os.platform()} ${os.arch()}`,
            scope: 'Current prototype parseDOM + fresh detail construction only; no DOM, diff, CRDT, or selection. Source preparation and validation excluded; variants checked before timing, final result checked afterward. Normal browser GC; previous result retained until replacement returns. ASCII fixture. Six warm-up parses per size.',
            results }, null, 2) + '\n');
    } finally {
        await browser?.close();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
