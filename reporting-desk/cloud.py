"""Single-workspace cloud entry point; expose only through authenticated HTTPS proxy."""
import os
import secrets
from urllib.parse import urlsplit
from http.server import ThreadingHTTPServer
import app


def configured_origin(value):
    parsed = urlsplit(value)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise ValueError('DESK_ORIGIN must be an HTTPS origin without a trailing slash')
    return value


class CloudHandler(app.Handler):
    def safety(self, change=False):
        origin = self.server.desk_origin
        if self.headers.get('Host') != urlsplit(origin).netloc:
            raise app.ApiError(403, '허용되지 않은 접속 주소입니다.')
        if self.headers.get('Origin') not in (None, origin):
            raise app.ApiError(403, '허용되지 않은 요청입니다.')
        if change and not secrets.compare_digest(self.headers.get('X-Desk-Token', ''), app.TOKEN):
            raise app.ApiError(403, '페이지를 새로고침해 주세요.')

    def send(self, status, content, ctype='application/json; charset=utf-8', extra=None):
        if ctype.startswith('text/html'):
            content = content.replace('이 컴퓨터에 저장 중'.encode(), '공유 서버에 저장 중'.encode())
        super().send(status, content, ctype, extra)


def main():
    origin = configured_origin(os.environ['DESK_ORIGIN'])
    app.init_db()
    server = ThreadingHTTPServer(('127.0.0.1', int(os.environ.get('DESK_PORT', '8765'))), CloudHandler)
    server.desk_origin = origin
    server.desk_storage = 'cloud'
    print('Cloud backend listening on loopback; authenticated HTTPS proxy required.', flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
