import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentSettings } from "../constants";
import { ThemeProvider } from "../features/appearance/ThemeProvider";
import type { AgentSettings, ModelCapabilityReport, ModelServiceMonitor, ModelCatalog } from "../types";
import { App } from "./App";

const api = vi.hoisted(() => ({ fetchJson: vi.fn<(path: string, options?: RequestInit) => Promise<unknown>>() }));

vi.mock("../api/client", async (importOriginal) => ({ ...await importOriginal<typeof import('../api/client')>(), createApiClient: () => (path: string, options?: RequestInit) => api.fetchJson(path, options), fetchWithTimeout: vi.fn() }));
vi.mock("../page-prefetch", () => ({ createPagePrefetcher: () => ({ prefetch: vi.fn(), prefetchWhenIdle: vi.fn() }) }));
vi.mock("../hooks/useAsyncPolling", () => ({ useAsyncPolling: vi.fn() }));
vi.mock("../components/AppSidebar", () => ({ AppSidebar: () => null }));
vi.mock("../components/AppIdentityMenu", () => ({ AppIdentityMenu: () => null }));
vi.mock("../components/AppTopBar", () => ({ AppTopBar: () => null }));
vi.mock("../components/AssistantSurface", () => ({ AssistantSurface: () => null }));
vi.mock("../components/ChatWorkspace", () => ({ ChatWorkspace: () => null }));
vi.mock("../features/chat/useConversations", () => ({
  useConversations: () => ({
    conversations: [], currentConversationId: null, conversationBusy: false,
    conversationDialog: null, setConversations: vi.fn(), setCurrentConversationId: vi.fn(),
    setConversationBusy: vi.fn(), refreshConversations: vi.fn().mockResolvedValue([])
  })
}));
vi.mock("../features/chat/useChatRun", () => ({
  useChatRun: () => ({
    chatMessages: [], chatBusy: false, modelUnavailable: null,
    chatAgentRef: { current: null }, setChatMessages: vi.fn(), setChatBusy: vi.fn(),
    setRetryChatDraft: vi.fn(), setModelUnavailable: vi.fn()
  })
}));
vi.mock("../features/library/useLibrary", () => ({
  useLibrary: () => ({ librarySources: [], libraryFolders: [], pendingKnowledge: [], libraryLoaded: true })
}));

const savedSettings: AgentSettings = {
  ...defaultAgentSettings,
  display_name: "我的助手",
  persona_role: "分析技术文档",
  response_style: "detailed",
  custom_instructions: "保留原始来源",
  library_memory_enabled: false,
  conversation_memory_enabled: false,
  knowledge_memory_enabled: false,
  summary_enabled: false,
  context_message_limit: 24,
  model_name: "saved-model",
  model_base_url: "https://saved.example.test/v1",
  model_protocol: "responses",
  api_key: "",
  api_key_configured: true,
  config_revision: 1
};

const monitor: ModelServiceMonitor = {
  status: "unknown", status_message: "等待检测", model_name: savedSettings.model_name,
  base_url: savedSettings.model_base_url, protocol: "responses", api_key_configured: true,
  window_hours: 24,
  summary: {
    total_requests: 0, successful_requests: 0, failed_requests: 0, success_rate: null,
    average_latency_ms: null, p95_latency_ms: null, timeout_count: 0,
    consecutive_failures: 0, total_tokens: 0
  },
  error_breakdown: [], recent_events: [], last_event_at: null,
  last_success_at: null, last_check_at: null
};

