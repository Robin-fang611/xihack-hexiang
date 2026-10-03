"""软件模拟状态、归属与后台停止；仅临时服务和可控时钟，不接真实设备。"""
import copy
import tempfile
import threading
import time
import unittest
from pathlib import Path

import server
from simulation import Simulator, SimulationError, schedule
from test_app import Client


class Handle:
    def __init__(self, due, callback):
        self.due, self.callback = due, callback
        self.cancelled = False
        self.fired = False

    def cancel(self):
        self.cancelled = True


class TimeFixture:
    def __init__(self):
        self.monotonic = 100.0
        self.wall = 1791000000.0
        self.handles = []

    def schedule(self, delay, callback):
        handle = Handle(self.monotonic + delay, callback)
        self.handles.append(handle)
        return handle

    def advance(self, seconds, *, callbacks=True):
        self.monotonic += seconds
        self.wall += seconds
        if callbacks:
            for handle in list(self.handles):
                if not handle.cancelled and not handle.fired and handle.due <= self.monotonic:
                    handle.fired = True
                    handle.callback()

    def simulator(self):
        return Simulator(clock=lambda: self.monotonic, wall_clock=lambda: self.wall, scheduler=self.schedule)


class SimulationStateTest(unittest.TestCase):
    def setUp(self):
        self.time = TimeFixture()
        self.simulator = self.time.simulator()
        self.scope = 'test-session-a'
        self.state = self.simulator.create(self.scope, 'reading')
        self.sid = self.state['id']

    def tearDown(self):
        self.simulator.close()

    def operate(self, action, **kwargs):
        return self.simulator.operate(self.scope, action, self.sid, **kwargs)

    def ready(self, minutes=1):
        self.operate('confirm')
        self.operate('set_timer', timer_minutes=minutes)
        return self.operate('start')

    def test_confirmation_is_enforced_by_server_state(self):
        self.assertFalse(self.state['confirmed'])
        for action in ('start', 'set_timer'):
            with self.assertRaises(SimulationError) as failure:
                self.operate(action, timer_minutes=1)
            self.assertEqual(failure.exception.status, 409)
            self.assertEqual(failure.exception.code, 'simulation_confirmation_required')
        self.assertFalse(self.operate('status')['running'])
        self.assertEqual(self.time.handles, [])
        confirmed = self.operate('confirm')
        self.assertTrue(confirmed['confirmed'])
        self.assertEqual(len([row for row in self.operate('confirm')['history'] if row['action'] == 'confirm']), 1)

    def test_background_deadline_stops_without_any_status_request(self):
        started = self.ready()
        self.assertEqual(started['remaining_seconds'], 60)
        self.assertIn('+08:00', started['expires_at'])
        self.assertEqual(started['mode'], 'software_simulation')
        self.time.advance(59)
        self.assertTrue(self.simulator.entries[self.sid]['state']['running'])
        self.time.advance(1)
        # 直接检查后台条目，尚未调用 status，排除仅靠读取时惰性停止。
        stopped = self.simulator.entries[self.sid]['state']
        self.assertFalse(stopped['running'])
        self.assertEqual(stopped['remaining_seconds'], 0)
        self.assertIsNone(stopped['expires_at'])
        self.assertEqual(stopped['history'][-1]['action'], 'auto_stop')
        self.assertEqual(len([row for row in self.operate('status')['history'] if row['action'] == 'auto_stop']), 1)

    def test_status_countdown_uses_monotonic_clock_and_catches_delayed_callback(self):
        started = self.ready()
        self.time.advance(10, callbacks=False)
        self.time.wall += 86400
        current = self.operate('status')
        self.assertEqual(current['remaining_seconds'], 50)
        self.assertEqual(current['remaining_minutes'], 1)
        self.assertEqual(current['expires_at'], started['expires_at'])
        self.time.advance(50, callbacks=False)
        self.assertFalse(self.operate('status')['running'])
        self.assertTrue(self.time.handles[-1].cancelled)

    def test_repeated_start_does_not_extend_timer_or_duplicate_event(self):
        started = self.ready()
        deadline = self.simulator.entries[self.sid]['deadline']
        self.time.advance(30)
        repeated = self.operate('start')
        self.assertEqual(self.simulator.entries[self.sid]['deadline'], deadline)
        self.assertEqual(repeated['expires_at'], started['expires_at'])
        self.assertEqual(repeated['remaining_seconds'], 30)
        self.assertEqual(len([row for row in repeated['history'] if row['action'] == 'start']), 1)
        self.time.advance(30)
        self.assertFalse(self.simulator.entries[self.sid]['state']['running'])

    def test_running_timer_reset_cancels_old_callback_and_stop_cancels_new(self):
        self.ready()
        old_timer = self.time.handles[-1]
        self.time.advance(10)
        changed = self.operate('set_timer', timer_minutes=2)
        self.assertEqual(changed['remaining_seconds'], 120)
        self.assertTrue(old_timer.cancelled)
        self.time.advance(50)
        old_timer.callback()  # 已进入队列的旧回调也不能关闭新计时。
        self.assertTrue(self.operate('status')['running'])
        self.assertEqual(self.operate('status')['remaining_seconds'], 70)
        active_timer = self.time.handles[-1]
        stopped = self.operate('stop')
        self.assertEqual(stopped['remaining_seconds'], 0)
        self.assertFalse(stopped['running'])
        self.assertTrue(active_timer.cancelled)
        self.time.advance(100)
        self.assertNotIn('auto_stop', [row['action'] for row in self.operate('status')['history']])
        self.assertEqual(self.operate('start')['remaining_seconds'], 120)

    def test_invalid_integer_values_do_not_change_timer_or_history(self):
        self.operate('confirm')
        before = self.operate('status')
        for minutes in (0, 121, 1.9, True, False, '1', None, {}, [1]):
            with self.subTest(minutes=repr(minutes)):
                with self.assertRaises(SimulationError) as failure:
                    self.operate('set_timer', timer_minutes=minutes)
                self.assertEqual(failure.exception.status, 400)
                self.assertEqual(failure.exception.code, 'invalid_timer')
                self.assertEqual(self.operate('status'), before)

    def test_foreign_scope_and_mutating_response_cannot_change_simulation(self):
        for action in ('status', 'confirm', 'start', 'set_timer', 'stop'):
            with self.assertRaises(SimulationError) as failure:
                self.simulator.operate('other-session', action, self.sid, timer_minutes=1)
            self.assertEqual(failure.exception.status, 404)
        returned = self.operate('status')
        returned['running'] = True
        returned['history'].clear()
        self.assertFalse(self.operate('status')['running'])
        self.assertEqual(len(self.operate('status')['history']), 1)

    def test_replacement_revoke_and_close_cancel_background_timer(self):
        self.ready()
        old_entry = self.simulator.entries[self.sid]
        old_timer = self.time.handles[-1]
        next_state = self.simulator.create(self.scope, 'lobby')
        self.assertTrue(old_timer.cancelled)
        self.assertFalse(old_entry['state']['running'])
        self.assertNotIn(self.sid, self.simulator.entries)
        self.assertFalse(next_state['confirmed'])
        self.simulator.revoke(self.scope)
        self.assertEqual(self.simulator.entries, {})
        third = self.simulator.create(self.scope, 'reading')
        self.sid = third['id']
        self.ready()
        self.simulator.close()
        self.assertTrue(self.time.handles[-1].cancelled)
        self.assertEqual(self.simulator.entries, {})

    def test_real_timer_thread_stops_with_explicitly_accelerated_test_clock(self):
        completed = threading.Event()
        scale = 1000
        def accelerated_scheduler(delay, callback):
            def run():
                callback()
                completed.set()
            return schedule(delay / scale, run)
        simulator = Simulator(clock=lambda: time.monotonic() * scale, scheduler=accelerated_scheduler)
        try:
            sid = simulator.create('accelerated-test', 'reading')['id']
            simulator.operate('accelerated-test', 'confirm', sid)
            simulator.operate('accelerated-test', 'set_timer', sid, timer_minutes=1)
            simulator.operate('accelerated-test', 'start', sid)
            self.assertTrue(completed.wait(2))
            with simulator.lock:
                state = copy.deepcopy(simulator.entries[sid]['state'])
            self.assertFalse(state['running'])
            self.assertEqual(state['history'][-1]['action'], 'auto_stop')
        finally:
            simulator.close()


class SimulationHTTPTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='hexiang-simulation-http-')
        self.store = server.Store(Path(self.temporary.name))
        self.time = TimeFixture()
        self.http = server.AppServer(('127.0.0.1', 0), self.store, simulator=self.time.simulator())
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.http.server_port}'
        self.client = Client(self.base)

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=5)
        self.temporary.cleanup()

    def call(self, action, sid=None, **kwargs):
        return self.client.call('POST', '/api/simulation', {'action': action, 'simulation_id': sid, **kwargs})

    def handoff(self):
        code, result = self.call('handoff', design={'components': [{'profile_id': 'F01', 'role': 'main'}]}, space_id='reading')
        self.assertEqual(code, 200)
        return result['simulation']['id']

    def test_guest_confirmation_invalid_input_foreign_scope_and_auto_stop(self):
        sid = self.handoff()
        self.assertEqual(self.call('start', sid)[0], 409)
        self.assertEqual(self.call('set_timer', sid, timer_minutes=1)[0], 409)
        self.assertTrue(self.call('confirm', sid)[1]['simulation']['confirmed'])
        for minutes in ('1', 1.9, True, None, 121):
            code, result = self.call('set_timer', sid, timer_minutes=minutes)
            self.assertEqual((code, result['code']), (400, 'invalid_timer'))
        self.assertEqual(self.call('set_timer', sid, timer_minutes=1)[0], 200)
        self.assertTrue(self.call('start', sid)[1]['simulation']['running'])
        other = Client(self.base)
        code, result = other.call('POST', '/api/simulation', {'action': 'status', 'simulation_id': sid})
        self.assertEqual((code, result['code']), (404, 'simulation_not_found'))
        self.time.advance(60)
        self.assertFalse(self.http.simulations[sid]['state']['running'])
        final = self.call('status', sid)[1]['simulation']
        self.assertEqual(final['history'][-1]['action'], 'auto_stop')
        self.assertEqual(final['remaining_seconds'], 0)

    def test_registration_and_logout_revoke_old_scope(self):
        guest_sid = self.handoff()
        self.call('confirm', guest_sid)
        self.call('start', guest_sid)
        self.assertEqual(self.client.call('POST', '/api/register', {'username': 'qa_sim_register', 'password': 'Testing-Simulation-123'})[0], 200)
        self.assertNotIn(guest_sid, self.http.simulations)
        self.assertEqual(self.call('status', guest_sid)[0], 404)
        user_sid = self.handoff()
        self.call('confirm', user_sid)
        self.call('start', user_sid)
        self.assertEqual(self.client.call('POST', '/api/logout', {})[0], 200)
        self.assertNotIn(user_sid, self.http.simulations)
        self.assertTrue(all(handle.cancelled for handle in self.time.handles))


if __name__ == '__main__':
    unittest.main(verbosity=2)
