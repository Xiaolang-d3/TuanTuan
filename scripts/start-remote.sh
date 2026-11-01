#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_LOG_DIR="$BACKEND_DIR/logs"
LOG_DIR="$ROOT_DIR/logs"
REMOTE_LOG="$LOG_DIR/cloudflared.log"

mkdir -p "$BACKEND_LOG_DIR" "$LOG_DIR"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared 未安装。请先执行：brew install cloudflared" >&2
  exit 1
fi

if lsof -tiTCP:8000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "8000 端口已被占用；先执行 ./scripts/stop-dev.sh 或 ./scripts/stop-remote.sh。" >&2
  exit 1
fi

if screen -ls 2>/dev/null | grep -q "tuantuan-remote"; then
  echo "远程服务已经运行。公开 URL："
  grep -Eo 'https://[-a-z0-9]+\.trycloudflare\.com' "$REMOTE_LOG" | tail -n 1 || true
  exit 0
fi

# The SPA and API use one origin in production. Keep the origin server private:
# only cloudflared can reach this loopback port, and Cloudflare terminates HTTPS.
echo "构建前端…"
(
  cd "$FRONTEND_DIR"
  npm run build >/dev/null
)

# Runtime dependencies only (no pytest/PyInstaller), from the hash-locked file.
"$BACKEND_DIR/scripts/install_deps.sh" "$BACKEND_DIR/.venv" runtime

: > "$BACKEND_LOG_DIR/remote-backend.log"
: > "$REMOTE_LOG"
screen -dmS tuantuan-remote-backend zsh -lc \
  "cd '$BACKEND_DIR' && BIND_HOST=127.0.0.1 API_DOCS_ENABLED=false env -u PYTHONPATH -u VIRTUAL_ENV -u PYTHONHOME .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 > '$BACKEND_LOG_DIR/remote-backend.log' 2>&1"

for _ in {1..20}; do
  if curl -fsS --max-time 1 http://127.0.0.1:8000/health >/dev/null; then
    break
  fi
  sleep 1
done
if ! curl -fsS --max-time 2 http://127.0.0.1:8000/health >/dev/null; then
  screen -S tuantuan-remote-backend -X quit || true
  echo "后端没有成功启动；查看 $BACKEND_LOG_DIR/remote-backend.log" >&2
  exit 1
fi

screen -dmS tuantuan-remote zsh -lc \
  "cloudflared tunnel --url http://127.0.0.1:8000 > '$REMOTE_LOG' 2>&1"

for _ in {1..30}; do
  URL="$(grep -Eo 'https://[-a-z0-9]+\.trycloudflare\.com' "$REMOTE_LOG" | tail -n 1 || true)"
  if [ -n "$URL" ]; then
    echo
    echo "远程 HTTPS 地址（任何网络均可访问）："
    echo "$URL"
    echo
    echo "注意：这是临时 Quick Tunnel；重启后 URL 会改变。Mac 必须保持开机且服务持续运行。"
    exit 0
  fi
  sleep 1
done

screen -S tuantuan-remote -X quit || true
screen -S tuantuan-remote-backend -X quit || true
echo "Cloudflare Tunnel 未能取得公开 URL；查看 $REMOTE_LOG" >&2
exit 1
