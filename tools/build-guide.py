#!/usr/bin/env python3
"""Builds the platform guide into one file with the pictures inside: docs/guide/platform.html + docs/guide/img → <out>.
Usage: python3 tools/build-guide.py [out.html]"""
import base64, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = os.path.join(ROOT, 'docs', 'guide', 'platform.html')
img = os.path.join(ROOT, 'docs', 'guide', 'img')
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'dist', 'ІНСТРУКЦІЯ-запуск-платформи.html')
html = open(src, encoding='utf-8').read()
missing = []

def inline(m):
    p = os.path.join(img, m.group(1))
    if not os.path.exists(p):
        missing.append(m.group(1))
        return m.group(0)
    return 'src="data:image/png;base64,' + base64.b64encode(open(p, 'rb').read()).decode() + '"'

html = re.sub(r'src="([\w.-]+\.png)"', inline, html)
if missing:
    sys.exit('missing pictures: ' + ', '.join(missing))
os.makedirs(os.path.dirname(out), exist_ok=True)
open(out, 'w', encoding='utf-8').write(html)
print(out, os.path.getsize(out))
