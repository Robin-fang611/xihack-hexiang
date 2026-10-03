"""一次执行本轮回归。测试只使用临时账号和数据库，不更改 .local 业务资料。"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import server
from iteration_cycle import runtime_manifest, tooling_manifest


ROOT = Path(__file__).resolve().parent
OUTPUT = Path(os.environ.get('XIHA_QA_OUTPUT', str(ROOT / 'verification' / 'current')))
KNOWLEDGE = ROOT.parent / '知识库'


def run(label, command, *, cwd=ROOT, extra_env=None):
    started = time.monotonic()
    print(f'验证：{label}', flush=True)
    result = subprocess.run(command, cwd=cwd, env={**os.environ, **(extra_env or {})},
                            capture_output=True, text=True, timeout=240)
    if result.stdout:
        print(result.stdout.strip(), flush=True)
    if result.stderr:
        print(result.stderr.strip(), flush=True)
    return {'name': label, 'passed': result.returncode == 0,
            'seconds': round(time.monotonic() - started, 2), 'exit_code': result.returncode}


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    node = shutil.which('node')
    if not node:
        raise SystemExit('需要已有 Node.js 运行库，本脚本不会自动安装依赖。')
    checks = []
    checks.append(run('真实 HTTP 与静态隔离', [sys.executable, 'test_app.py'],
                      extra_env={'XIHA_QA_OUTPUT': str(OUTPUT)}))
    checks.append(run('数字调香 29 项', [sys.executable, '验证数字调香.py', '--no-write'], cwd=KNOWLEDGE))
    checks.append(run('知识边界与八个反例', [sys.executable, '核验知识库.py', '--self-test',
                      '--output', str(OUTPUT / '知识边界验收.json')], cwd=KNOWLEDGE))
    with tempfile.TemporaryDirectory(prefix='hexiang-v2-regression-') as folder:
        store = server.Store(Path(folder))
        http = server.AppServer(('127.0.0.1', 0), store)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        try:
            checks.append(run('浏览器、PNG、窄屏与隐私竞态', [node, 'qa_v2.cjs'],
                              extra_env={'XIHA_QA_BASE': f'http://127.0.0.1:{http.server_port}',
                                         'XIHA_QA_DATA_DIR': str(store.path),
                                         'XIHA_QA_OUTPUT': str(OUTPUT)}))
        finally:
            http.shutdown()
            http.server_close()
            thread.join(timeout=5)
    manifest = runtime_manifest(ROOT.parent)
    result = {'passed': all(check['passed'] for check in checks),
              'checked_at_utc': datetime.now(timezone.utc).isoformat(), 'checks': checks,
              'source_sha256': manifest,
              'tooling_sha256': tooling_manifest(ROOT.parent),
              'scope': '隔离本地软件回归；不证明实闻、制作、成交、实机、生产或人工业务验收'}
    (OUTPUT / '整体验收.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'passed': result['passed'], 'checks': checks, 'source_files': len(manifest)},
                     ensure_ascii=False, indent=2))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
