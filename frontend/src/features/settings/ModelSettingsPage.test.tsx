import type { ReactElement } from "react";
import { cleanup, fireEvent, render as baseRender, screen, waitFor, within } from "@testing-library/react";
import type { createApiClient } from "../../api/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAgentSettings } from "../../constants";
import type { AgentSettings, ModelCapabilityReport, ModelServiceMonitor } from "../../types";
import { ModelSettingsPage } from "./ModelSettingsPage";

const settings: AgentSettings = {
  ...defaultAgentSettings,
  model_name: "gpt-5.5",
  model_base_url: "https://api.openai.com/v1",
  model_protocol: "auto",
  api_key: "",
  api_key_configured: true
};

const monitor: ModelServiceMonitor = {
  status: "healthy",
  status_message: "最近调用正常",
  model_name: "gpt-5.5",
  base_url: "https://api.openai.com/v1",
  protocol: "openai",
  api_key_configured: true,
  window_hours: 24,
  summary: {
    total_requests: 10,
    successful_requests: 9,
    failed_requests: 1,
    success_rate: 90,
    average_latency_ms: 400,
    p95_latency_ms: 800,
    timeout_count: 0,
    consecutive_failures: 0,
    total_tokens: 1280
  },
  usage: {
    window_hours: 24,
    total_tokens: 1280,
    remaining_quota: null,
    quota_available: false
  },
  error_breakdown: [],
  last_event_at: "2026-08-14T04:00:00Z",
  last_success_at: "2026-08-14T04:00:00Z",
  last_check_at: "2026-08-14T04:00:00Z",
  recent_events: []
};

const capabilities: ModelCapabilityReport = {
  model_name: "gpt-5.5",
  provider: "openai",
  provider_label: "OpenAI",
  protocol: "openai",
  protocol_label: "OpenAI 兼容 Chat Completions",
  vision: { status: "supported", source: "model_id", detail: "该模型 ID 通常支持图片 / 多模态输入" },
  streaming: { status: "supported", source: "client", detail: "当前 OpenAI 兼容客户端会对该对话模型发起流式请求" },
  tools: { status: "supported", source: "client", detail: "当前客户端会向该对话模型发送工具 / function calling" },
  probed: false,
  probe_error: null,
  attachment_vision_enabled: false
};

function props(overrides: Partial<Parameters<typeof ModelSettingsPage>[0]> = {}) {
  return {
    fetchJson: vi.fn() as unknown as ReturnType<typeof createApiClient>,
    settings,
    savedSettings: settings,
    editing: false,
    busy: false,
    monitor,
    monitorBusy: false,
    availableModels: ["gpt-5.5", "gpt-4.1"],
    discoveryBusy: false,
    discoveryError: "",
    capabilities,
    capabilitiesBusy: false,
    onSettingsChange: vi.fn(),
    onDiscoverModels: vi.fn(),
    onCheckService: vi.fn(),
    onProbeCapabilities: vi.fn(),
    onBeginEdit: vi.fn(),
    onCancelEdit: vi.fn(),
    onSave: vi.fn(),
    ...overrides
  };
}

function render(ui: ReactElement) {
  const result = baseRender(ui);
  if (!screen.queryByRole("dialog")) fireEvent.click(screen.getByRole("button", { name: "配置模型" }));
  return result;
}

function openAdvancedSettings() {
  const protocol = screen.queryByText("高级选项：接口协议（默认自动匹配）")?.closest("details");
  if (protocol) protocol.open = true;
  const summary = screen.getByText("高级设置");
  fireEvent.click(summary);
  const details = summary.closest("details");
  if (details) details.open = true;
}

