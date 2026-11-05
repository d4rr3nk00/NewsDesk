#!/usr/bin/env python3
"""Local-only reporting desk. Python 3.10+, no third-party packages."""
import argparse
import datetime as dt
import hashlib
import io
import json
import mimetypes
import os
import secrets
import sqlite3
import threading
import uuid
import webbrowser
import zipfile
from email import policy
from email.parser import BytesParser
import ai_assist
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('REPORTING_DESK_DATA', ROOT / 'data')).resolve()
FILES = DATA / 'files'
DB = DATA / 'reporting-desk.sqlite3'
MAX_UPLOAD = 50 * 1024 * 1024
KST = dt.timezone(dt.timedelta(hours=9))
TOKEN = secrets.token_urlsafe(32)


def now():
    return dt.datetime.now(KST).replace(microsecond=0).isoformat()


def uid():
    return uuid.uuid4().hex


def db():
    con = sqlite3.connect(DB, timeout=20)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA foreign_keys=ON')
    return con


def init_db():
    FILES.mkdir(parents=True, exist_ok=True)
    with db() as con:
        con.executescript('''
        CREATE TABLE IF NOT EXISTS cases (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, beat TEXT NOT NULL DEFAULT '',
          work_type TEXT NOT NULL DEFAULT '', due_at TEXT NOT NULL DEFAULT '',
          embargo_type TEXT NOT NULL DEFAULT 'none', embargo_at TEXT NOT NULL DEFAULT '',
          embargo_event TEXT NOT NULL DEFAULT '', embargo_released INTEGER NOT NULL DEFAULT 0,
          next_action TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '진행 중',
          angle_change TEXT NOT NULL DEFAULT '', angle_why TEXT NOT NULL DEFAULT '',
          angle_limits TEXT NOT NULL DEFAULT '', angle_shift TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sources (
          id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
          title TEXT NOT NULL, kind TEXT NOT NULL, sensitivity TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS source_versions (
          id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
          version INTEGER NOT NULL, original_name TEXT NOT NULL DEFAULT '',
          stored_name TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
          sha256 TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
          body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
          UNIQUE(source_id, version)
        );
        CREATE TABLE IF NOT EXISTS claims (
          id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
          text TEXT NOT NULL, kind TEXT NOT NULL DEFAULT '자료에 적힌 사실',
          status TEXT NOT NULL DEFAULT '확인 대기', permission TEXT NOT NULL DEFAULT '내부 검토용',
          comparison TEXT NOT NULL DEFAULT '', calculation TEXT NOT NULL DEFAULT '',
          next_question TEXT NOT NULL DEFAULT '', respondent TEXT NOT NULL DEFAULT '',
          answer_due TEXT NOT NULL DEFAULT '', needs_review INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS evidence (
          id TEXT PRIMARY KEY, claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
          source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE RESTRICT,
          location TEXT NOT NULL DEFAULT '', excerpt TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS drafts (
          id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
          name TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', subtitle TEXT NOT NULL DEFAULT '',
          title_public INTEGER NOT NULL DEFAULT 0, subtitle_public INTEGER NOT NULL DEFAULT 0,
          title_claims TEXT NOT NULL DEFAULT '[]', subtitle_claims TEXT NOT NULL DEFAULT '[]',
          target INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS draft_blocks (
          id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
          position INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '',
          public INTEGER NOT NULL DEFAULT 0, claim_ids TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE IF NOT EXISTS draft_versions (
          id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
          snapshot TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ai_results (
          id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
          mode TEXT NOT NULL, model TEXT NOT NULL, question TEXT NOT NULL DEFAULT '',
          sources TEXT NOT NULL DEFAULT '[]', claim_count INTEGER NOT NULL DEFAULT 0,
          web_search INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sources_case ON sources(case_id);
        CREATE INDEX IF NOT EXISTS claims_case ON claims(case_id);
        CREATE INDEX IF NOT EXISTS drafts_case ON drafts(case_id);
        ''')
        if 'revision' not in {row[1] for row in con.execute('PRAGMA table_info(drafts)')}:
            con.execute('ALTER TABLE drafts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')


def one(con, query, args=()):
    row = con.execute(query, args).fetchone()
    if row is None:
        raise ApiError(404, '항목을 찾을 수 없습니다.')
    return dict(row)


def rows(con, query, args=()):
    return [dict(x) for x in con.execute(query, args).fetchall()]


def json_list(value):
    try:
        result = json.loads(value) if isinstance(value, str) else value
        return result if isinstance(result, list) else []
    except (ValueError, TypeError):
        return []


def valid_datetime(value):
    if not value:
        return ''
    try:
        result = dt.datetime.fromisoformat(str(value))
        if result.tzinfo is not None:
            result = result.astimezone(KST).replace(tzinfo=None)
        return result.isoformat(timespec='minutes')
    except ValueError:
        raise ApiError(400, '날짜와 시각을 확인해 주세요.')


def clean(value, limit=100000):
    return str(value or '').strip()[:limit]


def choice(value, options, default):
    return value if value in options else default


def valid_url(value):
    value = clean(value, 4000)
    if value:
        parsed = urlparse(value)
        if parsed.scheme not in ('http', 'https') or not parsed.netloc:
            raise ApiError(400, '링크는 http:// 또는 https:// 주소여야 합니다.')
    return value


