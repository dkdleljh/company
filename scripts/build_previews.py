#!/usr/bin/env python3
"""Build browser-readable previews for the static portal.

HWP is extracted page-by-page with rhwp. Other formats reuse the verified
corpus and refresh files that were intentionally limited during indexing.
Credential-like values are redacted before anything enters the public repo.
"""
from __future__ import annotations

import concurrent.futures
import csv
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

SOURCE_ROOT = Path('/home/zenith/Documents/Company')
CORPUS_CATALOG = Path('/home/zenith/memory/documents/company-corpus/catalog.json')
SITE_ROOT = Path(__file__).resolve().parents[1]
DOCS_JSON = SITE_ROOT / 'docs/data/documents.json'
PREVIEW_ROOT = SITE_ROOT / 'docs/previews'
MEDIA_ROOT = PREVIEW_ROOT / 'media'
MAX_TEXT = 2_000_000

SECRET_PATTERNS = [
    re.compile(r'(?i)(password|passwd|비밀번호|암호|api[_ -]?key|access[_ -]?token|secret|인증키)(\s*[:=]\s*)(\S+)'),
    re.compile(r'(?i)(authorization\s*:\s*bearer\s+)(\S+)'),
]


def stable_id(relative_path: str) -> str:
    return hashlib.sha256(relative_path.encode('utf-8')).hexdigest()[:24]


def redact(text: str, relative_path: str) -> tuple[str, bool]:
    changed = False
    if '계정정보' in relative_path:
        return '# 보호된 자격증명 문서\n\n이 문서는 계정·비밀번호를 포함할 수 있어 공개 정적 사이트 미리보기에서 제외했습니다. 원본은 Notion에서 확인하세요.\n', True
    text, path_count = re.subn(r'/home/zenith/Documents/Company/?', '', text)
    text, home_count = re.subn(r'/home/zenith/[^\s)\]]+', '[LOCAL_PATH]', text)
    changed |= path_count > 0 or home_count > 0
    for pattern in SECRET_PATTERNS:
        text, count = pattern.subn(lambda m: f'{m.group(1)}{m.group(2) if m.lastindex and m.lastindex >= 2 else ""}[REDACTED]', text)
        changed |= count > 0
    return text[:MAX_TEXT], changed


def numeric_page(path: Path) -> int:
    match = re.search(r'_(\d+)\.[^.]+$', path.name)
    return int(match.group(1)) if match else 0


def extract_hwp(item: dict) -> tuple[str, str, int, str | None]:
    source = Path(item['absolute_path'])
    with tempfile.TemporaryDirectory(prefix='rhwp-preview-') as tmp:
        result = subprocess.run(
            ['rhwp', 'export-text', str(source), '-o', tmp],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=420,
        )
        pages = sorted(Path(tmp).glob('*.txt'), key=numeric_page)
        if result.returncode or not pages:
            return '', 'rhwp v0.7.11', 0, (result.stderr or 'rhwp produced no pages')[-1000:]
        chunks = []
        for number, page in enumerate(pages, 1):
            body = page.read_text(encoding='utf-8', errors='replace').strip()
            chunks.append(f'## {number}쪽\n\n{body}')
        return '\n\n---\n\n'.join(chunks), 'rhwp v0.7.11', len(pages), None


def xlsx_preview(path: Path) -> str:
    ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    with zipfile.ZipFile(path) as archive:
        shared = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            root = ET.fromstring(archive.read('xl/sharedStrings.xml'))
            shared = [''.join(t.text or '' for t in si.findall('.//m:t', ns)) for si in root.findall('m:si', ns)]
        workbook = ET.fromstring(archive.read('xl/workbook.xml'))
        rels_root = ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))
        rels = {r.attrib['Id']: r.attrib['Target'] for r in rels_root}
        out = []
        for sheet in workbook.findall('.//m:sheet', ns):
            name = sheet.attrib.get('name', 'Sheet')
            rid = sheet.attrib.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
            target = rels.get(rid or '', '')
            entry = target.lstrip('/') if target.startswith('/') else 'xl/' + target.replace('../', '')
            if entry not in archive.namelist():
                continue
            xml = ET.fromstring(archive.read(entry))
            out.append(f'## 시트: {name}')
            for row in xml.findall('.//m:sheetData/m:row', ns):
                values = []
                for cell in row.findall('m:c', ns):
                    value = cell.find('m:v', ns)
                    inline = cell.find('m:is/m:t', ns)
                    text = inline.text if inline is not None else (value.text if value is not None else '')
                    if cell.attrib.get('t') == 's' and text and text.isdigit():
                        idx = int(text)
                        text = shared[idx] if idx < len(shared) else text
                    values.append((text or '').replace('\n', ' '))
                if any(values):
                    out.append(' | '.join(values))
        return '\n\n'.join(out)


