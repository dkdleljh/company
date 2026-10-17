const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function harness(){
 const nodes=new Map(),workers=[];
 const get=id=>{if(!nodes.has(id)){const listeners={};nodes.set(id,{value:'',textContent:'',open:false,children:[],width:1,style:{},
  addEventListener(name,fn){listeners[name]=fn;},querySelectorAll(){return [];},replaceChildren(...v){this.children=v;},append(v){this.children.push(v);},
  showModal(){this.open=true;},close(){this.open=false;listeners.close?.();},getContext(){return {};},getBoundingClientRect(){return {width:900,height:600};}
 });}return nodes.get(id);};
 class Worker {constructor(){workers.push(this);}postMessage(data){this.posted=data;}terminate(){this.terminated=true;}}
 const context=vm.createContext({document:{querySelector:get,createElement:()=>({})},window:{},Worker,URL,ResizeObserver:class{observe(){}},cancelAnimationFrame(){},clearTimeout(){},setTimeout,devicePixelRatio:1});
 const source=fs.readFileSync(require.resolve('../docs/assets/graph-ui.js'),'utf8').replace('export class GraphView','class GraphView').replaceAll('import.meta.url',"'https://example.invalid/graph-ui.js'");
 vm.runInContext(source+'\nthis.View=GraphView',context);const view=new context.View({onOpen(){},search(){}});
 view.resize=()=>{};view.update=()=>{view.updates=(view.updates||0)+1;};
 return {view,get,workers};
}
test('locking during graph build terminates worker, erases data/DOM, and ignores a late decrypted result',()=>{
 const {view,get,workers}=harness();view.data={documents:[{title:'Private document',search_text:'Private body'}],topics:[]};view.open();
 const worker=workers[0];get('#graphSidebar').append('Private title');view.selected='private-id';view.lastClick={id:'private-id'};view.clearData();
 worker.onmessage({data:{type:'ready',graph:{nodes:[{id:'private-id',categories:[]}],edges:[]}}});
 assert.equal(worker.terminated,true);assert.equal(view.data,null);assert.equal(view.model,null);assert.equal(view.selected,null);assert.equal(view.lastClick,null);assert.equal(view.byId.size,0);assert.equal(view.adjacent.size,0);assert.equal(get('#graphDialog').open,false);assert.equal(get('#graphSidebar').children.length,0);assert.equal(view.updates,undefined);
});
test('closing unfinished graph allows a fresh worker and rejects stale progress/results',()=>{
 const {view,get,workers}=harness();view.data={documents:[],topics:[]};view.open();const old=workers[0];get('#graphDialog').close();view.open();const current=workers[1];
 old.onmessage({data:{type:'progress',text:'stale'}});assert.notEqual(get('#graphStatus').textContent,'stale');
 old.onmessage({data:{type:'ready',graph:{nodes:[]}}});assert.equal(view.model,null);
 current.onmessage({data:{type:'ready',graph:{nodes:[],edges:[]}}});assert.equal(view.updates,1);assert.equal(current.terminated,true);assert.equal(view.worker,null);
});
