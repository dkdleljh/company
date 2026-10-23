import sys,tempfile,unittest,json,zipfile,hashlib,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from company_sync import scan,changes,fingerprint,upload_parts,SyncError,markdown_literal,apply_renames
from company_notion import plain
class SyncTests(unittest.TestCase):
 def test_inventory_add_modify_rename_remove(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);(p/'one.txt').write_text('first');a=scan(p)
   (p/'one.txt').rename(p/'renamed.txt');b=scan(p)
   self.assertEqual(changes(a,b)['renamed'],{'renamed.txt':'one.txt'});self.assertEqual(changes(a,b)['removed'],[])
   (p/'renamed.txt').write_text('changed');self.assertEqual(changes(b,scan(p))['updated'],['renamed.txt'])
   (p/'two.txt').write_text('two');c=scan(p);(p/'renamed.txt').unlink();self.assertEqual(changes(c,scan(p))['removed'],['renamed.txt'])
 def test_empty_root_and_temporary_files(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);(p/'~$office.xlsx').write_text('saving');(p/'.secret').write_text('hidden');(p/'part.tmp').write_text('saving')
   with self.assertRaises(SyncError):scan(p)
   (p/'good.txt').write_text('stable');(p/'linked.txt').symlink_to(p/'good.txt')
   self.assertEqual(set(scan(p)),{'good.txt'})
 def test_duplicate_content_does_not_guess_rename(self):
  item={'sha256':'same','size':1};plan=changes({'a':item,'b':item},{'c':item})
  self.assertEqual(plan['renamed'],{});self.assertEqual(plan['removed'],['a','b'])
 def test_hwp_zip_is_lossless(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);source=p/'fixture.hwp';raw=b'fake-hwp\x00'*100;source.write_bytes(raw)
   parts=upload_parts(source,p)
   with zipfile.ZipFile(parts[0]) as z:
    self.assertEqual(z.namelist(),['fixture.hwp']);self.assertEqual(z.read(z.namelist()[0]),raw)
 def test_large_file_chunks_reassemble_exactly(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);source=p/'fixture.bin';raw=b'x'*(20*1024**2)+b'tail';source.write_bytes(raw)
   parts=upload_parts(source,p);self.assertEqual(len(parts),2);joined=b''
   for part in parts:
    self.assertLess(part.stat().st_size,20*1024**2)
    with zipfile.ZipFile(part) as z:joined+=z.read(z.namelist()[0])
   self.assertEqual(hashlib.sha256(joined).digest(),hashlib.sha256(raw).digest())
 def test_notion_literal_paths(self):
  path="98_정리기록/_(문서)_검증-v1.0.txt"
  self.assertEqual(plain(markdown_literal(path)),path)
  self.assertEqual(plain("`"+path+"`"),path)
 def test_notion_html_code_paths_match_existing_page_identity(self):
  for path in ['98_기록/2026-01-01_안내/00_설명.md',
               '95_보안자료/03_지역/01_통신/설비_현황/장비목록.zip']:
   self.assertEqual(plain('<code>'+path+'</code>'),path)
 def test_notion_code_entities_decode_without_changing_literal_filenames(self):
  self.assertEqual(plain('<code>A&amp;B/문서&lt;초안&gt;.txt</code>'),'A&B/문서<초안>.txt')
  self.assertEqual(plain('A&amp;B.txt'),'A&amp;B.txt')
  self.assertEqual(plain('folder/<code>literal</code>.txt'),'folder/<code>literal</code>.txt')
 def test_rename_does_not_leave_old_path_owning_the_same_page(self):
  entries={'old.txt':{'page_id':'page','sha256':'same','status':'active'}}
  apply_renames(entries,{'new.txt':'old.txt'})
  self.assertEqual(entries['new.txt']['page_id'],'page')
  self.assertNotIn('page_id',entries['old.txt']);self.assertEqual(entries['old.txt']['renamed_to'],'new.txt')
 def test_mtime_only_does_not_publish(self):
  a={'a':{'sha256':'a','size':1,'mtime_ns':1}};b={'a':{'sha256':'a','size':1,'mtime_ns':2}}
  self.assertEqual(fingerprint(a),fingerprint(b));self.assertEqual(changes(a,b)['updated'],[])

