import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentPreviewDialog } from "./AttachmentPreviewDialog";
import type { ChatAttachment } from "./types";

vi.mock("../library/PdfReader", () => ({ default: ({ bytes, title }: { bytes: Uint8Array; title: string }) => <div data-testid="pdf-reader">{title} · {new TextDecoder().decode(bytes)}</div> }));

function file(text: string, type = "text/plain"): Blob {
  return { size: new TextEncoder().encode(text).length, type, text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer } as Blob;
}

function attachment(filename: string, overrides: Partial<ChatAttachment> = {}): ChatAttachment {
  return { id: "test-file", kind: "document", original_filename: filename, parse_status: "parsed", ...overrides };
}

function loadImage(image: HTMLElement, width = 2000, height = 1000) {
  const viewport = image.closest(".chat-attachment-body") as HTMLElement;
  Object.defineProperties(viewport, { clientWidth: { configurable: true, value: 1064 }, clientHeight: { configurable: true, value: 712 } });
  Object.defineProperties(image, { naturalWidth: { configurable: true, value: width }, naturalHeight: { configurable: true, value: height } });
  fireEvent.load(image);
  return viewport;
}

beforeEach(() => {
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: vi.fn().mockReturnValue("blob:preview-test"), revokeObjectURL: vi.fn() }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("attachment preview", () => {
  it("loads the original PDF bytes into the shared reader and enables download", async () => {
    const load = vi.fn().mockResolvedValue({ file: file("%PDF-synthetic", "application/pdf") });
    render(<AttachmentPreviewDialog attachment={attachment("资料.pdf")} loadOriginal={load} onClose={vi.fn()} />);
    expect(await screen.findByTestId("pdf-reader")).toHaveTextContent("%PDF-synthetic");
    expect(screen.getByRole("button", { name: "下载原文件" })).toBeEnabled();
    expect(load.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
  });

  it("uses the selected local file without fetching or sending the message", async () => {
    const load = vi.fn();
    render(<AttachmentPreviewDialog attachment={attachment("草稿.txt")} localFile={file("本地草稿原文") as File} loadOriginal={load} onClose={vi.fn()} />);
    expect(await screen.findByText("本地草稿原文")).toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
  });

  it("renders Markdown tables and skips embedded HTML", async () => {
    const content = "# 资料标题\n\n|名称|状态|\n|---|---|\n|附件|就绪|\n\n<script>untrusted()</script>";
    render(<AttachmentPreviewDialog attachment={attachment("notes.md")} loadOriginal={async () => ({ file: file(content) })} onClose={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "资料标题" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveTextContent("就绪");
    expect(screen.getByRole("dialog").querySelector("script")).toBeNull();
  });

  it("shows extracted Word text with a clear original-layout download option", async () => {
    render(<AttachmentPreviewDialog attachment={attachment("报告.docx")} loadOriginal={async () => ({ file: file("docx bytes"), parsedText: "Word 提取的正文" })} onClose={vi.fn()} />);
    expect(await screen.findByText("Word 提取的正文")).toBeInTheDocument();
    expect(screen.getByText(/完整排版请下载原文件查看/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载原文件" })).toBeEnabled();
  });

  it("shows a retryable read failure and recovers without losing the attachment", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("原文件暂时不可用")).mockResolvedValueOnce({ file: file("恢复后的原文") });
    render(<AttachmentPreviewDialog attachment={attachment("资料.txt")} loadOriginal={load} onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("原文件暂时不可用");
    expect(screen.getByRole("button", { name: "下载原文件" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByText("恢复后的原文")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("releases image URLs, traps focus, and restores the trigger on close", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const close = vi.fn();
    const view = render(<AttachmentPreviewDialog attachment={attachment("picture.png", { kind: "image" })} loadOriginal={async () => ({ file: file("image", "image/png") })} onClose={close} />);
    const image = await screen.findByRole("img", { name: "picture.png" });
    expect(image).toHaveAttribute("src", "blob:preview-test");
    loadImage(image);
    const dialog = screen.getByRole("dialog");
    const controls = within(dialog).getAllByRole("button");
    controls.at(-1)!.focus();
    fireEvent.keyDown(controls.at(-1)!, { key: "Tab" });
    expect(controls[0]).toHaveFocus();
    fireEvent.pointerDown(image);
    const viewport = image.closest(".chat-attachment-body")!;
    expect(viewport).toHaveFocus();
    fireEvent.keyDown(viewport, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-test");
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("aborts an old preview and ignores a late read after the dialog closes", async () => {
    let resolve!: (value: { file: Blob }) => void;
    const load = vi.fn().mockImplementation(() => new Promise<{ file: Blob }>(done => { resolve = done; }));
    const view = render(<AttachmentPreviewDialog attachment={attachment("slow.txt")} loadOriginal={load} onClose={vi.fn()} />);
    const signal = load.mock.calls[0][1] as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    resolve({ file: file("迟到的文字") });
    await waitFor(() => expect(screen.queryByText("迟到的文字")).not.toBeInTheDocument());
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("downloads the original bytes using the complete Chinese filename", async () => {
    const original = file("完整的源码内容");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("中文资料.txt");
      expect(this.href).toBe("blob:preview-test");
    });
    render(<AttachmentPreviewDialog attachment={attachment("中文资料.txt")} loadOriginal={async () => ({ file: original })} onClose={vi.fn()} />);
    await screen.findByText("完整的源码内容");
    fireEvent.click(screen.getByRole("button", { name: "下载原文件" }));
    expect(click).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).toHaveBeenCalledWith(original);
  });

  it("shows actual pixel scale and supports original size, fitting, and double-click zoom", async () => {
    render(<AttachmentPreviewDialog attachment={attachment("wide.png", { kind: "image" })} loadOriginal={async () => ({ file: file("image", "image/png") })} onClose={vi.fn()} />);
    const image = await screen.findByRole("img");
    const viewport = loadImage(image);
    const scale = screen.getByRole("button", { name: "查看原始尺寸" });
    const fit = screen.getByRole("button", { name: "适应窗口" });
    expect(scale).toHaveTextContent("50%");
    expect(screen.queryByText(/2000 × 1000/)).not.toBeInTheDocument();
    expect(image).toHaveStyle({ width: "1000px" });
    fireEvent.click(screen.getByRole("button", { name: "放大图片" }));
    expect(scale).toHaveTextContent("75%");
    expect(viewport).toHaveClass("can-pan");
    fireEvent.click(scale);
    expect(image).toHaveStyle({ width: "2000px" });
    expect(scale).toHaveTextContent("100%");
    expect(viewport.scrollLeft).toBeGreaterThan(0);
    // Pointer capture during panning retargets double-clicks to the viewport.
    fireEvent.doubleClick(viewport);
    expect(fit).toHaveAttribute("aria-pressed", "true");
    expect(scale).toHaveTextContent("50%");
    expect(viewport.scrollLeft).toBe(0);
    expect(viewport).not.toHaveClass("can-pan");
    fireEvent.doubleClick(image);
    expect(scale).toHaveTextContent("100%");
    fireEvent.click(fit);
    expect(scale).toHaveTextContent("50%");
  });

  it("bounds keyboard zoom and fits tall images without cropping", async () => {
    render(<AttachmentPreviewDialog attachment={attachment("tall.png", { kind: "image" })} loadOriginal={async () => ({ file: file("image", "image/png") })} onClose={vi.fn()} />);
    const image = await screen.findByRole("img");
    loadImage(image, 1000, 2000);
    const dialog = screen.getByRole("dialog");
    const scale = screen.getByRole("button", { name: "查看原始尺寸" });
    expect(scale).toHaveTextContent("30%");
    expect(image).toHaveStyle({ width: "300px" });
    for (let index = 0; index < 20; index++) fireEvent.keyDown(dialog, { key: "+" });
    expect(scale).toHaveTextContent("400%");
    expect(screen.getByRole("button", { name: "放大图片" })).toBeDisabled();
    for (let index = 0; index < 20; index++) fireEvent.keyDown(dialog, { key: "-" });
    expect(scale).toHaveTextContent("10%");
    expect(screen.getByRole("button", { name: "缩小图片" })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "0" });
    expect(scale).toHaveTextContent("30%");
  });

  it("refits on resize while preserving an explicitly chosen original size", async () => {
    let resize!: () => void;
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
    render(<AttachmentPreviewDialog attachment={attachment("resize.png", { kind: "image" })} loadOriginal={async () => ({ file: file("image", "image/png") })} onClose={vi.fn()} />);
    const image = await screen.findByRole("img");
    const viewport = loadImage(image);
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 564 });
    act(() => resize());
    expect(image).toHaveStyle({ width: "532px" });
    fireEvent.click(screen.getByRole("button", { name: "查看原始尺寸" }));
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 432 });
    act(() => resize());
    expect(image).toHaveStyle({ width: "2000px" });
    fireEvent.click(screen.getByRole("button", { name: "适应窗口" }));
    expect(image).toHaveStyle({ width: "400px" });
  });
});


it("switches between images in one preview without losing the original focus target", async () => {
  const first = attachment("first.png", { id: "first", kind: "image" });
  const second = attachment("second.png", { id: "second", kind: "image" });
  const navigate = vi.fn();
  const load = vi.fn().mockResolvedValue({ file: file("image", "image/png") });
  const trigger = document.createElement("button"); document.body.appendChild(trigger); trigger.focus();
  const view = render(<AttachmentPreviewDialog attachment={first} gallery={[first, second]} onNavigate={navigate} loadOriginal={load} onClose={vi.fn()} />);
  loadImage(await screen.findByRole("img", { name: "first.png" }));
  fireEvent.click(screen.getByRole("button", { name: "查看原始尺寸" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
  expect(navigate).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
  expect(navigate).toHaveBeenCalledWith(second);
  view.rerender(<AttachmentPreviewDialog attachment={second} gallery={[first, second]} onNavigate={navigate} loadOriginal={load} onClose={vi.fn()} />);
  loadImage(await screen.findByRole("img", { name: "second.png" }));
  expect(screen.getByRole("button", { name: "查看原始尺寸" })).toHaveTextContent("50%");
  expect(screen.getByText("2 / 2")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "下一张图片" })).toBeDisabled();
  view.unmount(); expect(trigger).toHaveFocus(); trigger.remove();
});


it("opens generated images directly with tools and no file heading or edit-entry step", async () => {
  render(<AttachmentPreviewDialog attachment={attachment("generated.png", { kind: "image", origin: "generated", width: 1024, height: 768 })} loadOriginal={async () => ({ file: file("image", "image/png") })} onEditGeneratedImage={vi.fn()} onNavigate={vi.fn()} onClose={vi.fn()} />);
  await screen.findByRole("img", { name: "正在编辑的图片" });
  expect(screen.getByRole("toolbar", { name: "图片设计工具" })).toBeInTheDocument();
  expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "继续编辑" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("修改要求")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "关闭附件预览" })).toBeInTheDocument();
});
