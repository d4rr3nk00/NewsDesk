"""Private backend for the bundled desktop client. Uses only Python standard library."""
import json
import sys
from http.server import ThreadingHTTPServer
from pathlib import Path

root = Path(__file__).resolve().parent
if not (root / 'reporting-desk').exists():
    root = root.parent
sys.path.insert(0, str(root / 'reporting-desk'))
import app

app.init_db()
server = ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
print(json.dumps({'port': server.server_port}), flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
