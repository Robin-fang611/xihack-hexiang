"""Checkpoint integrity tests use entirely disposable projects and evidence."""
import json
import os
from pathlib import Path
import tempfile
import unittest
import shutil
import subprocess
import sys
import threading
import time
import copy
import uuid
import urllib.request
import urllib.error
import http.cookiejar

from iteration_cycle import CycleError, IterationCycle, context_usage, runtime_manifest, sha256


class CheckpointTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='hexiang-cycle-test-')
        self.root = Path(self.temporary.name)
        self.source = self.root / 'app' / 'static' / 'app.js'
        self.source.parent.mkdir(parents=True)
        self.source.write_text('export const version = 0;')
        self.cycle = IterationCycle(self.root)

    def tearDown(self):
        self.temporary.cleanup()

    def evidence(self, number, *, passed=True, artifact=True, source=True):
        folder = self.root / 'evidence' / str(number)
        folder.mkdir(parents=True, exist_ok=True)
        behavior = folder / 'behavior.json'
        behavior.write_text(json.dumps({'action': 'real-test-fixture', 'result': 'accepted'}))
        payload = {'round': number, 'passed': passed,
                   'checks': [{'id': f'behavior-{number}', 'passed': passed}],
                   'source_sha256': runtime_manifest(self.root) if source else {},
                   'behavior_evidence': [{'description': 'Disposable test fixture', 'path': str(behavior)}] if artifact else []}
        target = folder / 'acceptance.json'
        target.write_text(json.dumps(payload))
        return target

    def changed(self, number):
        self.source.write_text(f'export const version = {number};')

    def finish(self, number):
        self.changed(number)
        return self.cycle.complete(number, self.evidence(number), 'Reviewed behavior; next round follows its own objective.')

    def test_five_ordered_rounds_stop_and_keep_snapshots(self):
        for number in range(1, 6):
            state = self.cycle.start(number, f'Product behavior {number}')
            self.assertEqual(state['active_round'], number)
            state = self.finish(number)
            self.assertEqual(state['completed_rounds'], list(range(1, number + 1)))
            folder = self.cycle.folder(number)
            before = folder / 'source-before' / 'app' / 'static' / 'app.js'
            after = folder / 'completion' / 'source-after' / 'app' / 'static' / 'app.js'
            self.assertIn(f'version = {number - 1}', before.read_text())
            self.assertIn(f'version = {number}', after.read_text())
            self.assertTrue((folder / 'completion' / 'artifacts' / '01-behavior.json').is_file())
        self.assertEqual(state['status'], 'complete')
        self.assertIsNone(state['next_round'])
        with self.assertRaises(CycleError):
            self.cycle.start(5, 'Extra round')

    def test_skip_start_and_finish_are_rejected(self):
        with self.assertRaises(CycleError):
            self.cycle.start(2, 'Skipped first round')
        with self.assertRaises(CycleError):
            self.cycle.complete(1, self.root / 'missing.json', 'No start')
        self.cycle.start(1, 'First round')
        with self.assertRaises(CycleError):
            self.cycle.start(2, 'Parallel second round')
        with self.assertRaises(CycleError):
            self.cycle.complete(2, self.root / 'missing.json', 'Skipped finish')

    def test_duplicate_finish_is_rejected(self):
        self.cycle.start(1, 'First round')
        self.finish(1)
        with self.assertRaises(CycleError):
            self.cycle.complete(1, self.evidence(1), 'Duplicate')
        self.assertEqual(self.cycle.status()['completed_rounds'], [1])

    def test_repeated_old_tests_and_tool_only_changes_do_not_count(self):
        self.cycle.start(1, 'Actual change required')
        (self.root / 'app' / 'test_new.py').write_text('assert True')
        with self.assertRaisesRegex(CycleError, '运行源码没有实际改动'):
            self.cycle.complete(1, self.evidence(1), 'Tests only')
        self.assertEqual(self.cycle.status()['active_round'], 1)

    def test_failed_acceptance_does_not_advance(self):
        self.cycle.start(1, 'First round')
        self.changed(1)
        with self.assertRaises(CycleError):
            self.cycle.complete(1, self.evidence(1, passed=False), 'Failed')
        self.assertEqual(self.cycle.status()['completed_rounds'], [])
        self.assertFalse((self.cycle.folder(1) / 'completion').exists())

    def test_missing_behavior_and_source_binding_are_rejected(self):
        self.cycle.start(1, 'First round')
        self.changed(1)
        for settings in ({'artifact': False}, {'source': False}):
            with self.assertRaises(CycleError):
                self.cycle.complete(1, self.evidence(1, **settings), 'Missing evidence')

    def test_defect_probe_cannot_be_counted_as_round_acceptance(self):
        self.cycle.start(1, 'Actual implementation required')
        self.changed(1)
        path = self.evidence(1)
        value = json.loads(path.read_text())
        value['probe'] = 'cross-tab'
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(CycleError, '前置缺陷复现'):
            self.cycle.complete(1, path, 'Probe only')

    def test_source_changed_after_acceptance_requires_retest(self):
        self.cycle.start(1, 'First round')
        self.changed(1)
        evidence = self.evidence(1)
        self.changed(2)
        with self.assertRaisesRegex(CycleError, '验收源码与当前源码不一致'):
            self.cycle.complete(1, evidence, 'Changed after test')

    def test_old_artifact_cannot_be_reused(self):
        evidence = self.evidence(1)
        artifact = Path(json.loads(evidence.read_text())['behavior_evidence'][0]['path'])
        os.utime(artifact, (1, 1))
        self.cycle.start(1, 'First round')
        self.changed(1)
        payload = json.loads(evidence.read_text())
        payload['source_sha256'] = runtime_manifest(self.root)
        evidence.write_text(json.dumps(payload))
        with self.assertRaisesRegex(CycleError, '早于本轮开始'):
            self.cycle.complete(1, evidence, 'Old artifact')

    def test_private_data_is_never_hashed_or_copied(self):
        for name in ('.local/账号.txt', 'verification/old.json', '__pycache__/cache.py'):
            private = self.root / 'app' / name
            private.parent.mkdir(parents=True, exist_ok=True)
            private.write_text('DO_NOT_INCLUDE_PRIVATE_DATA')
        manifest = runtime_manifest(self.root)
        self.assertEqual(set(manifest), {'app/static/app.js'})
        self.cycle.start(1, 'First round')
        self.changed(1)
        with self.assertRaisesRegex(CycleError, '正式私有目录'):
            self.cycle.complete(1, self.root / 'app' / '.local' / '账号.txt', 'Unsafe')

    def test_new_runtime_modules_are_discovered_without_a_fixed_list(self):
        self.cycle.start(1, 'New interpretation module')
        parser = self.root / 'app' / 'intent.py'
        parser.write_text('def interpret(text): return text')
        self.assertIn('app/intent.py', runtime_manifest(self.root))
        self.cycle.complete(1, self.evidence(1), 'Actual new runtime module is source-bound.')
        receipt = json.loads((self.cycle.folder(1) / 'completion' / 'receipt.json').read_text())
        self.assertEqual(receipt['source_delta'][0]['path'], 'app/intent.py')

    def test_actual_test_sources_are_retained_for_future_reproduction(self):
        test = self.root / 'app' / 'qa_test.cjs'
        test.write_text('assert(before);')
        self.cycle.start(1, 'First round')
        self.changed(1)
        test.write_text('assert(after);')
        self.cycle.complete(1, self.evidence(1), 'Reviewed actual version of behavior tests.')
        folder = self.cycle.folder(1)
        self.assertEqual((folder / 'tooling-before' / 'app' / 'qa_test.cjs').read_text(), 'assert(before);')
        snapshot = folder / 'completion' / 'tooling-after' / 'app' / 'qa_test.cjs'
        self.assertEqual(snapshot.read_text(), 'assert(after);')
        snapshot.write_text('tampered')
        with self.assertRaises(CycleError):
            self.cycle.status()

    def test_snapshot_copy_survives_original_artifact_removal(self):
        self.cycle.start(1, 'First round')
        self.changed(1)
        evidence = self.evidence(1)
        artifact = Path(json.loads(evidence.read_text())['behavior_evidence'][0]['path'])
        self.cycle.complete(1, evidence, 'Review complete')
        artifact.unlink()
        self.assertEqual(self.cycle.status()['completed_rounds'], [1])

    def test_tampered_artifact_blocks_state(self):
        self.cycle.start(1, 'First round')
        self.finish(1)
        artifact = self.cycle.folder(1) / 'completion' / 'artifacts' / '01-behavior.json'
        artifact.write_text('tampered')
        with self.assertRaisesRegex(CycleError, '行为证据丢失或被改写'):
            self.cycle.status()

    def test_active_snapshot_corruption_is_rejected_before_receipt_write(self):
        self.cycle.start(1, 'First round')
        self.changed(1)
        snapshot = self.cycle.folder(1) / 'source-before' / 'app' / 'static' / 'app.js'
        snapshot.write_text('tampered')
        with self.assertRaises(CycleError):
            self.cycle.complete(1, self.evidence(1), 'Corrupted baseline')
        self.assertFalse((self.cycle.folder(1) / 'completion').exists())

    def test_tampered_acceptance_or_source_snapshot_blocks_state(self):
        self.cycle.start(1, 'First round')
        self.finish(1)
        for name in ('acceptance.json', 'source-after/app/static/app.js'):
            with self.subTest(file=name):
                artifact = self.cycle.folder(1) / 'completion' / name
                original = artifact.read_bytes()
                artifact.write_text('tampered')
                with self.assertRaises(CycleError):
                    self.cycle.status()
                artifact.write_bytes(original)

    def test_state_cache_rebuilds_from_full_receipt_after_interruption(self):
        self.cycle.start(1, 'First round')
        self.finish(1)
        (self.cycle.output / 'state.json').write_text('{partial cache')
        self.assertEqual(self.cycle.status()['completed_rounds'], [1])

    def test_objective_and_review_notes_are_required(self):
        with self.assertRaises(CycleError):
            self.cycle.start(1, '  ')
        self.cycle.start(1, 'First round')
        self.changed(1)
        with self.assertRaises(CycleError):
            self.cycle.complete(1, self.evidence(1), '')

    def test_symlinked_runtime_source_is_rejected(self):
        secret = self.root / 'secret.txt'
        secret.write_text('DO_NOT_READ')
        (self.source.parent / 'secret.js').symlink_to(secret)
        with self.assertRaisesRegex(CycleError, '符号链接'):
            runtime_manifest(self.root)

    def test_context_only_uses_last_event_and_no_message_body(self):
        session = self.root / 'chosen-session.jsonl'
        events = [
            {'type': 'response_item', 'payload': {'type': 'message', 'content': 'PRIVATE_MESSAGE_BODY'}},
            {'timestamp': 'first', 'payload': {'type': 'token_count', 'info': {'last_token_usage': {'total_tokens': 80}, 'model_context_window': 100}}},
            {'timestamp': 'last', 'payload': {'type': 'token_count', 'info': {'last_token_usage': {'total_tokens': 236018}, 'model_context_window': 828400}, 'rate_limits': 'PRIVATE_ACCOUNT_QUOTA'}},
        ]
        session.write_text('\n'.join(json.dumps(row) for row in events))
        result = context_usage(session)
        self.assertEqual(result['percent'], 28.49)
        self.assertEqual(result['observed_at'], 'last')
        self.assertFalse(result['handoff_required'])
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_context_threshold_is_strictly_above_fifty_percent(self):
        session = self.root / 'chosen-session.jsonl'
        for tokens, required in ((50, False), (51, True)):
            session.write_text(json.dumps({'payload': {'type': 'token_count', 'info': {'last_token_usage': {'total_tokens': tokens}, 'model_context_window': 100}}}))
            self.assertEqual(context_usage(session)['handoff_required'], required)

    def test_context_missing_and_latest_incomplete_are_unknown(self):
        session = self.root / 'chosen-session.jsonl'
        self.assertEqual(context_usage(session)['status'], 'unknown')
        session.write_text('\n'.join((json.dumps({'payload': {'type': 'token_count', 'info': {'last_token_usage': {'total_tokens': 51}, 'model_context_window': 100}}}),
                                    json.dumps({'timestamp': 'incomplete', 'payload': {'type': 'token_count', 'info': None}}))))
        result = context_usage(session)
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['observed_at'], 'incomplete')
        self.assertIsNone(result['handoff_required'])


