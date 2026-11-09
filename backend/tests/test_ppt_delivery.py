from io import BytesIO
import zipfile

import pytest

from app.presentations.validation import validate_delivery

P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"


def fixture(tmp_path, *, text="中文标题", picture=False, target="slides/slide1.xml", extra=None):
    source = tmp_path / "svg_output/slide_01.svg"
    source.parent.mkdir(exist_ok=True)
    source.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720"/><text x="80" y="100">中文标题</text></svg>', encoding="utf-8")
    shape = '<p:pic/>' if picture else f'<p:sp><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>'
    parts = {
        "[Content_Types].xml": f'<Types xmlns="{CT}"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
        "ppt/presentation.xml": f'<p:presentation xmlns:p="{P}" xmlns:r="{R}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
        "ppt/_rels/presentation.xml.rels": f'<Relationships xmlns="{REL}"><Relationship Id="rId1" Type="{R}/slide" Target="{target}"/></Relationships>',
        "ppt/slides/slide1.xml": f'<p:sld xmlns:p="{P}" xmlns:a="{A}"><p:cSld><p:spTree>{shape}</p:spTree></p:cSld></p:sld>',
    }
    parts.update(extra or {})
    out = tmp_path / "exports/result.pptx"
    out.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as package:
        for name, content in parts.items():
            package.writestr(name, content)
    return out


def test_editable_chinese_delivery_matches_svg_sources(tmp_path):
    report = validate_delivery(tmp_path, fixture(tmp_path))
    assert report["slides"] == 1
    assert report["native_shapes"] == 1
    assert report["native_text_nodes"] == 1
    assert report["sha256"]


@pytest.mark.parametrize("text,picture", [("", True), ("missing source text", False)])
def test_no_slide_screenshot_or_missing_text_substitution(tmp_path, text, picture):
    with pytest.raises(ValueError, match="原生|文字"):
        validate_delivery(tmp_path, fixture(tmp_path, text=text, picture=picture))


@pytest.mark.parametrize("extra", [
    {"../outside.xml": "x"},
    {"ppt/vbaProject.bin": "x"},
    {"ppt/slides/_rels/slide1.xml.rels": f'<Relationships xmlns="{REL}"><Relationship Id="image" Type="{R}/image" TargetMode="External" Target="https://example.com/a.png"/></Relationships>'},
    {"ppt/slides/slide2.xml": f'<p:sld xmlns:p="{P}"/>'},
    {"ppt/unused.xml": '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///secret">]><x>&e;</x>'},
])
def test_unsafe_or_unaccounted_package_parts_rejected(tmp_path, extra):
    with pytest.raises(ValueError):
        validate_delivery(tmp_path, fixture(tmp_path, extra=extra))


def test_office_printer_settings_binary_is_not_mistaken_for_a_macro(tmp_path):
    report = validate_delivery(tmp_path, fixture(tmp_path, extra={"ppt/printerSettings/printerSettings1.bin": b"printer settings"}))
    assert report["slides"] == 1


def test_slide_relationship_cannot_escape_package(tmp_path):
    with pytest.raises(ValueError):
        validate_delivery(tmp_path, fixture(tmp_path, target="../../outside.xml"))


def test_corrupt_zip_and_page_count_mismatch_rejected(tmp_path):
    out = fixture(tmp_path)
    second = tmp_path / "svg_output/slide_02.svg"
    second.write_bytes((tmp_path / "svg_output/slide_01.svg").read_bytes())
    with pytest.raises(ValueError, match="页数"):
        validate_delivery(tmp_path, out)
    out.write_bytes(b"not a zip")
    with pytest.raises(ValueError, match="PPTX"):
        validate_delivery(tmp_path, out)


def test_expansion_budget_is_checked_before_reading_package_parts(tmp_path, monkeypatch):
    from app.presentations import validation
    out = fixture(tmp_path, extra={"ppt/large.xml": "<x>" + " " * 10_000 + "</x>"})
    monkeypatch.setattr(validation, "MAX_PACKAGE_EXPANDED_BYTES", 1000)
    with pytest.raises(ValueError, match="展开"):
        validate_delivery(tmp_path, out)


def test_duplicate_zip_names_rejected(tmp_path):
    out = fixture(tmp_path)
    with pytest.warns(UserWarning), zipfile.ZipFile(out, "a") as package:
        package.writestr("ppt/slides/slide1.xml", "overwritten")
    with pytest.raises(ValueError, match="重复"):
        validate_delivery(tmp_path, out)
