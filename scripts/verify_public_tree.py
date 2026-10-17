#!/usr/bin/env python3
"""Fail closed if legacy plaintext content or private build files enter Pages."""
import json
import argparse
import re
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]/'docs');parser.add_argument('--documents',type=int,default=416);parser.add_argument('--topics',type=int,default=20);args=parser.parse_args();root=args.root
errors=[]
for name in ('data','previews'):
    if (root/name).exists():errors.append(f'Legacy plaintext directory: {name}')
manifest=json.loads((root/'secure/manifest.json').read_text())
if manifest.get('counts',{}).get('documents')!=args.documents:errors.append('Incomplete document catalog')
if manifest.get('counts',{}).get('topics')!=args.topics:errors.append('Incomplete topic catalog')
if manifest.get('iterations')!=600000:errors.append('Unexpected encryption parameters')
if not re.fullmatch(r'https://raw\.githubusercontent\.com/dkdleljh/company/[0-9a-f]{40}/objects/', manifest.get('asset_base','')):errors.append('Asset commit not pinned')
for file in root.rglob('*'):
    if not file.is_file():continue
    rel=file.relative_to(root).as_posix()
    if rel.startswith('assets/pdfjs/'):continue
    if file.suffix.lower() in {'.pdf','.hwp','.hwpx','.xlsx','.xlsm','.xls','.pptx','.docx','.zip','.exe','.apk','.rdb','.hdb','.bin'}:errors.append(f'Content or binary outside vendor: {rel}')
    if file.suffix=='.json' and rel!='secure/manifest.json':errors.append(f'Unexpected JSON: {rel}')
    if file.suffix in {'.js','.html','.css'} and 'ACCESS_HASH' in file.read_text():errors.append(f'Legacy public credential hash: {rel}')
if errors:raise SystemExit('\n'.join(errors))
print(json.dumps({'public_tree':'verified','documents':args.documents,'topics':args.topics,'bytes':sum(p.stat().st_size for p in root.rglob('*') if p.is_file())}))
