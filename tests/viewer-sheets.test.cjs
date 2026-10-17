const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
async function harness(){
 const source=fs.readFileSync(require.resolve('../docs/assets/viewer-sheets.js'),'utf8');
 const {SheetNavigation}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const nodes=new Map(),moves=[];
 const node=()=>({children:[],value:'',textContent:'',disabled:false,addEventListener(event,fn){this[event]=fn;},replaceChildren(){this.children=[];},append(child){this.children.push(child);}});
 const document={querySelector(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},createElement:node};
 return {nav:new SheetNavigation(document,p=>moves.push(p)),nodes,moves};
}
const sheets=[{name:'첫 시트',first_page:1,last_page:3},{name:'<한글 & 숨김>',hidden:true,first_page:4,last_page:5}];
const doc=(rows=sheets,path='test.xlsm')=>({relative_path:path,viewer:{kind:'pdf',sheets:rows}});
test('sheet selection jumps to first page and search/page changes update sheet-relative position',async()=>{
 const {nav,nodes,moves}=await harness();nav.set(doc(),5);
 const select=nodes.get('#sheetSelect'),position=nodes.get('#sheetPosition');
 assert.equal(select.children.length,2);assert.match(select.children[1].textContent,/<한글 & 숨김> · 숨김 시트/);
 select.value='1';select.change();assert.deepEqual(moves,[4]);
 nav.update(5,false);assert.equal(select.value,'1');assert.equal(position.textContent,'<한글 & 숨김> · 시트 안 2 / 2쪽');
 nav.update(3,false);assert.equal(select.value,'0');assert.match(position.textContent,/3 \/ 3쪽/);
 nav.update(5,true);assert.equal(select.disabled,true);select.change();assert.deepEqual(moves,[4]);assert.match(position.textContent,/전체 시트/);
 nav.update(5,false);assert.equal(select.disabled,false);assert.equal(select.value,'1');
 nav.clear();assert.equal(select.children.length,0);assert.equal(position.textContent,'');assert.equal(nodes.get('#sheetNavigation').hidden,true);
});
test('missing, overlapping, out-of-bounds mappings fail safely, and ordinary PDFs hide sheet UI',async()=>{
 const {nav,nodes,moves}=await harness();
 for(const rows of [undefined,[],[{name:'bad',first_page:1,last_page:6}],[sheets[0],{...sheets[1],first_page:3}],[{name:'unknown',first_page:null,last_page:null}]]){
  nav.set(doc(rows===undefined?null:rows),5);assert.equal(nodes.get('#sheetSelect').disabled,true);
  nodes.get('#sheetSelect').value='0';nodes.get('#sheetSelect').change();assert.equal(moves.length,0);
 }
 nav.set(doc(sheets,'ordinary.pdf'),5);assert.equal(nodes.get('#sheetNavigation').hidden,true);assert.equal(nodes.get('#pageLabel').textContent,'페이지');
});
test('omitted blank sheet is listed but cannot navigate to a guessed page',async()=>{
 const {nav,nodes}=await harness();nav.set(doc([sheets[0],{name:'빈 시트',first_page:null,last_page:null},sheets[1]]),5);
 assert.equal(nodes.get('#sheetSelect').children[1].disabled,true);nav.update(4,false);assert.equal(nodes.get('#sheetSelect').value,'2');
});
