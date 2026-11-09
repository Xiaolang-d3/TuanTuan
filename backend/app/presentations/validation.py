"""Validate untrusted slide sources before passing them to trusted PPT tools.

Only a static SVG subset is accepted. This is an input gate, not an OS sandbox;
callers must retain the job lease and stop writers before validating/exporting.
"""
from __future__ import annotations

import hashlib
import posixpath
import re
import stat
import warnings
import zipfile
from io import BytesIO
from pathlib import Path
from urllib.parse import urlsplit
from xml.etree import ElementTree as ET

from ..execution.workspace_files import open_regular_file, reject_links
from ..extensions.manifest import safe_resource_path

SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"
XML_NS = "http://www.w3.org/XML/1998/namespace"
MAX_SVG_BYTES = 1_000_000
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
MAX_ELEMENTS = 10_000
MAX_DEPTH = 64
# No scripting, HTML, animation, stylesheet imports, or filter resource loaders.
_ELEMENTS = frozenset({
    "svg", "g", "defs", "title", "desc", "symbol", "use", "switch",
    "rect", "circle", "ellipse", "line", "polyline", "polygon", "path",
    "text", "tspan", "textPath", "image", "clipPath", "mask", "marker",
    "linearGradient", "radialGradient", "stop", "pattern",
})
_URL = re.compile(r"url\(\s*(['\"]?)(#[A-Za-z_][\w.:-]*)\1\s*\)", re.IGNORECASE)
_ID = re.compile(r"[A-Za-z_][\w.:-]*\Z")


def _read(path: Path, root: Path, limit: int) -> bytes:
    path, root = path.absolute(), root.absolute()
    reject_links(path, root)
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("PPT 文件路径越界")
    try:
        with open_regular_file(path) as stream:
            content = stream.read(limit + 1)
    except OSError as exc:
        raise ValueError("PPT 文件缺失或不可读取") from exc
    if len(content) > limit:
        raise ValueError("PPT 文件超过大小限制")
    return content


def parse_xml(content: bytes) -> ET.Element:
    """UTF-8 only, bounded by the caller; reject declarations before parsing."""
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("XML 文件必须使用 UTF-8 编码") from exc
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", text, re.IGNORECASE):
        raise ValueError("XML 不允许 DTD 或实体声明")
    if "\x00" in text or re.search(r"<\?(?!xml\s)", text, re.IGNORECASE):
        raise ValueError("XML 不允许处理指令或空字符")
    declaration = re.match(r"\s*<\?xml\s+([^?]*)\?>", text)
    if declaration:
        encoding = re.search(r"encoding\s*=\s*['\"]([^'\"]+)", declaration[1], re.IGNORECASE)
        if encoding and encoding[1].lower() not in {"utf-8", "utf8"}:
            raise ValueError("XML 文件必须使用 UTF-8 编码")
    try:
        return ET.fromstring(text)
    except (ET.ParseError, ValueError) as exc:
        raise ValueError("XML 文件格式无效") from exc


def validate_raster(content: bytes) -> dict:
    from PIL import Image

    if len(content) > MAX_IMAGE_BYTES:
        raise ValueError("图片超过 10 MB 限制")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(content)) as image:
                width, height = image.size
                if image.format not in {"PNG", "JPEG", "WEBP"}:
                    raise ValueError("图片只支持 PNG、JPEG 或 WEBP")
                if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                    raise ValueError("图片像素超过限制")
                if getattr(image, "n_frames", 1) != 1:
                    raise ValueError("图片不支持动画或多帧")
                image.verify()
            # verify() checks the container; load() also checks compressed pixels.
            with Image.open(BytesIO(content)) as image:
                image.load()
    except Exception as exc:
        raise ValueError("图片内容损坏或超过允许范围") from exc
    return {"width": width, "height": height, "sha256": hashlib.sha256(content).hexdigest()}


