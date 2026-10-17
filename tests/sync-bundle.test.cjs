const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const {sha,decrypt}=require('../scripts/build_secure_bundle.cjs');const zlib=require('node:zlib');
test('automatic bundle refresh preserves key envelope and verifies changed source bytes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'company-sync-test-'));
 try{
  const source=path.join(dir,'source'),render=path.join(dir,'render'),output=path.join(dir,'out'),privateDir=path.join(dir,'private');
  fs.mkdirSync(path.join(source,'docs/data'),{recursive:true});fs.mkdirSync(render,{recursive:true});
  const original=path.join(dir,'original.txt'),catalog=path.join(dir,'catalog.json');
  fs.writeFileSync(catalog,JSON.stringify([{relative_path:'original.txt',absolute_path:original}]));
  fs.writeFileSync(path.join(source,'docs/data/documents.json'),JSON.stringify({'original.txt':{title:'original.txt',relative_path:'original.txt',format:'Text'}}));
  fs.writeFileSync(path.join(source,'docs/data/topics.json'),'[]');
  const manifestPath=path.join(output,'docs/secure/manifest.json');
  const prepare=text=>{fs.writeFileSync(original,text);fs.writeFileSync(path.join(render,'text.txt'),text);fs.writeFileSync(path.join(render,'manifest.json'),JSON.stringify({documents:[{relative_path:'original.txt',source_sha256:sha(Buffer.from(text)),kind:'text',assets:[],search_text_file:'text.txt'}]}));};
  const build=(env,input='')=>cp.spawnSync(process.execPath,[path.resolve(__dirname,'../scripts/build_secure_bundle.cjs'),source,render,output,privateDir],{env:{...process.env,COMPANY_CATALOG:catalog,...env},input,encoding:'utf8'});
  prepare('first');assert.equal(build({},'fixture-only-password').status,0);const before=JSON.parse(fs.readFileSync(manifestPath));
  prepare('updated');const result=build({COMPANY_REUSE_MANIFEST:manifestPath});assert.equal(result.status,0,result.stderr);
  const after=JSON.parse(fs.readFileSync(manifestPath));assert.equal(before.wrapped_key,after.wrapped_key);assert.equal(before.salt,after.salt);
  const key=fs.readFileSync(path.join(privateDir,'data-key.bin'));const blob=fs.readFileSync(path.join(output,'docs/secure/objects',after.index.id+'.bin'));
  const index=JSON.parse(zlib.gunzipSync(decrypt(blob,key,'company-v2:'+after.index.id)));
  assert.equal(index.documents[0].search_text,'updated');assert.equal(index.documents[0].viewer.original.sha256,sha(Buffer.from('updated')));
  fs.writeFileSync(original,'changed-after-render');assert.notEqual(build({COMPANY_REUSE_MANIFEST:manifestPath}).status,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
