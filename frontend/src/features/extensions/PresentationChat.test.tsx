import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PresentationChat } from "./PresentationChat";
import type { PresentationJob, PresentationService } from "./presentation-service";
beforeEach(() => { vi.stubGlobal("URL", class extends URL { static revokeObjectURL = vi.fn(); }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const waiting: PresentationJob = { id: "job", status: "waiting_user", revision: 2, topic: "季度复盘", page_count: 6, conversation_id: 1, model_name: "文本模型", stage: "stage1_recommended", confirmation_required: true, generation_available: true, cancel_requested: false };
function fixture(jobs: PresentationJob[] = [waiting]) {
  return { list: vi.fn().mockResolvedValue({ jobs, next_cursor: null }),
    capabilities: vi.fn().mockResolvedValue({ available: true, model_name: "文本模型", reason: "制作已就绪" }),
    create: vi.fn().mockResolvedValue({ ...waiting, id: "new" }), get: vi.fn().mockResolvedValue(waiting),
    retry: vi.fn().mockResolvedValue({ ...waiting, status: "queued", confirmation_required: false, revision: 3 }),
    confirmation: vi.fn().mockResolvedValue("/api/confirmation/"), cancel: vi.fn().mockResolvedValue({ ...waiting, status: "cancelled", revision: 3, confirmation_required: false }), resume: vi.fn(),
    activity: { artifacts: vi.fn().mockResolvedValue({ artifacts: [] }), download: vi.fn().mockResolvedValue(undefined) },
    preview: vi.fn().mockResolvedValue("blob:preview") };
}
function view(service: ReturnType<typeof fixture>, conversationId = 1, request = 0) {
  return <PresentationChat service={service as unknown as PresentationService} conversationId={conversationId} request={request} onOpenModelSettings={vi.fn()} />;
}

it("requires a concrete topic after choosing an example before submitting a paid job", async () => {
  const service = fixture([]);
  render(view(service, 1, 1));
  fireEvent.click(screen.getByRole("button", { name: /^知识分享$/ }));
  await waitFor(() => expect(service.capabilities).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "开始制作" })).toBeDisabled();
  expect(service.create).not.toHaveBeenCalled();
  const topic = "面向初学者介绍大语言模型：基本原理、实际应用与练习建议。";
  fireEvent.change(screen.getByLabelText("演示主题与要求"), { target: { value: topic } });
  await waitFor(() => expect(screen.getByRole("button", { name: "开始制作" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "开始制作" }));
  await waitFor(() => expect(service.create).toHaveBeenCalledWith(topic, 8, expect.any(String), 1));
});

it("requires more detail for a previously saved generic knowledge-sharing example", async () => {
  const service = fixture([]);
  render(view(service, 1, 1));
  fireEvent.change(screen.getByLabelText("演示主题与要求"), { target: { value: "面向初学者制作一份知识分享，先解释核心概念，再给出应用场景与练习建议。" } });
  await waitFor(() => expect(service.capabilities).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "开始制作" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("主题");
  expect(service.create).not.toHaveBeenCalled();
});

it("restores conversation tasks, shows real steps and opens the original confirmation", async () => {
  const service = fixture();
  render(view(service));
  expect(await screen.findByRole("heading", { name: "季度复盘" })).toBeVisible();
  expect(service.list.mock.calls[0][0]).toBe(1);
  expect(screen.getByLabelText("制作阶段")).toBeInTheDocument();
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "确认需求" }));
  expect(await screen.findByTitle("PPT 需求确认")).toHaveAttribute("src", "/api/confirmation/");
  expect(service.create).not.toHaveBeenCalled();
});

