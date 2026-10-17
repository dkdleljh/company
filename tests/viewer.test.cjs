const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../docs/assets/app.js'), 'utf8');
const findSource = source.slice(source.indexOf('async function findInDocument(next)'), source.indexOf("$('#viewerDownload').addEventListener"));
const pageSource = source.slice(source.indexOf('function changePage(n)'), source.indexOf("$('#pagePrev').addEventListener"));
const disposeSource = source.slice(source.indexOf('function disposeViewer()'), source.indexOf("$('#closeDocumentDialog').addEventListener"));
const openSource = source.slice(source.indexOf('async function openDocument(doc)'), source.indexOf('function showError(text)')).replaceAll('import.meta.url', "'https://test.invalid/assets/app.js'");
const lockSource = source.slice(source.indexOf('function lockPortal('), source.indexOf("$('#logoutBtn').addEventListener"));
const pagehideSource = source.slice(source.indexOf("window.addEventListener('pagehide'"));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function harness({gate, texts = ['RTU', 'RTU']} = {}) {
  const nodes = {'#viewerSearch':{value:'RTU'}, '#findStatus':{textContent:''}};
  const state = {pdf:{getPage:async number => {
    if (gate) await gate.promise;
    return {getTextContent:async () => ({items:[{str:texts[number-1]}]})};
  }}, text:false, total:texts.length, page:1, findPages:[], findAt:-1, searchSequence:0};
  const context = vm.createContext({viewer:state, $:selector=>nodes[selector],
    pageStrings:async (s,p)=>(await (await s.pdf.getPage(p)).getTextContent()).items.map(i=>i.str),
    matchParts:(strings,term)=>strings.join('').toLowerCase().includes(term.toLowerCase())?[[]]:[],
    renderPage:async()=>{}, normalize:value=>String(value).toLowerCase(), changePage:page=>{state.page=page;}});
  vm.runInContext(findSource, context);
  return {context, nodes, state};
}

test('repeated same-term search during a PDF scan never caches partial results', async () => {
  const gate = deferred();
  const {context, state, nodes} = harness({gate});
  const first = context.findInDocument(false);
  const second = context.findInDocument(true);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(Array.from(state.findPages), [1,2]);
  assert.equal(state.findTerm, 'RTU');
  await context.findInDocument(true);
  assert.match(nodes['#findStatus'].textContent, /2개 페이지/);
});

test('new search terms cancel old scans and cache only their own matching pages', async () => {
  const gate = deferred();
  const {context, state, nodes} = harness({gate, texts:['RTU', 'OPGW']});
  const first = context.findInDocument(false);
  nodes['#viewerSearch'].value = 'OPGW';
  const second = context.findInDocument(false);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(Array.from(state.findPages), [2]);
  assert.equal(state.findTerm, 'OPGW');
});

test('failed scans from a closed viewer do not overwrite a new viewer status', async () => {
  const gate = deferred();
  const {context, nodes} = harness({gate});
  const first = context.findInDocument(false);
  context.viewer = {searchSequence:0};
  nodes['#findStatus'].textContent = '새 문서';
  gate.reject(new Error('PDF worker destroyed'));
  await first;
  assert.equal(nodes['#findStatus'].textContent, '새 문서');
});

test('active PDF failures display a recoverable search error', async () => {
  const gate = deferred();
  const {context, state, nodes} = harness({gate});
  const result = context.findInDocument(false);
  gate.reject(new Error('Text extraction failed'));
  await result;
  assert.match(nodes['#findStatus'].textContent, /다시 시도/);
  assert.notEqual(state.findTerm, 'RTU');
});

test('page navigation accepts only whole pages within document bounds', () => {
  const context = vm.createContext({viewer:{page:1,total:3}, renderPage:()=>{}});
  vm.runInContext(pageSource, context);
  for (const [input, expected] of [[1.5,1],[-2,1],[99,3],['bad',1]]) {
    context.changePage(input);
    assert.equal(context.viewer.page, expected);
  }
});

