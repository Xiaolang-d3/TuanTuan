import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { DocumentEditor } from "./DocumentEditor";
import type { DocumentService, SavedDocument } from "./document-service";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const first: SavedDocument = { document_id: "a".repeat(32), version: 1, latest_version: 1, parent_document_version: null,
  conversation_id: 1, message_id: 2, title: "报告", markdown: "原正文。", evidence: [], citations: [], resources: [], incomplete: false, created_at: "2026-11-09" };
function fixture() {
  return { latest: vi.fn().mockResolvedValue(first), get: vi.fn().mockResolvedValue(first), versions: vi.fn().mockResolvedValue({ versions: [{ version: 1, created_at: first.created_at, parent_document_version: null }] }),
    save: vi.fn().mockResolvedValue({ ...first, version: 2, latest_version: 2, parent_document_version: 1, markdown: "修改后的正文。" }), archive: vi.fn(), resource: vi.fn() } as unknown as DocumentService;
}

it("saves a new version with the visible draft and keeps Markdown and TXT downloads", async () => {
  const service = fixture();
  render(<DocumentEditor documentId={first.document_id} service={service} />);
  const editor = await screen.findByRole("textbox", { name: "文档正文" });
  fireEvent.change(editor, { target: { value: "修改后的正文。" } });
  fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));
  await waitFor(() => expect(service.save).toHaveBeenCalledWith(first.document_id, { base_version: 1, markdown: "修改后的正文。", idempotency_key: expect.any(String) }, expect.any(AbortSignal)));
  expect(await screen.findByText("已保存 v2")).toBeVisible();
  expect(screen.getByRole("button", { name: "Markdown" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "TXT" })).toBeEnabled();
});

it("retains a conflicting draft and reuses its receipt on a network retry", async () => {
  const service = fixture();
  vi.mocked(service.save).mockRejectedValueOnce(new Error("网络中断")).mockRejectedValueOnce(new ApiError("保存冲突，草稿保留", 409));
  render(<DocumentEditor documentId={first.document_id} service={service} />);
  fireEvent.change(await screen.findByRole("textbox", { name: "文档正文" }), { target: { value: "不能丢失的草稿。" } });
  fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("网络中断");
  fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("保存冲突");
  expect(screen.getByRole("textbox", { name: "文档正文" })).toHaveValue("不能丢失的草稿。");
  expect(vi.mocked(service.save).mock.calls[0][1].idempotency_key).toBe(vi.mocked(service.save).mock.calls[1][1].idempotency_key);
});

it("continues from the selected saved historical version and never sends an unsaved draft", async () => {
  const service = fixture(), onContinue = vi.fn().mockResolvedValue(undefined);
  vi.mocked(service.latest).mockResolvedValue({ ...first, version: 2, latest_version: 2, markdown: "当前版本。" });
  vi.mocked(service.versions).mockResolvedValue({ versions: [{ version: 2, parent_document_version: 1, created_at: first.created_at }, { version: 1, parent_document_version: null, created_at: first.created_at }] });
  vi.mocked(service.get).mockResolvedValue({ ...first, latest_version: 2 });
  render(<DocumentEditor documentId={first.document_id} service={service} onContinue={onContinue} />);
  fireEvent.change(await screen.findByRole("textbox", { name: "文档正文" }), { target: { value: "未保存输入。" } });
  expect(screen.getByRole("button", { name: /用 v2 继续对话/ })).toBeDisabled();
  fireEvent.change(screen.getByRole("combobox", { name: "文档版本" }), { target: { value: "1" } });
  await waitFor(() => expect(screen.getByRole("textbox", { name: "文档正文" })).toHaveValue("原正文。"));
  fireEvent.click(screen.getByRole("button", { name: /用 v1 继续对话/ }));
  await waitFor(() => expect(onContinue).toHaveBeenCalledWith(expect.objectContaining({ version: 1, markdown: "原正文。" }), expect.any(AbortSignal)));
  expect(screen.getByRole("textbox", { name: "保留的草稿 v2" })).toHaveValue("未保存输入。");
});

it("archives the visible saved version with a stable retry receipt and indexing off", async () => {
  const service = fixture();
  vi.mocked(service.archive).mockRejectedValueOnce(new Error("网络中断")).mockResolvedValueOnce({ source: { id: 8 } as never, reused: false });
  render(<DocumentEditor documentId={first.document_id} service={service} />);
  await screen.findByRole("textbox", { name: "文档正文" });
  fireEvent.click(screen.getByRole("button", { name: "归档此保存版本" }));
  fireEvent.click(screen.getByRole("button", { name: "确认归档 v1" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "确认归档 v1" }));
  expect(await screen.findByText("已将 v1 归档到文件库")).toBeVisible();
  expect(service.archive).toHaveBeenCalledWith(first.document_id, 1, { filename: "报告.md", folder_id: null, enabled: false, idempotency_key: expect.any(String) }, expect.any(AbortSignal));
  expect(vi.mocked(service.archive).mock.calls[0][2].idempotency_key).toBe(vi.mocked(service.archive).mock.calls[1][2].idempotency_key);
});

it("discards a late document response after an account service change", async () => {
  const original = fixture(), next = fixture();
  let finish!: (document: SavedDocument) => void;
  vi.mocked(original.latest).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  vi.mocked(next.latest).mockResolvedValue({ ...first, markdown: "另一个账户自己的文档。" });
  const view = render(<DocumentEditor documentId={first.document_id} service={original} />);
  view.rerender(<DocumentEditor documentId={first.document_id} service={next} />);
  expect(await screen.findByRole("textbox", { name: "文档正文" })).toHaveValue("另一个账户自己的文档。");
  await act(async () => finish({ ...first, markdown: "旧账户内容不能显示。" }));
  expect(screen.getByRole("textbox", { name: "文档正文" })).toHaveValue("另一个账户自己的文档。");
});

it("loads a document-owned image through the exact version resource manifest", async () => {
  const service = fixture();
  const resource = { id: "c".repeat(32), uri: `resources/${"c".repeat(32)}.png`, filename: "图.png", mime_type: "image/png", sha256: "d".repeat(64), size_bytes: 10 };
  vi.mocked(service.latest).mockResolvedValue({ ...first, markdown: `![版本图片](${resource.uri})`, resources: [resource] });
  vi.mocked(service.resource).mockResolvedValue(new Blob(["image"], { type: "image/png" }));
  const original = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn().mockReturnValue("blob:document-image"); URL.revokeObjectURL = vi.fn();
  try {
    render(<DocumentEditor documentId={first.document_id} service={service} />);
    await screen.findByRole("textbox", { name: "文档正文" });
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    expect(await screen.findByRole("img", { name: "版本图片" })).toHaveAttribute("src", "blob:document-image");
    expect(service.resource).toHaveBeenCalledWith(first.document_id, resource.id, expect.any(AbortSignal));
  } finally { cleanup(); URL.createObjectURL = original; URL.revokeObjectURL = revoke; }
});

it("does not load remote images from an unsaved document preview", async () => {
  render(<DocumentEditor documentId={first.document_id} service={fixture()} />);
  fireEvent.change(await screen.findByRole("textbox", { name: "文档正文" }), { target: { value: "![外部图片](https://example.test/private.png)" } });
  fireEvent.click(screen.getByRole("button", { name: "预览" }));
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("图片不属于文档资源清单");
});
