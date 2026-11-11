import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerModelPicker } from "./ComposerModelPicker";
import type { ComposerModelSettings } from "./ComposerModelParameters";

const profiles = [
  { id: "p1", model_name: "gpt-5.5", connection_id: "service-a", connection_name: "主连接" },
  { id: "p2", model_name: "claude-x", connection_id: "service-a", connection_name: "主连接" }
];
function setup(overrides: Partial<Parameters<typeof ComposerModelPicker>[0]> = {}) {
  const props = {
    configured: true, currentModelName: "gpt-5.5", defaultModelName: "gpt-5.5", profiles, selectedProfileId: "p1",
    profileDisabled: false, serviceUnavailable: false, busy: false, canSelect: true,
    serviceModels: { connection_id: "service-a", connection_name: "主连接", revision: 1, models: ["gpt-5.5", "claude-x"], busy: false, error: "" },
    onChange: vi.fn(), onOpenSettings: vi.fn(), ...overrides
  };
  const view = render(<ComposerModelPicker {...props} />);
  return { ...props, view };
}
const openMenu = () => fireEvent.click(screen.getByRole("button", { name: /切换模型/ }));
afterEach(cleanup);

describe("ComposerModelPicker", () => {
  it("keeps cached models selectable when legacy metadata has no output types", () => {
    setup({ serviceModels: { connection_id: "service-a", connection_name: "主连接", revision: 1, models: ["gpt-5.5"], entries: [{ id: "gpt-5.5", output_types: [], output_types_source: "unknown" }], source: "cache", busy: false, error: "" } });
    openMenu();
    expect(screen.getByRole("option", { name: "gpt-5.5" })).toHaveAttribute("aria-selected", "true");
  });
  it("uses provider output metadata for opaque IDs and leaves video disabled", () => {
    const onServiceChange = vi.fn();
    setup({ onServiceChange, additionalServiceModels: [{ connection_id: "gateway", connection_name: "Gateway", revision: 1, busy: false, error: "", models: ["vendor/paint-alias", "vendor/movie-alias"], entries: [
      { id: "vendor/paint-alias", output_types: ["image"], output_types_source: "provider" },
      { id: "vendor/movie-alias", output_types: ["video"], output_types_source: "provider" }
    ] }] });
    openMenu();
    expect(screen.queryByRole("option", { name: "vendor/paint-alias" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "vendor/movie-alias" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "视频" }));
    expect(screen.getByRole("option", { name: "vendor/movie-alias" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "图片" }));
    fireEvent.click(screen.getByRole("option", { name: "vendor/paint-alias" }));
    expect(onServiceChange).toHaveBeenCalledWith("vendor/paint-alias", "gateway");
  });
  it("edits the active model parameters without switching models and keeps field keyboard input local", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const props = setup({ modelSettings: {
      profile: { id: "p1", connection_id: "c1", model_name: "gpt-5.5", enabled: true, revision: 3 },
      fetchJson: vi.fn().mockResolvedValue({ protocol: "responses", capabilities: { reasoning: { status: "supported" } }, max_output_tokens: { tokens: null } }) as unknown as ComposerModelSettings["fetchJson"],
      onSave
    } });
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "思考设置" }));
    await screen.findByTitle(/思考越深入/);
    const effort = screen.getByLabelText("思考程度");
    effort.focus();
    fireEvent.keyDown(effort, { key: "ArrowDown" });
    expect(effort).toHaveFocus();
    fireEvent.change(effort, { target: { value: "high" } });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("p1", 3, { reasoning_effort: "high" }));
    expect(props.onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(effort, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "模型与参数" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /切换模型，当前/ })).toHaveFocus();
  });

  it("loads service models on opening and selects an unsaved model on the same service", async () => {
    const props = setup({
      profiles: profiles.map(profile => ({ ...profile, connection_id: profile.id === "p1" ? "service-a" : "service-b" })),
      serviceModels: { connection_id: "service-a", connection_name: "主连接", revision: 1, models: ["gpt-5.5", "grok-model", "claude-model"], busy: false, error: "" },
      onDiscover: vi.fn().mockResolvedValue(undefined), onServiceChange: vi.fn().mockResolvedValue(undefined)
    });
    openMenu();
    await waitFor(() => expect(props.onDiscover).toHaveBeenCalledOnce());
    expect(screen.getAllByRole("option", { name: "gpt-5.5" })).toHaveLength(1);
    expect(screen.getByRole("option", { name: "claude-model" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "grok-model" }));
    expect(props.onServiceChange).toHaveBeenCalledWith("grok-model", "service-a");
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("queries again when reopened without waiting for a manual refresh", () => {
    const props = setup({ onDiscover: vi.fn().mockResolvedValue(undefined) });
    openMenu();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    openMenu();
    expect(props.onDiscover).toHaveBeenCalledTimes(2);
  });

  it("switches to a saved image model on another connection and back to a chat model", () => {
    const image = { id: "image-profile", model_name: "gpt-image-1", connection_id: "image-service", connection_name: "生图服务" };
    const additionalServiceModels = [{ connection_id: "image-service", connection_name: "生图服务", revision: 2, models: ["gpt-image-1"], busy: false, error: "" }];
    const { view, ...props } = setup({ profiles: [...profiles, image], additionalServiceModels });
    openMenu();
    fireEvent.click(screen.getByRole("tab", { name: "图片" }));
    fireEvent.click(within(screen.getByRole("group", { name: "生图服务" })).getByRole("option", { name: "gpt-image-1" }));
    expect(props.onChange).toHaveBeenLastCalledWith("image-profile");
    view.rerender(<ComposerModelPicker {...props} currentModelName="gpt-image-1" selectedProfileId="image-profile"
      serviceModels={additionalServiceModels[0]} additionalServiceModels={[props.serviceModels!]} />);
    openMenu();
    expect(screen.getByRole("option", { name: "gpt-image-1" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "图片" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "对话" }));
    fireEvent.click(within(screen.getByRole("group", { name: "主连接" })).getByRole("option", { name: "gpt-5.5" }));
    expect(props.onChange).toHaveBeenLastCalledWith("p1");
  });

  it("keeps model names scoped to their connection when choosing an unsaved image model", () => {
    const props = setup({ additionalServiceModels: [{ connection_id: "image-service", connection_name: "生图服务", revision: 2, models: ["gpt-5.5", "gpt-image-1"], busy: false, error: "" }], onServiceChange: vi.fn().mockResolvedValue(undefined) });
    openMenu();
    const group = within(screen.getByRole("group", { name: "生图服务" }));
    expect(group.getByRole("option", { name: "gpt-5.5" })).toHaveAttribute("aria-selected", "false");
    fireEvent.click(screen.getByRole("tab", { name: "图片" }));
    fireEvent.click(screen.getByRole("option", { name: "gpt-image-1" }));
    expect(props.onServiceChange).toHaveBeenCalledWith("gpt-image-1", "image-service");
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("allows switching to an image service when the chat service catalog fails", () => {
    const props = setup({ serviceModels: { connection_id: "service-a", connection_name: "主连接", revision: 1, models: [], busy: false, error: "聊天服务暂不可用" }, additionalServiceModels: [{ connection_id: "image-service", connection_name: "生图服务", revision: 2, models: ["gpt-image-1"], busy: false, error: "" }], onServiceChange: vi.fn().mockResolvedValue(undefined) });
    openMenu();
    expect(screen.getByRole("alert")).toHaveTextContent("聊天服务暂不可用");
    fireEvent.click(screen.getByRole("tab", { name: "图片" }));
    fireEvent.click(screen.getByRole("option", { name: "gpt-image-1" }));
    expect(props.onServiceChange).toHaveBeenCalledWith("gpt-image-1", "image-service");
  });

  it("separates output categories within one service without changing the selected model on tab clicks", () => {
    const props = setup({ serviceModels: { connection_id: "service-a", connection_name: "统一服务", revision: 1, models: ["gpt-5.5", "qwen3-vl", "gpt-image-1", "sora-2"], busy: false, error: "" }, onServiceChange: vi.fn() });
    openMenu();
    expect(screen.getByRole("tab", { name: "对话" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "qwen3-vl" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "gpt-image-1" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "图片" }));
    expect(screen.getByRole("option", { name: "gpt-image-1" })).toBeEnabled();
    expect(screen.queryByRole("option", { name: "gpt-5.5" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "视频" }));
    expect(screen.getByRole("option", { name: "sora-2" })).toBeDisabled();
    expect(screen.getByText("视频生成接口暂未接入，视频模型暂不可选。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "sora-2" }));
    expect(props.onServiceChange).not.toHaveBeenCalled();
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("navigates category tabs with the keyboard and shows a category-specific empty state", () => {
    setup(); openMenu();
    const chat = screen.getByRole("tab", { name: "对话" });
    chat.focus();
    fireEvent.keyDown(chat, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "图片" })).toHaveFocus();
    expect(screen.getByText("暂无图片模型，可前往管理模型添加生图服务")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("tab", { name: "图片" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "视频" })).toHaveFocus();
    expect(screen.getByText("暂无视频模型")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("tab", { name: "视频" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "对话" })).toHaveAttribute("aria-selected", "true");
  });

  it("shows only returned models without source badges or saved-only profiles", () => {
    const props = setup({
      profiles: [{ id: "legacy", model_name: "saved-only", connection_id: "service-a", connection_name: "主连接" }, { id: "p1", model_name: "gpt-5.5", connection_id: "service-a", connection_name: "主连接" }, { id: "p2", model_name: "gpt-5.5", connection_id: "service-b", connection_name: "备用连接" }],
      serviceModels: { connection_id: "service-a", connection_name: "主连接", revision: 1, models: ["gpt-5.5", "fresh-model", "gpt-5.5"], busy: false, error: "" }
    });
    openMenu();
    expect(screen.getAllByRole("option").map(item => item.getAttribute("aria-label"))).toEqual(["gpt-5.5", "fresh-model"]);
    expect(screen.queryByText(/服务返回|已保存|上次返回/)).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "saved-only" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "gpt-5.5" }));
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("retains only service results during loading and failure without clearing selection", () => {
    const { view, ...props } = setup({
      profiles: [{ id: "p1", model_name: "gpt-5.5", connection_id: "service-a", connection_name: "主连接" }],
      serviceModels: { connection_id: "service-a", connection_name: "主连接", revision: 1, models: ["gpt-5.5", "fresh-model"], busy: false, error: "" },
      onDiscover: vi.fn().mockResolvedValue(undefined)
    });
    openMenu();
    view.rerender(<ComposerModelPicker {...props} serviceModels={{ ...props.serviceModels!, busy: true }} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在更新模型列表");
    expect(screen.getByRole("option", { name: "gpt-5.5" })).toHaveAttribute("aria-selected", "true");
    expect(props.onDiscover).toHaveBeenCalledOnce();
    view.rerender(<ComposerModelPicker {...props} serviceModels={{ ...props.serviceModels!, error: "服务暂时不可用" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("服务暂时不可用");
    expect(screen.getByRole("option", { name: "gpt-5.5" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(props.onDiscover).toHaveBeenLastCalledWith(true, "service-a");
  });

  it("shows persisted cache state while refreshing and retains options on failure", () => {
    const onDiscover = vi.fn().mockResolvedValue(undefined);
    const service = { connection_id: "service-a", connection_name: "主连接", revision: 1, models: ["gpt-5.5", "fresh-model"], source: "cache" as const, discoveredAt: "2026-01-02T03:04:05Z", busy: false, error: "" };
    const { view, ...props } = setup({ serviceModels: service, onDiscover });
    openMenu();
    expect(onDiscover).toHaveBeenCalledOnce();
    expect(onDiscover).toHaveBeenCalledWith();
    expect(screen.getByText("上次获取，可能不是最新")).toHaveAttribute("title", "获取时间：2026-01-02T03:04:05Z");
    fireEvent.click(screen.getByRole("button", { name: "刷新模型列表" }));
    expect(onDiscover).toHaveBeenLastCalledWith(true);
    view.rerender(<ComposerModelPicker {...props} serviceModels={{ ...service, busy: true }} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在更新模型列表");
    expect(screen.getByRole("option", { name: "gpt-5.5" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "fresh-model" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "刷新模型列表" })).toBeDisabled();
    view.rerender(<ComposerModelPicker {...props} serviceModels={{ ...service, error: "连接超时" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("更新失败，显示上次读取的模型。 连接超时");
    expect(screen.getByText("上次获取，可能不是最新")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "fresh-model" })).toBeInTheDocument();
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("shows only supplied saved-only models before a directory is read and retains them on failure", () => {
    const onDiscover = vi.fn().mockResolvedValue(undefined);
    const service = { connection_id: "service-a", connection_name: "主连接", revision: 1, models: [], savedOnly: ["gpt-5.5"], busy: false, error: "" };
    const { view, ...props } = setup({ serviceModels: service, onDiscover });
    openMenu();
    const current = screen.getByRole("option", { name: "gpt-5.5" });
    expect(current).toHaveAttribute("aria-selected", "true");
    expect(current).toHaveAccessibleDescription("已保存");
    expect(screen.getByText("显示已保存模型，尚未读取服务目录")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "claude-x" })).not.toBeInTheDocument();
    expect(screen.queryByText(/当前选择服务未返回/)).not.toBeInTheDocument();
    view.rerender(<ComposerModelPicker {...props} serviceModels={{ ...service, busy: true }} />);
    expect(screen.getByRole("option", { name: "gpt-5.5" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("status")).toHaveTextContent("正在更新模型列表");
    view.rerender(<ComposerModelPicker {...props} serviceModels={{ ...service, error: "连接超时" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("读取失败，显示已保存模型。 连接超时");
    expect(screen.getByText("显示已保存模型，尚未读取服务目录")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onDiscover).toHaveBeenLastCalledWith(true, "service-a");
  });

  it("selects a supplied saved-only profile rather than creating a service model", () => {
    const onServiceChange = vi.fn().mockResolvedValue(undefined);
    const props = setup({
      serviceModels: { connection_id: "service-a", connection_name: "主连接", revision: 1, models: [], savedOnly: ["gpt-5.5", "claude-x"], busy: false, error: "" },
      onServiceChange
    });
    openMenu();
    expect(screen.getByRole("option", { name: "claude-x" })).toHaveAccessibleDescription("已保存");
    fireEvent.click(screen.getByRole("option", { name: "claude-x" }));
    expect(props.onChange).toHaveBeenCalledWith("p2");
    expect(onServiceChange).not.toHaveBeenCalled();
  });

  it("marks the current saved choice missing from a live catalog without duplicating returned names", () => {
    setup({ serviceModels: { connection_id: "service-a", connection_name: "主连接", revision: 1, models: ["claude-x"], savedOnly: ["gpt-5.5", "claude-x", "gpt-5.5"], source: "live", busy: false, error: "" } });
    openMenu();
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getByRole("option", { name: "gpt-5.5" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "gpt-5.5" })).toHaveAccessibleDescription("已保存 · 当前选择服务未返回");
    expect(screen.getByRole("option", { name: "claude-x" })).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText("上次获取，可能不是最新")).not.toBeInTheDocument();
  });

  it("reports a missing directory even when there are no saved options", () => {
    setup({ serviceModels: { connection_id: "service-a", connection_name: "主连接", revision: 1, models: [], savedOnly: [], busy: false, error: "" } });
    openMenu();
    expect(screen.getByText("尚未读取服务目录")).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("keeps a saved current choice when a known catalog is empty", () => {
    setup({ serviceModels: { connection_id: "service-a", connection_name: "主连接", revision: 1, models: [], savedOnly: ["gpt-5.5"], source: "cache", busy: false, error: "" } });
    openMenu();
    expect(screen.getByRole("option", { name: "gpt-5.5" })).toHaveAccessibleDescription("已保存 · 当前选择服务未返回");
    expect(screen.getByText("上次获取，可能不是最新")).toBeInTheDocument();
    expect(screen.queryByText("显示已保存模型，尚未读取服务目录")).not.toBeInTheDocument();
  });

  it("retries only the failing service while the footer refreshes all services", () => {
    const onDiscover = vi.fn().mockResolvedValue(undefined);
    setup({ onDiscover, additionalServiceModels: [
      { connection_id: "service-b", connection_name: "备用连接", revision: 1, models: ["b-model"], source: "cache", busy: false, error: "备用服务超时" },
      { connection_id: "service-c", connection_name: "第三连接", revision: 1, models: [], busy: true, error: "第三服务超时" }
    ] });
    openMenu();
    const failedService = within(screen.getByRole("group", { name: "备用连接" }));
    expect(failedService.getByRole("alert")).toHaveTextContent("备用服务超时");
    expect(failedService.getByRole("option", { name: "b-model" })).toBeEnabled();
    fireEvent.click(failedService.getByRole("button", { name: "重试" }));
    expect(onDiscover).toHaveBeenLastCalledWith(true, "service-b");
    expect(within(screen.getByRole("group", { name: "第三连接" })).getByRole("button", { name: "重试" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "刷新模型列表" })).toBeDisabled();
  });

  it("shows the active service in the trigger name and tooltip, including after switching", () => {
    const backup = { id: "backup", model_name: "gpt-5.5", connection_id: "service-b", connection_name: "备用连接" };
    const backupService = { connection_id: "service-b", connection_name: "备用连接", revision: 1, models: ["gpt-5.5"], busy: false, error: "" };
    const { view, ...props } = setup({ profiles: [...profiles, backup], additionalServiceModels: [backupService] });
    expect(screen.getByRole("button", { name: /切换模型，当前 gpt-5.5，服务 主连接/ })).toHaveAttribute("title", "当前模型：gpt-5.5；当前服务：主连接");
    view.rerender(<ComposerModelPicker {...props} currentModelName="gpt-5.5" selectedProfileId="backup" serviceModels={backupService} />);
    expect(screen.getByRole("button", { name: /切换模型，当前 gpt-5.5，服务 备用连接/ })).toHaveAttribute("title", "当前模型：gpt-5.5；当前服务：备用连接");
    view.rerender(<ComposerModelPicker {...props} currentModelName="fresh-model" selectedProfileId={null} serviceModels={backupService} />);
    expect(screen.getByRole("button", { name: /服务 备用连接/ })).toHaveAttribute("title", "当前模型：fresh-model；当前服务：备用连接");
  });

  it("does not invent a disabled model option during discovery or retry", () => {
    const onDiscover = vi.fn().mockResolvedValue(undefined);
    const service = { connection_id: "service-a", connection_name: "主连接", revision: 1, models: [], savedOnly: ["claude-x"], busy: false, error: "" };
    const { view, ...props } = setup({ currentModelName: "disabled-model", selectedProfileId: "disabled", profileDisabled: true, serviceModels: service, onDiscover });
    openMenu();
    expect(screen.queryByRole("option", { name: "disabled-model" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "claude-x" })).toBeEnabled();
    view.rerender(<ComposerModelPicker {...props} serviceModels={{ ...service, busy: true }} />);
    view.rerender(<ComposerModelPicker {...props} serviceModels={{ ...service, error: "连接超时" }} />);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onDiscover).toHaveBeenLastCalledWith(true, "service-a");
    expect(screen.queryByRole("option", { name: "disabled-model" })).not.toBeInTheDocument();
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("marks the current unsaved service model as selected", () => {
    setup({ selectedProfileId: null, currentModelName: "fresh-model", serviceModels: { connection_id: "service-a", connection_name: "主连接", revision: 1, models: ["fresh-model"], busy: false, error: "" } });
    openMenu();
    expect(screen.getByRole("option", { name: "fresh-model" })).toHaveAttribute("aria-selected", "true");
  });

  it("marks a saved-only current model with no selected profile", () => {
    setup({ selectedProfileId: null, currentModelName: "gpt-5.5", serviceModels: { connection_id: "service-a", connection_name: "主连接", revision: 1, models: [], savedOnly: ["gpt-5.5"], source: "live", busy: false, error: "" } });
    openMenu();
    expect(screen.getByRole("option", { name: "gpt-5.5" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "gpt-5.5" })).toHaveAccessibleDescription("已保存 · 当前选择服务未返回");
  });

  it("does not fall back to saved models after the first query fails and exposes a retry", () => {
    const props = setup({ serviceModels: { connection_id: "service-a", connection_name: "主连接", revision: 1, models: [], busy: false, error: "服务暂时不可用" }, onDiscover: vi.fn().mockResolvedValue(undefined) });
    openMenu();
    expect(screen.getByRole("alert")).toHaveTextContent("服务暂时不可用");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(props.onDiscover).toHaveBeenCalledWith(true, "service-a");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(props.onChange).not.toHaveBeenCalled();
  });
  it("reuses the saved profile when a returned model is selected", () => {
    const props = setup();
    openMenu();
    expect(screen.getByRole("listbox", { name: "选择模型" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /跟随默认/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "gpt-5.5" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("option", { name: "claude-x" }));
    expect(props.onChange).toHaveBeenCalledWith("p2");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("omits search and refresh controls while preserving keyboard model navigation", () => {
    setup();
    openMenu();
    expect(screen.queryByRole("textbox", { name: "搜索模型" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新模型列表" })).not.toBeInTheDocument();
    const current = screen.getByRole("option", { name: "gpt-5.5" });
    const next = screen.getByRole("option", { name: "claude-x" });
    expect(current).toHaveFocus();
    fireEvent.keyDown(current, { key: "ArrowDown" });
    expect(next).toHaveFocus();
    fireEvent.keyDown(next, { key: "ArrowDown" });
    expect(current).toHaveFocus();
    fireEvent.keyDown(current, { key: "ArrowUp" });
    expect(next).toHaveFocus();
  });

  it("removes a model no longer returned even when its profile remains saved", () => {
    const { view, ...props } = setup();
    openMenu();
    view.rerender(<ComposerModelPicker {...props} serviceModels={{ ...props.serviceModels, models: ["claude-x"] }} />);
    expect(screen.queryByRole("option", { name: "gpt-5.5" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("does not display saved profiles when there is no service catalog", () => {
    setup({ serviceModels: undefined });
    openMenu();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/服务尚未返回可选模型/)).toBeInTheDocument();
  });

  it("closes on Escape and opens model settings from the footer", () => {
    const props = setup();
    openMenu();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "管理模型" }));
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
  });

  it("asks the user to configure a model when none is available", () => {
    const props = setup({ configured: false });
    expect(screen.queryByRole("button", { name: /切换模型/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "未配置模型，去设置" }));
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
  });

  it("warns when the model service is unavailable but still allows switching", () => {
    setup({ serviceUnavailable: true });
    expect(screen.getByRole("status")).toHaveTextContent("服务不可用");
    openMenu();
    expect(screen.getByText("当前模型服务不可用，可以换一个模型或检查设置")).toBeInTheDocument();
  });

  it("warns about a disabled conversation model without adding it to the returned list", () => {
    setup({ profileDisabled: true, selectedProfileId: "gone", currentModelName: "old-model" });
    expect(screen.getByRole("status")).toHaveTextContent("已停用");
    openMenu();
    expect(screen.queryByRole("option", { name: /old-model/ })).not.toBeInTheDocument();
    expect(screen.getByText("当前模型已停用，请换一个模型")).toBeInTheDocument();
  });
});
