import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySettingsPage } from "./MemorySettingsPage";
import { ApiError, type createApiClient } from "../../api/client";
import type { AgentSettings, MemoryOverview, MemoryRule, MemorySummary } from "../../types";

type FetchJson = ReturnType<typeof createApiClient>;

const agentSettings: AgentSettings = {
  display_name: "团团",
  persona_role: "主动、清晰的 AI 伙伴",
  response_style: "concise",
  custom_instructions: "",
  library_memory_enabled: true,
  conversation_memory_enabled: true,
  knowledge_memory_enabled: true,
  user_memory_enabled: true,
  summary_enabled: true,
  context_message_limit: 12,
  model_name: "local-model",
  model_base_url: "",
  model_protocol: "auto",
  api_key: "",
  api_key_configured: false,
  default_kernel: "tuantuan",
  config_revision: 7
};

const memoryItems: MemorySummary[] = [
  { id: 1, kind: "fact", summary: "用户住在杭州", source_conversation_id: 12, created_at: "2026-11-01T08:00:00Z", updated_at: "2026-11-01T08:00:00Z" },
  { id: 2, kind: "preference", summary: "喜欢简洁的回答", source_conversation_id: null, created_at: "2026-11-02T08:00:00Z", updated_at: "2026-11-02T08:00:00Z" }
];

const memoryRules: MemoryRule[] = [
  { id: 1, rule: "回答时默认使用中文", enabled: true, created_at: "2026-11-03T08:00:00Z", updated_at: "2026-11-03T08:00:00Z" }
];

const overview: MemoryOverview = { enabled: true, items: memoryItems, rules: memoryRules };

