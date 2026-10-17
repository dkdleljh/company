#!/usr/bin/env python3
"""Private, resumable visual document rendering. Never uploads or edits sources.

Run with Python 3 (stdlib; Pillow is optional for image validation). Requires
rhwp, pdfinfo, pdftotext, dbus-run-session and the LibreOffice Flatpak. Office conversion runs in
an offline sandbox, with a disposable profile, disabled macros/active content,
no external-link updates, and cached formula values. Rendering is not a promise
of pixel-identical Office/HWP reproduction: original downloads remain canonical.
"""
from __future__ import annotations
import argparse
import concurrent.futures
import hashlib
import json
import mimetypes
import bisect
import posixpath
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter

VERSION = 1
DEFAULT_CATALOG = Path('/home/zenith/memory/documents/company-corpus/catalog.json')
DEFAULT_OUT = Path('/home/zenith/maintenance/company-upgrade-20261017/rendered')
SPREADSHEETS = {'.xlsx', '.xls', '.xlsm', '.ods'}
OFFICE = {'.xlsx', '.xls', '.xlsm', '.pptx', '.ppt', '.doc', '.docx', '.odt', '.ods', '.odp'}
TEXT = {'.txt', '.md', '.csv', '.log', '.json'}
IMAGE = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.tif'}


def sha256(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def run_bounded(command, timeout=90, env=None):
    """Kill only our process group, including Flatpak/LibreOffice descendants."""
    p = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         start_new_session=True, env=env)
    try:
        out, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGTERM)
        try:
            p.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            p.communicate()
        raise TimeoutError(f'conversion timeout ({timeout}s)')
    if p.returncode:
        # Document content and tool stdout must not leak into logs/manifest.
        raise RuntimeError(f'{Path(command[0]).name} failed (exit {p.returncode})')
    return out


def safe_xml(data):
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        raise ValueError('DTD/entity declarations are not accepted')
    return ET.fromstring(data)


def decode_text(data):
    if data.startswith(b'\xef\xbb\xbf'):
        return data.decode('utf-8-sig'), 'utf-8-sig'
    if data.startswith((b'\xff\xfe', b'\xfe\xff')):
        return data.decode('utf-16'), 'utf-16'
    for enc in ('utf-8', 'cp949', 'euc-kr'):
        try:
            text = data.decode(enc)
            if '\x00' in text:
                continue
            return text, enc
        except UnicodeDecodeError:
            pass
    raise ValueError('text encoding could not be decoded losslessly')


def pdf_pages(path):
    out = run_bounded(['pdfinfo', str(path)], 60).decode('utf-8', 'replace')
    match = re.search(r'^Pages:\s+(\d+)', out, re.M)
    if not match or int(match[1]) < 1:
        raise ValueError('PDF has no readable pages')
    return int(match[1])


def numeric_page(path):
    numbers = re.findall(r'\d+', path.stem)
    return int(numbers[-1]) if numbers else 0


def asset(path, output, mime=None):
    return {'path': str(path.relative_to(output)),
            'mime': mime or mimetypes.guess_type(path.name)[0] or 'application/octet-stream',
            'bytes': path.stat().st_size}


def write_json(path, data):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    tmp.replace(path)


def office_profile(profile):
    settings = {
        '/org.openoffice.Office.Common/Security/Scripting': {
            'MacroSecurityLevel': 3, 'DisableMacrosExecution': True,
            'DisableActiveContent': True, 'BlockUntrustedRefererLinks': True},
        '/org.openoffice.Office.Calc/Content/Update': {'Link': 1},
        '/org.openoffice.Office.Calc/Formula/Load': {
            'OOXMLRecalcMode': 1, 'ODFRecalcMode': 1, 'RecalcOptimalRowHeightMode': 1},
    }
    body = ['<?xml version="1.0" encoding="UTF-8"?>',
            '<oor:items xmlns:oor="http://openoffice.org/2001/registry">']
    for path, props in settings.items():
        body.append(f'<item oor:path="{path}">')
        for name, value in props.items():
            val = str(value).lower() if isinstance(value, bool) else str(value)
            body.append(f'<prop oor:name="{name}" oor:op="fuse"><value>{val}</value></prop>')
        body.append('</item>')
    body.append('</oor:items>')
    user = profile / 'user'
    user.mkdir(parents=True)
    (user / 'registrymodifications.xcu').write_text(''.join(body), encoding='utf-8')