from unittest.mock import patch,AsyncMock
from company_sync import update_document,refresh_topics,digest,sync,save,load,topics_fingerprint
class NotionSyncTests(unittest.IsolatedAsyncioTestCase):
 async def test_revision_update_keeps_attachment_history_and_retries_without_duplicates(self):
  class FakeNotion:
   def __init__(self):
    self.props={'상대경로':'before.txt','검증메모':'older','원본 파일':[]}
    self.body='## 자동 동기화 원본\n<file src="notion-file-block://changing-reference"></file>\n## 기존 문서 기록\nUser-authored note\n<page url="child">Child</page>'
    self.calls=[]
   async def fetch(self,*args):return {'text':'<properties>'+json.dumps(self.props)+'</properties><content>'+self.body+'</content>'}
   async def call(self,name,args):
    self.calls.append(args)
    if args['command']=='update_properties':self.props.update(args['properties'])
    elif args['command']=='update_content':
     edit=args['content_updates'][0];self.body=self.body.replace(edit['old_str'],edit['new_str'])
    return {}
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);source=p/'after.txt';source.write_text('updated');n=FakeNotion();entry={'page_id':'existing'};journal={};record={'sha256':digest(source),'size':source.stat().st_size}
   with patch('company_sync.upload',new=AsyncMock(return_value={'id':'upload','filename':'after.txt','markdown':'<file src="file-upload://upload"></file>'})),patch('company_sync.verify_attachments',return_value=True):
    await update_document(n,{'state':d},'after.txt',record,entry,source,journal,p/'journal.json')
    self.assertEqual(n.calls[1]['content_updates'][0]['old_str'],'## 자동 동기화 원본')
    self.assertIn('User-authored note',n.body);self.assertIn('<page url="child">Child</page>',n.body)
    self.assertIn('changing-reference',n.body);self.assertEqual(n.body.count('## 자동 동기화 원본'),1)
    calls=len(n.calls)
    await update_document(n,{'state':d},'after.txt',record,entry,source,journal,p/'journal.json')
    self.assertEqual(len(n.calls),calls)
 async def test_topic_inventory_follows_current_notion_pages_and_metadata(self):
  class FakeNotion:
   async def rows(self,*args):return [{'url':'https://www.notion.so/new'}]
   async def fetch(self,*args):return {'text':'<properties>'+json.dumps({'문서명':'New topic','분야':['ICT 공통'],'근거 문서':['https://www.notion.so/source'],'관련 문서':'["https://www.notion.so/related"]'})+'</properties><content>New body</content>'}
  topics=await refresh_topics(FakeNotion(),[{'id':'old','url':'https://www.notion.so/old'}],'collection://test')
  self.assertEqual(len(topics),1);self.assertEqual(topics[0]['id'],'new');self.assertEqual(topics[0]['content_markdown'],'New body');self.assertEqual(topics[0]['category'],['ICT 공통']);self.assertEqual(topics[0]['related_relations'],['https://www.notion.so/related'])

 async def test_removed_notion_relations_do_not_survive_refresh(self):
  class FakeNotion:
   async def fetch(self,*args):return {'text':'<properties>'+json.dumps({'문서명':'Same topic','분야':['ICT 공통']})+'</properties><content>Body</content>'}
  previous={'id':'same','url':'https://www.notion.so/same','source_relations':['https://www.notion.so/source'],'related_relations':['https://www.notion.so/related']}
  topics=await refresh_topics(FakeNotion(),[previous])
  self.assertEqual(topics[0]['source_relations'],[]);self.assertEqual(topics[0]['related_relations'],[])
  self.assertEqual(len(previous['related_relations']),1)

class SyncSafetyTests(unittest.IsolatedAsyncioTestCase):
 async def test_first_observation_waits_without_remote_mutations(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d)/'root';state=Path(d)/'state';root.mkdir();state.mkdir();(root/'a.txt').write_text('a')
   save(state/'ledger.json',{'files':{},'entries':{}})
   with patch('company_sync.Notion') as notion:
    await sync({'root':str(root),'state':str(state),'settle_seconds':30})
    notion.assert_not_called()
   self.assertEqual(load(state/'status.json')['status'],'waiting_for_stable_files')
 async def test_mass_deletion_preserves_last_success_before_remote_actions(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d)/'root';state=Path(d)/'state';root.mkdir();state.mkdir()
   for i in range(20):(root/f'{i}.txt').write_text(str(i))
   old=scan(root);save(state/'ledger.json',{'files':old,'entries':{}})
   for i in range(6):(root/f'{i}.txt').unlink()
   with patch('company_sync.Notion') as notion:
    with self.assertRaisesRegex(SyncError,'mass_removal_held'):await sync({'root':str(root),'state':str(state)},force=True)
    notion.assert_not_called()
   self.assertEqual(load(state/'ledger.json')['files'],old)