it("edits a failed job and retries the same conversation task without creating another", async () => {
  const failed = { ...waiting, status: "failed", error_code: "authentication_failed", error: "模型服务认证失败，请检查模型设置", confirmation_required: false } as PresentationJob;
  const service = fixture([failed]);
  render(view(service));
  await screen.findByText("模型服务认证失败，请检查模型设置");
  fireEvent.click(screen.getByRole("button", { name: "编辑要求后重做" }));
  expect(screen.getByLabelText("演示主题与要求")).toHaveValue("季度复盘");
  expect(screen.getByLabelText("建议页数")).toHaveValue(6);
  await waitFor(() => expect(screen.getByRole("button", { name: "保存并重试" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "保存并重试" }));
  await waitFor(() => expect(service.retry).toHaveBeenCalledWith("job", expect.objectContaining({ topic: "季度复盘", page_count: 6, expected_revision: 2, request_id: expect.any(String) })));
  expect(service.create).not.toHaveBeenCalled();
  expect(screen.getAllByRole("article", { name: /PPT：季度复盘/ })).toHaveLength(1);
  expect(service.capabilities).toHaveBeenCalledWith(expect.any(AbortSignal), 1);
});

it("retries the original failed task from its card", async () => {
  const service = fixture([{ ...waiting, status: "failed", confirmation_required: false, retryable: true }]);
  render(view(service));
  fireEvent.click(await screen.findByRole("button", { name: "重试制作" }));
  await waitFor(() => expect(service.retry).toHaveBeenCalledWith("job", expect.objectContaining({ expected_revision: 2, request_id: expect.any(String) })));
  expect(service.create).not.toHaveBeenCalled();
  expect(screen.getAllByRole("article", { name: /PPT：季度复盘/ })).toHaveLength(1);
});

it("retains the original retry target and request key when navigating away from an edited retry", async () => {
  const service = fixture([{ ...waiting, status: "failed", confirmation_required: false, retryable: true }]);
  service.retry.mockRejectedValueOnce(new Error("连接中断"));
  const rendered = render(view(service));
  fireEvent.click(await screen.findByRole("button", { name: "编辑要求后重做" }));
  fireEvent.change(screen.getByLabelText("演示主题与要求"), { target: { value: "更新后的季度复盘主题" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "保存并重试" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "保存并重试" }));
  await screen.findByText("连接中断");
  const originalBody = service.retry.mock.calls[0][1];
  rendered.rerender(view(service, 2));
  rendered.rerender(view(service, 1));
  await waitFor(() => expect(screen.getByRole("button", { name: "保存并重试" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "保存并重试" }));
  await waitFor(() => expect(service.retry).toHaveBeenCalledTimes(2));
  expect(service.retry).toHaveBeenLastCalledWith("job", originalBody);
  expect(service.create).not.toHaveBeenCalled();
});

it("confirms a possibly duplicate model call before retrying an uncertain task", async () => {
  const service = fixture([{ ...waiting, status: "failed", confirmation_required: false, retryable: true, retry_requires_confirmation: true }]);
  render(view(service));
  fireEvent.click(await screen.findByRole("button", { name: "重试制作" }));
  expect(service.retry).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("重复调用");
  fireEvent.click(screen.getByRole("button", { name: "确认重试" }));
  await waitFor(() => expect(service.retry).toHaveBeenCalledWith("job", expect.objectContaining({ acknowledge_uncertain: true })));
  expect(service.create).not.toHaveBeenCalled();
});

it("discards a delayed read after switching conversations", async () => {
  const service = fixture([]);
  let resolveOld!: (value: unknown) => void;
  service.list.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  const rendered = render(view(service));
  rendered.rerender(view(service, 2));
  await waitFor(() => expect(service.list).toHaveBeenCalledWith(2, expect.any(AbortSignal), undefined));
  await act(async () => resolveOld({ jobs: [waiting], next_cursor: null }));
  expect(screen.queryByText("季度复盘")).not.toBeInTheDocument();
});

it("cancels an active job without submitting a second model request", async () => {
  const service = fixture();
  render(view(service));
  fireEvent.click(await screen.findByRole("button", { name: "取消制作" }));
  await screen.findByText("制作已取消");
  expect(service.cancel).toHaveBeenCalledWith("job");
  expect(service.create).not.toHaveBeenCalled();
});

it("polls restored active tasks promptly instead of waiting for the idle interval", async () => {
  vi.useFakeTimers();
  const service = fixture();
  render(view(service));
  await act(async () => { await Promise.resolve(); });
  expect(service.list).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
  expect(service.list).toHaveBeenCalledTimes(2);
});

it("keeps a failed PPT-only restoration visible so the user can retry", async () => {
  const service = fixture([]);
  service.list.mockRejectedValueOnce(new Error("offline"));
  const content = vi.fn();
  render(<PresentationChat service={service as unknown as PresentationService} conversationId={1} request={0} onContentChange={content} onOpenModelSettings={vi.fn()} />);
  await screen.findByRole("button", { name: "重新读取任务" });
  expect(content).toHaveBeenLastCalledWith(1, true);
});

it("does not treat requested pages as the confirmed production total", async () => {
  const service = fixture([{ ...waiting, status: "running", confirmation_required: false, page_count: 8, stage: "page_9_ready" }]);
  render(view(service));
  await screen.findByText("已编排 9 页，正在继续制作。");
  expect(screen.getByText(/建议 8 页/)).toBeInTheDocument();
  expect(screen.queryByText(/9 \/ 8/)).not.toBeInTheDocument();
});

it("loads real artifacts, allows preview recovery and downloads the published PPTX", async () => {
  const service = fixture([{ ...waiting, status: "succeeded", confirmation_required: false }]);
  const pptx = { id: "ppt", filename: "result.pptx", version: 1, size: 10, media_type: "application/octet-stream" };
  service.activity.artifacts.mockResolvedValue({ artifacts: [pptx, { ...pptx, id: "page", filename: "P01.png", media_type: "image/png" }] } as never);
  service.preview.mockRejectedValueOnce(new Error("offline"));
  render(view(service));
  fireEvent.click(await screen.findByRole("button", { name: "重新读取预览" }));
  await screen.findByAltText("第 1 页预览");
  fireEvent.click(screen.getByRole("button", { name: "下载 PPTX" }));
  await waitFor(() => expect(service.activity.download).toHaveBeenCalledWith(pptx));
  expect(service.create).not.toHaveBeenCalled();
});

it("shows only the retried task's latest delivery rather than earlier artifact versions", async () => {
  const service = fixture([{ ...waiting, status: "succeeded", confirmation_required: false, delivery_artifacts: [{ id: "deck", version: 2, filename: "result.pptx" }, { id: "page", version: 2, filename: "P01.png" }] }]);
  const deck = { id: "deck", filename: "result.pptx", version: 2, size: 10, media_type: "application/octet-stream" };
  service.activity.artifacts.mockResolvedValue({ artifacts: [{ ...deck, version: 1 }, deck, { ...deck, id: "page", filename: "P01.png", version: 1, media_type: "image/png" }, { ...deck, id: "page", filename: "P01.png", media_type: "image/png" }, { ...deck, id: "old-extra-page", filename: "P02.png", version: 1, media_type: "image/png" }] } as never);
  render(view(service));
  await screen.findByText("1 页预览已就绪");
  fireEvent.click(screen.getByRole("button", { name: "下载 PPTX" }));
  await waitFor(() => expect(service.activity.download).toHaveBeenCalledWith(deck));
});

it("revokes a preview that arrives after its conversation was left", async () => {
  const success = { ...waiting, status: "succeeded", confirmation_required: false } as PresentationJob;
  const service = fixture([success]);
  service.list.mockImplementation(async (id: number) => ({ jobs: id === 1 ? [success] : [], next_cursor: null }));
  service.activity.artifacts.mockResolvedValue({ artifacts: [{ id: "page", filename: "P01.png", version: 1, size: 5, media_type: "image/png" }] } as never);
  let finish!: (url: string) => void;
  service.preview.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const rendered = render(view(service));
  await waitFor(() => expect(service.preview).toHaveBeenCalledTimes(1));
  rendered.rerender(view(service, 2));
  await act(async () => { finish("blob:late-preview"); });
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:late-preview");
  expect(screen.queryByAltText("第 1 页预览")).not.toBeInTheDocument();
});

it("keeps a draft when switching conversations and returning from settings", async () => {
  const service = fixture([]);
  const rendered = render(view(service, 1, 1));
  fireEvent.change(screen.getByLabelText("演示主题与要求"), { target: { value: "为客户准备项目提案" } });
  fireEvent.change(screen.getByLabelText("建议页数"), { target: { value: "5" } });
  rendered.rerender(view(service, 2));
  expect(screen.queryByRole("form", { name: "PPT 制作要求" })).not.toBeInTheDocument();
  rendered.rerender(view(service, 1));
  expect(screen.getByLabelText("演示主题与要求")).toHaveValue("为客户准备项目提案");
  expect(screen.getByLabelText("建议页数")).toHaveValue(5);
  rendered.unmount();
  render(view(service, 1));
  expect(screen.getByLabelText("演示主题与要求")).toHaveValue("为客户准备项目提案");
  expect(service.create).not.toHaveBeenCalled();
});

it("does not share drafts between authenticated service instances", () => {
  const first = fixture([]), second = fixture([]);
  const rendered = render(view(first, 1, 1));
  fireEvent.change(screen.getByLabelText("演示主题与要求"), { target: { value: "私人制作要求" } });
  rendered.unmount();
  render(view(second, 1, 1));
  expect(screen.getByLabelText("演示主题与要求")).toHaveValue("");
});

it("keeps the original idempotency key when a failed submission is retried after navigation", async () => {
  const service = fixture([]);
  service.create.mockRejectedValueOnce(new Error("连接中断"));
  const rendered = render(view(service, 1, 1));
  fireEvent.change(screen.getByLabelText("演示主题与要求"), { target: { value: "项目汇报" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "开始制作" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "开始制作" }));
  await screen.findByText("连接中断");
  const originalKey = service.create.mock.calls[0][2];
  rendered.unmount();
  render(view(service, 1));
  await waitFor(() => expect(screen.getByRole("button", { name: /开始制作|重新提交/ })).toBeEnabled());
  expect(service.create).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: /开始制作|重新提交/ }));
  await waitFor(() => expect(service.create).toHaveBeenCalledTimes(2));
  expect(service.create.mock.calls[1][2]).toBe(originalKey);
});

