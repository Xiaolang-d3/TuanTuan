#!/usr/bin/env python3
"""GitHub builds verified release bundles; a Mac pulls and activates them.

No credentials or working-tree resets are needed. Installing the launch agents
is a separate, explicit one-time operation; creating a skill does not install them.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import ProxyHandler, build_opener, urlopen


REPOSITORY = "Xiaolang-d3/TuanTuan"
APP_LABEL = "online.xiaocheng.tuantuan.web"
POLL_LABEL = "online.xiaocheng.tuantuan.deploy"
MAX_ARCHIVE_BYTES = 300 * 1024**2
MAX_EXTRACTED_BYTES = 1024**3
REVISION = re.compile(r"[0-9a-f]{40}")
LOCAL_HTTP = build_opener(ProxyHandler({}))
PUBLIC_FILES = ("tuantuan-logo.png", "tuantuan-favicon.png")
DATABASE_READY_CODE = """
from app.workspace import auth_db_path, existing_workspace_roots, workspace_db_path
from app.database_lifecycle import database_status
from app.db import DB_PATH
import sqlite3
path = auth_db_path()
if not path.is_file():
    raise SystemExit(1)
with sqlite3.connect(path) as connection:
    connection.execute('SELECT id FROM users LIMIT 1').fetchall()
paths = [workspace_db_path(root) for root in existing_workspace_roots()]
if DB_PATH.is_file() and DB_PATH != path:
    paths.append(DB_PATH)
