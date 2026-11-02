#!/usr/bin/env bash
set -euo pipefail

for session in tuantuan-remote tuantuan-remote-backend; do
  # screen prepends a numeric PID (e.g. 1234.tuantuan-remote), so let
  # screen resolve the suffix instead of parsing its CRLF-formatted listing.
  if screen -S "$session" -X quit 2>/dev/null; then
    echo "已停止 $session"
  else
    echo "$session 未运行"
  fi
done

# A screen child can outlive its screen controller on macOS. Only target the
# exact local origin used by this project's remote mode; never kill other tunnels.
pkill -f "cloudflared tunnel --url http://127.0.0.1:8000" 2>/dev/null || true

for port in 8000 5173; do
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN || true)"
  if [ -n "$pids" ]; then
    kill $pids
    echo "已停止端口 $port 上的服务"
  fi
done
