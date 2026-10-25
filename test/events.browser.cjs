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
        const url = new URL(req.url, 'http://localhost');
        res.setHeader('Content-Type', 'application/javascript');
        if (url.pathname === '/crdt.js') return res.end('export default {getText: async () => window.crdtText ?? "", updateText(data) {return window.processText(data)}, undoText(data) {return window.processText(data)}, redoText(data) {return window.processText(data)}, getSelection() {return window.cachedSelection}, async updateSelection(data) {if(window.selectionError) throw new Error("selection failed"); window.presence.push(data); return "reported"}}');
        if (url.pathname.endsWith('.css')) return res.end('');
        if (['/observer.js','/actions.js'].includes(url.pathname)) return res.end('export default {init() {}}');
        if (url.pathname === '/cursors.js') return res.end('export default {getPresence() {return {}}}');
        if (url.pathname === '/updateText') return res.end('export const insertAdjacentElement=()=>{},removeElement=()=>{},setInnerText=()=>{},setAttribute=()=>{},removeAttribute=()=>{},setClass=()=>{},setStyle=()=>{},replaceInnerText=()=>{};');
        if (url.pathname === '/updateDom') return res.end('export function updateDom(data) {window.renderUpdates.push(data)}');
        if (url.pathname === '/utils.js') return res.end('export const checkValue=()=>true; export const getAttributes = el => Object.fromEntries(["array","object","key"].map(name => [name,el.getAttribute(name)]));');
        if (url.pathname === '/utils-selection.js') return res.end('export function getSelectionRects() { return []; }');
        const file = path.resolve(root, '.' + url.pathname);
        if (!file.startsWith(root + '/') || !fs.existsSync(file)) return res.writeHead(404).end();
        res.end(fs.readFileSync(file, 'utf8').replaceAll('"@cocreate/crdt"', '"/crdt.js"').replaceAll('"@cocreate/utils/selection"', '"/utils-selection.js"').replaceAll('"@cocreate/utils"', '"/utils.js"').replaceAll('"@cocreate/observer"', '"/observer.js"').replaceAll('"@cocreate/actions"', '"/actions.js"').replaceAll('"@cocreate/cursors"', '"/cursors.js"').replace('import "@cocreate/element-prototype";', ''));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({headless:true, args:['--no-sandbox'], ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {})});
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });
async function fixture(run) {
    const page = await browser.newPage();
    try {
        await page.goto(origin + '/events.js');
        await page.evaluate(async origin => {
            const [{default:createEvents}, {default:createDOM}, {default:markdown}] = await Promise.all([
                import(origin+'/events.js'), import(origin+'/editors/dom.js'), import(origin+'/editors/markdown.js')
            ]);
            document.body.innerHTML='';
            window.operations=[]; window.presence=[]; window.positions=[]; window.renderUpdates=[];
            window.crdt=(await import('/crdt.js')).default;
            window.processText=data=>{operations.push(data)};
            window.bindMethods=element=>{
                for(const method of ['getText','updateText','replaceText','undoText','redoText','updateSelection','getSelection'])
                    element.editor[method]=data=>crdt[method]({...data,array:element.getAttribute('array'),object:element.getAttribute('object'),key:element.getAttribute('key')});
            };
            window.useBinding=async element=>{
                const module=await import('/index.js');
                bindMethods(element); element.editor.init=true;
                window.textAPI=module.default; window.publish=module.sendPosition;
            };
            window.applyText=(await import(origin+'/editors/text.js')).updateTextElement;
            window.receive=async (target,string,extra={})=>{
                await import(origin+'/index.js');
                window.dispatchEvent(new CustomEvent('cocreate-crdt-update',{detail:{elements:[target],string,value:string,start:0,length:0,...extra}}));
            };
            window.events=createEvents({updateText(data) { operations.push(data); }, sendPosition(el) { positions.push(el.id); }, clearPosition() {}});
            window.make=(tag, value, html, type) => {
                const el=document.createElement(tag); el.id='editor-'+document.querySelectorAll('[array]').length;
                for(const [key,val] of Object.entries({array:'test',object:'object',key:el.id,crdt:'true'})) el.setAttribute(key,val);
                el.editor={}; bindMethods(el); el.getValue=()=>el.value;
                if(tag==='input'||tag==='textarea') { el.value=value; el.defaultValue=value; }
                else {el.contentEditable='true'; el.innerHTML=html??value; el.value=value;}
                if(type) el.editor.dom=type==='dom'?createDOM(value,document):markdown(value);
                document.body.append(el); events.addEventListeners(el); el.focus();
                window.el=el;
                return el;
            };
            window.caret=(node,start,end=start) => { const s=node.ownerDocument.getSelection(); s.setBaseAndExtent(node,start,node,end); };
            window.edit=(target,inputType,data,range,cancelable=true) => {
                const event=new InputEvent('beforeinput',{bubbles:true,cancelable,inputType,data});
                if(range) Object.defineProperty(event,'getTargetRanges',{value:()=>[range]});
                target.dispatchEvent(event); return event.defaultPrevented;
            };
            window.result=()=>operations.map(({element,...data})=>({id:element.id,...data}));
        },origin);
        await run(page);
    } finally {await page.close();}
}

