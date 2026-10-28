const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const root = path.resolve(__dirname, '../..');

async function startBrowser({ bundle = false } = {}) {
    let bundleDirectory;
    if (bundle) {
        bundleDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-browser-tests-'));
        const configure = (await import(pathToFileURL(path.join(root, 'webpack.config.js')).href)).default;
        const config = await configure({}, { mode: 'production' });
        config.output.path = bundleDirectory;
        config.devtool = false;
        config.plugins = config.plugins.filter(plugin => plugin.constructor.name !== 'FileUploader');
        const compiler = require('webpack')(config);
        try {
            await new Promise((resolve, reject) => compiler.run((error, stats) => {
                if (error) return reject(error);
                if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
                resolve();
            }));
        } finally {
            await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
        }
    }
    const server = http.createServer((request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (pathname === '/api/ping') return response.writeHead(204, { Date: new Date().toUTCString() }).end();
        if (pathname === '/') {
            response.setHeader('Content-Type', 'text/html');
            return response.end('<!doctype html><body></body>');
        }
        const directory = bundle ? bundleDirectory : path.join(root, 'src');
        const file = path.resolve(directory, '.' + pathname);
        if (!file.startsWith(directory + '/') || !fs.existsSync(file) || !fs.statSync(file).isFile())
            return response.writeHead(404).end();
        response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'application/javascript');
        response.end(fs.readFileSync(file));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    try {
        browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
            ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
    } catch (error) {
        await new Promise(resolve => server.close(resolve));
        if (bundleDirectory) fs.rmSync(bundleDirectory, { recursive: true, force: true });
        throw error;
    }
    return {
        async run(callback, { markup } = {}) {
            const page = await browser.newPage();
            page.setDefaultTimeout(5000);
            const errors = [];
            const requests = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('request', request => requests.push(new URL(request.url()).pathname));
            page.on('response', response => {
                if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
            });
            let timeout;
            try {
                await page.goto(origin);
                if (markup) await page.setContent(markup);
                if (bundle) await page.addScriptTag({ url: origin + '/CoCreate-editor.min.js' });
                await Promise.race([
                    callback(page, requests),
                    new Promise((_, reject) => {
                        timeout = setTimeout(() => reject(new Error('Browser scenario exceeded 15 seconds')), 15000);
                    })
                ]);
                assert.deepEqual(errors, [], 'browser fixture must load without module or runtime errors');
            } finally {
                clearTimeout(timeout);
                await page.close();
            }
        },
        async close() {
            await browser?.close();
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            if (bundleDirectory) fs.rmSync(bundleDirectory, { recursive: true, force: true });
        }
    };
}
module.exports = { startBrowser };