def rich_text_hyperlinks(source, apply=False):
    """Remove hyperlink fields that make Calc discard rich text formatting.

    apply=True is used only on the disposable staged source, never the original.
    Cell values, run styles, widths/heights, merges, and original downloads stay
    unchanged. Ordinary hyperlink cells are preserved.
    """
    if source.suffix.lower() not in {'.xlsx', '.xlsm'} or not zipfile.is_zipfile(source):
        return 0
    ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    replacements = {}
    count = 0
    with zipfile.ZipFile(source) as z:
        rich = set()
        if 'xl/sharedStrings.xml' in z.namelist():
            rich = {str(i) for i, si in enumerate(safe_xml(z.read('xl/sharedStrings.xml')))
                    if len(si.findall('m:r', ns)) > 1}
        for name in z.namelist():
            if not re.fullmatch(r'xl/worksheets/sheet\d+\.xml', name):
                continue
            data = z.read(name)
            root = safe_xml(data)
            refs = {c.get('r') for c in root.findall('.//m:c', ns)
                if (c.get('t') == 's' and c.findtext('m:v', default='', namespaces=ns) in rich)
                or len(c.findall('m:is/m:r', ns)) > 1}
            affected = {h.get('ref') for h in root.findall('.//m:hyperlink', ns) if h.get('ref') in refs}
            if not affected:
                continue
            # Byte-level removal preserves every other OOXML part and prefix.
            def remove(match):
                nonlocal count
                ref = re.search(rb"\bref=[\"']([^\"']+)[\"']", match[0])
                if ref and ref[1].decode('ascii') in affected:
                    count += 1
                    return b''
                return match[0]
            replacements[name] = re.sub(rb'<(?:[A-Za-z_][\w.-]*:)?hyperlink\b[^>]*/>', remove, data)
        if apply and count:
            temporary = source.with_suffix(source.suffix + '.normalized')
            with zipfile.ZipFile(temporary, 'w') as output:
                for entry in z.infolist():
                    output.writestr(entry, replacements.get(entry.filename, z.read(entry.filename)))
    if apply and count:
        temporary.replace(source)
    return count


