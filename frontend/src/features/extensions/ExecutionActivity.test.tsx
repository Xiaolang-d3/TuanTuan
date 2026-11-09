import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExecutionActivity } from "./ExecutionActivity";
import type { ActivityService, BackgroundJob } from "./activity-service";

afterEach(cleanup);

function fixture() {
  let job: BackgroundJob = { id: "job-one", kind: "presentation", request: { topic: "季度汇报" }, status: "waiting_user", revision: 3, stage_id: "stage-one", prompt: "确认制作这份演示文稿？", answer_schema: { properties: { approved: { type: "boolean" } } }, checkpoint: {}, cancel_requested: false };
  const service: ActivityService = {
    environment: vi.fn().mockResolvedValue({ available: false, code: "engine_missing", reason: "未安装 Docker，执行型技能暂不可用" }),
    list: vi.fn(async () => ({ jobs: [job] })),
    get: vi.fn(async () => job),
    events: vi.fn().mockResolvedValue({ events: [{ cursor: 1, type: "waiting_user", data: {} }] }),
    artifacts: vi.fn().mockResolvedValue({ artifacts: [{ id: "file-one", version: 2, filename: "report.custom", size: 32, media_type: "application/octet-stream" }] }),
    confirm: vi.fn(async (_id, stage, revision, answer) => {
      expect(stage).toBe("stage-one"); expect(revision).toBe(3); expect(answer).toEqual({ approved: true });
      job = { ...job, status: "queued", revision: 4 }; return job;
    }),
    cancel: vi.fn(async () => { job = { ...job, status: "cancelled", cancel_requested: true }; return job; }),
    resume: vi.fn(async () => job),
    download: vi.fn().mockResolvedValue(undefined)
  };
  return service;
}

it("shows real environment status and uses the current stage/revision for explicit confirmation", async () => {
  const service = fixture();
  render(<ExecutionActivity service={service} />);
  expect(await screen.findByText("未安装 Docker，执行型技能暂不可用")).toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: /季度汇报/ }));
  fireEvent.click(await screen.findByRole("button", { name: "确认继续" }));
  await waitFor(() => expect(service.confirm).toHaveBeenCalledTimes(1));
  expect(await screen.findByRole("button", { name: "取消任务" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "下载 report.custom v2" }));
  await waitFor(() => expect(service.download).toHaveBeenCalledWith(expect.objectContaining({ id: "file-one", version: 2 })));
});

it("surfaces stale confirmation and does not claim the task succeeded", async () => {
  const service = fixture();
  vi.mocked(service.confirm).mockRejectedValue(new Error("确认页面已过期，请刷新"));
  render(<ExecutionActivity service={service} />);
  fireEvent.click(await screen.findByRole("button", { name: /季度汇报/ }));
  fireEvent.click(await screen.findByRole("button", { name: "确认继续" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("确认页面已过期");
  expect(screen.queryByText("已完成")).not.toBeInTheDocument();
});

it("reports request failure without substituting preview jobs", async () => {
  const service = fixture();
  vi.mocked(service.list).mockRejectedValue(new Error("任务服务暂不可用"));
  render(<ExecutionActivity service={service} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("任务服务暂不可用");
  expect(screen.queryByText("季度汇报")).not.toBeInTheDocument();
});

it("returns mixed confirmation schemas to their workflow instead of sending an incomplete answer", async () => {
  const service = fixture();
  const original = await service.get("job-one");
  vi.mocked(service.get).mockResolvedValue({ ...original, answer_schema: { type: "object", properties: { approved: { type: "boolean" }, title: { type: "string" } }, required: ["approved", "title"] } });
  render(<ExecutionActivity service={service} />);
  fireEvent.click(await screen.findByRole("button", { name: /季度汇报/ }));
  expect(await screen.findByText("请回到原工作流填写这一步所需的信息。")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "确认继续" })).not.toBeInTheDocument();
});
