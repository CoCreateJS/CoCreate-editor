const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=path.resolve(__dirname,'../dist');
let browser,server,base;
before(async()=>{
    server=http.createServer((req,res)=>{
        const url=new URL(req.url,'http://localhost');
        if(url.pathname==='/') {res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><link rel="stylesheet" href="/CoCreate-markdown.css"></head><body><script src="/CoCreate-markdown.js"></script></body></html>');return;}
        const file=path.resolve(root,'.'+url.pathname);
        if(!file.startsWith(root+'/')) {res.writeHead(403).end();return;}
        fs.readFile(file,(err,data)=>{if(err){res.writeHead(404).end();return;}
            res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');res.end(data);});
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    base=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true,args:['--no-sandbox'],
        ...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server.close(resolve));});
async function page(){const p=await browser.newPage();await p.goto(base);await p.waitForFunction(()=>CoCreate.markdown?.create);return p;}

test('component initial value uses Element Prototype, then Markdown owns getValue/setValue',async()=>{
    const p=await page();
    try {
        const initial=await p.evaluate(()=>{
            const host=document.createElement('div');host.id='editor';host.setAttribute('component','');
            host.setValue('**Initial**');
            const before={markup:host.innerHTML,attribute:host.getAttribute('value'),value:host.getValue()};
            host.setAttribute('markdown','');document.body.append(host);return before;
        });
        assert.deepEqual(initial,{markup:'',attribute:null,value:'**Initial**'});
        await p.waitForSelector('#editor .ProseMirror');
        assert.match(await p.locator('#editor .ProseMirror').innerHTML(),/<strong>Initial<\/strong>/);
        await p.evaluate(()=>document.querySelector('#editor').setValue('**Updated**'));
        assert.match(await p.locator('#editor .ProseMirror').innerHTML(),/<strong>Updated<\/strong>/);
        await p.locator('#editor .ProseMirror').fill('Typed');
        assert.match(await p.evaluate(()=>document.querySelector('#editor').getValue()),/Typed/);
        assert.equal(await p.locator('#editor').getAttribute('value'),null);
    } finally {await p.close();}
});

test('textarea initializes itself and preserves the existing native value bridge',async()=>{
    const p=await page();
    try {
        await p.evaluate(()=>{
            const host=document.createElement('textarea');host.id='editor';host.value='Initial';
            host.setAttribute('markdown','');document.body.append(host);
        });
        await p.waitForSelector('.ProseMirror');
        await p.evaluate(()=>document.querySelector('#editor').setValue('Updated'));
        assert.match(await p.locator('.ProseMirror').innerText(),/Updated/);
        await p.locator('.ProseMirror').fill('Typed');
        assert.match(await p.evaluate(()=>document.querySelector('#editor').getValue()),/Typed/);
        assert.match(await p.evaluate(()=>Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').get.call(document.querySelector('#editor'))),/Typed/);
    } finally {await p.close();}
});

test('only the marked host initializes; query attributes do not target other elements',async()=>{
    const p=await page();
    try {
        await p.evaluate(()=>{
            const target=document.createElement('div');target.id='target';target.textContent='Own value';
            const unrelated=document.createElement('div');unrelated.id='unrelated';
            const control=document.createElement('span');control.setAttribute('markdown-query','$document #unrelated');
            document.body.append(target,unrelated,control);
            target.setAttribute('markdown-query','$document #unrelated');
            target.setAttribute('markdown','');
        });
        await p.waitForSelector('#target .ProseMirror');
        assert.equal(await p.locator('#unrelated .ProseMirror').count(),0);
        assert.equal(await p.locator('.ProseMirror').count(),1);
        assert.match(await p.locator('#target .ProseMirror').innerText(),/Own value/);
    } finally {await p.close();}
});

test('the built-in placeholder appears once, follows value changes, and can be disabled',async()=>{
    const p=await page();
    try {
        await p.evaluate(()=>{
            const host=document.createElement('div');host.id='editor';host.setAttribute('component','');
            host.setAttribute('placeholder','Message CoCreate AI…');host.setAttribute('markdown','');
            document.body.append(host);
        });
        await p.waitForSelector('#editor .ProseMirror');
        const count=()=>p.evaluate(()=>[...document.querySelectorAll('#editor *')].filter(node=>
            getComputedStyle(node,'::before').content.includes('Message CoCreate AI')).length);
        assert.equal(await p.locator('#editor .ProseMirror').count(),1);
        assert.equal(await count(),1);
        await p.locator('#editor .ProseMirror').fill('Typed');
        assert.equal(await count(),0);
        await p.evaluate(()=>document.querySelector('#editor').setValue(''));
        assert.equal(await count(),1);
        await p.evaluate(()=>{
            CoCreate.markdown.destroy(document.querySelector('#editor'));
            document.querySelector('#editor').remove();
            const host=document.createElement('div');host.id='editor';host.setAttribute('markdown','');
            host.setAttribute('placeholder','Message CoCreate AI…');host.setAttribute('markdown-placeholder','false');
            document.body.append(host);
        });
        await p.waitForSelector('#editor .ProseMirror');
        assert.equal(await count(),0);
    } finally {await p.close();}
});
