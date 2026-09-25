import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import app as server
from game import GameError, act, authenticate, join, new_room, player, publish_due, view
from storage import SQLiteStore, StoreUnavailable, make_store


class GameTests(unittest.TestCase):
    def setUp(self):
        self.host = player('Alex', 'a' * 48)
        self.room = new_room('ABC234', self.host, 1000)
        self.players = [self.host]
        for index, name in enumerate(['Sam', 'Jo', 'Riley']):
            newcomer = player(name, str(index) * 48)
            join(self.room, newcomer)
            self.players.append(newcomer)
        self.serial = 0

    def action(self, p, action_name, now=1000, **data):
        self.serial += 1
        act(self.room, p, action_name, {'round': self.room['round'], 'request_id': f'request-{self.serial}', **data}, now)

    def start(self):
        self.action(self.host, 'configure', count=2)
        self.action(self.host, 'randomize')
        self.action(self.host, 'start')
        self.sardines = [p for p in self.players if p['role'] == 'sardine']
        self.seekers = [p for p in self.players if p['role'] == 'seeker']

    def seek(self):
        self.start()
        for p in self.sardines:
            self.action(p, 'hidden', now=1010)

    def test_entire_round_and_replay(self):
        self.start()
        self.action(self.sardines[0], 'hidden', now=1005)
        self.assertEqual(self.room['phase'], 'hiding')
        self.assertIsNone(self.room['started_at'])
        self.action(self.sardines[1], 'hidden', now=1010)
        self.assertEqual(self.room['started_at'], 1010)
        self.action(self.seekers[0], 'found', now=1100, found=True)
        self.action(self.seekers[0], 'found', now=1101, found=False)
        self.assertFalse(self.seekers[0]['found'])
        self.action(self.seekers[0], 'found', now=1102, found=True)
        self.action(self.seekers[1], 'found', now=1110, found=True)
        self.assertEqual(self.room['phase'], 'ended')
        self.assertEqual(self.room['ended_at'], 1110)
        self.assertEqual(self.room['end_reason'], 'everyone_found')
        join(self.room, player('New friend', 'n' * 48))
        self.action(self.host, 'reset')
        self.assertTrue(all(p['role'] == 'seeker' and not p['found'] for p in self.room['players']))
        self.assertEqual(self.room['hints'], [])

    def test_default_roles_and_host_can_be_sardine(self):
        self.assertTrue(all(p['role'] == 'seeker' for p in self.players))
        with patch('game.secrets.SystemRandom') as rng:
            rng.return_value.sample.return_value = [self.host]
            self.action(self.host, 'randomize')
        self.assertEqual(self.host['role'], 'sardine')

    def test_join_blocked_during_both_active_phases(self):
        self.start()
        with self.assertRaises(GameError): join(self.room, player('Late', 'l' * 48))
        for p in self.sardines: self.action(p, 'hidden')
        with self.assertRaises(GameError): join(self.room, player('Late', 'l' * 48))
        self.assertEqual(join(self.room, player('Alex', 'a' * 48))['id'], self.host['id'])

    def test_auth_and_permissions(self):
        with self.assertRaises(GameError): authenticate(self.room, 'incorrect')
        for action in ['configure', 'randomize', 'start', 'end', 'reset']:
            with self.assertRaises(GameError): self.action(self.players[1], action, count=1)
        self.seek()
        with self.assertRaises(GameError): self.action(self.seekers[0], 'hint', text='Spoiler')
        with self.assertRaises(GameError): self.action(self.sardines[0], 'found', found=True)

    def test_scheduled_hint_boundaries_and_exactly_once(self):
        self.seek()
        sardine = self.sardines[0]
        self.action(sardine, 'schedule', now=1030, text='Near a tree')
        self.assertEqual(self.room['scheduled'][sardine['id']]['due_at'], 1310)
        publish_due(self.room, 1309.999)
        self.assertEqual(len(self.room['hints']), 0)
        publish_due(self.room, 1310)
        publish_due(self.room, 1400)
        self.assertEqual(len(self.room['hints']), 1)
        self.assertEqual(self.room['hints'][0]['sent_at'], 1310)
        self.action(sardine, 'schedule', now=1310, text='Second clue')
        self.assertEqual(self.room['scheduled'][sardine['id']]['due_at'], 1610)
        self.action(sardine, 'hint', now=1350, text='An instant clue')
        self.assertEqual(len(self.room['hints']), 2)
        self.action(sardine, 'cancel_hint')
        self.assertEqual(self.room['scheduled'], {})

    def test_drafts_private_and_tokens_never_returned(self):
        self.seek()
        self.action(self.sardines[0], 'schedule', now=1020, text='A secret draft')
        result = view(self.room, self.seekers[0], 1021)
        self.assertIsNone(result['scheduled_hint'])
        self.assertNotIn('token_hash', str(result))
        self.assertNotIn('A secret draft', str(result))

    def test_host_end_cancels_queue_and_freezes_round(self):
        self.seek()
        self.action(self.sardines[0], 'schedule', text='Cancelled')
        self.action(self.host, 'end', now=1100)
        publish_due(self.room, 10000)
        self.assertEqual(self.room['scheduled'], {})
        self.assertEqual(self.room['hints'], [])
        with self.assertRaises(GameError): self.action(self.seekers[0], 'found', found=True)

    def test_duplicate_names_and_input_validation(self):
        with self.assertRaises(GameError): join(self.room, player(' alex ', 'x' * 48))
        for name in ['', 'a' * 25, None]:
            with self.assertRaises(GameError): player(name, 'x' * 48)
        for count in [0, 4, True, '2', -1]:
            with self.assertRaises(GameError): self.action(self.host, 'configure', count=count)
        with self.assertRaises(GameError): self.action(self.host, 'start')

    def test_idempotent_actions_and_stale_round_rejected(self):
        self.seek()
        data = {'round': self.room['round'], 'request_id': 'same-request-id', 'text': 'Only once'}
        act(self.room, self.sardines[0], 'hint', data, 1020)
        act(self.room, self.sardines[0], 'hint', data, 1020)
        self.assertEqual(len(self.room['hints']), 1)
        with self.assertRaises(GameError):
            act(self.room, self.seekers[0], 'found', {'round': 0, 'request_id': 'old-request', 'found': True}, 1020)

    def test_host_transfer(self):
        next_host = self.players[1]['id']
        self.action(self.host, 'leave')
        self.assertEqual(self.room['host_id'], next_host)

    def test_rename_preserves_identity_and_round_progress(self):
        self.seek()
        sardine = self.sardines[0]
        before = dict(sardine)
        self.action(sardine, 'schedule', now=1020, text='A queued clue')
        self.action(sardine, 'rename', name=' New nickname ')
        self.assertEqual(sardine, before | {'name': 'New nickname'})
        self.assertIn(sardine['id'], self.room['scheduled'])
        publish_due(self.room, 1310)
        self.assertEqual(self.room['hints'][0]['author'], 'New nickname')
        self.assertEqual(self.room['started_at'], 1010)

    def test_rename_validation_and_case_change(self):
        for name in ['', ' ', None, 'a' * 25, ' SAM ']:
            with self.assertRaises(GameError): self.action(self.host, 'rename', name=name)
        self.action(self.host, 'rename', name='ALEX')
        self.assertEqual(self.host['name'], 'ALEX')
        self.action(self.players[1], 'rename', name='Samantha', player_id=self.host['id'])
        self.assertEqual(self.host['name'], 'ALEX')
        self.assertEqual(self.players[1]['name'], 'Samantha')

    def test_kick_permissions_and_lobby_reset(self):
        target = self.players[1]
        with self.assertRaises(GameError): self.action(target, 'kick', player_id=self.players[2]['id'])
        with self.assertRaises(GameError): self.action(self.host, 'kick', player_id=self.host['id'])
        with self.assertRaises(GameError): self.action(self.host, 'kick', player_id='missing')
        self.action(self.host, 'configure', count=3)
        self.action(self.host, 'randomize')
        self.action(self.host, 'kick', player_id=target['id'])
        self.assertEqual(len(self.room['players']), 3)
        self.assertEqual(self.room['sardine_count'], 2)
        self.assertTrue(all(p['role'] == 'seeker' for p in self.room['players']))
        with self.assertRaises(GameError): authenticate(self.room, '0' * 48)

    def test_kicking_unready_sardine_starts_search(self):
        self.start()
        target = next(p for p in self.sardines if p['id'] != self.host['id'])
        remaining = next(p for p in self.sardines if p['id'] != target['id'])
        self.action(remaining, 'hidden', now=1005)
        self.action(self.host, 'kick', player_id=target['id'], now=1012)
        self.assertEqual(self.room['phase'], 'seeking')
        self.assertEqual(self.room['started_at'], 1012)
        self.assertEqual(self.room['sardine_count'], 1)

    def test_kicking_sardine_cancels_their_hint(self):
        self.seek()
        target = next(p for p in self.sardines if p['id'] != self.host['id'])
        self.action(target, 'schedule', now=1020, text='Remove this clue')
        self.action(self.host, 'kick', player_id=target['id'], now=1030)
        publish_due(self.room, 1500)
        self.assertEqual(self.room['hints'], [])
        self.assertEqual(self.room['phase'], 'seeking')

    def test_kicking_last_unfound_seeker_finishes_round(self):
        self.seek()
        target = next(p for p in self.seekers if p['id'] != self.host['id'])
        other = next(p for p in self.seekers if p['id'] != target['id'])
        self.action(other, 'found', found=True, now=1020)
        self.action(self.host, 'kick', player_id=target['id'], now=1030)
        self.assertEqual(self.room['end_reason'], 'everyone_found')
        self.assertEqual(self.room['ended_at'], 1030)

    def test_kicking_last_role_ends_round_and_allows_replay(self):
        for removed_role in ('sardine', 'seeker'):
            with self.subTest(role=removed_role):
                self.setUp()
                # Put the host in the opposite role to allow removing that role.
                self.action(self.host, 'configure', count=2)
                chosen = self.players[1:3] if removed_role == 'sardine' else [self.host, self.players[1]]
                with patch('game.secrets.SystemRandom') as rng:
                    rng.return_value.sample.return_value = chosen
                    self.action(self.host, 'randomize')
                self.action(self.host, 'start')
                for p in list(self.room['players']):
                    if p['role'] == removed_role:
                        self.action(self.host, 'kick', player_id=p['id'])
                self.assertEqual(self.room['phase'], 'ended')
                self.assertEqual(self.room['end_reason'], 'not_enough_players')
                self.action(self.host, 'reset')
                self.assertGreaterEqual(self.room['sardine_count'], 1)
                self.action(self.host, 'randomize')
                self.action(self.host, 'start')

    def test_kick_works_after_round_and_is_idempotent(self):
        self.seek()
        self.action(self.host, 'end')
        data = {'round': self.room['round'], 'request_id': 'kick-retry-id', 'player_id': self.players[1]['id']}
        act(self.room, self.host, 'kick', data, 1100)
        act(self.room, self.host, 'kick', data, 1100)
        self.assertEqual(len(self.room['players']), 3)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = SQLiteStore(os.path.join(self.temp.name, 'test.sqlite3'))
        self.patch = patch.object(server, 'store', return_value=self.store)
        self.patch.start()
        self.client = server.app.test_client()
        self.headers = {'Authorization': 'Bearer ' + 'a' * 48}

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_api_assets_and_reconnect(self):
        for path in ['/', '/assets/app.js', '/assets/style.css']:
            with self.client.get(path) as response:
                self.assertEqual(response.status_code, 200)
        response = self.client.post('/api/rooms', json={'name': 'Alex'}, headers=self.headers)
        self.assertEqual(response.status_code, 201)
        room = response.json
        url = '/api/rooms/' + room['code']
        self.assertEqual(self.client.get(url, headers=self.headers).json['me_id'], room['me_id'])
        self.assertEqual(self.client.get(url).status_code, 401)
        self.assertEqual(self.client.get(url, headers={'Authorization': 'Bearer ' + 'z' * 48}).status_code, 401)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')

    def test_multiplayer_api_round(self):
        host = self.client.post('/api/rooms', json={'name': 'Host'}, headers=self.headers).json
        url = '/api/rooms/' + host['code']
        guest_headers = {'Authorization': 'Bearer ' + 'g' * 48}
        guest = self.client.post(url + '/join', json={'name': 'Guest'}, headers=guest_headers)
        self.assertEqual(guest.status_code, 200)
        credentials = {host['me_id']: self.headers, guest.json['me_id']: guest_headers}
        counter = 0

        def send(action, headers, round_number, **fields):
            nonlocal counter
            counter += 1
            result = self.client.post(url + '/actions/' + action, headers=headers,
                                      json={'round': round_number, 'request_id': f'integration-{counter}', **fields})
            self.assertEqual(result.status_code, 200, result.json)
            return result.json

        send('randomize', self.headers, 0)
        current = send('start', self.headers, 0)
        self.assertEqual(current['phase'], 'hiding')
        late = self.client.post(url + '/join', json={'name': 'Late'},
                                headers={'Authorization': 'Bearer ' + 'l' * 48})
        self.assertEqual(late.status_code, 409)
        sardine = next(p for p in current['players'] if p['role'] == 'sardine')
        seeker = next(p for p in current['players'] if p['role'] == 'seeker')
        send('hidden', credentials[sardine['id']], 1)
        send('hint', credentials[sardine['id']], 1, text='Under something green')
        send('schedule', credentials[sardine['id']], 1, text='A later clue')
        seeker_view = self.client.get(url, headers=credentials[seeker['id']]).json
        self.assertEqual(seeker_view['hints'][0]['text'], 'Under something green')
        self.assertIsNone(seeker_view['scheduled_hint'])
        ended = send('found', credentials[seeker['id']], 1, found=True)
        self.assertEqual(ended['phase'], 'ended')
        lobby = send('reset', self.headers, 1)
        self.assertEqual(lobby['phase'], 'lobby')
        self.assertEqual(lobby['hints'], [])

    def test_concurrent_joins_do_not_lose_players(self):
        host = player('Host', 'a' * 48)
        self.store.create('ABC234', new_room('ABC234', host, 1000))
        def add(index):
            return self.store.update('ABC234', lambda r: join(r, player(f'Player {index}', f'{index:048}')))
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(add, range(20)))
        self.assertEqual(self.store.update('ABC234', lambda r: len(r['players'])), 21)

    def test_rename_and_kick_api_revoke_access(self):
        host = self.client.post('/api/rooms', json={'name': 'Host'}, headers=self.headers).json
        url = '/api/rooms/' + host['code']
        guest_headers = {'Authorization': 'Bearer ' + 'g' * 48}
        guest = self.client.post(url + '/join', json={'name': 'Guest'}, headers=guest_headers).json
        data = {'round': 0, 'request_id': 'rename-request', 'name': 'New name'}
        renamed = self.client.post(url + '/actions/rename', json=data, headers=guest_headers)
        self.assertEqual(renamed.status_code, 200)
        self.assertEqual(renamed.json['me_id'], guest['me_id'])
        self.assertEqual(self.client.get(url, headers=self.headers).json['players'][1]['name'], 'New name')
        kick = {'round': 0, 'request_id': 'kick-request', 'player_id': guest['me_id']}
        self.assertEqual(self.client.post(url + '/actions/kick', json=kick, headers=guest_headers).status_code, 403)
        self.assertEqual(self.client.post(url + '/actions/kick', json=kick, headers=self.headers).status_code, 200)
        self.assertEqual(self.client.get(url, headers=guest_headers).status_code, 401)
        self.assertEqual(self.client.post(url + '/actions/rename', json=data, headers=guest_headers).status_code, 401)

    def test_malformed_requests(self):
        self.assertEqual(self.client.post('/api/rooms', json=[], headers=self.headers).status_code, 400)
        self.assertEqual(self.client.post('/api/rooms', json={'name': ' '}, headers=self.headers).status_code, 400)
        self.assertEqual(self.client.get('/api/rooms/!!!', headers=self.headers).status_code, 400)
        self.assertEqual(self.client.get('/api/rooms/ABC234', headers=self.headers).status_code, 404)

    def test_production_requires_shared_storage(self):
        with patch.dict(os.environ, {'VERCEL': '1'}, clear=True):
            with self.assertRaises(StoreUnavailable): make_store()



if __name__ == '__main__':
    unittest.main()
