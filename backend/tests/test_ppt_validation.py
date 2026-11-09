from pathlib import Path

import pytest

from app.presentations.validation import validate_svg


SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">{}</svg>'


def write_svg(root, body):
    path = root / "svg_output/slide_01.svg"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(SVG.format(body), encoding="utf-8")
    return path


def test_valid_chinese_svg_remains_native_source(tmp_path):
    path = write_svg(tmp_path, '<rect width="1280" height="720" fill="#fff"/><text x="80" y="100" font-family="Noto Sans CJK SC" font-size="32">中文标题</text>')
    report = validate_svg(path, tmp_path)
    assert report["native_text_nodes"] == 1
    assert report["sha256"]


@pytest.mark.parametrize("body", [
    '<script>alert(1)</script>', '<foreignObject/>', '<text onclick="x()">x</text>',
    '<image href="https://example.com/a.png"/>', '<image href="file:///C:/secret.png"/>',
    '<image href="../../outside.png"/>', '<image href="data:image/svg+xml;base64,AAAA"/>',
    '<style>@import url(https://example.com/a.css);</style>',
    '<rect style="fill:url(https://example.com/a.svg#x)"/>',
    '<rect fill="url(//example.com/a.svg#x)"/>', '<rect style="fill:u\\72l(https://x)"/>',
    '<use href="http://example.com/shape.svg#x"/>', '<animate attributeName="x"/>',
    '<x:rect xmlns:x="https://example.com"/>',
])
def test_invalid_svg_and_external_resources_rejected(tmp_path, body):
    with pytest.raises(ValueError):
        validate_svg(write_svg(tmp_path, body), tmp_path)


def test_dtd_and_entities_rejected_before_xml_parse(tmp_path):
    path = write_svg(tmp_path, "")
    path.write_text('<!DOCTYPE svg [<!ENTITY content SYSTEM "file:///secret">]>' + SVG.format('<text>&content;</text>'), encoding="utf-8")
    with pytest.raises(ValueError, match="DTD"):
        validate_svg(path, tmp_path)


def test_authorized_image_is_validated_as_raster(tmp_path):
    from PIL import Image
    (tmp_path / "images").mkdir()
    Image.new("RGB", (8, 8), "white").save(tmp_path / "images/photo.png")
    report = validate_svg(write_svg(tmp_path, '<image href="../images/photo.png" width="100" height="100"/>'), tmp_path)
    assert report["image_count"] == 1
    (tmp_path / "images/photo.png").write_bytes(b"not an image")
    with pytest.raises(ValueError, match="图片"):
        validate_svg(write_svg(tmp_path, '<image href="../images/photo.png"/>'), tmp_path)


def test_fragment_paints_allowed_but_missing_references_rejected(tmp_path):
    validate_svg(write_svg(tmp_path, '<defs><linearGradient id="paint"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect fill="url(#paint)"/>'), tmp_path)
    with pytest.raises(ValueError, match="引用"):
        validate_svg(write_svg(tmp_path, '<rect fill="url(#missing)"/>'), tmp_path)


def test_deeply_nested_svg_rejected(tmp_path):
    with pytest.raises(ValueError, match="嵌套"):
        validate_svg(write_svg(tmp_path, '<g>' * 65 + '<text>x</text>' + '</g>' * 65), tmp_path)


@pytest.mark.parametrize("body", [
    '<g id="loop"><use href="#loop"/></g>',
    '<defs><g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g></defs>',
    '<image href="#paint"/><rect id="paint"/>',
    '<image href="../images/a.png" xmlns:xml="http://www.w3.org/XML/1998/namespace" xml:base="https://example.com/"/>',
    '<rect id="duplicate"/><rect id="duplicate"/>',
    '<image href="../images/a.png" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="../images/b.png"/>',
    '<use href="&#x68;ttps://example.com/a.svg"/>',
    '<image href="../images/a.png:stream"/>',
    '<image href="../images/%2e%2e/a.png"/>',
])
def test_obfuscated_or_recursive_references_are_rejected(tmp_path, body):
    with pytest.raises(ValueError):
        validate_svg(write_svg(tmp_path, body), tmp_path)


@pytest.mark.parametrize("change", [
    lambda data: data.encode("utf-16"),
    lambda data: ('<?xml-stylesheet href="https://example.com/a.css"?>' + data).encode(),
    lambda data: data.replace('width="1280"', 'width="100"').encode(),
    lambda data: data.replace('0 0 1280 720', '0 0 NaN 720').encode(),
])
def test_svg_encoding_processing_instructions_and_canvas_are_checked(tmp_path, change):
    path = write_svg(tmp_path, "")
    path.write_bytes(change(SVG.format("")))
    with pytest.raises(ValueError):
        validate_svg(path, tmp_path)


def test_reference_expansion_is_bounded(tmp_path):
    body = '<defs><g id="s0"><rect/></g>'
    for index in range(1, 35):
        body += f'<g id="s{index}"><use href="#s{index - 1}"/><use href="#s{index - 1}"/></g>'
    body += '</defs><use href="#s34"/>'
    with pytest.raises(ValueError, match="引用"):
        validate_svg(write_svg(tmp_path, body), tmp_path)


def test_repeated_large_subtree_expansion_is_bounded(tmp_path):
    body = '<defs><g id="large">' + '<rect/>' * 500 + '</g></defs>'
    body += '<use href="#large"/>' * 50
    with pytest.raises(ValueError, match="引用"):
        validate_svg(write_svg(tmp_path, body), tmp_path)


def test_raster_decode_and_pixel_limits(tmp_path, monkeypatch):
    from io import BytesIO
    from PIL import Image
    from app.presentations import validation

    image = BytesIO()
    Image.new("RGB", (8, 8), "white").save(image, "PNG")
    monkeypatch.setattr(validation, "MAX_IMAGE_PIXELS", 16)
    with pytest.raises(ValueError, match="图片"):
        validation.validate_raster(image.getvalue())


def test_image_directory_junction_cannot_escape_project(tmp_path, monkeypatch):
    from app.presentations import validation

    path = write_svg(tmp_path, '<image href="../images/photo.png"/>')
    image_dir = tmp_path / "images"
    image_dir.mkdir()
    original = Path.is_symlink
    monkeypatch.setattr(Path, "is_symlink", lambda self: self == image_dir or original(self))
    with pytest.raises(ValueError, match="链接"):
        validation.validate_svg(path, tmp_path)


def test_svg_size_limit_and_regular_file_required(tmp_path):
    path = write_svg(tmp_path, " " * 1_000_001)
    with pytest.raises(ValueError, match="大小"):
        validate_svg(path, tmp_path)
    with pytest.raises(ValueError, match="普通文件"):
        validate_svg(path.parent, tmp_path)
