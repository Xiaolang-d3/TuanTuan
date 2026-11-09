"""Opt-in, offline integration against unmodified pinned official PPT tools.

No model calls or confirmation files are made: these are authored test documents,
not authorization evidence for GenerateProduction.
"""
import json
import os
import subprocess
from pathlib import Path

from test_ppt_runtime_preview import installed_runtime


def author_fixture(project):
    from PIL import Image

    (project / "images").mkdir(exist_ok=True)
    Image.new("RGB", (100, 100), (247, 37, 86)).save(project / "images/asset.png")
    spec = """<!-- ppt-master-schema: design-spec/v1 -->
# 离线制作验证 - Design Spec
## I. Project Information
| Item | Value |
| --- | --- |
| Project Name | 离线制作验证 |
| Canvas Format | PPT 16:9 1280 × 720 |
| Page Count | 2 |
| Primary Language | zh-CN |
| Target Audience | 开发验收人员 |
| Communication Intent | 验证离线制作 |
| Desired Audience Outcome | 看见完整交付 |
| Core Message / Ask / Action | 中文文字与图片可正确交付 |
| Delivery Context | 本地测试 |
| Artifact Afterlife | 测试证据 |
| Reading Mode | balanced |
| Content Strategy | 仅使用测试数据 |
| Design Style | 简明 |
| AI Image Acquisition Path | not applicable |
| Generation Mode | continuous |
| Spec Refinement | disabled |
| Speaker Notes | enabled — test fixture |
| Custom Animations | disabled — test fixture |
| Narration Audio | disabled — test fixture |
| Created Date | 2026-11-03 |
## II. Canvas Specification
| Property | Value |
| --- | --- |
| Format | PPT 16:9 |
| Dimensions | 1280 × 720 |
| viewBox | `0 0 1280 720` |
| Margins | 60 |
| Content Area | 60 60 1160 600 |
## III. Visual Theme
### Theme Style
- **Mode**: custom
- **Mode Behavior**: 一页一个结论，清楚显示测试证据。
- **Visual style**: custom
- **Visual Style Behavior**: 浅色背景与深色中文文字。
- **Theme**: 离线验证
- **Tone**: 明确
### Color Scheme
| Role | HEX | Purpose |
| --- | --- | --- |
| Background | #FFFFFF | 背景 |
| Secondary background | #F4F6F8 | 内容区 |
| Primary | #15324F | 标题 |
| Accent | #F72556 | 重点 |
| Secondary accent | #208070 | 辅助 |
| Body text | #15324F | 正文 |
| Secondary text | #667788 | 注释 |
| Divider | #CCDDEE | 分隔 |
## IV. Typography System
### Font Plan
| Role | Character (Reference) | Primary | English if non-English | Fallback tail |
| --- | --- | --- | --- | --- |
| Title | sans | Noto Sans CJK SC | Noto Sans CJK SC | sans-serif |
| Body | sans | Noto Sans CJK SC | Noto Sans CJK SC | sans-serif |
- **Title stack**: Noto Sans CJK SC
- **Body stack**: Noto Sans CJK SC
### Font Size Hierarchy
| Purpose | Anchor Size (px) |
| --- | ---: |
| Body | 24 |
| Title | 40 |
| Subtitle | 30 |
| Annotation | 16 |
## V. Layout Principles
### Deck-wide Direction
- **Hierarchy direction**: 先标题，后正文。
- **Composition tendency**: 左对齐。
- **Cross-page continuity**: 固定页边距。
- **Spacing posture**: open
- **Spacing anchors**: 60, 24, 40, 0, 36
## VI. Icon Usage Specification
- **Primary bundled library**: none
| Icon Path | Suitable Scenarios |
| --- | --- |
## VIII. Image Resource List
| Filename | Dimensions | Ratio | Purpose | Type | Image pattern | Crop Policy | Acquire Via | Status | Reference | text_policy | page_role |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| asset.png | 100 × 100 | 1:1 | 图片路径验证 | Image | 单图 | no-crop | user | Existing | 测试生成 | none | evidence |
## IX. Content Outline
#### Slide 01 - 中文文字
- **Audience move**: 从未验证到看见中文文字。
- **Relationships**: 标题概括正文。
- **Title**: 离线制作验证
- **Core message**: 中文保持原生可编辑文字。
- **Content**: 中文文字可编辑，PPTX 与 SVG 同步。
#### Slide 02 - 图片路径
- **Audience move**: 从未验证到看见项目图片。
- **Relationships**: 图片与说明对应。
- **Title**: 图片路径验证
- **Core message**: 图片使用项目内相对路径。
- **Content**: 图片与中文说明正确显示。
- **Images**: asset.png 提供图片引用证据。
## X. Speaker Notes Requirements
- **Generation**: enabled
- **Filename**: match each SVG filename under notes/
- **Content**: 仅解释测试页面，不引用外部事实。
- **Total duration**: 1 minute
- **Notes style**: conversational
- **Presentation purpose**: 验证离线制作
"""
    lock = """<!-- ppt-master-schema: spec-lock/v1 -->
# Execution Lock
## canvas
- viewBox: 0 0 1280 720
- format: ppt169
## communication
- primary_language: zh-CN
- audience: 开发验收人员
- objective: 验证离线制作，让验收人员看见完整交付。
- core_message: 中文文字与图片可正确交付。
## mode
- mode: custom
- mode_behavior: 一页一个结论，清楚显示测试证据。
## visual_style
- visual_style: custom
- visual_style_behavior: 浅色背景与深色中文文字。
## colors
- background: #FFFFFF
- secondary_background: #F4F6F8
- primary: #15324F
- accent: #F72556
- secondary_accent: #208070
- body_text: #15324F
- secondary_text: #667788
- divider: #CCDDEE
## typography
- font_family: Noto Sans CJK SC
- title_family: Noto Sans CJK SC
- body_family: Noto Sans CJK SC
- body: 24
- title: 40
- subtitle: 30
- annotation: 16
## icons
- library: none
- inventory: none
## page_rhythm
- P01: anchor
- P02: breathing
## pptx_structure
- mode: flat
## images
- asset: images/asset.png | source=user | crop=no-crop
## forbidden
- `mask`, `<style>`, `class`, external CSS, `<foreignObject>`, `textPath`, `@font-face`, `<animate*>`, `<set>`, `<script>` / event attributes, `<iframe>`
- HTML named entities in text; write typography as raw Unicode and escape XML reserved characters
"""
    (project / "design_spec.md").write_text(spec, encoding="utf-8")
    (project / "spec_lock.md").write_text(lock, encoding="utf-8")
    (project / "svg_output").mkdir(exist_ok=True)
    for number, title, body in [(1, "离线制作验证", "中文文字可编辑，PPTX 与 SVG 同步。"),
                                (2, "图片路径验证", "图片与中文说明正确显示。")]:
        picture = '<image id="evidence-image" href="../images/asset.png" x="850" y="240" width="200" height="200"/>' if number == 2 else ""
        svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" data-pptx-page-role="content">
