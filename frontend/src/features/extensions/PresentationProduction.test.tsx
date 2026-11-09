import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PresentationProduction } from "./PresentationProduction";
import type { PresentationService } from "./presentation-service";

afterEach(cleanup);

const waitingJob = { id: "a", revision: 1, status: "waiting_user", stage: "stage1_recommended", confirmation_required: true, generation_available: true, cancel_requested: false };
const ready = { available: true, code: "ready", reason: "AI PPT 制作已就绪" };
function openExisting(service: PresentationService) {
  render(<PresentationProduction service={service} onClose={vi.fn()} />);
  return screen.findByLabelText("继续已有任务").then(select => fireEvent.change(select, { target: { value: "a" } }));
}
function mockService(job = waitingJob) {
  return { activity: { list: vi.fn().mockResolvedValue({ jobs: [{ ...job, kind: "ppt.generate" }] }), artifacts: vi.fn().mockResolvedValue({ artifacts: [] }), download: vi.fn().mockResolvedValue(undefined) },
    capabilities: vi.fn().mockResolvedValue(ready), create: vi.fn(),
    get: vi.fn().mockResolvedValue(job), confirmation: vi.fn().mockResolvedValue("/confirmation/"), cancel: vi.fn(), resume: vi.fn() };
}

it("creates a real job and waits for a real confirmation before showing results", async () => {
  const waiting = { id: "a", status: "waiting_user", stage: "stage1_recommended", confirmation_required: true, generation_available: true };
  const service = { activity: { list: vi.fn().mockResolvedValue({ jobs: [] }) },
    capabilities: vi.fn().mockResolvedValue(ready),
    create: vi.fn().mockResolvedValue(waiting), get: vi.fn().mockResolvedValue(waiting),
    confirmation: vi.fn().mockResolvedValue("/api/presentations/a/confirmation/") } as unknown as PresentationService;
  render(<PresentationProduction service={service} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("演示主题与要求"), { target: { value: "季度汇报" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "开始制作" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "开始制作" }));
  await screen.findByRole("button", { name: "打开需求确认页" });
  expect(screen.queryByRole("button", { name: "下载 PPTX" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "打开需求确认页" }));
  await waitFor(() => expect(screen.getByTitle("PPT 需求确认")).toHaveAttribute("src", "/api/presentations/a/confirmation/"));
});

it("shows an API failure instead of simulating successful generation", async () => {
  const service = { activity: { list: vi.fn().mockResolvedValue({ jobs: [] }) },
    capabilities: vi.fn().mockResolvedValue(ready),
    create: vi.fn().mockRejectedValue(new Error("运行包缺失，请准备资源")) } as unknown as PresentationService;
  render(<PresentationProduction service={service} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("演示主题与要求"), { target: { value: "季度汇报" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "开始制作" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "开始制作" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("运行包缺失");
  expect(screen.queryByText("制作完成")).not.toBeInTheDocument();
});

it("allows failed jobs to start over without offering unsupported recovery", async () => {
  const service = mockService({ ...waitingJob, status: "failed", confirmation_required: false });
  await openExisting(service as unknown as PresentationService);
  expect(await screen.findAllByRole("heading", { name: "制作失败" })).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "恢复任务" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "下载 PPTX" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "新建演示文稿" })).toBeEnabled();
});

it("closes the old confirmation document when the backend moves to another stage", async () => {
  const service = mockService();
  await openExisting(service as unknown as PresentationService);
  fireEvent.click(await screen.findByRole("button", { name: "打开需求确认页" }));
  await screen.findByTitle("PPT 需求确认");
  service.get.mockResolvedValue({ ...waitingJob, revision: 2, stage: "stage2_recommended" });
  fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
  await screen.findByRole("button", { name: "打开设计确认页" });
  expect(screen.queryByTitle("PPT 需求确认")).not.toBeInTheDocument();
});

it("describes a companion window when confirmation opens outside the workbench", async () => {
  const service = mockService(); service.confirmation.mockResolvedValue("");
  await openExisting(service as unknown as PresentationService);
  fireEvent.click(await screen.findByRole("button", { name: "打开需求确认页" }));
  expect(await screen.findByText(/确认窗口已打开/)).toBeInTheDocument();
  expect(screen.queryByTitle("PPT 需求确认")).not.toBeInTheDocument();
});

