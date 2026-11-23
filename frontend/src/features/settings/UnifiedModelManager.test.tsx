import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalog } from "../../types";
import { UnifiedModelManager } from "./UnifiedModelManager";

afterEach(cleanup);
const catalog: ModelCatalog = {
  connections: [
    { id: "one", name: "服务甲", model_base_url: "https://one.test/v1", model_protocol: "auto", api_key_configured: true, enabled: true, revision: 2 },
    { id: "two", name: "服务乙", model_base_url: "https://two.test/v1", model_protocol: "auto", api_key_configured: true, enabled: true, revision: 3 }
  ],
  profiles: [
    { id: "p1", connection_id: "one", model_name: "gpt-4.1", enabled: true, revision: 4, supported_purposes: ["chat"], output_types: ["chat"], capabilities: { chat: "supported", vision: "supported" }, context_limit: 99999, reasoning_effort: "low" },
    { id: "p2", connection_id: "two", model_name: "gpt-4.1", enabled: true, revision: 5, supported_purposes: ["chat"], output_types: ["chat"] },
    { id: "image", connection_id: "two", model_name: "gpt-image-2", enabled: true, revision: 1, supported_purposes: ["image"], output_types: ["image"] },
    { id: "video", connection_id: "two", model_name: "sora-2", enabled: true, revision: 1, supported_purposes: [], output_types: ["video"] }
  ], default_profile_id: "p1", purpose_defaults: { chat: "p1", image: null }, purpose_version: 7, service_connection_id: "one"
};
function props(overrides = {}) {
  return { catalog, loading: false, busy: false, error: "", fetchJson: vi.fn().mockResolvedValue({ models: ["gpt-4.1", "gateway/custom-id"] }), onReload: vi.fn(), onMutate: vi.fn().mockResolvedValue(true), onEnsureProfile: vi.fn().mockResolvedValue("new"), onApplied: vi.fn().mockResolvedValue(undefined), ...overrides };
}

function manageModel(optionName: string | RegExp) {
  const advanced = screen.queryByRole("button", { name: "高级设置" });
  if (advanced) fireEvent.click(advanced);
  const select = screen.getByRole("combobox", { name: "管理单个模型" });
  const option = within(select).getByRole<HTMLOptionElement>("option", { name: optionName });
  fireEvent.change(select, { target: { value: option.value } });
}

async function findAndManageModel(name: string, optionName: string | RegExp) {
  const list = await screen.findByRole("list", { name: "模型目录" });
  await within(list).findAllByText(name);
  manageModel(optionName);
}

