import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentReviewPanel } from "./DocumentReviewPanel";
import { DEFAULT_REVIEW_BUDGET, type DocumentReviewJob, type DocumentReviewService } from "./document-review-service";
import type { LibrarySourceDetail } from "../../types";

afterEach(cleanup);
const target = { source_kind: "library" as const, source_id: 1, source_revision: "a".repeat(64) };
const source = { id: 1, source_revision: target.source_revision, title: "已选资料", mime_type: "text/plain", parse_status: "ready", character_count: 7200 } as LibrarySourceDetail;
const saved: DocumentReviewJob = { id: "saved-review", kind: "document.review", status: "waiting_user", revision: 3, request: { target, conversation_id: 4 }, source_title: "恢复的审阅任务", checkpoint: {}, cancel_requested: false };
function fixture() {
  return { list: vi.fn().mockResolvedValue({ jobs: [] }), create: vi.fn().mockResolvedValue({ ...saved, status: "queued" }), get: vi.fn(), prepareAttachment: vi.fn(), confirm: vi.fn(), resume: vi.fn(), cancel: vi.fn() } as DocumentReviewService;
}
it("refreshes saved work without creating a new job or adding budget", async () => {
  const service = fixture();
  vi.mocked(service.list).mockResolvedValue({ jobs: [saved] });
  render(<DocumentReviewPanel service={service} conversationId={4} source={source} />);
  expect(await screen.findByText("恢复的审阅任务")).toBeVisible();
  expect(service.create).not.toHaveBeenCalled();
  expect(service.confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "刷新审阅任务" }));
  await waitFor(() => expect(service.list).toHaveBeenCalledTimes(2));
  expect(service.create).not.toHaveBeenCalled();
});
it("shows the initial limits and creates only after explicit submission", async () => {
  const service = fixture();
  render(<DocumentReviewPanel service={service} source={source} />);
  fireEvent.click(screen.getByText("全文审阅"));
  expect(screen.getByText(/32 次调用/)).toBeVisible();
  expect(service.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "开始全文审阅" }));
  await waitFor(() => expect(service.create).toHaveBeenCalledOnce());
  expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ target, budget: DEFAULT_REVIEW_BUDGET, idempotency_key: expect.any(String) }));
});
it("reuses the creation receipt after an uncertain HTTP failure", async () => {
  const service = fixture();
  vi.mocked(service.create).mockRejectedValueOnce(new Error("请求超时，请刷新任务后重试")).mockResolvedValueOnce({ ...saved, status: "queued" });
  render(<DocumentReviewPanel service={service} source={source} />);
  fireEvent.click(screen.getByText("全文审阅"));
  fireEvent.click(screen.getByRole("button", { name: "开始全文审阅" }));
  expect(await screen.findByText(/请求超时/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "刷新审阅任务" }));
  await waitFor(() => expect(service.list).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "开始全文审阅" }));
  await waitFor(() => expect(service.create).toHaveBeenCalledTimes(2));
  expect(vi.mocked(service.create).mock.calls[0][0].idempotency_key).toBe(vi.mocked(service.create).mock.calls[1][0].idempotency_key);
});
it("ignores creation results after switching conversation", async () => {
  const service = fixture();
  let finish!: (job: DocumentReviewJob) => void;
  vi.mocked(service.create).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<DocumentReviewPanel service={service} conversationId={4} source={source} />);
  fireEvent.click(screen.getByText("全文审阅"));
  fireEvent.click(screen.getByRole("button", { name: "开始全文审阅" }));
  await waitFor(() => expect(service.create).toHaveBeenCalledOnce());
  view.rerender(<DocumentReviewPanel service={service} conversationId={5} source={source} />);
  await act(async () => finish(saved));
  expect(screen.queryByText("恢复的审阅任务")).not.toBeInTheDocument();
});