def case_data(con, case_id):
    case = one(con, 'SELECT * FROM cases WHERE id=?', (case_id,))
    case['sources'] = rows(con, 'SELECT * FROM sources WHERE case_id=? ORDER BY updated_at DESC', (case_id,))
    for source in case['sources']:
        source['versions'] = rows(con, 'SELECT * FROM source_versions WHERE source_id=? ORDER BY version DESC', (source['id'],))
    case['claims'] = rows(con, 'SELECT * FROM claims WHERE case_id=? ORDER BY created_at DESC', (case_id,))
    for claim in case['claims']:
        claim['evidence'] = rows(con, '''SELECT e.*, v.version, v.original_name, v.url, v.body,
              s.id AS source_id, s.title AS source_title, s.kind AS source_kind, s.sensitivity
              FROM evidence e JOIN source_versions v ON v.id=e.source_version_id
              JOIN sources s ON s.id=v.source_id WHERE e.claim_id=? ORDER BY e.created_at''', (claim['id'],))
    case['drafts'] = rows(con, 'SELECT * FROM drafts WHERE case_id=? ORDER BY created_at', (case_id,))
    for draft in case['drafts']:
        draft['title_claims'] = json_list(draft['title_claims'])
        draft['subtitle_claims'] = json_list(draft['subtitle_claims'])
        draft['blocks'] = rows(con, 'SELECT * FROM draft_blocks WHERE draft_id=? ORDER BY position', (draft['id'],))
        for block in draft['blocks']:
            block['claim_ids'] = json_list(block['claim_ids'])
        draft['versions'] = rows(con, 'SELECT id,created_at FROM draft_versions WHERE draft_id=? ORDER BY created_at DESC, rowid DESC LIMIT 30', (draft['id'],))
    case['ai_results'] = rows(con, 'SELECT * FROM ai_results WHERE case_id=? ORDER BY created_at DESC, rowid DESC LIMIT 50', (case_id,))
    for result in case['ai_results']:
        result['sources'] = json_list(result['sources'])
        result['result'] = json.loads(result['result'])
    return case


def add_draft(con, case_id, name):
    stamp = now()
    draft_id = uid()
    con.execute('INSERT INTO drafts(id,case_id,name,created_at,updated_at) VALUES(?,?,?,?,?)', (draft_id, case_id, name, stamp, stamp))
    con.execute('INSERT INTO draft_blocks(id,draft_id,position) VALUES(?,?,0)', (uid(), draft_id))
    return draft_id


def update_case(con, case_id, data):
    title = clean(data.get('title'), 300)
    if not title:
        raise ApiError(400, '취재 건 제목 또는 메모 한 줄을 입력해 주세요.')
    embargo = choice(data.get('embargo_type'), ['none', 'time', 'event'], 'none')
    embargo_at = valid_datetime(data.get('embargo_at'))
    embargo_event = clean(data.get('embargo_event'), 500)
    if embargo == 'time' and not embargo_at:
        raise ApiError(400, '시각 엠바고의 보도 가능 시각을 입력해 주세요.')
    if embargo == 'event' and not embargo_event:
        raise ApiError(400, '엠바고가 해제되는 사건을 입력해 주세요.')
    vals = (title, clean(data.get('beat'), 100), clean(data.get('work_type'), 100),
            valid_datetime(data.get('due_at')), embargo, embargo_at, embargo_event,
            int(bool(data.get('embargo_released'))), clean(data.get('next_action'), 1000),
            choice(data.get('status'), ['진행 중', '대기', '완료'], '진행 중'),
            clean(data.get('angle_change'), 3000), clean(data.get('angle_why'), 3000),
            clean(data.get('angle_limits'), 3000), clean(data.get('angle_shift'), 3000), now(), case_id)
    con.execute('''UPDATE cases SET title=?,beat=?,work_type=?,due_at=?,embargo_type=?,embargo_at=?,
        embargo_event=?,embargo_released=?,next_action=?,status=?,angle_change=?,angle_why=?,
        angle_limits=?,angle_shift=?,updated_at=? WHERE id=?''', vals)


def save_version(con, source_id, fields, uploaded):
    source = one(con, 'SELECT * FROM sources WHERE id=?', (source_id,))
    number = con.execute('SELECT COALESCE(MAX(version),0)+1 FROM source_versions WHERE source_id=?', (source_id,)).fetchone()[0]
    file_name = stored = digest = ''
    size = 0
    body = clean(fields.get('body'), 1000000)
    url = valid_url(fields.get('url'))
    if source['kind'] == 'file':
        if not uploaded:
            raise ApiError(400, '파일을 선택해 주세요.')
        file_name, content = uploaded
        file_name = Path(file_name.replace('\\', '/')).name[:255] or 'file'
        if len(content) > MAX_UPLOAD:
            raise ApiError(400, '파일 크기는 50MB 이하여야 합니다.')
        stored = uid()
        size = len(content)
        digest = hashlib.sha256(content).hexdigest()
        (FILES / stored).write_bytes(content)
    elif source['kind'] == 'link' and not url:
        raise ApiError(400, '링크 주소를 입력해 주세요.')
    elif source['kind'] == 'memo' and not body:
        raise ApiError(400, '메모 내용을 입력해 주세요.')
    version_id = uid()
    try:
        con.execute('''INSERT INTO source_versions(id,source_id,version,original_name,stored_name,size,sha256,url,body,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)''', (version_id, source_id, number, file_name, stored, size, digest, url, body, now()))
        con.execute('UPDATE sources SET updated_at=? WHERE id=?', (now(), source_id))
        if number > 1:
            con.execute('''UPDATE claims SET needs_review=1,updated_at=? WHERE id IN
                (SELECT e.claim_id FROM evidence e JOIN source_versions v ON v.id=e.source_version_id WHERE v.source_id=?)''', (now(), source_id))
    except Exception:
        if stored:
            (FILES / stored).unlink(missing_ok=True)
        raise
    return version_id