def _image_reference(value: str, path: Path, root: Path) -> tuple[str, dict]:
    # Only staged, local raster assets. No URL decoding, data URLs, Windows ADS,
    # drive paths, protocol-relative URLs, fragments or query strings.
    parts = urlsplit(value)
    if not value or value != value.strip() or any(c in value for c in "\\:%?#") or parts.scheme or parts.netloc or parts.path.startswith("/"):
        raise ValueError("图片引用必须是任务内的相对路径")
    target = path.parent / value
    reject_links(target, root)
    target = target.resolve()
    if not target.is_relative_to((root / "images").resolve()):
        raise ValueError("图片引用必须位于当前项目 images 目录")
    content = _read(target, root, MAX_IMAGE_BYTES)
    return target.relative_to(root).as_posix(), validate_raster(content)


def validate_svg(path: Path, root: Path) -> dict:
    path, root = path.absolute(), root.absolute()
    content = _read(path, root, MAX_SVG_BYTES)
    document = parse_xml(content)
    if document.tag != f"{{{SVG_NS}}}svg":
        raise ValueError("页面必须是 SVG 命名空间的 svg 根节点")
    try:
        box = [float(value) for value in re.split(r"[\s,]+", document.get("viewBox", "").strip())]
    except ValueError as exc:
        raise ValueError("SVG 画布必须是 1280×720") from exc
    if box != [0, 0, 1280, 720] or document.get("width") != "1280" or document.get("height") != "720":
        raise ValueError("SVG 画布必须是 1280×720")
    identifiers, references, edges = set(), set(), {}
    subtree_sizes, all_targets = {}, []
    resources = {}
    image_count = text_count = count = 0
    stack = [(document, 0, ())]
    while stack:
        element, depth, ancestors = stack.pop()
        count += 1
        if count > MAX_ELEMENTS or len(element.attrib) > 128:
            raise ValueError("SVG 节点或属性超过限制")
        if depth > MAX_DEPTH:
            raise ValueError("SVG 嵌套超过限制")
        if not element.tag.startswith(f"{{{SVG_NS}}}") or element.tag.split("}", 1)[1] not in _ELEMENTS:
            raise ValueError("SVG 包含不支持或可执行的节点")
        tag = element.tag.split("}", 1)[1]
        identifier = element.get("id")
        if identifier is not None:
            if not _ID.fullmatch(identifier) or identifier in identifiers:
                raise ValueError("SVG 标识重复或格式无效")
            identifiers.add(identifier)
            ancestors = (*ancestors, identifier)
        for owner in ancestors:
            subtree_sizes[owner] = subtree_sizes.get(owner, 0) + 1
        if tag == "image":
            hrefs = [element.get("href"), element.get(f"{{{XLINK_NS}}}href")]
            if sum(value is not None for value in hrefs) != 1 or next(value for value in hrefs if value is not None).startswith("#"):
                raise ValueError("图片需要唯一的本地栅格图片引用")
        for key, value in element.attrib.items():
            if key.startswith("{"):
                namespace, name = key[1:].split("}", 1)
                if not ((namespace == XLINK_NS and name == "href") or (namespace == XML_NS and name in {"space", "lang"})):
                    raise ValueError("SVG 属性命名空间不受支持")
            else:
                name = key
            if name.lower().startswith("on") or name.lower() in {"base", "src"}:
                raise ValueError("SVG 不允许事件或外部资源属性")
            # CSS escapes/comments can hide url(), imports or executable values.
            if any(c in value for c in "\\@") or "/*" in value or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", value):
                raise ValueError("SVG 属性含有不支持的转义或样式")
            targets = []
            if name == "href":
                if value.startswith("#") and _ID.fullmatch(value[1:]):
                    targets.append(value[1:])
                elif tag == "image":
                    resource, report = _image_reference(value, path, root)
                    resources[resource] = report
                else:
                    raise ValueError("SVG 只允许页面内引用")
            else:
                matches = list(_URL.finditer(value))
                stripped = _URL.sub("", value)
                if re.search(r"url\s*\(|(?:https?|file|data|javascript):|expression\s*\(", stripped, re.IGNORECASE):
                    raise ValueError("SVG 不允许外部资源或可执行样式")
                targets.extend(match[2][1:] for match in matches)
            references.update(targets)
            all_targets.extend(targets)
            # Include containment: a symbol that uses an ancestor is recursive.
            for owner in ancestors:
                edges.setdefault(owner, []).extend(targets)
        if tag == "image":
            image_count += 1
        if tag == "text" and "".join(element.itertext()).strip():
            text_count += 1
        stack.extend((child, depth + 1, ancestors) for child in element)
    if references - identifiers:
        raise ValueError("SVG 引用不存在的节点")
    # Preserve edge multiplicity: a tiny DAG can expand exponentially in a renderer.
    # Memoized costs cap both validation work and downstream resource expansion.
    costs, heights = {}, {}

    def expansion(identifier: str, visiting: frozenset[str]) -> tuple[int, int]:
        if identifier in visiting or len(visiting) > MAX_DEPTH:
            raise ValueError("SVG 引用循环或嵌套超过限制")
        if identifier in costs:
            return costs[identifier], heights[identifier]
        cost, height = subtree_sizes.get(identifier, 1), 0
        for target in edges.get(identifier, ()):
            child_cost, child_height = expansion(target, visiting | {identifier})
            cost += child_cost
            height = max(height, child_height + 1)
            if cost > MAX_ELEMENTS or height > MAX_DEPTH:
                raise ValueError("SVG 引用展开或嵌套超过限制")
        costs[identifier], heights[identifier] = cost, height
        return cost, height

    total_expansion = count
    for identifier in all_targets:
        total_expansion += expansion(identifier, frozenset())[0]
        if total_expansion > MAX_ELEMENTS:
            raise ValueError("SVG 引用展开超过限制")
    return {
        "sha256": hashlib.sha256(content).hexdigest(), "native_text_nodes": text_count,
        "image_count": image_count, "element_count": count, "resources": resources,
    }


