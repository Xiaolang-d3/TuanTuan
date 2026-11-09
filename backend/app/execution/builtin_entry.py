"""Compatibility launcher for the unmodified official sibling imports under -I."""
import runpy
import sys
from pathlib import Path


def main():
    script = Path(sys.argv[1]).resolve(strict=True)
    skill = Path(__file__).resolve().parent.parent / "vendor/ppt-master"
    scripts = (skill / "scripts").resolve()
    # The confirmation service is the sole nested entrypoint. Do not enable
    # arbitrary nested vendor scripts (or task-relative import directories).
    if script.parent != scripts and script != scripts / "confirm_ui/server.py":
        raise SystemExit("Only scripts from the fixed built-in skill may run.")
    # -I deliberately removes the script directory. Several official entrypoints
    # import console_encoding before adding it themselves; restore this one known
    # directory without enabling the task cwd, PYTHONPATH, or user-site packages.
    sys.path.insert(0, str(script.parent))
    sys.argv = [str(script), *sys.argv[2:]]
    runpy.run_path(str(script), run_name="__main__")


if __name__ == "__main__":
    main()
