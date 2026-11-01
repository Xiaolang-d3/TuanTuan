"""Entrypoint packaged as the 团团 desktop sidecar.

It intentionally imports the FastAPI application only after setting data-path
environment variables: several modules derive SQLite paths during import.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def _startup_log(message: str) -> None:
    print(f"[tuantuan-desktop] {message}", file=sys.stderr, flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the 团团 desktop API")
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--instance-id", required=True)
    args = parser.parse_args()

    os.environ["TUANTUAN_DATA_DIR"] = args.data_dir
    os.environ["TUANTUAN_DESKTOP"] = "true"
    os.environ["TUANTUAN_INSTANCE_ID"] = args.instance_id
    os.environ["BIND_HOST"] = "127.0.0.1"
    os.environ["API_DOCS_ENABLED"] = "false"

    # Direct development execution starts from ``backend/app``.  The packaged
    # executable already exposes this path, but source execution needs it too.
    backend_dir = str(Path(__file__).resolve().parents[1])
    if backend_dir not in sys.path:
        sys.path.insert(0, backend_dir)

    _startup_log("loading server runtime")
    import uvicorn

    _startup_log("loading application")
    from app.main import app

    _startup_log(f"starting loopback server on port {args.port}")
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
