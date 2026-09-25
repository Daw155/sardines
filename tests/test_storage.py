"""Exercise real store SQL and HTTP encoding without needing cloud credentials."""
import io
import json
import os
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.error import URLError

import app as server
import test_game
from storage import REFRESH_INTERVAL, TTL, StoreUnavailable, TursoStore, make_store, serialize


class SQLTransport:
    """Turso wire-protocol test double backed by a real SQLite file."""
    def __init__(self, path):
        self.path = path
        self.calls = []

    def __call__(self, request, timeout):
        payload = json.loads(request.data)
        self.calls.append(payload)
        results = []
        with sqlite3.connect(self.path, timeout=10) as db:
            for command in payload['requests']:
                if command['type'] == 'close':
                    results.append({'type': 'ok', 'response': {'type': 'close'}})
                    continue
                stmt = command['stmt']
                args = [TursoStore._value(arg) for arg in stmt['args']]
                cursor = db.execute(stmt['sql'], args)
                rows = cursor.fetchall()
                results.append({'type': 'ok', 'response': {'type': 'execute', 'result': {
                    'rows': [[TursoStore._argument(cell) for cell in row] for row in rows],
                    'affected_row_count': max(0, cursor.rowcount),
                }}})
        return io.BytesIO(json.dumps({'results': results, 'baton': None}).encode())


class TursoApiTests(test_game.ApiTests):
    """Run the full existing multiplayer API suite through the new Turso store."""
    def setUp(self):
        super().setUp()
        self.transport = SQLTransport(os.path.join(self.temp.name, 'turso.sqlite3'))
        self.http = patch('storage.urlopen', side_effect=self.transport)
        self.http.start()
        self.addCleanup(self.http.stop)
        self.store = TursoStore('libsql://example.turso.io', 'test-token')
        server.store.return_value = self.store


class TursoStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = os.path.join(self.temp.name, 'turso.sqlite3')
        self.transport = SQLTransport(self.path)
        self.http = patch('storage.urlopen', side_effect=self.transport).start()
        self.addCleanup(patch.stopall)
        self.store = TursoStore('libsql://example.turso.io', 'test-token')
        self.store.create('ABC234', {'players': ['Host']})
        self.transport.calls.clear()

    def row(self):
        with sqlite3.connect(self.path) as db:
            return db.execute('SELECT data, expires, version FROM sardines_rooms WHERE code = ?', ('ABC234',)).fetchone()

    def test_unchanged_polls_are_one_read_and_no_writes(self):
        before = self.row()
        self.assertEqual(self.store.update('ABC234', lambda room: room['players']), ['Host'])
        self.assertEqual(self.row(), before)
        self.assertEqual(len(self.transport.calls), 1)
        self.assertTrue(self.transport.calls[0]['requests'][0]['stmt']['sql'].startswith('SELECT'))

    def test_poll_refreshes_expiry_only_after_interval(self):
        with sqlite3.connect(self.path) as db:
            db.execute('UPDATE sardines_rooms SET expires = ?', (time.time() + TTL - REFRESH_INTERVAL - 10,))
        before = self.row()
        self.store.update('ABC234', lambda room: room)
        after = self.row()
        self.assertGreater(after[1], before[1])
        self.assertNotEqual(after[2], before[2])
        self.assertEqual(after[0], before[0])
        self.assertEqual(len(self.transport.calls), 2)

    def test_update_race_retries_without_losing_either_change(self):
        original = self.store._execute
        raced = False
        def execute(sql, args=(), deadline=None):
            nonlocal raced
            if sql.startswith('UPDATE') and not raced:
                raced = True
                with sqlite3.connect(self.path) as db:
                    db.execute('UPDATE sardines_rooms SET data = ?, version = ?',
                               (serialize({'players': ['Host', 'Racing join']}), 'new-version'))
            return original(sql, args, deadline)
        def join(room):
            room['players'].append('My join')
            return room['players']
        with patch.object(self.store, '_execute', side_effect=execute):
            result = self.store.update('ABC234', join)
        self.assertEqual(result, ['Host', 'Racing join', 'My join'])
        self.assertEqual(json.loads(self.row()[0])['players'], result)
        self.assertEqual(len(self.transport.calls), 4)

    def test_expired_rooms_are_unavailable_and_codes_can_be_reused(self):
        with sqlite3.connect(self.path) as db:
            db.execute('UPDATE sardines_rooms SET expires = ?', (time.time() - 10,))
        self.assertIsNone(self.store.update('ABC234', lambda room: room))
        self.assertTrue(self.store.create('ABC234', {'players': ['New host']}))
        self.assertEqual(json.loads(self.row()[0]), {'players': ['New host']})

    def test_create_never_overwrites_live_room(self):
        self.assertFalse(self.store.create('ABC234', {'players': ['Other host']}))
        self.assertEqual(json.loads(self.row()[0]), {'players': ['Host']})

    def test_callback_error_does_not_save_partial_mutation(self):
        def fail(room):
            room['players'].append('Should not save')
            raise ValueError('Rejected')
        with self.assertRaises(ValueError): self.store.update('ABC234', fail)
        self.assertEqual(json.loads(self.row()[0]), {'players': ['Host']})

    def test_sql_parameters_handle_quotes_and_unicode(self):
        name = "O'Brien 🐟'); DROP TABLE sardines_rooms;--"
        self.store.update('ABC234', lambda room: room['players'].append(name))
        self.assertEqual(self.store.update('ABC234', lambda room: room['players'])[-1], name)

    def test_protocol_uses_https_token_and_closes_stream(self):
        self.store.update('ABC234', lambda room: room)
        request = self.http.call_args.args[0]
        self.assertEqual(request.full_url, 'https://example.turso.io/v2/pipeline')
        self.assertEqual(request.get_header('Authorization'), 'Bearer test-token')
        self.assertEqual(json.loads(request.data)['requests'][-1], {'type': 'close'})

    def test_network_and_protocol_errors_are_storage_errors(self):
        responses = [URLError('offline'), io.BytesIO(b'not json'),
                     io.BytesIO(json.dumps({'results': [{'type': 'error', 'error': {'message': 'secret'}},
                                                       {'type': 'ok', 'response': {'type': 'close'}}]}).encode()),
                     io.BytesIO(b'{"results": []}')]
        for response in responses:
            with self.subTest(response=type(response).__name__):
                self.http.side_effect = response if isinstance(response, Exception) else None
                self.http.return_value = response
                with self.assertRaises(StoreUnavailable) as exc:
                    self.store.update('ABC234', lambda room: room)
                self.assertNotIn('secret', str(exc.exception))

    def test_conflict_retries_are_bounded(self):
        original = self.store._execute
        def execute(sql, args=(), deadline=None):
            return {'rows': [], 'affected': 0} if sql.startswith('UPDATE') else original(sql, args, deadline)
        with patch.object(self.store, '_execute', side_effect=execute):
            with self.assertRaises(StoreUnavailable):
                self.store.update('ABC234', lambda room: room['players'].append('New'))
        self.assertEqual(len(self.transport.calls), 8)

    def test_expiration_cleanup_is_bounded(self):
        with sqlite3.connect(self.path) as db:
            db.executemany('INSERT INTO sardines_rooms VALUES (?, ?, ?, ?)',
                           [(f'old-{i}', '{}', 0, 'v') for i in range(150)])
        self.store.create('NEW234', {})
        with sqlite3.connect(self.path) as db:
            remaining = db.execute('SELECT count(*) FROM sardines_rooms WHERE expires = 0').fetchone()[0]
        self.assertEqual(remaining, 50)

    def test_configuration_requires_pair_and_ignores_legacy_redis(self):
        for env in ({'TURSO_DATABASE_URL': 'libsql://example.turso.io'}, {'TURSO_AUTH_TOKEN': 'secret'},
                    {'VERCEL': '1', 'KV_REST_API_URL': 'https://redis.test', 'KV_REST_API_TOKEN': 'secret'}):
            with patch.dict(os.environ, env, clear=True):
                with self.assertRaises(StoreUnavailable): make_store()
        with patch.dict(os.environ, {'TURSO_DATABASE_URL': 'libsql://example.turso.io', 'TURSO_AUTH_TOKEN': 'secret'}, clear=True):
            self.assertIsInstance(make_store(), TursoStore)

    def test_invalid_database_urls_are_rejected(self):
        for url in ('http://example.turso.io', 'file:test.db', 'https://user:password@example.test',
                    'https://example.test?token=secret', 'https://example.test/other'):
            with self.subTest(url=url):
                with self.assertRaises(StoreUnavailable): TursoStore(url, 'secret')
