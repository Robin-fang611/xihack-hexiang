#!/bin/bash
# 启动西客松合香 · 双端口演示版（隔离演示数据，端口 8875）
cd "$(dirname "$0")"
if [ ! -f ".demo/app.sqlite3" ]; then
  python3 seed_demo.py || exit 1
fi
exec python3 server.py --port 8875 --data-dir .demo
