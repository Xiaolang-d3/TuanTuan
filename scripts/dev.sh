#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_LOG_DIR="$BACKEND_DIR/logs"
FRONTEND_LOG_DIR="$FRONTEND_DIR/logs"

mkdir -p "$BACKEND_LOG_DIR" "$FRONTEND_LOG_DIR"

# Read only the two networking keys from backend/.env. Sourcing the whole file
# breaks on non-ASCII comments, so grep the exact assignments instead.
env_value() {
  [ -f "$BACKEND_DIR/.env" ] || return 0
  LC_ALL=C grep -a -E "^[[:space:]]*$1[[:space:]]*=" "$BACKEND_DIR/.env" \
    | tail -n 1 \
    | cut -d= -f2- \
    | tr -d "\"' \r"
}

BIND_HOST="${BIND_HOST:-$(env_value BIND_HOST)}"
BIND_HOST="${BIND_HOST:-127.0.0.1}"
PUBLIC_HOSTS="${PUBLIC_HOSTS:-$(env_value PUBLIC_HOSTS)}"
export BIND_HOST PUBLIC_HOSTS

case "$BIND_HOST" in
  127.0.0.1|localhost|::1) EXPOSED=0 ;;
  *) EXPOSED=1 ;;
esac

if [ "$EXPOSED" = "1" ]; then
  echo "警告：BIND_HOST=${BIND_HOST}，服务将对本机以外的设备开放。"
  echo "      请确认已设置强密码，并且只在受信任的网络中使用。"
  if [ -z "$PUBLIC_HOSTS" ]; then
    echo "      未设置 PUBLIC_HOSTS，其它设备通过主机名访问前端会被 Vite 拒绝。"
  fi
fi

if lsof -tiTCP:8000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Backend already listening on port 8000"
else
  # Runtime + test dependencies, all from the hash-locked dev lock.
  "$BACKEND_DIR/scripts/install_deps.sh" "$BACKEND_DIR/.venv" dev
  # env -u clears any inherited PYTHONPATH/VIRTUAL_ENV that would shadow .venv.
  screen -dmS tuantuan-backend zsh -lc \
    "cd '$BACKEND_DIR' && env -u PYTHONPATH -u VIRTUAL_ENV -u PYTHONHOME .venv/bin/uvicorn app.main:app --host '$BIND_HOST' --port 8000 > '$BACKEND_LOG_DIR/backend.log' 2>&1"
  echo "Started backend at http://$BIND_HOST:8000"
fi

if lsof -tiTCP:5173 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Frontend already listening on port 5173"
else
  if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    npm --prefix "$FRONTEND_DIR" install
  fi
  screen -dmS tuantuan-frontend zsh -lc \
    "cd '$FRONTEND_DIR' && BIND_HOST='$BIND_HOST' PUBLIC_HOSTS='$PUBLIC_HOSTS' npm run dev > '$FRONTEND_LOG_DIR/frontend.log' 2>&1"
  echo "Started frontend at http://$BIND_HOST:5173"
fi

if [ "$EXPOSED" = "1" ]; then
  echo "团团 is reachable from other devices on this network."
else
  echo "团团 is listening on this machine only."
fi
