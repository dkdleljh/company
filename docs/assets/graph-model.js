(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.CompanyGraph=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const KINDS={notion:'Notion 연결',reference:'문서 내 참조',duplicate:'같은 원본',category:'같은 분류',folder:'같은 폴더',similarity:'본문 유사도 · 추정'};
const normalize=v=>String(v||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
const list=v=>Array.isArray(v)?v:v?[v]:[];
const notionId=v=>String(v||'').replace(/-/g,'').match(/[a-f0-9]{32}(?=$|[?#/}\])])/i)?.[0].toLowerCase()||'';
const docId=d=>'doc:'+d.relative_path;
const topicId=t=>'topic:'+String(t.id||notionId(t.url)||t.url);
const STOP=new Set(('있다 있는 경우 대한 위한 또는 등이 이를 위해 따라 해당 한다 하는 하고 및 등 그 이 저 수 제 년 월 일 문서 파일 자료 업무 공통 기준 사항 내용 관련 관리 사용 적용 방법 일반 필요 확인 참고 정리 목록 안내 별지 붙임 별표 복사 개정 최종 본부 한전 한국전력공사 페이지 the and for with from this that are was not page section table pdf hwp hwpx xlsx txt md http https www com').split(' '));
function terms(text){
 const counts=new Map();
 for(const m of String(text||'').normalize('NFKC').toLowerCase().matchAll(/[가-힣]{2,16}|[a-z]{2,20}/g)){
  const t=m[0];if(!STOP.has(t))counts.set(t,(counts.get(t)||0)+1);
 }
 return counts;
}
function build(documents=[],topics=[],progress=()=>{}){
 const nodes=[],edges=[],byId=new Map(),byNotion=new Map(),byPath=new Map(),byTitle=new Map(),edgeKeys=new Set();
 const addNode=n=>{if(!byId.has(n.id)){nodes.push(n);byId.set(n.id,n);}return byId.get(n.id);};
 const addEdge=(a,b,kind,extra={})=>{if(!a||!b||a===b||!byId.has(a)||!byId.has(b))return;const pair=[a,b].sort();const key=JSON.stringify([...pair,kind]);if(!edgeKeys.has(key)){edgeKeys.add(key);edges.push({source:pair[0],target:pair[1],kind,...extra});}};
 const record=(item,id,kind)=>{
  const n=addNode({id,kind,label:String(item.title||item.relative_path||'제목 없음'),path:item.relative_path||'',categories:[...new Set(item.graph_categories||[...list(item.category),...list(item.categories)])].filter(Boolean),ref:kind==='document'?item.relative_path:item.id});
  for(const value of [item.notion_page_id,item.notion_url,item.url]){const nid=notionId(value);if(nid){const ids=byNotion.get(nid)||[];ids.push(id);byNotion.set(nid,[...new Set(ids)]);}}
  if(item.relative_path)byPath.set(item.relative_path,id);
  const title=normalize(n.label);const ids=byTitle.get(title)||[];ids.push(id);byTitle.set(title,ids);return n;
 };
 documents.forEach(d=>record(d,docId(d),'document'));topics.forEach(t=>record(t,topicId(t),'topic'));
 const records=[...documents.map(d=>({item:d,id:docId(d)})),...topics.map(t=>({item:t,id:topicId(t)}))];
 const resolve=value=>{const v=typeof value==='string'?value:value?.url||value?.notion_page_id||value?.id||value?.relative_path;return byNotion.get(notionId(v))||(byPath.has(v)?[byPath.get(v)]:[]);};
 const referenceBodies=new Map();
 for(const {item,id} of records){
  for(const rel of [...list(item.source_relations),...list(item.related_relations)])for(const target of resolve(rel))addEdge(id,target,'notion');
  const bodyKey=item.body_ref||item.sha256||item.viewer?.original?.sha256;
  const body=String(item.content_markdown||item.search_text||(bodyKey&&referenceBodies.get(bodyKey))||'');if(bodyKey&&body)referenceBodies.set(bodyKey,body);
  for(const m of body.matchAll(/https:\/\/(?:www\.|app\.)?notion\.(?:so|com)\/[^\s<>"\])]+/gi))for(const target of resolve(m[0]))addEdge(id,target,'reference');
  for(const m of body.matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)){
   const target=byPath.get(m[1])||(byTitle.get(normalize(m[1]))?.length===1?byTitle.get(normalize(m[1]))[0]:null);addEdge(id,target,'reference');
  }
  const n=byId.get(id);if(!n.categories.length)n.categories=['기타 자료'];
  for(const category of n.categories){const cid='category:'+category;addNode({id:cid,kind:'category',label:category,categories:[category]});addEdge(id,cid,'category');}
  if(item.relative_path){const parent=item.relative_path.split('/').slice(0,-1).join('/');if(parent){const fid='folder:'+parent;addNode({id:fid,kind:'folder',label:parent.split('/').at(-1).replace(/^\d+_/,''),path:parent,categories:n.categories.slice()});addEdge(id,fid,'folder');}}
 }
 const hashes=new Map();for(const d of documents){const hash=d.sha256||d.viewer?.original?.sha256;if(hash){const ids=hashes.get(hash)||[];ids.push(docId(d));hashes.set(hash,ids);}}
 for(const ids of hashes.values())for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++)addEdge(ids[i],ids[j],'duplicate');
 progress('본문의 공통 용어를 비교하고 있습니다…');
 const raw=[],df=new Map(),cache=new Map();
 for(const {item} of records){
  const key=item.body_ref||item.sha256||item.viewer?.original?.sha256;
  let counts=key&&cache.get(key);if(!counts){counts=terms(item.search_text||item.content_markdown||'');if(key)cache.set(key,counts);}
  const weighted=new Map(counts);for(const [term,count] of terms(item.title))weighted.set(term,(weighted.get(term)||0)+count*8);
  raw.push(weighted);for(const t of weighted.keys())df.set(t,(df.get(t)||0)+1);
 }
 const vectors=raw.map(counts=>{
  const values=[];for(const [t,count] of counts){if((df.get(t)||0)>Math.max(5,records.length*.5))continue;values.push([t,(1+Math.log(count))*(1+Math.log((records.length+1)/((df.get(t)||0)+1)))]);}
  values.sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));const top=values.slice(0,96),norm=Math.sqrt(top.reduce((s,[,v])=>s+v*v,0));return new Map(top.map(([t,v])=>[t,norm?v/norm:0]));
 });
 // Compare every pair; no top-N edge truncation. These remain labelled estimates.
 for(let i=0;i<records.length;i++)for(let j=i+1;j<records.length;j++){
  const a=vectors[i],b=vectors[j];let score=0,shared=0;for(const [t,v] of a)if(b.has(t)){score+=v*b.get(t);shared++;}
  if(shared>=4&&score>=.52)addEdge(records[i].id,records[j].id,'similarity',{score:Math.round(score*100),shared});
 }
 const degree=new Map();for(const e of edges){degree.set(e.source,(degree.get(e.source)||0)+1);degree.set(e.target,(degree.get(e.target)||0)+1);}for(const n of nodes)n.degree=degree.get(n.id)||0;
 return {nodes,edges,counts:{documents:documents.length,topics:topics.length},version:1};
}
function subset(model,{kinds=Object.keys(KINDS),matches=null,category='',selected=null,local=false,depth=1}={}){
 const allowed=new Set(kinds),byId=new Map(model.nodes.map(n=>[n.id,n]));
 let ids=new Set(model.nodes.filter(n=>['document','topic'].includes(n.kind)&&(!matches||matches.has(n.id))&&(!category||n.categories.includes(category))).map(n=>n.id));
 let edges=model.edges.filter(e=>allowed.has(e.kind));
 for(const e of edges){const a=byId.get(e.source),b=byId.get(e.target);if(ids.has(e.source)&&['category','folder'].includes(b.kind))ids.add(e.target);if(ids.has(e.target)&&['category','folder'].includes(a.kind))ids.add(e.source);}
 edges=edges.filter(e=>ids.has(e.source)&&ids.has(e.target));
 if(local&&selected&&ids.has(selected)){
  let reached=new Set([selected]);for(let step=0;step<Math.min(2,Math.max(1,depth));step++){const next=new Set(reached);for(const e of edges){if(reached.has(e.source))next.add(e.target);if(reached.has(e.target))next.add(e.source);}reached=next;}ids=reached;edges=edges.filter(e=>ids.has(e.source)&&ids.has(e.target));
 }
 return {nodes:model.nodes.filter(n=>ids.has(n.id)),edges};
}
function layout(model){
 const groups=[...new Set(model.nodes.filter(n=>n.kind==='category').map(n=>n.label))].sort();
 const hash=s=>{let h=2166136261;for(const c of s)h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;};
 const nodes=model.nodes.map(n=>{const group=groups.indexOf(n.categories[0]),angle=2*Math.PI*Math.max(0,group)/Math.max(1,groups.length)-Math.PI/2;const seed=hash(n.id),r=n.kind==='category'?0:55+Math.sqrt(seed%1000)*6,a=(seed%6283)/1000;const ax=Math.cos(angle)*480,ay=Math.sin(angle)*480;return {...n,x:ax+Math.cos(a)*r,y:ay+Math.sin(a)*r,ax,ay,vx:0,vy:0};});
 const map=new Map(nodes.map(n=>[n.id,n]));const edges=model.edges.filter(e=>e.kind!=='folder'&&e.kind!=='similarity').map(e=>[map.get(e.source),map.get(e.target),e.kind]);
 for(let t=0;t<120;t++){
  for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){
   const a=nodes[i],b=nodes[j];let dx=b.x-a.x,dy=b.y-a.y,d2=dx*dx+dy*dy;if(d2>70000)continue;if(d2<.01){dx=.1;dy=.1;d2=.02;}const f=35/Math.max(25,d2);a.vx-=dx*f;a.vy-=dy*f;b.vx+=dx*f;b.vy+=dy*f;
  }
  for(const [a,b,kind] of edges){const dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1,force=(d-(kind==='category'?100:65))*.0018;a.vx+=dx/d*force;b.vx-=dx/d*force;a.vy+=dy/d*force;b.vy-=dy/d*force;}
  for(const n of nodes){const pull=n.kind==='category'?.035:.003;n.vx=(n.vx+(n.ax-n.x)*pull)*.72;n.vy=(n.vy+(n.ay-n.y)*pull)*.72;n.x+=Math.max(-12,Math.min(12,n.vx));n.y+=Math.max(-12,Math.min(12,n.vy));}
 }
 return {...model,nodes:nodes.map(({ax,ay,vx,vy,...n})=>n)};
}
return {KINDS,normalize,notionId,docId,topicId,build,subset,layout};
});
