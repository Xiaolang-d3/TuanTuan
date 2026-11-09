"""Fixed runtime entrypoint: render one host-validated slide with pinned fonts."""
from __future__ import annotations

import os
import sys
from pathlib import Path


def main():
    import resvg_py
    from PIL import Image
    from io import BytesIO

    if len(sys.argv) != 4:
        raise SystemExit("Expected slide, output and bundled font")
    source, output, font = (Path(arg) for arg in sys.argv[1:])
    if source.stat().st_size > 1000000:
        raise ValueError("Slide too large")
    png = resvg_py.svg_to_bytes(
        # resvg resolves href against resources_dir (not svg_path). Authoring
        # uses ../images relative to svg_output, so the source directory is the
        # base; the project root would silently drop every supplied image.
        svg_path=str(source), resources_dir=str(source.parent),
        skip_system_fonts=True, font_files=[str(font)],
        font_family="Noto Sans CJK SC", sans_serif_family="Noto Sans CJK SC",
        width=1280, height=720,
    )
    with Image.open(BytesIO(png)) as image:
        if image.size != (1280, 720) or image.format != "PNG":
            raise ValueError("Invalid preview dimensions")
        image.verify()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".part")
    with temporary.open("wb") as stream:
        stream.write(png)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(output)


if __name__ == "__main__":
    main()
