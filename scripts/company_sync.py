#!/usr/bin/env python3
"""Deterministic local -> Notion -> encrypted Pages sync. No LLM calls."""
import argparse,asyncio,datetime,fcntl,hashlib,json,mimetypes,os,re,shutil,subprocess,sys,tempfile,time,zipfile
from pathlib import Path
from urllib.parse import urlparse,unquote
from company_notion import Notion,NotionError,page_properties,page_body,plain

class SyncError(Exception):pass

def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def save(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True);tmp=path.with_suffix(path.suffix+'.tmp')
    with tmp.open('w') as f:json.dump(value,f,ensure_ascii=False,indent=2);f.flush();os.fsync(f.fileno())
    os.chmod(tmp,0o600);tmp.replace(path)
def load(path,default=None):
    p=Path(path);return json.loads(p.read_text()) if p.exists() else default

def digest(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for b in iter(lambda:f.read(1048576),b''):h.update(b)
    return h.hexdigest()

def scan(root):
    root=Path(root)
    if not root.is_dir() or root.is_symlink():raise SyncError('source_root_unavailable')
    result={}
    for p in sorted(root.rglob('*')):
        if p.is_symlink():continue
        if not p.is_file() or any(x.startswith('.') for x in p.relative_to(root).parts) or p.name.startswith('~$') or p.suffix.lower() in {'.tmp','.part','.swp','.crdownload'}:continue
        if not p.resolve().is_relative_to(root.resolve()):raise SyncError('source_escapes_root')
        a=p.stat();h=digest(p);b=p.stat()
        if (a.st_size,a.st_mtime_ns,a.st_ino)!=(b.st_size,b.st_mtime_ns,b.st_ino):raise SyncError('source_changing')
        result[p.relative_to(root).as_posix()]={'sha256':h,'size':b.st_size,'mtime_ns':b.st_mtime_ns}
    if not result:raise SyncError('empty_source_root')
    return result

def fingerprint(files):return hashlib.sha256(json.dumps({p:(v['sha256'],v['size']) for p,v in files.items()},sort_keys=True).encode()).hexdigest()
def changes(old,new):
    removed=set(old)-set(new);added=set(new)-set(old);renames={}
    for p in sorted(added):
        matches=[q for q in removed if old[q]['sha256']==new[p]['sha256']]
        if len(matches)==1 and sum(new[q]['sha256']==new[p]['sha256'] for q in added)==1:renames[p]=matches[0];removed.remove(matches[0])
    updated={p for p in new if p not in old or old[p]['sha256']!=new[p]['sha256']}
    return {'updated':sorted(updated),'removed':sorted(removed),'renamed':renames}

def apply_renames(entries,renames):
    for new,old in renames.items():
        entries[new]=dict(entries[old]);entries[new]['status']='active'
        # A later new file at the old path must not reuse the moved page's ID.
        entries[old]={'status':'renamed','renamed_to':new}

def run(command,cwd=None,env=None,timeout=3600):
    r=subprocess.run(command,cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
    if r.returncode:raise SyncError('command_failed:'+Path(command[0]).name+':'+Path(command[1]).name+':'+str(r.returncode))
    return r.stdout.decode(errors='replace').strip()

def markdown_literal(value):return re.sub(r'([\\`*_{}\[\]()#+.!|>~-])',r'\\\1',str(value))

def attachment_name(url):return unquote(Path(urlparse(url).path).name)
def verify_attachments(urls,expected,work):
    import requests
    parts=[]
    with tempfile.TemporaryDirectory(dir=work,prefix='verify-') as tmp:
        for i,url in enumerate(urls):
            u=urlparse(url)
            if u.scheme!='https' or not u.hostname or not u.hostname.endswith(('.amazonaws.com','.notion.so','.notion-static.com')):raise SyncError('unexpected_attachment_host')
            p=Path(tmp)/str(i)
            with requests.get(url,stream=True,timeout=180) as r:
                r.raise_for_status()
                with p.open('wb') as f:
                    for b in r.iter_content(1048576):f.write(b)
            if digest(p)==expected:return True
            if zipfile.is_zipfile(p):
                with zipfile.ZipFile(p) as z:
                    entries=[v for v in z.infolist() if not v.is_dir()]
                    if len(entries)!=1:continue
                    member=entries[0]
                    if member.file_size>5*1024**3:raise SyncError('archive_size_bound')
                    part=Path(tmp)/(str(i)+'.bin')
                    with z.open(member) as source,part.open('wb') as target:shutil.copyfileobj(source,target,1048576)
                    if digest(part)==expected:return True
                    m=re.search(r'part(\d+)',attachment_name(url),re.I) or re.search(r'part(\d+)',member.filename,re.I)
                    if m:parts.append((int(m.group(1)),part))
        if parts:
            parts.sort()
            if [i for i,p in parts]!=list(range(parts[0][0],parts[0][0]+len(parts))):return False
            h=hashlib.sha256()
            for i,p in parts:
                with p.open('rb') as f:
                    for b in iter(lambda:f.read(1048576),b''):h.update(b)
            return h.hexdigest()==expected
    return False

def upload_parts(source,work):
    # The existing MCP upload endpoint accepts files below 20 MiB. ZIP retains unsupported bytes exactly.
    size=source.stat().st_size;safe={'.pdf','.txt','.csv','.json','.md','.xlsx','.xls','.pptx','.ppt','.doc','.docx','.jpg','.jpeg','.png','.svg','.zip','.gz'}
    if size<19*1024**2 and source.suffix.lower() in safe:return [source]
    if size<19*1024**2:
        target=work/(source.name+'.zip')
        with zipfile.ZipFile(target,'w',zipfile.ZIP_STORED) as z:z.write(source,source.name)
        return [target]
    out=[];chunk_size=18*1024**2
    with source.open('rb') as f:
        i=0
        while True:
            data=f.read(chunk_size)
            if not data and i:break
            i+=1;name=f'original-part{i:04d}.zip';p=work/name
            with zipfile.ZipFile(p,'w',zipfile.ZIP_STORED) as z:z.writestr(f'part{i:04d}.bin',data)
            out.append(p)
            if not data:break
    return out

async def upload(n,p):
    import requests
    created=await n.call('notion-create-file-upload',{'filename':p.name})
    u=urlparse(created['upload_url'])
    if u.scheme!='https' or not u.hostname.endswith(('.notion.so','.notion.com','.amazonaws.com')):raise SyncError('unexpected_upload_host')
    def send():
        with p.open('rb') as f:
            r=requests.post(created['upload_url'],headers=created.get('upload_headers',{}),files={created.get('upload_form_field','file'):(p.name,f,mimetypes.guess_type(p.name)[0] or 'application/octet-stream')},timeout=600)
        r.raise_for_status();return r.json()
    result=await asyncio.to_thread(send)
    return {'id':created['file_upload_id'],'filename':p.name,'markdown':result.get('suggested_markdown') or created.get('suggested_markdown') or f'<file src="file-upload://{created["file_upload_id"]}"></file>'}

async def update_document(n,config,rel,record,entry,snapshot,journal,jpath):
    pid=entry.get('page_id');key=rel+'|'+record['sha256'];job=journal.setdefault(key,{})
    if not pid:
        rows=await n.rows(config.get('notion_source_view',config['notion_source']));matches=[r for r in rows if plain(r.get('상대경로'))==rel]
        if len(matches)>1:raise SyncError('duplicate_notion_paths')
        if matches:pid=matches[0]['url']
        elif job.get('create_intent'):raise SyncError('uncertain_create_requires_reconciliation')
        else:
            job['create_intent']=now();save(jpath,journal)
            result=await n.call('notion-create-pages',{'parent':{'data_source_id':config['notion_source'].removeprefix('collection://')},'pages':[{'properties':{'원본 제목':markdown_literal(Path(rel).name),'상대경로':markdown_literal(rel),'검증메모':'로컬 자동 동기화 준비 중'},'content':'로컬 파일 연결을 준비하고 있습니다.'}],'allow_async':False})
            pages=result.get('pages',[]) if isinstance(result,dict) else []
            if not pages:raise SyncError('created_page_requires_reconciliation')
            pid=pages[0].get('id') or pages[0].get('url')
        entry['page_id']=pid;job['page_id']=pid;save(jpath,journal)
    current=await n.fetch(pid,True);props=page_properties(current)
    marker='SHA-256: '+record['sha256']
    revision='동기화 식별자: '+hashlib.sha256((rel+'|'+record['sha256']).encode()).hexdigest()
    note=str(props.get('검증메모',''))
    if marker in note and revision in page_body(current) and '## 자동 동기화 원본' in page_body(current) and plain(props.get('상대경로'))==rel and '로컬 삭제' not in note:
        if await asyncio.to_thread(verify_attachments,props.get('원본 파일',[]),record['sha256'],Path(config['state'])):
            entry.update(record,status='active',verified_at=now());return
    uploads=job.get('uploads') if time.time()-job.get('uploaded_at',0)<3300 else None
    if not uploads:
        with tempfile.TemporaryDirectory(dir=config['state'],prefix='upload-') as tmp:
            uploads=[]
            for p in upload_parts(snapshot,Path(tmp)):uploads.append(await upload(n,p))
        job.update(uploads=uploads,uploaded_at=time.time());save(jpath,journal)
    note=f'로컬 자동 동기화 / {marker} / {record["size"]} bytes / {now()}'
    await n.call('notion-update-page',{'page_id':pid,'command':'update_properties','properties':{'원본 제목':markdown_literal(Path(rel).name),'상대경로':markdown_literal(rel),'검증메모':note,'원본 파일':[{'type':'file_upload','file_upload':{'id':u['id']}} for u in uploads]},'allow_async':False})
    current=await n.fetch(pid);body=page_body(current)
    start='## 자동 동기화 원본';end='## 기존 문서 기록'
    content=f'{start}\n현재 로컬 파일의 원본입니다. 아래 기존 기록보다 이 첨부 파일을 우선 사용하세요.\n\n상대경로: `{rel}`\n\n{marker}\n\n{revision}\n\n'+ '\n'.join(u['markdown'] for u in uploads)+'\n\n'
    if any(u.get('filename','').startswith('original-part') for u in uploads):
        content+='분할 ZIP은 원본 바이트를 담습니다. ZIP 안의 part0001.bin, part0002.bin 순서대로 결합해 위 파일명으로 저장하고 SHA-256으로 검증하세요.\n\n'
    elif any(u.get('filename','').endswith('.zip') for u in uploads) and snapshot.suffix.lower()!='.zip':
        content+='ZIP을 풀면 원래 파일명과 내용 그대로 원본을 사용할 수 있습니다.\n\n'
    if start in body:
        # File references returned by fetch are not stable search strings in Notion.
        # Replace only our unique heading and keep prior attachments as revision history.
        await n.call('notion-update-page',{'page_id':pid,'command':'update_content','content_updates':[{'old_str':start,'new_str':content+'## 이전 자동 동기화 기록\n'}],'allow_async':False})
    else:
        await n.call('notion-update-page',{'page_id':pid,'command':'insert_content','position':{'type':'start'},'content':content+end+'\n','allow_async':False})
    final=await n.fetch(pid,True);props=page_properties(final)
    if plain(props.get('상대경로'))!=rel or revision not in page_body(final) or not await asyncio.to_thread(verify_attachments,props.get('원본 파일',[]),record['sha256'],Path(config['state'])):raise SyncError('notion_original_verification_failed')
    entry.update(record,status='active',verified_at=now());job['verified']=True;save(jpath,journal)

async def refresh_topics(n,topics,source=None):
    result=[]
    identity=lambda url:url.split('?')[0].rstrip('/').rsplit('/',1)[-1].replace('-','')
    previous={identity(t['url']):t for t in topics}
    rows=await n.rows(source,'url') if source else topics
    if not rows:raise SyncError('empty_notion_encyclopedia_held')
    for row in rows:
        url=row['url'];pid=identity(url);topic=previous.get(pid,{})
        value=await n.fetch(url);props=page_properties(value);copy=dict(topic)
        copy.update(id=topic.get('id',pid),url=url,content_markdown=page_body(value),title=plain(props.get('문서명') or value.get('title') or topic.get('title','')))
        for source_key,target in [('분야','category'),('근거 문서','source_relations'),('관련 문서','related_relations')]:
            if source_key in props:
                field=props[source_key]
                if isinstance(field,str):
                    try:field=json.loads(field)
                    except ValueError:field=[plain(field)] if field else []
                copy[target]=field
            elif target in ('source_relations','related_relations'):
                # Notion omits empty relation properties; do not retain removed links.
                copy[target]=[]
        copy.setdefault('summary','');result.append(copy)
    return result

def build_and_publish(config,files,entries,topics,baseline):
    state=Path(config['state']);repo=Path(config['repo']);assets=Path(config['assets_repo']);rendered=Path(config['rendered'])
    dirty=run(['git','status','--porcelain'],repo)
    # This dedicated checkout owns only the generated manifest. Recover interrupted writes.
    if dirty and all(re.sub(r'^[ MARCUD?!]{1,2} +','',line)=='docs/secure/manifest.json' for line in dirty.splitlines()):
        run(['git','restore','--staged','--worktree','docs/secure/manifest.json'],repo)
    elif dirty:raise SyncError('sync_checkout_not_clean')
    run(['git','fetch','origin','main'],repo);run(['git','merge','--ff-only','origin/main'],repo)
    source=state/'inputs';data=source/'docs/data';data.mkdir(parents=True,exist_ok=True)
    old={d['relative_path']:d for d in baseline['documents']};docs={};catalog=[]
    for rel,item in files.items():
        entry=entries[rel];pid=entry['page_id'];pid=pid.rsplit('/',1)[-1].split('?')[0]
        doc=dict(old.get(rel,{}));doc.update(title=Path(rel).name,relative_path=rel,extension=Path(rel).suffix.lower(),size_bytes=item['size'],notion_page_id=pid,notion_url='https://www.notion.so/'+pid.replace('-',''))
        doc.setdefault('format',next((d['format'] for d in baseline['documents'] if d.get('extension')==Path(rel).suffix.lower()),Path(rel).suffix.lstrip('.').upper() or '기타'));doc['scope']=rel.split('/')[0];doc.setdefault('category',rel.split('/')[1] if len(rel.split('/'))>2 else rel.split('/')[0]);doc.setdefault('search_tokens',[])
        for k in ['search_text','viewer']:doc.pop(k,None)
        docs[rel]=doc
        staged=state/'sources'/item['sha256']/Path(rel).name
        catalog.append({'relative_path':rel,'absolute_path':str(staged if staged.exists() else Path(config['root'])/rel)})
    save(data/'documents.json',docs);save(data/'topics.json',topics);save(data/'sync.json',{'mode':'local-to-notion-web','interval_seconds':config['interval_seconds'],'verified_at':now()});save(state/'catalog.json',catalog)
    env=dict(os.environ,RENDER_PDF_PYTHON=config['render_python'])
    run([config['python'],'scripts/render_documents.py','--catalog',str(state/'catalog.json'),'--output',str(rendered),'--workers','2','--timeout','180'],repo,env,timeout=14400)
    output=state/'bundle';objects=output/'docs/secure/objects';objects.mkdir(parents=True,exist_ok=True)
    for p in (assets/'objects').glob('*.bin'):
        if not (objects/p.name).exists():os.link(p,objects/p.name)
    env.update(COMPANY_REUSE_MANIFEST=str(repo/'docs/secure/manifest.json'),COMPANY_CATALOG=str(state/'catalog.json'))
    run([config['node'],'scripts/build_secure_bundle.cjs',str(source),str(rendered),str(output),config['private_key_dir']],repo,env,timeout=14400)
    if fingerprint(scan(config['root']))!=fingerprint(files):raise SyncError('source_changed_before_publish')
    run(['git','fetch','origin','encrypted-assets-v2'],assets);run(['git','merge','--ff-only','origin/encrypted-assets-v2'],assets)
    pending=[]
    for p in objects.glob('*.bin'):
        target=assets/'objects'/p.name
        if not target.exists():os.link(p,target);pending.append('objects/'+p.name)
    # Include objects left by an interrupted run, even when they already exist locally.
    run(['git','add','--','objects'],assets)
    if run(['git','diff','--cached','--name-only'],assets):
        run(['git','commit','-m','Update encrypted company document snapshot'],assets)
    run(['git','push','origin','HEAD:encrypted-assets-v2'],assets,timeout=3600)
    asset_commit=run(['git','rev-parse','HEAD'],assets)
    manifest=load(output/'docs/secure/manifest.json');manifest['asset_base']=f'https://raw.githubusercontent.com/dkdleljh/company/{asset_commit}/objects/'
    import requests
    for attempt in range(12):
        response=requests.get(manifest['asset_base']+manifest['index']['id']+'.bin',timeout=60)
        if response.ok and hashlib.sha256(response.content).hexdigest()==manifest['index']['sha256']:break
        time.sleep(5)
    else:raise SyncError('remote_encrypted_index_unavailable')
    save(repo/'docs/secure/manifest.json',manifest)
    run([config['python'],'scripts/verify_public_tree.py','--documents',str(len(files)),'--topics',str(len(topics))],repo)
    run(['git','add','docs/secure/manifest.json'],repo);run(['git','commit','-m','Sync local company files after Notion verification'],repo)
    commit=run(['git','rev-parse','HEAD'],repo);save(state/'publish-pending.json',{'commit':commit,'manifest':manifest,'files':files,'entries':entries,'synced_at':now()})
    run(['git','push','origin','HEAD:main'],repo,timeout=3600)
    verify_deploy(config,commit,manifest)
    return commit

def verify_deploy(config,commit,manifest):
    import requests
    for i in range(40):
        build=json.loads(run(['gh','api','repos/dkdleljh/company/pages/builds/latest'],config['repo']))
        if build.get('commit')==commit and build.get('status')=='built':
            response=requests.get(config['site']+'secure/manifest.json',params={'sync':commit},timeout=30);response.raise_for_status()
            if response.json()==manifest:return
        if build.get('commit')==commit and build.get('status')=='errored':raise SyncError('pages_build_failed')
        time.sleep(10)
    raise SyncError('pages_verification_pending')

async def sync(config,force=False):
    state=Path(config['state']);state.mkdir(parents=True,exist_ok=True);start=now();status={'checked_at':start,'status':'checking'};save(state/'status.json',status)
    files=scan(config['root']);mark=fingerprint(files);ledger=load(state/'ledger.json')
    if not ledger:raise SyncError('baseline_audit_required')
    pending=load(state/'publish-pending.json')
    if pending:
        repo=config['repo'];run(['git','fetch','origin','main'],repo)
        remote=run(['git','rev-parse','origin/main'],repo)
        if remote!=pending['commit']:
            contains=subprocess.run(['git','merge-base','--is-ancestor',pending['commit'],remote],cwd=repo).returncode==0
            if not contains:
                run(['git','rebase','origin/main'],repo)
                pending['commit']=run(['git','rev-parse','HEAD'],repo);save(state/'publish-pending.json',pending)
                run(['git','push','origin','HEAD:main'],repo)
            else:pending['commit']=remote
        await asyncio.to_thread(verify_deploy,config,pending['commit'],pending['manifest'])
        ledger={k:pending[k] for k in ['files','entries','synced_at','commit']};save(state/'ledger.json',ledger);save(state/'publish-pending.json',None)

    observed=load(state/'observed.json',{})
    if not force and (observed.get('fingerprint')!=mark or time.time()-observed.get('at',0)<config['settle_seconds']):
        if observed.get('fingerprint')!=mark:save(state/'observed.json',{'fingerprint':mark,'at':time.time()})
        save(state/'status.json',dict(status,status='waiting_for_stable_files',files=len(files)));return
    plan=changes(ledger['files'],files)
    if len(plan['removed'])>max(5,len(ledger['files'])//10):raise SyncError('mass_removal_held')
    topics_cache=load(state/'topics.json');topics_due=time.time()-load(state/'topics-check.json',{}).get('at',0)>config.get('notion_poll_seconds',900)
    if not plan['updated'] and not plan['removed'] and not force and not topics_due:
        save(state/'status.json',dict(status,status='healthy',files=len(files),last_synced_at=ledger.get('synced_at'),commit=ledger.get('commit'),changes=0));return
    entries=load(state/'notion-ledger.json',ledger['entries']);journal=load(state/'journal.json',{});jpath=state/'journal.json'
    baseline=load(config['baseline']);topics=topics_cache or baseline['topics']
    previous_topics=json.dumps(topics,sort_keys=True,ensure_ascii=False)
    async with Notion(config['hermes']) as n:
        apply_renames(entries,plan['renamed'])
        for rel in plan['updated']:
            item=files[rel];snapshot=state/'sources'/item['sha256']/Path(rel).name;snapshot.parent.mkdir(parents=True,exist_ok=True)
            if not snapshot.exists():shutil.copy2(Path(config['root'])/rel,snapshot)
            if digest(snapshot)!=item['sha256']:raise SyncError('snapshot_changed')
            entry=entries.setdefault(rel,{})
            if entry.get('status')=='renamed' and not entry.get('page_id'):
                entries[rel]=entry={};journal.pop(rel+'|'+item['sha256'],None)
            await update_document(n,config,rel,item,entry,snapshot,journal,jpath);save(state/'notion-ledger.json',entries)
            save(state/'status.json',dict(status,status='syncing_notion',completed=sum(e.get('sha256')==files[p]['sha256'] for p,e in entries.items() if p in files),files=len(files)))
        for rel in plan['removed']:
            entry=entries[rel]
            if entry.get('status')!='removed':
                await n.call('notion-update-page',{'page_id':entry['page_id'],'command':'update_properties','properties':{'검증메모':f'로컬 삭제 감지 {now()}. 이전 원본은 복구용으로 보존합니다. SHA-256: {entry["sha256"]}'},'allow_async':False})
                removed=page_properties(await n.fetch(entry['page_id']))
                if '로컬 삭제 감지' not in str(removed.get('검증메모','')):raise SyncError('notion_removal_verification_failed')
                entry['status']='removed';save(state/'notion-ledger.json',entries)
        topics=await refresh_topics(n,topics,config.get('notion_topics_view'))
    save(state/'topics.json',topics);save(state/'topics-check.json',{'at':time.time()})
    if not plan['updated'] and not plan['removed'] and not force and json.dumps(topics,sort_keys=True,ensure_ascii=False)==previous_topics:
        save(state/'status.json',dict(status,status='healthy',files=len(files),last_synced_at=ledger.get('synced_at'),commit=ledger.get('commit'),changes=0));return
    save(state/'status.json',dict(status,status='building_web',files=len(files)))
    commit=await asyncio.to_thread(build_and_publish,config,files,entries,topics,baseline)
    save(state/'ledger.json',{'files':files,'entries':entries,'synced_at':now(),'commit':commit})
    save(state/'publish-pending.json',None)
    save(state/'status.json',dict(status,status='healthy',files=len(files),last_synced_at=now(),commit=commit,changes=len(plan['updated'])+len(plan['removed'])))

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config',type=Path,required=True);parser.add_argument('--force',action='store_true');args=parser.parse_args();os.umask(0o077)
    c=load(args.config);state=Path(c['state']);state.mkdir(parents=True,exist_ok=True)
    with (state/'sync.lock').open('w') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return
        try:asyncio.run(sync(c,args.force))
        except Exception as e:
            message=str(e) if isinstance(e,(SyncError,NotionError)) else type(e).__name__
            save(state/'status.json',{'status':'error','checked_at':now(),'error':message});print(json.dumps({'status':'error','error':message}),flush=True);raise SystemExit(1)
        print(json.dumps(load(state/'status.json')),flush=True)
if __name__=='__main__':main()
