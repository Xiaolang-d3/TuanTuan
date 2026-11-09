import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MarkdownContent } from "./ChatMarkdown";
import { LocalCitationActionsContext, LocalCitationDialog } from "./LocalCitation";
import type { LocalEvidence, LocalSourcePreview } from "./local-evidence";

vi.mock("../library/PdfReader", () => ({ default: ({ initialPage }: { initialPage?: number }) => <div>PDF 第 {initialPage} 页</div> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const evidence: LocalEvidence = {
  citation_id: `e_${"a".repeat(32)}`, source_kind: "library", source_id: 1,
  source_revision: "b".repeat(64), block_id: "c".repeat(32), title: "三页资料",
  locator: { kind: "pdf_page", page: 3, precise: true }, excerpt: "第三页事实", excerpt_hash: "d".repeat(64)
};
const marker = `[[cite:${evidence.citation_id}]]`;
const preview: LocalSourcePreview = {
  ...evidence, text: "第三页事实", model_text: "第三页事实", is_current: false,
  original: { available: true, source_kind: "library", source_id: 1, mime_type: "application/pdf", filename: "three.pdf" }
};

it("turns only backed normal-text markers into source controls", () => {
  const open = vi.fn();
  render(<LocalCitationActionsContext.Provider value={open}><MarkdownContent localEvidence={[evidence]}>{`结论 ${marker}\n\n\`${marker}\`\n\n~~~text\n${marker}\n~~~`}</MarkdownContent></LocalCitationActionsContext.Provider>);
  const button = screen.getByRole("button", { name: /核对来源：三页资料.*第 3 页/ });
  expect(screen.getAllByRole("button", { name: /核对来源/ })).toHaveLength(1);
  expect(document.querySelectorAll("code")).toHaveLength(2);
  expect([...document.querySelectorAll("code")].every(node => node.textContent?.includes(marker))).toBe(true);
  fireEvent.click(button);
  expect(open).toHaveBeenCalledWith(evidence);
});

it("keeps unknown and partial streaming references noninteractive", () => {
  render(<MarkdownContent localEvidence={[evidence]} streaming>{`[[cite:e_${"0".repeat(32)}]] and [[cite:${evidence.citation_id}`}</MarkdownContent>);
  expect(screen.queryByRole("button", { name: /核对来源/ })).not.toBeInTheDocument();
  expect(screen.getByText(/核对来源中/)).toBeVisible();
});

it("keeps ordinary web citations working alongside local citations", () => {
  render(<MarkdownContent localEvidence={[evidence]} sources={[{ title: "官网", url: "https://example.com" }]}>{`[官网](https://example.com) ${marker}`}</MarkdownContent>);
  expect(screen.getByRole("link", { name: "来源 1：官网" })).toHaveAttribute("href", "https://example.com");
});

it("opens the cited historical PDF page and preserves focus on closing", async () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  const close = vi.fn();
  const loadPreview = vi.fn().mockResolvedValue(preview);
  const loadOriginal = vi.fn().mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(4) });
  const view = render(<LocalCitationDialog evidence={evidence} loadPreview={loadPreview} loadOriginal={loadOriginal} onClose={close} />);
  expect(await screen.findByText("PDF 第 3 页")).toBeVisible();
  expect(screen.getByText(/来源已有更新/)).toBeVisible();
  expect(screen.getByRole("button", { name: "关闭来源" })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("dialog", { name: "核对本地来源" }), { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
  view.unmount();
  expect(trigger).toHaveFocus();
  trigger.remove();
});

it("keeps the excerpt readable when the original is unavailable", async () => {
  render(<LocalCitationDialog evidence={evidence} loadPreview={vi.fn().mockResolvedValue({ ...preview, original: { available: false, reason: "原文件已移除" } })} loadOriginal={vi.fn()} onClose={vi.fn()} />);
  expect(await screen.findByText("原文件已移除")).toBeVisible();
  expect(screen.getByText("第三页事实", { selector: "mark" })).toBeVisible();
});

it("reports inaccessible references and allows retry without a model call", async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error("资料已移入回收站")).mockResolvedValueOnce({ ...preview, original: { available: false, reason: "没有原文件" } });
  render(<LocalCitationDialog evidence={evidence} loadPreview={load} loadOriginal={vi.fn()} onClose={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("资料已移入回收站");
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  await waitFor(() => expect(screen.getByText("第三页事实", { selector: "mark" })).toBeVisible());
  expect(load).toHaveBeenCalledTimes(2);
});
