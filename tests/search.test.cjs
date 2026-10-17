const assert = require('node:assert/strict');
const test = require('node:test');
const Search = require('../docs/assets/search.js');

const documents = [
  {id:'opgw-exact', title:'OPGW 시설', relative_path:'02_OPGW_광통신/시설.pdf', format:'PDF', category:'02_OPGW_광통신', size_bytes:20},
  {id:'opgw-separated', title:'OPGW 신규 가공선 시설 기준', relative_path:'공통/기준.hwp', format:'HWP', size_bytes:40},
  {id:'scada', title:'SCADA 업무 지침', relative_path:'운영/매뉴얼.pdf', format:'PDF', category:'01_RTU_SCADA', notion_page_id:'11111111-2222-3333-4444-555555555555'},
  {id:'mountain', title:'팔공산 중계소 설비', relative_path:'공사/목록.xlsx', format:'Excel', search_text:'노후 통신 장비 교체 작업'},
  {id:'korean', title:'전력 통신 운영 기준', relative_path:'공통/기준.pdf', format:'PDF'},
  {id:'rtu', title:'RTU/SCADA 운영 안내', relative_path:'공통/안내.pdf', format:'PDF'},
  {id:'false-acronym', title:'Virtuoso 업무 안내', relative_path:'공통/안내.pdf', format:'PDF'},
  {id:'unrelated', title:'직원 교육 계획', relative_path:'교육/안내.pdf', format:'PDF', search_text:'시설 관리 교육'},
  {id:'body-only', title:'일반 업무 문서', relative_path:'문서.pdf', format:'PDF', search_text:'OPGW 시설'},
  {id:'false-category', title:'안전 표시등 공사', relative_path:'업무/개인메모.txt', category:'메모', format:'Text'},
];
const topics = [
  {id:'t-scada', title:'감시 제어 운영', categories:['RTU·SCADA·EMS'], summary:'SCADA 업무 지침', content_markdown:'설비 관리', source_relations:['https://app.notion.com/p/11111111222233334444555555555555']},
  {id:'t-opgw', title:'OPGW 시설', category:['OPGW·광통신'], summary:'광통신 시설 기준'},
];
const prepared = Search.prepare(documents, topics);
const ids = (rows) => rows.map(row => row.id);

test('normalization handles Unicode width, punctuation and Korean spacing', () => {
  assert.equal(Search.normalize(' ＯＰＧＷ·시설_기준 '), 'opgw 시설 기준');
  assert.deepEqual(ids(Search.searchDocuments(prepared,'전력통신')), ['korean']);
  assert.deepEqual(ids(Search.searchDocuments(prepared,'ＯＰＧＷ시설')), ids(Search.searchDocuments(prepared,'OPGW 시설')));
});

test('multiple words must all match, including path and decrypted body', () => {
  assert.deepEqual(new Set(ids(Search.searchDocuments(prepared,'OPGW 시설'))), new Set(['opgw-exact','opgw-separated','body-only']));
  assert.deepEqual(new Set(ids(Search.searchDocuments(prepared,'SCADA 운영'))), new Set(['scada','rtu']));
  assert.deepEqual(ids(Search.searchDocuments(prepared,'팔공산 교체')), ['mountain']);
  assert.deepEqual(Search.searchDocuments(prepared,'OPGW 급여'), []);
  assert.deepEqual(Search.searchDocuments(prepared,'존재하지않는검색어'), []);
});

test('English acronyms have boundaries and explicit aliases do not widen unrelated searches', () => {
  assert.deepEqual(ids(Search.searchDocuments(prepared,'RTU', {sort:'title'})), ['rtu','scada']);
  assert.equal(Search.searchDocuments(prepared,'OPGW')[0].id, 'opgw-exact');
  assert.ok(Search.searchDocuments(prepared,'광섬유복합가공지선').some(row => row.id === 'opgw-exact'));
  assert.deepEqual(Search.searchDocuments(prepared,'OPGQ'), []);
});

test('known Korean aliases accept spacing while other terms still use AND', () => {
  const aliases = Search.prepare([
    {id:'rtu', title:'RTU 운영'},
    {id:'opgw', title:'OPGW 시설'},
    {id:'other', title:'Virtuoso 운영'},
  ]);
  assert.deepEqual(ids(Search.searchDocuments(aliases,'원격 단말 장치')), ['rtu']);
  assert.deepEqual(ids(Search.searchDocuments(aliases,'광섬유 복합 가공 지선')), ['opgw']);
  assert.deepEqual(ids(Search.searchDocuments(aliases,'원격 단말 장치 운영')), ['rtu']);
  assert.deepEqual(ids(Search.searchDocuments(aliases,'광섬유 복합 가공 지선 시설')), ['opgw']);
  assert.deepEqual(Search.searchDocuments(aliases,'원격 단말 장치 급여'), []);
  assert.deepEqual(Search.searchDocuments(aliases,'R T U'), []);
});

