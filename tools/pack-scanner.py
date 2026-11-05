#!/usr/bin/env python3
"""Packs the scanner for the operator: site-scanner/ (the extension) + «ЯК ВСТАНОВИТИ.html» (pictures inside).
Usage: python3 tools/pack-scanner.py <screenshots dir> <out dir>"""
import base64, json, os, re, shutil, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
shots, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
ver = json.load(open(os.path.join(ROOT, 'scanner', 'manifest.json')))['version']
guide = open(os.path.join(ROOT, 'scanner-guide', 'guide.html'), encoding='utf-8').read()

def inline(m):
    p = os.path.join(shots, m.group(1))
    data = base64.b64encode(open(p, 'rb').read()).decode()
    return f'src="data:image/png;base64,{data}"'

guide = re.sub(r'src="([\w.-]+\.png)"', inline, guide)
name = os.path.join(out, f'site-scanner-v{ver}.zip')
with zipfile.ZipFile(name, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in sorted(os.listdir(os.path.join(ROOT, 'scanner'))):
        p = os.path.join(ROOT, 'scanner', f)
        if os.path.isfile(p):
            z.write(p, f'site-scanner/{f}')
    z.writestr('ЯК ВСТАНОВИТИ.html', guide)
print(name, os.path.getsize(name))
