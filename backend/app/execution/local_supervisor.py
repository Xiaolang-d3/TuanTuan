"""Fixed helper: wait for a parent-owned pipe before starting trusted argv.

Not an API/tool. Only LocalBuiltinHandle may dispatch a manifest-checked command.
"""
import json
import os
import signal
import subprocess
import sys
import threading


def main():
    # A parent that fails before committing identity cannot leave a runnable child.
    timeout = threading.Timer(10, lambda: os._exit(124))
    timeout.daemon = True
    timeout.start()
    line = sys.stdin.buffer.readline(131_073)
    if not line or len(line) > 131_072:
        return 124
    payload = json.loads(line)
    timeout.cancel()
    if not isinstance(payload.get("argv"), list) or not payload.get("nonce"):
        return 125

    def parent_closed():
        sys.stdin.buffer.read()
        if os.name != "nt":
            os.killpg(os.getpgrp(), signal.SIGKILL)
        os._exit(125)

    watcher = threading.Thread(target=parent_closed, daemon=True)
    watcher.start()
    child = subprocess.Popen(payload["argv"], stdin=subprocess.DEVNULL)
    # The watcher deliberately holds a blocking stdin read. Avoid interpreter
    # finalization trying to acquire its buffered lock after a successful child.
    os._exit(child.wait())


if __name__ == "__main__":
    raise SystemExit(main())
