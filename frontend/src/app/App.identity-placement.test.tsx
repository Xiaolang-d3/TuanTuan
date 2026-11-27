import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentSettings } from "../constants";
import { ThemeProvider } from "../features/appearance/ThemeProvider";
import { App } from "./App";
import type { Conversation } from "../types";
import type { ConversationDialogState } from "../components/ConversationDialog";

const api = vi.hoisted(() => ({ fetchJson: vi.fn<(path: string, options?: RequestInit) => Promise<unknown>>() }));
const conversations = vi.hoisted(() => ({
  conversations: [] as Conversation[], currentConversationId: null as number | null, conversationBusy: false,
  conversationDialog: null as ConversationDialogState | null, setConversationDialog: vi.fn(),
  renameConversation: vi.fn(), removeConversation: vi.fn(), setConversations: vi.fn(), setCurrentConversationId: vi.fn(),
  setConversationBusy: vi.fn(), invalidateConversationReads: vi.fn(), refreshConversations: vi.fn().mockResolvedValue([])
}));
const chat = vi.hoisted(() => ({
  chatMessages: [], chatBusy: false, modelUnavailable: null,
  chatAgentRef: { current: null }, setChatMessages: vi.fn(), setChatBusy: vi.fn(),
  setRetryChatDraft: vi.fn(), setModelUnavailable: vi.fn(), refreshChat: vi.fn().mockResolvedValue(undefined)
}));
const library = vi.hoisted(() => ({
  libraryEditor: { name: "", privacyMode: "redacted" }, librarySources: [], libraryFolders: [],
  pendingKnowledge: [], libraryLoaded: true, refreshLibrary: vi.fn().mockResolvedValue(undefined),
  setErrorMessage: (_message: string) => {}, setNoticeMessage: (_message: string) => {}
}));

vi.mock("../api/client", async (importOriginal) => ({ ...await importOriginal<typeof import('../api/client')>(), createApiClient: () => api.fetchJson, fetchWithTimeout: vi.fn() }));
vi.mock("../page-prefetch", () => ({ createPagePrefetcher: () => ({ prefetch: vi.fn(), prefetchWhenIdle: vi.fn() }) }));
vi.mock("../hooks/useAsyncPolling", () => ({ useAsyncPolling: vi.fn() }));
vi.mock("../features/chat/useConversations", () => ({ useConversations: () => conversations }));
vi.mock("../features/chat/useChatRun", () => ({ useChatRun: () => chat }));
vi.mock("../features/library/useLibrary", () => ({ useLibrary: (options: {
  setErrorMessage: (message: string) => void; setNoticeMessage: (message: string) => void;
}) => {
  library.setErrorMessage = options.setErrorMessage;
  library.setNoticeMessage = options.setNoticeMessage;
  return library;
} }));
vi.mock("../components/AssistantSurface", () => ({
  AssistantSurface: ({ page, children }: { page: boolean; children: ReactNode }) => <section hidden={!page}>{children}</section>
}));
vi.mock("../components/ChatWorkspace", () => ({ ChatWorkspace: () => <><h2>测试工作区</h2><textarea aria-label="测试对话草稿" defaultValue="" /></> }));
vi.mock("../features/home/HomePage", () => ({ HomePage: () => <h2>测试首页</h2> }));
vi.mock("../features/library/LibraryPage", () => ({ LibraryPage: () => <h2>测试文件库</h2> }));
vi.mock("../features/settings/AccountSettingsPage", () => ({ AccountSettingsPage: () => <h2>测试账号设置</h2> }));
vi.mock("../features/settings/ModelSettingsPage", () => ({ ModelSettingsPage: () => <h2>测试模型设置</h2> }));
vi.mock("../features/settings/SettingsWorkspace", async (importOriginal) => ({
  ...await importOriginal<typeof import("../features/settings/SettingsWorkspace")>(),
  SettingsOverview: () => <h2>测试设置概览</h2>
}));

