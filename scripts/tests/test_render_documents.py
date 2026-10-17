"""Focused integrity, decoding, isolation, and optional real Office tests."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile

MODULE = Path(__file__).resolve().parents[1] / 'render_documents.py'
spec = importlib.util.spec_from_file_location('renderer', MODULE)
r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)


def workbook(path):
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    files = {
        '[Content_Types].xml': '''<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>''',
        '_rels/.rels': f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml': f'<workbook xmlns="{ns}" xmlns:r="{rel}"><sheets><sheet name="Wide" sheetId="1" r:id="rId1"/><sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/></sheets><calcPr calcMode="manual" fullCalcOnLoad="0" forceFullCalc="0"/></workbook>',
        'xl/_rels/workbook.xml.rels': f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="{rel}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{ns}"><dimension ref="A1:AI1"/><cols><col min="1" max="35" width="30" customWidth="1"/></cols><sheetData><row r="1"><c r="A1"><f>1+1</f><v>777</v></c><c r="AI1" t="inlineStr"><is><t>LAST_COLUMN_MARKER</t></is></c></row></sheetData></worksheet>',
        'xl/worksheets/sheet2.xml': f'<worksheet xmlns="{ns}"><dimension ref="A1"/><cols><col min="1" max="1" width="30" customWidth="1"/></cols><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>HIDDEN_SHEET_MARKER</t></is></c></row></sheetData></worksheet>',
    }
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, body in files.items(): z.writestr(name, body)


class RenderingTests(unittest.TestCase):
    def test_korean_encodings_lossless(self):
        text = '한글 전력 ICT 문서\n가독성 확인'
        for encoding in ['utf-8', 'utf-8-sig', 'cp949', 'utf-16']:
            self.assertEqual(r.decode_text(text.encode(encoding))[0], text)
        with self.assertRaises(ValueError): r.decode_text(b'\x81\x00\xff')

    def test_entity_xml_rejected(self):
        with self.assertRaises(ValueError):
            r.safe_xml(b'<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>')

    def test_timeout_kills_descendant(self):
        with tempfile.TemporaryDirectory() as t:
            pidfile = Path(t) / 'child.pid'
            code = 'import subprocess,time,pathlib; p=subprocess.Popen(["sleep","30"]); pathlib.Path(' + repr(str(pidfile)) + ').write_text(str(p.pid)); time.sleep(30)'
            started = time.monotonic()
            with self.assertRaises(TimeoutError): r.run_bounded([sys.executable, '-c', code], .5)
            self.assertLess(time.monotonic() - started, 5)
            pid = int(pidfile.read_text())
            stat = Path(f'/proc/{pid}/stat')
            try:
                state = stat.read_text().split()[2]
            except FileNotFoundError:  # The killed child may already be reaped.
                state = None
            self.assertIn(state, (None, 'Z'))

    def test_unsupported_is_honest(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t); source = root / 'software.exe'; source.write_bytes(b'MZtest')
            out = r.render_one(source, r.sha256(source), root / 'out')
            self.assertEqual(out['kind'], 'unsupported')
            self.assertEqual(out['assets'], [])
            self.assertTrue(out['reason'])
            self.assertEqual(source.read_bytes(), b'MZtest')

    def test_ooxml_search_includes_full_cells(self):
        with tempfile.TemporaryDirectory() as t:
            path = Path(t) / 'search.xlsx'; workbook(path)
            text = r.ooxml_search_text(path)
            self.assertIn('777', text)
            self.assertIn('LAST_COLUMN_MARKER', text)
            self.assertIn('HIDDEN_SHEET_MARKER', text)

    def test_rich_text_hyperlink_normalization_is_staged(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t); original = root / 'original.xlsx'; workbook(original)
            with zipfile.ZipFile(original) as z:
                entries = {n:z.read(n) for n in z.namelist()}
            name = 'xl/worksheets/sheet1.xml'
            entries[name] = entries[name].replace(b'<is><t>LAST_COLUMN_MARKER</t></is>',
                b'<is><r><rPr><b/><sz val="22"/></rPr><t>TITLE</t></r><r><rPr><sz val="10"/></rPr><t> Details</t></r></is>')
            entries[name] = entries[name].replace(b'</worksheet>',
                b'<hyperlinks><hyperlink ref="AI1" location="Sheet2!A1"/><hyperlink ref="A1" location="Sheet2!A1"/></hyperlinks></worksheet>')
            with zipfile.ZipFile(original,'w') as z:
                for n,data in entries.items():z.writestr(n,data)
            digest = r.sha256(original)
            self.assertEqual(r.rich_text_hyperlinks(original),1)
            staged = root / 'source.xlsx'; staged.write_bytes(original.read_bytes())
            self.assertEqual(r.rich_text_hyperlinks(staged,apply=True),1)
            self.assertEqual(r.sha256(original),digest)
            with zipfile.ZipFile(staged) as z:
                self.assertIn(b'<rPr><b/><sz val="22"/></rPr>',z.read(name))
                self.assertIn(b'hyperlink ref="A1"',z.read(name))
                self.assertNotIn(b'hyperlink ref="AI1"',z.read(name))

    def test_vector_pagination_preserves_boundary_and_last_row(self):
        try:
            import pymupdf as fitz
        except ImportError:
            self.skipTest('run with render-venv Python for vector PDF regression')
        with tempfile.TemporaryDirectory() as t:
            root = Path(t); source = root / 'fixture.xlsx'; workbook(source)
            pdf = root / 'long.pdf'; doc = fitz.open(); page = doc.new_page(width=500,height=3500)
            for y,text in [(30,'FIRST_ROW'),(1002,'BOUNDARY_ROW'),(3490,'LAST_ROW')]:
                page.insert_text((20,y),text,fontsize=10)
            page.draw_rect(fitz.Rect(10,10,490,3495))
            # LibreOffice uses /UserUnit for long worksheets. Raw MediaBox
            # coordinates would clip both the last row and the right column.
            doc.xref_set_key(page.xref, 'UserUnit', '3')
            page.insert_text((400,2000),'RIGHT_COLUMN',fontsize=10)
            doc.save(pdf);doc.close()
            before = r.sha256(source); audit = r.paginate_pdf(pdf,source)
            self.assertEqual(r.sha256(source),before)
            self.assertEqual(audit['text_words_missing'],0)
            self.assertGreater(audit['page_count'],1)
            with fitz.open(pdf) as doc:
                self.assertLessEqual(max(p.rect.height/p.rect.width for p in doc),2)
                text = ''.join(p.get_text() for p in doc)
                for marker in ['FIRST_ROW','BOUNDARY_ROW','LAST_ROW','RIGHT_COLUMN']: self.assertIn(marker,text)
                self.assertTrue(any(p.get_drawings() for p in doc))

    def test_sheet_names_cover_split_pages_and_hidden_sheet(self):
        try:
            import pymupdf as fitz
        except ImportError:
            self.skipTest('run with render-venv Python')
        with tempfile.TemporaryDirectory() as t:
            root = Path(t); source = root / 'fixture.xlsm'; workbook(source)
            pdf = root / 'rendered.pdf'; doc = fitz.open()
            for _ in range(4): doc.new_page()
            doc.save(pdf); doc.close()
            record = {'page_count':4, 'page_map':[
                {'source_page':1,'first_page':1,'last_page':3},
                {'source_page':2,'first_page':4,'last_page':4}]}
            before = r.sha256(source)
            result = r.sheet_navigation(source,pdf,record)['sheets']
            self.assertEqual([(s['name'],s['first_page'],s['last_page'],s['hidden']) for s in result],
                             [('Wide',1,3,False),('Hidden',4,4,True)])
            self.assertEqual(r.sha256(source),before)
            # PDF bookmarks trim names; displayed names still preserve the original.
            record['sheet_bookmarks']=[[1,' Wide ',1],[1,'Hidden',2]]
            self.assertEqual(r.sheet_navigation(source,pdf,record)['sheets'][0]['first_page'],1)
            # Export omitted a sheet: bookmarks identify the survivor by name.
            record.update(page_count=1,page_map=[{'source_page':1,'first_page':1,'last_page':1}],
                          sheet_bookmarks=[[1,'Hidden',1]])
            result = r.sheet_navigation(source,pdf,record)['sheets']
            self.assertIsNone(result[0]['first_page']);self.assertEqual(result[1]['first_page'],1)
            # No bookmark means an unequal sheet/page count must not be guessed.
            record['sheet_bookmarks']=[]
            self.assertTrue(all(s['first_page'] is None for s in r.sheet_navigation(source,pdf,record)['sheets']))

    def test_legacy_xls_bookmarks_survive_pagination(self):
        try:
            import pymupdf as fitz
        except ImportError:
            self.skipTest('run with render-venv Python')
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);source=root/'legacy.xls';source.write_bytes(b'fixture')
            pdf=root/'rendered.pdf';doc=fitz.open()
            page=doc.new_page(width=400,height=2200);page.insert_text((20,30),'FIRST')
            page=doc.new_page();page.insert_text((20,30),'SECOND')
            doc.set_toc([[1,'첫 시트',1],[1,'둘째 시트',2]]);doc.save(pdf);doc.close()
            record=r.paginate_pdf(pdf,source)
            result=r.sheet_navigation(source,pdf,record)['sheets']
            self.assertGreater(result[0]['last_page'],1)
            self.assertEqual(result[1]['first_page'],record['page_count'])
            self.assertEqual([s['name'] for s in result],['첫 시트','둘째 시트'])
            record['page_map'][1]['first_page']=1
            self.assertEqual(r.sheet_navigation(source,pdf,record)['sheets'],[])

    def test_pdf_original_bytes_preserved(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t); source = root / 'original.pdf'
            stream = b'BT /F1 12 Tf 20 50 Td (Original fidelity) Tj ET'
            objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
                b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
                b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
                b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
                b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream']
            data = b'%PDF-1.4\n'; offsets = [0]
            for i, obj in enumerate(objects, 1):
                offsets.append(len(data)); data += str(i).encode() + b' 0 obj\n' + obj + b'\nendobj\n'
            xref = len(data)
            data += b'xref\n0 6\n0000000000 65535 f \n'
            data += b''.join(f'{n:010} 00000 n \n'.encode() for n in offsets[1:])
            data += b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + str(xref).encode() + b'\n%%EOF\n'
            source.write_bytes(data)
            out = r.render_one(source, r.sha256(source), root / 'out')
            self.assertEqual(out['kind'], 'pdf')
            self.assertEqual(out['page_count'], 1)
            self.assertEqual((root / 'out' / out['assets'][0]['path']).read_bytes(), data)
            self.assertEqual(out['fidelity'], 'original-bytes')

    def test_mindmap_structure(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t); source = root / 'map.mm'
            source.write_text('<map><node TEXT="부모"><node TEXT="자식"/></node></map>')
            out = r.render_one(source, r.sha256(source), root / 'out')
            self.assertEqual((root / 'out' / out['assets'][0]['path']).read_text(), '- 부모\n  - 자식')
            self.assertEqual(out['fidelity'], 'structured-text')

    @unittest.skipUnless(os.environ.get('TEST_OFFICE') == '1', 'set TEST_OFFICE=1 for real offline LibreOffice')
    def test_office_hidden_sheets_full_width_cached_values(self):
        with tempfile.TemporaryDirectory(dir='/home/zenith/maintenance/company-upgrade-20261017') as t:
            root = Path(t); source = root / 'fixture.xlsx'; workbook(source)
            digest = r.sha256(source)
            out = r.render_one(source, digest, root / 'out', timeout=45)
            self.assertEqual(out['kind'], 'pdf', out)
            self.assertEqual(out['page_count'], 2)
            self.assertEqual(out['sheet_count'], 2)
            self.assertEqual([(s['name'],s['first_page'],s['hidden']) for s in out['sheets']], [('Wide',1,False),('Hidden',2,True)])
            pdf = root / 'out' / out['assets'][0]['path']
            text = subprocess.run(['pdftotext', '-layout', str(pdf), '-'], capture_output=True, check=True, text=True).stdout
            self.assertIn('777', text, 'cached formula value must not be recalculated')
            self.assertIn('LAST_COLUMN_MARKER', text)
            self.assertIn('HIDDEN_SHEET_MARKER', text)
            self.assertEqual(r.sha256(source), digest)

if __name__ == '__main__': unittest.main()
