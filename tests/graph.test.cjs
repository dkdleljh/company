const test=require('node:test'),assert=require('node:assert/strict');
const G=require('../docs/assets/graph-model.js');
const id1='11111111111111111111111111111111',id2='22222222222222222222222222222222';
const docs=[{title:'제어 절차',relative_path:'운영/제어.hwp',notion_page_id:id1,sha256:'same',graph_categories:['RTU'],search_text:'원격단말장치 현장신호 전송경로 제어명령 상태취득'}, {title:'제어 절차 사본',relative_path:'보존/제어.hwp',notion_page_id:id2,sha256:'same',graph_categories:['RTU'],search_text:'원격단말장치 현장신호 전송경로 제어명령 상태취득'}, {title:'도면',relative_path:'그림.png',graph_categories:[],search_text:''}];
const topics=[{id:'overview',title:'RTU 개요',url:'https://www.notion.so/33333333333333333333333333333333',category:['RTU'],source_relations:['https://app.notion.com/'+id1],content_markdown:`참고 [[운영/제어.hwp]] https://www.notion.so/${id2}`}, {id:'other',title:'관련 백과',url:'https://www.notion.so/44444444444444444444444444444444',related_relations:['https://www.notion.so/33333333333333333333333333333333'],category:['RTU']}];
const linked=(g,a,b,kind)=>g.edges.some(e=>e.kind===kind&&new Set([e.source,e.target]).has(a)&&new Set([e.source,e.target]).has(b));
test('all files including textless files are represented; explicit Notion links, references and hash duplicates are distinct',()=>{
 const g=G.build(docs,topics);assert.equal(g.nodes.filter(n=>n.kind==='document').length,3);assert.equal(g.nodes.filter(n=>n.kind==='topic').length,2);
 assert.ok(linked(g,'topic:overview','doc:운영/제어.hwp','notion'));assert.ok(linked(g,'topic:overview','doc:보존/제어.hwp','reference'));assert.ok(linked(g,'topic:overview','doc:운영/제어.hwp','reference'));assert.ok(linked(g,'topic:overview','topic:other','notion'));
 assert.ok(linked(g,'doc:운영/제어.hwp','doc:보존/제어.hwp','duplicate'));assert.ok(linked(g,'doc:그림.png','category:기타 자료','category'));
 assert.ok(g.edges.every(e=>e.source!==e.target));assert.equal(new Set(g.edges.map(e=>JSON.stringify([e.source,e.target,e.kind]))).size,g.edges.length);
});
test('rich text and dashed Notion URLs resolve without exposing external links as graph nodes',()=>{
 assert.equal(G.notionId('https://www.notion.so/11111111-1111-1111-1111-111111111111?x=1'),id1);
 assert.equal(G.notionId(`{{https://www.notion.so/${id1}}}`),id1);
 assert.equal(G.notionId(`[link](https://www.notion.so/${id1})`),id1);
 const g=G.build([{...docs[0],search_text:'https://example.com/secret'}],[]);assert.ok(g.nodes.every(n=>!n.label.includes('example')));
});
test('duplicate content reuse retains references for every duplicate record',()=>{
 const base={...docs[0],body_ref:'same',search_text:`https://www.notion.so/33333333333333333333333333333333`};
 const duplicate={...docs[1],body_ref:'same',search_text:''};const g=G.build([base,duplicate],topics);
 assert.ok(linked(g,'doc:운영/제어.hwp','topic:overview','reference'));assert.ok(linked(g,'doc:보존/제어.hwp','topic:overview','reference'));
});
test('similarity is labelled inferred, needs multiple substantial terms, and never connects only generic boilerplate',()=>{
 const g=G.build(docs,[]);const edge=g.edges.find(e=>e.kind==='similarity');assert.ok(edge);assert.ok(edge.shared>=4);assert.ok(edge.score>=52);
 const noise=G.build([{title:'문서 파일',relative_path:'a',search_text:'자료 문서 파일 업무 기준 사항 내용 사용'},{title:'문서 파일',relative_path:'b',search_text:'자료 문서 파일 업무 기준 사항 내용 사용'}],[]);assert.equal(noise.edges.filter(e=>e.kind==='similarity').length,0);
});
test('filtering keeps every matching document, hides disabled hubs, supports empty and 1/2-hop local views',()=>{
 const g=G.build(docs,topics);const all=G.subset(g);assert.equal(all.nodes.filter(n=>n.kind==='document').length,3);
 const empty=G.subset(g,{matches:new Set()});assert.equal(empty.nodes.length,0);assert.equal(empty.edges.length,0);
 const raw=G.subset(g,{kinds:['notion','duplicate']});assert.ok(raw.nodes.every(n=>!['folder','category'].includes(n.kind)));
 const local=G.subset(g,{kinds:['duplicate'],selected:'doc:운영/제어.hwp',local:true});assert.equal(local.nodes.length,2);
 const two=G.subset(g,{selected:'doc:운영/제어.hwp',local:true,depth:2});assert.ok(two.nodes.length>=local.nodes.length);
 const category=G.subset(g,{category:'RTU'});assert.ok(!category.nodes.some(n=>n.id==='doc:그림.png'));
});
test('ambiguous wiki titles are not guessed and layout is deterministic with finite positions',()=>{
 const duplicateTitles=docs.map(d=>({...d,title:'same'}));const t={id:'t',title:'wiki',content_markdown:'[[same]]'};const g=G.build(duplicateTitles,[t]);assert.equal(g.edges.filter(e=>e.kind==='reference').length,0);
 const a=G.layout(g),b=G.layout(g);assert.deepEqual(a,b);assert.ok(a.nodes.every(n=>Number.isFinite(n.x)&&Number.isFinite(n.y)));
});
