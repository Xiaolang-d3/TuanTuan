import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentReviewCard } from "./DocumentReviewCard";
import { LocalCitationContext } from "./LocalCitation";
import type { LocalEvidence } from "./local-evidence";
import type { DocumentReviewJob, DocumentReviewService } from "./document-review-service";

afterEach(cleanup);
const coverage = { status: "partial" as const, total_blocks: 4, completed_blocks: 2, failed_blocks: 0, extraction_complete: true, unprocessed_ranges: [] };
const running: DocumentReviewJob = {
  id: "review-one", kind: "document.review", status: "running", revision: 2, cancel_requested: false,
  request: { target: { source_kind: "library", source_id: 1, source_revision: "a".repeat(64) } },
  source_title: "长资料.pdf", checkpoint: { review: { coverage, summary: "已提交批次的结论。" } },
};
function fixture() {
  return { create: vi.fn(), list: vi.fn(), get: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), resume: vi.fn() } as unknown as DocumentReviewService;
}

it("opens committed citations even when the model summary has no inline markers", async () => {
  const evidence: LocalEvidence = { citation_id: `e_${"a".repeat(32)}`, source_kind: "library", source_id: 1,
    source_revision: "b".repeat(64), block_id: "c".repeat(32), title: "长资料.pdf", locator: { kind: "pdf_page", page: 3 },
    excerpt: "第三页的已提交片段。", excerpt_hash: "d".repeat(64) };
  const loadPreview = vi.fn().mockResolvedValue({ ...evidence, text: evidence.excerpt, is_current: true, original: { available: false, reason: "没有原文件" } });
  render(<LocalCitationContext.Provider value={{ loadPreview, loadOriginal: vi.fn() }}><DocumentReviewCard service={fixture()} onChange={vi.fn()}
    job={{ ...running, status: "succeeded", result: { coverage, summary: "只有结论，没有引用标记。", local_evidence: [evidence] } }} />
  </LocalCitationContext.Provider>);
  fireEvent.click(screen.getByRole("button", { name: "核对来源：长资料.pdf，第 3 页" }));
  expect(await screen.findByText("没有原文件")).toBeVisible();
  expect(loadPreview).toHaveBeenCalledWith(evidence, expect.any(AbortSignal));
});

it("separates successful job lifecycle from incomplete extraction, even at 100 percent of blocks", () => {
  const service = fixture();
  render(<DocumentReviewCard job={{ ...running, status: "succeeded", result: { summary: "可提取部分的结论。", coverage: { ...coverage, status: "complete", completed_blocks: 4, extraction_complete: false, unprocessed_ranges: [{ reason: "ocr_required", page: 3 }] } } }} service={service} onChange={vi.fn()} />);
  expect(screen.queryByText("全文审阅完成")).not.toBeInTheDocument();
  expect(screen.getByText("审阅结束，覆盖不完整")).toBeVisible();
  expect(screen.getByText(/缺少可提取文字或 OCR/)).toBeVisible();
  expect(screen.getByText("可提取部分的结论。")).toBeVisible();
  expect(service.create).not.toHaveBeenCalled();
  expect(service.confirm).not.toHaveBeenCalled();
});

it("only adds the displayed budget after an explicit click with current stage, revision and receipt", async () => {
  const service = fixture();
  vi.mocked(service.confirm).mockResolvedValue({ ...running, status: "queued", revision: 5 });
  const onChange = vi.fn();
  render(<DocumentReviewCard job={{ ...running, status: "waiting_user", revision: 4, stage_id: "stage-a", prompt: "输入预算已用完", checkpoint: { ...running.checkpoint, budget_exhausted: true } }} service={service} onChange={onChange} />);
  expect(service.confirm).not.toHaveBeenCalled();
  expect(screen.getByText(/32 次调用/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "追加预算并继续" }));
  await waitFor(() => expect(service.confirm).toHaveBeenCalledOnce());
  expect(service.confirm).toHaveBeenCalledWith("review-one", "stage-a", 4, {
    budget: { calls: 32, input_tokens: 200000, output_tokens: 32000, active_seconds: 1800 },
    idempotency_key: "document-review-budget:review-one:stage-a:4",
  });
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ revision: 5 })));
});

it("preserves committed partial output after cancellation", async () => {
  const service = fixture();
  const cancelled = { ...running, status: "cancelled" as const, cancel_requested: true, revision: 3 };
  vi.mocked(service.cancel).mockResolvedValue(cancelled);
  const onChange = vi.fn();
  const view = render(<DocumentReviewCard job={running} service={service} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "取消审阅" }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(cancelled));
  view.rerender(<DocumentReviewCard job={cancelled} service={service} onChange={onChange} />);
  expect(screen.getByText("审阅已取消")).toBeVisible();
  expect(screen.getByText(/已审阅 2.*共 4 块/)).toBeVisible();
  expect(screen.getByText("已提交批次的结论。")).toBeVisible();
});

it.each(["interrupted", "waiting_user"] as const)("does not replay an uncertain request or offer budget recovery for %s", status => {
  const service = fixture();
  render(<DocumentReviewCard job={{ ...running, status, stage_id: "stage-a", checkpoint: { ...running.checkpoint, external_outcome: "unknown", budget_exhausted: true } }} service={service} onChange={vi.fn()} />);
  expect(screen.getByText(/模型请求结果待核对/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "恢复审阅" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "追加预算并继续" })).not.toBeInTheDocument();
  expect(service.resume).not.toHaveBeenCalled();
});

it("keeps incomplete budget edits empty and disables confirmation", () => {
  render(<DocumentReviewCard job={{ ...running, status: "waiting_user", stage_id: "stage-a", checkpoint: { ...running.checkpoint, budget_exhausted: true } }} service={fixture()} onChange={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("追加调用次数"), { target: { value: "" } });
  expect(screen.getByRole("button", { name: "追加预算并继续" })).toBeDisabled();
  expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
});

it("ignores stale action responses after another confirmation stage or account becomes visible", async () => {
  const service = fixture();
  let finish!: (value: DocumentReviewJob) => void;
  vi.mocked(service.confirm).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const onChange = vi.fn();
  const waiting = { ...running, status: "waiting_user" as const, stage_id: "stage-a", checkpoint: { ...running.checkpoint, budget_exhausted: true } };
  const view = render(<DocumentReviewCard job={waiting} service={service} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "追加预算并继续" }));
  view.rerender(<DocumentReviewCard job={{ ...waiting, id: "other-account-job", revision: 7 }} service={service} onChange={onChange} />);
  await act(async () => { finish({ ...running, status: "queued", revision: 3 }); });
  expect(onChange).not.toHaveBeenCalled();
});