it("starts with a fresh draft after a successful submission", async () => {
  const service = fixture([]);
  const rendered = render(view(service, 1, 1));
  fireEvent.change(screen.getByLabelText("演示主题与要求"), { target: { value: "已提交的汇报" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "开始制作" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "开始制作" }));
  await waitFor(() => expect(screen.queryByRole("form", { name: "PPT 制作要求" })).not.toBeInTheDocument());
  rendered.rerender(view(service, 1, 2));
  expect(screen.getByLabelText("演示主题与要求")).toHaveValue("");
});

it("does not clear newly selected requirements when an older submission finishes", async () => {
  const source = { ...waiting, status: "succeeded", confirmation_required: false, topic: "另一份提案" } as PresentationJob;
  const service = fixture([source]);
  let finish!: (value: PresentationJob) => void;
  service.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(view(service, 1, 1));
  fireEvent.change(screen.getByLabelText("演示主题与要求"), { target: { value: "正在提交的旧草稿" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "开始制作" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "开始制作" }));
  fireEvent.click(await screen.findByRole("button", { name: "以此要求新建" }));
  expect(screen.getByLabelText("演示主题与要求")).toHaveValue("另一份提案");
  await act(async () => { finish({ ...waiting, id: "new", topic: "正在提交的旧草稿" }); });
  expect(screen.getByLabelText("演示主题与要求")).toHaveValue("另一份提案");
  expect(service.create).toHaveBeenCalledTimes(1);
});