class TopicPublishRetryTests(unittest.IsolatedAsyncioTestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.path=Path(self.tmp.name)
  self.root=self.path/'root';self.state=self.path/'state';self.root.mkdir();self.state.mkdir();(self.root/'a.txt').write_text('unchanged')
  self.files=scan(self.root);self.entries={'a.txt':dict(self.files['a.txt'],page_id='source',status='active')}
  self.config={'root':str(self.root),'state':str(self.state),'baseline':str(self.path/'baseline.json'),'repo':str(self.path/'repo'),'hermes':'unused','settle_seconds':0,'notion_poll_seconds':900}
  save(self.config['baseline'],{'topics':self.topics('Old'),'documents':[]})
  save(self.state/'ledger.json',{'files':self.files,'entries':self.entries,'commit':'old','synced_at':'before','topics_fingerprint':topics_fingerprint(self.topics('Old'))})
  save(self.state/'observed.json',{'fingerprint':fingerprint(self.files),'at':0})
  save(self.state/'topics.json',self.topics('Old'))
  owner=self;self.latest='Updated'
  class FakeNotion:
   def __init__(self,*args):pass
   async def __aenter__(self):return self
   async def __aexit__(self,*args):pass
   async def fetch(self,*args):return {'text':'<properties>'+json.dumps({'문서명':owner.latest})+'</properties><content>'+owner.latest+' body</content>'}
  notion_patch=patch('company_sync.Notion',side_effect=FakeNotion);self.notion=notion_patch.start();self.addCleanup(notion_patch.stop)
 def topics(self,title):return [{'id':'topic','url':'https://www.notion.so/topic','title':title,'content_markdown':title+' body','source_relations':[],'related_relations':[],'summary':''}]
 def pending(self,topics,commit='pending'):
  save(self.state/'publish-pending.json',{'commit':commit,'manifest':{'fixture':True},'files':self.files,'entries':self.entries,'synced_at':'pending-time','topics_fingerprint':topics_fingerprint(topics)})
 async def test_topic_only_failure_before_pending_retries_then_noops(self):
  with patch('company_sync.build_and_publish',side_effect=[RuntimeError('render failed'),'published']) as build:
   with self.assertRaisesRegex(RuntimeError,'render failed'):await sync(self.config)
   self.assertIsNone(load(self.state/'publish-pending.json'))
   self.assertEqual(load(self.state/'topics.json'),self.topics('Updated'))
   self.assertEqual(load(self.state/'ledger.json')['topics_fingerprint'],topics_fingerprint(self.topics('Old')))
   # Same observed topics and an unexpired poll interval must still retry publication.
   await sync(self.config);self.assertEqual(build.call_count,2)
   self.assertEqual(load(self.state/'ledger.json')['commit'],'published')
   self.assertEqual(load(self.state/'ledger.json')['topics_fingerprint'],topics_fingerprint(self.topics('Updated')))
   polls=self.notion.call_count;await sync(self.config)
   self.assertEqual(build.call_count,2);self.assertEqual(self.notion.call_count,polls)
   # An unchanged scheduled poll also remains a no-op.
   save(self.state/'topics-check.json',{'at':0});await sync(self.config);self.assertEqual(build.call_count,2)
 async def test_legacy_unknown_topics_retry_until_published_then_noop(self):
  # Old versions could save new topics before failing, without a pending record.
  ledger=load(self.state/'ledger.json');ledger.pop('topics_fingerprint');save(self.state/'ledger.json',ledger)
  save(self.state/'topics.json',self.topics('Updated'));save(self.state/'topics-check.json',{'at':time.time()})
  with patch('company_sync.build_and_publish',side_effect=[RuntimeError('render failed'),'published']) as build:
   with self.assertRaisesRegex(RuntimeError,'render failed'):await sync(self.config)
   self.assertEqual(load(self.state/'ledger.json')['topics_fingerprint'],'')
   await sync(self.config);self.assertEqual(build.call_count,2)
   self.assertEqual(load(self.state/'ledger.json')['topics_fingerprint'],topics_fingerprint(self.topics('Updated')))
   await sync(self.config);self.assertEqual(build.call_count,2)
 async def test_legacy_unknown_without_cache_still_publishes(self):
  ledger=load(self.state/'ledger.json');ledger.pop('topics_fingerprint');save(self.state/'ledger.json',ledger)
  (self.state/'topics.json').unlink();save(self.state/'topics-check.json',{'at':time.time()});self.latest='Old'
  with patch('company_sync.build_and_publish',return_value='published') as build:
   await sync(self.config);build.assert_called_once()
   await sync(self.config);build.assert_called_once()
 async def test_legacy_pending_without_topic_identity_republishes_once(self):
  self.pending(self.topics('Old'));pending=load(self.state/'publish-pending.json');pending.pop('topics_fingerprint');save(self.state/'publish-pending.json',pending)
  save(self.state/'topics.json',self.topics('Updated'));save(self.state/'topics-check.json',{'at':time.time()})
  def publish(config,files,entries,topics,baseline):
   self.assertEqual(load(self.state/'ledger.json')['topics_fingerprint'],'')
   self.assertEqual(topics,self.topics('Updated'));return 'published'
  with patch('company_sync.run',return_value='pending'),patch('company_sync.verify_deploy'),patch('company_sync.build_and_publish',side_effect=publish) as build:
   await sync(self.config);build.assert_called_once()
   await sync(self.config);build.assert_called_once()
 async def test_pending_recovery_records_its_topics_without_republishing(self):
  def fail_after_pending(config,files,entries,topics,baseline):
   self.pending(topics);raise SyncError('pages_verification_pending')
  with patch('company_sync.build_and_publish',side_effect=fail_after_pending) as build:
   with self.assertRaisesRegex(SyncError,'pages_verification_pending'):await sync(self.config)
   with patch('company_sync.run',return_value='pending'),patch('company_sync.verify_deploy') as verify:
    await sync(self.config)
   verify.assert_called_once();self.assertEqual(build.call_count,1)
   self.assertEqual(load(self.state/'ledger.json')['commit'],'pending')
   self.assertEqual(load(self.state/'ledger.json')['topics_fingerprint'],topics_fingerprint(self.topics('Updated')))
   self.assertIsNone(load(self.state/'publish-pending.json'))
 async def test_topics_changed_while_pending_are_published_after_recovery(self):
  self.pending(self.topics('Updated'));save(self.state/'topics.json',self.topics('Updated'));self.latest='Newer'
  with patch('company_sync.run',return_value='pending'),patch('company_sync.verify_deploy'),patch('company_sync.build_and_publish',return_value='newer') as build:
   await sync(self.config)
   self.assertEqual(build.call_count,1);self.assertEqual(build.call_args.args[3],self.topics('Newer'))
  self.assertEqual(load(self.state/'ledger.json')['commit'],'newer')
  self.assertEqual(load(self.state/'ledger.json')['topics_fingerprint'],topics_fingerprint(self.topics('Newer')))
 async def test_pending_fingerprint_does_not_acknowledge_a_newer_observed_cache(self):
  self.pending(self.topics('Updated'));save(self.state/'topics.json',self.topics('Newer'));save(self.state/'topics-check.json',{'at':time.time()});self.latest='Newer'
  def publish(config,files,entries,topics,baseline):
   self.assertEqual(load(self.state/'ledger.json')['topics_fingerprint'],topics_fingerprint(self.topics('Updated')))
   return 'newer'
  with patch('company_sync.run',return_value='pending'),patch('company_sync.verify_deploy'),patch('company_sync.build_and_publish',side_effect=publish) as build:
   await sync(self.config);self.assertEqual(build.call_count,1)
  self.assertEqual(load(self.state/'ledger.json')['topics_fingerprint'],topics_fingerprint(self.topics('Newer')))

if __name__=='__main__':unittest.main()
