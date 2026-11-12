import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PresentationJobCard } from "./PresentationJobCard";
import type { PresentationJob, PresentationService } from "./presentation-service";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const running = { id: "one", status: "running", revision: 1, topic: "季度复盘", page_count: 8, stage: "spec_ready", confirmation_required: false, generation_available: true, cancel_requested: false } as PresentationJob;
const requestProgress = { activity: "正在生成第 4 页", started_at: "2026-11-05 00:00:00", pages_completed: 3, pages_total: null, outcome_uncertain: false };
function fixture() {
  return { get: vi.fn().mockResolvedValue(running), create: vi.fn(), resume: vi.fn(), activity: { artifacts: vi.fn().mockResolvedValue({ artifacts: [] }) } } as unknown as PresentationService;
}
function view(job: PresentationJob, service = fixture(), onChange = vi.fn(), onRecreate = vi.fn()) {
  return <PresentationJobCard job={job} service={service} onChange={onChange} onRecreate={onRecreate} onOpenModelSettings={vi.fn()} />;
}

// Losing the server timestamp or treating its timezone as local makes this fail.
it("uses the current server request clock and resets when another request starts", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-05T00:01:05Z"));
  const job = { ...running, progress: requestProgress };
  const result = render(view(job));
  expect(screen.getByText("正在生成第 4 页")).toBeVisible();
  expect(screen.getByText(/本次请求已等待 1 分 5 秒/)).toBeVisible();
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.getByText(/本次请求已等待 1 分 7 秒/)).toBeVisible();
  result.rerender(view({ ...job, progress: { ...requestProgress, activity: "正在编写逐页讲稿", started_at: "2026-11-05T00:01:06Z" } }));
  expect(screen.getByText(/本次请求已等待 1 秒/)).toBeVisible();
});

it.each(["waiting_user", "queued", "failed", "interrupted", "cancelled", "succeeded"] as const)("does not keep a live request clock for %s", status => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-05T00:01:05Z"));
  render(view({ ...running, status, progress: requestProgress }));
  act(() => vi.advanceTimersByTime(30_000));
  expect(screen.queryByText(/本次请求已等待/)).not.toBeInTheDocument();
  expect(screen.queryByText("正在生成第 4 页")).not.toBeInTheDocument();
});

it.each([null, "invalid-date", "2026-11-06T00:00:00Z"])("does not invent elapsed time for timestamp %s", started_at => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-05T00:01:05Z"));
  render(view({ ...running, progress: { ...requestProgress, started_at } }));
  expect(screen.getByText("正在生成第 4 页")).toBeVisible();
  expect(screen.queryByText(/本次请求已等待/)).not.toBeInTheDocument();
});

it("stops the request clock as the task leaves running and cleans it up on unmount", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-05T01:02:03Z"));
  const job = { ...running, progress: requestProgress };
  const result = render(view(job));
  expect(screen.getByText(/本次请求已等待 1 小时 2 分 3 秒/)).toBeVisible();
  result.rerender(view({ ...job, status: "waiting_user", confirmation_required: true }));
  act(() => vi.advanceTimersByTime(5000));
  expect(screen.queryByText(/本次请求已等待/)).not.toBeInTheDocument();
  expect(vi.getTimerCount()).toBe(0);
  result.rerender(view(job));
  expect(screen.getByText(/本次请求已等待 1 小时 2 分 8 秒/)).toBeVisible();
  result.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("retains verified pages after failure without using requested pages as a denominator", () => {
  const result = render(view({ ...running, status: "failed", progress: requestProgress }));
  expect(screen.getByText(/已完成 3 页/)).toBeVisible();
  expect(screen.getByText(/总页数待确认/)).toBeVisible();
  expect(screen.queryByText(/3\s*\/\s*8|37.5%/)).not.toBeInTheDocument();
  result.rerender(view({ ...running, status: "interrupted", progress: { ...requestProgress, pages_total: 6 } }));
  expect(screen.getByText(/已完成 3 页/)).toBeVisible();
  expect(screen.getByText(/共 6 页/)).toBeVisible();
});

it("describes historical connection failure and makes refresh a state-only action", async () => {
  const service = fixture(); const onChange = vi.fn(); const onRecreate = vi.fn();
  const failed = { ...running, status: "failed", error_code: "service_unavailable", error: "模型服务暂时不可用，请稍后重试。", progress: requestProgress } as PresentationJob;
  render(view(failed, service, onChange, onRecreate));
  expect(screen.getByRole("alert")).toHaveTextContent(/当次.*连接失败/);
  expect(screen.getByRole("alert")).not.toHaveTextContent("暂时不可用");
  expect(screen.getByText(/刷新.*只.*更新状态.*不会重新制作/)).toBeVisible();
  expect(screen.getByText(/重试与编辑要求都在原任务继续/)).toBeVisible();
  expect(screen.queryByText(/结果待核对/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(running));
  expect(service.get).toHaveBeenCalledWith("one");
  expect(service.create).not.toHaveBeenCalled();
  expect(service.resume).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "编辑要求后重做" }));
  expect(onRecreate).toHaveBeenCalledWith(failed);
});

it("shows uncertain outcome guidance only when explicitly reported on a stopped job", () => {
  const result = render(view({ ...running, status: "failed", progress: { ...requestProgress, outcome_uncertain: true } }));
  expect(screen.getByText(/结果待核对.*不会自动重复请求/)).toBeVisible();
  result.rerender(view({ ...running, status: "failed" }));
  expect(screen.queryByText(/结果待核对/)).not.toBeInTheDocument();
  expect(screen.getByText(/原要求已保留/)).toBeVisible();
  expect(screen.queryByText(/本次请求已等待/)).not.toBeInTheDocument();
});

it.each([
  ["design_spec", "编写设计规格"],
  ["page.p03", "页面编排"],
  ["speaker_notes", "讲稿编写"],
  ["stage2", "拟定设计方案"],
] as const)("names the precise failed stage %s when the backend reports it", (stage, label) => {
  render(view({ ...running, status: "failed", error_stage: stage }));
  expect(screen.getByText(`失败阶段：${label}。原要求已保留。`)).toBeVisible();
});

it("falls back to the coarse phase label without a reported stage", () => {
  render(view({ ...running, status: "failed", stage: "final_confirmed" }));
  expect(screen.getByText("失败阶段：页面与讲稿。原要求已保留。")).toBeVisible();
});