function renderApp() {
  return render(
    <ThemeProvider>
      <App apiBase="/test-api" accessToken="test-only-session" onLogout={vi.fn()}
        user={{ email: "developer@example.test", has_avatar: false }} updateSession={vi.fn()} />
    </ThemeProvider>
  );
}

function expectSidebarIdentity(container: HTMLElement) {
  const triggers = screen.getAllByRole("button", { name: "账号菜单" });
  expect(triggers).toHaveLength(1);
  const trigger = triggers[0];
  expect(trigger.closest(".sidebar-identity-slot")).not.toBeNull();
  expect(trigger.closest("aside.sidebar")).not.toBeNull();
  expect(container.querySelector(".content .app-identity")).toBeNull();
  expect(container.querySelector(".app-topbar .app-identity")).toBeNull();
  return trigger;
}

beforeEach(() => {
  conversations.conversations = [];
  conversations.currentConversationId = null;
  conversations.conversationDialog = null;
  conversations.setConversationDialog.mockClear();
  conversations.renameConversation.mockClear();
  conversations.removeConversation.mockClear();
  conversations.invalidateConversationReads.mockClear();
  conversations.setConversations.mockClear();
  chat.setChatMessages.mockClear();
  api.fetchJson.mockReset();
  conversations.refreshConversations.mockResolvedValue([]);
  library.refreshLibrary.mockResolvedValue(undefined);
  api.fetchJson.mockImplementation(async (path) => {
    if (path === "/system/database-status") return { status: "ready" };
    if (path === "/image-studio/options") return { default_profile_id: null, models: [] };
    if (path.startsWith("/image-studio/history")) return { items: [], has_more: false };
    if (path === "/image-studio/works") return { items: [] };
    if (path === "/channels/weixin") return { connected: false, enabled: false, error: "" };
    if (path === "/agent/settings") return { ...defaultAgentSettings, model_name: "test-model", api_key_configured: true };
    if (path === "/agent/model-monitor?hours=24" || path === "/agent/models/capabilities") return null;
    if (path === "/agent/models/discover") return { models: [], count: 0 };
    if (path === "/agent/capabilities" || path === "/attachments/config") return {};
    throw new Error(`Unexpected mocked request: ${path}`);
  });
  localStorage.clear();
  window.history.replaceState(null, "", "#/home");
});

afterEach(() => {
  cleanup();
  delete (api.fetchJson as typeof api.fetchJson & { events?: unknown }).events;
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("App project conversations", () => {
  function mockProject(create: () => Promise<Conversation>) {
    const fallback = api.fetchJson.getMockImplementation()!;
    const connection = { id: "connection", name: "自定义连接", model_base_url: "https://models.example.test/v1", model_protocol: "openai", enabled: true, api_key_configured: true, revision: 1 };
    const profile = { id: "chat-model", connection_id: connection.id, model_name: "聊天模型", enabled: true, revision: 1, supported_purposes: ["chat"] };
    const project = { id: "p1", name: "项目一", description: "", status: "active", created_at: "", updated_at: "", default_model_profile_id: null, items: [] };
    api.fetchJson.mockImplementation(async (path, options) => {
      if (path === "/agent/model-connections") return { connections: [connection], profiles: [profile, { ...profile, id: "image-model", model_name: "图片模型", supported_purposes: ["image"] }], default_profile_id: null };
      if (path === "/projects/p1") return project;
      if (path === "/projects") return { items: [project] };
      if (path === "/projects/p1/conversations") return create();
      return fallback(path, options);
    });
    window.history.replaceState(null, "", "#/projects?id=p1");
  }

  const created: Conversation = { id: 29, title: "新对话", status: "active", summary: "", updated_at: "", project_context: { id: "p1", name: "项目一", sources: [] } };

  it("offers chat profiles and opens the returned conversation without starting a run", async () => {
    mockProject(async () => created);
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "编辑项目" }));
    expect(await screen.findByRole("option", { name: "聊天模型 · 自定义连接" })).toBeEnabled();
    expect(screen.queryByRole("option", { name: /图片模型/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "新建项目对话" }));
    fireEvent.click(screen.getByRole("button", { name: "创建对话" }));
    await waitFor(() => expect(window.location.hash).toBe("#/chat/29"));
    expect(chat.setChatMessages).toHaveBeenCalledWith([]);
    expect(conversations.setConversations).toHaveBeenCalledWith(expect.any(Function));
    const update = conversations.setConversations.mock.lastCall?.[0];
    expect(update([])).toEqual([created]);
    const posts = api.fetchJson.mock.calls.filter(([, request]) => request?.method === "POST");
    expect(posts.map(([path, request]) => [path, JSON.parse(String(request?.body))])).toEqual([["/projects/p1/conversations", { source_ids: [] }]]);
  });

  it("does not open a stale conversation after leaving and returning to the same project", async () => {
    let resolve!: (result: Conversation) => void;
    const pending = new Promise<Conversation>(done => { resolve = done; });
    mockProject(() => pending);
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "新建项目对话" }));
    fireEvent.click(screen.getByRole("button", { name: "创建对话" }));
    const request = api.fetchJson.mock.calls.find(([path]) => path === "/projects/p1/conversations")?.[1];
    expect(request?.signal?.aborted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "返回我的项目" }));
    fireEvent.click(await screen.findByRole("button", { name: /项目一/ }));
    expect(await screen.findByRole("button", { name: "新建项目对话" })).toBeEnabled();
    expect(request?.signal?.aborted).toBe(true);
    await act(async () => { resolve(created); });
    expect(window.location.hash).toBe("#/projects?id=p1");
    expect(conversations.setConversations).not.toHaveBeenCalled();
  });
});