describe("ModelSettingsPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens connection management instead of duplicating connection fields", () => {
    baseRender(<ModelSettingsPage {...props({ connectionManager: <h3 id="model-connections-title">服务连接</h3>, purposeManager: <h3>使用规则</h3> })} />);
    expect(screen.getByText("服务连接")).toBeInTheDocument();
    expect(screen.getByText("使用规则")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "配置模型" })).not.toBeInTheDocument();
  });

  it("shows the saved model, key state and connection status without opening the dialog", () => {
    baseRender(<ModelSettingsPage {...props()} />);
    const summary = screen.getByRole("heading", { name: "默认模型" }).closest("section");
    expect(summary).not.toBeNull();
    expect(within(summary!).getByText("gpt-5.5")).toBeInTheDocument();
    expect(within(summary!).getByText("密钥已配置")).toBeInTheDocument();
    expect(within(summary!).getByText("运行正常")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("explains image defaults and text routing", () => {
    baseRender(<ModelSettingsPage {...props({ savedSettings: { ...settings, model_name: "gpt-image-2.5-sunburst" } })} />);
    expect(screen.getByRole("heading", { name: "默认模型" })).toBeInTheDocument();
    expect(screen.getByText(/图片生成模型 · 普通文字请求会尝试使用已启用的聊天模型/)).toBeInTheDocument();
  });

  it("distinguishes image configuration from chat routing and unavailable video", () => {
    baseRender(<ModelSettingsPage {...props({ savedSettings: { ...settings, model_name: "gpt-image-2.5-sunburst" } })} />);
    const summary = screen.getByRole("heading", { name: "模型用途" }).closest("section")!;
    expect(within(summary).getByText("默认配置：gpt-image-2.5-sunburst")).toBeInTheDocument();
    expect(within(summary).getByText("自动选择已启用的聊天模型")).toBeInTheDocument();
    expect(within(summary).getByText("暂未接入")).toBeInTheDocument();
  });

  it("focuses the first field and restores focus after Escape", async () => {
    const onCancelEdit = vi.fn();
    baseRender(<ModelSettingsPage {...props({ onCancelEdit })} />);
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "配置模型" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "配置模型" });
    const url = within(dialog).getByLabelText("Base URL");
    await waitFor(() => expect(url).toHaveFocus());
    expect(screen.queryByRole("heading", { name: "默认模型" })).not.toBeInTheDocument();
    fireEvent.keyDown(url, { key: "Escape" });
    expect(dialog).not.toBeInTheDocument();
    expect(onCancelEdit).toHaveBeenCalledOnce();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps a failed save open and closes only after editing finishes", () => {
    const page = props({ editing: true });
    const { rerender } = baseRender(<ModelSettingsPage {...page} />);
    rerender(<ModelSettingsPage {...page} busy />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "关闭模型设置" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(dialog).toBeInTheDocument();
    expect(page.onCancelEdit).not.toHaveBeenCalled();
    rerender(<ModelSettingsPage {...page} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    rerender(<ModelSettingsPage {...page} editing={false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows save errors inside the dialog and allows an explicit cancel", () => {
    const onCancelEdit = vi.fn();
    baseRender(<ModelSettingsPage {...props({ editing: true, error: "保存失败，请重试", onCancelEdit })} />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("保存失败，请重试");
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭模型设置" }));
    expect(dialog).not.toBeInTheDocument();
    expect(onCancelEdit).toHaveBeenCalledOnce();
  });

  it("shows newly entered keys by default and allows hiding them", () => {
    const page = props({ editing: true });
    const { rerender } = render(<ModelSettingsPage {...page} />);
    rerender(<ModelSettingsPage {...page} settings={{ ...settings, api_key: "test-only-draft" }} />);
    expect(screen.getByLabelText("API Key")).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "隐藏 API Key" }));
    expect(screen.getByLabelText("API Key")).toHaveAttribute("type", "password");
  });

  it("shows the saved key on opening without changing the draft", async () => {
    const fetchJson = vi.fn().mockResolvedValue({ api_key: "stored-test-key" });
    const onSettingsChange = vi.fn();
    const savedSettings = { ...settings, connection_id: "c1" };
    render(<ModelSettingsPage {...props({ fetchJson: fetchJson as unknown as ReturnType<typeof createApiClient>, savedSettings, onSettingsChange })} />);
    await waitFor(() => expect(screen.getByLabelText("API Key")).toHaveValue("stored-test-key"));
    expect(screen.getByLabelText("API Key")).toHaveAttribute("type", "text");
    expect(fetchJson).toHaveBeenCalledWith("/agent/model-connections/c1/reveal-key", { method: "POST" });
    expect(onSettingsChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "隐藏 API Key" }));
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    expect(screen.getByLabelText("API Key")).toHaveAttribute("type", "password");
  });

  it("ignores a delayed saved key when the service address changes", async () => {
    let resolveKey!: (value: { api_key: string }) => void;
    const fetchJson = vi.fn().mockImplementation(() => new Promise(resolve => { resolveKey = resolve; }));
    const page = props({ fetchJson: fetchJson as unknown as ReturnType<typeof createApiClient>, savedSettings: { ...settings, connection_id: "c1" } });
    const { rerender } = render(<ModelSettingsPage {...page} />);
    rerender(<ModelSettingsPage {...page} settings={{ ...settings, model_base_url: "https://new.example.test" }} />);
    resolveKey({ api_key: "stored-test-key" });
    await waitFor(() => expect(screen.getByLabelText("API Key")).toHaveValue(""));
  });

  it("filters a large catalog while preserving the selected model", () => {
    const onSettingsChange = vi.fn();
    render(<ModelSettingsPage {...props({ availableModels: ["gpt-5.5", ...Array.from({ length: 10 }, (_, i) => `custom-${i}`)], onSettingsChange })} />);
    fireEvent.change(screen.getByLabelText("搜索模型"), { target: { value: "CUSTOM-8" } });
    const select = screen.getByLabelText("模型名称") as HTMLSelectElement;
    expect(Array.from(select.options).map(item => item.value)).toEqual(["gpt-5.5", "custom-8"]);
    fireEvent.change(select, { target: { value: "custom-8" } });
    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ model_name: "custom-8" }));
    fireEvent.change(screen.getByLabelText("搜索模型"), { target: { value: "missing" } });
    expect(screen.getByText("没有匹配的模型，可修改搜索词或手动填写。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "手动填写" }));
    expect(screen.queryByLabelText("搜索模型")).not.toBeInTheDocument();
    expect(screen.getByLabelText("模型名称")).toHaveAttribute("placeholder", "输入模型名称");
  });

  it("explains why saving is unavailable when a new service needs a key", () => {
    render(<ModelSettingsPage {...props({ editing: true, settings: { ...settings, model_base_url: "https://new.example.test" } })} />);
    expect(screen.getByText("请填写当前服务的 API Key")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存并应用" })).toBeDisabled();
  });

  it("prevents dismissal while a save result is unknown", () => {
    baseRender(<ModelSettingsPage {...props({ saveUnknown: true })} />);
    expect(screen.getByRole("button", { name: "关闭模型设置" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows editable connection fields and keeps technical settings collapsed initially", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<ModelSettingsPage {...props()} />);

    expect(screen.getByRole("dialog", { name: "配置模型" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Base URL/)).toHaveValue("https://api.openai.com/v1");
    expect(screen.getByLabelText(/^Base URL/)).not.toBeDisabled();
    expect(screen.getByLabelText(/^Base URL/)).not.toHaveAttribute("readonly");
    expect(screen.getByLabelText(/^API Key/)).not.toBeDisabled();
    expect(screen.getByLabelText(/^API Key/)).not.toHaveAttribute("readonly");
    expect(screen.getByLabelText("模型名称")).toHaveValue("gpt-5.5");
    expect(screen.getByLabelText("模型名称")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "保存并应用" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeEnabled();
    expect(screen.queryByText("已锁定")).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "模型列表", hidden: true })).not.toBeInTheDocument();
    const advanced = screen.getByText("高级设置").closest("details")!;
    expect(advanced).not.toHaveAttribute("open");
    expect(screen.getByLabelText(/^接口协议/)).not.toBeVisible();
    for (const title of ["模型额度", "模型能力检测", "连接状态与调用质量"]) {
      expect(within(advanced).getByText(title, { selector: "h3" })).not.toBeVisible();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["Base URL", "https://models.example.test/v1", "model_base_url"],
    ["API Key", "test-key", "api_key"],
    ["模型名称", "gpt-4.1", "model_name"]
  ])("begins editing when the person changes %s without an unlock step", (label, value, field) => {
    const onSettingsChange = vi.fn();
    const onBeginEdit = vi.fn();
    render(<ModelSettingsPage {...props({ onSettingsChange, onBeginEdit })} />);

    fireEvent.change(screen.getByLabelText(new RegExp(`^${label}`)), { target: { value } });

    expect(onBeginEdit).toHaveBeenCalledOnce();
    expect(onSettingsChange).toHaveBeenCalledWith({ ...settings, [field]: value });
  });

  it("saves a changed connection and cancels editing through their respective callbacks", () => {
    const onSave = vi.fn();
    const onCancelEdit = vi.fn();
    const onBeginEdit = vi.fn();
    const onSettingsChange = vi.fn();
    render(<ModelSettingsPage {...props({ editing: true, onSettingsChange, onSave, onCancelEdit, onBeginEdit })} />);

    fireEvent.change(screen.getByLabelText("模型名称"), { target: { value: "gpt-4.1" } });
    expect(onSettingsChange).toHaveBeenCalledWith({ ...settings, model_name: "gpt-4.1" });
    expect(onBeginEdit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    expect(onSave).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancelEdit).toHaveBeenCalledOnce();
  });

  it("disables the form while saving to prevent another change or duplicate submission", () => {
    const onSave = vi.fn();
    render(<ModelSettingsPage {...props({ editing: true, busy: true, onSave })} />);

    expect(screen.getByLabelText(/^Base URL/)).toBeDisabled();
    expect(screen.getByLabelText(/^API Key/)).toBeDisabled();
    expect(screen.getByLabelText("模型名称")).toBeDisabled();
    const save = screen.getByRole("button", { name: "保存中…" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("lets the person switch among discovered models", () => {
    const onSettingsChange = vi.fn();
    const availableModels = [
      "gpt-5.5",
      "codex-auto-review",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra"
    ];
    render(<ModelSettingsPage {...props({ editing: true, availableModels, onSettingsChange })} />);

    const select = screen.getByLabelText("模型名称");
    expect(select.tagName).toBe("SELECT");
    expect(select).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "保存并应用" })).toBeEnabled();

    fireEvent.change(select, { target: { value: "deepseek-v4-flash" } });
    expect(onSettingsChange).toHaveBeenCalledWith({ ...settings, model_name: "deepseek-v4-flash" });
  });

  it("allows a custom model name even when the service has returned a model list", () => {
    const onSettingsChange = vi.fn();
    const pageProps = props({ onSettingsChange });
    const { rerender } = render(<ModelSettingsPage {...pageProps} />);

    fireEvent.click(screen.getByRole("button", { name: "手动填写" }));
    const modelName = screen.getByLabelText("模型名称");
    expect(modelName.tagName).toBe("INPUT");
    expect(modelName).not.toBeDisabled();
    expect(modelName).toHaveValue("gpt-5.5");
    fireEvent.change(modelName, { target: { value: "custom-chat-model" } });
    expect(onSettingsChange).toHaveBeenCalledWith({ ...settings, model_name: "custom-chat-model" });
    rerender(<ModelSettingsPage {...pageProps} settings={{ ...settings, model_name: "custom-chat-model" }} editing />);

    fireEvent.click(screen.getByRole("button", { name: "从列表选择" }));
    expect(screen.getByLabelText("模型名称").tagName).toBe("SELECT");
    expect(screen.getByLabelText("模型名称")).toHaveValue("custom-chat-model");
  });

  it("does not disable the model select just because rediscovery is in progress", () => {
    const onSettingsChange = vi.fn();
    render(<ModelSettingsPage {...props({
      editing: true,
      availableModels: ["gpt-5.5", "codex-auto-review", "deepseek-v4-flash"],
      discoveryBusy: true,
      onSettingsChange
    })} />);

    const select = screen.getByLabelText("模型名称");
    expect(select).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "读取中…" })).toBeDisabled();

    fireEvent.change(select, { target: { value: "codex-auto-review" } });
    expect(onSettingsChange).toHaveBeenCalledWith({ ...settings, model_name: "codex-auto-review" });
  });

  it("keeps manual entry available when the model list cannot be read", () => {
    const onSettingsChange = vi.fn();
    render(<ModelSettingsPage {...props({
      availableModels: [],
      discoveryError: "识别可用模型失败",
      onSettingsChange
    })} />);

    const input = screen.getByLabelText("模型名称");
    expect(input.tagName).toBe("INPUT");
    expect(input).not.toBeDisabled();
    expect(input).not.toHaveAttribute("readonly");
    fireEvent.change(input, { target: { value: "gpt-5.4-mini" } });
    expect(onSettingsChange).toHaveBeenCalledWith({ ...settings, model_name: "gpt-5.4-mini" });
  });

  it("uses a concise recovery hint rather than displaying a technical model discovery error", () => {
    const discoveryError = "模型目录 https://www.example.test/models 没有返回 OpenAI 兼容的模型列表，请确认 Base URL 填写的是模型服务的 API 网关地址";
    render(<ModelSettingsPage {...props({ availableModels: [], discoveryError })} />);

    expect(screen.getByText("未能读取模型列表，可手动填写模型名称。")).toBeInTheDocument();
    expect(screen.getByText(discoveryError, { exact: false })).not.toBeVisible();
  });

  it("lets the person refresh the model list explicitly", () => {
    const onDiscoverModels = vi.fn();
    render(<ModelSettingsPage {...props({ onDiscoverModels })} />);

    fireEvent.click(screen.getByRole("button", { name: "刷新列表" }));
    expect(onDiscoverModels).toHaveBeenCalledWith(true);
  });

  it("offers protocol, quota, capability and connection diagnostics after opening advanced settings", () => {
    const onProbeCapabilities = vi.fn();
    render(<ModelSettingsPage {...props({ onProbeCapabilities })} />);
    const dialog = screen.getByRole("dialog", { name: "配置模型" });
    const protocol = within(dialog).getByText("高级选项：接口协议（默认自动匹配）").closest("details")!;
    protocol.open = true;
    expect(within(dialog).getByRole("combobox", { name: /^接口协议/ })).toBeVisible();
    expect(within(dialog).getByDisplayValue("自动匹配（当前：OpenAI 兼容 Chat Completions）")).toBeVisible();
    expect(within(dialog).getByText(/系统不会自动添加 \/v1/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    openAdvancedSettings();

    expect(screen.getByRole("heading", { name: "模型额度" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "模型能力检测" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "连接状态与调用质量" })).toBeInTheDocument();
    expect(screen.getByText("暂无额度数据")).toBeInTheDocument();
    expect(screen.getByText("1,280")).toBeInTheDocument();
    expect(screen.getByText("是否支持多模态")).toBeInTheDocument();
    expect(screen.getAllByText("支持").length).toBeGreaterThanOrEqual(3);
    fireEvent.click(screen.getByRole("button", { name: "检测" }));
    expect(onProbeCapabilities).toHaveBeenCalledOnce();
  });

  it("prefers Anthropic Messages for Claude models on a custom gateway", () => {
    const onSettingsChange = vi.fn();
    render(<ModelSettingsPage {...props({
      settings: { ...settings, model_name: "claude-sonnet-5-thinking", model_base_url: "https://api.example.test" },
      editing: true,
      capabilities: null,
      onSettingsChange
    })} />);
    openAdvancedSettings();

    const protocol = screen.getByDisplayValue("自动匹配（优先：Anthropic Messages API）");
    expect(protocol).not.toBeDisabled();
    fireEvent.change(protocol, { target: { value: "openai" } });
    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ model_protocol: "openai" }));
  });

  it("uses Anthropic Messages for the official Anthropic host", () => {
    render(<ModelSettingsPage {...props({
      settings: { ...settings, model_name: "claude-sonnet-5-thinking", model_base_url: "https://api.anthropic.com" },
      capabilities: null
    })} />);
    openAdvancedSettings();

    expect(screen.getByDisplayValue("自动匹配（优先：Anthropic Messages API）")).toBeInTheDocument();
  });

  it("offers the common native protocols and recognizes Ollama without requiring a key", () => {
    render(<ModelSettingsPage {...props({
      settings: { ...settings, model_name: "qwen3", model_base_url: "http://localhost:11434" },
      editing: true,
      capabilities: null
    })} />);
    openAdvancedSettings();

    const protocol = screen.getByDisplayValue("自动匹配（优先：Ollama Chat API）");
    expect(protocol).toContainHTML('<option value="responses">OpenAI Responses API</option>');
    expect(protocol).toContainHTML('<option value="gemini">Google Gemini generateContent</option>');
    expect(protocol).toContainHTML('<option value="ollama">Ollama Chat API</option>');
    expect(screen.getByPlaceholderText("本地 Ollama 可留空")).toBeInTheDocument();
    expect(screen.getByText("本地 Ollama 可不填写密钥。")).toBeInTheDocument();
  });

  it("explains a managed read-only credential without asking to repair a keychain", () => {
    render(<ModelSettingsPage {...props({ savedSettings: { ...settings, secret_storage_writable: false, api_key_source: "environment" } })} />);
    expect(screen.getByText("当前使用只读环境变量密钥，页面无法更换；本地 macOS 可使用系统钥匙串保存个人密钥。")).toBeInTheDocument();
    expect(screen.getByLabelText("API Key")).toBeDisabled();
    expect(screen.getByLabelText("模型名称")).toBeEnabled();
    expect(screen.queryByText(/修复系统钥匙串/)).not.toBeInTheDocument();
  });

  it("allows replacing an environment key when local keychain storage is writable", () => {
    render(<ModelSettingsPage {...props({ editing: true, savedSettings: { ...settings, secret_storage: "keyring", secret_storage_writable: true, api_key_source: "environment" } })} />);
    expect(screen.getByLabelText("API Key")).toBeEnabled();
    expect(screen.queryByText(/当前使用只读环境变量密钥/)).not.toBeInTheDocument();
  });

  it("shows the negotiated protocol for the saved connection and a prediction for a draft", () => {
    const page = props({ settings: { ...settings, model_name: "claude-test" }, savedSettings: { ...settings, model_name: "claude-test" }, monitor: { ...monitor, model_name: "claude-test", protocol: "openai" } });
    const { rerender } = render(<ModelSettingsPage {...page} />);
    openAdvancedSettings();
    expect(screen.getByDisplayValue("自动匹配（当前：OpenAI 兼容 Chat Completions）")).toBeInTheDocument();
    rerender(<ModelSettingsPage {...page} editing />);
    expect(screen.getByDisplayValue("自动匹配（优先：Anthropic Messages API）")).toBeInTheDocument();
  });

  it("offers reconciliation and a version-checked recovery path for an uncertain save", () => {
    const onConfirmSave = vi.fn();
    const onResumeEditing = vi.fn();
    render(<ModelSettingsPage {...props({ editing: true, saveUnknown: true, onConfirmSave, onResumeEditing })} />);
    expect(screen.getByLabelText("API Key")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "保存并应用" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新确认保存结果" }));
    fireEvent.click(screen.getByRole("button", { name: "读取最新配置并继续编辑" }));
    expect(onConfirmSave).toHaveBeenCalledOnce();
    expect(onResumeEditing).toHaveBeenCalledOnce();
  });

  it("labels the protocol auto mode actually uses in the protocol and monitor cards", () => {
    const detectedSettings: AgentSettings = { ...settings, model_name: "grok-4.7", detected_model_protocol: "responses", resolved_model_protocol: "responses" };
    render(<ModelSettingsPage {...props({
      settings: detectedSettings,
      savedSettings: detectedSettings,
      monitor: { ...monitor, model_name: "grok-4.7", protocol: "responses", detected_protocol: "responses", protocol_label: "自动 · 实际使用 OpenAI Responses API" }
    })} />);
    openAdvancedSettings();
    expect(screen.getByText("自动 · 实际使用 OpenAI Responses API", { selector: ".model-detected-protocol" })).toBeInTheDocument();
    expect(screen.getByText(/^自动 · 实际使用 OpenAI Responses API · /)).toBeInTheDocument();
  });

  it("shows estimated cost, per-call cost and fallback answers in the monitor", () => {
    render(<ModelSettingsPage {...props({
      monitor: {
        ...monitor,
        summary: { ...monitor.summary, estimated_cost_usd: 0.0123, priced_requests: 8, unpriced_requests: 2, fallback_requests: 1 },
        recent_events: [{ id: 1, request_kind: "stream", status: "success", error_code: "", error_message: "", latency_ms: 420, total_tokens: 30, model_name: "claude-sonnet-4-5", base_url: "", protocol: "anthropic", created_at: "2026-08-14T04:00:00Z", cost_usd: 0.00042, backend: "litellm", fallback_from_profile_id: "p1" }]
      },
      capabilities: { ...capabilities, merged: {
        profile_id: "p1", model_name: "gpt-5.5", protocol: "openai",
        capabilities: { reasoning: { status: "supported", source: "litellm", detail: "", label: "推理", overridden: false, probe_status: null, litellm_status: "supported" } } as never,
        context_window: { tokens: 400000, source: "litellm" }, max_output_tokens: { tokens: 128000, source: "litellm" },
        litellm_known: true, pricing: { input_per_million_usd: null, output_per_million_usd: null }
      } }
    })} />);
    openAdvancedSettings();
    expect(screen.getByText("近 24h 估算费用")).toBeInTheDocument();
    expect(screen.getByText("$0.01")).toBeInTheDocument();
    expect(screen.getByText("8 次有价格数据，2 次未计价")).toBeInTheDocument();
    expect(screen.getByText("420 ms · $0.0004")).toBeInTheDocument();
    expect(screen.getByText("备用")).toBeInTheDocument();
    expect(screen.getByText(/上下文长度 400K · 最大输出 128K · 推理 支持（LiteLLM）/)).toBeInTheDocument();
  });
});