MAX_PACKAGE_EXPANDED_BYTES = 128 * 1024 * 1024
MAX_PACKAGE_PART_BYTES = 16 * 1024 * 1024
_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_REL = "http://schemas.openxmlformats.org/package/2006/relationships"


def validate_delivery(project_root: Path, pptx_path: Path) -> dict:
    """Additional host gate; the official delivery checker is still mandatory.

    Verify bounded OOXML and native text against authoritative svg_output pages.
    Never extract ZIP entries or count preview screenshots as editable slides.
    """
    root = project_root.absolute()
    content = _read(pptx_path, root, 64 * 1024 * 1024)
    try:
        with zipfile.ZipFile(BytesIO(content)) as package:
            entries = package.infolist()
            if len(entries) > 5000 or sum(part.file_size for part in entries) > MAX_PACKAGE_EXPANDED_BYTES:
                raise ValueError("PPTX 展开大小或文件数量超过限制")
            names, xml = set(), {}
            for part in entries:
                name = part.filename
                safe_resource_path(name.rstrip("/"))
                if name.casefold() in names:
                    raise ValueError("PPTX 存在重复文件名")
                names.add(name.casefold())
                if stat.S_ISLNK(part.external_attr >> 16) or part.flag_bits & 1:
                    raise ValueError("PPTX 不允许链接或加密文件")
                if part.file_size > MAX_PACKAGE_PART_BYTES or part.file_size > max(1, part.compress_size) * 1000:
                    raise ValueError("PPTX 文件展开比例或大小超过限制")
                printer_settings = re.fullmatch(r"ppt/printerSettings/printerSettings[1-9][0-9]*\.bin", name)
                if (name.lower().endswith(".bin") and not printer_settings) or name.lower().endswith((".exe", ".js", ".html")) or "/embeddings/" in name.lower():
                    raise ValueError("PPTX 不允许宏、脚本或嵌入程序")
                payload = package.read(part)  # CRC validation for every bounded part.
                if name.endswith((".xml", ".rels")):
                    xml[name] = parse_xml(payload)
            if "[Content_Types].xml" not in xml or "ppt/presentation.xml" not in xml or "ppt/_rels/presentation.xml.rels" not in xml:
                raise ValueError("PPTX 缺少演示文稿结构")
            types = xml["[Content_Types].xml"]
            main_type = "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"
            if not any(node.get("PartName") == "/ppt/presentation.xml" and node.get("ContentType") == main_type for node in types):
                raise ValueError("PPTX 主文档类型不正确")
            for rel_name, relationships in xml.items():
                if not rel_name.endswith(".rels"):
                    continue
                if relationships.tag != f"{{{_REL}}}Relationships":
                    raise ValueError("PPTX 关系格式不正确")
                owner = "" if rel_name == "_rels/.rels" else posixpath.dirname(posixpath.dirname(rel_name))
                ids = set()
                for rel in relationships:
                    identity, target = rel.get("Id"), rel.get("Target", "")
                    if not identity or identity in ids or rel.get("TargetMode", "Internal") != "Internal":
                        raise ValueError("PPTX 关系重复或包含外部资源")
                    ids.add(identity)
                    if not target or any(char in target for char in "\\:%?#") or target.startswith("//"):
                        raise ValueError("PPTX 关系路径不正确")
                    resolved = posixpath.normpath(posixpath.join(owner, target)) if not target.startswith("/") else target[1:]
                    safe_resource_path(resolved)
                    if resolved.casefold() not in names:
                        raise ValueError("PPTX 引用缺失的文件")
            relationships = {rel.get("Id"): rel for rel in xml["ppt/_rels/presentation.xml.rels"]}
            presentation = xml["ppt/presentation.xml"]
            pages = presentation.findall(f"{{{_P}}}sldIdLst/{{{_P}}}sldId")
            source_dir = root / "svg_output"
            reject_links(source_dir, root)
            sources = sorted(source_dir.glob("*.svg"))
            if not 1 <= len(pages) <= 20 or len(pages) != len(sources):
                raise ValueError("PPTX 页数与 SVG 来源页数不一致")
            referenced, native_shapes, text_nodes = set(), 0, 0
            for page, source in zip(pages, sources):
                rel = relationships.get(page.get(f"{{{_R}}}id"))
                if rel is None or rel.get("Type") != f"{_R}/slide":
                    raise ValueError("PPTX 页面关系不正确")
                target = rel.get("Target", "")
                name = posixpath.normpath(posixpath.join("ppt", target)) if not target.startswith("/") else target[1:]
                if not re.fullmatch(r"ppt/slides/slide[1-9][0-9]*\.xml", name) or name in referenced:
                    raise ValueError("PPTX 页面引用无效或重复")
                referenced.add(name)
                slide = xml[name]
                source_report = validate_svg(source, root)
                source_xml = parse_xml(_read(source, root, MAX_SVG_BYTES))
                texts = ["".join(node.itertext()) for node in source_xml.iter(f"{{{SVG_NS}}}text")]
                native = slide.findall(f".//{{{_P}}}sp")
                actual = "".join(node.text or "" for node in slide.iter(f"{{{_A}}}t"))
                normalize = lambda value: re.sub(r"\s+", "", value)
                if source_report["native_text_nodes"] and not native:
                    raise ValueError("PPTX 页面缺少原生可编辑文字，不能用截图替代")
                if any(normalize(text) not in normalize(actual) for text in texts if text.strip()):
                    raise ValueError("PPTX 原生文字与 SVG 来源不一致")
                native_shapes += len(native)
                text_nodes += len(list(slide.iter(f"{{{_A}}}t")))
            packaged_pages = {name for name in xml if re.fullmatch(r"ppt/slides/slide[1-9][0-9]*\.xml", name)}
            if referenced != packaged_pages:
                raise ValueError("PPTX 包含未登记的页面")
    except (zipfile.BadZipFile, RuntimeError, KeyError, OSError) as exc:
        raise ValueError("PPTX 文件损坏或结构不正确") from exc
    return {"sha256": hashlib.sha256(content).hexdigest(), "slides": len(pages), "native_shapes": native_shapes, "native_text_nodes": text_nodes}
