import sys,tempfile,unittest,json,zipfile,hashlib
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
 def test_rename_does_not_leave_old_path_owning_the_same_page(self):
  entries={'old.txt':{'page_id':'page','sha256':'same','status':'active'}}
  apply_renames(entries,{'new.txt':'old.txt'})
  self.assertEqual(entries['new.txt']['page_id'],'page')
  self.assertNotIn('page_id',entries['old.txt']);self.assertEqual(entries['old.txt']['renamed_to'],'new.txt')
 def test_mtime_only_does_not_publish(self):
  a={'a':{'sha256':'a','size':1,'mtime_ns':1}};b={'a':{'sha256':'a','size':1,'mtime_ns':2}}
  self.assertEqual(fingerprint(a),fingerprint(b));self.assertEqual(changes(a,b)['updated'],[])

from unittest.mock import patch,AsyncMock
from company_sync import update_document,refresh_topics,digest,sync,save,load
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
   async def fetch(self,*args):return {'text':'<properties>'+json.dumps({'문서명':'New topic','분야':['ICT 공통'],'근거 문서':['https://www.notion.so/source']})+'</properties><content>New body</content>'}
  topics=await refresh_topics(FakeNotion(),[{'id':'old','url':'https://www.notion.so/old'}],'collection://test')
  self.assertEqual(len(topics),1);self.assertEqual(topics[0]['id'],'new');self.assertEqual(topics[0]['content_markdown'],'New body');self.assertEqual(topics[0]['category'],['ICT 공통'])

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

if __name__=='__main__':unittest.main()
