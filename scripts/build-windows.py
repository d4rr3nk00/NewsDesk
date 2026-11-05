"""Assemble verified official Windows runtimes and compile a per-user NSIS installer."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DOWNLOADS = Path(os.environ['DESK_DOWNLOADS'])
ELECTRON = '45.2.3'
PYTHON = '3.14.8'

def verified_zip(name, expected):
    archive = DOWNLOADS / name
    with archive.open('rb') as stream:
        actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    if actual != expected:
        raise RuntimeError(f'Checksum mismatch: {name}')
    return archive

name = f'electron-v{ELECTRON}-win32-x64.zip'
checks = (DOWNLOADS / f'electron-{ELECTRON}-SHASUMS256.txt').read_text()
expected = next(line.split()[0] for line in checks.splitlines() if line.split()[-1].lstrip('*') == name)
electron_zip = verified_zip(name, expected)
name = f'python-{PYTHON}-embed-amd64.zip'
sbom = json.loads((DOWNLOADS / (name+'.spdx.json')).read_text())
expected = next(c['checksumValue'] for p in sbom['packages'] if p['name'] == 'CPython' for c in p['checksums'] if c['algorithm'] == 'SHA256')
python_zip = verified_zip(name, expected)
build = ROOT / 'build/windows'
if build.exists():
    shutil.rmtree(build)
build.mkdir(parents=True)
with zipfile.ZipFile(electron_zip) as archive:
    archive.extractall(build)
(build/'electron.exe').rename(build/'NewsDesk.exe')
(build/'resources/default_app.asar').unlink(missing_ok=True)
shutil.copytree(ROOT/'desktop/shell', build/'resources/app')
py_dir = build/'resources/python'
with zipfile.ZipFile(python_zip) as archive:
    archive.extractall(py_dir)
# Embedded Python uses explicit private search paths. No global Python installation is read.
(py_dir/'python314._pth').write_text('python314.zip\n.\n../payload\n../payload/reporting-desk\n', encoding='utf-8')
payload = build/'resources/payload'
payload.mkdir()
shutil.copy2(ROOT/'desktop/backend.py', payload/'backend.py')
shutil.copytree(ROOT/'reporting-desk', payload/'reporting-desk', ignore=shutil.ignore_patterns('data','__pycache__','*.pyc'))
# Ship upstream license notices unchanged.
shutil.copy2(DOWNLOADS / f'python-{PYTHON}-embed-amd64.zip.spdx.json', py_dir/'SBOM.json')
(ROOT/'releases').mkdir(exist_ok=True)
subprocess.run([os.environ.get('MAKENSIS','makensis'), 'installer.nsi'], cwd=ROOT/'desktop', check=True)
print('Windows installer built with verified Electron and embedded Python.')
