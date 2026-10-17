const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const zlib=require('node:zlib');
const {encrypt,decrypt,sha}=require('../scripts/build_secure_bundle.cjs');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const password='test-only-nonproduction-passphrase';
function fixture(){
  const key=crypto.randomBytes(32),salt=crypto.randomBytes(16);
  const raw=Buffer.from(JSON.stringify({documents:[{title:'문서 테스트'}],topics:[]}));
  const id=sha(raw),encrypted=encrypt(zlib.gzipSync(raw),key,`company-v2:${id}`);
  const index={id,url:`./secure/objects/${id}.bin`,sha256:sha(encrypted),decoded_bytes:raw.length};
  const manifest={version:2,iterations:600000,salt:salt.toString('base64'),wrapped_key:encrypt(key,crypto.pbkdf2Sync(password,salt,600000,32,'sha256'),'company-v2:key').toString('base64'),index};
  return {key,raw,id,encrypted,index,manifest};
}
test('AES-GCM authenticates nonce, content and asset identity',()=>{
 const key=crypto.randomBytes(32),data=Buffer.from('한글 · tables · 123');
 const enc=encrypt(data,key,'asset-1');assert.deepEqual(decrypt(enc,key,'asset-1'),data);
 assert.throws(()=>decrypt(enc,key,'asset-2'));
 enc[15]^=1;assert.throws(()=>decrypt(enc,key,'asset-1'));
});
test('browser WebCrypto interoperates with builder; rejects bad code, corrupted file and locked access',async()=>{
 const {Vault}=await import(pathToFileURL(path.join(__dirname,'../docs/assets/vault.js')));
 const f=fixture();let payload=f.encrypted;
 const originalFetch=global.fetch;
 global.fetch=async url=>new Response(url==='./secure/manifest.json'?JSON.stringify(f.manifest):payload);
 try{
  const vault=new Vault();
  await assert.rejects(vault.open('wrong-test-code'),/접속 코드/);
  assert.deepEqual(await vault.open(password),JSON.parse(f.raw));
  assert.deepEqual(Buffer.from(await vault.read(f.index)),f.raw);
  await assert.rejects(vault.read({...f.index,url:'https://untrusted.invalid/file'}),/주소/);
  payload=Buffer.from(f.encrypted);payload[16]^=1;
  await assert.rejects(vault.read(f.index),/검증/);
  vault.lock();await assert.rejects(vault.read(f.index),/접속 코드/);
 }finally{global.fetch=originalFetch;}
});
test('remote base must pin exact company repository commit, never third-party or moving branch',async()=>{
 const {Vault}=await import(pathToFileURL(path.join(__dirname,'../docs/assets/vault.js')));
 const f=fixture();f.manifest.asset_base='https://example.com/objects/';const old=global.fetch;
 global.fetch=async()=>new Response(JSON.stringify(f.manifest));
 try{await assert.rejects(new Vault().open(password),/주소/);}finally{global.fetch=old;}
});
test('lock cancels pending login instead of restoring a key after navigation',async()=>{
 const {Vault}=await import(pathToFileURL(path.join(__dirname,'../docs/assets/vault.js')));
 const f=fixture();const old=global.fetch;let release;let began;
 const started=new Promise(r=>began=r);
 global.fetch=async url=>{if(url==='./secure/manifest.json'){began();await new Promise(r=>release=r);return new Response(JSON.stringify(f.manifest));}return new Response(f.encrypted);};
 try{const vault=new Vault();const opening=vault.open(password);await started;vault.lock();release();await assert.rejects(opening,{name:'AbortError'});await assert.rejects(vault.read(f.index),/접속 코드/);}
 finally{global.fetch=old;}
});
