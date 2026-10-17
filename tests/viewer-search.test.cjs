const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const context=vm.createContext({Intl});
vm.runInContext(fs.readFileSync(require.resolve('../docs/assets/viewer-search.js'),'utf8').replaceAll('export ',''),context);
const matches=(strings,term)=>JSON.parse(JSON.stringify(context.matchParts(strings,term)));
test('HWP single-character nodes map a Korean phrase to original glyphs',()=>{
  const result=matches(['무','정','전','전','원','공급장치'],'무정전 전원');
  assert.equal(result.length,1);assert.deepEqual(result[0].map(p=>p.segment),[0,1,2,3,4]);
});
test('PDF matches span runs and retain exact offsets including whitespace',()=>{
  assert.deepEqual(matches(['앞 RT','U 운','영 뒤'],'rtu 운영'),[[{segment:0,start:2,end:4},{segment:1,start:0,end:3},{segment:2,start:0,end:1}]]);
});
test('Unicode normalization maps ligatures, decomposed Korean and fullwidth text',()=>{
  assert.deepEqual(matches(['한 ＲＴＵ ﬃ'],'한 rtu ffi'),[[{segment:0,start:0,end:9}]]);
});
test('literal punctuation, repeated results, empty and absent searches',()=>{
  assert.equal(matches(['A+B A+B'],'a+b').length,2);
  assert.deepEqual(matches(['RTU'],'   '),[]);
  assert.deepEqual(matches(['RTU'],'OPGW'),[]);
  assert.deepEqual(matches(['aaa'],'a'),[[{segment:0,start:0,end:1}],[{segment:0,start:1,end:2}],[{segment:0,start:2,end:3}]]);
});
