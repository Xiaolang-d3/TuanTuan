#!/bin/sh
# Install backend dependencies only from hash-locked files (see
# docs/model-layer.md), then scan the venv for startup-executing files.
#
#   install_deps.sh [VENV] [runtime|dev|build]
#
#   runtime  requirements-lock.txt                        (start-remote.sh, production)
#   dev      requirements-dev-lock.txt (runtime + tests)   (dev.sh, CI tests)
#   build    runtime + requirements-build-lock.txt         (desktop sidecar build)
#
# When the selected locks or the mode change, the venv is recreated (--clear)
# and every package is installed with --force-reinstall: pip skips packages
# already installed at the pinned version *without* checking their hashes, and
# a venv used in another mode would keep packages the new mode must not have.
# The .pth scan runs on every call, because anything may have written into the
# venv since the last install. TUANTUAN_BASE_PYTHON picks the interpreter the
# venv is created from (default python3).
set -eu
BACKEND_DIR=$(cd "$(dirname "$0")/.." && pwd)
VENV="${1:-$BACKEND_DIR/.venv}"
MODE="${2:-runtime}"
case "$MODE" in
  runtime) LOCKS="requirements-lock.txt" ;;
  dev) LOCKS="requirements-dev-lock.txt" ;;
  build) LOCKS="requirements-lock.txt requirements-build-lock.txt" ;;
  *) echo "usage: $0 [VENV] [runtime|dev|build]" >&2; exit 2 ;;
esac
STAMP="$VENV/.requirements-lock.sha256"

SUM=$(cd "$BACKEND_DIR" && { echo "$MODE"; cat $LOCKS; } | { shasum -a 256 2>/dev/null || sha256sum; } | cut -d ' ' -f 1)
if [ ! -x "$VENV/bin/python" ] || [ "$(cat "$STAMP" 2>/dev/null || true)" != "$SUM" ]; then
  rm -f "$STAMP"
  "${TUANTUAN_BASE_PYTHON-${CAREERLOOP_BASE_PYTHON:-python3}}" -m venv --clear "$VENV"
  for LOCK in $LOCKS; do
    env -u PYTHONPATH -u VIRTUAL_ENV -u PYTHONHOME "$VENV/bin/python" -m pip install -q --disable-pip-version-check \
      --require-hashes --no-deps --only-binary :all: --force-reinstall -r "$BACKEND_DIR/$LOCK"
  done
  # ensurepip adds an unpinned setuptools on Python <= 3.11; keep only locked packages (+ pip).
  if ! (cd "$BACKEND_DIR" && cat $LOCKS) | grep -q '^setuptools=='; then
    "$VENV/bin/python" -m pip uninstall -q -y setuptools >/dev/null 2>&1 || true
  fi
  INSTALLED=1
fi
# Scan before anything starts this venv normally: -I -S processes no .pth.
if ! "$VENV/bin/python" -I -S "$BACKEND_DIR/scripts/scan_pth.py" --python "$VENV/bin/python" >/dev/null; then
  rm -f "$STAMP"
  echo "Unexpected startup code in $VENV; do not use it. Remove the venv and investigate." >&2
  exit 1
fi
if [ "${INSTALLED:-0}" = 1 ]; then
  echo "$SUM" > "$STAMP"
fi
