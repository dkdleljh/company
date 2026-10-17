import sys,tempfile,unittest,json,zipfile,hashlib
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from company_sync import scan,changes,fingerprint,upload_parts,SyncError
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
   with zipfile.ZipFile(parts[0]) as z:self.assertEqual(z.read(z.namelist()[0]),raw)
 def test_large_file_chunks_reassemble_exactly(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);source=p/'fixture.bin';raw=b'x'*(20*1024**2)+b'tail';source.write_bytes(raw)
   parts=upload_parts(source,p);self.assertEqual(len(parts),2);joined=b''
   for part in parts:
    self.assertLess(part.stat().st_size,20*1024**2)
    with zipfile.ZipFile(part) as z:joined+=z.read(z.namelist()[0])
   self.assertEqual(hashlib.sha256(joined).digest(),hashlib.sha256(raw).digest())
 def test_mtime_only_does_not_publish(self):
  a={'a':{'sha256':'a','size':1,'mtime_ns':1}};b={'a':{'sha256':'a','size':1,'mtime_ns':2}}
  self.assertEqual(fingerprint(a),fingerprint(b));self.assertEqual(changes(a,b)['updated'],[])
if __name__=='__main__':unittest.main()