def run_browser_round(number, probe=None, supplemental=False):
    """Serve actual product sources with brand-new data, never copying .local OCR."""
    import server
    project = Path(__file__).resolve().parent.parent
    output = project / 'app' / 'verification' / 'iterations' / f'round-{number}'
    if probe:
        output = output / f'probe-{probe}'
    if supplemental:
        output = output / 'supplement'
    output.mkdir(parents=True, exist_ok=True)
    attempt = Path(tempfile.mkdtemp(prefix='attempt-', dir=output))
    before = runtime_manifest(project)
    node = shutil.which('node')
    if not node:
        raise SystemExit('未发现已有Node运行库；本脚本不会安装依赖。')
    live_suffix = uuid.uuid4().hex[:12]
    live_credentials = {'username': 'qa_r4_live_' + live_suffix, 'password': 'QaR4-Live-Only-' + live_suffix}
    background = None
    with tempfile.TemporaryDirectory(prefix=f'hexiang-round-{number}-') as temporary:
        store = server.Store(Path(temporary))
        http = server.AppServer(('127.0.0.1', 0), store)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        try:
            live_owner = None
            live_cookies = []
            if number in (4, 5) and not probe and not supplemental:
                live_owner = IsolatedHTTPClient(f'http://127.0.0.1:{http.server_port}')
                registration_status, _ = live_owner.call('POST', '/api/register', live_credentials)
                if registration_status != 200:
                    raise RuntimeError('隔离的后台计时会话未能建立。')
                live_cookies = live_owner.browser_cookies()
            result = subprocess.run([node, 'qa_iterations.cjs'], cwd=project / 'app',
                                    env={**os.environ, 'XIHA_QA_ROUND': str(number),
                                         'XIHA_QA_BASE': f'http://127.0.0.1:{http.server_port}',
                                         'XIHA_QA_DATA_DIR': str(store.path), 'XIHA_QA_OUTPUT': str(attempt),
                                         'XIHA_QA_LIVE_USERNAME': live_credentials['username'],
                                         'XIHA_QA_LIVE_PASSWORD': live_credentials['password'],
                                         'XIHA_QA_LIVE_COOKIES': json.dumps(live_cookies),
                                         'XIHA_QA_PROBE': probe or '',
                                         'XIHA_QA_R5_NEW_ONLY': '1' if supplemental else '0'},
                                    capture_output=True, text=True, timeout=180)
            if number in (4, 5) and not probe and not supplemental:
                job_path = attempt / 'r4-live-job.json'
                if job_path.is_file():
                    job = json.loads(job_path.read_text())
                    deadline = job['started_epoch'] + 63
                    print(json.dumps({'real_background_timer_wait': True, 'browser_closed': job['browser_closed'],
                                      'remaining_seconds': max(0, round(deadline - time.time(), 2))}), flush=True)
                    while time.time() < deadline:
                        time.sleep(max(0, min(1, deadline - time.time())))
                    # No simulation status request has been made for this owner.
                    with http.sim_lock:
                        entry = http.simulations.get(job['simulation_id'])
                        internal = copy.deepcopy(entry['state']) if entry else None
                    stopped_before_http = bool(internal and internal.get('running') is False and
                                               any(item.get('action') == 'auto_stop' for item in internal.get('history', [])))
                    # Keep the original CookieJar whose exact raw cookie was
                    # injected into Chrome; a new login has a different scope.
                    status_code, remote = live_owner.call('POST', '/api/simulation', {'action': 'status', 'simulation_id': job['simulation_id']})
                    background = {'passed': bool(job['browser_closed'] and stopped_before_http and
                                                 status_code == 200 and remote.get('simulation', {}).get('running') is False),
                                  'elapsed_seconds': round(time.time() - job['started_epoch'], 2),
                                  'browser_closed': job['browser_closed'], 'no_poll_before_internal_observation': True,
                                  'internal_before_any_status': internal, 'owner_status_http': status_code,
                                  'owner_status': remote,
                                  'scope': 'Actual default threading.Timer and real one-minute wall time; internal state observed before any status query after closing the independent Chrome process.'}
                else:
                    background = {'passed': False, 'reason': 'The browser did not leave a real one-minute background job receipt.'}
                (attempt / '真实后台定时验收.json').write_text(json.dumps(background, ensure_ascii=False, indent=2) + '\n')
        finally:
            http.shutdown()
            http.server_close()
            thread.join(timeout=5)
    if result.stdout:
        print(result.stdout.strip())
    if result.stderr:
        print(result.stderr.strip(), file=sys.stderr)
    trace = json.loads((attempt / '浏览器行为.json').read_text())
    modules = {2: ['test_intent'], 4: ['test_simulation', 'test_conflict'],
               5: ['test_intent', 'test_simulation', 'test_conflict', 'test_session_race', 'test_iterations']}.get(number) if not probe and not supplemental else None
    if modules:
        command = [sys.executable, '-m', 'unittest', '-v', *modules]
        module = subprocess.run(command, cwd=project / 'app', capture_output=True, text=True, timeout=60)
        module_evidence = {'command': command,
                           'passed': module.returncode == 0, 'exit_code': module.returncode,
                           'stdout': module.stdout, 'stderr': module.stderr}
        module_path = attempt / '模块验收.json'
        module_path.write_text(json.dumps(module_evidence, ensure_ascii=False, indent=2) + '\n')
        trace['checks'].append({'id': f'r{number}-module-tests', 'description': 'Actual module tests: ' + ', '.join(modules), 'passed': module.returncode == 0})
        trace['passed'] = trace['passed'] and module.returncode == 0
        trace['behavior_evidence'].append({'description': 'Actual output of all round-specific module tests', 'path': str(module_path)})
    if number in (4, 5) and not probe and not supplemental:
        trace['checks'].append({'id': 'r4-real-background-auto-stop', 'description': 'Actual closed-browser one-minute timer stops in the background before any owner status request', 'passed': bool(background and background['passed'])})
        trace['passed'] = trace['passed'] and bool(background and background['passed'])
        trace['behavior_evidence'].append({'description': 'Actual internal server state before any status request, then matching HTTP state after >=60 real seconds with the controlling Chrome process closed', 'path': str(attempt / '真实后台定时验收.json')})
    if number == 5 and not probe and not supplemental:
        regression_folder = attempt / '完整回归'
        regression = subprocess.run([sys.executable, 'verify_v2.py'], cwd=project / 'app', capture_output=True, text=True,
                                    env={**os.environ, 'XIHA_QA_OUTPUT': str(regression_folder)}, timeout=180)
        regression_log = {'passed': regression.returncode == 0, 'exit_code': regression.returncode,
                          'stdout': regression.stdout, 'stderr': regression.stderr}
        (attempt / '完整回归命令.json').write_text(json.dumps(regression_log, ensure_ascii=False, indent=2) + '\n')
        trace['checks'].append({'id': 'r5-complete-original-regression', 'description': 'Full original HTTP/privacy/upload/publication/matching/48-layout/knowledge regression adapted to explicit save and server confirmation', 'passed': regression.returncode == 0})
        trace['passed'] = trace['passed'] and regression.returncode == 0
        trace['behavior_evidence'].append({'description': 'Actual command output of the full original regression suite', 'path': str(attempt / '完整回归命令.json')})
        for artifact in sorted(regression_folder.rglob('*')):
            if artifact.is_file() and artifact.suffix in {'.json', '.png'}:
                trace['behavior_evidence'].append({'description': 'Actual full regression artifact: ' + artifact.name, 'path': str(artifact)})
    after = runtime_manifest(project)
    stable = before == after
    trace['checks'].append({'id': f'r{number}-source-stable', 'description': 'Runtime source unchanged during acceptance', 'passed': stable})
    trace['passed'] = trace['passed'] and result.returncode == 0 and stable
    if probe:
        trace['probe'] = probe
        trace['scope'] = '前置缺陷复现；不能作为第五轮完成验收。'
        trace['passed'] = False
    trace['source_sha256'] = after
    trace['behavior_evidence'].append({'description': 'Actual assertions, measured positions, source based candidate descriptions and export details',
                                       'path': str(attempt / '浏览器行为.json')})
    target = output / '验收.json'
    target.write_text(json.dumps(trace, ensure_ascii=False, indent=2) + '\n')
    (attempt / '验收.json').write_text(json.dumps(trace, ensure_ascii=False, indent=2) + '\n')
    if supplemental and trace['passed']:
        aggregate_round_five(project, trace, target)
    print(json.dumps({'round': number, 'passed': trace['passed'], 'evidence': str(target)}, ensure_ascii=False))
    return 0 if probe or trace['passed'] else 1


