/* Sheet names stay in the encrypted catalog and are inserted as text only. */
export class SheetNavigation {
  constructor(document, navigate) {
    this.document=document;this.navigate=navigate;
    this.box=document.querySelector('#sheetNavigation');
    this.select=document.querySelector('#sheetSelect');
    this.count=document.querySelector('#sheetCount');
    this.position=document.querySelector('#sheetPosition');
    this.pageLabel=document.querySelector('#pageLabel');
    this.select.addEventListener('change',()=>{
      const sheet=this.sheets[Number(this.select.value)];
      if(!this.select.disabled&&sheet?.first_page)this.navigate(sheet.first_page);
    });
    this.clear();
  }
  clear(){
    this.sheets=[];this.box.hidden=true;this.select.replaceChildren();
    this.count.textContent='';this.position.textContent='';this.pageLabel.textContent='페이지';
  }
  set(doc,total){
    this.clear();
    if(doc.viewer.kind!=='pdf'||! /\.(xlsx?|xlsm|ods)$/i.test(doc.relative_path))return;
    this.box.hidden=false;this.pageLabel.textContent='전체 페이지';
    const input=doc.viewer.sheets;
    if(!Array.isArray(input)||!input.length){this.select.disabled=true;this.position.textContent='시트 정보를 확인할 수 없습니다. 전체 페이지로 이동해 주세요.';return;}
    let cursor=1;
    const valid=input.every(s=>{
      if(!s||typeof s.name!=='string'||!s.name)return false;
      if(s.first_page===null&&s.last_page===null)return true;
      if(!Number.isInteger(s.first_page)||!Number.isInteger(s.last_page)||s.first_page!==cursor||s.last_page<s.first_page||s.last_page>total)return false;
      cursor=s.last_page+1;return true;
    })&&cursor===total+1;
    this.sheets=input.map(s=>({name:typeof s?.name==='string'?s.name:'이름 없는 시트',hidden:!!s?.hidden,
      first_page:valid?s.first_page:null,last_page:valid?s.last_page:null}));
    this.count.textContent=`(${this.sheets.length}개)`;
    for(const [i,sheet] of this.sheets.entries()){
      const option=this.document.createElement('option');option.value=String(i);
      option.textContent=`${i+1}. ${sheet.name}${sheet.hidden?' · 숨김 시트':''}${sheet.first_page?'':' · 페이지 연결 없음'}`;
      option.disabled=!sheet.first_page;this.select.append(option);
    }
    this.update(1,false);
  }
  update(page,textMode){
    if(this.box.hidden||!this.sheets.length)return;
    this.select.disabled=textMode||!this.sheets.some(s=>s.first_page);
    if(textMode){this.position.textContent='전체 시트의 텍스트를 함께 표시합니다.';return;}
    const index=this.sheets.findIndex(s=>s.first_page&&page>=s.first_page&&page<=s.last_page);
    this.select.value=index<0?'':String(index);
    this.position.textContent=index<0?'시트별 페이지를 확인할 수 없습니다. 전체 페이지로 이동해 주세요.':
      `${this.sheets[index].name} · 시트 안 ${page-this.sheets[index].first_page+1} / ${this.sheets[index].last_page-this.sheets[index].first_page+1}쪽`;
  }
}