test('native typing and browser deletion produce one source operation apiece', () => fixture(async page => {
    await page.evaluate(()=>{make('textarea','abc'); el.setSelectionRange(1,2);});
    await page.keyboard.type('X');
    await page.keyboard.press('Delete');
    assert.deepEqual(await page.evaluate(()=>result().map(({start,end,value})=>({start,end,value}))),[
        {start:1,end:2,value:'X'},{start:2,end:3,value:''}
    ]);
}));
test('rich typing submits an atomic replacement without rendering or changing the source', () => fixture(async page => {
    const result=await page.evaluate(()=>{
        make('div','abcd'); caret(el.firstChild,1,3);
        const prevented=edit(el,'insertText','X');
        return {prevented,source:el.value,live:el.innerHTML,ops:result()};
    });
    assert.equal(result.prevented,true); assert.equal(result.source,'abcd'); assert.equal(result.live,'abcd');
    assert.deepEqual(result.ops.map(({start,end,value})=>({start,end,value})),[{start:1,end:3,value:'X'}]);
}));
test('rich mobile beforeinput handles Enter, grapheme deletion, and word deletion', () => fixture(async page => {
    const changes=await page.evaluate(()=>{
        make('div','👨‍👩‍👧‍👦'); caret(el.firstChild,el.firstChild.length); edit(el,'deleteContentBackward',null);
        make('div','hello world'); caret(el.firstChild,11); edit(el,'deleteWordBackward',null);
        make('div','abc'); caret(el.firstChild,1); edit(el,'insertParagraph',null);
        return result().map(({start,end,value})=>({start,end,value}));
    });
    assert.deepEqual(changes,[{start:0,end:11,value:''},{start:6,end:11,value:''},{start:1,end:1,value:'\n'}]);
}));
test('DOM and Markdown line-end insertion keeps the content source boundary', () => fixture(async page => {
    const changes=await page.evaluate(()=>{
        make('div','<p>abc</p><p>def</p>','<p>abc</p><p>def</p>','dom'); caret(el.firstChild.firstChild,3); edit(el,'insertText','X');
        make('div','# abc\n\ndef','<h1>abc</h1><p>def</p>','markdown'); caret(el.firstChild.firstChild,3); edit(el,'insertText','Y');
        return result().map(({start,end,value})=>({start,end,value}));
    });
    assert.deepEqual(changes,[{start:6,end:6,value:'X'},{start:5,end:5,value:'Y'}]);
}));
test('browser target ranges replace the autocorrect range without moving the selection', () => fixture(async page => {
    const outcome=await page.evaluate(()=>{
        make('div','<p>teh!</p>','<p>teh!</p>','dom'); const text=el.firstChild.firstChild; caret(text,4);
        const range=new StaticRange({startContainer:text,startOffset:0,endContainer:text,endOffset:3});
        edit(el,'insertReplacementText','the',range);
        return {ops:result(),offset:document.getSelection().anchorOffset};
    });
    assert.equal(outcome.offset,4);
    assert.deepEqual(outcome.ops.map(({start,end,value})=>({start,end,value})),[{start:3,end:6,value:'the'}]);
}));
for(const tag of ['textarea','div']) test(`${tag} composition commits once and ignores IME keyboard shortcuts`, () => fixture(async page => {
    const outcome=await page.evaluate(async tag=>{
        make(tag,'ab'); if(tag==='div') caret(el.firstChild,1); else el.setSelectionRange(1,1);
        el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
        const key=new KeyboardEvent('keydown',{key:'z',ctrlKey:true,isComposing:true,cancelable:true,bubbles:true}); el.dispatchEvent(key);
        if(tag==='div') el.firstChild.data='a語b'; else el.value='a語b';
        el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'語'}));
        const during=operations.length;
        el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'語'}));
        el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'語'}));
        await Promise.resolve();
        el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'語'}));
        return {during,keyPrevented:key.defaultPrevented,ops:result()};
    },tag);
    assert.equal(outcome.during,0); assert.equal(outcome.keyPrevented,false);
    assert.deepEqual(outcome.ops.map(({start,end,value})=>({start,end,value})),[{start:1,end:1,value:'語'}]);
}));
test('noncancelable browser input is reported after mutation', () => fixture(async page => {
    const changes=await page.evaluate(()=>{
        make('div','abc'); caret(el.firstChild,1,2); edit(el,'insertReplacementText','X',null,false);
        el.firstChild.data='aXc'; el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertReplacementText',data:'X'}));
        return result();
    });
    assert.deepEqual(changes.map(({start,end,value})=>({start,end,value})),[{start:1,end:2,value:'X'}]);
}));
test('keyboard and mobile history use CRDT; prevented shortcuts and AltGraph are respected', () => fixture(async page => {
    const changes=await page.evaluate(()=>{
        make('textarea','abc');
        for(const data of [{key:'z',ctrlKey:true},{key:'z',metaKey:true,shiftKey:true},{key:'y',ctrlKey:true},{key:'z',ctrlKey:true,altKey:true}])
            el.dispatchEvent(new KeyboardEvent('keydown',{...data,bubbles:true,cancelable:true}));
        edit(el,'historyUndo',null); edit(el,'historyRedo',null);
        const blocked=new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}); blocked.preventDefault(); el.dispatchEvent(blocked);
        return result().map(({undoRedo})=>undoRedo);
    });
    assert.deepEqual(changes,['undo','redo','redo','undo','redo']);
}));
test('nested editors and readonly user edits do not enter their parent operation stream', () => fixture(async page => {
    const changes=await page.evaluate(()=>{
        const parent=make('div','outer');
        const child=make('textarea','child'); parent.append(child); child.setSelectionRange(0,1);
        child.value='Xhild'; child.dispatchEvent(new InputEvent('input',{bubbles:true}));
        parent.setAttribute('readonly',''); caret(parent.firstChild,0); edit(parent,'insertText','bad');
        return result();
    });
    assert.equal(changes.length,1); assert.equal(changes[0].id,'editor-1');
}));
test('paste normalizes newlines and cut submits one deletion', () => fixture(async page => {
    const changes=await page.evaluate(()=>{
        make('div','abcd'); caret(el.firstChild,1,3);
        const paste=new DataTransfer(); paste.setData('text/plain','X\r\nY'); el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:paste}));
        make('div','abcd'); caret(el.firstChild,1,3);
        el.dispatchEvent(new ClipboardEvent('cut',{bubbles:true,cancelable:true,clipboardData:new DataTransfer()}));
        return result().map(({start,end,value})=>({start,end,value}));
    });
    assert.deepEqual(changes,[{start:1,end:3,value:'X\nY'},{start:1,end:3,value:''}]);
}));
test('form reset reports the final browser value and respects cancellation', () => fixture(async page => {
    const changes=await page.evaluate(async()=>{
        const form=document.createElement('form'); document.body.append(form); const field=make('textarea','base');
        events.removeEventListeners(field); form.append(field); events.addEventListeners(field);
        field.value='edited'; field.dispatchEvent(new InputEvent('input',{bubbles:true})); form.reset(); await Promise.resolve();
        field.value='other'; field.dispatchEvent(new InputEvent('input',{bubbles:true}));
        form.addEventListener('reset',e=>e.preventDefault()); form.reset(); await Promise.resolve();
        return result().map(({value})=>value);
    });
    assert.deepEqual(changes,['edited','base','other']);
}));
test('whole-value input works on readonly elements without rendering', () => fixture(async page => {
    const outcome=await page.evaluate(()=>{
        make('div','old'); el.setAttribute('readonly',''); el.value='new'; el.dispatchEvent(new CustomEvent('input',{detail:{value:'new'}}));
        return {live:el.innerHTML,ops:result()};
    });
    assert.equal(outcome.live,'old'); assert.equal(outcome.ops[0].value,'new');
}));
test('iframe user operations use the frame source while setter input stays on the frame', () => fixture(async page => {
    const outcome=await page.evaluate(async()=>{
        const frame=document.createElement('iframe'); frame.id='frame'; document.body.append(frame);
        const doc=frame.contentDocument; doc.body.innerHTML='<p>abc</p>'; doc.documentElement.contentEditable='true';
        const value=doc.documentElement.outerHTML; frame.value=value; frame.getValue=()=>frame.value;
        frame.editor={dom:(await import('/editors/dom.js')).default(value,document)};
        for(const [key,val] of Object.entries({array:'a',object:'o',key:'frame',crdt:'true'})) frame.setAttribute(key,val);
        events.addEventListeners(frame); caret(doc.body.firstChild.firstChild,1); edit(doc.documentElement,'insertText','X');
        const first=result()[0];
        frame.value='replacement'; frame.dispatchEvent(new CustomEvent('input',{detail:{value:'replacement'}}));
        return {first,expected:value.indexOf('abc')+1,ops:result(),live:doc.body.innerHTML};
    });
    assert.equal(outcome.first.id,'frame'); assert.equal(outcome.first.start,outcome.expected); assert.equal(outcome.live,'<p>abc</p>'); assert.equal(outcome.ops.length,2);
}));
test('attachment is idempotent; teardown removes element, document routing, and form callbacks', () => fixture(async page => {
    const outcome=await page.evaluate(async()=>{
        make('textarea','base'); events.addEventListeners(el); el.value='new'; el.dispatchEvent(new InputEvent('input',{bubbles:true}));
        const count=operations.length; events.removeEventListeners(el);
        positions.length=0; document.dispatchEvent(new Event('selectionchange'));
        el.value='ignored'; el.dispatchEvent(new InputEvent('input',{bubbles:true}));
        return {count,total:operations.length,positions:positions.length,init:el.editor.init};
    });
    assert.deepEqual(outcome,{count:1,total:1,positions:0,init:false});
}));