def save_claim(con, claim_id, data):
    text = clean(data.get('text'), 5000)
    if not text:
        raise ApiError(400, '쓰려는 주장을 입력해 주세요.')
    kinds = ['자료에 적힌 사실', '출처의 주장·전망', '직접 인용', '자체 계산', '취재 가설']
    statuses = ['확인 대기', '원문 확인', '교차 확인', '자료 상충', '보류']
    permissions = ['단정 가능', '출처를 밝혀 인용', '추정임을 표시', '조건부 문장', '내부 검토용']
    con.execute('''UPDATE claims SET text=?,kind=?,status=?,permission=?,comparison=?,calculation=?,
       next_question=?,respondent=?,answer_due=?,needs_review=?,updated_at=? WHERE id=?''',
       (text, choice(data.get('kind'), kinds, kinds[0]), choice(data.get('status'), statuses, statuses[0]),
        choice(data.get('permission'), permissions, permissions[-1]), clean(data.get('comparison'), 5000),
        clean(data.get('calculation'), 5000), clean(data.get('next_question'), 3000),
        clean(data.get('respondent'), 500), valid_datetime(data.get('answer_due')),
        int(bool(data.get('needs_review'))), now(), claim_id))


def check_claim_ids(con, case_id, values):
    values = list(dict.fromkeys(str(v) for v in json_list(values)))
    existing = {r[0] for r in con.execute('SELECT id FROM claims WHERE case_id=?', (case_id,))}
    if any(v not in existing for v in values):
        raise ApiError(400, '이 취재 건에 없는 주장이 연결되어 있습니다.')
    return values


def save_draft(con, draft_id, data, snapshot=True):
    draft = one(con, 'SELECT * FROM drafts WHERE id=?', (draft_id,))
    expected = data.get('base_revision', draft['revision'])
    try:
        expected = int(expected)
    except (ValueError, TypeError):
        raise ApiError(400, '원고의 저장 상태를 확인해 주세요.')
    if expected != draft['revision']:
        raise ApiError(409, '다른 창에서 이 원고가 변경되었습니다. 현재 수정 내용을 따로 복사한 뒤 새로고침해 최신 저장본을 확인해 주세요.')
    target = data.get('target') or 0
    try:
        target = max(0, min(int(target), 1000000))
    except (ValueError, TypeError):
        raise ApiError(400, '목표 글자 수는 숫자로 입력해 주세요.')
    title_claims = check_claim_ids(con, draft['case_id'], data.get('title_claims', []))
    subtitle_claims = check_claim_ids(con, draft['case_id'], data.get('subtitle_claims', []))
    blocks = data.get('blocks', [])
    if not isinstance(blocks, list) or len(blocks) > 200:
        raise ApiError(400, '문단 수를 확인해 주세요.')
    validated = []
    for block in blocks:
        validated.append({'text': clean(block.get('text'), 50000), 'public': int(bool(block.get('public'))),
                          'claim_ids': check_claim_ids(con, draft['case_id'], block.get('claim_ids', []))})
    name = clean(data.get('name'), 100) or draft['name']
    updated = con.execute('''UPDATE drafts SET name=?,title=?,subtitle=?,title_public=?,subtitle_public=?,
       title_claims=?,subtitle_claims=?,target=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?''',
       (name, clean(data.get('title'), 500), clean(data.get('subtitle'), 1000),
        int(bool(data.get('title_public'))), int(bool(data.get('subtitle_public'))),
        json.dumps(title_claims, ensure_ascii=False), json.dumps(subtitle_claims, ensure_ascii=False), target, now(), draft_id, expected))
    if updated.rowcount != 1:
        raise ApiError(409, '다른 창에서 이 원고가 변경되었습니다. 현재 수정 내용을 따로 복사한 뒤 새로고침해 최신 저장본을 확인해 주세요.')
    con.execute('DELETE FROM draft_blocks WHERE draft_id=?', (draft_id,))
    for i, block in enumerate(validated):
        con.execute('INSERT INTO draft_blocks(id,draft_id,position,text,public,claim_ids) VALUES(?,?,?,?,?,?)',
                    (uid(), draft_id, i, block['text'], block['public'], json.dumps(block['claim_ids'], ensure_ascii=False)))
    if snapshot:
        snap = {'name': name, 'title': clean(data.get('title'), 500), 'subtitle': clean(data.get('subtitle'), 1000),
                'title_public': int(bool(data.get('title_public'))), 'subtitle_public': int(bool(data.get('subtitle_public'))),
                'title_claims': title_claims, 'subtitle_claims': subtitle_claims, 'target': target, 'blocks': validated}
        con.execute('INSERT INTO draft_versions(id,draft_id,snapshot,created_at) VALUES(?,?,?,?)',
                    (uid(), draft_id, json.dumps(snap, ensure_ascii=False), now()))


