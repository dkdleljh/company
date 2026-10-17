const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function harness({realResize=false}={}){
 const nodes=new Map(),workers=[],observers=[];
 const get=id=>{if(!nodes.has(id)){const listeners={};nodes.set(id,{value:'',textContent:'',open:false,children:[],width:1,style:{},
  addEventListener(name,fn){listeners[name]=fn;},querySelectorAll(){return [];},replaceChildren(...v){this.children=v;},append(v){this.children.push(v);},
  showModal(){this.open=true;},close(){this.open=false;listeners.close?.();},getContext(){return {setTransform(){}};},getBoundingClientRect(){return {width:900,height:600};}
 });}return nodes.get(id);};
 class Worker {constructor(){workers.push(this);}postMessage(data){this.posted=data;}terminate(){this.terminated=true;}}
 const context=vm.createContext({document:{querySelector:get,createElement:()=>({})},window:{},Worker,URL,ResizeObserver:class{constructor(callback){observers.push(callback);}observe(){}},requestAnimationFrame(){return 1;},cancelAnimationFrame(){},clearTimeout(){},setTimeout,devicePixelRatio:1});
 const source=fs.readFileSync(require.resolve('../docs/assets/graph-ui.js'),'utf8').replace('export class GraphView','class GraphView').replaceAll('import.meta.url',"'https://example.invalid/graph-ui.js'");
 vm.runInContext(source+'\nthis.View=GraphView',context);const view=new context.View({onOpen(){},search(){}});
 if(!realResize)view.resize=()=>{};view.update=()=>{view.updates=(view.updates||0)+1;};
 return {view,get,workers,observers};
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

test('desktop-to-mobile resize keeps the current graph centered and visible',()=>{
 const {view,get,observers}=harness({realResize:true});get('#graphDialog').open=true;
 let size={width:1200,height:800};get('#graphStage').getBoundingClientRect=()=>size;view.resize();
 view.camera={x:420,y:300,k:1.5};
 const nodes=[{x:-150,y:-100},{x:400,y:250}];
 const center={x:(view.width/2-view.camera.x)/view.camera.k,y:(view.height/2-view.camera.y)/view.camera.k};
 size={width:390,height:344};observers[0]();
 assert.equal(view.width,390);assert.equal(view.height,344);assert.equal(get('#graphCanvas').width,390);
 assert.ok(Math.abs((view.width/2-view.camera.x)/view.camera.k-center.x)<1e-9);
 assert.ok(Math.abs((view.height/2-view.camera.y)/view.camera.k-center.y)<1e-9);
 assert.ok(view.camera.k<1.5);
 for(const node of nodes){const x=node.x*view.camera.k+view.camera.x,y=node.y*view.camera.k+view.camera.y;assert.ok(x>=0&&x<=view.width&&y>=0&&y<=view.height);}
 const camera={...view.camera};observers[0]();assert.deepEqual(view.camera,camera);
 size={width:0,height:0};observers[0]();assert.deepEqual(view.camera,camera);assert.equal(view.width,390);assert.equal(view.height,344);
});
test('fit ignores hidden stage measurements and fits once to a valid viewport',()=>{
 const {view,get}=harness({realResize:true});get('#graphDialog').open=true;view.visible.nodes=[{x:-100,y:-50},{x:100,y:50}];
 let size={width:0,height:0};get('#graphStage').getBoundingClientRect=()=>size;view.fit();assert.equal(view.width,undefined);assert.deepEqual({...view.camera},{x:0,y:0,k:1});
 size={width:390,height:344};view.fit();assert.equal(view.camera.x,195);assert.equal(view.camera.y,172);assert.ok(view.camera.k>0);
});

test('repeated viewport and orientation roundtrips restore the original zoom and focal point',()=>{
 const {view,get,observers}=harness({realResize:true});get('#graphDialog').open=true;
 let size={width:1200,height:800};get('#graphStage').getBoundingClientRect=()=>size;view.resize();view.camera={x:420,y:300,k:1.5};
 const original={...view.camera};
 for(let i=0;i<5;i++){
  for(const next of [{width:390,height:344},{width:844,height:300},{width:390,height:344},{width:1200,height:800}]){size=next;observers[0]();}
  for(const key of ['x','y','k'])assert.ok(Math.abs(view.camera[key]-original[key])<1e-9,`camera ${key} drifts after roundtrip ${i}`);
 }
});
