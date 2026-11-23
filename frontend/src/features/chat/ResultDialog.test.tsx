import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResultDialog } from "./ResultDialog";
import { MarkdownContent } from "./ChatMarkdown";
import { markdownToText } from "./result-files";
import type { ArtifactManifest, ResultServices } from "./result-types";
import type { LibrarySourceDetail } from "../../types";
import type { DocumentService, SavedDocument } from "./document-service";

const downloads = vi.hoisted(() => ({ downloadText: vi.fn() }));
vi.mock("./result-files", async importOriginal => ({ ...await importOriginal<typeof import("./result-files")>(), downloadText: downloads.downloadText }));
const manifest: ArtifactManifest = { message_id: 12, snapshot: "a".repeat(64), incomplete: false, artifacts: [
  { selector: "answer", kind: "answer", filename: "回答.md", mime_type: "text/markdown", content: "# 报告\n\n|主题|状态|\n|---|---|\n|成果|完成|\n\n[官网](https://example.com)", can_index: true },
  { selector: "code:20", kind: "code", filename: "代码-1.py", mime_type: "text/plain", content: "print('你好')\n", can_index: true },
  { selector: "attachment:image", kind: "attachment", filename: "示意图.png", mime_type: "image/png", attachment_id: "image", can_index: false }
] };
const saved = { source: { id: 30 } as LibrarySourceDetail, reused: false };