const capabilities: ModelCapabilityReport = {
  model_name: savedSettings.model_name, provider: "responses", provider_label: "Responses",
  protocol: "responses", protocol_label: "OpenAI Responses API",
  vision: { status: "unknown", source: "model_id", detail: "等待检测" },
  streaming: { status: "supported", source: "client", detail: "支持流式输出" },
  tools: { status: "supported", source: "client", detail: "支持工具调用" },
  probed: false, probe_error: null
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function mockApi(settingsResult: Promise<AgentSettings> = Promise.resolve(savedSettings)) {
  api.fetchJson.mockImplementation(async (path, options) => {
    if (path === "/system/database-status") return { status: "ready" };
    if (path === "/agent/settings") {
      if (options?.method === "PUT") return { ...JSON.parse(String(options.body)), api_key: "", api_key_configured: true };
      return settingsResult;
    }
    if (path === "/agent/model-monitor?hours=24") return monitor;
    if (path === "/agent/model-monitor/check") return { ...monitor, available: true };
    if (path.startsWith("/agent/models/capabilities")) return capabilities;
    if (path === "/agent/models/discover") return { models: [], count: 0 };
    if (path === "/agent/model-connections") return { connections: [], profiles: [], default_profile_id: null };
    if (path === "/agent/capabilities" || path === "/attachments/config") return {};
    throw new Error(`Unexpected mocked request: ${path}`);
  });
}

function appElement(accessToken = "test-only-session", apiBase = "/test-api", email = "developer@example.test") {
  return <ThemeProvider><App apiBase={apiBase} accessToken={accessToken} onLogout={vi.fn()} user={{ email, has_avatar: false }} updateSession={vi.fn()} /></ThemeProvider>;
}
async function modelField(label: string) {
  await act(async () => {});
  if (!screen.queryByLabelText(label)) {
    fireEvent.click(await screen.findByRole("button", { name: "配置模型" }));
  }
  return screen.findByLabelText(label);
}
function renderApp() { return render(appElement()); }
function navigate(hash: string) {
  act(() => {
    window.history.replaceState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}
function replaceApi(override: (path: string, options?: RequestInit) => Promise<unknown> | undefined) {
  const fallback = api.fetchJson.getMockImplementation()!;
  api.fetchJson.mockImplementation((path, options) => override(path, options) ?? fallback(path, options));
}

function openAdvancedSettings() {
  const details = screen.getByText("高级设置").closest("details");
  if (details) details.open = true;
}

// Keep lazy module loading outside the timing window for settings interactions.
beforeAll(async () => {
  await Promise.all([
    import("../features/settings/SettingsWorkspace"),
    import("../features/settings/ModelSettingsPage"),
    import("../features/settings/ModelConnectionManager")
  ]);
});

beforeEach(() => {
  api.fetchJson.mockReset();
  localStorage.clear();
  window.history.replaceState(null, "", "#/settings/model");
  vi.spyOn(window, "confirm").mockImplementation(() => { throw new Error("Model editing must not require confirmation"); });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("App model settings", () => {
  it("keeps unified model discovery and view mounted while refreshing the saved default summary", async () => {
    mockApi(Promise.resolve({ ...savedSettings, credential_status: "saved_unverified" }));
    const summary = deferred<AgentSettings>();
    let changed = false;
    const catalog = () => ({ connections: [{ id: "c1", name: "Service", model_base_url: savedSettings.model_base_url, model_protocol: "openai", enabled: true, api_key_configured: true, revision: 1 }], profiles: [
      { id: "p1", connection_id: "c1", model_name: "gpt-5.5", enabled: true, revision: 1, supported_purposes: ["chat"], output_types: ["chat"] },
      { id: "p2", connection_id: "c1", model_name: "gpt-4.1", enabled: true, revision: 1, supported_purposes: ["chat"], output_types: ["chat"] }
    ], default_profile_id: changed ? "p2" : "p1", purpose_defaults: { chat: changed ? "p2" : "p1", image: null }, purpose_version: changed ? 2 : 1 });
    replaceApi((path, options) => {
      if (path === "/agent/model-connections") return Promise.resolve(catalog());
      if (path === "/agent/model-defaults/chat") { changed = true; return Promise.resolve(catalog()); }
      if (path === "/agent/settings" && changed && options?.method !== "PUT") return summary.promise;
      return undefined;
    });
    renderApp();
    await screen.findByRole("heading", { name: "模型管理" });
    fireEvent.click(screen.getByRole("button", { name: "模型列表" }));
    const search = screen.getByLabelText("搜索模型");
    fireEvent.change(search, { target: { value: "gpt-4.1" } });
    fireEvent.click(screen.getByRole("button", { name: "高级设置" }));
    const modelSelect = await screen.findByRole("combobox", { name: "管理单个模型" });
    const option = within(modelSelect).getByRole<HTMLOptionElement>("option", { name: "gpt-4.1 · Service" });
    fireEvent.change(modelSelect, { target: { value: option.value } });
    fireEvent.click(screen.getByRole("button", { name: "设为文本默认" }));
    await waitFor(() => expect(api.fetchJson.mock.calls.filter(([path]) => path === "/agent/settings").length).toBeGreaterThan(1));
    expect(screen.getByRole("heading", { name: "模型管理" })).toBeInTheDocument();
    expect(screen.getByLabelText("搜索模型")).toBe(search);
    await act(async () => summary.resolve({ ...savedSettings, model_name: "gpt-4.1", config_revision: 2, credential_status: "saved_unverified" }));
    expect(screen.getByLabelText("搜索模型")).toHaveValue("gpt-4.1");
  });
  it("uses unified management for modern catalogs and keeps usage diagnostics in advanced mode", async () => {
    mockApi(Promise.resolve({ ...savedSettings, credential_status: "saved_unverified" }));
    replaceApi(path => path === "/agent/model-connections" ? Promise.resolve({ connections: [], profiles: [], default_profile_id: null, purpose_defaults: { chat: null, image: null }, purpose_version: 1 }) : undefined);
    renderApp();
    expect(await screen.findByRole("heading", { name: "模型管理" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "连接第一个服务" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "模型额度" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /高级/ }));
    expect(await screen.findByRole("heading", { name: "模型额度" })).toBeInTheDocument();
    expect(api.fetchJson.mock.calls.some(([path]) => path.endsWith("/discover"))).toBe(false);
  });
  it("does not silently discover models or authenticate saved keychain credentials on load", async () => {
    mockApi(Promise.resolve({ ...savedSettings, credential_status: "saved_unverified" }));
    renderApp();
    expect(await screen.findByText("密钥已保存，使用时授权")).toBeInTheDocument();
    await act(async () => {});
    expect(api.fetchJson.mock.calls.some(([path]) => path === "/agent/models/discover")).toBe(false);
    expect(api.fetchJson.mock.calls.some(([path]) => path === "/agent/model-monitor/check")).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "配置模型" }));
    expect(await screen.findByLabelText("API Key")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await act(async () => {});
    expect(api.fetchJson.mock.calls.some(([path]) => path === "/agent/models/discover")).toBe(false);
  });

  it("waits for saved configuration before editing and preserves other preferences when saving three fields", async () => {
    const initialSettings = deferred<AgentSettings>();
    mockApi(initialSettings.promise);
    renderApp();

    expect(await screen.findByText("正在读取模型配置…")).toBeInTheDocument();
    expect(screen.queryByLabelText("Base URL")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("模型名称")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存并应用" })).not.toBeInTheDocument();
    expect(api.fetchJson.mock.calls.some(([path, options]) => path === "/agent/settings" && options?.method === "PUT")).toBe(false);

    await act(async () => { initialSettings.resolve(savedSettings); });
    expect(await modelField("Base URL")).toHaveValue(savedSettings.model_base_url);
    expect(await modelField("模型名称")).toHaveValue(savedSettings.model_name);

    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://new.example.test/v1" } });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "test-only-new-key" } });
    fireEvent.change(await modelField("模型名称"), { target: { value: "new-model" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));

    await waitFor(() => expect(api.fetchJson.mock.calls.some(([path, options]) => path === "/agent/settings" && options?.method === "PUT")).toBe(true));
    const saveBody = JSON.parse(String(api.fetchJson.mock.calls.find(([path, options]) => path === "/agent/settings" && options?.method === "PUT")?.[1]?.body));
    expect(saveBody).toEqual({ ...savedSettings, model_base_url: "https://new.example.test/v1", api_key: "test-only-new-key", model_name: "new-model", expected_revision: 1, request_id: expect.any(String) });
    expect(await screen.findByText("设置已保存，连接检测成功")).toBeInTheDocument();
    expect(await modelField("API Key")).toHaveValue("");
    expect(screen.getByRole("button", { name: "保存并应用" })).toBeDisabled();
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("reads diagnostics from the saved connection and probes its explicit protocol after cancelling a draft", async () => {
    mockApi();
    renderApp();
    await modelField("Base URL");
    await waitFor(() => expect(api.fetchJson).toHaveBeenCalledWith("/agent/models/capabilities", expect.objectContaining({ signal: expect.any(AbortSignal) })));

    fireEvent.change(await modelField("模型名称"), { target: { value: "unsaved-model" } });
    openAdvancedSettings();
    // The modal hides background diagnostics from the accessibility tree.
    expect(screen.queryByRole("button", { name: "检测" })).not.toBeInTheDocument();
    expect(screen.getByText("检测", { exact: true }).closest("button")).toBeDisabled();
    expect(screen.getByText("立即检测", { exact: true }).closest("button")).toBeDisabled();

    const later = Date.now() + 31_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    act(() => {
      window.history.replaceState(null, "", "#/settings/appearance");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await screen.findByRole("heading", { name: "外观" });
    act(() => {
      window.history.replaceState(null, "", "#/settings/model");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(await modelField("模型名称")).toHaveValue("unsaved-model");
    await waitFor(() => expect(api.fetchJson.mock.calls.filter(([path, options]) => path === "/agent/models/capabilities" && options?.method !== "POST")).toHaveLength(2));
    expect(api.fetchJson.mock.calls.some(([path]) => path.startsWith("/agent/models/capabilities?"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(await modelField("模型名称")).toHaveValue(savedSettings.model_name);
    fireEvent.click(screen.getByRole("button", { name: "关闭模型设置" }));
    openAdvancedSettings();
    fireEvent.click(screen.getByRole("button", { name: "检测" }));

    await waitFor(() => expect(api.fetchJson).toHaveBeenCalledWith("/agent/models/capabilities", expect.objectContaining({
      method: "POST", body: JSON.stringify({
        model_name: savedSettings.model_name, model_base_url: savedSettings.model_base_url,
        model_protocol: "responses", api_key: "", probe: true
      })
    })));
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("keeps a saved connection when an older route refresh finishes afterwards", async () => {
    const oldRead = deferred<AgentSettings>();
    let reads = 0;
    mockApi();
    replaceApi((path, options) => path === "/agent/settings" && options?.method !== "PUT"
      ? (++reads === 1 ? Promise.resolve(savedSettings) : oldRead.promise) : undefined);
    renderApp();
    await modelField("模型名称");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    navigate("#/settings/appearance");
    await screen.findByRole("heading", { name: "外观" });
    navigate("#/settings/model");
    await waitFor(() => expect(reads).toBe(2));
    fireEvent.change(await modelField("模型名称"), { target: { value: "new-model" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    await screen.findByText("设置已保存，连接检测成功");
    await act(async () => { oldRead.resolve(savedSettings); });
    expect(await modelField("模型名称")).toHaveValue("new-model");
    expect(screen.getByText("new-model", { selector: ".model-current-summary strong" })).toBeInTheDocument();
  });

  it("unlocks saved fields while connection diagnostics are still running", async () => {
    const check = deferred<unknown>();
    mockApi();
    replaceApi((path) => path === "/agent/model-monitor/check" ? check.promise : undefined);
    renderApp();
    await modelField("模型名称");
    fireEvent.change(await modelField("模型名称"), { target: { value: "new-model" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    await screen.findByText("设置已保存，正在检测连接");
    expect(await modelField("模型名称")).toBeEnabled();
    expect(await modelField("API Key")).toBeEnabled();
    expect(screen.queryByRole("button", { name: "保存中…" })).not.toBeInTheDocument();
    fireEvent.change(await modelField("模型名称"), { target: { value: "another-model" } });
    expect(screen.getByRole("button", { name: "保存并应用" })).toBeEnabled();
    await act(async () => { check.resolve({ ...monitor, available: false, check_error_message: "暂时不可用" }); });
    expect(screen.getAllByText("配置已保存，但连接检测失败：暂时不可用").length).toBeGreaterThan(0);
    expect(await modelField("模型名称")).toHaveValue("another-model");
  });

  it("shows probe failures and allows retry without an unhandled rejection", async () => {
    mockApi();
    replaceApi((path, options) => path === "/agent/models/capabilities" && options?.method === "POST"
      ? Promise.reject(new Error("检测请求超时")) : undefined);
    renderApp();
    await screen.findByRole("button", { name: "配置模型" });
    openAdvancedSettings();
    const probe = screen.getByRole("button", { name: "检测" });
    await waitFor(() => expect(probe).toBeEnabled());
    fireEvent.click(probe);
    expect((await screen.findAllByText("模型能力检测失败：检测请求超时")).length).toBeGreaterThan(0);
    expect(probe).toBeEnabled();
  });

  it("recovers a failed first read without ever enabling default configuration submission", async () => {
    mockApi();
    let reads = 0;
    replaceApi((path, options) => path === "/agent/settings" && options?.method !== "PUT"
      ? (++reads === 1 ? Promise.reject(new Error("服务暂不可用")) : Promise.resolve(savedSettings)) : undefined);
    renderApp();
    await screen.findByRole("heading", { name: "无法读取模型配置" });
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(await modelField("模型名称")).toHaveValue(savedSettings.model_name);
    expect(api.fetchJson.mock.calls.some(([path, options]) => path === "/agent/settings" && options?.method === "PUT")).toBe(false);
  });

  it.each([
    ["new-token", "/test-api", "developer@example.test"],
    ["test-only-session", "/new-api", "developer@example.test"],
    ["test-only-session", "/test-api", "another@example.test"]
  ])("clears draft secrets and fresh route cache when the client scope changes", async (token, base, email) => {
    const latest = deferred<AgentSettings>();
    mockApi();
    let reads = 0;
    replaceApi((path, options) => path === "/agent/settings" && options?.method !== "PUT"
      ? (++reads === 1 ? Promise.resolve(savedSettings) : latest.promise) : undefined);
    const { rerender } = renderApp();
    await modelField("API Key");
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "test-only-draft" } });
    rerender(appElement(token, base, email));
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    await waitFor(() => expect(reads).toBe(2));
    await act(async () => { latest.resolve({ ...savedSettings, model_name: "scope-model" }); });
    expect(await modelField("模型名称")).toHaveValue("scope-model");
    expect(await modelField("API Key")).toHaveValue("");
    expect(screen.getByRole("button", { name: "保存并应用" })).toBeDisabled();
  });

  it("does not carry a saved key to a changed address on blur or explicit refresh", async () => {
    mockApi();
    renderApp();
    await modelField("Base URL");
    await waitFor(() => expect(api.fetchJson.mock.calls.some(([path]) => path === "/agent/models/discover")).toBe(true));
    const requests = api.fetchJson.mock.calls.filter(([path]) => path === "/agent/models/discover").length;
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "test-only-old-address-draft" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://different.example.test/v1" } });
    fireEvent.blur(screen.getByLabelText("Base URL"));
    fireEvent.click(screen.getByRole("button", { name: "刷新列表" }));
    expect(await modelField("API Key")).toHaveValue("");
    expect(screen.getByText("服务地址已更改，请填写该服务的密钥；不会复用旧地址的密钥。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存并应用" })).toBeDisabled();
    expect(api.fetchJson.mock.calls.filter(([path]) => path === "/agent/models/discover")).toHaveLength(requests);
  });

  it("preserves a conflicting draft and saves against the newly read revision", async () => {
    mockApi();
    let saves = 0;
    let reads = 0;
    replaceApi((path, options) => {
      if (path !== "/agent/settings") return undefined;
      if (options?.method === "PUT") {
        saves += 1;
        if (saves === 1) return Promise.reject(Object.assign(new Error("配置冲突"), { status: 409 }));
        return Promise.resolve({ ...JSON.parse(String(options.body)), api_key: "", api_key_configured: true });
      }
      return Promise.resolve(++reads === 1 ? savedSettings : { ...savedSettings, config_revision: 2, custom_instructions: "另一页面的最新偏好" });
    });
    renderApp();
    await modelField("模型名称");
    fireEvent.change(await modelField("模型名称"), { target: { value: "my-draft-model" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    await screen.findAllByText(/配置已在其他页面更新/);
    expect(await modelField("模型名称")).toHaveValue("my-draft-model");
    await waitFor(() => expect(screen.getByRole("button", { name: "保存并应用" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    await screen.findByText("设置已保存，连接检测成功");
    const body = JSON.parse(String(api.fetchJson.mock.calls.filter(([path, options]) => path === "/agent/settings" && options?.method === "PUT")[1][1]?.body));
    expect(body.expected_revision).toBe(2);
    expect(body.model_name).toBe("my-draft-model");
    expect(body.custom_instructions).toBe("另一页面的最新偏好");
  });

  it("reconciles an uncertain save by request ID without sending a duplicate PUT", async () => {
    mockApi();
    let lastRequestId: string | null = null;
    replaceApi((path, options) => {
      if (path !== "/agent/settings") return undefined;
      if (options?.method === "PUT") {
        lastRequestId = JSON.parse(String(options.body)).request_id;
        return Promise.reject(new Error("请求超时"));
      }
      return Promise.resolve(lastRequestId ? { ...savedSettings, model_name: "saved-after-timeout", config_revision: 2, last_save_request_id: lastRequestId } : savedSettings);
    });
    renderApp();
    await modelField("模型名称");
    fireEvent.change(await modelField("模型名称"), { target: { value: "saved-after-timeout" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    await screen.findByText("设置已保存，连接检测成功");
    expect(await modelField("模型名称")).toHaveValue("saved-after-timeout");
    expect(api.fetchJson.mock.calls.filter(([path, options]) => path === "/agent/settings" && options?.method === "PUT")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "重新确认保存结果" })).not.toBeInTheDocument();
  });

  it("retains an unknown save outcome until a subsequent read confirms its request ID", async () => {
    mockApi();
    let lastRequestId: string | null = null;
    let confirmationRead = 0;
    replaceApi((path, options) => {
      if (path !== "/agent/settings") return undefined;
      if (options?.method === "PUT") {
        lastRequestId = JSON.parse(String(options.body)).request_id;
        return Promise.reject(new Error("连接中断"));
      }
      if (!lastRequestId || ++confirmationRead === 1) return Promise.resolve(savedSettings);
      return Promise.resolve({ ...savedSettings, model_name: "unknown-draft", last_save_request_id: lastRequestId });
    });
    renderApp();
    await modelField("模型名称");
    fireEvent.change(await modelField("模型名称"), { target: { value: "unknown-draft" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    const confirm = await screen.findByRole("button", { name: "重新确认保存结果" });
    expect(await modelField("模型名称")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "保存并应用" })).not.toBeInTheDocument();
    fireEvent.click(confirm);
    await screen.findByText("设置已保存，连接检测成功");
    expect(await modelField("模型名称")).toHaveValue("unknown-draft");
    expect(api.fetchJson.mock.calls.filter(([path, options]) => path === "/agent/settings" && options?.method === "PUT")).toHaveLength(1);
  });


  it("ignores capability and monitor responses from before a successful configuration save", async () => {
    const oldCapabilities = deferred<ModelCapabilityReport>();
    const oldMonitor = deferred<ModelServiceMonitor>();
    let capabilityReads = 0;
    mockApi();
    replaceApi((path, options) => {
      if (path === "/agent/models/capabilities" && options?.method !== "POST") return ++capabilityReads === 1
        ? oldCapabilities.promise : Promise.resolve({ ...capabilities, model_name: "new-model", vision: { ...capabilities.vision, detail: "新配置的能力" } });
      if (path === "/agent/model-monitor?hours=24") return oldMonitor.promise;
      if (path === "/agent/model-monitor/check") return Promise.resolve({ ...monitor, model_name: "new-model", available: true });
      return undefined;
    });
    renderApp();
    await modelField("模型名称");
    fireEvent.change(await modelField("模型名称"), { target: { value: "new-model" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    await screen.findByText("设置已保存，连接检测成功");
    openAdvancedSettings();
    await screen.findByText("新配置的能力");
    await act(async () => {
      oldCapabilities.resolve({ ...capabilities, vision: { ...capabilities.vision, detail: "旧配置的能力" } });
      oldMonitor.resolve({ ...monitor, model_name: "stale-monitor-model" });
    });
    expect(screen.getByText("新配置的能力")).toBeInTheDocument();
    expect(screen.queryByText("旧配置的能力")).not.toBeInTheDocument();
    expect(screen.queryByText("stale-monitor-model")).not.toBeInTheDocument();
  });

  it("ignores a failed check after a newer save has succeeded", async () => {
    const oldCheck = deferred<unknown>();
    let checks = 0;
    mockApi();
    replaceApi(path => path === "/agent/model-monitor/check" ? (++checks === 1 ? oldCheck.promise : Promise.resolve({ ...monitor, available: true })) : undefined);
    renderApp();
    await modelField("模型名称");
    fireEvent.change(await modelField("模型名称"), { target: { value: "first-model" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    await screen.findByText("设置已保存，正在检测连接");
    fireEvent.change(await modelField("模型名称"), { target: { value: "second-model" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    await screen.findByText("设置已保存，连接检测成功");
    await act(async () => { oldCheck.resolve({ ...monitor, available: false, check_error_message: "旧连接失败" }); });
    expect(screen.queryByText(/旧连接失败/)).not.toBeInTheDocument();
    expect(await modelField("模型名称")).toHaveValue("second-model");
  });

  it("ignores a response from a superseded authentication client even if it ignores cancellation", async () => {
    const oldRead = deferred<AgentSettings>();
    mockApi();
    let reads = 0;
    replaceApi((path, options) => path === "/agent/settings" && options?.method !== "PUT"
      ? (++reads === 1 ? oldRead.promise : Promise.resolve({ ...savedSettings, model_name: "new-session-model" })) : undefined);
    const { rerender } = renderApp();
    await screen.findByText("正在读取模型配置…");
    rerender(appElement("new-session"));
    expect(await modelField("模型名称")).toHaveValue("new-session-model");
    await act(async () => { oldRead.resolve({ ...savedSettings, model_name: "old-session-model" }); });
    expect(await modelField("模型名称")).toHaveValue("new-session-model");
  });

  it("uses the historical receipt when another save has replaced the last request ID", async () => {
    mockApi();
    let requestId: string | null = null;
    const newest = { ...savedSettings, model_name: "later-update-model", config_revision: 3, last_save_request_id: "another-request" };
    replaceApi((path, options) => {
      if (path.startsWith("/agent/settings/requests/")) return Promise.resolve({ committed: true, saved_revision: 2, settings: newest });
      if (path !== "/agent/settings") return undefined;
      if (options?.method === "PUT") { requestId = JSON.parse(String(options.body)).request_id; return Promise.reject(new Error("请求超时")); }
      return Promise.resolve(requestId ? newest : savedSettings);
    });
    renderApp();
    await modelField("模型名称");
    fireEvent.change(await modelField("模型名称"), { target: { value: "my-committed-model" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    await screen.findByText("此前保存已提交，当前配置已由后续更新覆盖。当前显示服务端最新配置。");
    expect(await modelField("模型名称")).toHaveValue("later-update-model");
    expect(api.fetchJson.mock.calls.filter(([path, options]) => path === "/agent/settings" && options?.method === "PUT")).toHaveLength(1);
  });

  it("reads the latest revision before resuming editing after an unconfirmed save", async () => {
    mockApi();
    let saves = 0;
    const latest = { ...savedSettings, model_name: "server-model", config_revision: 2 };
    replaceApi((path, options) => {
      if (path.startsWith("/agent/settings/requests/")) return Promise.resolve({ committed: false, saved_revision: null, settings: latest });
      if (path !== "/agent/settings") return undefined;
      if (options?.method === "PUT") {
        if (++saves === 1) return Promise.reject(new Error("请求超时"));
        return Promise.resolve({ ...JSON.parse(String(options.body)), api_key: "", api_key_configured: true, config_revision: 3 });
      }
      return Promise.resolve(saves ? latest : savedSettings);
    });
    renderApp();
    await modelField("模型名称");
    fireEvent.change(await modelField("模型名称"), { target: { value: "pending-draft" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    const resume = await screen.findByRole("button", { name: "读取最新配置并继续编辑" });
    await waitFor(() => expect(resume).toBeEnabled());
    fireEvent.click(resume);
    await screen.findByText(/已读取最新配置，可以继续编辑/);
    expect(await modelField("模型名称")).toHaveValue("pending-draft");
    expect(await modelField("模型名称")).toBeEnabled();
    expect(saves).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    await screen.findByText("设置已保存，连接检测成功");
    const body = JSON.parse(String(api.fetchJson.mock.calls.filter(([path, options]) => path === "/agent/settings" && options?.method === "PUT")[1][1]?.body));
    expect(body.expected_revision).toBe(2);
    expect(body.model_name).toBe("pending-draft");
  });


  it("offers every service in unified management and saves purpose rules independently", async () => {
    mockApi();
    const catalog: ModelCatalog = {
      connections: [
        { id: "c1", name: "主连接", model_base_url: savedSettings.model_base_url, model_protocol: "responses", api_key_configured: true, enabled: true, revision: 1 },
        { id: "c2", name: "历史图片连接", model_base_url: "https://second.example.test/v1", model_protocol: "openai", api_key_configured: true, enabled: true, revision: 1 }
      ],
      profiles: [
        { id: "p1", connection_id: "c1", model_name: savedSettings.model_name, enabled: true, revision: 1, supported_purposes: ["chat"] },
        { id: "p2", connection_id: "c1", model_name: "second-model", enabled: true, revision: 1, supported_purposes: ["chat"] },
        { id: "legacy", connection_id: "c2", model_name: "legacy-image", enabled: true, revision: 1, supported_purposes: ["image"] }
      ], default_profile_id: "p1", service_connection_id: "c1", purpose_defaults: { chat: "p1", image: null }, purpose_version: 1
    };
    let changed = false;
    const response = () => ({ ...catalog, default_profile_id: changed ? "p2" : "p1", purpose_defaults: { chat: changed ? "p2" : "p1", image: null }, purpose_version: changed ? 2 : 1 });
    replaceApi((path, options) => {
      if (path === "/agent/model-connections") return Promise.resolve(response());
      if (path === "/agent/model-defaults/chat") { changed = true; return Promise.resolve(response()); }
      if (path === "/agent/settings" && options?.method !== "PUT" && changed) return Promise.resolve({ ...savedSettings, model_name: "second-model", config_revision: 2 });
      return undefined;
    });
    renderApp();
    await screen.findByRole("heading", { name: "模型管理" });
    expect(screen.getByRole("button", { name: "添加服务" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "模型列表" }));
    fireEvent.click(screen.getByRole("combobox", { name: "按服务筛选" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "历史图片连接" })).toBeVisible());
    fireEvent.keyDown(screen.getByRole("combobox", { name: "搜索服务" }), { key: "Escape" });
    expect(screen.queryByRole("button", { name: "使用规则" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "场景默认模型" }));
    fireEvent.click(screen.getByRole("button", { name: "更换文本对话模型" }));
    const picker = screen.getByRole("region", { name: "选择文本对话模型" });
    expect(within(picker).queryByRole("radio", { name: /legacy-image/ })).not.toBeInTheDocument();
    fireEvent.click(within(picker).getByRole("radio", { name: /second-model/ }));
    fireEvent.click(within(picker).getByRole("button", { name: "设为默认" }));
    await waitFor(() => expect(picker).not.toBeInTheDocument());
    expect(within(screen.getByRole("region", { name: "当前默认模型" })).getByText("second-model")).toBeInTheDocument();
    expect(api.fetchJson.mock.calls.some(([path, options]) => path === "/agent/settings" && options?.method === "PUT")).toBe(false);
    expect(api.fetchJson.mock.calls.some(([path]) => path.includes("c2/discover"))).toBe(false);
  });

  it("sends the full saved settings when switching the default kernel", async () => {
    mockApi(Promise.resolve({ ...savedSettings, credential_status: "saved_unverified" }));
    replaceApi((path) => path === "/agent/kernels"
      ? Promise.resolve({
          choices: [
            { id: "tuantuan", name: "团团内核", available: true, reason: "" },
            { id: "dsh", name: "DeepSeek Harness", available: true, reason: "" }
          ],
          default_kernel: "tuantuan"
        })
      : undefined);
    renderApp();
    fireEvent.change(await screen.findByLabelText("新对话默认内核"), { target: { value: "dsh" } });

    await waitFor(() => expect(
      api.fetchJson.mock.calls.some(([path, options]) => path === "/agent/settings" && options?.method === "PUT")
    ).toBe(true));
    const saveBody = JSON.parse(String(
      api.fetchJson.mock.calls.find(([path, options]) => path === "/agent/settings" && options?.method === "PUT")?.[1]?.body
    ));
    expect(saveBody.default_kernel).toBe("dsh");
    expect(saveBody.persona_role).toBe(savedSettings.persona_role);
  });

});