raise SystemExit(0 if all(database_status(p)['status'] == 'ready' for p in paths) else 1)
"""


def read_json(path: Path, default=None):
    return json.loads(path.read_text()) if path.is_file() else default


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)


def clean_environment() -> dict[str, str]:
    # Do not pass GitHub, model or search credentials to dependency installers.
    keep = ("HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SSL_CERT_FILE", "SYSTEMROOT", "WINDIR")
    return {key: os.environ[key] for key in keep if key in os.environ}


def run(args, **kwargs):
    env = kwargs.pop("env", None)
    return subprocess.run([str(a) for a in args], check=True,
                          env=env if env is not None else clean_environment(), **kwargs)


def latest_revision() -> str:
    result = run(["git", "ls-remote", f"https://github.com/{REPOSITORY}.git", "refs/heads/main"],
                 capture_output=True, text=True, timeout=40)
    revision = result.stdout.split()[0]
    if not REVISION.fullmatch(revision):
        raise RuntimeError("GitHub main did not return a valid commit")
    return revision


def bundle(source: Path, output: Path, revision: str) -> None:
    if not REVISION.fullmatch(revision):
        raise ValueError("A full commit SHA is required")
    output.mkdir(parents=True, exist_ok=True)
    archive = output / "app.tar.gz"
    includes = ["backend/app", "backend/scripts", "backend/requirements-lock.txt", "frontend/dist"]
    with tarfile.open(archive, "w:gz") as tar:
        for name in includes:
            path = source / name
            if not path.exists():
                raise RuntimeError(f"Missing release input: {name}")
            for file in ([path] if path.is_file() else sorted(path.rglob("*"))):
                if file.is_symlink():
                    raise RuntimeError("Release inputs must not contain symlinks")
                relative = file.relative_to(source)
                if not file.is_file() or "__pycache__" in relative.parts or file.suffix == ".pyc":
                    continue
                if file.name.startswith(".env") or file.suffix in {".db", ".sqlite", ".sqlite3"}:
                    raise RuntimeError("Runtime secrets/data must not enter a release")
                tar.add(file, arcname=str(relative), recursive=False)
    write_json(output / "release.json", {
        "format": 1, "repository": REPOSITORY, "revision": revision,
        "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "bytes": archive.stat().st_size,
    })


def download(url: str, destination: Path, limit: int) -> None:
    with urlopen(url, timeout=45) as response, destination.open("wb") as output:
        total = 0
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > limit:
                raise RuntimeError("Release download exceeds the configured limit")
            output.write(chunk)


def extract_bundle(archive: Path, destination: Path) -> None:
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        if len(members) > 50_000 or sum(m.size for m in members) > MAX_EXTRACTED_BYTES:
            raise RuntimeError("Release archive is too large")
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or not path.parts:
                raise RuntimeError("Unsafe release path")
            allowed = path.parts[:2] in {("backend", "app"), ("backend", "scripts"), ("frontend", "dist")}
            if not allowed and str(path) != "backend/requirements-lock.txt":
                raise RuntimeError("Unexpected release file")
            if not member.isfile():
                raise RuntimeError("Only ordinary files may appear in a release")
            target = destination.joinpath(*path.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.is_symlink() or any(p.is_symlink() for p in target.parents if p != destination.parent):
                raise RuntimeError("Symlink in release destination")
            stream = tar.extractfile(member)
            if stream is None:
                raise RuntimeError("Missing archive member")
            with stream, target.open("wb") as output:
                shutil.copyfileobj(stream, output)
            target.chmod(0o644)


def runtime_environment(root: Path, config: dict, revision: str, *, smoke_data: Path | None = None):
    env = clean_environment()
    env.update({
        "BIND_HOST": "127.0.0.1", "API_DOCS_ENABLED": "false", "TUANTUAN_DESKTOP": "false",
        "TUANTUAN_DATA_DIR": str(smoke_data or config["data_dir"]),
        "TUANTUAN_INSTANCE_ID": revision, "OPENAI_API_KEY": "", "TAVILY_API_KEY": "",
        "AGENT_SEARCH_TOKEN": "", "MINIO_ACCESS_KEY": "", "MINIO_SECRET_KEY": "",
        "WEB_RESEARCH_ENABLED": "false", "ATTACHMENT_STORAGE": "local",
        "EMBEDDING_BACKEND": "hash" if smoke_data else "auto",
        "PYTHON_DOTENV_DISABLED": "1", "PYTHONUNBUFFERED": "1",
    })
    # User-provided credentials remain in their existing per-workspace keyring.
    # No operator .env or global model credential is imported into a release.
    env["TUANTUAN_SECRET_BACKEND"] = "memory" if smoke_data else "keyring"
    if not smoke_data:
        env["TUANTUAN_MAINTENANCE_FILE"] = str(root / "maintenance")
        env["TUANTUAN_BENCHMARK_ENV_FILE"] = str(root / "service.env")
    return env


def healthy(port: int, revision: str) -> bool:
    try:
        with LOCAL_HTTP.open(f"http://127.0.0.1:{port}/health", timeout=2) as response:
            body = json.load(response)
        return body.get("status") == "ok" and body.get("instance_id") == revision
    except (OSError, ValueError):
        return False


def wait_healthy(port: int, revision: str) -> None:
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if healthy(port, revision):
            return
        time.sleep(1)
    raise RuntimeError("Application health check failed")


def smoke(release: Path, root: Path, config: dict, revision: str) -> None:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="tuantuan-smoke-") as data:
        env = runtime_environment(root, config, revision, smoke_data=Path(data))
        with (root / "logs" / "smoke.log").open("ab") as log:
            process = subprocess.Popen(
                [str(release / "backend/.venv/bin/python"), "-m", "uvicorn", "app.main:app",
                 "--host", "127.0.0.1", "--port", str(port), "--workers", "1", "--no-proxy-headers"],
                cwd=release / "backend", env=env, stdout=log, stderr=log)
            try:
                wait_healthy(port, revision)
                for path in ("/", "/auth/config", *(f"/{name}" for name in PUBLIC_FILES)):
                    with LOCAL_HTTP.open(f"http://127.0.0.1:{port}{path}", timeout=5) as response:
                        if response.status != 200:
                            raise RuntimeError("Public page/asset smoke check failed")
                try:
                    LOCAL_HTTP.open(f"http://127.0.0.1:{port}/library", timeout=5)
                except HTTPError as error:
                    if error.code != 401:
                        raise RuntimeError("Business API auth check failed") from error
                else:
                    raise RuntimeError("Business API is unexpectedly public")
            finally:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


def prepare(root: Path, config: dict, revision: str) -> Path | None:
    release = root / "releases" / revision
    if (release / ".prepared").is_file():
        return release
    base = f"https://github.com/{REPOSITORY}/releases/download/deploy-{revision}"
    with tempfile.TemporaryDirectory(dir=root, prefix="download-") as directory:
        stage = Path(directory)
        try:
            download(f"{base}/release.json", stage / "release.json", 32_768)
        except HTTPError as error:
            if error.code == 404:  # CI/CD has not published this main commit yet.
                return None
            raise
        manifest = read_json(stage / "release.json")
        if (manifest.get("format"), manifest.get("repository"), manifest.get("revision")) != (1, REPOSITORY, revision):
            raise RuntimeError("Release manifest does not match the requested commit")
        download(f"{base}/app.tar.gz", stage / "app.tar.gz", MAX_ARCHIVE_BYTES)
        digest = hashlib.sha256((stage / "app.tar.gz").read_bytes()).hexdigest()
        if digest != manifest.get("sha256") or (stage / "app.tar.gz").stat().st_size != manifest.get("bytes"):
            raise RuntimeError("Release integrity check failed")
        release.mkdir(parents=True, exist_ok=True)
        extract_bundle(stage / "app.tar.gz", release)
    env = clean_environment()
    env["TUANTUAN_BASE_PYTHON"] = config["python"]
    # The repo installer creates the venv at its final path and scans .pth files.
    with (root / "logs" / "prepare.log").open("ab") as log:
        subprocess.run(["/bin/sh", str(release / "backend/scripts/install_deps.sh"),
                        str(release / "backend/.venv"), "runtime"], check=True, env=env,
                       stdout=log, stderr=log, timeout=1200)
    smoke(release, root, config, revision)
    (release / ".prepared").touch()
    return release


def service(root: Path, action: str) -> None:
    domain = f"gui/{os.getuid()}"
    plist = root / "web.plist"
    if action == "start":
        run(["launchctl", "bootstrap", domain, str(plist)], stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=60)
        return
    # Existing installations retain the label recorded in their own plist.
    label = plistlib.loads(plist.read_bytes())["Label"] if plist.is_file() else APP_LABEL
    target = f"{domain}/{label}"
    state = subprocess.run(["launchctl", "print", target], capture_output=True, text=True,
                           env=clean_environment(), timeout=10)
    if state.returncode:
        return  # No registered job can restart a candidate during recovery.
    match = re.search(r"^\s*pid = (\d+)\s*$", state.stdout, re.MULTILINE)
    pid = int(match.group(1)) if match else None
    run(["launchctl", "bootout", target], stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, timeout=90)
    if pid:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.5)
        raise RuntimeError("Managed application has not exited; data recovery paused")


def port_open(port: int) -> bool:
    with socket.socket() as connection:
        return connection.connect_ex(("127.0.0.1", port)) == 0


def stopped(port: int) -> None:
    deadline = time.monotonic() + 30
    while port_open(port) and time.monotonic() < deadline:
        time.sleep(0.5)
    if port_open(port):
        raise RuntimeError("Application did not stop; data was not copied")


def finish_activation(root: Path, transaction: dict) -> None:
    write_json(root / "last-success.json", {
        "revision": transaction["candidate"], "backup": transaction["backup"], "time": int(time.time()),
    })
    (root / "maintenance").unlink(missing_ok=True)
    (root / "transaction.json").unlink(missing_ok=True)


def recover(root: Path, config: dict) -> None:
    transaction = read_json(root / "transaction.json")
    if not transaction:
        return
    maintenance = root / "maintenance"
    previous = transaction["previous"]
    port = config["port"]
    if transaction["phase"] == "verified":
        if not maintenance.exists() or healthy(port, transaction["candidate"]):
            # Once the gate has opened, never restore an older data snapshot.
            finish_activation(root, transaction)
            return
    if not maintenance.exists():
        if transaction["backup"]:
            raise RuntimeError("Interrupted deployment may have accepted writes; manual recovery required")
        maintenance.touch()
    if transaction["backup"]:
        if port_open(port):
            identities = [transaction["candidate"]] + ([previous["revision"]] if previous else [])
            if not any(healthy(port, identity) for identity in identities):
                raise RuntimeError("Unknown service owns the deployment port; recovery paused")
        # A launchd candidate may be migrating or restarting before binding its
        # port. Always unload its exact job before touching the data directory.
        service(root, "stop")
        stopped(port)
        data = Path(config["data_dir"])
        failed = Path(transaction["failed_data"])
        if not failed.exists():
            if data.exists():
                data.rename(failed)
        if not data.exists():
            # Copy first, then atomically put the restored tree in place. An
            # interrupted copy never becomes the application's data directory.
            with tempfile.TemporaryDirectory(dir=data.parent, prefix="restore-") as temporary:
                restored = Path(temporary) / "data"
                shutil.copytree(transaction["backup"], restored)
                restored.rename(data)
    if previous:
        write_json(root / "current.json", previous)
        if not healthy(port, previous["revision"]):
            try:
                service(root, "start")
            except subprocess.CalledProcessError:
                pass  # launchd may still own a job that is restarting.
            wait_healthy(port, previous["revision"])
    else:
        (root / "current.json").unlink(missing_ok=True)
    maintenance.unlink(missing_ok=True)
    (root / "transaction.json").unlink(missing_ok=True)


def activate(root: Path, config: dict, revision: str) -> None:
    previous = read_json(root / "current.json")
    port = config["port"]
    if port_open(port) and (not previous or not healthy(port, previous["revision"])):
        raise RuntimeError("Port belongs to an unmanaged service; stop/migrate it explicitly first")
    if shutil.disk_usage(root).free < 15 * 1024**3:
        raise RuntimeError("Less than 15 GiB free; release activation paused")
    data = Path(config["data_dir"])
    data.mkdir(parents=True, exist_ok=True)
    if data.stat().st_dev != root.stat().st_dev:
        raise RuntimeError("Data and deployment root must be on the same volume for atomic recovery")
    backup = root / "backups" / f"{time.time_ns()}-{revision}"
    transaction = {"previous": previous, "candidate": revision, "backup": None,
                   "failed_data": str(root / "backups" / f"failed-{time.time_ns()}"), "phase": "stopping"}
    write_json(root / "transaction.json", transaction)
    maintenance = root / "maintenance"
    maintenance.touch()
    try:
        if previous:
            service(root, "stop")
        stopped(port)
        shutil.copytree(data, backup)
        transaction.update(backup=str(backup), phase="backed-up")
        write_json(root / "transaction.json", transaction)
        write_json(root / "current.json", {"revision": revision})
        service(root, "start")
        wait_healthy(port, revision)
        release = root / "releases" / revision
        # /health is liveness. Check DB readiness separately before admitting writes.
        run([release / "backend/.venv/bin/python", "-c", DATABASE_READY_CODE],
            cwd=release / "backend", env=runtime_environment(root, config, revision), timeout=30)
    except Exception:
        recover(root, config)
        raise
    transaction["phase"] = "verified"
    write_json(root / "transaction.json", transaction)
    finish_activation(root, transaction)


@contextmanager
def deploy_lock(root: Path):
    import fcntl
    with (root / "deploy.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
        else:
            try:
                yield True
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)


def once(root: Path, *, retry: bool = False) -> None:
    config = read_json(root / "config.json")
    if not config or not config.get("enabled"):
        return
    with deploy_lock(root) as acquired:
        if not acquired:
            return
        # A crashed activation must be recovered even if current.json already
        # names main or GitHub is temporarily unreachable.
        recover(root, config)
        revision = latest_revision()
        current = read_json(root / "current.json", {})
        failed = read_json(root / "last-failure.json", {})
        if current.get("revision") == revision:
            if not healthy(config["port"], revision) or (root / "maintenance").exists():
                raise RuntimeError("Current release needs service recovery")
            return
        if failed.get("revision") == revision and not retry:
            return
        try:
            if prepare(root, config, revision) is None:
                return
            # An older CI run must not overwrite a newer main deployment.
            if latest_revision() != revision:
                return
            activate(root, config, revision)
        except Exception as error:
            write_json(root / "last-failure.json", {"revision": revision, "error": type(error).__name__, "time": int(time.time())})
            raise
        print(f"Deployed {revision} to https://xiaocheng.online")


def configure(root: Path, data: Path, python: Path, port: int) -> None:
    if sys.platform != "darwin":
        raise RuntimeError("This service installer targets macOS launchd")
    if (root / "config.json").exists():
        raise RuntimeError("Existing deployment config is preserved; inspect it instead of overwriting")
    if not 1024 <= port <= 65535:
        raise ValueError("Choose an unprivileged port")
    if data == root or root in data.parents and data.parts[len(root.parts)] in {"releases", "backups"}:
        raise ValueError("Data must be separate from releases and backups")
    if data in root.parents:
        raise ValueError("Deployment root cannot be inside the data directory")
    for name in ("logs", "releases", "backups"):
        (root / name).mkdir(parents=True, exist_ok=True, mode=0o700)
    manager = root / "manager.py"
    shutil.copyfile(Path(__file__).resolve(), manager)
    manager.chmod(0o700)
    write_json(root / "config.json", {"enabled": False, "data_dir": str(data), "python": str(python), "port": port})
    for label, args, interval, name in (
        (APP_LABEL, ["serve", "--root", str(root)], None, "web"),
        (POLL_LABEL, ["once", "--root", str(root)], 60, "deploy"),
    ):
        plist = {"Label": label, "ProgramArguments": [str(python), str(manager), *args],
                 "StandardOutPath": str(root / "logs" / f"{name}.log"),
                 "StandardErrorPath": str(root / "logs" / f"{name}.log"),
                 "EnvironmentVariables": {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}}
        if interval:
            plist.update(StartInterval=interval, RunAtLoad=True)
        else:
            plist.update(KeepAlive=True, RunAtLoad=True)
        (root / f"{name}.plist").write_bytes(plistlib.dumps(plist))
    print(f"Prepared disabled deployment config and launchd plists in {root}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    pack = commands.add_parser("bundle")
    pack.add_argument("--source", type=Path, default=Path.cwd())
    pack.add_argument("--output", type=Path, required=True)
    pack.add_argument("--revision", required=True)
    for name in ("configure", "once", "serve", "status"):
        command = commands.add_parser(name)
        command.add_argument("--root", type=Path, required=True)
        if name == "configure":
            command.add_argument("--data-dir", type=Path, required=True)
            command.add_argument("--python", type=Path, required=True)
            command.add_argument("--port", type=int, default=8000)
        if name == "once":
            command.add_argument("--retry", action="store_true")
    args = parser.parse_args()
    if args.command == "bundle":
        bundle(args.source.resolve(), args.output.resolve(), args.revision)
        return
    root = args.root.expanduser().resolve()
    if args.command == "configure":
        configure(root, args.data_dir.expanduser().resolve(), args.python.expanduser().resolve(), args.port)
    elif args.command == "once":
        once(root, retry=args.retry)
    elif args.command == "status":
        print(json.dumps({name: read_json(root / f"{name}.json") for name in
                          ("config", "current", "last-success", "last-failure")}, ensure_ascii=False, indent=2))
    elif args.command == "serve":
        config = read_json(root / "config.json")
        revision = read_json(root / "current.json")["revision"]
        release = root / "releases" / revision
        python = release / "backend/.venv/bin/python"
        os.chdir(release / "backend")
        os.execve(python, [str(python), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
                          "--port", str(config["port"]), "--workers", "1", "--no-proxy-headers"],
                  runtime_environment(root, config, revision))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Exceptions may carry upstream strings; keep unattended logs terse.
        print(f"Deployment stopped: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)