def aggregate_round_five(project, supplemental, supplemental_path):
    """Combine proved current-source stages, retaining the failed test attempt."""
    original_path = project / 'app' / 'verification' / 'iterations' / 'round-5' / '验收.json'
    original = json.loads(original_path.read_text())
    current = runtime_manifest(project)
    if original.get('source_sha256') != current or supplemental.get('source_sha256') != current:
        raise RuntimeError('运行源码变化，不能沿用已完成阶段的证据，必须重新完整验收。')
    if original.get('round') != 5 or supplemental.get('round') != 5 or original.get('probe') or supplemental.get('probe'):
        raise RuntimeError('只有第五轮正式验收与补测可以组合，不能使用前置复现。')
    if supplemental.get('passed') is not True or supplemental.get('errors'):
        raise RuntimeError('补测仍有失败，不能组合为完成。')
    # The original full run stopped at one known test precondition mistake.
    # Do not discard unrelated exceptions or browser errors in an aggregate.
    old_errors = original.get('errors', [])
    if original.get('passed') is not False or len(old_errors) != 1 or old_errors[0].get('stage') != 'R5 searchable library keeps material domains separate' or not all(word in old_errors[0].get('message', '') for word in ('#library-search', 'disabled', 'locator.fill')):
        raise RuntimeError('原完整验收不是已核实的传统域测试前置错误，不能覆盖其失败。')
    required = {'r1-mobile-main-path', 'r1-folded-exclusions', 'r1-direct-and-keyboard', 'r1-candidate-explanations',
                'r1-single-reference-export', 'r1-browser-errors', 'r2-text-changes-real-candidates',
                'r2-ambiguity-and-conflict-boundaries', 'r2-preview-before-apply', 'r2-ui-current-and-text-resolution',
                'r2-stale-success-feedback-cleared', 'r2-proposal-invalidated-by-edits',
                'r2-browser-errors',
                'r3-refresh-restores-only-input', 'r3-save-deduplicates-download-does-not-save',
                'r3-save-failure-keeps-export', 'r3-view-saved-card-does-not-adopt',
                'r3-saved-card-continues-editing', 'r3-account-boundary-clears-storage',
                'r3-malformed-draft-no-partial-injection', 'r3-mobile-primary-action-preserved', 'r3-browser-errors',
                'r4-confirm-scope-and-strict-timer', 'r4-concurrent-edit-cas',
                'r4-dirty-form-survives-delayed-refresh', 'r4-publication-cas-and-permissions',
                'r4-real-ui-countdown-auto-stop', 'r4-browser-errors', 'r4-real-background-auto-stop',
                'r5-module-tests', 'r5-complete-original-regression', 'r5-source-stable'}
    proved = {check['id'] for check in original.get('checks', []) if check.get('passed') is True}
    if not required <= proved:
        raise RuntimeError('原阶段缺少必要的通过证据，不能组合为完成。')
    new_required = {'r5-library-search-family-and-domain', 'r5-negation-unknown-compact',
                    'r5-lock-save-signature-both-directions', 'r5-cross-tab-user-binding', 'r5-source-stable'}
    new_proved = {check['id'] for check in supplemental.get('checks', []) if check.get('passed') is True}
    if not new_required <= new_proved:
        raise RuntimeError('第五轮新行为未全部通过，不能组合为完成。')
    if any(check.get('passed') is not True or not check.get('id') for check in original['checks'] + supplemental['checks']):
        raise RuntimeError('仍有失败检查，不能组合为完成。')
    for evidence in (original, supplemental):
        identifiers = [check['id'] for check in evidence['checks']]
        if len(identifiers) != len(set(identifiers)):
            raise RuntimeError('同一验收有重复检查名称，不能组合为完成。')
    trace_artifact = next(item['path'] for item in original['behavior_evidence'] if item['path'].endswith('浏览器行为.json'))
    original_attempt = Path(trace_artifact).parent / '验收.json'
    supplemental_trace = next(item['path'] for item in supplemental['behavior_evidence'] if item['path'].endswith('浏览器行为.json'))
    supplemental_attempt = Path(supplemental_trace).parent / '验收.json'
    if json.loads(original_attempt.read_text()) != original or json.loads(supplemental_attempt.read_text()) != supplemental or json.loads(supplemental_path.read_text()) != supplemental:
        raise RuntimeError('汇总文件与各次独立验收不一致，不能组合为完成。')
    started_epoch = json.loads((project / 'app' / 'verification' / 'iterations' / 'round-05' / 'start.json').read_text())['started_epoch']
    artifact_hashes = {}
    for item in original['behavior_evidence'] + supplemental['behavior_evidence']:
        artifact = Path(item['path'])
        if not artifact.is_absolute() or artifact.is_symlink() or not artifact.is_file() or '.local' in artifact.parts or not artifact.resolve().is_relative_to(original_path.parent.resolve()) or artifact.stat().st_mtime + 0.01 < started_epoch:
            raise RuntimeError('组合证据不存在、越界或早于本轮开始，不能组合为完成。')
        artifact_hashes[str(artifact)] = sha256(artifact)
    failed_supplements = sorted(path for path in (original_path.parent / 'supplement').glob('attempt-*/验收.json') if json.loads(path.read_text()).get('passed') is False)
    acceptance_paths = [original_attempt, supplemental_attempt, *failed_supplements]
    final = {**supplemental, 'passed': True,
             'checks': original['checks'] + [check for check in supplemental['checks'] if check['id'] not in proved],
             'behavior_evidence': original['behavior_evidence'] + supplemental['behavior_evidence'],
             'source_sha256': current, 'errors': [],
             'combined_current_source_evidence': [str(original_attempt), str(supplemental_attempt)],
             'combined_artifact_sha256': artifact_hashes,
             'combined_acceptance_sha256': {str(path): sha256(path) for path in acceptance_paths},
             'retained_failed_attempts': [str(original_attempt), *map(str, failed_supplements)],
             'corrected_test_assumption': '原完整脚本向传统域按设计禁用/隐藏的搜索框填值；首份补测把合法省略的解锁字段误当成必须 null。两次失败记录保留，失败尝试不计为通过。补测确认传统材料不能进入现代构图、解锁字段省略并实际恢复未锁复选框。根据现行前端去重契约，返回已保存签名应无重复请求；双向锁变化在各自新签名上实测 HTTP 201。'}
    if runtime_manifest(project) != current:
        raise RuntimeError('组合审计期间运行源码变化，不能沿用验收。')
    original_path.write_text(json.dumps(final, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'aggregate_round': 5, 'passed': True, 'checks': len(final['checks']), 'evidence': str(original_path)}, ensure_ascii=False))