function createApi(initial: { overview: MemoryOverview; settings: AgentSettings }) {
  const calls: Array<{ path: string; options?: RequestInit }> = [];
  const memory = {
    enabled: initial.overview.enabled,
    items: initial.overview.items.map((item) => ({ ...item })),
    rules: initial.overview.rules.map((rule) => ({ ...rule }))
  };
  const settings = { ...initial.settings };
  let nextRuleId = memory.rules.reduce((max, rule) => Math.max(max, rule.id), 0) + 1;

  const fetchJson = vi.fn(async (path: string, options?: RequestInit) => {
    calls.push({ path, options });
    const method = options?.method ?? "GET";
    if (path === "/memory" && method === "GET") {
      return { enabled: memory.enabled, items: memory.items.map((item) => ({ ...item })), rules: memory.rules.map((rule) => ({ ...rule })) };
    }
    if (path === "/agent/settings" && method === "GET") return { ...settings };
    if (path === "/agent/settings" && method === "PUT") {
      const body = JSON.parse(String(options?.body)) as { user_memory_enabled?: boolean; expected_revision?: number };
      if (body.expected_revision !== settings.config_revision) throw new ApiError("配置已在其他页面更新", 409);
      if (typeof body.user_memory_enabled === "boolean") {
        settings.user_memory_enabled = body.user_memory_enabled;
        memory.enabled = settings.user_memory_enabled;
      }
      settings.config_revision = (settings.config_revision ?? 0) + 1;
      return { ...settings };
    }
    const itemMatch = path.match(/^\/memory\/items\/(\d+)$/);
    if (itemMatch && method === "DELETE") {
      memory.items = memory.items.filter((entry) => entry.id !== Number(itemMatch[1]));
      return { deleted: true };
    }
    if (path === "/memory/rules" && method === "POST") {
      const body = JSON.parse(String(options?.body)) as { rule: string };
      const rule: MemoryRule = { id: nextRuleId++, rule: body.rule, enabled: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      memory.rules.push(rule);
      return rule;
    }
    if (path === "/memory/rules" && method === "GET") return { rules: memory.rules.map((rule) => ({ ...rule })) };
    const ruleMatch = path.match(/^\/memory\/rules\/(\d+)$/);
    if (ruleMatch && method === "PUT") {
      const rule = memory.rules.find((entry) => entry.id === Number(ruleMatch[1]));
      if (!rule) throw new Error(`rule ${ruleMatch[1]} not found`);
      const body = JSON.parse(String(options?.body)) as { rule?: string; enabled?: boolean };
      if (typeof body.rule === "string") rule.rule = body.rule;
      if (typeof body.enabled === "boolean") rule.enabled = body.enabled;
      return { ...rule };
    }
    if (ruleMatch && method === "DELETE") {
      memory.rules = memory.rules.filter((entry) => entry.id !== Number(ruleMatch[1]));
      return { deleted: true };
    }
    if (path === "/memory" && method === "DELETE") {
      const cleared_items = memory.items.length;
      const cleared_rules = memory.rules.length;
      memory.items = [];
      memory.rules = [];
      return { cleared_items, cleared_rules };
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  });

  return { calls, fetchJson: fetchJson as unknown as FetchJson, mock: fetchJson, memory, settings };
}

describe("MemorySettingsPage", () => {
  afterEach(() => {
    cleanup();
  });

  it("loads the overview and shows items, rules, and the master toggle", async () => {
    const api = createApi({ overview, settings: agentSettings });
    render(<MemorySettingsPage fetchJson={api.fetchJson} />);

    expect(screen.getByText("正在读取记忆数据…")).toBeInTheDocument();
    expect(await screen.findByText("用户住在杭州")).toBeInTheDocument();
    expect(screen.getByText("喜欢简洁的回答")).toBeInTheDocument();
    expect(screen.getByText("事实")).toBeInTheDocument();
    expect(screen.getByText("偏好")).toBeInTheDocument();
    expect(screen.getByText("回答时默认使用中文")).toBeInTheDocument();
    expect(screen.getByText(/来自对话 #12/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "跨会话记忆" })).toHaveAttribute("aria-checked", "true");
    expect(api.calls.map((call) => call.path)).toEqual(["/memory", "/agent/settings"]);
  });

  it("turns the memory toggle off via PUT /agent/settings with expected_revision", async () => {
    const api = createApi({ overview, settings: agentSettings });
    render(<MemorySettingsPage fetchJson={api.fetchJson} />);

    fireEvent.click(await screen.findByRole("switch", { name: "跨会话记忆" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "跨会话记忆" })).toHaveAttribute("aria-checked", "false"));

    const put = api.calls.find((call) => call.path === "/agent/settings" && call.options?.method === "PUT");
    expect(put).toBeDefined();
    const body = JSON.parse(String(put?.options?.body)) as { user_memory_enabled: boolean; expected_revision: number };
    expect(body.user_memory_enabled).toBe(false);
    expect(body.expected_revision).toBe(7);
    expect(screen.getByRole("status")).toHaveTextContent("已关闭跨会话记忆");
    expect(screen.getByRole("switch", { name: "跨会话记忆" })).toHaveAttribute("aria-checked", "false");
  });

  it("shows a conflict message and re-reads settings when the toggle PUT hits 409", async () => {
    const api = createApi({ overview, settings: agentSettings });
    const original = api.mock.getMockImplementation();
    api.mock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === "/agent/settings" && options?.method === "PUT") throw new ApiError("配置已在其他页面更新", 409);
      return original!(path, options);
    });
    render(<MemorySettingsPage fetchJson={api.fetchJson} />);

    fireEvent.click(await screen.findByRole("switch", { name: "跨会话记忆" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("设置已在其他页面更新，请重新查看后再试。");
    // 开关回落到重新读取到的服务端状态
    await waitFor(() => expect(screen.getByRole("switch", { name: "跨会话记忆" })).toHaveAttribute("aria-checked", "true"));
  });

  it("deletes an item optimistically and calls DELETE /memory/items/{id}", async () => {
    const api = createApi({ overview, settings: agentSettings });
    render(<MemorySettingsPage fetchJson={api.fetchJson} />);

    await screen.findByText("用户住在杭州");
    fireEvent.click(screen.getByRole("button", { name: "删除记忆：用户住在杭州" }));
    await waitFor(() => expect(screen.queryByText("用户住在杭州")).not.toBeInTheDocument());

    expect(api.calls.some((call) => call.path === "/memory/items/1" && call.options?.method === "DELETE")).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("已删除一条记忆");
    expect(screen.getByText(/来自对话的自动抽取，共 1 条/)).toBeInTheDocument();
  });

  it("restores a deleted item when the delete fails", async () => {
    const api = createApi({ overview, settings: agentSettings });
    const original = api.mock.getMockImplementation();
    api.mock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === "/memory/items/1" && options?.method === "DELETE") throw new Error("服务器开小差了");
      return original!(path, options);
    });
    render(<MemorySettingsPage fetchJson={api.fetchJson} />);

    await screen.findByText("用户住在杭州");
    fireEvent.click(screen.getByRole("button", { name: "删除记忆：用户住在杭州" }));
    await screen.findByRole("alert");

    expect(screen.getByRole("alert")).toHaveTextContent("服务器开小差了");
    expect(screen.getByText("用户住在杭州")).toBeInTheDocument();
  });

  it("adds a rule via POST and refreshes the rule list", async () => {
    const api = createApi({ overview, settings: agentSettings });
    render(<MemorySettingsPage fetchJson={api.fetchJson} />);

    await screen.findByText("回答时默认使用中文");
    fireEvent.change(screen.getByLabelText("新规则"), { target: { value: "代码注释用中文" } });
    fireEvent.click(screen.getByRole("button", { name: "添加规则" }));
    expect(await screen.findByText("代码注释用中文")).toBeInTheDocument();

    const post = api.calls.find((call) => call.path === "/memory/rules" && call.options?.method === "POST");
    expect(post).toBeDefined();
    expect(JSON.parse(String(post?.options?.body))).toEqual({ rule: "代码注释用中文" });
    expect(api.calls.some((call) => call.path === "/memory/rules" && !call.options?.method)).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("规则已添加");
  });

  it("shows a limit message when adding a rule returns 409", async () => {
    const api = createApi({ overview, settings: agentSettings });
    const original = api.mock.getMockImplementation();
    api.mock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === "/memory/rules" && options?.method === "POST") throw new ApiError("规则数量已达上限", 409);
      return original!(path, options);
    });
    render(<MemorySettingsPage fetchJson={api.fetchJson} />);

    await screen.findByText("回答时默认使用中文");
    fireEvent.change(screen.getByLabelText("新规则"), { target: { value: "再多一条" } });
    fireEvent.click(screen.getByRole("button", { name: "添加规则" }));
    await screen.findByRole("alert");

    expect(screen.getByRole("alert")).toHaveTextContent("规则数量已达上限");
  });

  it("edits a rule through the inline editor", async () => {
    const api = createApi({ overview, settings: agentSettings });
    render(<MemorySettingsPage fetchJson={api.fetchJson} />);

    await screen.findByText("回答时默认使用中文");
    fireEvent.click(screen.getByRole("button", { name: "编辑规则：回答时默认使用中文" }));
    fireEvent.change(screen.getByLabelText("编辑规则内容"), { target: { value: "回答时默认使用简体中文" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("回答时默认使用简体中文")).toBeInTheDocument();

    const put = api.calls.find((call) => call.path === "/memory/rules/1" && call.options?.method === "PUT");
    expect(put).toBeDefined();
    expect(JSON.parse(String(put?.options?.body))).toEqual({ rule: "回答时默认使用简体中文" });
  });

  it("toggles a rule off via PUT", async () => {
    const api = createApi({ overview, settings: agentSettings });
    render(<MemorySettingsPage fetchJson={api.fetchJson} />);

    fireEvent.click(await screen.findByRole("switch", { name: "规则「回答时默认使用中文」停用" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "规则「回答时默认使用中文」启用" })).toHaveAttribute("aria-checked", "false"));

    const put = api.calls.find((call) => call.path === "/memory/rules/1" && call.options?.method === "PUT");
    expect(put).toBeDefined();
    expect(JSON.parse(String(put?.options?.body))).toEqual({ enabled: false });
  });

  it("deletes a rule via DELETE /memory/rules/{id}", async () => {
    const api = createApi({ overview, settings: agentSettings });
    render(<MemorySettingsPage fetchJson={api.fetchJson} />);

    await screen.findByText("回答时默认使用中文");
    fireEvent.click(screen.getByRole("button", { name: "删除规则：回答时默认使用中文" }));
    await waitFor(() => expect(screen.queryByText("回答时默认使用中文")).not.toBeInTheDocument());

    expect(api.calls.some((call) => call.path === "/memory/rules/1" && call.options?.method === "DELETE")).toBe(true);
  });

  it("clears everything after an inline confirmation", async () => {
    const api = createApi({ overview, settings: agentSettings });
    render(<MemorySettingsPage fetchJson={api.fetchJson} />);

    await screen.findByText("用户住在杭州");
    fireEvent.click(screen.getByRole("button", { name: "清除全部记忆与规则" }));
    expect(screen.getByText(/确定要清除全部 2 条记忆与 1 条规则吗/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认清除" }));
    expect(await screen.findByText(/已清除 2 条记忆与 1 条规则/)).toBeInTheDocument();

    expect(screen.queryByText("用户住在杭州")).not.toBeInTheDocument();
    expect(screen.queryByText("回答时默认使用中文")).not.toBeInTheDocument();
    expect(api.calls.some((call) => call.path === "/memory" && call.options?.method === "DELETE")).toBe(true);
    // 开关与设置保持不变
    expect(screen.getByRole("switch", { name: "跨会话记忆" })).toHaveAttribute("aria-checked", "true");
  });

  it("paginates long item lists", async () => {
    const manyItems: MemorySummary[] = Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      kind: "fact",
      summary: `事实 ${index + 1}`,
      source_conversation_id: null,
      created_at: "2026-11-01T08:00:00Z",
      updated_at: "2026-11-01T08:00:00Z"
    }));
    const api = createApi({ overview: { enabled: true, items: manyItems, rules: [] }, settings: agentSettings });
    render(<MemorySettingsPage fetchJson={api.fetchJson} />);

    await screen.findByText("事实 1");
    expect(screen.queryByText("事实 11")).not.toBeInTheDocument();
    expect(screen.getByText("第 1 / 2 页")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("事实 11")).toBeInTheDocument();
    expect(screen.queryByText("事实 1")).not.toBeInTheDocument();
    expect(screen.getByText("第 2 / 2 页")).toBeInTheDocument();
  });

  it("shows a load error when the memory endpoint fails", async () => {
    const api = createApi({ overview, settings: agentSettings });
    const original = api.mock.getMockImplementation();
    api.mock.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === "/memory" && !options?.method) throw new ApiError("服务不可用", 503);
      return original!(path, options);
    });
    render(<MemorySettingsPage fetchJson={api.fetchJson} />);

    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("服务不可用");
  });
});