function viewerHarness() {
  const nodes = new Map();
  const tasks = [];
  const revoked = [];
  class LocalURL extends URL { static revokeObjectURL(url) { revoked.push(url); } }
  const $ = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value:'', textContent:'', open:false, hidden:false,
      setAttribute(){}, removeAttribute(name){delete this[name];}, replaceChildren(){},
      showModal(){this.open=true;}, close(){this.open=false;},
    });
    return nodes.get(selector);
  };
  const context = vm.createContext({
    $, viewer:null, viewerSequence:0, renderSequence:0, renderTask:null, pdfLoading:null,
    objectURLs:[], URL:LocalURL, AbortController,
    type:doc=>doc.format, safeLink:()=> '#', message(){}, updateNavigation(){},
    renderPage:async()=>{}, showError:message=>{$('#viewerStatus').textContent=message;},
    vault:{read:async()=>new Uint8Array([1,2,3])},
    pdfLibrary:{getDocument(){
      const pending=deferred();
      const task={promise:pending.promise, resolve:pending.resolve, destroyCount:0,
        destroy(){this.destroyCount++;}};
      tasks.push(task);return task;
    }},
  });
  vm.runInContext(disposeSource+'\n'+openSource,context);
  return {context,tasks,nodes,revoked};
}
const pdfDocument = id => ({title:id,relative_path:`${id}.pdf`,format:'PDF',
  viewer:{kind:'pdf',fidelity:'original-bytes',assets:[{}]}});

test('closing a loaded PDF destroys its loading task without a proxy destroy method', async () => {
  const {context,tasks} = viewerHarness();
  const opened=context.openDocument(pdfDocument('first'));
  await new Promise(setImmediate);
  const proxy={numPages:3}; // PDF.js 6 proxy intentionally has no destroy method.
  tasks[0].resolve(proxy);
  await opened;
  const controller=context.viewer.controller;
  assert.equal(context.viewer.pdf,proxy);
  assert.doesNotThrow(()=>context.closeViewer());
  assert.equal(tasks[0].destroyCount,1);
  assert.equal(controller.signal.aborted,true);
  assert.equal(context.viewer,null);
  assert.equal(context.pdfLoading,null);
});

test('late completion and password callbacks of an old PDF cannot destroy the new loading task', async () => {
  const {context,tasks,nodes}=viewerHarness();
  const first=context.openDocument(pdfDocument('old'));
  await new Promise(setImmediate);
  const second=context.openDocument(pdfDocument('new'));
  await new Promise(setImmediate);
  assert.equal(tasks.length,2);
  assert.equal(tasks[0].destroyCount,1);
  tasks[0].onPassword();
  assert.equal(tasks[1].destroyCount,0);
  let proxyDestroyCalls=0;
  tasks[0].resolve({numPages:1,destroy(){proxyDestroyCalls++;}});
  await first;
  assert.equal(proxyDestroyCalls,0);
  assert.equal(context.pdfLoading,tasks[1]);
  assert.equal(tasks[1].destroyCount,0);
  assert.equal(nodes.get('#viewerStatus')?.textContent||'', '');
  const proxy={numPages:4};
  tasks[1].resolve(proxy);
  await second;
  assert.equal(context.viewer.pdf,proxy);
  assert.equal(context.viewer.doc.title,'new');
  context.closeViewer();
  assert.equal(tasks[1].destroyCount,1);
});