it("opens a stable editable document from the selected answer snapshot", async () => {
  const doc = { document_id: "d".repeat(32), version: 1, latest_version: 1, parent_document_version: null,
    conversation_id: 7, message_id: 12, title: "报告", markdown: "# 可编辑报告", evidence: [], citations: [], resources: [], incomplete: false, created_at: "2026-11-09" } satisfies SavedDocument;
  const documents = { create: vi.fn().mockResolvedValue(doc), latest: vi.fn().mockResolvedValue(doc), versions: vi.fn().mockResolvedValue({ versions: [{ version: 1, parent_document_version: null, created_at: doc.created_at }] }) } as unknown as DocumentService;
  render(<ResultDialog conversationId={7} messageId={12} services={services({ documentService: documents })} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑文档" }));
  expect(await screen.findByRole("textbox", { name: "文档正文" })).toHaveValue("# 可编辑报告");
  expect(documents.create).toHaveBeenCalledWith({ conversation_id: 7, message_id: 12, snapshot: manifest.snapshot, idempotency_key: `document:7:12:${manifest.snapshot}` }, expect.any(AbortSignal));
});
function services(overrides: ResultServices = {}): ResultServices {
  return { onLoadResults: vi.fn().mockResolvedValue(manifest), onSaveResult: vi.fn().mockResolvedValue(saved), resultFolders: [{ id: 2, name: "成果归档" }], ...overrides };
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("chat result reader and archive", () => {
  it.each([["image/png", "图.png", false], ["image/webp", "图.webp", true]])("offers PNG conversion only when useful for %s", async (mime, filename, convert) => {
    const asset = { id: "image", kind: "image" as const, origin: "generated" as const, original_filename: filename, parse_status: "parsed" as const };
    const imageManifest: ArtifactManifest = { ...manifest, artifacts: [{ selector: "asset:image", kind: "image", filename, mime_type: mime, asset, can_index: false }] };
    const api = services({ onLoadResults: vi.fn().mockResolvedValue(imageManifest), onLoadAttachment: vi.fn() });
    render(<ResultDialog messageId={12} services={api} onClose={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "下载原图" })).toBeEnabled();
    expect(!!screen.queryByRole("button", { name: "导出 PNG" })).toBe(convert);
  });

  it("renders the shared Markdown reader and downloads Markdown and text with sources", async () => {
    render(<ResultDialog messageId={12} services={services()} onClose={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "报告" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveTextContent("成果完成");
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    expect(downloads.downloadText).toHaveBeenCalledWith(manifest.artifacts[0].content, "回答.md", "text/markdown");
    fireEvent.click(screen.getByRole("button", { name: "TXT" }));
    expect(downloads.downloadText).toHaveBeenLastCalledWith(expect.stringContaining("官网（https://example.com）"), "回答.txt");
  });

  it("saves the authoritative snapshot, selected folder, and defaults to archive only", async () => {
    const api = services({ onOpenSavedResult: vi.fn() });
    const close = vi.fn();
    render(<ResultDialog messageId={12} services={api} saving onClose={close} />);
    const checkbox = await screen.findByRole("checkbox", { name: "作为知识依据使用" });
    expect(checkbox).not.toBeChecked();
    fireEvent.change(screen.getByRole("textbox", { name: "文件名" }), { target: { value: "项目报告.md" } });
    fireEvent.change(screen.getByRole("combobox", { name: "文件夹" }), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    expect(await screen.findByRole("status")).toHaveTextContent("已保存到文件库");
    expect(api.onSaveResult).toHaveBeenCalledWith(12, { selector: "answer", snapshot: manifest.snapshot, filename: "项目报告.md", folder_id: 2, enabled: false }, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "打开文件" }));
    expect(api.onOpenSavedResult).toHaveBeenCalledWith(30);
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves code content and prevents claiming image-only archives are searchable", async () => {
    render(<ResultDialog messageId={12} services={services()} saving onClose={vi.fn()} />);
    const select = await screen.findByRole("combobox", { name: "选择成果" });
    fireEvent.change(select, { target: { value: "code:20" } });
    expect(screen.getByRole("textbox", { name: "文件名" })).toHaveValue("代码-1.py");
    fireEvent.click(screen.getByRole("button", { name: "下载源文件" }));
    expect(downloads.downloadText).toHaveBeenCalledWith("print('你好')\n", "代码-1.py", "text/plain");
    fireEvent.change(select, { target: { value: "attachment:image" } });
    expect(screen.getByRole("checkbox", { name: "作为知识依据使用" })).toBeDisabled();
    expect(screen.getByText("该成果没有可检索文字，将完整保存原文件。")).toBeInTheDocument();
  });

  it("keeps the user's save fields after a conflict and supports reopening a refreshed snapshot", async () => {
    const api = services({ onSaveResult: vi.fn().mockRejectedValue(new Error("回答已更新，请重新打开成果后再保存")) });
    render(<ResultDialog messageId={12} services={api} saving onClose={vi.fn()} />);
    await screen.findByRole("combobox", { name: "选择成果" });
    fireEvent.change(screen.getByRole("textbox", { name: "文件名" }), { target: { value: "保留标题.md" } });
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("回答已更新");
    expect(screen.getByRole("textbox", { name: "文件名" })).toHaveValue("保留标题.md");
    expect(screen.getByRole("button", { name: "确认保存" })).toBeEnabled();
  });

  it("aborts late reads and restores the trigger without displaying a stale result", async () => {
    let resolve!: (value: ArtifactManifest) => void;
    const load = vi.fn().mockImplementation(() => new Promise<ArtifactManifest>(done => { resolve = done; }));
    const trigger = document.createElement("button"); document.body.appendChild(trigger); trigger.focus();
    const view = render(<ResultDialog messageId={12} services={services({ onLoadResults: load })} onClose={vi.fn()} />);
    const signal = load.mock.calls[0][1] as AbortSignal;
    view.unmount(); resolve(manifest);
    await waitFor(() => expect(signal.aborted).toBe(true));
    expect(trigger).toHaveFocus();
    expect(screen.queryByText("报告")).not.toBeInTheDocument(); trigger.remove();
  });

  it("retries failed reads and identifies stopped results as incomplete", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("读取失败")).mockResolvedValueOnce({ ...manifest, incomplete: true });
    render(<ResultDialog messageId={12} services={services({ onLoadResults: load })} onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("读取失败");
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByText("未完成的执行 · 已保留现有内容")).toBeInTheDocument();
  });
});

it("exports readable prose without altering fenced source code", () => {
  const code = "```python\n# keep heading\ntext = '**literal**'\n```";
  const result = markdownToText("# 标题\n\n**正文** [官网](https://example.com)\n\n" + code);
  expect(result).toContain("标题\n\n正文 官网（https://example.com）");
  expect(result).toContain("# keep heading\ntext = '**literal**'");
  expect(result).not.toContain("```python");
});

it("downloads code with the correct extension and has a safe remote-image fallback", async () => {
  render(<MarkdownContent>{"```typescript\nconst name = 'test';\n```\n\n![示意图](https://example.com/image.png)"}</MarkdownContent>);
  fireEvent.click(screen.getByRole("button", { name: "下载代码" }));
  expect(downloads.downloadText).toHaveBeenCalledWith("const name = 'test';\n", "代码.ts", "text/plain");
  fireEvent.error(screen.getByRole("img", { name: "示意图" }));
  expect(screen.getByRole("link", { name: /图片加载失败，打开原图/ })).toHaveAttribute("href", "https://example.com/image.png");
});
