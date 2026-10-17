import { Vault } from './vault.js';
const $=s=>document.querySelector(s);
const vault=new Vault();
const PAGE_SIZE=40;
let topics=[],documents=[],index=null,category='전체',format='전체',query='',visible=PAGE_SIZE;
let viewer=null,viewerSequence=0,renderSequence=0,renderTask=null,pdfLoading=null;
let pdfLibrary=null,objectURLs=[];
const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeLink=value=>{try{const url=new URL(value);return url.protocol==='https:'&& /(^|\.)notion\.(so|com)$/.test(url.hostname)?url.href:'#';}catch{return '#';}};
const normalize=v=>window.CompanySearch.normalize(v);
function message(text){$('#viewerStatus').hidden=false;$('#viewerStatus').textContent=text;}
function bytes(size){if(!size)return '—';const i=Math.min(Math.floor(Math.log(size)/Math.log(1024)),3);return `${(size/1024**i).toFixed(i?1:0)} ${['B','KB','MB','GB'][i]}`;}
function type(doc){return doc.format||doc.extension?.replace(/^\./,'').toUpperCase()||'기타';}
function categories(topic){return [...new Set([topic.category,topic.categories].flatMap(v=>Array.isArray(v)?v:(v?[v]:[])))];}
function topicMarkup(text){return String(text||'').split('\n').map(line=>{
  if(!line.trim())return '';
  const inline=s=>escapeHtml(s).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/`([^`]+)`/g,'<code>$1</code>');
  if(/^#{1,3} /.test(line))return `<h3>${inline(line.replace(/^#+ /,''))}</h3>`;
  if(/^- /.test(line))return `<p class="list-item">• ${inline(line.slice(2))}</p>`;
  return `<p>${inline(line)}</p>`;
}).join('');}
function snippet(doc){
  if(!query)return '';
  const body=String(doc.search_text||'').replace(/\s+/g,' ');
  const tokens=normalize(query).split(/\s+/).filter(Boolean);
  let at=-1;
  for(const token of tokens){at=body.toLocaleLowerCase('ko').indexOf(token);if(at>=0)break;}
  return at<0 ? '' : `${at>35?'…':''}${body.slice(Math.max(0,at-35),at+100)}${at+100<body.length?'…':''}`;
}
$('#loginForm').addEventListener('submit',async event=>{
  event.preventDefault();const button=$('#loginButton');if(button.disabled)return;
  button.disabled=true;$('#loginError').textContent='문서 목록을 여는 중입니다…';
  try {
    const data=await vault.open($('#password').value);$('#password').value='';
    topics=data.topics;documents=data.documents;index=window.CompanySearch.prepare(documents,topics);
    $('#topicCount').textContent=topics.length;$('#docCount').textContent=documents.length;
    $('#viewableCount').textContent=documents.filter(d=>d.viewer?.kind!=='unsupported').length;
    const stamp=new Date(data.generated_at).toLocaleDateString('ko-KR');
    $('#syncState').textContent=`사이트 갱신 ${stamp}`;$('#snapshotInfo').textContent=`Notion 저장본 · 사이트 갱신 ${stamp}`;
    createFilters();renderAll();$('#loginView').hidden=true;$('#appView').hidden=false;
    $('#loginError').textContent='';$('#searchInput').focus();
  } catch(error){vault.lock();$('#loginError').textContent=error.message;$('#password').select();}
  finally{button.disabled=false;}
});
function lockPortal(focus=true){
  closeViewer();$('#topicDialog').close();vault.lock();topics=[];documents=[];index=null;
  $('#topicGrid').replaceChildren();$('#documentRows').replaceChildren();$('#dialogContent').replaceChildren();
  for(const id of ['viewerTitle','viewerPath','viewerEngine','viewerNote','dialogTitle','dialogSummary','dialogCategory','searchStatus','findStatus'])$('#'+id).textContent='';
  $('#viewerSearch').value='';$('#viewerNotionLink').removeAttribute('href');$('#dialogNotionLink').removeAttribute('href');
  $('#appView').hidden=true;$('#loginView').hidden=false;$('#password').value='';if(focus)$('#password').focus();
  category='전체';format='전체';query='';visible=PAGE_SIZE;$('#searchInput').value='';
}
$('#logoutBtn').addEventListener('click',()=>lockPortal());
function createFilters(){
  const cats=['전체',...new Set(topics.flatMap(categories))];
  const formats=['전체',...new Set(documents.map(type))].sort((a,b)=>a==='전체'?-1:b==='전체'?1:a.localeCompare(b,'ko'));
  $('#categoryFilters').innerHTML=cats.map(c=>`<button class="chip" type="button" data-category="${escapeHtml(c)}" aria-pressed="${c===category}">${escapeHtml(c)}</button>`).join('');
  $('#formatFilters').innerHTML=formats.map(f=>`<button class="chip" type="button" data-format="${escapeHtml(f)}" aria-pressed="${f===format}">${escapeHtml(f)}</button>`).join('');
  updateFilters();
}
function updateFilters(){document.querySelectorAll('[data-category],[data-format]').forEach(el=>{
  const on=el.dataset.category?el.dataset.category===category:el.dataset.format===format;
  el.classList.toggle('active',on);el.setAttribute('aria-pressed',on);
});}
$('#categoryFilters').addEventListener('click',e=>{const b=e.target.closest('[data-category]');if(b){category=b.dataset.category;visible=PAGE_SIZE;updateFilters();renderAll();}});
$('#formatFilters').addEventListener('click',e=>{const b=e.target.closest('[data-format]');if(b){format=b.dataset.format;visible=PAGE_SIZE;updateFilters();renderAll();}});
$('#resetFilters').addEventListener('click',()=>{category=format='전체';query='';visible=PAGE_SIZE;$('#searchInput').value='';$('#sortSelect').value='relevance';updateFilters();renderAll();$('#searchInput').focus();});
$('#searchInput').addEventListener('input',e=>{query=e.target.value;visible=PAGE_SIZE;renderAll();});
$('#sortSelect').addEventListener('change',()=>{visible=PAGE_SIZE;renderAll();});
$('#loadMoreBtn').addEventListener('click',()=>{visible+=PAGE_SIZE;renderAll();});
function renderAll(){
  if(!index)return;
  const found=window.CompanySearch.searchDocuments(index,query,{category,format,sort:$('#sortSelect').value});
  const ts=window.CompanySearch.searchTopics(index,query,{category});
  $('#resultCount').textContent=found.length;
  $('#searchStatus').textContent=`${query.trim()?`“${query.trim()}” · `:''}문서 ${found.length}개, 백과 ${ts.length}개${category!=='전체'?` · ${category}`:''}${format!=='전체'?` · ${format}`:''}`;
  $('#documentRows').innerHTML=found.slice(0,visible).map(doc=>{
    const hint=snippet(doc);const v=doc.viewer;
    const label=v.kind==='unsupported'?'파일 안내':v.kind==='pdf'&&v.fidelity==='original-bytes'?'원본 보기':'바로 보기';
    return `<tr><td data-label="문서"><div class="doc-title">${escapeHtml(doc.title)}</div><div class="doc-path">${escapeHtml(doc.relative_path)}</div>${hint?`<p class="search-snippet">${escapeHtml(hint)}</p>`:''}</td><td data-label="분야">${escapeHtml(String(doc.scope||doc.category||'기타').replace(/^\d+_/,'').replaceAll('_',' '))}</td><td data-label="형식"><span class="format-badge">${escapeHtml(type(doc))}</span></td><td data-label="크기">${bytes(doc.size_bytes)}</td><td data-label="보기"><button type="button" class="preview-btn" data-preview-path="${escapeHtml(doc.relative_path)}">${label}</button></td><td data-label="원본 파일"><a class="notion-link" href="${safeLink(doc.notion_url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(doc.title)} Notion 원본">Notion ↗</a></td></tr>`;
  }).join('')||'<tr><td colspan="6" class="empty-state">일치하는 문서가 없습니다. 검색어를 줄이거나 검색·필터를 초기화해 주세요.</td></tr>';
  $('#loadMoreBtn').hidden=visible>=found.length;$('#loadMoreBtn').textContent=`더 보기 (${Math.min(visible,found.length)} / ${found.length})`;
  $('#topicGrid').innerHTML=ts.map((t,i)=>`<article class="topic-card" role="button" tabindex="0" data-topic-id="${escapeHtml(t.id)}"><span class="topic-index">${String(i+1).padStart(2,'0')}</span><h4>${escapeHtml(t.title)}</h4><p>${escapeHtml(t.summary)}</p><div class="topic-tags">${categories(t).map(c=>`<span>${escapeHtml(c)}</span>`).join('')}</div></article>`).join('')||'<p class="empty-state">일치하는 백과 문서가 없습니다.</p>';
}
$('#topicGrid').addEventListener('click',e=>{const id=e.target.closest('[data-topic-id]')?.dataset.topicId;const t=topics.find(t=>t.id===id);if(!t)return;
  $('#dialogCategory').textContent=categories(t).join(' · ');$('#dialogTitle').textContent=t.title;$('#dialogSummary').textContent=t.summary;
  $('#dialogContent').innerHTML=topicMarkup(t.content_markdown);$('#dialogNotionLink').href=safeLink(t.url);$('#topicDialog').showModal();
});
$('#topicGrid').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){const card=e.target.closest('[data-topic-id]');if(card){e.preventDefault();card.click();}}});
$('#closeDialog').addEventListener('click',()=>$('#topicDialog').close());
function backdrop(event){if(event.target!==event.currentTarget)return;const r=event.currentTarget.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)event.currentTarget.close();}
$('#topicDialog').addEventListener('click',backdrop);
$('#documentRows').addEventListener('click',e=>{const path=e.target.closest('[data-preview-path]')?.dataset.previewPath;const doc=documents.find(d=>d.relative_path===path);if(doc)openDocument(doc);});
function disposeViewer(){
  viewerSequence++;renderSequence++;renderTask?.cancel();renderTask=null;pdfLoading?.destroy();pdfLoading=null;
  viewer?.controller.abort();viewer?.loadingTask?.destroy();viewer=null;
  objectURLs.forEach(URL.revokeObjectURL);objectURLs=[];$('#viewerContent').replaceChildren();
}
function closeViewer(){disposeViewer();$('#documentDialog').close();}
$('#closeDocumentDialog').addEventListener('click',closeViewer);
$('#documentDialog').addEventListener('click',backdrop);
$('#documentDialog').addEventListener('close',disposeViewer);
async function openDocument(doc){
  disposeViewer();const seq=viewerSequence;
  viewer={doc,controller:new AbortController(),page:1,total:1,pdf:null,raw:null,text:false,findPages:[],findAt:-1,searchSequence:0};
  $('#viewerTitle').textContent=doc.title;$('#viewerPath').textContent=doc.relative_path;$('#viewerFormat').textContent=type(doc);
  $('#viewerNotionLink').href=safeLink(doc.notion_url);$('#viewerSearch').value='';$('#findStatus').textContent='';$('#zoomSelect').value='fit';
  $('#viewerTextMode').setAttribute('aria-pressed','false');$('#viewerTextMode').textContent='텍스트 보기';$('#viewerTextMode').hidden=!doc.search_text;
  $('#viewerDownload').hidden=!doc.viewer.original;$('#viewerDownload').textContent='원본 파일 저장';$('#viewerDownload').disabled=false;
  $('#viewerEngine').textContent='문서를 여는 중…';$('#viewerNote').textContent='';$('#retryLoad').hidden=true;
  if(!$('#documentDialog').open)$('#documentDialog').showModal();message('문서를 불러오는 중입니다…');updateNavigation();
  try {
    const v=doc.viewer;
    if(v.kind==='pdf'){
      if(!pdfLibrary){pdfLibrary=await import('./pdfjs/pdf.mjs');pdfLibrary.GlobalWorkerOptions.workerSrc=new URL('./pdfjs/pdf.worker.mjs',import.meta.url).href;}
      if(seq!==viewerSequence)return;
      const raw=await vault.read(v.assets[0],viewer.controller.signal);if(seq!==viewerSequence)return;viewer.raw=raw;
      const loadingTask=pdfLibrary.getDocument({data:raw.slice(),cMapUrl:new URL('./pdfjs/cmaps/',import.meta.url).href,cMapPacked:true,standardFontDataUrl:new URL('./pdfjs/standard_fonts/',import.meta.url).href,wasmUrl:new URL('./pdfjs/wasm/',import.meta.url).href,isEvalSupported:false,enableXfa:false});
      pdfLoading=loadingTask;loadingTask.onPassword=()=>{loadingTask.destroy();if(seq===viewerSequence)showError('암호로 보호된 PDF입니다. 원본 파일을 저장한 뒤 문서 비밀번호로 열어 주세요.');};
      const pdf=await loadingTask.promise;if(seq!==viewerSequence){loadingTask.destroy();return;}viewer.loadingTask=loadingTask;pdfLoading=null;viewer.pdf=pdf;viewer.total=pdf.numPages;
    } else if(v.kind==='svg-pages')viewer.total=v.assets.length;
    $('#viewerEngine').textContent=v.kind==='pdf'&&v.fidelity==='original-bytes'?'원본 PDF':v.kind==='svg-pages'?'한글 문서 페이지':v.kind==='pdf'?'문서 페이지 변환':v.kind==='image'?'원본 이미지':v.kind==='unsupported'?'원본 파일 안내':'본문 보기';
    $('#viewerNote').textContent=v.fidelity==='original-bytes'?'원본 파일을 변경하지 않고 표시합니다.':v.kind==='unsupported'?v.reason:(v.kind==='pdf'||v.kind==='svg-pages')?'표·그림을 포함한 변환 미리보기입니다. 원본 프로그램과 일부 글꼴·배치가 다를 수 있습니다.':v.reason||'';
    if(v.kind==='pdf'&&/\.(xlsx?|xlsm)$/i.test(doc.relative_path))$('#viewerNote').textContent+=' 긴 시트는 나눠 표시하며, 경계의 일부 행이 겹칠 수 있습니다.';
    await renderPage();
  } catch(error){if(seq===viewerSequence&&error.name!=='AbortError')showError(error.message);}
}
function showError(text){message(text);$('#retryLoad').hidden=false;}
$('#retryLoad').addEventListener('click',()=>{if(viewer)openDocument(viewer.doc);});
function updateNavigation(){if(!viewer)return;const visual=!viewer.text&&['pdf','svg-pages'].includes(viewer.doc.viewer.kind);
  $('#pageNumber').value=viewer.page;$('#pageNumber').max=viewer.total;$('#pageTotal').textContent=`/ ${viewer.total}`;
  $('#pagePrev').disabled=!visual||viewer.page<=1;$('#pageNext').disabled=!visual||viewer.page>=viewer.total;$('#pageNumber').disabled=!visual;
  $('#zoomSelect').disabled=viewer.text||viewer.doc.viewer.kind==='unsupported'||viewer.doc.viewer.kind==='text';
}
function highlighted(text,term){
  if(!term.trim())return escapeHtml(text);const expression=term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return text.split(new RegExp(`(${expression})`,'giu')).map((part,i)=>i%2?`<mark>${escapeHtml(part)}</mark>`:escapeHtml(part)).join('');
}
async function renderPage(){
  if(!viewer)return;const state=viewer,seq=++renderSequence;renderTask?.cancel();renderTask=null;
  const content=$('#viewerContent');content.replaceChildren();message('페이지를 표시하는 중입니다…');updateNavigation();
  try{
    const v=state.doc.viewer;
    if(state.text||v.kind==='text'){
      const pre=document.createElement('pre');pre.className='plain-document';pre.innerHTML=highlighted(state.doc.search_text||'표시할 본문이 없습니다.',$('#viewerSearch').value);content.append(pre);
    }else if(v.kind==='pdf'&&state.pdf){
      const page=await state.pdf.getPage(state.page);if(seq!==renderSequence)return;
      const normal=page.getViewport({scale:1});const zoom=$('#zoomSelect').value;
      const scale=zoom==='fit'?Math.max(.01,(content.clientWidth-parseFloat(getComputedStyle(content).paddingLeft)-parseFloat(getComputedStyle(content).paddingRight)-2)/normal.width):Number(zoom);
      const vp=page.getViewport({scale});const ratio=Math.min(devicePixelRatio||1,2,Math.sqrt(16000000/(vp.width*vp.height)),16000/vp.width,16000/vp.height);
      const wrapper=document.createElement('div');wrapper.className='pdf-page';const canvas=document.createElement('canvas');canvas.id='viewerCanvas';canvas.setAttribute('aria-label',`${state.page}쪽 문서 페이지. 텍스트 보기로 내용을 읽을 수 있습니다.`);
      canvas.width=Math.ceil(vp.width*ratio);canvas.height=Math.ceil(vp.height*ratio);canvas.style.width=`${vp.width}px`;canvas.style.height=`${vp.height}px`;wrapper.append(canvas);content.append(wrapper);
      renderTask=page.render({canvasContext:canvas.getContext('2d'),viewport:vp,transform:ratio===1?null:[ratio,0,0,ratio,0,0]});await renderTask.promise;
    }else if(v.kind==='svg-pages'||v.kind==='image'){
      const asset=v.assets[v.kind==='svg-pages'?state.page-1:0];const raw=await vault.read(asset,state.controller.signal);if(seq!==renderSequence)return;
      objectURLs.forEach(URL.revokeObjectURL);objectURLs=[];
      const url=URL.createObjectURL(new Blob([raw],{type:asset.mime}));objectURLs.push(url);
      const img=document.createElement('img');img.className='visual-page';img.alt=`${state.doc.title} ${state.page}쪽`;img.src=url;
      if($('#zoomSelect').value!=='fit'){img.style.width=`${794*Number($('#zoomSelect').value)}px`;img.style.maxWidth='none';}
      content.append(img);await img.decode();if(seq!==renderSequence)return;
    }else{
      const box=document.createElement('div');box.className='viewer-no-result';box.textContent=v.reason||'이 파일 형식은 브라우저에서 페이지로 표시할 수 없습니다. 원본 파일을 저장하거나 Notion에서 열어 주세요.';content.append(box);
    }
    if(seq===renderSequence){$('#viewerStatus').hidden=true;content.scrollTop=0;}
  }catch(error){if(seq===renderSequence&&error.name!=='RenderingCancelledException'&&error.name!=='AbortError')showError(error.message);}
}
function changePage(n){if(!viewer)return;viewer.page=Math.min(viewer.total,Math.max(1,Math.trunc(Number(n)||1)));renderPage();}
$('#pagePrev').addEventListener('click',()=>changePage(viewer.page-1));$('#pageNext').addEventListener('click',()=>changePage(viewer.page+1));
$('#pageNumber').addEventListener('change',e=>changePage(e.target.value));$('#zoomSelect').addEventListener('change',renderPage);
$('#pageNumber').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();changePage(e.target.value);}});
$('#viewerTextMode').addEventListener('click',()=>{if(!viewer)return;viewer.text=!viewer.text;$('#viewerTextMode').setAttribute('aria-pressed',viewer.text);$('#viewerTextMode').textContent=viewer.text?'페이지 보기':'텍스트 보기';renderPage();});
let findTimer;
$('#viewerSearch').addEventListener('input',()=>{clearTimeout(findTimer);findTimer=setTimeout(()=>findInDocument(false),220);});
$('#viewerSearch').addEventListener('keydown',e=>{if(e.key==='Enter'){clearTimeout(findTimer);findInDocument(true);}});
$('#findNext').addEventListener('click',()=>findInDocument(true));
async function findInDocument(next){
  if(!viewer)return;const state=viewer;let seq;
  try {
  const term=$('#viewerSearch').value.trim();seq=++state.searchSequence;
  if(!term){$('#findStatus').textContent='';state.findTerm='';if(state.text)renderPage();return;}
  if(state.pdf&&!state.text){
    if(state.findTerm!==term){
      const foundPages=[];state.findAt=-1;$('#findStatus').textContent='전체 페이지를 찾는 중…';
      for(let p=1;p<=state.total;p++){
        const page=await state.pdf.getPage(p);const text=await page.getTextContent();
        if(viewer!==state||seq!==state.searchSequence)return;
        const compact=s=>normalize(s).replace(/\s/g,'');
        if(compact(text.items.map(i=>i.str||'').join(' ')).includes(compact(term)))foundPages.push(p);
      }
      state.findPages=foundPages;state.findTerm=term;
    }
    if(viewer!==state||seq!==state.searchSequence)return;
    if(!state.findPages.length){$('#findStatus').textContent='일치하는 페이지가 없습니다.';return;}
    state.findAt=next?(state.findAt+1)%state.findPages.length:0;
    $('#findStatus').textContent=`${state.findAt+1} / ${state.findPages.length}개 페이지`;changePage(state.findPages[state.findAt]);
  }else{
    if(!state.text){state.text=true;$('#viewerTextMode').setAttribute('aria-pressed','true');$('#viewerTextMode').textContent='페이지 보기';}
    await renderPage();if(viewer!==state)return;
    const marks=[...$('#viewerContent').querySelectorAll('mark')];
    state.findAt=next?(state.findAt+1)%Math.max(1,marks.length):0;
    $('#findStatus').textContent=marks.length?`${state.findAt+1} / ${marks.length}개`:'일치하는 내용이 없습니다.';
    marks[state.findAt]?.scrollIntoView({block:'center'});
  }
  }catch(error){if(viewer===state && seq===state.searchSequence && error.name!=='AbortError')$('#findStatus').textContent='검색을 완료하지 못했습니다. 다시 시도해 주세요.';}
}
$('#viewerDownload').addEventListener('click',async()=>{
  if(!viewer?.doc.viewer.original)return;const state=viewer,button=$('#viewerDownload'),original=state.doc.viewer.original;
  button.disabled=true;
  try{
    const parts=[];for(let i=0;i<original.assets.length;i++){button.textContent=`원본 준비 ${i+1}/${original.assets.length}`;parts.push(await vault.read(original.assets[i],state.controller.signal));}
    if(viewer!==state)return;
    const blob=new Blob(parts,{type:'application/octet-stream'});const url=URL.createObjectURL(blob);objectURLs.push(url);
    const a=document.createElement('a');a.href=url;a.download=state.doc.relative_path.split('/').pop();a.click();
  }catch(error){if(viewer===state&&error.name!=='AbortError')showError(error.message);}
  finally{if(viewer===state){button.disabled=false;button.textContent='원본 파일 저장';}}
});
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'&&!$('#appView').hidden){e.preventDefault();$('#searchInput').focus();}});
let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(viewer&&$('#documentDialog').open&&$('#zoomSelect').value==='fit')renderPage();},150);});
window.addEventListener('pagehide',()=>lockPortal(false));
