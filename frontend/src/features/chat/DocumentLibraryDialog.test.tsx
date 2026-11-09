import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentLibraryDialog } from "./DocumentLibraryDialog";
import type { DocumentService, SavedDocument } from "./document-service";

afterEach(cleanup);
it("reopens saved documents without loading their original chat", async () => {
  const document: SavedDocument = { document_id: "a".repeat(32), version: 2, latest_version: 2, parent_document_version: 1,
    conversation_id: 4, message_id: 9, title: "交付报告", markdown: "独立保存的修改内容。", evidence: [], citations: [], resources: [], incomplete: false, created_at: "2026-11-09" };
  const service = { list: vi.fn().mockResolvedValue({ documents: [document] }), latest: vi.fn().mockResolvedValue(document), versions: vi.fn().mockResolvedValue({ versions: [{ version: 2, parent_document_version: 1, created_at: document.created_at }] }) } as unknown as DocumentService;
  render(<DocumentLibraryDialog service={service} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "打开文档：交付报告" }));
  expect(await screen.findByRole("textbox", { name: "文档正文" })).toHaveValue("独立保存的修改内容。");
  expect(service.latest).toHaveBeenCalledWith(document.document_id, expect.any(AbortSignal));
});

it("opens a requested document directly and retains its draft during a viewport change", async () => {
  const document: SavedDocument = { document_id: "b".repeat(32), version: 1, latest_version: 1, parent_document_version: null,
    conversation_id: 4, message_id: 9, title: "报告", markdown: "已保存正文。", evidence: [], citations: [], resources: [], incomplete: false, created_at: "2026-11-09" };
  const service = { list: vi.fn().mockResolvedValue({ documents: [document] }), latest: vi.fn().mockResolvedValue(document), versions: vi.fn().mockResolvedValue({ versions: [{ version: 1, parent_document_version: null, created_at: document.created_at }] }) } as unknown as DocumentService;
  render(<DocumentLibraryDialog initialDocumentId={document.document_id} service={service} onClose={vi.fn()} />);
  const editor = await screen.findByRole("textbox", { name: "文档正文" });
  fireEvent.change(editor, { target: { value: "屏幕变化时保留的草稿。" } });
  fireEvent(window, new Event("resize"));
  expect(editor).toHaveValue("屏幕变化时保留的草稿。");
});
