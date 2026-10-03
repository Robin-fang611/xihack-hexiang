"""Five real development rounds with immutable, source-bound acceptance receipts.

This is a checkpoint controller, not an agent scheduler. A developer must make
each change, run that round's behavior checks, review the result, and then call
complete. Existing business data and credentials are never included.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import time


ROOT = Path(__file__).resolve().parent.parent
ROUNDS = 5
FORBIDDEN_PARTS = {'.local', '__pycache__', 'verification', '.git'}
TOOL_PREFIXES = ('test_', 'qa_', 'verify_')


class CycleError(ValueError):
    pass


def stamp():
    return datetime.now(timezone.utc).isoformat()


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def runtime_manifest(project_root=ROOT):
    """Hash runnable product sources, excluding tests and generated/private data."""
    project_root = Path(project_root).resolve()
    app = project_root / 'app'
    files = []
    if app.exists():
        for directory, subdirectories, names in os.walk(app, followlinks=False):
            subdirectories[:] = [name for name in subdirectories if name not in FORBIDDEN_PARTS]
            for name in names:
                path = Path(directory) / name
                relative = path.relative_to(app)
                if relative.parts[0] == 'static':
                    relevant = path.suffix.lower() in {'.js', '.css', '.html', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2', '.ttf'}
                elif path.name == 'iteration_cycle.py' or path.name.startswith(TOOL_PREFIXES):
                    relevant = False
                else:
                    relevant = path.suffix in {'.py', '.json', '.swift'}
                if not relevant:
                    continue
                if path.is_symlink():
                    raise CycleError(f'运行源码不能使用符号链接：{relative}')
                if path.is_file():
                    files.append(path)
    for name in ('数字调香.py', '知识条目.json', '复合调香规则.json'):
        path = project_root / '知识库' / name
        if path.is_symlink():
            raise CycleError(f'知识源码不能使用符号链接：{name}')
        if path.is_file():
            files.append(path)
    result = {str(path.relative_to(project_root)): sha256(path) for path in sorted(files)}
    if not result:
        raise CycleError('未找到运行源码，不能开始或验收迭代。')
    return result


def tooling_manifest(project_root=ROOT):
    project_root = Path(project_root).resolve()
    result = {}
    for folder in (project_root / 'app', project_root / '知识库'):
        if not folder.is_dir():
            continue
        for path in folder.iterdir():
            if path.is_file() and not path.is_symlink() and path.suffix in {'.py', '.cjs'}:
                if path.name.startswith(TOOL_PREFIXES) or path.name == 'iteration_cycle.py' or path.name.startswith(('核验', '验证')):
                    result[str(path.relative_to(project_root))] = sha256(path)
    return dict(sorted(result.items()))


def source_delta(before, after):
    return [{'path': name, 'before': before.get(name), 'after': after.get(name),
             'kind': 'added' if name not in before else 'removed' if name not in after else 'changed'}
            for name in sorted(set(before) | set(after)) if before.get(name) != after.get(name)]


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.checkpoint-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError) as error:
        raise CycleError(f'收据不可读：{path.name}（{error}）') from error


def safe_evidence_path(path):
    original = Path(path).absolute()
    resolved = original.resolve()
    if any(part in {'.local', '.git'} for part in original.parts + resolved.parts):
        raise CycleError('不能读取正式私有目录或 Git 内部文件作为验收证据。')
    if any(marker in resolved.name.lower() for marker in ('credential', 'password', '账号', '凭据')):
        raise CycleError('凭据文件不能作为验收证据。')
    if not resolved.is_file():
        raise CycleError(f'行为证据不存在：{resolved.name}')
    return resolved


def context_usage(session_file):
    """Read only the last token_count event from one explicitly chosen session."""
    path = Path(session_file).expanduser()
    unknown = {'status': 'unknown', 'percent': None, 'observed_at': None,
               'handoff_required': None, 'threshold_percent': 50}
    if not path.is_file():
        return {**unknown, 'reason': '指定的会话日志不存在或不是文件。'}
    latest = None
    try:
        with path.open() as handle:
            for line in handle:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                payload = entry.get('payload', {})
                if isinstance(payload, dict) and payload.get('type') == 'token_count':
                    latest = {'info': payload.get('info'), 'timestamp': entry.get('timestamp')}
    except (OSError, UnicodeError):
        return {**unknown, 'reason': '指定会话日志不可读。'}
    if latest is None:
        return {**unknown, 'reason': '指定会话日志没有 token_count 事件。'}
    info = latest['info'] if isinstance(latest['info'], dict) else {}
    usage = info.get('last_token_usage') or {}
    used = usage.get('total_tokens') if isinstance(usage, dict) else None
    capacity = info.get('model_context_window')
    if not isinstance(used, (int, float)) or isinstance(used, bool) or used < 0 or not isinstance(capacity, (int, float)) or isinstance(capacity, bool) or capacity <= 0:
        return {**unknown, 'observed_at': latest['timestamp'],
                'reason': '最后一个 token_count 缺少有效的 last_token_usage 或 model_context_window。'}
    percent = used / capacity * 100
    return {'status': 'known', 'percent': round(percent, 2),
            'observed_at': latest['timestamp'], 'handoff_required': percent > 50,
            'threshold_percent': 50}


class IterationCycle:
    def __init__(self, project_root=ROOT):
        self.root = Path(project_root).resolve()
        self.output = self.root / 'app' / 'verification' / 'iterations'

    @contextmanager
    def locked(self):
        self.output.mkdir(parents=True, exist_ok=True)
        with (self.output / '.lock').open('a') as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            yield

    def folder(self, number):
        return self.output / f'round-{number:02d}'

    def verify_snapshot(self, number, snapshot_root, manifest):
        for name, digest in manifest.items():
            relative = Path(name)
            snapshot = snapshot_root / relative
            if relative.is_absolute() or '..' in relative.parts or any(part in FORBIDDEN_PARTS for part in relative.parts) or snapshot.is_symlink():
                raise CycleError('收据中的源码路径无效。')
            if not snapshot.is_file() or sha256(snapshot) != digest:
                raise CycleError(f'第 {number} 轮源码快照丢失或被改写。')

    def _state(self):
        # Receipts are authoritative; state.json is a recoverable convenience.
        completed, active = [], None
        gap = False
        for number in range(1, ROUNDS + 1):
            folder = self.folder(number)
            beginning = folder / 'start.json'
            ending = folder / 'completion' / 'receipt.json'
            if ending.exists() and not beginning.exists():
                raise CycleError(f'第 {number} 轮缺少开始收据。')
            if not beginning.exists():
                gap = True
                continue
            if gap or active is not None:
                raise CycleError('发现跳轮或并行轮次收据，停止推进。')
            start = read_json(beginning)
            if start.get('round') != number or not start.get('source_sha256'):
                raise CycleError(f'第 {number} 轮开始收据无效。')
            self.verify_snapshot(number, folder / 'source-before', start['source_sha256'])
            if start.get('tooling_snapshot'):
                self.verify_snapshot(number, folder / 'tooling-before', start.get('tooling_sha256', {}))
            if not ending.exists():
                active = number
                continue
            receipt = read_json(ending)
            if receipt.get('round') != number or receipt.get('passed') is not True or not receipt.get('source_delta'):
                raise CycleError(f'第 {number} 轮完成收据无效。')
            if source_delta(start['source_sha256'], receipt.get('source_sha256', {})) != receipt['source_delta']:
                raise CycleError(f'第 {number} 轮源码差异与收据不一致。')
            acceptance = folder / 'completion' / 'acceptance.json'
            if not acceptance.is_file() or sha256(acceptance) != receipt.get('acceptance_sha256'):
                raise CycleError(f'第 {number} 轮独立验收记录丢失或被改写。')
            verification = read_json(acceptance)
            if verification.get('passed') is not True or verification.get('round') != number or verification.get('source_sha256') != receipt['source_sha256']:
                raise CycleError(f'第 {number} 轮独立验收与完成收据不一致。')
            snapshots = [(folder / 'completion' / 'source-after', receipt['source_sha256'])]
            if receipt.get('tooling_snapshot'):
                snapshots.append((folder / 'completion' / 'tooling-after', receipt.get('tooling_sha256', {})))
            for snapshot_root, manifest in snapshots:
                self.verify_snapshot(number, snapshot_root, manifest)
            artifacts = receipt.get('artifacts', [])
            if not artifacts:
                raise CycleError(f'第 {number} 轮缺少行为证据。')
            for artifact in artifacts:
                relative = Path(artifact.get('path', ''))
                location = folder / 'completion' / relative
                if relative.is_absolute() or '..' in relative.parts or location.is_symlink():
                    raise CycleError('收据中的证据路径无效。')
                if not location.is_file() or sha256(location) != artifact.get('sha256'):
                    raise CycleError(f'第 {number} 轮行为证据丢失或被改写。')
            completed.append(number)
        state = {'total_rounds': ROUNDS, 'completed_rounds': completed,
                 'active_round': active, 'next_round': None if len(completed) == ROUNDS else len(completed) + 1,
                 'status': 'complete' if len(completed) == ROUNDS else 'running' if active else 'ready',
                 'scope': '仅本地开发迭代；不代替真实气味、设备、生产及人工业务验收'}
        atomic_json(self.output / 'state.json', state)
        return state

    def status(self):
        with self.locked():
            return self._state()

    def snapshot(self, target, manifest):
        for name, digest in manifest.items():
            source = self.root / name
            if sha256(source) != digest:
                raise CycleError('保存快照期间源码变化，请完成当前编辑后重试。')
            destination = target / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
            if sha256(destination) != digest:
                raise CycleError('源码快照校验失败。')

    def start(self, number, objective):
        with self.locked():
            state = self._state()
            if state['status'] == 'complete':
                raise CycleError('五轮已经全部完成，自循环已停止。')
            if state['active_round'] is not None:
                raise CycleError(f"第 {state['active_round']} 轮尚未完成，不能开启新轮。")
            if number != state['next_round']:
                raise CycleError(f"必须先开始第 {state['next_round']} 轮。")
            if not objective.strip():
                raise CycleError('每轮必须声明具体开发目标。')
            manifest = runtime_manifest(self.root)
            receipt = {'round': number, 'objective': objective.strip(), 'started_at': stamp(),
                       'started_epoch': time.time(), 'source_sha256': manifest,
                       'tooling_sha256': tooling_manifest(self.root), 'tooling_snapshot': True}
            staging = Path(tempfile.mkdtemp(prefix='.start-', dir=self.output))
            try:
                self.snapshot(staging / 'source-before', manifest)
                self.snapshot(staging / 'tooling-before', receipt['tooling_sha256'])
                if runtime_manifest(self.root) != manifest:
                    raise CycleError('保存快照期间源码变化，请完成当前编辑后重试。')
                atomic_json(staging / 'start.json', receipt)
                os.rename(staging, self.folder(number))
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
            return self._state()

    def complete(self, number, evidence_path, notes):
        with self.locked():
            state = self._state()
            if number in state['completed_rounds']:
                raise CycleError(f'第 {number} 轮已完成，不能重复计数。')
            if number != state['active_round']:
                raise CycleError('只能结束当前已开始的轮次。')
            if not notes.strip():
                raise CycleError('完成前必须记录评审结论和下一轮取舍。')
            start = read_json(self.folder(number) / 'start.json')
            source = runtime_manifest(self.root)
            delta = source_delta(start['source_sha256'], source)
            if not delta:
                raise CycleError('运行源码没有实际改动，重复跑旧测试不能算开发迭代。')
            evidence_path = safe_evidence_path(evidence_path)
            if any(part.startswith('probe-') for part in evidence_path.parts):
                raise CycleError('前置缺陷复现不是整轮验收，不能计数。')
            evidence = read_json(evidence_path)
            if evidence.get('probe'):
                raise CycleError('前置缺陷复现不是整轮验收，不能计数。')
            if evidence.get('round') != number or evidence.get('passed') is not True:
                raise CycleError('本轮独立验收未通过，失败不能计数。')
            checks = evidence.get('checks', [])
            if not checks or any(check.get('passed') is not True or not check.get('id') for check in checks):
                raise CycleError('每轮需要有名称且全部通过的行为检查。')
            if evidence.get('source_sha256') != source:
                raise CycleError('验收源码与当前源码不一致，请重新验收修改后的版本。')
            behavior = evidence.get('behavior_evidence', [])
            if not behavior:
                raise CycleError('本轮缺少实际行为证据。')
            staged = Path(tempfile.mkdtemp(prefix='.completion-', dir=self.output))
            try:
                artifacts = []
                for index, item in enumerate(behavior, 1):
                    if not item.get('description', '').strip():
                        raise CycleError('行为证据需要说明它证明的行为。')
                    location = Path(item.get('path', ''))
                    if not location.is_absolute():
                        location = evidence_path.parent / location
                    location = safe_evidence_path(location)
                    if location.stat().st_mtime + 0.01 < start['started_epoch']:
                        raise CycleError('行为证据早于本轮开始，不能重复使用旧产物。')
                    name = f'artifacts/{index:02d}-{location.name}'
                    destination = staged / name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(location, destination)
                    artifacts.append({'path': name, 'description': item['description'], 'sha256': sha256(destination)})
                # Preserve acceptance assertions and the exact product version.
                atomic_json(staged / 'acceptance.json', evidence)
                self.snapshot(staged / 'source-after', source)
                tooling = tooling_manifest(self.root)
                self.snapshot(staged / 'tooling-after', tooling)
                if runtime_manifest(self.root) != source:
                    raise CycleError('保存完成收据期间源码变化，请重新验收。')
                receipt = {'round': number, 'objective': start['objective'], 'passed': True,
                           'completed_at': stamp(), 'notes': notes.strip(), 'checks': checks,
                           'source_delta': delta, 'source_sha256': source,
                           'tooling_sha256': tooling, 'tooling_snapshot': True, 'artifacts': artifacts,
                           'acceptance_sha256': sha256(staged / 'acceptance.json')}
                atomic_json(staged / 'receipt.json', receipt)
                os.rename(staged, self.folder(number) / 'completion')
            finally:
                if staged.exists():
                    shutil.rmtree(staged)
            return self._state()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    beginning = commands.add_parser('start')
    beginning.add_argument('--round', type=int, required=True, choices=range(1, ROUNDS + 1))
    beginning.add_argument('--objective', required=True)
    ending = commands.add_parser('complete')
    ending.add_argument('--round', type=int, required=True, choices=range(1, ROUNDS + 1))
    ending.add_argument('--evidence', type=Path, required=True)
    ending.add_argument('--notes', required=True)
    commands.add_parser('status')
    context = commands.add_parser('context-usage')
    context.add_argument('--session-file', type=Path, required=True)
    args = parser.parse_args()
    controller = IterationCycle()
    try:
        result = (context_usage(args.session_file) if args.command == 'context-usage' else
                  controller.start(args.round, args.objective) if args.command == 'start' else
                  controller.complete(args.round, args.evidence, args.notes) if args.command == 'complete' else
                  controller.status())
    except CycleError as error:
        parser.exit(1, f'迭代检查点拒绝操作：{error}\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
