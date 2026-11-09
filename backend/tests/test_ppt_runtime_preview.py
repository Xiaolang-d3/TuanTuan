"""Real renderer regression tests using the optional pinned offline bundle."""
import os
import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def installed_runtime():
    from app.execution.builtin_runtime import BuiltinRuntime

    configured = os.environ.get("PPT_TEST_RUNTIME")
    if not configured:
        pytest.skip("Set PPT_TEST_RUNTIME to the pinned offline PPT runtime")
    runtime = BuiltinRuntime.load(Path(configured))
    runtime.verify()
    return runtime


def test_preview_renders_project_relative_image(installed_runtime, tmp_path):
    from PIL import Image

    project = tmp_path / "deck"
    (project / "svg_output").mkdir(parents=True)
    (project / "images").mkdir()
    Image.new("RGB", (30, 30), (247, 37, 86)).save(project / "images/asset.png")
    (project / "svg_output/P01.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">'
        '<rect width="1280" height="720" fill="#FFFFFF"/>'
        '<image href="../images/asset.png" x="100" y="100" width="100" height="100"/>'
        '</svg>', encoding="utf-8",
    )
    # Use the current host entrypoint with the pinned offline interpreter and
    # dependencies, so this detects renderer changes before rebuilding bundles.
    renderer = Path(__file__).parents[1] / "app/execution/render_preview.py"
    argv = [str(installed_runtime.path(installed_runtime.manifest["python"])), "-I", "-B", str(renderer),
            str(project / "svg_output/P01.svg"), str(project / "previews/P01.png"),
            str(installed_runtime.path(installed_runtime.manifest["font"]))]
    subprocess.run(argv, check=True, capture_output=True, timeout=300)
    with Image.open(project / "previews/P01.png") as preview:
        assert preview.size == (1280, 720)
        assert preview.convert("RGB").getpixel((150, 150)) == (247, 37, 86)
