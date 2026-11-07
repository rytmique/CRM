#!/usr/bin/env python3
"""The package for a local test on a person's own computer (no server on the internet; the AI key is optional):
the code of the current commit + START-HERE.html + .env (the platform's Telegram bot token, if given).
Usage: python3 tools/pack-local.py <out.zip> [telegram_token] [guide.html]
The token goes only into the zip, never into git."""
import io, os, subprocess, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = sys.argv[1]
token = sys.argv[2] if len(sys.argv) > 2 else ''
guide = sys.argv[3] if len(sys.argv) > 3 else ''
code = subprocess.run(['git', 'archive', '--format=zip', '--prefix=agency-crm/', 'HEAD'], cwd=ROOT, check=True, capture_output=True).stdout
src = zipfile.ZipFile(io.BytesIO(code))
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for info in src.infolist():
        name = info.filename
        # tests, the scanner and the dev docs are not needed to run it
        if any(name.startswith(f'agency-crm/{d}/') for d in ('test', 'scanner', 'scanner-guide', 'e2e-out', 'docs')):
            continue
        z.writestr(info, src.read(info))
    env = ['# Local test settings (read by the server at start)']
    if token:
        env.append(f'TELEGRAM_BOT_TOKEN={token}')
    env.append('# ANTHROPIC_API_KEY=sk-ant-...   (or put the key in the panel: ШІ)')
    z.writestr('agency-crm/.env', '\n'.join(env) + '\n')
    if guide:
        z.write(guide, 'agency-crm/START-HERE.html')
print(out, os.path.getsize(out))
