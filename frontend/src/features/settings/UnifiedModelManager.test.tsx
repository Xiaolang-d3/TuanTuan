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

describe("UnifiedModelManager", () => {
  it("offers ordinary service removal with confirmation and resets the selected service", async () => {
    const p = props(); const view = render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /服务乙.*已保存配置/ }));
    fireEvent.click(screen.getByRole("button", { name: "删除服务乙" }));
    expect(p.onMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "删除服务" })).toHaveTextContent("3 个已保存模型");
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(p.onMutate).toHaveBeenCalledWith("/agent/model-connections/two?remove=true&expected_revision=3", "DELETE"));
    view.rerender(<UnifiedModelManager {...p} catalog={{ ...catalog, connections: [catalog.connections[0]], profiles: [catalog.profiles[0]] }} />);
    expect(screen.getByRole("button", { name: "全部服务" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("row", { name: /gpt-image-2/ })).not.toBeInTheDocument();
  });
  it("explains default protection and allows cancelling removal without a request", () => {
    const p = props(); render(<UnifiedModelManager {...p} />);
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
    const rows = screen.getAllByRole("row", { name: /gpt-4.1/ });
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("服务甲")).toBeInTheDocument();
    expect(within(rows[1]).getByText("服务乙")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全部服务" })).toHaveAttribute("aria-pressed", "true");
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
    const row = screen.getAllByRole("row", { name: /gpt-4.1/ })[1];
    fireEvent.click(within(row).getByRole("button", { name: "使用文本" }));
    await waitFor(() => expect(p.onMutate).toHaveBeenCalledWith("/agent/model-defaults/chat", "POST", { profile_id: "p2", expected_version: 7 }));
    expect(p.onEnsureProfile).not.toHaveBeenCalled();
    expect(p.onApplied).toHaveBeenCalled();
    expect(within(screen.getByRole("row", { name: /sora-2/ })).queryByRole("button", { name: /使用/ })).not.toBeInTheDocument();
  });
  it("discovers explicitly across services and preserves unknown raw IDs", async () => {
    const p = props(); render(<UnifiedModelManager {...p} />);
    expect(p.fetchJson).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));
    await screen.findAllByText("gateway/custom-id");
    expect(p.fetchJson).toHaveBeenCalledWith("/agent/model-connections/one/discover", expect.objectContaining({ method: "POST" }));
    expect(p.fetchJson).toHaveBeenCalledWith("/agent/model-connections/two/discover", expect.objectContaining({ method: "POST" }));
  });
  it("saves thinking only without overwriting existing capabilities or context", async () => {
    const p = props(); render(<UnifiedModelManager {...p} />);
    const row = screen.getAllByRole("row", { name: /gpt-4.1/ })[0];
    fireEvent.click(within(row).getByRole("button", { name: "参数" }));
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
    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));
    view.rerender(<UnifiedModelManager {...p} fetchJson={vi.fn()} />);
    resolve({ models: ["stale-private-model"] });
    await waitFor(() => expect(screen.queryByText("stale-private-model")).not.toBeInTheDocument());
  });
  it("does not apply a discovered model after its connection revision changes", async () => {
    let resolve!: (id: string) => void;
    const p = props({ catalog: { ...catalog, profiles: [] }, onEnsureProfile: vi.fn(() => new Promise<string>(r => { resolve = r; })) });
    const view = render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));
    const row = (await screen.findAllByRole("row", { name: /gpt-4.1/ }))[0];
    fireEvent.click(within(row).getByRole("button", { name: "使用文本" }));
    view.rerender(<UnifiedModelManager {...p} catalog={{ ...catalog, profiles: [], connections: catalog.connections.map(item => ({ ...item, revision: item.revision + 1 })) }} />);
    resolve("late-profile");
    await waitFor(() => expect(screen.getByRole("button", { name: "添加服务" })).toBeEnabled());
    expect(p.onMutate).not.toHaveBeenCalled();
  });
  it("edits advanced parameters without changing capability declarations or reasoning", async () => {
    const p = props(); render(<UnifiedModelManager {...p} />);
    fireEvent.click(within(screen.getAllByRole("row", { name: /gpt-4.1/ })[0]).getByRole("button", { name: "参数" }));
    fireEvent.click(await screen.findByText("请求参数（可选）"));
    fireEvent.click(screen.getByRole("button", { name: "编辑请求参数" }));
    fireEvent.change(screen.getByLabelText("温度"), { target: { value: "0.4" } });
    fireEvent.click(screen.getByRole("button", { name: "保存请求参数" }));
    await waitFor(() => expect(p.onMutate).toHaveBeenCalledWith("/agent/model-profiles/p1", "PATCH", { parameters: { temperature: 0.4 }, context_limit: 99999, expected_revision: 4 }));
  });
  it("does not replace a dirty service editor with another add action", () => {
    render(<UnifiedModelManager {...props()} />);
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
    expect(screen.getByRole("button", { name: "全部服务" })).toHaveAttribute("aria-pressed", "true");
    view.rerender(<UnifiedModelManager {...p} catalog={{ ...catalog, connections: [...catalog.connections, { ...catalog.connections[0], id: "three", name: "第三服务", model_base_url: "https://third.test/v1" }] }} />);
    await waitFor(() => expect(p.fetchJson).toHaveBeenCalledWith("/agent/model-connections/three/discover", expect.anything()));
    expect(screen.getByRole("button", { name: /第三服务.*已保存配置/ })).toHaveAttribute("aria-pressed", "true");
  });
  it("reports invalid addresses without sending secrets and clears the attempted key", () => {
    const p = props(); render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "添加服务" }));
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "bad-address" } });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "private-test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并获取模型" }));
    expect(screen.getByRole("alert")).toHaveTextContent("完整的 http:// 或 https:// 地址");
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    expect(p.onMutate).not.toHaveBeenCalled();
  });
  it("enables a model independently from setting its default purpose", async () => {
    const p = props({ catalog: { ...catalog, profiles: catalog.profiles.map(item => item.id === "p2" ? { ...item, enabled: false } : item) } });
    render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "高级设置" }));
    fireEvent.click(screen.getByRole("switch", { name: "服务乙 gpt-4.1 启用" }));
    await waitFor(() => expect(p.onMutate).toHaveBeenCalledWith("/agent/model-profiles/p2", "PATCH", { enabled: true, expected_revision: 5 }));
    expect(p.onEnsureProfile).not.toHaveBeenCalled();
    expect(p.onMutate).toHaveBeenCalledTimes(1);
    expect(p.onApplied).not.toHaveBeenCalled();
  });
  it("shows provider display names while keeping raw model identity for selection", async () => {
    const p = props({ fetchJson: vi.fn().mockResolvedValue({ models: ["vendor/paint-alias"], entries: [{ id: "vendor/paint-alias", display_name: "画图模型", output_types: ["image"], output_types_source: "provider" }] }) });
    render(<UnifiedModelManager {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));
    const row = (await screen.findAllByRole("row", { name: /画图模型/ }))[1];
    expect(within(row).getByText("vendor/paint-alias")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "使用图片" }));
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
    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));
    const row = await screen.findByRole("row", { name: /opaque-alias/ });
    expect(within(row).queryByRole("button", { name: "使用图片" })).not.toBeInTheDocument();
  });
  it("requires trusted image-only metadata before switching an inferred alias to Images", async () => {
    render(<UnifiedModelManager {...props({ catalog: { ...catalog, profiles: [] }, fetchJson: vi.fn().mockResolvedValue({ models: ["flux-inferred-only"] }) })} />);
    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));
    const row = (await screen.findAllByRole("row", { name: /flux-inferred-only/ }))[0];
    expect(within(row).queryByRole("button", { name: "使用图片" })).not.toBeInTheDocument();
  });
});
