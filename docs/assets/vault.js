/* Authenticated encrypted static content. Keys live only in this page's memory. */
const encoder = new TextEncoder();
const decode64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = bytes => [...new Uint8Array(bytes)].map(v=>v.toString(16).padStart(2,'0')).join('');
export class Vault {
  #key = null;
  #epoch = 0;
  #assetBase = null;
  async open(password) {
    this.lock();
    const epoch=this.#epoch;
    const current=()=>{if(epoch!==this.#epoch)throw new DOMException('Aborted','AbortError');};
    if(!crypto.subtle || !globalThis.DecompressionStream) throw new Error('최신 Chrome, Edge 또는 Safari에서 HTTPS로 접속해 주세요.');
    const response=await fetch('./secure/manifest.json',{cache:'no-store'});
    if(!response.ok)throw new Error('문서 목록을 불러오지 못했습니다. 연결을 확인하고 다시 시도해 주세요.');
    const manifest=await response.json();current();
    if(manifest.version!==2 || manifest.iterations!==600000)throw new Error('새로고침 후 다시 접속해 주세요.');
    if(manifest.asset_base && !/^https:\/\/raw\.githubusercontent\.com\/dkdleljh\/company\/[a-f0-9]{40}\/objects\/$/.test(manifest.asset_base))throw new Error('유효하지 않은 저장소 주소입니다.');
    const assetBase=manifest.asset_base||null;
    const material=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveKey']);
    const wrapping=await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt:decode64(manifest.salt),iterations:manifest.iterations},material,{name:'AES-GCM',length:256},false,['decrypt']);
    const wrapped=decode64(manifest.wrapped_key);
    let raw;
    try {raw=await crypto.subtle.decrypt({name:'AES-GCM',iv:wrapped.slice(0,12),additionalData:encoder.encode('company-v2:key')},wrapping,wrapped.slice(12));}
    catch {throw new Error('접속 코드가 일치하지 않습니다.');}
    const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);
    current();this.#key=key;this.#assetBase=assetBase;
    new Uint8Array(raw).fill(0);
    try {return JSON.parse(new TextDecoder().decode(await this.read(manifest.index)));}
    catch(error){if(epoch===this.#epoch)this.lock();throw error;}
  }
  lock(){this.#epoch++;this.#key=null;this.#assetBase=null;}
  async read(asset,signal) {
    const key=this.#key;
    if(!key)throw new Error('먼저 접속 코드를 입력해 주세요.');
    if(!asset || !/^[a-f0-9]{64}$/.test(asset.id) || asset.url!==`./secure/objects/${asset.id}.bin`)throw new Error('유효하지 않은 문서 주소입니다.');
    const response=await fetch(this.#assetBase?`${this.#assetBase}${asset.id}.bin`:asset.url,{signal});
    if(!response.ok)throw new Error(`문서를 불러오지 못했습니다 (${response.status}). 다시 시도해 주세요.`);
    const encrypted=await response.arrayBuffer();
    if(hex(await crypto.subtle.digest('SHA-256',encrypted))!==asset.sha256)throw new Error('파일 검증에 실패했습니다. 새로고침 후 다시 시도해 주세요.');
    const bytes=new Uint8Array(encrypted);
    let compressed;
    try{compressed=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12),additionalData:encoder.encode(`company-v2:${asset.id}`)},key,bytes.slice(12));}
    catch{throw new Error('파일을 복호화하지 못했습니다. 다시 로그인해 주세요.');}
    const raw=await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    if(raw.byteLength!==asset.decoded_bytes || hex(await crypto.subtle.digest('SHA-256',raw))!==asset.id)throw new Error('원본 파일 무결성 확인에 실패했습니다.');
    if(this.#key!==key || signal?.aborted)throw new DOMException('Aborted','AbortError');
    return new Uint8Array(raw);
  }
}