def pptx_preview(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        slides = sorted(
            (n for n in archive.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml', n)),
            key=lambda n: int(re.findall(r'\d+', n)[-1]),
        )
        chunks = []
        for idx, slide in enumerate(slides, 1):
            root = ET.fromstring(archive.read(slide))
            texts = [node.text or '' for node in root.iter() if node.tag.endswith('}t')]
            chunks.append(f'## 슬라이드 {idx}\n\n' + '\n\n'.join(t for t in texts if t.strip()))
        return '\n\n---\n\n'.join(chunks)


def extract_refresh(item: dict) -> tuple[str, str, int, str | None]:
    path = Path(item['absolute_path'])
    ext = item['extension'].lower()
    try:
        if ext == '.pdf':
            result = subprocess.run(['pdftotext', '-layout', str(path), '-'], capture_output=True, text=True, timeout=180)
            return result.stdout, 'poppler pdftotext', 0, result.stderr[-1000:] if result.returncode else None
        if ext in {'.xlsx', '.xlsm'}:
            return xlsx_preview(path), 'OOXML worksheet parser', 0, None
        if ext == '.pptx':
            return pptx_preview(path), 'OOXML slide parser', 0, None
        if ext in {'.md', '.txt', '.csv'}:
            return path.read_text(encoding='utf-8', errors='replace'), 'UTF-8 text reader', 0, None
        if ext == '.zip':
            with zipfile.ZipFile(path) as archive:
                return '# 압축파일 구성\n\n' + '\n'.join(f'- {name}' for name in archive.namelist()), 'ZIP directory reader', 0, None
    except Exception as error:
        return '', 'preview extractor', 0, str(error)
    return '', '', 0, None


def build_one(item: dict) -> dict:
    relative_path = item['relative_path']
    ext = item['extension'].lower()
    corpus_path = Path(item['extracted_markdown'])
    error = None
    page_count = 0
    media_url = None

    if ext == '.hwp':
        text, engine, page_count, error = extract_hwp(item)
    elif ext in {'.jpg', '.jpeg', '.png', '.webp'}:
        media_name = stable_id(relative_path) + ext
        MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item['absolute_path'], MEDIA_ROOT / media_name)
        text, engine, media_url = f'# 이미지 미리보기\n\n![{Path(relative_path).name}](../media/{media_name})', 'browser image viewer', f'./previews/media/{media_name}'
    elif item.get('limited') or item.get('extractor') == 'reviewed-classification':
        text, engine, page_count, error = extract_refresh(item)
        if not text:
            text = corpus_path.read_text(encoding='utf-8', errors='replace')
            engine = item.get('extractor') or 'corpus fallback'
    else:
        text = corpus_path.read_text(encoding='utf-8', errors='replace')
        engine = item.get('extractor') or 'indexed corpus'

    text, redacted = redact(text, relative_path)
    preview_id = stable_id(relative_path)
    payload = {
        'relative_path': relative_path,
        'title': item.get('title') or Path(relative_path).name,
        'format': ext.lstrip('.').upper() or 'FILE',
        'engine': engine,
        'page_count': page_count,
        'content': text,
        'media_url': media_url,
        'redacted': redacted,
        'error': error,
    }
    (PREVIEW_ROOT / f'{preview_id}.json').write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
    return {'preview_id': preview_id, 'preview_engine': engine, 'preview_available': bool(text or media_url), 'preview_pages': page_count, 'preview_redacted': redacted}


def main() -> None:
    PREVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
    catalog = json.loads(CORPUS_CATALOG.read_text(encoding='utf-8'))
    documents = json.loads(DOCS_JSON.read_text(encoding='utf-8'))
    by_path = {item['relative_path']: item for item in catalog}
    missing = sorted(set(documents) - set(by_path))
    if missing:
        raise SystemExit(f'catalog missing {len(missing)} paths')

    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(build_one, by_path[path]): path for path in documents}
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            path = futures[future]
            try:
                results[path] = future.result()
            except Exception as error:
                print(f'FAILED {path}: {error}')
                results[path] = {'preview_available': False, 'preview_error': str(error)}
            if index % 25 == 0 or index == len(futures):
                print(f'progress {index}/{len(futures)}')

    for path, doc in documents.items():
        doc.update(results[path])
    DOCS_JSON.write_text(json.dumps(documents, ensure_ascii=False, indent=2), encoding='utf-8')

    stats = {
        'total': len(documents),
        'available': sum(bool(d.get('preview_available')) for d in documents.values()),
        'hwp': sum(d.get('extension') == 'hwp' for d in documents.values()),
        'hwp_with_pages': sum(d.get('extension') == 'hwp' and d.get('preview_pages', 0) > 0 for d in documents.values()),
        'redacted': sum(bool(d.get('preview_redacted')) for d in documents.values()),
    }
    (PREVIEW_ROOT / 'manifest.json').write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(stats, ensure_ascii=False))


if __name__ == '__main__':
    main()
