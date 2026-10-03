"""会话归属的软件模拟；单调时钟与后台定时器，不连接真实设备。"""
from __future__ import annotations

import copy
from datetime import datetime
import math
import threading
import time
import uuid
from zoneinfo import ZoneInfo


class SimulationError(Exception):
    def __init__(self, status, message, code):
        self.status, self.message, self.code = status, message, code


def schedule(delay, callback):
    timer = threading.Timer(delay, callback)
    timer.daemon = True
    timer.start()
    return timer


class Simulator:
    def __init__(self, *, clock=time.monotonic, wall_clock=time.time, scheduler=schedule):
        self.clock, self.wall_clock, self.scheduler = clock, wall_clock, scheduler
        self.entries = {}
        self.lock = threading.RLock()
        self.closed = False

    def stamp(self, timestamp=None):
        timestamp = self.wall_clock() if timestamp is None else timestamp
        return datetime.fromtimestamp(timestamp, ZoneInfo('Asia/Shanghai')).isoformat(timespec='seconds')

    def _event(self, entry, action, note=''):
        row = {'action': action, 'at': self.stamp()}
        if note:
            row['note'] = note
        entry['state']['history'].append(row)
        entry['state']['history'] = entry['state']['history'][-100:]

    def _cancel(self, entry):
        entry['generation'] += 1
        if entry.get('timer') is not None:
            entry['timer'].cancel()
        entry['timer'] = None

    def _stop(self, entry, action, note=''):
        self._cancel(entry)
        entry['deadline'] = None
        entry['state'].update(running=False, remaining_seconds=0, remaining_minutes=0, expires_at=None)
        self._event(entry, action, note)

    def _sync(self, entry):
        if not entry['state']['running']:
            return
        remaining = entry['deadline'] - self.clock()
        if remaining <= 0:
            self._stop(entry, 'auto_stop', '软件模拟定时已到，后台自动关闭；不涉及真实设备。')
        else:
            seconds = math.ceil(remaining)
            entry['state'].update(remaining_seconds=seconds, remaining_minutes=math.ceil(seconds / 60))

    def _arm(self, entry):
        self._cancel(entry)
        generation = entry['generation']
        simulation_id = entry['state']['id']
        delay = max(0, entry['deadline'] - self.clock())
        entry['timer'] = self.scheduler(delay, lambda: self._expired(simulation_id, generation))

    def _expired(self, simulation_id, generation):
        with self.lock:
            entry = self.entries.get(simulation_id)
            if not entry or entry['generation'] != generation or not entry['state']['running']:
                return
            self._sync(entry)
            if entry['state']['running']:
                # 调度器提前唤醒时按单调时钟重排，不能提前关停。
                self._arm(entry)

    def _reset_deadline(self, entry):
        seconds = entry['state']['timer_minutes'] * 60
        entry['deadline'] = self.clock() + seconds
        entry['state'].update(remaining_seconds=seconds, remaining_minutes=entry['state']['timer_minutes'],
                              expires_at=self.stamp(self.wall_clock() + seconds))
        self._arm(entry)

    def _snapshot(self, entry):
        self._sync(entry)
        return copy.deepcopy(entry['state'])

    def create(self, scope, space_id):
        with self.lock:
            if self.closed:
                raise SimulationError(503, '软件模拟服务已关闭。', 'simulation_closed')
            self.revoke(scope, note='新方案替换本会话旧软件模拟。')
            simulation_id = uuid.uuid4().hex
            state = {'id': simulation_id, 'space_id': space_id, 'confirmed': False, 'running': False,
                     'timer_minutes': 10, 'remaining_minutes': 10, 'remaining_seconds': 600,
                     'expires_at': None, 'history': [], 'mode': 'software_simulation'}
            entry = {'scope': scope, 'state': state, 'deadline': None, 'timer': None, 'generation': 0}
            self.entries[simulation_id] = entry
            self._event(entry, 'handoff', '软件模拟接收设计；确认后可运行，不涉及真实耗材或设备。')
            return self._snapshot(entry)

    def operate(self, scope, action, simulation_id, *, timer_minutes=None):
        with self.lock:
            entry = self.entries.get(simulation_id) if isinstance(simulation_id, str) else None
            if not entry or entry['scope'] != scope:
                raise SimulationError(404, '未找到本会话的模拟。', 'simulation_not_found')
            self._sync(entry)
            state = entry['state']
            if action == 'status':
                return self._snapshot(entry)
            if action == 'confirm':
                if not state['confirmed']:
                    state['confirmed'] = True
                    self._event(entry, action, '已确认本次软件模拟。')
            elif action in ('start', 'set_timer'):
                if not state['confirmed']:
                    raise SimulationError(409, '请先确认本次软件模拟，再设置或运行。', 'simulation_confirmation_required')
                if action == 'set_timer':
                    if type(timer_minutes) is not int or not 1 <= timer_minutes <= 120:
                        raise SimulationError(400, '模拟时长须为1至120之间的整数分钟。', 'invalid_timer')
                    state['timer_minutes'] = timer_minutes
                    if state['running']:
                        self._reset_deadline(entry)
                    else:
                        state.update(remaining_seconds=timer_minutes * 60, remaining_minutes=timer_minutes, expires_at=None)
                    self._event(entry, action)
                elif not state['running']:
                    state['running'] = True
                    self._reset_deadline(entry)
                    self._event(entry, action)
            elif action == 'stop':
                self._stop(entry, action, '软件模拟已手动关闭。')
            else:
                raise SimulationError(400, '不支持的模拟动作。', 'invalid_simulation_action')
            return self._snapshot(entry)

    def revoke(self, scope, *, note='会话已切换，旧软件模拟已撤销。'):
        with self.lock:
            for simulation_id, entry in list(self.entries.items()):
                if entry['scope'] == scope:
                    self._stop(entry, 'revoke', note)
                    self.entries.pop(simulation_id)

    def close(self):
        with self.lock:
            self.closed = True
            for entry in self.entries.values():
                self._stop(entry, 'server_close', '本机软件服务已关闭。')
            self.entries.clear()