def export_draft(con, draft_id, mode, confirmed):
    draft = one(con, 'SELECT * FROM drafts WHERE id=?', (draft_id,))
    case = one(con, 'SELECT * FROM cases WHERE id=?', (draft['case_id'],))
    blocks = rows(con, 'SELECT * FROM draft_blocks WHERE draft_id=? ORDER BY position', (draft_id,))
    if mode == 'external':
        if not confirmed:
            raise ApiError(400, '보도 가능 시점과 공개 범위를 확인해 주세요.')
        if case['embargo_type'] == 'time':
            embargo = dt.datetime.fromisoformat(case['embargo_at']).replace(tzinfo=KST)
            if dt.datetime.now(KST) < embargo:
                raise ApiError(403, '보도 가능 시각 전입니다. 내부 검토본은 만들 수 있습니다.')
        if case['embargo_type'] == 'event' and not case['embargo_released']:
            raise ApiError(403, '사건 기준 엠바고가 아직 해제 확인되지 않았습니다.')
        parts = [(draft['title'], draft['title_claims'])] if draft['title_public'] and draft['title'] else []
        if draft['subtitle_public'] and draft['subtitle']:
            parts.append((draft['subtitle'], draft['subtitle_claims']))
        parts.extend((b['text'], b['claim_ids']) for b in blocks if b['public'] and b['text'])
        for text, claim_ids in parts:
            for claim_id in json_list(claim_ids):
                claim = one(con, 'SELECT * FROM claims WHERE id=? AND case_id=?', (claim_id, case['id']))
                if claim['needs_review'] or claim['status'] in ('확인 대기', '자료 상충', '보류') or claim['permission'] == '내부 검토용':
                    raise ApiError(403, '공개 승인 문장에 재확인·보류 중이거나 내부 검토용인 주장이 연결되어 있습니다: ' + claim['text'][:80])
                if claim['permission'] == '추정임을 표시' and not ('추정' in text or '추산' in text):
                    raise ApiError(403, '추정 주장에 연결된 문장에 ‘추정’ 또는 ‘추산’을 표시해 주세요: ' + claim['text'][:80])
        if not parts:
            raise ApiError(400, '공개 승인된 제목·부제·문단이 없습니다.')
        return '\n\n'.join(p[0] for p in parts)
    if mode != 'internal':
        raise ApiError(400, '출력 종류를 확인해 주세요.')
    stamp = now().replace('T', ' ')[:16]
    lines = [f'[내부 검토본] {case["title"]}', f'작성 시각: {stamp} KST', f'마감: {case["due_at"] or "미지정"}',
             f'엠바고: {embargo_label(case)}', '']
    def append_part(text, claim_ids):
        if not text:
            return
        lines.append(text)
        for claim_id in json_list(claim_ids):
            claim = one(con, 'SELECT * FROM claims WHERE id=? AND case_id=?', (claim_id, case['id']))
            lines.append(f'  [근거 확인] {claim["text"]} / {claim["status"]} / {claim["permission"]}' + (' / 재확인 필요' if claim['needs_review'] else ''))
            for ev in rows(con, '''SELECT s.title,v.version,e.location FROM evidence e
                JOIN source_versions v ON v.id=e.source_version_id JOIN sources s ON s.id=v.source_id WHERE e.claim_id=?''', (claim_id,)):
                lines.append(f'    └ {ev["title"]} v{ev["version"]} · {ev["location"] or "위치 미지정"}')
        lines.append('')
    append_part(draft['title'], draft['title_claims'])
    append_part(draft['subtitle'], draft['subtitle_claims'])
    for block in blocks:
        append_part(block['text'], block['claim_ids'])
    return '\n'.join(lines).strip()


def embargo_label(case):
    if case['embargo_type'] == 'time':
        return case['embargo_at'].replace('T', ' ') + ' KST'
    if case['embargo_type'] == 'event':
        return case['embargo_event'] + (' (해제 확인)' if case['embargo_released'] else ' (해제 전)')
    return '없음'


BACKUP_TABLES = ('cases', 'sources', 'source_versions', 'claims', 'evidence', 'drafts', 'draft_blocks', 'draft_versions', 'ai_results')