test('repeated-text composition preserves the actual insertion position', () => fixture(async page => {
    const changes=await page.evaluate(async()=>{
        make('div','aaa'); caret(el.firstChild,1);
        el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
        el.firstChild.data='aaaa';
        el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'a'}));
        await Promise.resolve(); return result();
    });
    assert.equal(changes[0].start,1); assert.equal(changes[0].end,1); assert.equal(changes[0].value,'a');
}));
test('repeated native deletion uses the browser caret rather than the last matching character', () => fixture(async page => {
    await page.evaluate(()=>{make('textarea','aaaa'); el.setSelectionRange(2,2);});
    await page.keyboard.press('Backspace');
    assert.deepEqual(await page.evaluate(()=>result().map(({start,end,value})=>({start,end,value}))),[{start:1,end:2,value:''}]);
}));
test('Tab inserts once; Shift+Tab and platform navigation shortcuts stay native', () => fixture(async page => {
    const outcome=await page.evaluate(()=>{
        make('textarea','abcd'); el.setSelectionRange(1,3);
        const prevented=[];
        for(const modifiers of [{},{shiftKey:true},{ctrlKey:true},{metaKey:true},{altKey:true}]) {
            const event=new KeyboardEvent('keydown',{key:'Tab',...modifiers,cancelable:true,bubbles:true}); el.dispatchEvent(event); prevented.push(event.defaultPrevented);
        }
        return {prevented,ops:result()};
    });
    assert.deepEqual(outcome.prevented,[true,false,false,false,false]);
    assert.deepEqual(outcome.ops.map(({start,end,value})=>({start,end,value})),[{start:1,end:3,value:'\t'}]);
}));
test('selection inside a nested editor is isolated even if the browser targets its parent', () => fixture(async page => {
    const changes=await page.evaluate(()=>{
        const parent=make('div','outer'); const child=document.createElement('div'); child.contentEditable='true'; child.textContent='inner'; parent.append(child);
        caret(child.firstChild,2); edit(parent,'insertText','bad'); parent.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,cancelable:true,bubbles:true}));
        return result();
    });
    assert.equal(changes.length,0);
}));
test('drop text is submitted at the browser target range without inserting HTML', () => fixture(async page => {
    const outcome=await page.evaluate(()=>{
        make('div','abcd'); caret(el.firstChild,0);
        const range=new StaticRange({startContainer:el.firstChild,startOffset:3,endContainer:el.firstChild,endOffset:3});
        const transfer=new DataTransfer(); transfer.setData('text/plain','<b>X</b>'); transfer.setData('text/html','<b>X</b>');
        const event=new InputEvent('beforeinput',{inputType:'insertFromDrop',bubbles:true,cancelable:true,dataTransfer:transfer});
        Object.defineProperty(event,'getTargetRanges',{value:()=>[range]}); el.dispatchEvent(event);
        return {ops:result(),live:el.innerHTML};
    });
    assert.equal(outcome.live,'abcd');
    assert.deepEqual(outcome.ops.map(({start,end,value})=>({start,end,value})),[{start:3,end:3,value:'<b>X</b>'}]);
}));
test('deletion stops at document boundaries and does not split a forward grapheme', () => fixture(async page => {
    const changes=await page.evaluate(()=>{
        make('div','👩🏽‍💻x'); caret(el.firstChild,0); edit(el,'deleteContentForward',null);
        make('div','\nx'); caret(el.firstChild,0); edit(el,'deleteSoftLineBackward',null);
        make('div','x'); caret(el.firstChild,1); edit(el,'deleteContentForward',null);
        return result();
    });
    assert.deepEqual(changes.map(({start,end,value})=>({start,end,value})),[{start:0,end:7,value:''}]);
}));
test('aborted attachment cannot commit a deferred composition', () => fixture(async page => {
    const outcome=await page.evaluate(async()=>{
        make('div','abc'); caret(el.firstChild,1); el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
        el.firstChild.data='a語bc'; el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
        events.removeEventListeners(el); await Promise.resolve(); return {count:operations.length,init:el.editor.init};
    });
    assert.deepEqual(outcome,{count:0,init:false});
}));

test('unchanged input and a collapsed cut do not create CRDT operations', () => fixture(async page => {
    const changes=await page.evaluate(()=>{
        make('textarea','abc'); el.setSelectionRange(1,2); edit(el,'insertText','b'); el.dispatchEvent(new InputEvent('input',{bubbles:true}));
        make('div','abc'); caret(el.firstChild,1); edit(el,'deleteByCut',null);
        return result();
    });
    assert.equal(changes.length,0);
}));
test('form reset respects a disabled CRDT binding', () => fixture(async page => {
    const count=await page.evaluate(async()=>{
        const form=document.createElement('form'); document.body.append(form); make('textarea','base'); form.append(el);
        el.value='changed'; el.editor.inputValue='changed'; el.setAttribute('crdt','false'); form.reset(); await Promise.resolve();
        return operations.length;
    });
    assert.equal(count,0);
}));