class IsolatedHTTPClient:
    """A cookie-bound temporary client; credentials and cookies are never output."""
    def __init__(self, base):
        self.base = base
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.csrf = None
        self.session_status, _ = self.call('GET', '/api/session')

    def browser_cookies(self):
        return [{'name': cookie.name, 'value': cookie.value, 'domain': cookie.domain,
                 'path': cookie.path, 'secure': cookie.secure, 'httpOnly': cookie.has_nonstandard_attr('HttpOnly'),
                 'sameSite': 'Strict'} for cookie in self.jar]

    def call(self, method, endpoint, body=None):
        headers = {'Origin': self.base}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers['Content-Type'] = 'application/json'
        if self.csrf:
            headers['X-CSRF-Token'] = self.csrf
        request = urllib.request.Request(self.base + endpoint, data=data, headers=headers, method=method)
        try:
            response = self.opener.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        value = json.loads(response.read())
        if value.get('csrf_token'):
            self.csrf = value['csrf_token']
        return response.code, value


if __name__ == '__main__':
    if len(sys.argv) == 2 and sys.argv[1] == '--round5-supplement':
        raise SystemExit(run_browser_round(5, supplemental=True))
    if len(sys.argv) == 2 and sys.argv[1] == '--probe-cross-tab':
        raise SystemExit(run_browser_round(5, probe='cross-tab'))
    if len(sys.argv) == 3 and sys.argv[1] == '--round':
        number = int(sys.argv[2])
        if number not in (1, 2, 3, 4, 5):
            raise SystemExit('此轮的独立行为验收尚未实现，不能用旧轮测试代替。')
        raise SystemExit(run_browser_round(number))
    unittest.main(verbosity=2)