it("supports page selection, keyboard navigation and downloading inside the preview", async () => {
  const service = fixture([{ ...waiting, status: "succeeded", confirmation_required: false }]);
  const pptx = { id: "ppt", filename: "result.pptx", version: 1, size: 10, media_type: "application/octet-stream" };
  service.activity.artifacts.mockResolvedValue({ artifacts: [pptx, ...[1, 2, 3].map(index => ({ ...pptx, id: `page-${index}`, filename: `P0${index}.png`, media_type: "image/png" }))] } as never);
  render(view(service));
  fireEvent.click(await screen.findByRole("button", { name: "查看逐页预览" }));
  const preview = within(screen.getByRole("dialog", { name: "PPT 逐页预览" }));
  fireEvent.change(preview.getByLabelText("选择幻灯片"), { target: { value: "2" } });
  await preview.findByAltText("第 3 页预览");
  fireEvent.keyDown(document, { key: "ArrowLeft" });
  await preview.findByAltText("第 2 页预览");
  fireEvent.click(preview.getByRole("button", { name: "下载 PPTX" }));
  await waitFor(() => expect(service.activity.download).toHaveBeenCalledWith(pptx));
  service.activity.download.mockRejectedValueOnce(new Error("下载连接中断，请重试"));
  await waitFor(() => expect(preview.getByRole("button", { name: "下载 PPTX" })).toBeEnabled());
  fireEvent.click(preview.getByRole("button", { name: "下载 PPTX" }));
  await preview.findByText("下载连接中断，请重试");
});