def backup_case(con, case_id):
    one(con, 'SELECT id FROM cases WHERE id=?', (case_id,))
    tables = {
        'cases': rows(con, 'SELECT * FROM cases WHERE id=?', (case_id,)),
        'sources': rows(con, 'SELECT * FROM sources WHERE case_id=?', (case_id,)),
        'source_versions': rows(con, 'SELECT v.* FROM source_versions v JOIN sources s ON s.id=v.source_id WHERE s.case_id=?', (case_id,)),
        'claims': rows(con, 'SELECT * FROM claims WHERE case_id=?', (case_id,)),
        'evidence': rows(con, 'SELECT e.* FROM evidence e JOIN claims c ON c.id=e.claim_id WHERE c.case_id=?', (case_id,)),
        'drafts': rows(con, 'SELECT * FROM drafts WHERE case_id=?', (case_id,)),
        'draft_blocks': rows(con, 'SELECT b.* FROM draft_blocks b JOIN drafts d ON d.id=b.draft_id WHERE d.case_id=?', (case_id,)),
        'draft_versions': rows(con, 'SELECT v.* FROM draft_versions v JOIN drafts d ON d.id=v.draft_id WHERE d.case_id=?', (case_id,)),
        'ai_results': rows(con, 'SELECT * FROM ai_results WHERE case_id=?', (case_id,))
    }
    total = sum(v['size'] for v in tables['source_versions'])
    if total > 200 * 1024 * 1024:
        raise ApiError(400, '이 취재 건의 파일이 200MB를 초과해 하나의 백업으로 만들 수 없습니다.')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('manifest.json', json.dumps({'format': 'reporting-desk-backup', 'version': 1, 'tables': tables}, ensure_ascii=False))
        for v in tables['source_versions']:
            if v['stored_name']:
                file_path = FILES / v['stored_name']
                if not file_path.is_file():
                    raise ApiError(400, '원본 파일을 찾을 수 없어 백업을 만들지 못했습니다: ' + v['original_name'])
                content = file_path.read_bytes()
                if hashlib.sha256(content).hexdigest() != v['sha256']:
                    raise ApiError(400, '원본 파일이 저장 당시와 달라 백업을 중단했습니다: ' + v['original_name'])
                archive.writestr('files/' + v['stored_name'], content)
    result = buf.getvalue()
    if len(result) > MAX_UPLOAD:
        raise ApiError(400, '백업 ZIP이 50MB를 초과해 이 버전에서 복원할 수 없습니다. 더 작은 취재 건으로 나눠 주세요.')
    return result


def import_case(con, uploaded):
    if not uploaded:
        raise ApiError(400, '취재 데스크 백업 파일을 선택해 주세요.')
    created_files = []
    try:
        with zipfile.ZipFile(io.BytesIO(uploaded[1])) as archive:
            infos = archive.infolist()
            names = [i.filename for i in infos]
            if len(names) != len(set(names)) or 'manifest.json' not in names:
                raise ApiError(400, '백업 파일 형식을 확인해 주세요.')
            if sum(i.file_size for i in infos) > 210 * 1024 * 1024 or archive.getinfo('manifest.json').file_size > 10 * 1024 * 1024:
                raise ApiError(400, '백업 파일의 압축 해제 크기가 너무 큽니다.')
            manifest = json.loads(archive.read('manifest.json').decode('utf-8'))
            if manifest.get('format') != 'reporting-desk-backup' or manifest.get('version') != 1:
                raise ApiError(400, '지원하지 않는 백업 형식입니다.')
            tables = manifest['tables']
            if isinstance(tables, dict):
                tables.setdefault('ai_results', [])  # Backups from the original offline version.
            if not isinstance(tables, dict) or any(not isinstance(tables.get(t), list) for t in BACKUP_TABLES) or len(tables['cases']) != 1:
                raise ApiError(400, '백업의 취재 건 정보를 읽을 수 없습니다.')
            if sum(len(tables[t]) for t in BACKUP_TABLES) > 50000:
                raise ApiError(400, '백업의 항목이 너무 많습니다.')
            mappings = {}
            for table in BACKUP_TABLES:
                ids = [str(row['id']) for row in tables[table]]
                if len(ids) != len(set(ids)):
                    raise ApiError(400, '백업에 중복된 항목이 있습니다.')
                mappings[table] = {old: uid() for old in ids}
            def remap_list(value):
                result = []
                for old in json_list(value):
                    if old not in mappings['claims']:
                        raise ApiError(400, '백업에 연결된 주장이 없습니다.')
                    result.append(mappings['claims'][old])
                return result
            for table in BACKUP_TABLES:
                columns = {r[1] for r in con.execute('PRAGMA table_info(' + table + ')')}
                for original in tables[table]:
                    row = {k: v for k, v in original.items() if k in columns}
                    row['id'] = mappings[table][str(original['id'])]
                    for key, target in [('case_id','cases'), ('source_id','sources'), ('source_version_id','source_versions'), ('claim_id','claims'), ('draft_id','drafts')]:
                        if key in row:
                            row[key] = mappings[target][str(row[key])]
                    for key in ('title_claims', 'subtitle_claims', 'claim_ids'):
                        if key in row:
                            row[key] = json.dumps(remap_list(row[key]), ensure_ascii=False)
                    if table == 'draft_versions':
                        snap = json.loads(row['snapshot'])
                        snap['title_claims'] = remap_list(snap.get('title_claims', []))
                        snap['subtitle_claims'] = remap_list(snap.get('subtitle_claims', []))
                        for block in snap.get('blocks', []):
                            block['claim_ids'] = remap_list(block.get('claim_ids', []))
                        row['snapshot'] = json.dumps(snap, ensure_ascii=False)
                    if table == 'source_versions' and row.get('stored_name'):
                        old_name = str(row['stored_name'])
                        if len(old_name) != 32 or any(c not in '0123456789abcdef' for c in old_name):
                            raise ApiError(400, '백업의 파일 이름이 올바르지 않습니다.')
                        info = archive.getinfo('files/' + old_name)
                        if info.file_size > MAX_UPLOAD:
                            raise ApiError(400, '백업에 50MB를 초과한 파일이 있습니다.')
                        content = archive.read(info)
                        if hashlib.sha256(content).hexdigest() != row.get('sha256') or len(content) != row.get('size'):
                            raise ApiError(400, '백업의 원본 파일이 손상되었습니다.')
                        new_name = uid()
                        (FILES / new_name).write_bytes(content)
                        created_files.append(new_name)
                        row['stored_name'] = new_name
                    keys = list(row)
                    con.execute('INSERT INTO ' + table + ' (' + ','.join(keys) + ') VALUES (' + ','.join('?' for _ in keys) + ')', [row[k] for k in keys])
            con.commit()
            return mappings['cases'][str(tables['cases'][0]['id'])]
    except Exception as exc:
        con.rollback()
        for name in created_files:
            (FILES / name).unlink(missing_ok=True)
        if isinstance(exc, ApiError):
            raise
        if isinstance(exc, (KeyError, ValueError, TypeError, zipfile.BadZipFile, sqlite3.IntegrityError, UnicodeDecodeError)):
            raise ApiError(400, '백업 파일을 읽을 수 없거나 연결 정보가 올바르지 않습니다.') from exc
        raise


