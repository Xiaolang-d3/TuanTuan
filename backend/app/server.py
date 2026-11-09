"""Uvicorn CLI with bounded draining for long-lived notification streams.

Run with ``python -m app.server app.main:app --reload``. All Uvicorn options
remain available, including --timeout-graceful-shutdown to override the default.
"""
import asyncio
import importlib

from uvicorn import Server
from uvicorn.main import main as uvicorn_main


class DrainingServer(Server):
    """Notify SSE producers before Uvicorn waits for their HTTP connections."""

    async def startup(self, sockets=None):
        self.lifespan.state["tuantuan_shutdown"] = asyncio.Event()
        await super().startup(sockets=sockets)

    async def shutdown(self, sockets=None):
        self.lifespan.state["tuantuan_shutdown"].set()
        await super().shutdown(sockets=sockets)


def main() -> None:
    # Uvicorn's CLI has no server-class option. Keep its argument handling and
    # reload supervisor, selecting our server only for this entry point.
    entrypoint = importlib.import_module("uvicorn.main")
    original = entrypoint.Server
    entrypoint.Server = DrainingServer
    try:
        uvicorn_main(default_map={"timeout_graceful_shutdown": 5})
    finally:
        entrypoint.Server = original


if __name__ == "__main__":
    main()