it("opens from the cover and remembers the last viewed page in this task", async () => {
  const service = fixture([{ ...waiting, status: "succeeded", confirmation_required: false }]);
  const pages = [1, 2, 3].map(index => ({ id: `page-${index}`, filename: `P0${index}.png`, version: 1, size: 10, media_type: "image/png" }));
  service.activity.artifacts.mockResolvedValue({ artifacts: pages } as never);
  render(view(service));
  fireEvent.click(await screen.findByRole("button", { name: "打开第 1 页预览" }));
  let dialog = within(screen.getByRole("dialog", { name: "PPT 逐页预览" }));
  fireEvent.click(dialog.getByRole("button", { name: "预览第 3 页" }));
  await dialog.findByAltText("第 3 页预览");
  fireEvent.click(dialog.getByRole("button", { name: "关闭窗口" }));
  fireEvent.click(screen.getByRole("button", { name: "查看逐页预览" }));
  dialog = within(screen.getByRole("dialog", { name: "PPT 逐页预览" }));
  await dialog.findByAltText("第 3 页预览");
  fireEvent.click(dialog.getByRole("button", { name: "关闭窗口" }));
  // Clicking the cover deliberately opens the cover rather than the bookmark.
  fireEvent.click(screen.getByRole("button", { name: "打开第 1 页预览" }));
  await within(screen.getByRole("dialog")).findByAltText("第 1 页预览");
});

it("shows a readable title while retaining full multiline requirements for review and recreation", async () => {
  const topic = "AI 智能体架构分享\n面向研发团队，重点解释规划、工具调用和记忆。\n" + "使用提供的资料，避免编造数据。".repeat(20);
  const service = fixture([{ ...waiting, status: "failed", confirmation_required: false, topic }]);
  render(view(service));
  expect(await screen.findByRole("heading", { name: "AI 智能体架构分享" })).toBeVisible();
  const requirements = screen.getByText(topic, { exact: true, normalizer: text => text });
  expect(requirements).not.toBeVisible();
  fireEvent.click(screen.getByText("查看制作要求"));
  expect(requirements).toBeVisible();
  expect(requirements.textContent).toBe(topic);
  fireEvent.click(screen.getByRole("button", { name: "编辑要求后重做" }));
  expect(screen.getByLabelText("演示主题与要求")).toHaveValue(topic);
  expect(service.create).not.toHaveBeenCalled();
});