test('pagehide locks restored pages, clears decrypted data and body DOM, and does not steal focus', () => {
  const {context,revoked}=viewerHarness();
  const handlers = new Map();
  let locks=0, focusCount=0, destroyed=0;
  context.window={addEventListener:(event,handler)=>handlers.set(event,handler)};
  context.vault.lock=()=>{locks++;};
  Object.assign(context, {topics:[{title:'fixture'}],documents:[{search_text:'fixture body'}],
    index:{documents:[{body:'indexed fixture'}]},category:'fixture',format:'PDF',query:'fixture',
    visible:80,PAGE_SIZE:40,objectURLs:['blob:fixture']});
  const controller=new AbortController();
  context.viewer={controller,loadingTask:{destroy(){destroyed++;}}};
  for(const selector of ['#topicGrid','#documentRows','#dialogContent','#viewerContent']) {
    const node=context.$(selector);
    node.children=['decrypted fixture'];
    node.replaceChildren=function(){this.children=[];};
  }
  const titleIds=['viewerTitle','viewerPath','viewerEngine','viewerNote','dialogTitle','dialogSummary','dialogCategory','searchStatus','findStatus'];
  for(const id of titleIds)context.$('#'+id).textContent='fixture metadata';
  context.$('#password').value='test-only';
  context.$('#password').focus=()=>{focusCount++;};
  context.$('#searchInput').value='fixture';
  context.$('#viewerSearch').value='fixture';
  context.$('#viewerNotionLink').href='https://notion.so/fixture';
  context.$('#dialogNotionLink').href='https://notion.so/fixture';
  context.$('#loginView').hidden=true;
  context.$('#appView').hidden=false;
  context.$('#documentDialog').open=true;
  context.$('#topicDialog').open=true;
  vm.runInContext(lockSource+'\n'+pagehideSource,context);
  assert.equal(typeof handlers.get('pagehide'),'function');
  handlers.get('pagehide')({persisted:true});
  assert.equal(locks,1);
  assert.equal(context.documents.length,0);
  assert.equal(context.topics.length,0);
  assert.equal(context.index,null);
  assert.equal(context.viewer,null);
  assert.equal(controller.signal.aborted,true);
  assert.equal(destroyed,1);
  assert.deepEqual(revoked,['blob:fixture']);
  for(const selector of ['#topicGrid','#documentRows','#dialogContent','#viewerContent'])assert.equal(context.$(selector).children.length,0);
  for(const id of titleIds)assert.equal(context.$('#'+id).textContent,'');
  assert.equal(context.$('#documentDialog').open,false);
  assert.equal(context.$('#topicDialog').open,false);
  assert.equal(context.$('#appView').hidden,true);
  assert.equal(context.$('#loginView').hidden,false);
  assert.equal(context.$('#password').value,'');
  assert.equal(context.$('#searchInput').value,'');
  assert.equal(context.$('#viewerSearch').value,'');
  assert.equal(context.$('#viewerNotionLink').href,undefined);
  assert.equal(context.$('#dialogNotionLink').href,undefined);
  assert.equal(context.query,'');
  assert.equal(context.category,'전체');
  assert.equal(context.format,'전체');
  assert.equal(context.visible,40);
  assert.equal(focusCount,0);
  context.lockPortal();
  assert.equal(focusCount,1,'manual lock still focuses the login field');
});


test('HWP page search preserves visual mode and navigates matching pages', async () => {
  const {context,state,nodes}=harness();
  state.pdf=null;state.doc={viewer:{kind:'svg-pages'}};state.total=3;
  context.pageStrings=async(_,p)=>p===2?['R','T','U']:['다른 내용'];
  await context.findInDocument(false);
  assert.equal(state.text,false);
  assert.equal(state.page,2);
  assert.deepEqual(Array.from(state.findPages),[2]);
  assert.match(nodes['#findStatus'].textContent,/1개 페이지/);
  nodes['#viewerSearch'].value='없음';await context.findInDocument(false);
  assert.equal(state.text,false);
  assert.match(nodes['#findStatus'].textContent,/일치하는 페이지가 없습니다/);
});

test('clearing a visual search redraws the page to remove old highlights', async () => {
  const {context,state,nodes}=harness();let renders=0;
  context.renderPage=async()=>{renders++;};
  state.findTerm='RTU';state.findPages=[1];nodes['#viewerSearch'].value='';
  await context.findInDocument(false);
  assert.equal(renders,1);assert.equal(state.text,false);
  assert.equal(state.findTerm,'');assert.deepEqual(Array.from(state.findPages),[]);
});


test('search during PDF loading waits without changing to text mode', async () => {
  const {context,state,nodes}=harness();state.pdf=null;state.doc={viewer:{kind:'pdf'}};
  await context.findInDocument(false);
  assert.equal(state.text,false);assert.match(nodes['#findStatus'].textContent,/불러온 뒤/);
});