it("does not let an old poll overwrite an acknowledged cancellation", async () => {
  const service = mockService();
  let resolvePoll!: (job: typeof waitingJob) => void;
  service.get.mockResolvedValueOnce(waitingJob).mockImplementation(() => new Promise(resolve => { resolvePoll = resolve; }));
  service.cancel.mockResolvedValue({ ...waitingJob, revision: 3, status: "cancelled", confirmation_required: false });
  await openExisting(service as unknown as PresentationService);
  await screen.findByRole("button", { name: "取消制作" });
  await waitFor(() => expect(service.get).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "取消制作" }));
  await screen.findAllByRole("heading", { name: "制作已取消" });
  await act(async () => resolvePoll(waitingJob));
  expect(screen.getAllByRole("heading", { name: "制作已取消" })).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "打开需求确认页" })).not.toBeInTheDocument();
});

it("loads authenticated artifacts only for a successful job and downloads the published PPTX", async () => {
  const service = mockService({ ...waitingJob, status: "succeeded", confirmation_required: false });
  const pptx = { id: "pptx", filename: "季度汇报.pptx", version: 1, size: 5, media_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
  service.activity.artifacts.mockResolvedValue({ artifacts: [pptx] });
  await openExisting(service as unknown as PresentationService);
  fireEvent.click(await screen.findByRole("button", { name: "下载 PPTX" }));
  await waitFor(() => expect(service.activity.download).toHaveBeenCalledWith(pptx));
});

it("lets keyboard users enter the confirmation iframe from the last workbench control", async () => {
  const service = mockService();
  await openExisting(service as unknown as PresentationService);
  fireEvent.click(await screen.findByRole("button", { name: "打开需求确认页" }));
  await screen.findByTitle("PPT 需求确认");
  const refresh = screen.getByRole("button", { name: "刷新状态" }); refresh.focus();
  const prevented = !fireEvent.keyDown(refresh, { key: "Tab", cancelable: true });
  expect(prevented).toBe(false);
});

it("blocks new jobs until readiness completes and can recheck after configuration", async () => {
  const service = mockService();
  service.capabilities.mockResolvedValueOnce({ available: false, code: "model_unavailable", reason: "请先配置文本模型" });
  render(<PresentationProduction service={service as unknown as PresentationService} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("演示主题与要求"), { target: { value: "汇报" } });
  expect(screen.getByRole("button", { name: "开始制作" })).toBeDisabled();
  expect(await screen.findByText("请先配置文本模型")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "开始制作" })).toBeDisabled();
  expect(service.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "开始制作" })).toBeEnabled());
});

it("keeps history downloads available when new generation is unavailable", async () => {
  const service = mockService({ ...waitingJob, status: "succeeded", confirmation_required: false });
  service.capabilities.mockResolvedValue({ available: false, code: "runtime_missing", reason: "请准备运行包" });
  service.activity.artifacts.mockResolvedValue({ artifacts: [{ id: "ppt", filename: "result.pptx", version: 1, size: 5, media_type: "application/octet-stream" }] });
  await openExisting(service as unknown as PresentationService);
  expect(await screen.findByRole("button", { name: "下载 PPTX" })).toBeEnabled();
});

it("offers retry when the readiness request fails", async () => {
  const service = mockService();
  service.capabilities.mockRejectedValueOnce(new Error("网络暂时不可用"));
  render(<PresentationProduction service={service as unknown as PresentationService} onClose={vi.fn()} />);
  expect(await screen.findByText("网络暂时不可用")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
  await screen.findByText("AI PPT 制作已就绪");
});

it("shows page authoring progress instead of an internal stage identifier", async () => {
  const service = mockService({ ...waitingJob, status: "running", stage: "page_3_ready", confirmation_required: false });
  await openExisting(service as unknown as PresentationService);
  expect(await screen.findAllByRole("heading", { name: "已编排第 3 页" })).toHaveLength(2);
});
