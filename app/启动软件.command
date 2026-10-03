#!/bin/zsh
set -e
task_app_dir="$(cd "$(dirname "$0")" && pwd)"
task_repo_dir="$(dirname "$task_app_dir")"
task_python="${XIHAK_PYTHON:-python3}"
if [[ -x "$task_repo_dir/.venv/bin/python" ]]; then
  task_python="$task_repo_dir/.venv/bin/python"
fi
exec "$task_python" "$task_app_dir/server.py" --port 8870