<rect id="background" data-pptx-role="background" width="1280" height="720" fill="#FFFFFF"/>
<g id="page-content" data-pptx-bounds="60 60 1100 500">
<text id="heading" x="60" y="110" font-family="Noto Sans CJK SC" font-size="40" fill="#15324F">{title}</text>
<text id="body" x="60" y="210" font-family="Noto Sans CJK SC" font-size="24" fill="#15324F">{body}</text>
{picture}</g></svg>'''
        (project / f"svg_output/P{number:02d}.svg").write_text(svg, encoding="utf-8")
    (project / "notes").mkdir(exist_ok=True)
    (project / "notes/total.md").write_text("# Slide 1\n\n第一张测试中文原生文字。\n\n---\n\n# Slide 2\n\n第二张测试相对路径图片。", encoding="utf-8")


def test_official_offline_export_preview_and_host_delivery(installed_runtime, tmp_path):
    from app.presentations.validation import validate_delivery, validate_svg
    from PIL import Image

    task = Path(os.environ.get("PPT_SMOKE_OUTPUT", str(tmp_path)))
    task.mkdir(parents=True, exist_ok=True)
    project_name = "offline_smoke_ppt169_20261103"
    project = task / project_name
    logs = []

    def run(command, **args):
        argv = installed_runtime.command(command, {"project": project_name, **args}, task)
        result = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", timeout=300)
        logs.append({"command": command, "returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr})
        (task / "official-tool-results.json").write_text(json.dumps(logs, ensure_ascii=False, indent=2), encoding="utf-8")
        assert result.returncode == 0, f"{command}: {result.stdout}\n{result.stderr}"

    run("init")
    author_fixture(project)
    run("validate_project")
    for source in sorted((project / "svg_output").glob("*.svg")):
        validate_svg(source, project)
    run("calibrate")
    run("quality_check", stage="final")
    run("split_notes")
    run("finalize")
    run("export", notes=True)
    run("delivery_check")
    report = validate_delivery(project, project / "exports/result.pptx")
    assert report["slides"] == 2
    assert report["native_text_nodes"] >= 4
    for number in (1, 2):
        run("render_preview", slide=f"P{number:02d}")
    with Image.open(project / "previews/P02.png") as preview:
        assert preview.size == (1280, 720)
        assert preview.convert("RGB").getpixel((950, 340)) == (247, 37, 86)
    (task / "host-delivery-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
