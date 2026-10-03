"""真实HTTP暂停交接核验，再撤销会话；旧请求不得重建软件模拟。"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import tempfile
import threading
import unittest
from unittest.mock import patch
from pathlib import Path

import server
import services
from test_app import Client


class SessionRaceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='hexiang-session-race-')
        self.store = server.Store(Path(self.temporary.name))
        self.http = server.AppServer(('127.0.0.1', 0), self.store)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.http.server_port}'
        self.client = Client(self.base)
        self.assertEqual(self.client.call('POST', '/api/register',
                                         {'username': 'qa_cached_scope', 'password': 'Testing-Race-123'})[0], 200)
        raw_cookie = next(cookie.value for cookie in self.client.jar if cookie.name == server.COOKIE)
        self.scope = hashlib.sha256(raw_cookie.encode()).hexdigest()

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=5)
        self.temporary.cleanup()

    def handoff(self, *, scenario=''):
        return self.client.call('POST', '/api/simulation', {
            'action': 'handoff', 'space_id': 'reading',
            'design': {'scenario': scenario, 'components': [{'profile_id': 'F01', 'role': 'main'}]},
        })

    def running_timer(self):
        code, result = self.handoff()
        self.assertEqual(code, 200)
        sid = result['simulation']['id']
        for action, extra in [('confirm', {}), ('set_timer', {'timer_minutes': 1}), ('start', {})]:
            code, result = self.client.call('POST', '/api/simulation', {'action': action, 'simulation_id': sid, **extra})
            self.assertEqual(code, 200)
        with self.http.sim_lock:
            timer = self.http.simulations[sid]['timer']
        self.assertIsNotNone(timer)
        return sid, timer

    def cached_handoff_after_revoke(self, revoke):
        entered = threading.Event()
        release = threading.Event()
        original = services.evaluate_board
        def blocked_evaluation(payload):
            if payload.get('scenario') == 'RACE_CACHED_HANDOFF':
                entered.set()
                if not release.wait(5):
                    raise RuntimeError('test release did not arrive')
            return original(payload)
        with patch.object(services, 'evaluate_board', blocked_evaluation):
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(self.handoff, scenario='RACE_CACHED_HANDOFF')
                try:
                    self.assertTrue(entered.wait(5), 'HTTP请求实际进入交接核验')
                    # 此时原请求已缓存scope；另一HTTP请求已完成会话撤销。
                    code, result = revoke()
                    self.assertEqual(code, 200)
                    with self.store.db() as db:
                        row = db.execute('SELECT expires FROM sessions WHERE token=?', (self.scope,)).fetchone()
                        self.assertTrue(row is None or row['expires'] <= 0)
                finally:
                    release.set()
                response = future.result(timeout=10)
        return response

    def test_blocked_handoff_cannot_recreate_old_scope_after_logout(self):
        old_sid, timer = self.running_timer()
        code, result = self.cached_handoff_after_revoke(lambda: self.client.call('POST', '/api/logout', {}))
        self.assertEqual((code, result.get('code')), (409, 'session_changed'))
        with self.http.sim_lock:
            self.assertNotIn(old_sid, self.http.simulations)
            self.assertFalse(any(entry['scope'] == self.scope for entry in self.http.simulations.values()))
        self.assertTrue(timer.finished.is_set(), '注销已经取消旧后台Timer')

    def test_blocked_handoff_cannot_recreate_old_scope_after_login_rotation(self):
        old_sid, timer = self.running_timer()
        code, result = self.cached_handoff_after_revoke(lambda: self.client.call('POST', '/api/login',
                                                       {'username': 'qa_cached_scope', 'password': 'Testing-Race-123'}))
        self.assertEqual((code, result.get('code')), (409, 'session_changed'))
        with self.http.sim_lock:
            self.assertNotIn(old_sid, self.http.simulations)
            self.assertFalse(any(entry['scope'] == self.scope for entry in self.http.simulations.values()))
        self.assertTrue(timer.finished.is_set())
        # 新会话仍可正常交接，拒绝只针对被撤销的旧请求。
        self.assertEqual(self.handoff()[0], 200)

    def test_blocked_handoff_rechecks_expiry_and_cancels_expired_scope_timer(self):
        old_sid, timer = self.running_timer()
        def expire():
            with self.store.db() as db:
                db.execute('UPDATE sessions SET expires=0 WHERE token=?', (self.scope,))
            return 200, {'fixture': 'explicitly expired temporary test session'}
        code, result = self.cached_handoff_after_revoke(expire)
        self.assertEqual((code, result.get('code')), (409, 'session_changed'))
        with self.http.sim_lock:
            self.assertNotIn(old_sid, self.http.simulations)
        self.assertTrue(timer.finished.is_set())

    def test_start_that_precedes_logout_is_atomic_and_its_timer_is_cancelled(self):
        code, result = self.handoff()
        self.assertEqual(code, 200)
        sid = result['simulation']['id']
        self.client.call('POST', '/api/simulation', {'action': 'confirm', 'simulation_id': sid})
        entered = threading.Event()
        release = threading.Event()
        logout_attempted_lock = threading.Event()
        timers = []
        original = self.http.simulator.operate
        class ObservedLock:
            def __init__(self):
                self.lock = threading.RLock()
                self.attempts = 0
            def __enter__(self):
                self.attempts += 1
                if self.attempts == 2:
                    logout_attempted_lock.set()
                self.lock.acquire()
                return self
            def __exit__(self, *_):
                self.lock.release()
        self.http.scope_lock = ObservedLock()
        def blocked_start(scope, action, simulation_id, **kwargs):
            if action == 'start':
                entered.set()
                if not release.wait(5):
                    raise RuntimeError('test release did not arrive')
            result = original(scope, action, simulation_id, **kwargs)
            if action == 'start':
                with self.http.sim_lock:
                    timers.append(self.http.simulations[simulation_id]['timer'])
            return result
        with patch.object(self.http.simulator, 'operate', blocked_start):
            with ThreadPoolExecutor(max_workers=2) as pool:
                start = pool.submit(self.client.call, 'POST', '/api/simulation', {'action': 'start', 'simulation_id': sid})
                logout = None
                try:
                    self.assertTrue(entered.wait(5))
                    logout = pool.submit(self.client.call, 'POST', '/api/logout', {})
                    self.assertTrue(logout_attempted_lock.wait(5), '另一HTTP线程已经尝试进入同一scope锁')
                    self.assertFalse(logout.done(), '完成最终scope检查的start操作先完成，再允许logout撤销')
                finally:
                    release.set()
                self.assertEqual(start.result(timeout=10)[0], 200)
                self.assertEqual(logout.result(timeout=10)[0], 200)
        self.assertEqual(len(timers), 1)
        self.assertTrue(timers[0].finished.is_set())
        with self.http.sim_lock:
            self.assertFalse(any(entry['scope'] == self.scope for entry in self.http.simulations.values()))


if __name__ == '__main__':
    unittest.main(verbosity=2)