def office_worker(stage):
    """Executed inside an offline Flatpak and a private desktop D-Bus session."""
    stage = Path(stage)
    profile = stage / 'profile'
    office_profile(profile)
    source = next(stage.glob('source.*'))
    is_calc = source.suffix in {'.xlsx', '.xls', '.xlsm', '.ods'}
    is_impress = source.suffix in {'.pptx', '.ppt', '.odp'}
    meta = {}
    normalized_links = rich_text_hyperlinks(source, apply=True)
    meta['rich_text_hyperlink_fix_version'] = 1
    meta['rich_text_hyperlinks_normalized'] = normalized_links
    if source.suffix in {'.xlsx', '.xlsm'} and zipfile.is_zipfile(source):
        with zipfile.ZipFile(source) as z:
            root = safe_xml(z.read('xl/workbook.xml'))
            sheets = [n for n in root.iter() if n.tag.endswith('}sheet')]
            meta.update(sheet_count=len(sheets), sheet_names=[n.get('name','') for n in sheets])
    elif source.suffix == '.pptx':
        with zipfile.ZipFile(source) as z:
            meta['slide_count'] = len([n for n in z.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml',n)])
    filt = 'calc_pdf_Export' if is_calc else 'impress_pdf_Export' if is_impress else 'writer_pdf_Export'
    options = {k: {'type':'boolean', 'value':str(v).lower()} for k,v in {
        'UseLosslessCompression':True,'ReduceImageResolution':False,
        'ExportBookmarks':True,'ExportHiddenSlides':True,'ExportNotesPages':False,
        'SinglePageSheets':is_calc,'EmbedStandardFonts':True}.items()}
    command = ['/app/libreoffice/program/soffice',
        '-env:UserInstallation=' + profile.as_uri(), '--headless','--nologo',
        '--nodefault','--norestore','--nolockcheck','--convert-to',
        'pdf:' + filt + ':' + json.dumps(options,separators=(',',':')),
        '--outdir',str(stage),str(source)]
    result = subprocess.run(command,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if result.returncode or not (stage / 'source.pdf').exists():
        raise RuntimeError('office PDF export failed')
    (stage / 'source.pdf').rename(stage / 'rendered.pdf')
    meta['office_security_version'] = 3
    write_json(stage / 'office-meta.json',meta)


def convert_office(source, target, timeout):
    with tempfile.TemporaryDirectory(prefix='office-', dir=target) as temporary:
        stage = Path(temporary)
        shutil.copyfile(source, stage / ('source' + source.suffix.lower()))
        worker = stage / 'worker.py'
        shutil.copyfile(__file__, worker)
        env = os.environ.copy()
        env['SAL_USE_VCLPLUGIN'] = 'svp'
        # A private D-Bus session prevents Flatpak LibreOffice forwarding to
        # unrelated desktop instances despite separate UserInstallation paths.
        command = ['dbus-run-session', '--', 'flatpak', 'run', '--unshare=network', '--nofilesystem=host:reset',
            '--nofilesystem=home', '--filesystem=' + str(stage),
            '--env=PYTHONPATH=/app/libreoffice/program', '--env=SAL_USE_VCLPLUGIN=svp',
            '--command=python3', 'org.libreoffice.LibreOffice', str(worker),
            '--office-worker', str(stage)]
        run_bounded(command, timeout=timeout, env=env)
        rendered = stage / 'rendered.pdf'
        pages = pdf_pages(rendered)
        meta = json.loads((stage / 'office-meta.json').read_text())
        # Empty sheets may produce no page even with SinglePageSheets. This is
        # recorded explicitly, never silently advertised as full reproduction.
        expected = meta.get('slide_count')
        if expected and pages != expected:
            raise ValueError('slide/page count mismatch')
        if meta.get('sheet_count') and pages != meta['sheet_count']:
            meta['page_count_warning'] = 'Empty sheets may be omitted from PDF; original workbook preserves all sheets.'
        shutil.copyfile(rendered, target / 'rendered.pdf')
        return pages, meta


def ooxml_search_text(source):
    """Index full stored cells/slides even when the visual layout clips text."""
    chunks = []
    if not zipfile.is_zipfile(source):
        return ''
    with zipfile.ZipFile(source) as z:
        if source.suffix.lower() in {'.xlsx', '.xlsm'}:
            shared = []
            if 'xl/sharedStrings.xml' in z.namelist():
                root = safe_xml(z.read('xl/sharedStrings.xml'))
                shared = [''.join(n.text or '' for n in si.iter() if n.tag.endswith('}t')) for si in root]
            workbook = safe_xml(z.read('xl/workbook.xml'))
            chunks.extend(n.get('name','') for n in workbook.iter() if n.tag.endswith('}sheet'))
            for name in sorted(z.namelist()):
                if re.fullmatch(r'xl/worksheets/sheet\d+\.xml', name):
                    root = safe_xml(z.read(name))
                    for cell in (n for n in root.iter() if n.tag.endswith('}c')):
                        value = next((n.text or '' for n in cell if n.tag.endswith('}v')), '')
                        if cell.get('t') == 's' and value.isdigit():
                            value = shared[int(value)] if int(value) < len(shared) else ''
                        elif cell.get('t') == 'inlineStr':
                            value = ''.join(n.text or '' for n in cell.iter() if n.tag.endswith('}t'))
                        if value: chunks.append(value)
        elif source.suffix.lower() == '.pptx':
            for name in sorted(z.namelist()):
                if re.fullmatch(r'ppt/(?:slides/slide|notesSlides/notesSlide)\d+\.xml', name):
                    chunks.append('\n'.join(n.text or '' for n in safe_xml(z.read(name)).iter() if n.tag.endswith('}t')))
    return '\n'.join(chunks)


def extract_search(source, target, kind, assets):
    output = target / 'search.txt'
    if source.suffix.lower() in {'.xlsx', '.xlsm'} and zipfile.is_zipfile(source):
        # Whole-sheet PDFs can have enormous page coordinates; extracting
        # every stored source cell is complete and avoids costly PDF layout.
        output.write_text(ooxml_search_text(source), encoding='utf-8')
        return output
    if kind == 'pdf':
        path = target / ('original.pdf' if source.suffix.lower() == '.pdf' else 'rendered.pdf')
        run_bounded(['pdftotext', '-layout', str(path), str(output)], 120)
        if source.suffix.lower() in {'.xlsx', '.xlsm', '.pptx'}:
            with output.open('a', encoding='utf-8') as f:
                f.write('\n\n' + ooxml_search_text(source))
    elif kind == 'svg-pages':
        with tempfile.TemporaryDirectory(prefix='text-', dir=target) as tmp:
            run_bounded(['rhwp', 'export-text', str(source), '-o', tmp], 120)
            pages = sorted(Path(tmp).glob('*.txt'), key=numeric_page)
            output.write_text('\n\n'.join(p.read_text(encoding='utf-8') for p in pages), encoding='utf-8')
    elif kind == 'text':
        shutil.copyfile(target / 'content.txt', output)
    return output if output.exists() else None


def sheet_value_counts(source):
    """Workbook order is essential: a PDF page corresponds to that sheet."""
    if not zipfile.is_zipfile(source):
        return []
    ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    with zipfile.ZipFile(source) as z:
        if 'xl/workbook.xml' not in z.namelist():
            return []
        workbook = safe_xml(z.read('xl/workbook.xml'))
        rels = {r.get('Id'): r.get('Target') for r in safe_xml(z.read('xl/_rels/workbook.xml.rels'))}
        result = []
        for sheet in workbook.findall('m:sheets/m:sheet', ns):
            target = rels[sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')]
            entry = target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/' + target)
            root = safe_xml(z.read(entry))
            count = sum(1 for c in root.findall('.//m:c', ns)
                if c.find('m:f', ns) is not None or c.findtext('m:v', default='', namespaces=ns)
                or any(t.text for t in c.findall('m:is//m:t', ns)))
            # Drawing-only sheets are not empty: these may contain text boxes,
            # charts, pictures, controls, or OLE objects without cell values.
            if any(root.findall('.//m:'+tag,ns) for tag in
                   ('drawing','legacyDrawing','legacyDrawingHF','oleObjects','controls','picture')):
                count += 1
            result.append(count)
        return result


def paginate_pdf(pdf, original_source):
    """Bound visual page height while keeping source content as vector PDF."""
    import pymupdf as fitz
    doc = fitz.open(pdf)
    counts = sheet_value_counts(original_source)
    dimensions = []
    for page in doc:
        kind, raw = doc.xref_get_key(page.xref, 'MediaBox')
        coords = [float(x) for x in re.findall(r'[-+]?(?:\d*\.\d+|\d+)(?:[Ee][-+]?\d+)?', raw)] if kind == 'array' else []
        width, height = (coords[2]-coords[0],coords[3]-coords[1]) if len(coords)==4 else (page.rect.width,page.rect.height)
        # Text/clip coordinates include /UserUnit; raw MediaBox does not.
        # Only retain raw units for malformed, truly empty worksheet pages.
        if not (width <= 1 and height/max(width,.00001) > 2):
            width,height = page.rect.width,page.rect.height
        dimensions.append((width,height))
    audit = {'pagination_version': 1, 'original_page_count': len(doc),
        'paginated_source_pages': [], 'empty_sheet_pages_normalized': [],
        'page_map': [], 'text_words_missing': 0}
    if original_source.suffix.lower() in SPREADSHEETS:
        audit['sheet_bookmarks'] = doc.get_toc()
    if not any(h/max(w,.00001)>2 for w,h in dimensions):
        audit['page_map'] = [{'source_page':i+1,'first_page':i+1,'last_page':i+1} for i in range(len(doc))]
        audit.update(page_count=len(doc), max_page_height_width_ratio=max(h/max(w,.00001) for w,h in dimensions))
        doc.close()
        return audit
    output = fitz.open()
    comparisons = []
    for index,(width,height) in enumerate(dimensions):
        page = doc[index]
        first_output = len(output)
        if width <= 1 and height/ max(width,.00001)>2:
            if index >= len(counts) or counts[index] != 0 or page.get_images() or page.get_text().strip():
                raise ValueError('degenerate page is not a proven empty worksheet')
            empty = output.new_page(width=595.28,height=841.89)
            empty.insert_text((36,54), '빈 시트', fontname='korea', fontsize=12)
            audit['empty_sheet_pages_normalized'].append(index+1)
        elif height/width <= 2:
            output.insert_pdf(doc,from_page=index,to_page=index)
        else:
            words = page.get_text('words')
            before = Counter(w[4] for w in words)
            # Merge line-height intervals so a split never bisects a text row.
            intervals = []
            for top,bottom in sorted((w[1],w[3]) for w in words):
                if intervals and top <= intervals[-1][1] + .05:
                    intervals[-1][1] = max(intervals[-1][1],bottom)
                else:
                    intervals.append([top,bottom])
            starts = [a for a,b in intervals]
            # A one-column sheet must not become dozens of tiny pages.
            # Pad only the PDF paper width; never scale or rearrange content.
            paper_width = max(width,300)
            overlap = min(80,max(16,max((w[3]-w[1] for w in words),default=16)))
            y = 0.0
            while y < height - .01:
                end = min(height,y+paper_width*2-2*overlap)
                if end < height:
                    j = bisect.bisect_right(starts,end)-1
                    if j>=0 and intervals[j][0] < end < intervals[j][1]:
                        candidate = intervals[j][0]-.1
                        if candidate > y+paper_width*.5:
                            end = candidate
                clip_start,clip_end = max(0,y-overlap),min(height,end+overlap)
                destination = output.new_page(width=paper_width,height=clip_end-clip_start)
                destination.show_pdf_page(fitz.Rect(0,0,width,clip_end-clip_start),doc,index,
                    clip=fitz.Rect(0,clip_start,width,clip_end))
                y=end
            audit['paginated_source_pages'].append(index+1)
            comparisons.append((first_output,len(output),before))
        audit['page_map'].append({'source_page':index+1,'first_page':first_output+1,'last_page':len(output)})
    # Verify *rendered PDF text*, not the separate OOXML search index.
    missing = 0
    missing_chars = 0
    for first,last,before in comparisons:
        after = Counter()
        for i in range(first,last):
            after.update(w[4] for w in output[i].get_text('words'))
        missing += sum((before-after).values())
        before_chars = Counter({})
        after_chars = Counter({})
        for word,n in before.items():
            for char in word: before_chars[char] += n
        for word,n in after.items():
            for char in word: after_chars[char] += n
        missing_chars += sum((before_chars-after_chars).values())
    if missing:
        raise ValueError(f'pagination text comparison: {missing} word tokens, {missing_chars} characters missing')
    temporary = pdf.with_suffix('.paginated.pdf')
    output.save(temporary,garbage=4,deflate=True)
    audit.update(page_count=len(output), max_page_height_width_ratio=max(p.rect.height/p.rect.width for p in output))
    output.close(); doc.close()
    temporary.replace(pdf)
    return audit


def ensure_paginated(source, target, record, output):
    if record.get('pagination_version') == 1:
        if not record.get('page_map') and not record.get('paginated_source_pages'):
            record['page_map'] = [{'source_page':i+1,'first_page':i+1,'last_page':i+1}
                                  for i in range(record['original_page_count'])]
        return record
    if not str(record.get('renderer','')).startswith('LibreOffice'):
        return record
    pdf = target / 'rendered.pdf'
    interpreter = Path(os.environ.get('RENDER_PDF_PYTHON', str(DEFAULT_OUT.parent / 'render-venv/bin/python')))
    result = run_bounded([str(interpreter),str(Path(__file__).resolve()),
        '--paginate-worker',str(pdf),'--original-source',str(source)],300)
    audit = json.loads(result)
    record.update(audit)
    record['assets'] = [asset(pdf,output)]
    if audit['paginated_source_pages'] or audit['empty_sheet_pages_normalized']:
        record['reason'] = '원본의 서식 변환본입니다. 긴 시트는 전체 열을 유지해 여러 쪽으로 나누고, 값·수식이 없는 빈 시트도 표시합니다. 글꼴·도형 배치는 원본 프로그램과 다를 수 있습니다.'
    return record


def sheet_navigation(source, pdf, record):
    """Resolve sheet identities only against a complete, contiguous page map."""
    import pymupdf as fitz
    sheets = []
    if source.suffix.lower() in {'.xlsx', '.xlsm'}:
        with zipfile.ZipFile(source) as z:
            root = safe_xml(z.read('xl/workbook.xml'))
            sheets = [{'name':n.get('name',''), 'hidden':n.get('state','visible') != 'visible'}
                      for n in root.iter() if n.tag.endswith('}sheet')]
    page_map = record.get('page_map', [])
    cursor = 1
    for i, page in enumerate(page_map):
        if (page.get('source_page') != i+1 or page.get('first_page') != cursor
                or type(page.get('last_page')) is not int or page['last_page'] < cursor):
            return {'sheets':[], 'sheet_navigation_version':2}
        cursor = page['last_page']+1
    if not page_map or cursor != record['page_count']+1:
        return {'sheets':[], 'sheet_navigation_version':2}
    # Fresh conversion keeps bookmarks BEFORE tall pages are split. Old caches
    # may still contain bookmarks pointing at final page numbers.
    bookmarks = record.get('sheet_bookmarks')
    if bookmarks is None:
        with fitz.open(pdf) as doc:
            toc = doc.get_toc()
        starts = {p['first_page']:p['source_page'] for p in page_map}
        bookmarks = [[level,name,starts.get(page,0)] for level,name,page in toc]
    valid = (len(bookmarks) == len(page_map)
             and all(b[0] == 1 and b[2] == i+1 and isinstance(b[1],str) and b[1]
                     for i,b in enumerate(bookmarks)))
    if not sheets and valid:
        sheets = [{'name':b[1], 'hidden':False} for b in bookmarks]
    mapping = {}
    names = [s['name'].strip() for s in sheets]
    if valid and len(set(names)) == len(names) and len({b[1].strip() for b in bookmarks}) == len(bookmarks) and all(b[1].strip() in names for b in bookmarks):
        mapping = {b[1].strip():page_map[i] for i,b in enumerate(bookmarks)}
    elif not bookmarks and len(set(names)) == len(names) and len(sheets) == len(page_map):
        # SinglePageSheets export: each source page is exactly one worksheet.
        mapping = dict(zip(names,page_map))
    result = []
    for i, sheet in enumerate(sheets):
        page = mapping.get(sheet['name'].strip())
        result.append({**sheet, 'index':i+1,
            'first_page':page['first_page'] if page else None,
            'last_page':page['last_page'] if page else None})
    return {'sheets':result, 'sheet_navigation_version':2}


def ensure_sheet_navigation(source, target, record):
    if (source.suffix.lower() not in SPREADSHEETS or record.get('kind') != 'pdf'
            or record.get('sheet_navigation_version') == 2):
        return record
    interpreter = Path(os.environ.get('RENDER_PDF_PYTHON', str(DEFAULT_OUT.parent / 'render-venv/bin/python')))
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', dir=target) as temporary:
        json.dump(record,temporary); temporary.flush()
        result = run_bounded([str(interpreter),str(Path(__file__).resolve()),
            '--sheets-worker',temporary.name,'--original-source',str(source)],90)
    record.update(json.loads(result))
    return record


def encrypted_office(source):
    with source.open('rb') as f:
        if f.read(8) != bytes.fromhex('d0cf11e0a1b11ae1'):
            return False
    # OOXML encrypted containers expose these standard CFB directory names;
    # no password attempts, decryption, or application execution is performed.
    data = source.read_bytes()
    return 'EncryptedPackage'.encode('utf-16le') in data and 'EncryptionInfo'.encode('utf-16le') in data


def render_one(source, digest, output, timeout=90, retry=False):
    target = output / 'assets' / digest
    cache = target / 'record.json'
    if cache.exists() and not retry:
        record = json.loads(cache.read_text())
        rich_text_cache_valid = (record.get('rich_text_hyperlink_fix_version') == 1
            or source.suffix.lower() not in {'.xlsx', '.xlsm'}
            or not rich_text_hyperlinks(source))
        if rich_text_cache_valid and record.get('version') == VERSION and not record.get('error_type') and (source.suffix.lower() not in OFFICE or record.get('office_security_version') == 3) and all((output / a['path']).is_file() and (output / a['path']).stat().st_size == a['bytes'] for a in record.get('assets', [])) and (not record.get('search_text_file') or (output / record['search_text_file']).is_file()):
            if source.suffix.lower() in OFFICE and record.get('search_version') != 2:
                try:
                    search = extract_search(source, target, record['kind'], record['assets'])
                    if search:
                        record['search_text_file'] = str(search.relative_to(output))
                        record['search_text_bytes'] = search.stat().st_size
                    record['search_version'] = 2
                    record.pop('search_error', None)
                    write_json(cache, record)
                except Exception:
                    record['search_error'] = 'text extraction unavailable'
            record = ensure_paginated(source, target, record, output)
            record = ensure_sheet_navigation(source, target, record)
            write_json(cache, record)
            return record
    target.mkdir(parents=True, exist_ok=True)
    ext = source.suffix.lower()
    record = dict(version=VERSION, source_sha256=digest, source_bytes=source.stat().st_size,
        kind='unsupported', assets=[], page_count=0, reason=None, renderer=None, fidelity=None)
    try:
        if ext == '.pdf':
            dst = target / 'original.pdf'
            shutil.copyfile(source, dst)
            assert sha256(dst) == digest, 'PDF copy integrity mismatch'
            record.update(kind='pdf', assets=[asset(dst, output)], page_count=pdf_pages(dst),
                          renderer='original PDF', fidelity='original-bytes')
        elif ext in IMAGE:
            dst = target / ('original' + ext)
            shutil.copyfile(source, dst)
            assert sha256(dst) == digest, 'image copy integrity mismatch'
            try:
                from PIL import Image
                with Image.open(dst) as im:
                    im.verify()
                with Image.open(dst) as im:
                    record['width'], record['height'] = im.size
                    record['frame_count'] = getattr(im, 'n_frames', 1)
            except ImportError:
                pass
            record.update(kind='image', assets=[asset(dst, output)], page_count=1,
                          renderer='original image', fidelity='original-bytes')
        elif ext in {'.hwp', '.hwpx'}:
            # A fresh directory prevents stale trailing pages after a retry.
            pages_dir = Path(tempfile.mkdtemp(prefix='pages-', dir=target))
            run_bounded(['rhwp', 'export-svg', str(source), '-o', str(pages_dir), '--embed-fonts'], timeout)
            pages = sorted(pages_dir.glob('*.svg'), key=numeric_page)
            if not pages:
                raise ValueError('renderer produced no SVG pages')
            for p in pages:
                root = safe_xml(p.read_bytes())
                if not root.tag.endswith('svg'):
                    raise ValueError('invalid SVG page')
            record.update(kind='svg-pages', assets=[asset(p, output, 'image/svg+xml') for p in pages],
                page_count=len(pages), renderer='rhwp 0.7.11', fidelity='converted',
                reason='한글 문서의 서식 미리보기입니다. 대체 글꼴·도형·쪽 배치는 원본과 다를 수 있습니다.')
        elif ext in OFFICE and encrypted_office(source):
            record.update(renderer='encrypted Office container', office_security_version=3,
                reason='문서 자체에 열기 암호가 설정되어 미리보기를 만들 수 없습니다. 원본을 내려받아 문서 암호로 열어 주세요.')
        elif ext in OFFICE:
            count, meta = convert_office(source, target, timeout)
            record.update(kind='pdf', assets=[asset(target / 'rendered.pdf', output)], page_count=count,
                renderer='LibreOffice offline / macros disabled / cached formula values', fidelity='converted',
                reason='원본의 서식 변환본입니다. 글꼴·수식·차트는 원본 프로그램과 다를 수 있습니다.', **meta)
        elif ext in TEXT:
            text, enc = decode_text(source.read_bytes())
            dst = target / 'content.txt'
            dst.write_text(text, encoding='utf-8')
            record.update(kind='text', assets=[asset(dst, output, 'text/plain;charset=utf-8')],
                          encoding=enc, renderer='lossless text decoding', fidelity='text-content')
        elif ext == '.mm' and source.read_bytes()[:16].startswith(b'<TGE MMI FILE>'):
            record.update(renderer='proprietary TGE MMI binary',
                reason='전용 HMI·설비 화면 파일입니다. 브라우저에서 표시할 수 없으며 원본을 해당 설비 프로그램에서 열어 주세요.')
        elif ext == '.mm':
            root = safe_xml(source.read_bytes())
            lines = []
            def walk(node, depth=0):
                if node.tag.rsplit('}',1)[-1] == 'node':
                    label = node.attrib.get('TEXT', '')
                    rich = node.find('richcontent')
                    if rich is not None:
                        label += ' ' + ''.join(rich.itertext()).strip()
                    lines.append('  '*depth + '- ' + label)
                    for child in node:
                        if child.tag.rsplit('}',1)[-1] == 'node': walk(child, depth+1)
            for node in root:
                if node.tag.rsplit('}',1)[-1] == 'node': walk(node)
            dst = target / 'content.txt'; dst.write_text('\n'.join(lines), encoding='utf-8')
            record.update(kind='text', assets=[asset(dst, output, 'text/plain;charset=utf-8')],
                renderer='FreeMind structured XML', fidelity='structured-text',
                reason='마인드맵의 계층 구조입니다. 원래 배치는 원본 프로그램에서 확인하세요.')
        elif ext == '.zip':
            with zipfile.ZipFile(source) as z:
                entries = [{'name': x.filename, 'bytes': x.file_size, 'compressed_bytes': x.compress_size,
                            'encrypted': bool(x.flag_bits & 1), 'directory': x.is_dir()} for x in z.infolist()]
            dst = target / 'content.txt'
            dst.write_text('압축파일 구성 (파일을 실행하거나 압축 해제하지 않았습니다)\n\n' +
                '\n'.join(f"{x['name']}  ({x['bytes']:,} bytes)" for x in entries), encoding='utf-8')
            record.update(kind='text', assets=[asset(dst, output, 'text/plain;charset=utf-8')],
                renderer='ZIP central directory', fidelity='metadata-only',
                reason='압축파일 구성 목록입니다. 내부 문서의 미리보기는 원본을 내려받아 확인하세요.', entry_count=len(entries))
        else:
            record['reason'] = '실행파일·설치파일·전용 데이터베이스는 브라우저로 표시할 수 없습니다. 원본 파일을 해당 프로그램에서 열어 주세요.'
        try:
            search = extract_search(source, target, record['kind'], record['assets'])
            if search:
                record['search_text_file'] = str(search.relative_to(output))
                record['search_text_bytes'] = search.stat().st_size
                record['search_version'] = 2
        except Exception as err:
            record['search_error'] = type(err).__name__ + ': text extraction unavailable'
    except Exception as err:
        record.update(kind='unsupported', assets=[], page_count=0,
                      reason=f'서식 변환을 완료하지 못했습니다 ({type(err).__name__}). 원본 파일을 내려받아 확인하세요.',
                      error_type=type(err).__name__)
    record = ensure_paginated(source, target, record, output)
    record = ensure_sheet_navigation(source, target, record)
    write_json(cache, record)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', type=Path, default=DEFAULT_CATALOG)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUT)
    parser.add_argument('--workers', type=int, default=3)
    parser.add_argument('--timeout', type=int, default=90)
    parser.add_argument('--limit', type=int)
    parser.add_argument('--extensions', nargs='*')
    parser.add_argument('--retry', action='store_true')
    parser.add_argument('--office-worker')
    parser.add_argument('--paginate-worker',type=Path)
    parser.add_argument('--sheets-worker',type=Path)
    parser.add_argument('--original-source',type=Path)
    args = parser.parse_args()
    if args.sheets_worker:
        record = json.loads(args.sheets_worker.read_text())
        print(json.dumps(sheet_navigation(args.original_source,args.sheets_worker.parent / 'rendered.pdf',record)))
        return
    if args.paginate_worker:
        print(json.dumps(paginate_pdf(args.paginate_worker,args.original_source)))
        return
    if args.office_worker:
        office_worker(args.office_worker)
        return
    os.umask(0o077)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    items = json.loads(args.catalog.read_text())
    if args.extensions: items = [i for i in items if Path(i['absolute_path']).suffix.lower() in args.extensions]
    if args.limit: items = items[:args.limit]
    records = {}; sources = {}; digests = []
    for item in items:
        source = Path(item['absolute_path'])
        digest = sha256(source)
        sources.setdefault(digest, source)
        digests.append(digest)
    print(json.dumps({'stage':'start', 'sources':len(items), 'unique':len(sources)}, ensure_ascii=False), flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(render_one,s,d,output,args.timeout,args.retry):d for d,s in sources.items()}
        for n,future in enumerate(concurrent.futures.as_completed(futures),1):
            digest = futures[future]; records[digest] = future.result()
            print(json.dumps({'stage':'render','done':n,'total':len(sources), 'id':digest[:12],
                              'kind':records[digest]['kind'],'pages':records[digest]['page_count']}), flush=True)
    docs = [dict(records[d], relative_path=i['relative_path']) for i,d in zip(items,digests)]
    asset_paths = {a['path']:a['bytes'] for r in records.values() for a in r['assets']}
    totals = {'source_bytes_unique':sum(r['source_bytes'] for r in records.values()),
              'asset_bytes_unique':sum(asset_paths.values()),
              'search_text_bytes_unique':sum(r.get('search_text_bytes',0) for r in records.values()),
              'page_count_unique':sum(r['page_count'] for r in records.values()),
              'kind_counts':dict(Counter(d['kind'] for d in docs)),
              'unique_kind_counts':dict(Counter(r['kind'] for r in records.values()))}
    manifest = {'version':VERSION,'source_count':len(items),'unique_count':len(sources),'totals':totals,'documents':docs}
    write_json(output / 'manifest.json',manifest)
    print(json.dumps({'stage':'complete',**totals}), flush=True)

if __name__ == '__main__':
    main()
