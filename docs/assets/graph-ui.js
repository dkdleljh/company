const $=s=>document.querySelector(s);
const PALETTE=['#c3f458','#76d1ff','#d6a0ff','#ffa96b','#76e0b5','#ff91b5','#f4dc77','#95a9ff'];
const button=(label,fn,className='')=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.className=className;b.addEventListener('click',fn);return b;};
export class GraphView {
 constructor({onOpen,search}){
  this.onOpen=onOpen;this.search=search;this.dialog=$('#graphDialog');this.canvas=$('#graphCanvas');this.ctx=this.canvas.getContext('2d');this.pointers=new Map();this.resetState();
  $('#closeGraph').onclick=()=>this.dialog.close();$('#graphFit').onclick=()=>this.fit();$('#graphZoomIn').onclick=()=>this.zoom(1.3);$('#graphZoomOut').onclick=()=>this.zoom(1/1.3);
  $('#graphAll').onclick=()=>{this.selected=null;$('#graphLocal').checked=false;this.update(true);};
  $('#graphSearch').oninput=()=>{clearTimeout(this.searchTimer);this.searchTimer=setTimeout(()=>{this.selected=null;$('#graphLocal').checked=false;this.update(true);},140);};
  for(const control of this.dialog.querySelectorAll('[data-edge-kind],#graphCategory,#graphLocal,#graphDepth'))control.addEventListener('change',()=>{if(control.id==='graphCategory'){this.selected=null;$('#graphLocal').checked=false;}this.update(true);});
  this.dialog.addEventListener('close',()=>{this.stop();if(this.worker){this.worker.terminate();this.worker=null;this.model=null;}});
  this.canvas.addEventListener('wheel',e=>{e.preventDefault();const p=this.point(e);this.zoom(Math.exp(-e.deltaY*.0015),p);},{passive:false});
  this.canvas.addEventListener('pointerdown',e=>this.down(e));this.canvas.addEventListener('pointermove',e=>this.move(e));this.canvas.addEventListener('pointerup',e=>this.up(e));this.canvas.addEventListener('pointercancel',e=>this.up(e,true));
  this.canvas.addEventListener('pointerleave',()=>{if(!this.pointers.size){this.hover=null;this.drawSoon();}});
  this.canvas.addEventListener('keydown',e=>{
   if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','0','Enter'].includes(e.key)){e.preventDefault();if(e.key==='Enter'&&this.selected)this.openSelected();else if(e.key==='0')this.fit();else if(['+','='].includes(e.key))this.zoom(1.3);else if(e.key==='-')this.zoom(1/1.3);else {this.camera.x+=e.key==='ArrowLeft'?50:e.key==='ArrowRight'?-50:0;this.camera.y+=e.key==='ArrowUp'?50:e.key==='ArrowDown'?-50:0;this.drawSoon();}}
  });
  this.resizeObserver=new ResizeObserver(()=>{if(this.dialog.open){this.resize();this.drawSoon();}});this.resizeObserver.observe($('#graphStage'));
 }
 resetState(){this.model=null;this.data=null;this.selected=null;this.hover=null;this.matches=null;this.visible={nodes:[],edges:[]};this.camera={x:0,y:0,k:1};this.hitPoints=[];this.byId=new Map();this.worker=null;this.colors=new Map();this.adjacent=new Set();this.lastClick=null;this.pointers?.clear();}
 setData(documents,topics,index){
  this.clearData();const cats=[...new Set(topics.flatMap(t=>[t.category,t.categories].flatMap(v=>Array.isArray(v)?v:v?[v]:[])))].sort((a,b)=>a.localeCompare(b,'ko'));
  const compact=s=>window.CompanySearch.normalize(s).replace(/ /g,'');
  const seenBodies=new Set();
  this.data={documents:documents.map((d,i)=>{const hash=d.viewer?.original?.sha256;const reuse=hash&&seenBodies.has(hash);if(hash)seenBodies.add(hash);return {title:d.title,relative_path:d.relative_path,notion_page_id:d.notion_page_id,notion_url:d.notion_url,sha256:hash,body_ref:hash,search_text:reuse?'':d.search_text,graph_categories:cats.filter(c=>index.documents[i].categories.has(compact(c)))};}),topics};
  const select=$('#graphCategory');select.replaceChildren();for(const value of ['전체',...cats,'기타 자료']){const o=document.createElement('option');o.value=value==='전체'?'':value;o.textContent=value;select.append(o);}
 }
 open(selected=null){
  if(!this.data)return;this.selected=selected;$('#graphSearch').value='';$('#graphCategory').value='';$('#graphLocal').checked=Boolean(selected);
  if(!this.dialog.open)this.dialog.showModal();this.resize();
  if(this.model){this.update(true);return;}
  $('#graphStatus').textContent='전체 문서의 연결을 준비하고 있습니다…';$('#graphEmpty').textContent='문서 관계를 분석하고 있습니다…';$('#graphEmpty').hidden=false;$('#graphSidebar').replaceChildren();
  if(this.worker)return;
  let worker;try{worker=this.worker=new Worker(new URL('./graph-worker.js?v=1',import.meta.url));}catch{this.worker=null;$('#graphStatus').textContent='이 브라우저에서 그래프를 실행하지 못했습니다. 최신 브라우저로 다시 열어 주세요.';$('#graphEmpty').textContent=$('#graphStatus').textContent;return;}
  worker.onmessage=({data})=>{if(this.worker!==worker)return;if(data.type==='progress')$('#graphStatus').textContent=data.text;
   else if(data.type==='ready'){this.model=data.graph;this.byId=new Map(this.model.nodes.map(n=>[n.id,n]));const cats=[...new Set(this.model.nodes.flatMap(n=>n.categories))].sort();this.colors=new Map(cats.map((c,i)=>[c,PALETTE[i%PALETTE.length]]));worker.terminate();this.worker=null;this.update(true);}
   else {$('#graphStatus').textContent=data.text;$('#graphEmpty').textContent=data.text;worker.terminate();this.worker=null;}
  };
  worker.onerror=()=>{if(this.worker!==worker)return;$('#graphStatus').textContent='그래프를 불러오지 못했습니다. 창을 닫고 다시 열어 주세요.';$('#graphEmpty').textContent=$('#graphStatus').textContent;worker.terminate();this.worker=null;};
  worker.postMessage(this.data);
 }
 update(fit=false){
  if(!this.model)return;const query=$('#graphSearch').value.trim();const matches=this.matches=query?this.search(query):null;
  const kinds=[...this.dialog.querySelectorAll('[data-edge-kind]:checked')].map(el=>el.dataset.edgeKind);
  this.visible=window.CompanyGraph.subset(this.model,{kinds,matches,category:$('#graphCategory').value,selected:this.selected,local:$('#graphLocal').checked,depth:Number($('#graphDepth').value)});
  this.adjacent=new Set(this.selected?[this.selected]:[]);for(const e of this.visible.edges){if(e.source===this.selected)this.adjacent.add(e.target);if(e.target===this.selected)this.adjacent.add(e.source);}
  const docs=this.visible.nodes.filter(n=>n.kind==='document').length,topics=this.visible.nodes.filter(n=>n.kind==='topic').length;
  $('#graphStatus').textContent=`원본 ${docs} / ${this.model.counts.documents} · 백과 ${topics} / ${this.model.counts.topics} · 표시 연결 ${this.visible.edges.length.toLocaleString()}개`;
  $('#graphEmpty').hidden=this.visible.nodes.length>0;$('#graphEmpty').textContent='표시할 문서가 없습니다. 검색어나 연결 필터를 바꿔 주세요.';
  $('#graphLocal').disabled=!this.selected;$('#graphDepth').disabled=!$('#graphLocal').checked;
  this.sidebar();if(fit)this.fit();else this.drawSoon();
 }
 select(id,center=false){
  this.selected=id;this.update();const n=this.byId.get(id);if(n&&center){this.camera.k=1.15;this.camera.x=this.width/2-n.x*this.camera.k;this.camera.y=this.height/2-n.y*this.camera.k;this.drawSoon();}
 }
 openSelected(){const n=this.byId.get(this.selected);if(n&&['document','topic'].includes(n.kind))this.onOpen(n);}
 sidebar(){
  const panel=$('#graphSidebar');panel.replaceChildren();const n=this.byId.get(this.selected);const head=document.createElement('h3');head.textContent=n?n.label:'연결을 따라 탐색하세요';panel.append(head);
  const help=document.createElement('p');help.className='graph-detail';help.textContent=n?(n.path||({topic:'백과 문서',category:'분류에 속한 문서',folder:'폴더에 속한 문서'}[n.kind])):'점을 선택하면 연결 이유가 표시됩니다. 문서는 두 번 클릭하거나 아래 목록에서 찾아 열 수 있습니다.';panel.append(help);
  if(n){const actions=document.createElement('div');actions.className='graph-detail-actions';if(['document','topic'].includes(n.kind))actions.append(button(n.kind==='topic'?'백과 열기':'문서 열기',()=>this.openSelected(),'graph-primary'));actions.append(button('이 노드 주변만',()=>{$('#graphLocal').checked=true;this.update(true);}));panel.append(actions);}
  const rows=[];
  if(n){const neighbors=new Map();const enabled=new Set([...this.dialog.querySelectorAll('[data-edge-kind]:checked')].map(el=>el.dataset.edgeKind));for(const e of this.model.edges){if(!enabled.has(e.kind))continue;const other=e.source===n.id?e.target:e.target===n.id?e.source:null;if(other){const entry=neighbors.get(other)||{node:this.byId.get(other),reasons:[]};entry.reasons.push(e.kind==='similarity'?`본문 유사도 ${e.score}% · 추정`:window.CompanyGraph.KINDS[e.kind]);neighbors.set(other,entry);}}rows.push(...neighbors.values());}
  else rows.push(...this.visible.nodes.filter(x=>['document','topic'].includes(x.kind)).map(node=>({node,reasons:[node.kind==='topic'?'백과 문서':'원본 문서']})));
  const q=window.CompanyGraph.normalize($('#graphSearch').value);const order=new Map([...(this.matches||[])].map((id,i)=>[id,i]));
  rows.sort((a,b)=>{if(q&&!n){const rank=node=>{const title=window.CompanyGraph.normalize(node.label);return title===q?0:title.includes(q)?1:2;};return rank(a.node)-rank(b.node)||(order.get(a.node.id)??Infinity)-(order.get(b.node.id)??Infinity)||a.node.label.localeCompare(b.node.label,'ko');}return a.node.label.localeCompare(b.node.label,'ko');});
  const count=document.createElement('p');count.className='graph-list-count';count.textContent=n?`연결된 항목 ${rows.length}개 · 전체 자료 기준`:`문서 찾아가기 · ${rows.length}개`;panel.append(count);
  const list=document.createElement('ul');list.className='graph-neighbors';panel.append(list);let shown=0;
  const more=button('더 보기',append,'graph-more');
  const choose=id=>{$('#graphSearch').value='';$('#graphCategory').value='';this.select(id,true);};
  function append(){const end=Math.min(rows.length,shown+40);for(;shown<end;shown++){const row=rows[shown],li=document.createElement('li'),b=button('',()=>choose(row.node.id));const title=document.createElement('span');title.textContent=row.node.label;const reason=document.createElement('small');reason.textContent=[...new Set(row.reasons)].join(' · ');b.append(title,reason);li.append(b);list.append(li);}more.hidden=shown>=rows.length;more.textContent=`더 보기 (${shown}/${rows.length})`;}
  append();panel.append(more);
 }
 resize(){const r=$('#graphStage').getBoundingClientRect();this.width=Math.max(1,r.width);this.height=Math.max(1,r.height);const dpr=Math.min(devicePixelRatio||1,2);this.canvas.width=Math.round(this.width*dpr);this.canvas.height=Math.round(this.height*dpr);this.ctx.setTransform(dpr,0,0,dpr,0,0);}
 fit(){if(!this.visible.nodes.length){this.drawSoon();return;}this.resize();const xs=this.visible.nodes.map(n=>n.x),ys=this.visible.nodes.map(n=>n.y);const minX=Math.min(...xs)-50,maxX=Math.max(...xs)+50,minY=Math.min(...ys)-50,maxY=Math.max(...ys)+50;this.camera.k=Math.min(2.3,Math.max(.12,Math.min((this.width-50)/(maxX-minX),(this.height-50)/(maxY-minY))));this.camera.x=this.width/2-(minX+maxX)/2*this.camera.k;this.camera.y=this.height/2-(minY+maxY)/2*this.camera.k;this.drawSoon();}
 zoom(factor,p={x:this.width/2,y:this.height/2}){const old=this.camera.k,next=Math.max(.12,Math.min(6,old*factor));this.camera.x=p.x-(p.x-this.camera.x)*next/old;this.camera.y=p.y-(p.y-this.camera.y)*next/old;this.camera.k=next;this.drawSoon();}
 point(e){const r=this.canvas.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};}
 hit(p){let best=null,distance=15;for(const h of this.hitPoints){const d=Math.hypot(h.x-p.x,h.y-p.y);if(d<Math.max(10,h.r+4)&&d<distance){best=h.id;distance=d;}}return best;}
 down(e){const p=this.point(e);this.canvas.setPointerCapture(e.pointerId);this.pointers.set(e.pointerId,p);if(this.pointers.size===2){const [a,b]=[...this.pointers.values()];this.pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),mid:{x:(a.x+b.x)/2,y:(a.y+b.y)/2}};this.drag=null;return;}this.drag={id:this.hit(p),start:p,last:p,moved:false};}
 move(e){const p=this.point(e);if(this.pointers.has(e.pointerId))this.pointers.set(e.pointerId,p);
  if(this.pointers.size===2&&this.pinch){const [a,b]=[...this.pointers.values()],mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2},distance=Math.hypot(a.x-b.x,a.y-b.y);this.zoom(distance/Math.max(1,this.pinch.distance),this.pinch.mid);this.camera.x+=mid.x-this.pinch.mid.x;this.camera.y+=mid.y-this.pinch.mid.y;this.pinch={distance,mid};this.drawSoon();return;}
  if(this.drag&&this.pointers.size===1){const d=this.drag,dx=p.x-d.last.x,dy=p.y-d.last.y;if(Math.hypot(p.x-d.start.x,p.y-d.start.y)>4)d.moved=true;if(d.moved){if(d.id){const n=this.byId.get(d.id);n.x+=dx/this.camera.k;n.y+=dy/this.camera.k;}else{this.camera.x+=dx;this.camera.y+=dy;}}d.last=p;this.drawSoon();}
  else {this.hover=this.hit(p);this.canvas.style.cursor=this.hover?'pointer':'grab';this.drawSoon();}
 }
 up(e,cancel=false){const d=this.drag;this.pointers.delete(e.pointerId);if(this.pointers.size<2)this.pinch=null;if(!cancel&&d&&!d.moved){const id=this.hit(this.point(e));if(id){const now=performance.now();if(this.lastClick?.id===id&&now-this.lastClick.time<450){this.select(id);this.openSelected();}else this.select(id);this.lastClick={id,time:now};}else {this.selected=null;$('#graphLocal').checked=false;this.update();}}this.drag=null;}
 drawSoon(){if(!this.frame&&this.dialog.open)this.frame=requestAnimationFrame(()=>{this.frame=null;this.draw();});}
 stop(){cancelAnimationFrame(this.frame);this.frame=null;clearTimeout(this.searchTimer);this.pointers.clear();this.drag=null;this.pinch=null;}
 draw(){
  const c=this.ctx;c.clearRect(0,0,this.width,this.height);this.hitPoints=[];if(!this.model)return;const camera=this.camera;const pos=n=>({x:n.x*camera.k+camera.x,y:n.y*camera.k+camera.y});const focused=this.selected&&this.visible.nodes.some(n=>n.id===this.selected);
  for(const e of this.visible.edges){const a=pos(this.byId.get(e.source)),b=pos(this.byId.get(e.target));const active=e.source===this.selected||e.target===this.selected;c.strokeStyle=active?'#d6f991':e.kind==='similarity'?'#b493da':'#70988a';c.globalAlpha=active?.8:focused?.035:e.kind==='similarity'?.24:.32;c.lineWidth=active?1.5:.65;c.setLineDash(['similarity','folder','category'].includes(e.kind)?[2,4]:[]);c.beginPath();c.moveTo(a.x,a.y);c.lineTo(b.x,b.y);c.stroke();}
  c.setLineDash([]);const labels=[];
  for(const n of this.visible.nodes){const p=pos(n),active=n.id===this.selected,near=this.adjacent?.has(n.id),hover=n.id===this.hover;const r=(n.kind==='document'?3.4:n.kind==='topic'?6.2:n.kind==='category'?9:5)*(active?1.55:1);const color=this.colors.get(n.categories[0])||'#c3f458';c.globalAlpha=focused&&!near&&!hover?.2:1;c.fillStyle=color;c.strokeStyle=color;c.lineWidth=1.5;
   if(active){c.beginPath();c.arc(p.x,p.y,r+5,0,Math.PI*2);c.stroke();}
   c.beginPath();if(n.kind==='topic'){c.moveTo(p.x,p.y-r);c.lineTo(p.x+r,p.y);c.lineTo(p.x,p.y+r);c.lineTo(p.x-r,p.y);c.closePath();}else c.arc(p.x,p.y,r,0,Math.PI*2);if(['category','folder'].includes(n.kind)){c.fillStyle='#11211c';c.fill();c.stroke();}else c.fill();this.hitPoints.push({id:n.id,...p,r});
   if(active||hover||n.kind==='category'||camera.k>1.35||(focused&&near))labels.push({n,p,r,active,hover,near});
  }
  c.globalAlpha=1;c.font='12px "Noto Sans CJK KR", sans-serif';c.textBaseline='middle';
  const occupied=[];labels.sort((a,b)=>(b.active||b.hover)-(a.active||a.hover));
  for(const {n,p,r,active,hover,near} of labels){if(p.x<0||p.x>this.width||p.y<0||p.y>this.height)continue;const label=n.label.length>35?n.label.slice(0,34)+'…':n.label;const w=c.measureText(label).width+10,x=p.x+r+7,y=p.y-9;if(!active&&!hover&&occupied.some(b=>x<b.x+b.w&&x+w>b.x&&y<b.y+20&&y+20>b.y))continue;occupied.push({x,y,w});c.globalAlpha=focused&&!active&&!hover&&!near?.25:1;c.fillStyle='#0b1612e8';c.fillRect(x-3,y,w,19);c.fillStyle=active||hover?'#e3fba4':'#cfddd5';c.fillText(label,x,p.y);}
  c.globalAlpha=1;
 }
 clearData(){this.stop();if(this.dialog.open)this.dialog.close();this.worker?.terminate();this.resetState();$('#graphSidebar').replaceChildren();$('#graphStatus').textContent='';$('#graphSearch').value='';$('#graphCategory').replaceChildren();$('#graphEmpty').textContent='';this.canvas.width=this.canvas.width;}
}
