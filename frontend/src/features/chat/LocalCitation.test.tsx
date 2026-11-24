import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "../../components/ui/Dialog";
import { MarkdownContent } from "./ChatMarkdown";
import { LocalCitationContext } from "./LocalCitation";
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
const textPreview = { ...preview, original: { available: false as const, reason: "原文件已移除" } };

function getCitation() {
  return screen.getByRole("button", { name: /核对来源：三页资料.*第 3 页/ });
}

function citationMarkdown(content = marker, loadPreview = vi.fn().mockResolvedValue(textPreview), loadOriginal = vi.fn()) {
  return <LocalCitationContext.Provider value={{ loadPreview, loadOriginal }}>
    <MarkdownContent localEvidence={[evidence]}>{content}</MarkdownContent>
  </LocalCitationContext.Provider>;
}

it("turns only backed normal-text markers into source controls", () => {
  render(citationMarkdown(`结论 ${marker}\n\n\`${marker}\`\n\n~~~text\n${marker}\n~~~`));
  expect(getCitation()).toBeVisible();
  expect(screen.getAllByRole("button", { name: /核对来源/ })).toHaveLength(1);
  expect(document.querySelectorAll("code")).toHaveLength(2);
  expect([...document.querySelectorAll("code")].every(node => node.textContent?.includes(marker))).toBe(true);
});

it("previews actual local evidence on keyboard focus, dismisses on Escape, then opens the same source", async () => {
  const loadPreview = vi.fn().mockResolvedValue(textPreview);
  render(citationMarkdown(marker, loadPreview));
  const button = getCitation();
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  act(() => button.focus());
  const card = await screen.findByRole("tooltip");
  expect(button).toHaveAttribute("aria-describedby", card.id);
  expect(within(card).getByText("资料库 · 第 3 页")).toBeVisible();
  expect(within(card).getByText(evidence.title)).toBeVisible();
  expect(within(card).getByText(evidence.excerpt)).toBeVisible();
  expect(loadPreview).not.toHaveBeenCalled();
  fireEvent.keyDown(button, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  expect(button).toHaveFocus();
  fireEvent.click(button);
  expect(await screen.findByText("原文件已移除")).toBeVisible();
  expect(loadPreview).toHaveBeenCalledExactlyOnceWith(evidence, expect.any(AbortSignal));
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

it("opens the cited historical PDF page and restores focus inside the parent dialog", async () => {
  const closeParent = vi.fn();
  const loadPreview = vi.fn().mockResolvedValue(preview);
  const loadOriginal = vi.fn().mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(4) });
  render(<Dialog open onOpenChange={closeParent}>
    <DialogContent backdropClassName="chat-result-backdrop">
      <DialogTitle>聊天成果</DialogTitle>
      {citationMarkdown(marker, loadPreview, loadOriginal)}
    </DialogContent>
  </Dialog>);
  const trigger = getCitation();
  fireEvent.click(trigger);
  expect(await screen.findByText("PDF 第 3 页")).toBeVisible();
  expect(screen.getByText(/来源已有更新/)).toBeVisible();
  const close = screen.getByRole("button", { name: "关闭来源" });
  await waitFor(() => expect(close).toHaveFocus());
  fireEvent.keyDown(close, { key: "Escape" });
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(screen.getByRole("dialog", { name: "聊天成果" })).toBeVisible();
  expect(screen.queryByRole("dialog", { name: evidence.title })).not.toBeInTheDocument();
  expect(closeParent).not.toHaveBeenCalled();
});

it("keeps the excerpt readable when the original is unavailable", async () => {
  render(citationMarkdown());
  fireEvent.click(getCitation());
  expect(await screen.findByText("原文件已移除")).toBeVisible();
  expect(screen.getByText("第三页事实", { selector: "mark" })).toBeVisible();
});

it("reports inaccessible references and allows retry without a model call", async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error("资料已移入回收站")).mockResolvedValueOnce(textPreview);
  render(citationMarkdown(marker, load));
  fireEvent.click(getCitation());
  expect(await screen.findByRole("alert")).toHaveTextContent("资料已移入回收站");
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  expect(await screen.findByText("第三页事实", { selector: "mark" })).toBeVisible();
  expect(load).toHaveBeenCalledTimes(2);
});

it("loads one preview for a repeated marker and aborts it when its conversation body is replaced", async () => {
  let resolvePreview!: (result: LocalSourcePreview) => void;
  const loadPreview = vi.fn().mockImplementation(() => new Promise<LocalSourcePreview>(resolve => { resolvePreview = resolve; }));
  const loadOriginal = vi.fn();
  const content = `结论 ${marker}，同一来源 ${marker}`;
  const view = render(<div key="conversation-1">{citationMarkdown(content, loadPreview, loadOriginal)}</div>);
  const buttons = screen.getAllByRole("button", { name: /核对来源/ });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[1]);
  expect(screen.getByRole("dialog", { name: evidence.title })).toBeVisible();
  view.rerender(<div key="conversation-1">{citationMarkdown(content, loadPreview, loadOriginal)}</div>);
  expect(loadPreview).toHaveBeenCalledTimes(1);
  const signal = loadPreview.mock.calls[0][1] as AbortSignal;
  view.rerender(<div key="conversation-2">{citationMarkdown(content, loadPreview, loadOriginal)}</div>);
  expect(signal.aborted).toBe(true);
  await act(async () => resolvePreview(preview));
  expect(screen.queryByRole("dialog", { name: evidence.title })).not.toBeInTheDocument();
  expect(loadOriginal).not.toHaveBeenCalled();
});
