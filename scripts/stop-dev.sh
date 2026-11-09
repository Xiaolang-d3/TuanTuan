#!/usr/bin/env bash
set -euo pipefail

for port in 5173 8000; do
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN || true)"
  if [ -n "$pids" ]; then
    kill $pids
    echo "Stopped service on port $port"
    sleep 1
  else
    echo "No service listening on port $port"
  fi
done

for session in tuantuan-frontend tuantuan-backend; do
  if screen -ls | grep -q "$session"; then
    screen -S "$session" -X quit
    echo "Stopped screen session $session"
  fi
done
