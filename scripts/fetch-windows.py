"""Download pinned runtimes over verified TLS; reject unexpected contents."""
import hashlib
import json
import os
from pathlib import Path
import urllib.request

lock = json.loads((Path(__file__).parent/'runtime-lock.json').read_text())
out = Path(os.environ['DESK_DOWNLOADS'])
out.mkdir(parents=True, exist_ok=True)
for kind, item in lock.items():
    base = (f'https://github.com/electron/electron/releases/download/v{item["version"]}/'
            if kind == 'electron' else f'https://www.python.org/ftp/python/{item["version"]}/')
    target = out/item['filename']
    if not target.exists():
        temporary = target.with_suffix('.part')
        with urllib.request.urlopen(base+item['filename'], timeout=120) as response, temporary.open('wb') as stream:
            while data := response.read(1024*1024):
                stream.write(data)
        temporary.replace(target)
    with target.open('rb') as stream:
        actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    if actual != item['sha256']:
        raise RuntimeError(f'Checksum mismatch: {target.name}')
    metadata = ('SHASUMS256.txt' if kind == 'electron' else item['filename']+'.spdx.json')
    metadata_name = f'electron-{item["version"]}-SHASUMS256.txt' if kind == 'electron' else metadata
    with urllib.request.urlopen(base+metadata, timeout=30) as response:
        (out/metadata_name).write_bytes(response.read())
    print('Verified:', target.name)
