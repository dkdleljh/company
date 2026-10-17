#!/usr/bin/env node
/* Build encrypted, deduplicated assets. Password is accepted on stdin only. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const gzip = promisify(zlib.gzip);
const ITERATIONS = 600000;
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function encrypt(data, key, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([iv, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
}
function decrypt(data, key, aad) {
  const decipher = crypto.createDecipheriv('aes-256-gcm',key,data.subarray(0,12));
  decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([decipher.update(data.subarray(12,-16)),decipher.final()]);
}
async function main() {
  const [sourceSite, renderedRoot, outputSite, privateRoot] = process.argv.slice(2);
  if (!privateRoot) throw new Error('Usage: build_secure_bundle.cjs sourceSite renderedRoot outputSite privateRoot < password-input');
  const prior = process.env.COMPANY_REUSE_MANIFEST ? JSON.parse(fs.readFileSync(process.env.COMPANY_REUSE_MANIFEST)) : null;
  if(prior && (prior.version!==2 || prior.iterations!==ITERATIONS || !prior.wrapped_key || !prior.salt))throw new Error('Invalid existing key envelope');
  const password = prior ? '' : fs.readFileSync(0,'utf8').trimEnd();
  if (!prior && !password) throw new Error('Password required on stdin');
  fs.mkdirSync(privateRoot,{recursive:true,mode:0o700});
  const keyPath = path.join(privateRoot,'data-key.bin');
  if(prior && !fs.existsSync(keyPath))throw new Error('Existing data key required for unattended refresh');
  const key = fs.existsSync(keyPath) ? fs.readFileSync(keyPath) : crypto.randomBytes(32);
  if(key.length!==32) throw new Error('Invalid private key length');
  fs.writeFileSync(keyPath,key,{mode:0o600}); fs.chmodSync(keyPath,0o600);
  const secureRoot = path.join(outputSite,'docs/secure'); fs.mkdirSync(secureRoot,{recursive:true});
  const objectRoot = path.join(secureRoot,'objects'); fs.mkdirSync(objectRoot,{recursive:true});
  const descriptors = new Map();
  async function put(raw, mime) {
    const id = sha(raw); const aad = `company-v2:${id}`;
    if(descriptors.has(id)) return {...descriptors.get(id),mime};
    const target=path.join(objectRoot,`${id}.bin`);
    let encrypted;
    if(fs.existsSync(target)) {
      encrypted=fs.readFileSync(target);
      // Reuse only if the existing authenticated object is the exact input.
      const old=decrypt(encrypted,key,aad);
      if(sha(zlib.gunzipSync(old))!==id) throw new Error('Cached object mismatch');
    } else { const compressed=await gzip(raw,{level:6});encrypted=encrypt(compressed,key,aad);fs.writeFileSync(target,encrypted); }
    const d={url:`./secure/objects/${id}.bin`,id,sha256:sha(encrypted),bytes:encrypted.length,decoded_bytes:raw.length,mime};
    descriptors.set(id,d);return d;
  }
  const documentsRaw=JSON.parse(fs.readFileSync(path.join(sourceSite,'docs/data/documents.json')));
  const topics=JSON.parse(fs.readFileSync(path.join(sourceSite,'docs/data/topics.json')));
  const rendered=JSON.parse(fs.readFileSync(path.join(renderedRoot,'manifest.json')));
  const renders=new Map(rendered.documents.map(d=>[d.relative_path,d]));
  const sourceCatalog=JSON.parse(fs.readFileSync(process.env.COMPANY_CATALOG||'/home/zenith/memory/documents/company-corpus/catalog.json'));
  const sources=new Map(sourceCatalog.map(d=>[d.relative_path,d]));
  const documents=[]; const counts={};
  for(const [relative,doc] of Object.entries(documentsRaw)) {
    const r=renders.get(relative); if(!r) throw new Error(`Missing render record (${documents.length})`);
    const assets=[];
    for(const a of r.assets||[]) {
      const assetPath=path.resolve(renderedRoot,a.path);
      if(!assetPath.startsWith(path.resolve(renderedRoot)+path.sep))throw new Error('Asset escapes rendered root');
      assets.push(await put(fs.readFileSync(assetPath),a.mime));
    }
    let text='';
    if(r.search_text_file) {const textPath=path.resolve(renderedRoot,r.search_text_file);if(!textPath.startsWith(path.resolve(renderedRoot)+path.sep))throw new Error('Text escapes rendered root');text=fs.readFileSync(textPath,'utf8');}
    else {const p=path.join(sourceSite,'docs/previews',`${doc.preview_id}.json`);if(fs.existsSync(p))text=JSON.parse(fs.readFileSync(p)).content||'';}
    const textAsset=text ? await put(Buffer.from(text),'text/plain;charset=utf-8'):null;
    const source=sources.get(relative); if(!source)throw new Error('Original missing');
    const originalBytes=fs.readFileSync(source.absolute_path);
    if(sha(originalBytes)!==r.source_sha256)throw new Error('Source changed after render');
    const originalAssets=[];
    for(let offset=0;offset<originalBytes.length;offset+=64*1024*1024)originalAssets.push(await put(originalBytes.subarray(offset,offset+64*1024*1024),'application/octet-stream'));
    if(!originalAssets.length)originalAssets.push(await put(Buffer.alloc(0),'application/octet-stream'));
    const original={assets:originalAssets,sha256:r.source_sha256,bytes:originalBytes.length};
    counts[r.kind]=(counts[r.kind]||0)+1;
    const copy={...doc};
    for(const k of Object.keys(copy))if(k.startsWith('preview_'))delete copy[k];
    if(originalBytes.subarray(0,64).toString('ascii').includes('<TGE MMI FILE>'))copy.format='HMI 설비 화면';
    documents.push({...copy,search_text:text,viewer:{kind:r.kind,assets,page_count:r.page_count,reason:r.reason||'',renderer:r.renderer||'',fidelity:r.fidelity||'',source_sha256:r.source_sha256,text:textAsset,original}});
  }
  const timestamp=new Date().toISOString();
  const syncPath=path.join(sourceSite,'docs/data/sync.json');
  const sync=fs.existsSync(syncPath)?JSON.parse(fs.readFileSync(syncPath)):null;
  const index=await put(Buffer.from(JSON.stringify({version:2,generated_at:timestamp,documents,topics,counts,sync})),'application/json');
  const salt=prior?Buffer.from(prior.salt,'base64'):crypto.randomBytes(16);
  const wrapped=prior?Buffer.from(prior.wrapped_key,'base64'):encrypt(key,crypto.pbkdf2Sync(password,salt,ITERATIONS,32,'sha256'),'company-v2:key');
  const manifest={version:2,kdf:'PBKDF2-SHA256',iterations:ITERATIONS,salt:salt.toString('base64'),wrapped_key:wrapped.toString('base64'),index,generated_at:timestamp,counts:{documents:documents.length,topics:topics.length,...counts}};
  const size=[...descriptors.values()].reduce((s,d)=>s+d.bytes,0);
  if(size>5*1024**3) throw new Error(`Encrypted content exceeds repository budget: ${size}`);
  if([...descriptors.values()].some(d=>d.bytes>95*1024*1024))throw new Error('Encrypted object exceeds Git file budget');
  fs.writeFileSync(path.join(secureRoot,'manifest.json.tmp'),JSON.stringify(manifest,null,2)+'\n');
  fs.renameSync(path.join(secureRoot,'manifest.json.tmp'),path.join(secureRoot,'manifest.json'));
  // Keep previous immutable objects so old manifest readers remain valid during refresh.

  fs.writeFileSync(path.join(privateRoot,'bundle-audit.json'),JSON.stringify({generated_at:timestamp,counts:manifest.counts,objects:descriptors.size,encrypted_bytes:size,source_manifest_sha256:sha(fs.readFileSync(path.join(renderedRoot,'manifest.json')))},null,2));
  console.log(JSON.stringify({counts:manifest.counts,objects:descriptors.size,encrypted_MiB:Math.round(size/1048576)}));
}
module.exports={encrypt,decrypt,sha};
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