describe("App identity placement", () => {
  it('shares one live Weixin stream between the sidebar and settings across navigation', async () => {
    const signals: AbortSignal[] = [];
    let push!: (event: string, data: unknown) => void;
    const state = { connected: true, enabled: true, error: '', conversation_id: 6, unread_count: 2,
      latest_sequence: 2, readable_sequence: 2, read_sequence: 0, binding_id: 'binding', stream_id: 'server', revision: 1 };
    Object.assign(api.fetchJson, { events: async (_path: string, signal: AbortSignal, callback: typeof push) => {
      signals.push(signal); push = callback;
      callback('weixin-status', state);
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()));
    } });
    window.history.replaceState(null, '', '#/settings/channels');
    const view = renderApp();
    expect(await screen.findByText('已连接微信')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /微信 Bot.*2 条未读消息/ })).toBeInTheDocument();
    await act(async () => { window.location.hash = '#/settings/account'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(await screen.findByText('测试账号设置')).toBeInTheDocument();
    await act(async () => { push('weixin-status', { ...state, unread_count: 4, revision: 2 }); });
    expect(screen.getByRole('button', { name: /微信 Bot.*4 条未读消息/ })).toBeInTheDocument();
    await act(async () => { window.location.hash = '#/settings/channels'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(await screen.findByText('已连接微信')).toBeInTheDocument();
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    expect(api.fetchJson.mock.calls.some(([path]) => path === '/channels/weixin')).toBe(false);
    view.unmount();
    expect(signals[0].aborted).toBe(true);
  });
  it('waits for a new bot conversation to enter the list before navigating', async () => {
    const old = { id: 8, title: '旧会话', status: 'active', summary: '', updated_at: '' } as Conversation;
    const bot = { ...old, id: 6, title: '微信会话' };
    conversations.conversations = [old];
    conversations.currentConversationId = 8;
    const originalApi = api.fetchJson.getMockImplementation()!;
    api.fetchJson.mockImplementation(async path => path === '/channels/weixin' ? {
      connected: true, enabled: true, error: '', conversation_id: 6, unread_count: 1,
      readable_sequence: 1, read_sequence: 0, latest_sequence: 1, binding_id: 'binding'
    } : originalApi(path));
    let finish: () => void = () => {};
    conversations.refreshConversations.mockImplementationOnce(() => new Promise<Conversation[]>(resolve => {
      finish = () => { conversations.conversations = [bot, old]; resolve([bot, old]); };
    }));
    renderApp();
    const nav = screen.getByRole('navigation', { name: '主导航' });
    const entry = await screen.findByRole('button', { name: /^微信 Bot/ });
    expect(within(nav).queryByRole('button', { name: /^微信 Bot/ })).not.toBeInTheDocument();
    expect(entry.closest('.sidebar-identity-slot')).toBeTruthy();
    const account = screen.getByRole('button', { name: '账号菜单' });
    expect(account.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(entry);
    expect(window.location.hash).toBe('#/home');
    await act(async () => finish());
    await waitFor(() => expect(window.location.hash).toBe('#/chat/6'));
  });
  it('does not pull the user back to the Weixin chat after they navigated elsewhere', async () => {
    const old = { id: 8, title: '旧会话', status: 'active', summary: '', updated_at: '' } as Conversation;
    const bot = { ...old, id: 6, title: '微信会话' };
    conversations.conversations = [old];
    conversations.currentConversationId = 8;
    const originalApi = api.fetchJson.getMockImplementation()!;
    api.fetchJson.mockImplementation(async path => path === '/channels/weixin' ? {
      connected: true, enabled: true, error: '', conversation_id: 6, unread_count: 1,
      readable_sequence: 1, read_sequence: 0, latest_sequence: 1, binding_id: 'binding'
    } : originalApi(path));
    let finish: () => void = () => {};
    conversations.refreshConversations.mockImplementationOnce(() => new Promise<Conversation[]>(resolve => {
      finish = () => { conversations.conversations = [bot, old]; resolve([bot, old]); };
    }));
    renderApp();
    fireEvent.click(await screen.findByRole('button', { name: /^微信 Bot/ }));
    fireEvent.click(screen.getAllByRole('link', { name: '我的作品' })[0]);
    await waitFor(() => expect(window.location.hash).toContain('works'));
    await act(async () => finish());
    expect(window.location.hash).toContain('works');
    expect(window.location.hash).not.toBe('#/chat/6');
  });
  it("resets extension drafts when switching accounts that have no numeric ID", async () => {
    let second = false;
    const originalApi = api.fetchJson.getMockImplementation()!;
    api.fetchJson.mockImplementation(async path => path === "/extensions" ? { extensions: second ? [] : [{ id: "owner-skill", kind: "skill", name: "仅第一账号技能", description: "私有说明", source: "user", enabled: true, permissions: [] }], connections: [], execution: { available: false, reason: "未接入" } } : originalApi(path));
    window.history.replaceState(null, "", "#/settings/extensions");
    const view = renderApp();
    expect(await screen.findByText("仅第一账号技能")).toBeInTheDocument();
    second = true;
    view.rerender(<ThemeProvider><App apiBase="/test-api" accessToken="second-test-session" onLogout={vi.fn()}
      user={{ email: "second@example.test", has_avatar: false }} updateSession={vi.fn()} /></ThemeProvider>);
    expect(await screen.findByRole("heading", { name: "让团团学会你的工作方法" })).toBeInTheDocument();
    expect(screen.queryByText("仅第一账号技能")).not.toBeInTheDocument();
  });

  it("opens the channels deep link with its page title and Weixin controls", async () => {
    window.history.replaceState(null, "", "#/settings/channels");
    renderApp();
    expect(await screen.findByRole("heading", { name: /^消息渠道$/ })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /^连接微信$/ })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("消息渠道｜团团"));
  });
  it.each(["#/chat/7", "#/chat/library"])("keeps conversation management visible outside hidden page content on %s", async (hash) => {
    const conversation: Conversation = { id: 7, title: "原有对话", summary: "", status: "active", updated_at: "2026-10-14" };
    conversations.conversations = [conversation];
    conversations.currentConversationId = 7;
    conversations.conversationDialog = { kind: "rename", conversation };
    window.history.replaceState(null, "", hash);
    const { container } = renderApp();
    const dialog = await screen.findByRole("dialog", { name: "重命名对话" });
    const content = container.querySelector<HTMLElement>(".content")!;
    expect(dialog.closest(".content")).toBeNull();
    content.style.visibility = "hidden";
    expect(dialog).toBeVisible();
    content.style.display = "none";
    expect(dialog).toBeVisible();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "对话名称" }), { target: { value: "新的对话名称" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(conversations.renameConversation).toHaveBeenCalledWith(conversation, "新的对话名称");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(conversations.setConversationDialog).toHaveBeenCalledWith(null);
  });

  it.each(["#/chat/7", "#/chat/library"])("keeps global file feedback visible outside hidden page content on %s", async (hash) => {
    window.history.replaceState(null, "", hash);
    const { container } = renderApp();
    await screen.findByRole("heading", { name: hash.endsWith("library") ? "测试文件库" : "测试工作区" });
    act(() => {
      library.setErrorMessage("1 个文件导入失败");
      library.setNoticeMessage("文件已存档");
    });
    const error = screen.getByText("1 个文件导入失败").closest(".global-error-toast")!;
    const notice = screen.getByText("文件已存档").closest(".global-notice-toast")!;
    const content = container.querySelector<HTMLElement>(".content")!;
    expect(error.closest(".content")).toBeNull();
    expect(notice.closest(".content")).toBeNull();
    content.style.display = "none";
    expect(error).toBeVisible();
    expect(notice).toBeVisible();
    fireEvent.click(within(error as HTMLElement).getByRole("button", { name: "关闭错误提示" }));
    expect(screen.queryByText("1 个文件导入失败")).not.toBeInTheDocument();
  });

  it("opens image creation through works without losing the unsent chat draft", async () => {
    conversations.conversations = [{ id: 7, title: "原有对话", summary: "", status: "active", updated_at: "2026-10-14" }];
    conversations.refreshConversations.mockResolvedValue(conversations.conversations);
    conversations.currentConversationId = 7;
    const originalApi = api.fetchJson.getMockImplementation()!;
    api.fetchJson.mockImplementation(path => path.startsWith("/creation-records?")
      ? Promise.resolve({ items: [{ kind: "chat", id: "7", title: "原有对话", updated_at: "2026-10-14T12:00:00Z", conversation_id: 7, status: null }], has_more: false })
      : originalApi(path));
    window.history.replaceState(null, "", "#/chat/7");
    renderApp();
    const draft = await screen.findByRole("textbox", { name: "测试对话草稿" });
    fireEvent.change(draft, { target: { value: "尚未发送的计划" } });
    const navigation = within(screen.getByRole("navigation", { name: "主导航" }));
    expect(screen.queryByRole("navigation", { name: "AI 工作区模块" })).not.toBeInTheDocument();
    expect(within(document.querySelector(".sidebar-identity-slot")!).getByRole("link", { name: "设置" })).toBeInTheDocument();
    fireEvent.click(navigation.getByRole("link", { name: "我的作品" }));
    await screen.findByRole("heading", { name: "我的作品" });
    expect(navigation.getByRole("link", { name: "我的作品" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "去图片创作" }));
    await screen.findByRole("region", { name: "图片创作工作台" });
    expect(window.location.hash).toBe("#/images");
    expect(draft).toBeInTheDocument();
    expect(draft).not.toBeVisible();
    expect(navigation.getByRole("link", { name: "我的作品" })).not.toHaveAttribute("aria-current");
    expect(navigation.getByRole("link", { name: "创作记录" })).not.toHaveAttribute("aria-current");
    fireEvent.click(navigation.getByRole("link", { name: "创作记录" }));
    fireEvent.click(await screen.findByRole("button", { name: /原有对话/ }));
    expect(await screen.findByRole("textbox", { name: "测试对话草稿" })).toBe(draft);
    expect(draft).toHaveValue("尚未发送的计划");
    expect(window.location.hash).toBe("#/chat/7");
    fireEvent.click(navigation.getByRole("link", { name: "我的作品" }));
    await screen.findByRole("heading", { name: "我的作品" });
    fireEvent.click(screen.getByRole("button", { name: "去图片创作" }));
    await screen.findByRole("region", { name: "图片创作工作台" });
    const accountTrigger = screen.getByRole("button", { name: "账号菜单" });
    expect(accountTrigger).not.toHaveClass("active");
    fireEvent.click(accountTrigger);
    expect(screen.queryByRole("menuitem", { name: "文件库管理" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "设置" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu", { name: "账号菜单" }), { key: "Escape" });
    fireEvent.click(screen.getAllByRole("link", { name: "设置" })[0]);
    await screen.findByRole("heading", { name: "测试设置概览" });
    expect(window.location.hash).toBe("#/settings");
  });
  it.each([
    ["#/images", "图片创作", null],
    ["#/video", "视频", null],
    ["#/works", "我的作品", "我的作品"]
  ])("opens %s as an addressable product page", async (hash, heading, label) => {
    window.history.replaceState(null, "", hash);
    renderApp();
    expect(await screen.findByRole("heading", { name: heading, level: 1 })).toBeInTheDocument();
    const navigation = within(screen.getByRole("navigation", { name: "主导航" }));
    if (label) expect(navigation.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
    else expect(navigation.queryByRole("link", { current: "page" })).not.toBeInTheDocument();
    expect(window.location.hash).toBe(hash);
  });

  it.each([
    ["#/home", "测试首页"],
    ["#/library", "测试文件库"],
    ["#/chat", "测试工作区"],
    ["#/settings/model", "测试模型设置"],
    ["#/settings/appearance", "外观"]
  ])("keeps one account menu in the sidebar on %s", async (hash, pageHeading) => {
    window.history.replaceState(null, "", hash);
    const { container } = renderApp();

    await screen.findByRole("heading", { name: pageHeading, level: 2 });
    expectSidebarIdentity(container);
    expect(window.location.hash).toBe(hash === "#/library" ? "#/chat/library" : hash);
  });

  it("keeps the same account menu when navigating to account and settings", async () => {
    const { container } = renderApp();
    await screen.findByRole("heading", { name: "测试首页" });
    const trigger = expectSidebarIdentity(container);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "账号与安全" }));
    await screen.findByRole("heading", { name: "测试账号设置" });
    expect(window.location.hash).toBe("#/settings/account");
    expect(expectSidebarIdentity(container)).toBe(trigger);
    expect(trigger).toHaveClass("active");
    expect(screen.queryByRole("menu", { name: "账号菜单" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "账号与安全" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("menuitem", { name: "设置" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu", { name: "账号菜单" }), { key: "Escape" });
    fireEvent.click(screen.getAllByRole("link", { name: "设置" })[0]);
    await screen.findByRole("heading", { name: "测试设置概览" });
    expect(window.location.hash).toBe("#/settings");
    expect(expectSidebarIdentity(container)).toBe(trigger);
    expect(trigger).toHaveClass("active");
    expect(screen.queryByRole("menu", { name: "账号菜单" })).not.toBeInTheDocument();
  });

  it("opens the account menu after collapsing the sidebar", async () => {
    const { container } = renderApp();
    await screen.findByRole("heading", { name: "测试首页" });
    const toggle = screen.getByRole("button", { name: "收起侧边栏" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "展开侧边栏" })).toHaveAttribute("aria-expanded", "false");
    const trigger = expectSidebarIdentity(container);
    expect(trigger.closest("aside")).toHaveClass("collapsed");

    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "账号菜单" })).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("menuitem", { name: "设置" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu", { name: "账号菜单" }), { key: "Escape" });
    fireEvent.click(screen.getAllByRole("link", { name: "设置" })[0]);
    await screen.findByRole("heading", { name: "测试设置概览" });
    expect(expectSidebarIdentity(container).closest("aside")).toHaveClass("collapsed");
    await waitFor(() => expect(localStorage.getItem("tuantuan-sidebar:developer@example.test")).toBe("collapsed"));
  });
});