class ApiError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = 'ReportingDesk/1.0'
    def log_message(self, fmt, *args):
        pass

    def send(self, status, content, ctype='application/json; charset=utf-8', extra=None):
        if isinstance(content, (dict, list)):
            content = json.dumps(content, ensure_ascii=False).encode('utf-8')
        elif isinstance(content, str):
            content = content.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(content)

    def safety(self, change=False):
        host = self.headers.get('Host', '')
        if host not in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'):
            raise ApiError(403, '허용되지 않은 접속 주소입니다.')
        origin = self.headers.get('Origin')
        if origin and origin not in (f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}'):
            raise ApiError(403, '허용되지 않은 요청입니다.')
        if change and not secrets.compare_digest(self.headers.get('X-Desk-Token', ''), TOKEN):
            raise ApiError(403, '인증이 만료되었습니다. 페이지를 새로고침해 주세요.')

    def request_data(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            raise ApiError(400, '요청 크기를 확인해 주세요.')
        if length < 0 or length > MAX_UPLOAD + 1024 * 1024:
            raise ApiError(413, '요청 크기가 너무 큽니다. 파일은 50MB 이하여야 합니다.')
        raw = self.rfile.read(length)
        content_type = self.headers.get('Content-Type', '')
        if content_type.startswith('multipart/form-data'):
            header = ('Content-Type: ' + content_type + '\r\nMIME-Version: 1.0\r\n\r\n').encode('ascii')
            form = BytesParser(policy=policy.default).parsebytes(header + raw)
            if not form.is_multipart():
                raise ApiError(400, '첨부된 자료를 읽을 수 없습니다.')
            result, uploaded = {}, None
            for item in form.iter_parts():
                key = item.get_param('name', header='content-disposition')
                filename = item.get_filename()
                content = item.get_payload(decode=True) or b''
                if filename:
                    uploaded = (filename, content)
                else:
                    result[key] = content.decode('utf-8', errors='replace')
            return result, uploaded
        try:
            data = json.loads(raw.decode('utf-8') or '{}')
            if not isinstance(data, dict):
                raise ValueError()
            return data, None
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, '요청 내용을 읽을 수 없습니다.')

    def handle_request(self, method):
        try:
            self.safety(method != 'GET')
            path = urlparse(self.path).path
            chunks = [p for p in path.split('/') if p]
            if method == 'GET' and path in ('/', '/app.js', '/ai-ui.js', '/styles.css', '/favicon.svg'):
                filename = 'index.html' if path == '/' else path[1:]
                content = (ROOT / filename).read_bytes()
                typ = {'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'ai-ui.js': 'text/javascript; charset=utf-8',
                       'styles.css': 'text/css; charset=utf-8', 'favicon.svg': 'image/svg+xml'}[filename]
                return self.send(200, content, typ)
            if method == 'GET' and path == '/api/config':
                return self.send(200, {'token': TOKEN, 'now': now(), 'storage': getattr(self.server, 'desk_storage', 'local')})
            if method == 'GET' and path == '/api/ai/status':
                return self.send(200, {'key_ready': ai_assist.key_ready()})
            if method == 'GET' and len(chunks) == 3 and chunks[:2] == ['api', 'files']:
                with db() as con:
                    version = one(con, 'SELECT * FROM source_versions WHERE id=?', (chunks[2],))
                    if not version['stored_name']:
                        raise ApiError(404, '파일이 없는 자료입니다.')
                    content = (FILES / version['stored_name']).read_bytes()
                    # Open PDFs in the browser, never execute supplied HTML or scripts.
                    typ = 'application/pdf' if version['original_name'].lower().endswith('.pdf') else 'application/octet-stream'
                    disposition = 'inline' if typ == 'application/pdf' else 'attachment'
                    from urllib.parse import quote
                    return self.send(200, content, typ, {'Content-Disposition': f"{disposition}; filename*=UTF-8''{quote(version['original_name'])}"})
            if method == 'GET' and path == '/api/cases':
                with db() as con:
                    cases = rows(con, '''SELECT c.*, (SELECT COUNT(*) FROM claims x WHERE x.case_id=c.id AND
                         (x.status IN ('확인 대기','자료 상충','보류') OR x.needs_review=1)) AS open_claims,
                         (SELECT COUNT(*) FROM sources s WHERE s.case_id=c.id) AS source_count,
                         (SELECT MIN(x.answer_due) FROM claims x WHERE x.case_id=c.id AND x.answer_due<>'') AS next_answer
                         FROM cases c ORDER BY CASE WHEN status='완료' THEN 2 WHEN status='대기' THEN 1 ELSE 0 END,
                         CASE WHEN due_at='' THEN 1 ELSE 0 END,due_at,updated_at DESC''')
                return self.send(200, {'cases': cases})
            if method == 'GET' and len(chunks) == 3 and chunks[:2] == ['api', 'cases']:
                with db() as con:
                    return self.send(200, case_data(con, chunks[2]))
            if method == 'GET' and len(chunks) == 4 and chunks[:2] == ['api', 'cases'] and chunks[3] == 'backup':
                with db() as con:
                    content = backup_case(con, chunks[2])
                return self.send(200, content, 'application/zip', {'Content-Disposition': 'attachment; filename="reporting-desk-backup.zip"'})
            data, uploaded = self.request_data() if method != 'GET' else ({}, None)
            with db() as con:
                def saved(status, payload):
                    # Commit before reporting success to the browser.
                    con.commit()
                    return self.send(status, payload)
                if method == 'POST' and path == '/api/ai/key':
                    ai_assist.set_key(data.get('key'))
                    return saved(200, {'key_ready': True})
                if method == 'DELETE' and path == '/api/ai/key':
                    ai_assist.clear_key()
                    return saved(200, {'key_ready': False})
                if method == 'POST' and len(chunks) == 4 and chunks[:2] == ['api', 'cases'] and chunks[3] == 'ai-preview':
                    preview = ai_assist.prepare(con, FILES, chunks[2], data)
                    return self.send(200, preview)
                if method == 'POST' and path == '/api/ai/run':
                    prepared, key = ai_assist.take_request(data.get('preview_id'), data.get('confirmed'))
                    one(con, 'SELECT id FROM cases WHERE id=?', (prepared['case_id'],))
                    result = ai_assist.execute(prepared, key)
                    result_id = uid()
                    persisted = False
                    try:
                        con.execute('''INSERT INTO ai_results(id,case_id,mode,model,question,sources,claim_count,web_search,result,created_at)
                            VALUES(?,?,?,?,?,?,?,?,?,?)''',
                            (result_id, prepared['case_id'], prepared['mode'], result['model'], prepared['question'],
                             json.dumps(prepared['sources'],ensure_ascii=False), prepared['claim_count'], int(prepared['web_search']),
                             json.dumps(result,ensure_ascii=False), now()))
                        con.commit()
                        persisted = True
                    except sqlite3.Error:
                        con.rollback()
                    return self.send(200, {'id': result_id if persisted else None, 'saved':persisted,
                                           'case_id':prepared['case_id'], 'result':result})
                if method == 'POST' and path == '/api/import':
                    return saved(201, {'id': import_case(con, uploaded)})
                if method == 'POST' and path == '/api/cases':
                    case_id = uid(); stamp = now()
                    con.execute('INSERT INTO cases(id,title,created_at,updated_at) VALUES(?,?,?,?)', (case_id, '새 취재', stamp, stamp))
                    update_case(con, case_id, data)
                    add_draft(con, case_id, '발제')
                    add_draft(con, case_id, '스트레이트')
                    return saved(201, {'id': case_id})
                if len(chunks) == 3 and chunks[:2] == ['api', 'cases'] and method == 'PUT':
                    one(con, 'SELECT id FROM cases WHERE id=?', (chunks[2],))
                    update_case(con, chunks[2], data)
                    return saved(200, {'ok': True})
                if len(chunks) == 3 and chunks[:2] == ['api', 'cases'] and method == 'DELETE':
                    case_id = chunks[2]
                    one(con, 'SELECT id FROM cases WHERE id=?', (case_id,))
                    names = [r[0] for r in con.execute('''SELECT v.stored_name FROM source_versions v JOIN sources s ON s.id=v.source_id WHERE s.case_id=? AND v.stored_name<>'' ''', (case_id,))]
                    con.execute('DELETE FROM evidence WHERE claim_id IN (SELECT id FROM claims WHERE case_id=?)', (case_id,))
                    con.execute('DELETE FROM cases WHERE id=?', (case_id,))
                    con.commit()
                    for name in names:
                        if len(name) == 32 and all(c in '0123456789abcdef' for c in name):
                            (FILES / name).unlink(missing_ok=True)
                    return saved(200, {'ok': True})
                if len(chunks) == 4 and chunks[:2] == ['api', 'cases'] and chunks[3] == 'sources' and method == 'POST':
                    case_id = chunks[2]; one(con, 'SELECT id FROM cases WHERE id=?', (case_id,))
                    title = clean(data.get('title'), 300)
                    if not title:
                        raise ApiError(400, '자료 이름을 입력해 주세요.')
                    kind = choice(data.get('kind'), ['file', 'link', 'memo'], 'memo')
                    sensitivity = choice(data.get('sensitivity'), ['공개', '내부', '취재원 보호'], '내부')
                    source_id = uid(); stamp = now()
                    con.execute('INSERT INTO sources(id,case_id,title,kind,sensitivity,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
                                (source_id, case_id, title, kind, sensitivity, stamp, stamp))
                    save_version(con, source_id, data, uploaded)
                    return saved(201, {'id': source_id})
                if len(chunks) == 4 and chunks[:2] == ['api', 'sources'] and chunks[3] == 'versions' and method == 'POST':
                    return saved(201, {'id': save_version(con, chunks[2], data, uploaded)})
                if len(chunks) == 3 and chunks[:2] == ['api', 'sources'] and method == 'PUT':
                    previous = one(con, 'SELECT * FROM sources WHERE id=?', (chunks[2],))
                    title = clean(data.get('title'), 300)
                    if not title: raise ApiError(400, '자료 이름을 입력해 주세요.')
                    sensitivity = choice(data.get('sensitivity'), ['공개', '내부', '취재원 보호'], '내부')
                    con.execute('UPDATE sources SET title=?,sensitivity=?,updated_at=? WHERE id=?', (title, sensitivity, now(), chunks[2]))
                    if previous['sensitivity'] != sensitivity:
                        con.execute('''UPDATE claims SET needs_review=1,updated_at=? WHERE id IN
                            (SELECT e.claim_id FROM evidence e JOIN source_versions v ON v.id=e.source_version_id WHERE v.source_id=?)''', (now(), chunks[2]))
                    return saved(200, {'ok': True})
                if len(chunks) == 4 and chunks[:2] == ['api', 'cases'] and chunks[3] == 'claims' and method == 'POST':
                    case_id = chunks[2]; one(con, 'SELECT id FROM cases WHERE id=?', (case_id,))
                    claim_id = uid(); stamp = now()
                    con.execute('INSERT INTO claims(id,case_id,text,created_at,updated_at) VALUES(?,?,?,?,?)', (claim_id, case_id, '새 주장', stamp, stamp))
                    save_claim(con, claim_id, data)
                    return saved(201, {'id': claim_id})
                if len(chunks) == 3 and chunks[:2] == ['api', 'claims'] and method == 'PUT':
                    one(con, 'SELECT id FROM claims WHERE id=?', (chunks[2],))
                    save_claim(con, chunks[2], data)
                    return saved(200, {'ok': True})
                if len(chunks) == 4 and chunks[:2] == ['api', 'claims'] and chunks[3] == 'evidence' and method == 'POST':
                    claim = one(con, 'SELECT * FROM claims WHERE id=?', (chunks[2],))
                    one(con, '''SELECT v.id FROM source_versions v JOIN sources s ON s.id=v.source_id
                               WHERE v.id=? AND s.case_id=?''', (data.get('source_version_id'), claim['case_id']))
                    ev_id = uid()
                    con.execute('INSERT INTO evidence(id,claim_id,source_version_id,location,excerpt,created_at) VALUES(?,?,?,?,?,?)',
                                (ev_id, claim['id'], data['source_version_id'], clean(data.get('location'), 1000), clean(data.get('excerpt'), 10000), now()))
                    return saved(201, {'id': ev_id})
                if len(chunks) == 3 and chunks[:2] == ['api', 'evidence'] and method == 'DELETE':
                    one(con, 'SELECT id FROM evidence WHERE id=?', (chunks[2],))
                    con.execute('DELETE FROM evidence WHERE id=?', (chunks[2],))
                    return saved(200, {'ok': True})
                if len(chunks) == 4 and chunks[:2] == ['api', 'cases'] and chunks[3] == 'drafts' and method == 'POST':
                    one(con, 'SELECT id FROM cases WHERE id=?', (chunks[2],))
                    name = clean(data.get('name'), 100)
                    if not name: raise ApiError(400, '원고 이름을 입력해 주세요.')
                    return saved(201, {'id': add_draft(con, chunks[2], name)})
                if len(chunks) == 3 and chunks[:2] == ['api', 'drafts'] and method == 'PUT':
                    save_draft(con, chunks[2], data)
                    return saved(200, {'ok': True})
                if len(chunks) == 4 and chunks[:2] == ['api', 'drafts'] and chunks[3] == 'export' and method == 'POST':
                    return self.send(200, {'text': export_draft(con, chunks[2], data.get('mode'), bool(data.get('confirmed')))})
                if len(chunks) == 5 and chunks[:2] == ['api', 'drafts'] and chunks[3] == 'restore' and method == 'POST':
                    version = one(con, 'SELECT * FROM draft_versions WHERE id=? AND draft_id=?', (chunks[4], chunks[2]))
                    save_draft(con, chunks[2], json.loads(version['snapshot']))
                    return saved(200, {'ok': True})
            raise ApiError(404, '요청한 기능을 찾을 수 없습니다.')
        except (ApiError, ai_assist.AiError) as exc:
            self.send(exc.status, {'error': exc.message})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            print('요청 처리 오류:', type(exc).__name__, str(exc), flush=True)
            self.send(500, {'error': '처리 중 오류가 발생했습니다. 실행 창에서 오류를 확인해 주세요.'})

    def do_GET(self): self.handle_request('GET')
    def do_POST(self): self.handle_request('POST')
    def do_PUT(self): self.handle_request('PUT')
    def do_DELETE(self): self.handle_request('DELETE')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    init_db()
    server = None
    for port in range(args.port, args.port + 20):
        try:
            server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
            break
        except OSError:
            continue
    if server is None:
        raise SystemExit('사용할 수 있는 로컬 포트를 찾지 못했습니다.')
    url = f'http://127.0.0.1:{server.server_port}/'
    print('\n취재 데스크가 실행 중입니다: ' + url, flush=True)
    print('이 창을 닫으면 프로그램이 종료됩니다. 자료 저장 위치: ' + str(DATA), flush=True)
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