describe("UnifiedModelManager", () => {
  it("guides the first connection without exposing empty directory controls", () => {
    render(<UnifiedModelManager {...props({ catalog: { ...catalog, connections: [], profiles: [], purpose_defaults: { chat: null, image: null } } })} />);
    expect(screen.getByRole("heading", { name: "连接模型服务，开始使用" })).toBeVisible();
    expect(screen.queryByRole("list", { name: "模型目录" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "搜索模型" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新全部服务模型" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "连接第一个服务" }));
    expect(screen.getByRole("form", { name: "添加服务" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "连接模型服务，开始使用" })).not.toBeInTheDocument();
  });
  it("shows defaults and opens a purpose-specific picker without leaving the overview", () => {
    render(<UnifiedModelManager {...props()} />);
    const summary = screen.getByRole("region", { name: "当前默认模型" });
    expect(summary).toHaveTextContent("gpt-4.1");
    expect(summary).toHaveTextContent("自动选择");
    expect(screen.queryByRole("textbox", { name: "搜索可用模型" })).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "选择图片生成模型" });
    fireEvent.click(trigger);
    const search = screen.getByRole("textbox", { name: "搜索可用模型" });
    expect(search).toHaveFocus();
    expect(screen.getByRole("button", { name: "概览" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("list", { name: "模型目录" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByRole("radio", { name: /自动选择.*当前默认/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /gpt-image-2.*服务乙/ })).toBeVisible();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("searches beyond the first page across services and retries the selected default", async () => {
    const profiles = [
      catalog.profiles[0],
      ...Array.from({ length: 10 }, (_, index) => ({ ...catalog.profiles[0], id: `extra-${index}`, model_name: `extra-model-${index}` })),
      { ...catalog.profiles[1], discovery: { id: "gpt-4.1", display_name: "Gateway Text", output_types: ["chat"], output_types_source: "provider" } },
      { ...catalog.profiles[0], id: "disabled-profile", model_name: "disabled-profile", enabled: false },
      { ...catalog.profiles[0], id: "disabled-service", connection_id: "disabled", model_name: "disabled-service" },
      ...catalog.profiles.slice(2)
    ] satisfies ModelCatalog["profiles"];
    const snapshot: ModelCatalog = {
      ...catalog,
      profiles,
      connections: [...catalog.connections, { ...catalog.connections[0], id: "disabled", enabled: false }]
    };
    const onMutate = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const p = props({ catalog: snapshot, onMutate });
    const view = render(<UnifiedModelManager {...p} />);
    const trigger = screen.getByRole("button", { name: "更换文本对话模型" });
    fireEvent.click(trigger);
    const picker = screen.getByRole("region", { name: "选择文本对话模型" });
    const search = within(picker).getByRole("textbox", { name: "搜索可用模型" });
    expect(within(picker).getByRole("radio", { name: /gpt-4.1.*服务甲.*当前默认/ })).toBeChecked();
    expect(within(picker).getAllByRole("radio")).toHaveLength(9);
    expect(within(picker).getByRole("button", { name: "显示更多（共 12 个）" })).toBeVisible();
    fireEvent.change(search, { target: { value: "gpt-4.1 服务乙" } });
    const candidate = within(picker).getByRole("radio", { name: /Gateway Text.*服务乙/ });
    fireEvent.click(candidate);
    expect(onMutate).not.toHaveBeenCalled();
    const save = within(picker).getByRole("button", { name: "设为默认" });
    fireEvent.click(save);
    expect(await within(picker).findByRole("alert")).toHaveTextContent("保存未完成");
    expect(candidate).toBeChecked();
    expect(within(screen.getByRole("region", { name: "当前默认模型" })).getByText("服务甲 · 后续新任务使用")).toBeVisible();
    fireEvent.click(save);
    await waitFor(() => expect(picker).not.toBeInTheDocument());
    expect(onMutate.mock.calls).toEqual(Array.from({ length: 2 }, () => ["/agent/model-defaults/chat", "POST", { profile_id: "p2", expected_version: 7 }]));
    expect(p.onEnsureProfile).not.toHaveBeenCalled();
    expect(p.onApplied).toHaveBeenCalledOnce();
    view.rerender(<UnifiedModelManager {...p} catalog={{ ...snapshot, purpose_defaults: { chat: "p2", image: null }, purpose_version: 8 }} />);
    expect(screen.getByText("服务乙 · 后续新任务使用")).toBeVisible();
    expect(trigger).toHaveFocus();
  });

  it("clears an unavailable explicit default using the current policy version", async () => {
    const p = props({ catalog: { ...catalog, profiles: [], purpose_defaults: { chat: "p1", image: null } } });
    const view = render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "更换文本对话模型" }));
    const picker = screen.getByRole("region", { name: "选择文本对话模型" });
    fireEvent.click(within(picker).getByRole("radio", { name: /自动选择/ }));
    expect(p.onMutate).not.toHaveBeenCalled();
    fireEvent.click(within(picker).getByRole("button", { name: "设为自动选择" }));
    await waitFor(() => expect(picker).not.toBeInTheDocument());
    expect(p.onMutate).toHaveBeenCalledWith("/agent/model-defaults/chat", "POST", { profile_id: null, expected_version: 7 });
    expect(p.onEnsureProfile).not.toHaveBeenCalled();
    view.rerender(<UnifiedModelManager {...p} catalog={{ ...p.catalog, purpose_defaults: { chat: null, image: null }, purpose_version: 8 }} />);
    expect(screen.getByRole("button", { name: "选择文本对话模型" })).toHaveFocus();
  });

  it("offers a service connection when the purpose has no usable model", () => {
    render(<UnifiedModelManager {...props({ catalog: { ...catalog, profiles: catalog.profiles.filter(profile => profile.id !== "image") } })} />);
    fireEvent.click(screen.getByRole("button", { name: "选择图片生成模型" }));
    const picker = screen.getByRole("region", { name: "选择图片生成模型" });
    expect(picker).toHaveTextContent("没有可用的图片模型");
    expect(within(picker).queryByRole("button", { name: "设为默认" })).not.toBeInTheDocument();
    fireEvent.click(within(picker).getByRole("button", { name: "连接模型服务" }));
    expect(screen.getByRole("form", { name: "添加服务" })).toBeVisible();
  });
  it("recovers from combined filters without losing the selected service", () => {
    render(<UnifiedModelManager {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "模型列表" }));
    fireEvent.change(screen.getByRole("combobox", { name: "按服务筛选" }), { target: { value: "two" } });
    fireEvent.change(screen.getByRole("textbox", { name: "搜索模型" }), { target: { value: "missing-model" } });
    fireEvent.click(screen.getByRole("button", { name: /^筛选$/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "输出类型" }), { target: { value: "image" } });
    expect(screen.queryByRole("list", { name: "模型目录" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "没有符合条件的模型" })).toBeVisible();
    fireEvent.click(screen.getAllByRole("button", { name: "清除筛选" })[0]);
    expect(within(screen.getByRole("list", { name: "模型目录" })).getByText("gpt-image-2", { exact: true })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "搜索模型" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "按服务筛选" })).toHaveValue("two");
  });
  it("only reveals the credential typed in the connection form when requested", () => {
    render(<UnifiedModelManager {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加服务" }));
    fireEvent.change(screen.getByLabelText("API Key", { exact: true }), { target: { value: "test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "显示 API Key" }));
    expect(screen.getByLabelText("API Key", { exact: true })).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "隐藏 API Key" }));
    expect(screen.getByLabelText("API Key", { exact: true })).toHaveAttribute("type", "password");
  });
  it("offers ordinary service removal with confirmation and resets the selected service", async () => {
    const p = props(); const view = render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "模型列表" }));
    fireEvent.change(screen.getByRole("combobox", { name: "按服务筛选" }), { target: { value: "two" } });
    fireEvent.click(screen.getByRole("button", { name: "服务管理" }));
    fireEvent.click(screen.getByRole("button", { name: "删除服务乙" }));
    expect(p.onMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "删除服务" })).toHaveTextContent("3 个已保存模型");
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(p.onMutate).toHaveBeenCalledWith("/agent/model-connections/two?remove=true&expected_revision=3", "DELETE"));
    view.rerender(<UnifiedModelManager {...p} catalog={{ ...catalog, connections: [catalog.connections[0]], profiles: [catalog.profiles[0]] }} />);
    fireEvent.click(screen.getByRole("button", { name: "模型列表" }));
    expect(screen.getByRole("combobox", { name: "按服务筛选" })).toHaveValue("");
    expect(within(screen.getByRole("list", { name: "模型目录" })).queryByText("gpt-image-2", { exact: true })).not.toBeInTheDocument();
  });
  it("explains default protection and allows cancelling removal without a request", () => {
    const p = props(); render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "服务管理" }));
    fireEvent.click(screen.getByRole("button", { name: "删除服务甲" }));
    expect(screen.getByRole("region", { name: "删除服务" })).toHaveTextContent("先切换");
    expect(screen.getByRole("button", { name: "确认删除" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "取消删除" }));
    expect(screen.queryByRole("region", { name: "删除服务" })).not.toBeInTheDocument();
    expect(p.onMutate).not.toHaveBeenCalled();
  });
  it("warns about an existing address before creating another service", () => {
    render(<UnifiedModelManager {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加服务" }));
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://one.test/v1/" } });
    expect(screen.getByRole("status")).toHaveTextContent("服务甲");
    expect(screen.getByRole("status")).toHaveTextContent("已有相同地址");
  });
  it("starts with all services and keeps identical model IDs separate", () => {
    render(<UnifiedModelManager {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "模型列表" }));
    const list = within(screen.getByRole("list", { name: "模型目录" }));
    expect(list.getAllByRole("listitem").map(item => item.textContent)).toEqual(["gpt-4.1", "gpt-4.1", "gpt-image-2", "sora-2"]);
    expect(list.queryByRole("button")).not.toBeInTheDocument();
    expect(list.queryByRole("group")).not.toBeInTheDocument();
    fireEvent.click(list.getAllByRole("listitem")[0]);
    expect(list.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "管理单个模型" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "按服务筛选" })).toHaveValue("");
  });
  it("keeps service maintenance out of the model list and opens a service's models on demand", () => {
    render(<UnifiedModelManager {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "模型列表" }));
    expect(screen.queryByRole("button", { name: "编辑服务甲" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "输出类型" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "服务管理" }));
    expect(screen.queryByRole("list", { name: "模型目录" })).not.toBeInTheDocument();
    const services = screen.getByRole("region", { name: "已连接服务" });
    expect(services).toHaveTextContent("API Key 已配置");
    fireEvent.click(within(services).getAllByRole("button", { name: "查看模型" })[1]);
    expect(screen.getByRole("combobox", { name: "按服务筛选" })).toHaveValue("two");
    expect(within(screen.getByRole("list", { name: "模型目录" })).getAllByText("gpt-4.1", { exact: true })).toHaveLength(1);
  });
  it("opens a two-field ordinary connection form with optional details collapsed", () => {
    render(<UnifiedModelManager {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "添加服务" }));
    const form = screen.getByRole("form", { name: "添加服务" });
    expect(within(form).getByLabelText("Base URL")).toBeVisible();
    expect(within(form).getByLabelText("API Key")).toHaveAttribute("type", "password");
    expect(within(form).getByLabelText("服务名称")).not.toBeVisible();
    expect(within(form).getByLabelText("接口协议")).not.toBeVisible();
  });
  it("requires a fresh key for changed addresses and clears the key after saving", async () => {
    const p = props(); render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "服务管理" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑服务甲" }));
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://changed.test/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存服务" }));
    expect(p.onMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("API Key");
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "test-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "保存服务" }));
    expect(p.onMutate).toHaveBeenCalledWith("/agent/model-connections/one", "PATCH", expect.objectContaining({ expected_revision: 2, api_key: "test-secret" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    await waitFor(() => expect(screen.queryByRole("form", { name: "编辑服务" })).not.toBeInTheDocument());
  });
  it("protects unsaved credentials on cancellation and clears them when the account client changes", () => {
    const p = props(); const view = render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "添加服务" }));
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "private" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByText(/放弃未保存/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("private");
    view.rerender(<UnifiedModelManager {...p} fetchJson={vi.fn()} />);
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
  });
  it("uses the exact service profile for a direct default with optimistic version", async () => {
    const p = props(); render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "模型列表" }));
    manageModel("gpt-4.1 · 服务乙");
    fireEvent.click(screen.getByRole("button", { name: "设为文本默认" }));
    await waitFor(() => expect(p.onMutate).toHaveBeenCalledWith("/agent/model-defaults/chat", "POST", { profile_id: "p2", expected_version: 7 }));
    expect(p.onEnsureProfile).not.toHaveBeenCalled();
    expect(p.onApplied).toHaveBeenCalled();
    manageModel("sora-2 · 服务乙");
    expect(within(screen.getByRole("group", { name: "sora-2的详情" })).queryByRole("button", { name: /默认/ })).not.toBeInTheDocument();
  });
  it("discovers explicitly across services and preserves unknown raw IDs", async () => {
    const p = props(); render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "模型列表" }));
    expect(p.fetchJson).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "刷新全部服务模型" }));
    await screen.findAllByText("gateway/custom-id");
    expect(p.fetchJson).toHaveBeenCalledWith("/agent/model-connections/one/discover", expect.objectContaining({ method: "POST" }));
    expect(p.fetchJson).toHaveBeenCalledWith("/agent/model-connections/two/discover", expect.objectContaining({ method: "POST" }));
  });
  it("saves thinking only without overwriting existing capabilities or context", async () => {
    const p = props(); render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "模型列表" }));
    manageModel("gpt-4.1 · 服务甲");
    fireEvent.click(screen.getByRole("button", { name: "参数" }));
    const effort = await screen.findByLabelText("思考程度");
    await waitFor(() => expect(effort).toBeEnabled());
    expect(screen.getByRole("region", { name: "gpt-4.1 参数设置" })).toHaveFocus();
    fireEvent.change(effort, { target: { value: "high" } });
    await waitFor(() => expect(p.onMutate).toHaveBeenCalledWith("/agent/model-profiles/p1", "PATCH", { reasoning_effort: "high", expected_revision: 4 }));
  });
  it("ignores old discoveries after the client changes", async () => {
    let resolve!: (v: unknown) => void;
    const fetchJson = vi.fn(() => new Promise(r => { resolve = r; }));
    const p = props({ fetchJson }); const view = render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "模型列表" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新全部服务模型" }));
    view.rerender(<UnifiedModelManager {...p} fetchJson={vi.fn()} />);
    resolve({ models: ["stale-private-model"] });
    await waitFor(() => expect(screen.queryByText("stale-private-model")).not.toBeInTheDocument());
  });
  it("does not apply a discovered model after its connection revision changes", async () => {
    let resolve!: (id: string) => void;
    const p = props({ catalog: { ...catalog, profiles: [] }, onEnsureProfile: vi.fn(() => new Promise<string>(r => { resolve = r; })) });
    const view = render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "模型列表" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新全部服务模型" }));
    await findAndManageModel("gpt-4.1", "gpt-4.1 · 服务甲");
    fireEvent.click(screen.getByRole("button", { name: "设为文本默认" }));
    view.rerender(<UnifiedModelManager {...p} catalog={{ ...catalog, profiles: [], connections: catalog.connections.map(item => ({ ...item, revision: item.revision + 1 })) }} />);
    resolve("late-profile");
    await waitFor(() => expect(screen.getByRole("button", { name: "添加服务" })).toBeEnabled());
    expect(p.onMutate).not.toHaveBeenCalled();
  });
  it("edits advanced parameters without changing capability declarations or reasoning", async () => {
    const p = props(); render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "模型列表" }));
    manageModel("gpt-4.1 · 服务甲");
    fireEvent.click(screen.getByRole("button", { name: "参数" }));
    fireEvent.click(await screen.findByText("请求参数（可选）"));
    fireEvent.click(screen.getByRole("button", { name: "编辑请求参数" }));
    fireEvent.change(screen.getByLabelText("温度"), { target: { value: "0.4" } });
    fireEvent.click(screen.getByRole("button", { name: "保存请求参数" }));
    await waitFor(() => expect(p.onMutate).toHaveBeenCalledWith("/agent/model-profiles/p1", "PATCH", { parameters: { temperature: 0.4 }, context_limit: 99999, expected_revision: 4 }));
  });
  it("does not replace a dirty service editor with another add action", () => {
    render(<UnifiedModelManager {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "服务管理" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑服务甲" }));
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "keep-me" } });
    expect(screen.getByRole("button", { name: "添加服务" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "编辑服务乙" })).toBeDisabled();
  });
  it("waits for the returned catalog to identify a newly saved connection", async () => {
    const p = props(); const view = render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "添加服务" }));
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://third.test/v1" } });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "new-test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并获取模型" }));
    await waitFor(() => expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument());
    expect(p.fetchJson).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "按服务筛选" })).toHaveValue("");
    view.rerender(<UnifiedModelManager {...p} catalog={{ ...catalog, connections: [...catalog.connections, { ...catalog.connections[0], id: "three", name: "第三服务", model_base_url: "https://third.test/v1" }] }} />);
    await waitFor(() => expect(p.fetchJson).toHaveBeenCalledWith("/agent/model-connections/three/discover", expect.anything()));
    expect(p.fetchJson).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("combobox", { name: "按服务筛选" })).toHaveValue("three");
  });
  it("reports invalid addresses without sending secrets and preserves the key for correction", () => {
    const p = props(); render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "添加服务" }));
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "bad-address" } });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "private-test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并获取模型" }));
    expect(screen.getByRole("alert")).toHaveTextContent("完整的 http:// 或 https:// 地址");
    expect(screen.getByLabelText("API Key")).toHaveValue("private-test-key");
    expect(p.onMutate).not.toHaveBeenCalled();
  });
  it("enables a model independently from setting its default purpose", async () => {
    const p = props({ catalog: { ...catalog, profiles: catalog.profiles.map(item => item.id === "p2" ? { ...item, enabled: false } : item) } });
    render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "模型列表" }));
    manageModel("gpt-4.1 · 服务乙");
    fireEvent.click(screen.getByRole("switch", { name: "服务乙 gpt-4.1 启用" }));
    await waitFor(() => expect(p.onMutate).toHaveBeenCalledWith("/agent/model-profiles/p2", "PATCH", { enabled: true, expected_revision: 5 }));
    expect(p.onEnsureProfile).not.toHaveBeenCalled();
    expect(p.onMutate).toHaveBeenCalledTimes(1);
    expect(p.onApplied).not.toHaveBeenCalled();
  });
  it("shows provider display names while keeping raw model identity for selection", async () => {
    const p = props({ fetchJson: vi.fn().mockResolvedValue({ models: ["vendor/paint-alias"], entries: [{ id: "vendor/paint-alias", display_name: "画图模型", output_types: ["image"], output_types_source: "provider" }] }) });
    render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "模型列表" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新全部服务模型" }));
    await findAndManageModel("画图模型", "画图模型 · 服务乙 · vendor/paint-alias");
    const details = within(screen.getByRole("group", { name: "画图模型的详情" }));
    expect(screen.getByRole<HTMLOptionElement>("option", { name: "画图模型 · 服务乙 · vendor/paint-alias" }).selected).toBe(true);
    fireEvent.click(details.getByRole("button", { name: "设为图片默认" }));
    await waitFor(() => expect(p.onEnsureProfile).toHaveBeenCalledWith("two", "vendor/paint-alias", 3));
  });
  it.each([
    ["auto", "https://gateway.test/v1", ["chat", "image"]],
    ["openai", "https://gateway.test/v1", ["chat", "image"]],
    ["responses", "https://gateway.test/v1", ["chat", "image"]],
    ["auto", "https://api.anthropic.com", ["image"]],
    ["auto", "https://generativelanguage.googleapis.com/v1beta", ["image"]]
  ] as const)("does not offer an unimplemented image action for %s %s %s", async (protocol, baseUrl, outputs) => {
    const p = props({ catalog: { ...catalog, profiles: [], connections: [{ ...catalog.connections[0], model_protocol: protocol, model_base_url: baseUrl }] }, fetchJson: vi.fn().mockResolvedValue({ models: ["opaque-alias"], entries: [{ id: "opaque-alias", output_types: outputs, output_types_source: "provider" }] }) });
    render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "模型列表" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新全部服务模型" }));
    await findAndManageModel("opaque-alias", "opaque-alias · 服务甲");
    expect(within(screen.getByRole("group", { name: "opaque-alias的详情" })).queryByRole("button", { name: "设为图片默认" })).not.toBeInTheDocument();
  });
  it("requires trusted image-only metadata before switching an inferred alias to Images", async () => {
    render(<UnifiedModelManager {...props({ catalog: { ...catalog, profiles: [] }, fetchJson: vi.fn().mockResolvedValue({ models: ["flux-inferred-only"] }) })} />);
    fireEvent.click(screen.getByRole("button", { name: "模型列表" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新全部服务模型" }));
    await findAndManageModel("flux-inferred-only", "flux-inferred-only · 服务甲");
    expect(within(screen.getByRole("group", { name: "flux-inferred-only的详情" })).queryByRole("button", { name: "设为图片默认" })).not.toBeInTheDocument();
  });
  it("views disabled models without enabling and previews unsaved entries without writes", async () => {
    const p = props({ catalog: { ...catalog, profiles: catalog.profiles.map(item => item.id === "p2" ? { ...item, enabled: false } : item) } });
    render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "模型列表" }));
    const list = within(screen.getByRole("list", { name: "模型目录" }));
    expect(list.getAllByRole("listitem").at(-1)).toHaveTextContent("gpt-4.1");
    expect(list.queryByRole("button")).not.toBeInTheDocument();
    manageModel("gpt-4.1 · 服务乙");
    expect(screen.getByRole("group", { name: "gpt-4.1的详情" })).toHaveTextContent("未启用");
    const parameters = screen.getByRole("button", { name: "参数" });
    fireEvent.click(parameters);
    expect(screen.getByRole("region", { name: "gpt-4.1 参数设置" })).toHaveTextContent("只读预览");
    expect(p.onMutate).not.toHaveBeenCalled();
    expect(p.onEnsureProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "收起参数" }));
    expect(parameters).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "刷新全部服务模型" }));
    await list.findAllByText("gateway/custom-id");
    manageModel("gateway/custom-id · 服务甲");
    expect(screen.getByRole("group", { name: "gateway/custom-id的详情" })).toHaveTextContent("输出能力待确认");
    fireEvent.click(screen.getByRole("button", { name: "确认输出能力" }));
    expect(screen.getByText("高级能力与上下文").parentElement).toHaveAttribute("open");
    expect(p.onEnsureProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "启用并编辑参数" }));
    await waitFor(() => expect(p.onEnsureProfile).toHaveBeenCalledWith("one", "gateway/custom-id", 2));
  });
  it("refreshes only the selected service", async () => {
    const p = props(); render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "模型列表" }));
    fireEvent.change(screen.getByRole("combobox", { name: "按服务筛选" }), { target: { value: "two" } });
    fireEvent.click(screen.getByRole("button", { name: "刷新此服务模型" }));
    await screen.findByText("gateway/custom-id");
    expect(p.fetchJson).toHaveBeenCalledTimes(1);
    expect(p.fetchJson).toHaveBeenCalledWith("/agent/model-connections/two/discover", expect.anything());
  });
  it("protects request drafts when closing or changing models and restores trigger focus", async () => {
    const p = props(); render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "模型列表" }));
    manageModel("gpt-4.1 · 服务甲");
    const parameters = screen.getByRole("button", { name: "参数" });
    fireEvent.click(parameters);
    fireEvent.click(screen.getByText("请求参数（可选）"));
    fireEvent.click(screen.getByRole("button", { name: "编辑请求参数" }));
    fireEvent.change(screen.getByLabelText("温度"), { target: { value: "0.7" } });
    fireEvent.click(screen.getByRole("button", { name: "收起参数" }));
    expect(screen.getByRole("alert")).toHaveTextContent("参数有未保存");
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.getByLabelText("温度")).toHaveValue("0.7");
    fireEvent.click(parameters);
    fireEvent.click(screen.getByRole("button", { name: "模型列表" }));
    expect(screen.getByLabelText("温度")).toHaveValue("0.7");
    fireEvent.click(screen.getByRole("button", { name: "收起参数" }));
    fireEvent.click(screen.getByRole("button", { name: "放弃参数修改并继续" }));
    expect(screen.queryByRole("region", { name: "gpt-4.1 参数设置" })).not.toBeInTheDocument();
    expect(parameters).toHaveFocus();
  });

});
