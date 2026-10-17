/* Map normalized matches back to original text offsets without changing document text. */
export function matchParts(strings, term) {
  const fold=s=>s.normalize('NFKC').toLocaleLowerCase('ko').replace(/\s/gu,'');
  const needle=fold(term);if(!needle)return [];
  let text='';const positions=[];
  const segmenter=new Intl.Segmenter('ko',{granularity:'grapheme'});
  strings.forEach((value,segment)=>{
    for(const {segment:cluster,index:start} of segmenter.segment(value)){
      const normalized=fold(cluster);text+=normalized;
      for(let i=0;i<normalized.length;i++)positions.push({segment,start,end:start+cluster.length});
    }
  });
  const matches=[];
  for(let at=text.indexOf(needle);at>=0;at=text.indexOf(needle,at+needle.length)){
    const parts=[];
    for(const pos of positions.slice(at,at+needle.length)){
      const last=parts.at(-1);
      if(last&&last.segment===pos.segment)last.end=pos.end;else parts.push({...pos});
    }
    matches.push(parts);
  }
  return matches;
}
export function parseSvg(raw) {
  const doc=new DOMParser().parseFromString(new TextDecoder().decode(raw),'image/svg+xml');
  if(doc.querySelector('parsererror')||doc.documentElement.localName!=='svg')throw new Error('한글 페이지를 읽지 못했습니다.');
  return doc;
}
export function svgStrings(doc){return [...doc.querySelectorAll('text')].map(node=>node.textContent||'');}
export function showBoxes(wrapper,boxes){
  wrapper.querySelector('.search-highlights')?.remove();
  const layer=document.createElement('div');layer.className='search-highlights';layer.setAttribute('aria-hidden','true');
  for(const box of boxes){
    if(!(box.width>0&&box.height>0))continue;
    const mark=document.createElement('span');mark.className='search-highlight';
    Object.assign(mark.style,{left:`${box.x}%`,top:`${box.y}%`,width:`${box.width}%`,height:`${box.height}%`});layer.append(mark);
  }
  wrapper.append(layer);
}
export async function pdfBoxes(pdfLibrary,page,viewport,wrapper,term,isCurrent){
  const content=await page.getTextContent();if(!isCurrent())return;
  const container=document.createElement('div');container.className='search-text-layer';
  container.setAttribute('aria-hidden','true');
  container.style.setProperty('--total-scale-factor',viewport.scale*viewport.userUnit);
  wrapper.append(container);
  const layer=new pdfLibrary.TextLayer({textContentSource:content,container,viewport});
  container.style.width=`${viewport.rawDims.pageWidth*viewport.scale*viewport.userUnit}px`;
  container.style.height=`${viewport.rawDims.pageHeight*viewport.scale*viewport.userUnit}px`;
  try{
    await layer.render();if(!isCurrent())return;
    const base=wrapper.getBoundingClientRect(),boxes=[];
    for(const parts of matchParts(layer.textContentItemsStr,term))for(const part of parts){
      const node=layer.textDivs[part.segment]?.firstChild;if(!node)continue;
      const range=document.createRange();range.setStart(node,part.start);range.setEnd(node,part.end);
      for(const r of range.getClientRects())boxes.push({x:(r.left-base.left)/base.width*100,y:(r.top-base.top)/base.height*100,width:r.width/base.width*100,height:r.height/base.height*100});
    }
    if(isCurrent())showBoxes(wrapper,boxes);
  }finally{layer.cancel();container.remove();}
}
export async function svgBoxes(raw,wrapper,term,signal,isCurrent){
  const doc=parseSvg(raw);if(!matchParts(svgStrings(doc),term).length)return;
  // Measure in an isolated, script-free document. The visible original stays an image.
  const svg=doc.documentElement;
  for(const element of doc.querySelectorAll('script,foreignObject,iframe,object,embed,a,animate,animateTransform,set'))element.remove();
  for(const element of [svg,...svg.querySelectorAll('*')])for(const attr of [...element.attributes]){
    if(/^on/i.test(attr.name)||(/^(href|src)$/i.test(attr.localName)&&!/^#|^data:image\//i.test(attr.value)))element.removeAttributeNode(attr);
  }
  const frame=document.createElement('iframe');frame.className='svg-measure-frame';frame.setAttribute('sandbox','allow-same-origin');frame.setAttribute('aria-hidden','true');frame.tabIndex=-1;
  frame.style.width=`${parseFloat(svg.getAttribute('width'))||794}px`;frame.style.height=`${parseFloat(svg.getAttribute('height'))||1123}px`;
  const csp="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'";
  frame.srcdoc=`<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html,body{margin:0;padding:0;background:white}svg{display:block}</style>${new XMLSerializer().serializeToString(svg)}`;
  let abort;
  try{
    await new Promise((resolve,reject)=>{
      abort=()=>{frame.remove();reject(new DOMException('Aborted','AbortError'));};
      if(signal.aborted){abort();return;}
      signal.addEventListener('abort',abort,{once:true});frame.onload=resolve;frame.onerror=()=>reject(new Error('검색어 위치를 표시하지 못했습니다.'));document.body.append(frame);
    });
    const inner=frame.contentDocument;await inner.fonts.ready;if(!isCurrent())return;
    const root=inner.querySelector('svg'),base=root.getBoundingClientRect(),nodes=[...root.querySelectorAll('text')],boxes=[];
    for(const parts of matchParts(nodes.map(n=>n.textContent||''),term))for(const part of parts){
      const node=nodes[part.segment],matrix=node.getScreenCTM();
      for(let i=part.start;i<Math.min(part.end,node.getNumberOfChars());i++){
        const r=node.getExtentOfChar(i);
        const points=[[r.x,r.y],[r.x+r.width,r.y],[r.x,r.y+r.height],[r.x+r.width,r.y+r.height]].map(([x,y])=>new DOMPoint(x,y).matrixTransform(matrix));
        const left=Math.min(...points.map(p=>p.x)),top=Math.min(...points.map(p=>p.y));
        boxes.push({x:(left-base.left)/base.width*100,y:(top-base.top)/base.height*100,width:(Math.max(...points.map(p=>p.x))-left)/base.width*100,height:(Math.max(...points.map(p=>p.y))-top)/base.height*100});
      }
    }
    if(isCurrent())showBoxes(wrapper,boxes);
  }finally{signal.removeEventListener('abort',abort);frame.remove();}
}
