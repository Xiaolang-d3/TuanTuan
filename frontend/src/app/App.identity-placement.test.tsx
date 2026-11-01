import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentSettings } from "../constants";
import { ThemeProvider } from "../features/appearance/ThemeProvider";
import { App } from "./App";
import type { Conversation } from "../types";
import type { ConversationDialogState } from "../components/ConversationDialog";

const api = vi.hoisted(() => ({ fetchJson: vi.fn<(path: string) => Promise<unknown>>() }));
const conversations = vi.hoisted(() => ({
  conversations: [] as Conversation[], currentConversationId: null as number | null, conversationBusy: false,
  conversationDialog: null as ConversationDialogState | null, setConversationDialog: vi.fn(),
  renameConversation: vi.fn(), removeConversation: vi.fn(), setConversations: vi.fn(), setCurrentConversationId: vi.fn(),
  setConversationBusy: vi.fn(), refreshConversations: vi.fn().mockResolvedValue([])
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

vi.mock("../api/client", () => ({ createApiClient: () => api.fetchJson, fetchWithTimeout: vi.fn() }));
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
  AssistantSurface: ({ page, children }: { page: boolean; children: ReactNode }) => page ? <section>{children}</section> : null
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
  api.fetchJson.mockReset();
  conversations.refreshConversations.mockResolvedValue([]);
  library.refreshLibrary.mockResolvedValue(undefined);
  api.fetchJson.mockImplementation(async (path) => {
    if (path === "/system/database-status") return { status: "ready" };
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
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("App identity placement", () => {
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

  it("switches between chat and sidebar files without losing the unsent composer", async () => {
    conversations.conversations = [{ id: 7, title: "原有对话", summary: "", status: "active", updated_at: "2026-10-14" }];
    conversations.currentConversationId = 7;
    window.history.replaceState(null, "", "#/chat/7");
    renderApp();
    const draft = await screen.findByRole("textbox", { name: "测试对话草稿" });
    fireEvent.change(draft, { target: { value: "尚未发送的计划" } });
    const navigation = within(screen.getByRole("navigation", { name: "主导航" }));
    expect(screen.queryByRole("navigation", { name: "AI 工作区模块" })).not.toBeInTheDocument();
    expect(navigation.queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
    fireEvent.click(navigation.getByRole("button", { name: "文件库" }));
    await screen.findByRole("heading", { name: "测试文件库" });
    expect(window.location.hash).toBe("#/chat/library");
    expect(draft).toBeInTheDocument();
    expect(draft).not.toBeVisible();
    expect(navigation.getByRole("button", { name: "文件库" })).toHaveAttribute("aria-current", "page");
    expect(navigation.getByRole("button", { name: "AI 工作区" })).not.toHaveAttribute("aria-current");
    fireEvent.click(navigation.getByRole("button", { name: "AI 工作区" }));
    expect(await screen.findByRole("textbox", { name: "测试对话草稿" })).toBe(draft);
    expect(draft).toHaveValue("尚未发送的计划");
    expect(window.location.hash).toBe("#/chat/7");
    fireEvent.click(navigation.getByRole("button", { name: "文件库" }));
    await screen.findByRole("heading", { name: "测试文件库" });
    const accountTrigger = screen.getByRole("button", { name: "账号菜单" });
    expect(accountTrigger).not.toHaveClass("active");
    fireEvent.click(accountTrigger);
    expect(screen.queryByRole("menuitem", { name: "文件库管理" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "设置" }));
    await screen.findByRole("heading", { name: "测试设置概览" });
    expect(window.location.hash).toBe("#/settings");
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
    fireEvent.click(screen.getByRole("menuitem", { name: "设置" }));
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
    fireEvent.click(screen.getByRole("menuitem", { name: "设置" }));
    await screen.findByRole("heading", { name: "测试设置概览" });
    expect(expectSidebarIdentity(container).closest("aside")).toHaveClass("collapsed");
    await waitFor(() => expect(localStorage.getItem("tuantuan-sidebar:developer@example.test")).toBe("collapsed"));
  });
});