test('Latin boundary matching checks later occurrences without accepting substrings', () => {
  const boundaryCases = Search.prepare([
    {id:'start',title:'RTU 안내'},
    {id:'end',title:'안내 RTU'},
    {id:'later',title:'업무',search_text:'Virtuoso artu rtu'},
    {id:'false',title:'Virtuoso ARTU RTUX RTU12'},
  ]);
  assert.deepEqual(new Set(ids(Search.searchDocuments(boundaryCases,'RTU'))),new Set(['start','end','later']));
});

test('duplicate bodies preserve all records and each title’s independent ranking', () => {
  const body='SCADA 운영과 OPGW 시설 관리';
  const duplicates = Search.prepare([
    Object.freeze({id:'a',title:'OPGW 시설',search_text:body}),
    Object.freeze({id:'b',title:'SCADA 운영',search_text:body}),
    Object.freeze({id:'c',title:'별도 문서',search_text:body}),
  ]);
  const opgw=Search.searchDocuments(duplicates,'OPGW 시설');
  const scada=Search.searchDocuments(duplicates,'SCADA 운영');
  assert.equal(opgw.length,3);
  assert.equal(scada.length,3);
  assert.equal(opgw[0].id,'a');
  assert.equal(scada[0].id,'b');
});

test('exact title ranks ahead of separated title and body-only matches', () => {
  assert.deepEqual(ids(Search.searchDocuments(prepared,'OPGW 시설')), ['opgw-exact','opgw-separated','body-only']);
});

test('category filters use explicit relations and exact folder mappings', () => {
  assert.deepEqual(ids(Search.searchDocuments(prepared,'', {category:'OPGW·광통신'})), ['opgw-exact']);
  assert.deepEqual(ids(Search.searchDocuments(prepared,'', {category:'RTU·SCADA·EMS'})), ['scada']);
  assert.deepEqual(Search.searchDocuments(prepared,'', {category:'안전·점검·복구'}), []);
  assert.deepEqual(ids(Search.searchTopics(prepared,'SCADA 운영', {category:'RTU·SCADA·EMS'})), ['t-scada']);
});

test('format filter, user sorts, deterministic ties, and empty query', () => {
  assert.deepEqual(ids(Search.searchDocuments(prepared,'OPGW 시설',{format:'pdf'})), ['opgw-exact','body-only']);
  assert.deepEqual(ids(Search.searchDocuments(prepared,'OPGW 시설',{sort:'size-desc'})), ['opgw-separated','opgw-exact','body-only']);
  assert.equal(Search.searchDocuments(prepared,'').length, documents.length);
  assert.deepEqual(ids(Search.searchDocuments(prepared,'!!!')), ids(Search.searchDocuments(prepared,'')));
  assert.deepEqual(ids(Search.searchDocuments(prepared,'', {format:'Unknown'})), []);
  const tied = Search.prepare([{id:'b',title:'동일',relative_path:'동일'},{id:'a',title:'동일',relative_path:'동일'}],[]);
  assert.deepEqual(ids(Search.searchDocuments(tied,'동일')), ['a','b']);
});

test('prepare and search leave input records and nested arrays unchanged', () => {
  const before = JSON.stringify({documents,topics});
  const fresh = Search.prepare(documents,topics);
  Search.searchDocuments(fresh,'SCADA',{sort:'path'});
  Search.searchTopics(fresh,'시설');
  assert.equal(JSON.stringify({documents,topics}), before);
  assert.equal(Search.searchDocuments(fresh,'팔공산')[0], documents[3]);
});

test('browser script exposes the same API without dependencies', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../docs/assets/search.js'),'utf8'), context);
  assert.deepEqual(Object.keys(context.CompanySearch).sort(), Object.keys(Search).sort());
  assert.equal(context.CompanySearch.normalize('ＯＰＧＷ'), 'opgw');
});

test('missing optional fields and extension-only formats remain searchable', () => {
  const sparse = Search.prepare([{title:'원격단말장치',extension:'.pdf'}, {title:'한글'}]);
  assert.equal(Search.searchDocuments(sparse,'RTU', {format:'PDF'}).length, 1);
  assert.equal(Search.searchDocuments(Search.prepare(), 'test').length, 0);
  assert.equal(Search.searchTopics(Search.prepare(), '').length, 0);
});
