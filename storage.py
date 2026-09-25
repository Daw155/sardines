"""Atomic room storage: SQLite locally, Turso SQL over HTTPS on Vercel."""
import json
import os
import secrets
import sqlite3
import threading
import time
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

TTL = 24 * 60 * 60
REFRESH_INTERVAL = 60 * 60
MAX_ATTEMPTS = 8
SCHEMA = (
    "CREATE TABLE IF NOT EXISTS sardines_rooms ("
    "code TEXT PRIMARY KEY, data TEXT NOT NULL, expires REAL NOT NULL, version TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS sardines_rooms_expires ON sardines_rooms (expires)",
)


class StoreUnavailable(Exception):
    pass


def serialize(room):
    return json.dumps(room, separators=(',', ':'), ensure_ascii=False)


class SQLiteStore:
    def __init__(self, path):
        self.path = path
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, data TEXT, expires REAL)")

    def connect(self):
        return sqlite3.connect(self.path, timeout=10)

    def create(self, code, room):
        with self.connect() as db:
            db.execute("DELETE FROM rooms WHERE expires < ?", (time.time(),))
            cursor = db.execute("INSERT OR IGNORE INTO rooms VALUES (?, ?, ?)",
                                (code, serialize(room), time.time() + TTL))
            return cursor.rowcount == 1

    def update(self, code, fn):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            now = time.time()
            row = db.execute("SELECT data, expires FROM rooms WHERE code = ? AND expires > ?",
                             (code, now)).fetchone()
            room = json.loads(row[0]) if row else None
            result = fn(room)
            if room is not None:
                updated = serialize(room)
                if updated != row[0] or row[1] <= now + TTL - REFRESH_INTERVAL:
                    db.execute("UPDATE rooms SET data = ?, expires = ? WHERE code = ?",
                               (updated, now + TTL, code))
            return result


class TursoStore:
    """One row per room. Version-checked writes retry from fresh state on conflict.

    Requests never hold an SQL transaction open across network calls. Each write
    is atomic, and a random version also guards against expired codes being reused.
    """
    def __init__(self, url, token):
        url = url.strip().rstrip('/')
        if url.startswith('libsql://'):
            url = 'https://' + url[len('libsql://'):]
        parsed = urlsplit(url)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment or parsed.path not in ('', '/v2/pipeline')):
            raise StoreUnavailable('TURSO_DATABASE_URL must be a libsql:// or https:// database URL.')
        self.url = url if parsed.path else url + '/v2/pipeline'
        self.token = token.strip()
        self._ready = False
        self._schema_lock = threading.Lock()

    @staticmethod
    def _argument(value):
        if value is None:
            return {'type': 'null'}
        if isinstance(value, str):
            return {'type': 'text', 'value': value}
        if isinstance(value, int):
            return {'type': 'integer', 'value': str(value)}
        if isinstance(value, float):
            return {'type': 'float', 'value': value}
        raise TypeError('Unsupported SQL argument')

    @staticmethod
    def _value(cell):
        kind = cell['type']
        if kind == 'null':
            return None
        if kind == 'integer':
            return int(cell['value'])
        if kind == 'float':
            return float(cell['value'])
        if kind == 'text':
            return cell['value']
        raise ValueError('Unsupported SQL result type')

    def _pipeline(self, statements, deadline=None):
        timeout = 8 if deadline is None else min(8, deadline - time.monotonic())
        if timeout <= 0:
            raise StoreUnavailable('Room storage request timed out. Please try again.')
        commands = [{'type': 'execute', 'stmt': {'sql': sql,
                     'args': [self._argument(arg) for arg in args], 'want_rows': True}}
                    for sql, args in statements]
        request = Request(self.url, json.dumps({'requests': commands + [{'type': 'close'}]}).encode(),
                          {'Authorization': f'Bearer {self.token}', 'Content-Type': 'application/json'})
        try:
            with urlopen(request, timeout=timeout) as response:
                body = json.load(response)
            results = body['results']
            if len(results) != len(commands) + 1:
                raise ValueError('Incomplete SQL response')
            decoded = []
            for item in results:
                if item['type'] != 'ok':
                    # Do not echo server errors: they may contain room data or SQL.
                    raise StoreUnavailable('Turso rejected a query. Check database permissions and availability.')
            for item in results[:-1]:
                result = item['response']['result']
                decoded.append({'rows': [[self._value(cell) for cell in row] for row in result['rows']],
                                'affected': int(result['affected_row_count'])})
            return decoded
        except (OSError, ValueError, TypeError, KeyError) as exc:
            raise StoreUnavailable('Turso is unavailable. Check its URL, token, and connection.') from exc

    def _execute(self, sql, args=(), deadline=None):
        return self._pipeline([(sql, args)], deadline)[0]

    def ensure_schema(self):
        if not self._ready:
            with self._schema_lock:
                if not self._ready:
                    self._pipeline([(sql, ()) for sql in SCHEMA])
                    self._ready = True

    def create(self, code, room):
        self.ensure_schema()
        now = time.time()
        # Indexed, bounded cleanup avoids scanning all rooms or requiring a cron.
        self._execute('DELETE FROM sardines_rooms WHERE code IN '
                      '(SELECT code FROM sardines_rooms WHERE expires <= ? LIMIT 100)', (now,))
        result = self._execute(
            'INSERT INTO sardines_rooms (code, data, expires, version) VALUES (?, ?, ?, ?) '
            'ON CONFLICT(code) DO UPDATE SET data = excluded.data, expires = excluded.expires, '
            'version = excluded.version WHERE sardines_rooms.expires <= ?',
            (code, serialize(room), now + TTL, secrets.token_hex(16), now))
        return result['affected'] == 1

    def update(self, code, fn):
        self.ensure_schema()
        deadline = time.monotonic() + 20
        for _ in range(MAX_ATTEMPTS):
            now = time.time()
            rows = self._execute('SELECT data, expires, version FROM sardines_rooms '
                                 'WHERE code = ? AND expires > ?', (code, now), deadline)['rows']
            room = json.loads(rows[0][0]) if rows else None
            result = fn(room)
            if room is None:
                return result
            raw, expires, version = rows[0]
            updated = serialize(room)
            if updated == raw and expires > now + TTL - REFRESH_INTERVAL:
                return result  # Ordinary polling: one indexed read, zero writes.
            saved = self._execute('UPDATE sardines_rooms SET data = ?, expires = ?, version = ? '
                                  'WHERE code = ? AND version = ? AND expires > ?',
                                  (updated, now + TTL, secrets.token_hex(16), code, version, time.time()),
                                  deadline)
            if saved['affected'] == 1:
                return result
        raise StoreUnavailable('The room is busy. Please try again.')


def make_store():
    url = os.getenv('TURSO_DATABASE_URL', '').strip()
    token = os.getenv('TURSO_AUTH_TOKEN', '').strip()
    if url and token:
        return TursoStore(url, token)
    if url or token or os.getenv('VERCEL'):
        raise StoreUnavailable('Set both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN to connect Turso.')
    return SQLiteStore(os.getenv('SARDINES_DB', '.sardines.sqlite3'))
