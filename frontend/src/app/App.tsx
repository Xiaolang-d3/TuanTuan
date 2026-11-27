import { readStorageItem } from "../storage";
import { useAgentPreferences } from "./useAgentPreferences";
import { useConversationModels } from "./useConversationModels";
import { ModelSettingsRoute } from "./ModelSettingsRoute";
import { useTheme } from "../features/appearance/ThemeProvider";
import { AppearanceSettingsPage } from "../features/settings/AppearanceSettingsPage";
import { AgentKernelSettings } from "../features/settings/AgentKernelSettings";
import { WeixinSettingsPage } from "../features/settings/WeixinSettingsPage";
import { useWeixinBot } from '../features/chat/useWeixinBot';
import { useWeixinStatus } from '../features/chat/useWeixinStatus';
import { ExtensionPreviewProvider } from "../features/extensions/ExtensionPreviewContext";
import { LocalCitationProvider } from "../features/chat/LocalCitation";
import { createDocumentService, type DocumentService, type SavedDocument } from "../features/chat/document-service";
import { DocumentLibraryDialog } from "../features/chat/DocumentLibraryDialog";
import { PageLoading } from "../components/PageLoading";
import { downloadConversationMarkdown } from "../features/chat/conversationActions";
import { useImageEdits } from "../features/chat/useImageEdits";
import { useChatRun } from "../features/chat/useChatRun";
import { useConversationWebSearch } from "../features/chat/useConversationWebSearch";
import { VideoPage, WorksPage } from "../features/product/ProductPages";
import { ImageWorkspacePage } from "../features/product/ImageWorkspacePage";
import { useLibrary } from "../features/library/useLibrary";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createApiClient, fetchWithTimeout } from "../api/client";
import { createDocumentReviewService } from "../features/chat/document-review-service";
import { createVoiceInputService } from "../features/chat/voiceInput";
import type { AuthUser } from "../components/AuthGate";
import { AssistantSurface } from "../components/AssistantSurface";
import { AIWorkspaceModules } from "../features/chat/AIWorkspaceModules";
import { AppSidebar, type ProductNavKey } from "../components/AppSidebar";
import { FirstRunGuide } from "../features/onboarding/FirstRunGuide";
import { useFirstRun } from "../features/onboarding/useFirstRun";
import { AppIdentityMenu } from "../components/AppIdentityMenu";
import { AppTopBar } from "../components/AppTopBar";
import { ActionButton } from "../components/ui/ActionButton";
import { WorkspaceShortcuts, type WorkspaceShortcutGroup } from "../features/product/WorkspaceShortcuts";
import { ConversationDialog } from "../components/ConversationDialog";
import type { AttachmentConfig, ChatAttachment } from "../features/chat/types";
import type { ArtifactManifest } from "../features/chat/result-types";
import { CreationEntry } from "../features/home/CreationEntry";
import { CreationRecords } from "../features/product/CreationRecords";
import { TaskCenter, type TaskCenterView, type TaskSource } from "../features/product/TaskCenter";
import { GlobalSearch, type SearchHit } from "../features/product/GlobalSearch";
import type { CreationRecord } from "../features/product/creationRecordsApi";
import { ProjectsPage } from "../features/product/ProjectsPage";
import type { ProjectItem } from "../features/product/projectsApi";
import { pageMeta, topbarSectionForPage } from "../constants";
import { createPagePrefetcher } from "../page-prefetch";
import { createRouteDataCache, requiredDataForRoute, type RouteDataKey } from "../route-data";
import { useAsyncPolling } from "../hooks/useAsyncPolling";
import type { AppRoute } from "../routing";
import type { AgentCapabilities, Conversation, LibraryEditor, LibrarySourceDetail } from "../types";
import { useAppRoute } from "./useAppRoute";
import { useHomeCreation } from "./useHomeCreation";
import { useWorkspaceConversations } from "./useWorkspaceConversations";
import { Bell, CheckCircle2, ListTodo, Search, TriangleAlert, X } from "lucide-react";
import "../styles/foundations.css";
import "../AppStyles";

const loadChatWorkspace = () => import("../components/ChatWorkspace");

const loadHomePage = () => import("../features/home/HomePage");

const loadSettingsWorkspace = () => import("../features/settings/SettingsWorkspace");

const loadLibraryPage = () => import("../features/library/LibraryPage");

const loadAccountSettingsPage = () => import("../features/settings/AccountSettingsPage");

const loadMemorySettingsPage = () => import("../features/settings/MemorySettingsPage");

const ChatWorkspace = lazy(() => loadChatWorkspace().then((module) => ({
  default: module.ChatWorkspace
})));

const HomePage = lazy(() => loadHomePage().then((module) => ({
  default: module.HomePage
})));

const AgentOperationsDashboard = lazy(() => import("../features/settings/AgentOperationsDashboard").then((module) => ({
  default: module.AgentOperationsDashboard
})));

const SettingsWorkspace = lazy(() => loadSettingsWorkspace().then((module) => ({
  default: module.SettingsWorkspace
})));

const SettingsOverview = lazy(() => loadSettingsWorkspace().then((module) => ({
  default: module.SettingsOverview
})));

const ExtensionsPage = lazy(() => import("../features/extensions/ExtensionsPage").then((module) => ({ default: module.ExtensionsPage })));
const SkillsCenterPage = lazy(() => import("../features/extensions/SkillsCenterPage").then((module) => ({ default: module.SkillsCenterPage })));

const LibraryPage = lazy(() => loadLibraryPage().then((module) => ({
  default: module.LibraryPage
})));

const AccountSettingsPage = lazy(() => loadAccountSettingsPage().then((module) => ({
  default: module.AccountSettingsPage
})));

const MemorySettingsPage = lazy(() => loadMemorySettingsPage().then((module) => ({
  default: module.MemorySettingsPage
})));

const pagePrefetcher = createPagePrefetcher({
  chat: loadChatWorkspace,
  library: () => Promise.all([loadSettingsWorkspace(), loadLibraryPage()]),
  account: () => Promise.all([loadSettingsWorkspace(), loadAccountSettingsPage()]),
  memory: () => Promise.all([loadSettingsWorkspace(), loadMemorySettingsPage()]),
  dashboard: loadHomePage,
  settings: loadSettingsWorkspace
});

function preferenceKey(base: string, email: string) {
  return `${base}:${email}`;
}

function readPreference(base: string, email: string) {
  return readStorageItem(preferenceKey(base, email)) ?? readStorageItem(base);
}

function appTopBarShowsTitle(route: AppRoute): boolean {
  return route.section === "settings";
}

export function App({
  apiBase,
  accessToken,
  onLogout,
  user,
  updateSession
}: {
  apiBase: string;
  accessToken: string;
  onLogout: () => void;
  user: AuthUser;
  updateSession: (token: string, nextUser: AuthUser) => void;
}) {
  const userEmail = user.email;
  const firstRun = useFirstRun(userEmail);
  const fetchJson = useMemo(() => createApiClient(apiBase, accessToken), [apiBase, accessToken]);
  const documentReviewService = useMemo(() => createDocumentReviewService(apiBase, accessToken), [apiBase, accessToken]);
  const documentService = useMemo(() => createDocumentService(apiBase, accessToken), [apiBase, accessToken]);
  const documentOwner = useRef(documentService); documentOwner.current = documentService;
  const documentContinuation = useRef<{ service: DocumentService; documentId: string; version: number; conversationId: number | null; key: string } | null>(null);
  const continuingDocument = useRef<symbol | null>(null);
  const [documentsOpen, setDocumentsOpen] = useState(false);
  const [initialDocumentId, setInitialDocumentId] = useState<string | null>(null);
  const documentCreation = useRef<AbortController | null>(null);
  useEffect(() => () => { documentCreation.current?.abort(); documentCreation.current = null; }, [documentService]);
  const voiceInput = useMemo(() => createVoiceInputService(fetchJson), [fetchJson]);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarEpoch, setAvatarEpoch] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readPreference("tuantuan-sidebar", userEmail) === "collapsed");
  const { appRoute, navigateRoute, navigationIntent, setActiveView } = useAppRoute();
  const [projectsRevision, setProjectsRevision] = useState(0);
  const [visitedImageWorkspace, setVisitedImageWorkspace] = useState(appRoute.section === "images");
  useEffect(() => { if (appRoute.section === "images") setVisitedImageWorkspace(true); }, [appRoute.section]);
  const activeView = appRoute.section;
  const workspaceLibraryOpen = appRoute.section === "chat" && appRoute.page === "library";
  const [visibleMessageCount, setVisibleMessageCount] = useState(12);
  const [errorMessage, setErrorMessage] = useState("");
  const [noticeMessage, setNoticeMessage] = useState("");
  const workspaceConversations = useWorkspaceConversations({ appRoute, navigateRoute, fetchJson, userEmail, setActiveView, setErrorMessage, setNoticeMessage });
  const {
    invalidateConversationReads, conversations, setConversations, currentConversation, currentConversationId, currentConversationIdRef,
    selectConversation, loadInitialConversations, openAgentRunConversation, ensurePresentationConversation, conversationBusy, setConversationBusy,
    conversationDialog, setConversationDialog, refreshConversations, searchConversations, createNewConversation, archiveConversation,
    renameConversation, removeConversation, composerDrafts, persistComposerDrafts, pinnedConversationIds, togglePinnedConversation,
    conversationFolders, conversationFolderAssignments, createConversationFolder, renameConversationFolder, removeConversationFolder, assignConversationFolder
  } = workspaceConversations;
  const { libraryEditor, librarySources, libraryFolders, libraryCollections, createLibraryCollection, renameLibraryCollection, deleteLibraryCollection, updateLibraryCollectionSources, organizeLibrarySource, createLibraryFolder, loadLibraryOriginal, searchLibrarySources, confirmedKnowledge, confirmedKnowledgeCount, sourceCount, pendingKnowledge, libraryLoaded, libraryBusy, sourceImportBusy, enhancedDocumentParse, setLibraryEditor, setEnhancedDocumentParse, refreshLibrary, saveLibraryMetadata, importLibraryFiles, createPastedSource, updateLibrarySource, downloadLibrarySource, deleteLibrarySource } = useLibrary({ fetchJson, apiBase, accessToken, setErrorMessage, setNoticeMessage });
  const [openLibraryResultId, setOpenLibraryResultId] = useState<number | null>(null);
  const [libraryAttachments, setLibraryAttachments] = useState<{ conversationId: number; attachments: ChatAttachment[] } | null>(null);
  const creationScope = JSON.stringify([apiBase, userEmail]);
  const [shortcutStates, setShortcutStates] = useState<Record<string, Partial<Record<WorkspaceShortcutGroup, boolean>>>>({});
  const shortcutState = shortcutStates[creationScope];
  const [taskCenter, setTaskCenter] = useState<{ scope: string; view: TaskCenterView } | null>(null);
  const [searchScope, setSearchScope] = useState<string | null>(null);
  const { migrateHomeTheme, resolved: resolvedTheme } = useTheme();
  useEffect(() => { migrateHomeTheme(userEmail); }, [migrateHomeTheme, userEmail]);
  const skillSelectionScopeFor = (id: number | null) => JSON.stringify([apiBase, user.id ?? user.email, id]);
  const skillSelectionScope = skillSelectionScopeFor(appRoute.section === "chat" ? appRoute.conversationId ?? currentConversationId : currentConversationId);
  const [chatSkillSelection, setChatSkillSelection] = useState<{ scope: string; id: string | null | undefined }>({ scope: "", id: undefined });
  const selectedSkillId = chatSkillSelection.scope === skillSelectionScope ? chatSkillSelection.id : undefined;
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);
  const conversationWebSearch = useConversationWebSearch(apiBase, user, currentConversationId);
  const webSearchAvailable = capabilities?.web_research?.enabled === true;
  const webSearchEnabled = webSearchAvailable && conversationWebSearch.enabled;
  const { chatMessages, setChatMessages, chatBusy, setChatBusy, modelUnavailable, setModelUnavailable, sendError, retryChatDraft, setRetryChatDraft, replacementUndo, chatAgentRef, taskCancelBusy, chatAttachmentBusy, refreshChat, uploadChatAttachment, loadChatAttachment, removeChatAttachment, sendChatMessage, retryChatMessage, stopChatGeneration, editChatMessage, regenerateChatMessage, undoReplacement, deleteChatTurn, cancelCurrentTask } = useChatRun({ apiBase, accessToken, fetchJson, selectedSkillId, currentConversationId, currentConversationIdRef, webSearchEnabled, modelProfileId: currentConversation?.model_profile_id ?? null, setErrorMessage, setNoticeMessage, refreshConversations, onLibraryChanged: refreshLibrary });
  const [attachmentConfig, setAttachmentConfig] = useState<AttachmentConfig | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [databaseReady, setDatabaseReady] = useState(false);
  const databaseInitializationRef = useRef<Promise<void> | null>(null);
  const routeDataCache = useMemo(() => createRouteDataCache<RouteDataKey>(30_000), [fetchJson, userEmail]);
  const agentPreferences = useAgentPreferences({
    fetchJson, userEmail, invalidateRouteData: routeDataCache.invalidate, setCapabilities, setModelUnavailable, setErrorMessage, setNoticeMessage,
    modelCatalogEnabled: databaseReady && ((appRoute.section === "chat" && !workspaceLibraryOpen)
      || (appRoute.section === "settings" && appRoute.page === "model") || (appRoute.section === "projects" && Boolean(appRoute.projectId)))
  });
  const {
    modelSettingsScope, modelSettingsReady, modelSettingsLoadError, modelSettingsEditing, modelSaveUnknown,
    savedAgentSettings, agentSettingsBusy, modelCatalog, kernels, changeDefaultKernel,
    refreshAgentSettings, refreshModelMonitor, refreshModelCapabilities, refreshCapabilities, retryAgentSettings
  } = agentPreferences;
  const homeCreation = useHomeCreation({
    fetchJson, userEmail, creationScope, databaseReady, chatBusy, clearChatMessages: () => setChatMessages([]),
    selectNewConversationSkill: (id, skillId) => setChatSkillSelection({ id: skillId, scope: skillSelectionScopeFor(id) }),
    setErrorMessage, setNoticeMessage, navigateRoute, currentConversationId, conversationBusy, setConversationBusy,
    invalidateConversationReads, setConversations, selectConversation
  });
  const conversationModels = useConversationModels({
    fetchJson, scope: modelSettingsScope, conversation: currentConversation, currentConversationId, currentConversationIdRef,
    modelCatalog, capabilities, savedModelName: modelSettingsReady ? savedAgentSettings.model_name : "尚未配置",
    chatBusy, invalidateConversationReads, setConversations, setModelUnavailable, setNoticeMessage
  });
  const { activeModelProfiles } = conversationModels;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      pagePrefetcher.prefetchWhenIdle(
        // Hover and keyboard focus already prefetch the destination page. On a
        // cold mobile connection, eagerly fetching every workspace competes
        // with the critical shell, styles, and authentication requests.
        ["chat"],
        (callback) => window.setTimeout(callback, 0)
      );
    }, 3000);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(preferenceKey("tuantuan-view", userEmail), activeView);
  }, [activeView]);

  useEffect(() => {
    if (!noticeMessage) return;
    const timer = window.setTimeout(() => setNoticeMessage(""), 2600);
    return () => window.clearTimeout(timer);
  }, [noticeMessage]);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    if (!user.has_avatar) {
      setAvatarUrl(null);
      return;
    }
    void fetchWithTimeout(`${apiBase}/auth/me/avatar`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("avatar missing");
        const blob = await response.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setAvatarUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setAvatarUrl(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [apiBase, accessToken, user.has_avatar, avatarEpoch]);

  useEffect(() => {
    function focusComposer(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.matches("input, textarea, select, [contenteditable='true']");
      if (event.key === "/" && !isTyping && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setActiveView("chat");
        window.setTimeout(() => chatInputRef.current?.focus(), 0);
      }
    }
    window.addEventListener("keydown", focusComposer);
    return () => window.removeEventListener("keydown", focusComposer);
  }, []);

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(preferenceKey("tuantuan-sidebar", userEmail), next ? "collapsed" : "expanded");
      return next;
    });
  }

  const hasLibrarySources = librarySources.some((source) => source.enabled && !source.trashed_at && source.parse_status === "ready");
  const libraryReady = libraryLoaded
    ? hasLibrarySources
    : null;
  const imageEdits = useImageEdits({ fetchJson, currentConversationId, currentConversationIdRef, refreshChat, refreshConversations, accountKey: userEmail });
  const displayedChatMessages = [...chatMessages, ...imageEdits.messages.filter(message => !chatMessages.some(saved => saved.id === message.id))];
  const hiddenMessageCount = Math.max(0, displayedChatMessages.length - visibleMessageCount);
  const visibleChatMessages = displayedChatMessages.slice(-visibleMessageCount);
  const latestAgent = [...chatMessages]
    .reverse()
    .find((message) => message.role === "assistant" && message.payload?.agent)?.payload?.agent;
  const waitingForUser = latestAgent?.status === "waiting_user";

  async function refreshAttachmentConfig() {
    const next = await fetchJson<AttachmentConfig>("/attachments/config");
    setAttachmentConfig(next);
  }

  function handleNextStep() {
    navigateRoute({ section: "settings", page: "library" });
  }

  function handleSuggestedAction() {
    if (!waitingForUser) {
      handleNextStep();
      return;
    }
    void sendChatMessage("检查刚才的失败原因，告诉我最简单的恢复步骤");
  }

  useEffect(() => {
    async function initializeDatabase() {
      const database = await fetchJson<{
        status: "uninitialized" | "requires_rebuild" | "ready";
        reason?: string;
      }>("/system/database-status");
      if (database.status === "requires_rebuild") {
        const confirmed = window.confirm(
          "当前数据库格式无法自动升级。\n\n继续前会自动生成带时间戳的完整备份；备份可用于恢复原数据库。是否现在备份并重建？"
        );
        if (!confirmed) {
          throw new Error("已取消数据库重建。当前旧数据库保持不变，确认后才能进入团团。");
        }
        await fetchJson("/system/database-rebuild", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmation: "确认重建团团数据库" })
        });
      }
      setDatabaseReady(true);
    }
    const initialization = databaseInitializationRef.current ?? initializeDatabase();
    databaseInitializationRef.current = initialization;
    initialization.catch((error: unknown) => {
      databaseInitializationRef.current = null;
      setErrorMessage(error instanceof Error ? error.message : "系统连接失败");
    });
  }, []);

  useEffect(() => {
    if (!databaseReady) return;
    const loaders: Record<RouteDataKey, () => Promise<unknown>> = {
      attachmentConfig: refreshAttachmentConfig,
      agentSettings: refreshAgentSettings,
      library: refreshLibrary,
      capabilities: refreshCapabilities,
      conversations: loadInitialConversations,
      modelMonitor: refreshModelMonitor,
      modelCapabilities: () => refreshModelCapabilities(false),
    };
    void Promise.all(requiredDataForRoute(appRoute).map((key) => (
      routeDataCache.load(key, loaders[key])
    ))).catch((error: unknown) => {
      setErrorMessage(error instanceof Error ? error.message : "读取页面数据失败");
    });
  }, [appRoute, databaseReady, fetchJson, userEmail]);

  useAsyncPolling({
    enabled: databaseReady && appRoute.section === "settings" && appRoute.page === "model",
    intervalMs: 15_000,
    poll: refreshModelMonitor,
    onError: (_reason, failures) => {
      if (failures >= 3) setErrorMessage("设置状态连续刷新失败，当前仍显示上一次数据。");
    }
  });

  useEffect(() => {
    if (!currentConversationId) return;
    chatAgentRef.current?.abortRun();
    chatAgentRef.current = null;
    setChatBusy(false);
    setRetryChatDraft(null);
    setVisibleMessageCount(12);
    setChatMessages([]);
    Promise.all([
      refreshChat(currentConversationId),
    ]).catch((error: unknown) => {
      setErrorMessage(error instanceof Error ? error.message : "切换对话失败");
    });
  }, [currentConversationId]);

  const routePageMeta = appRoute.section === "settings"
    ? {
      overview: pageMeta.settings,
      extensions: { title: "扩展中心", description: "管理技能、插件与 MCP，预览新的工作方式" },
      channels: { title: "消息渠道", description: "连接微信，在手机上向团团派任务" },
      appearance: { title: "外观", description: "统一设置所有模块的主题" },
      account: { title: "账号与安全", description: "管理跟随登录账号的昵称、头像和密码" },
      library: { title: "文件库管理", description: "整理文件、阅读原件，选取资料用于对话" },
      model: { title: "模型设置", description: "填写服务地址、API Key，选择使用的模型" },
      agent: { title: "智能体设置", description: "设置新对话的执行内核，查看 Agent 任务、工具使用和异常原因" },
      memory: { title: "记忆与个性化", description: "跨会话记住你的事实与偏好，仅存本地" }
    }[appRoute.page]
    : pageMeta[appRoute.section];

  const weixinChannel = useWeixinStatus(fetchJson, databaseReady);
  const weixinBot = useWeixinBot({ fetchJson, enabled: databaseReady, channel: weixinChannel,
    activeConversationId: appRoute.section === 'chat' && !workspaceLibraryOpen ? currentConversationId : null,
    chatBusy, onMessages: setChatMessages });
  const weixinActive = !!weixinBot?.conversation_id && appRoute.section === 'chat' && !workspaceLibraryOpen && currentConversationId === weixinBot.conversation_id;

  async function openWeixinConversation() {
    if (weixinBot?.conversation_id) {
      const intent = navigationIntent.current;
      try {
        await refreshConversations();
        // 会话列表刷新期间发生了其他导航时，保留用户新的位置。
        if (navigationIntent.current !== intent) return;
        navigateRoute({ section: "chat", conversationId: weixinBot.conversation_id });
      } catch {
        if (navigationIntent.current === intent) setErrorMessage("微信会话读取失败，请稍后重试");
      }
    } else navigateRoute({ section: "settings", page: "channels" });
  }

  const documentPageTitle = workspaceLibraryOpen ? "文件库｜AI 工作区" : appRoute.section === "chat"
    ? currentConversation?.title || "新对话"
    : routePageMeta.title;
  const topbarTitle = appTopBarShowsTitle(appRoute) ? documentPageTitle : undefined;
  const topbarSection = topbarTitle ? topbarSectionForPage(appRoute.section, topbarTitle) : undefined;

  useEffect(() => {
    document.title = `${documentPageTitle}｜团团`;
  }, [documentPageTitle]);

  const openTasks = databaseReady ? () => setTaskCenter({ scope: creationScope, view: "tasks" }) : undefined;
  const openNotifications = databaseReady ? () => setTaskCenter({ scope: creationScope, view: "notifications" }) : undefined;
  const openSearch = databaseReady ? () => setSearchScope(creationScope) : undefined;
  const workspaceActions = databaseReady ? (
    <div className="workspace-actions" role="group" aria-label="工作区工具">
      <ActionButton variant="ghost" size="sm" aria-label="全局搜索" title="全局搜索" icon={<Search aria-hidden="true" size={17} />} onClick={openSearch}>搜索</ActionButton>
      <ActionButton variant="ghost" size="sm" aria-label="任务中心" title="任务中心" icon={<ListTodo aria-hidden="true" size={17} />} onClick={openTasks}>任务</ActionButton>
      <ActionButton variant="ghost" size="sm" aria-label="通知" title="通知" icon={<Bell aria-hidden="true" size={17} />} onClick={openNotifications}>通知</ActionButton>
    </div>
  ) : null;

  const identityMenu = (
    <AppIdentityMenu
      userEmail={user.qq_only ? "QQ 登录" : userEmail}
      accountName={user.display_name || (user.qq_only ? "QQ 用户" : undefined)}
      avatarUrl={avatarUrl}
      activeView={activeView}
      settingsPage={appRoute.section === "settings" ? appRoute.page : undefined}
      onOpenAccount={() => navigateRoute({ section: "settings", page: "account" })}
      onOpenTasks={openTasks}
      onOpenNotifications={openNotifications}
      onOpenSearch={openSearch}
      onLogout={onLogout}
      onPrefetchPage={(page) => void pagePrefetcher.prefetch(page)}
    />
  );

  function selectProductNav(key: ProductNavKey) {
    if (key === "dashboard") navigateRoute({ section: "dashboard" });
    else if (key === "history") navigateRoute({ section: "history" });
    else if (key === "projects") navigateRoute({ section: "projects" });
    else if (key === "skills") navigateRoute({ section: "skills" });
    else if (key === "works") navigateRoute({ section: "works" });
    else if (key === "library") navigateRoute({ section: "chat", page: "library" });
    else if (key === "settings") navigateRoute({ section: "settings", page: "overview" });
  }

  const recordNavigation = useRef(0);
  const recordClient = useRef(fetchJson);
  recordClient.current = fetchJson;

  function openProjectItem(item: ProjectItem) {
    if (item.kind === "image_work" || item.kind === "final_work") {
      navigateRoute({ section: "works", work: `${item.kind}:${item.source_id}` });
    } else if (item.kind === "library") {
      setOpenLibraryResultId(Number(item.source_id));
      navigateRoute({ section: "chat", page: "library" });
    } else {
      openCreationRecord({ kind: item.kind, id: item.source_id, conversation_id: item.conversation_id });
    }
  }

  function openCreationRecord(record: Pick<CreationRecord, "kind" | "id" | "conversation_id">) {
    const intent = ++recordNavigation.current;
    if (record.kind === "image") navigateRoute({ section: "images", taskId: record.id });
    else if (record.kind === "document") {
      setInitialDocumentId(record.id);
      setDocumentsOpen(true);
    } else if (record.conversation_id !== null) {
      const conversationId = record.conversation_id;
      const origin = window.location.hash;
      const stillOpening = () => recordNavigation.current === intent && recordClient.current === fetchJson && window.location.hash === origin;
      void (async () => {
        const available = await refreshConversations();
        if (!stillOpening()) return;
        if (!available.some(item => item.id === conversationId)) {
          setErrorMessage("找不到这条记录的来源对话，请刷新创作记录后再试。");
          return;
        }
        selectConversation(conversationId);
      })().catch(() => { if (stillOpening()) setErrorMessage("暂时无法打开来源对话，请重试。"); });
    } else setErrorMessage("这条记录没有可打开的来源对话。");
  }

  function openTaskSource(source: TaskSource) {
    setTaskCenter(null);
    if (source.kind === "image") openCreationRecord({ kind: "image", id: source.id, conversation_id: null });
    else {
      const conversationId = Number(source.id);
      if (Number.isSafeInteger(conversationId) && conversationId > 0) openCreationRecord({ kind: "chat", id: source.id, conversation_id: conversationId });
    }
  }

  function openSearchHit(hit: SearchHit) {
    setSearchScope(null);
    if (hit.kind === "project") navigateRoute({ section: "projects", projectId: hit.id });
    else if (hit.kind === "image_work" || hit.kind === "final_work") {
      navigateRoute({ section: "works", work: `${hit.kind}:${hit.id}` });
    } else if (hit.kind === "knowledge") {
      const id = Number(hit.id);
      if (!Number.isSafeInteger(id) || id < 1) return;
      setOpenLibraryResultId(id);
      navigateRoute({ section: "chat", page: "library" });
    } else openCreationRecord({ kind: hit.kind, id: hit.id, conversation_id: hit.conversation_id });
  }

  async function useLibraryForChat(sourceIds: number[]) {
    const result = await fetchJson<{ conversation: Conversation; attachments: ChatAttachment[] }>("/library/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source_ids: sourceIds }) });
    await refreshConversations();
    setLibraryAttachments({ conversationId: result.conversation.id, attachments: result.attachments });
    selectConversation(result.conversation.id);
    setNoticeMessage(`${result.attachments.length} 个文件已加入新对话，输入问题后发送`);
  }

  async function editChatDocument(messageId: number) {
    if (documentCreation.current || !currentConversationId) return;
    const service = documentService, conversationId = currentConversationId, controller = new AbortController();
    documentCreation.current = controller;
    try {
      const manifest = await fetchJson<ArtifactManifest>(`/chat/messages/${messageId}/artifacts`, { signal: controller.signal });
      const document = await service.create({ conversation_id: conversationId, message_id: messageId, snapshot: manifest.snapshot,
        idempotency_key: `document:${conversationId}:${messageId}:${manifest.snapshot}` }, controller.signal);
      if (controller.signal.aborted || documentOwner.current !== service || currentConversationIdRef.current !== conversationId) return;
      setInitialDocumentId(document.document_id); setDocumentsOpen(true);
    } catch (caught) {
      if (!controller.signal.aborted && documentOwner.current === service) setErrorMessage(caught instanceof Error ? caught.message : "文档打开失败，请重试");
    } finally { if (documentCreation.current === controller) documentCreation.current = null; }
  }

  async function continueDocument(document: SavedDocument, signal: AbortSignal) {
    if (continuingDocument.current) throw new Error("正在准备文档对话，请稍候");
    const service = documentService, token = Symbol(); continuingDocument.current = token;
    let intent = documentContinuation.current;
    if (!intent || intent.service !== service || intent.documentId !== document.document_id || intent.version !== document.version) {
      intent = { service, documentId: document.document_id, version: document.version, conversationId: null, key: crypto.randomUUID() };
      documentContinuation.current = intent;
    }
    try {
      if (!intent.conversationId) {
        const created = await fetchJson<Conversation>("/conversations", { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: `继续修改 · ${document.title}`.slice(0, 60) }) });
        intent.conversationId = created.id;
      }
      if (signal.aborted || documentOwner.current !== service) return;
      const attachment = await service.attach(document.document_id, document.version, intent.conversationId, intent.key, signal);
      await refreshConversations();
      if (signal.aborted || documentOwner.current !== service) return;
      setLibraryAttachments({ conversationId: intent.conversationId, attachments: [attachment] });
      selectConversation(intent.conversationId);
      setNoticeMessage(`文档 v${document.version} 已加入新对话，输入修改要求后发送`);
      documentContinuation.current = null;
    } finally { if (continuingDocument.current === token) continuingDocument.current = null; }
  }

  function openImageConversation(conversationId: number) {
    const routeAtClick = window.location.hash;
    const selectedAtClick = currentConversationIdRef.current;
    const stillOpening = () => window.location.hash === routeAtClick && currentConversationIdRef.current === selectedAtClick;
    void (async () => {
      await refreshConversations();
      if (!stillOpening()) return;
      // 上次打开的图片可能属于同一会话，重新选择该会话不会自动加载历史消息。
      if (currentConversationIdRef.current === conversationId && !chatAgentRef.current) {
        await refreshChat(conversationId, () => stillOpening() && !chatAgentRef.current);
      }
      if (!stillOpening()) return;
      selectConversation(conversationId);
    })().catch((error: unknown) => {
      if (stillOpening()) setErrorMessage(error instanceof Error ? error.message : "打开对话失败");
    });
  }

  const libraryModule = (
    <Suspense fallback={<PageLoading label="正在加载文件库…" />}>
      <LibraryPage
        documentReviewService={documentReviewService}
        onOpenDocuments={() => { setInitialDocumentId(null); setDocumentsOpen(true); }}
        initialSourceId={openLibraryResultId}
        onInitialSourceConsumed={() => setOpenLibraryResultId(null)}
        editor={libraryEditor}
        sources={librarySources}
        folders={libraryFolders}
        collections={libraryCollections}
        onCreateCollection={createLibraryCollection}
        onRenameCollection={renameLibraryCollection}
        onDeleteCollection={deleteLibraryCollection}
        onUpdateCollectionSources={updateLibraryCollectionSources}
        onOrganizeSource={organizeLibrarySource}
        onCreateFolder={createLibraryFolder}
        onLoadOriginal={loadLibraryOriginal}
        onLoadAsset={async (sourceId, assetId, signal) => {
          const response = await fetchWithTimeout(`${apiBase}/library/sources/${sourceId}/assets/${encodeURIComponent(assetId)}/file`, { signal, headers: { Authorization: `Bearer ${accessToken}` } });
          if (!response.ok) throw new Error("存档图片读取失败");
          return response.blob();
        }}
        onSearchSources={searchLibrarySources}
        onUseForChat={useLibraryForChat}
        busy={libraryBusy}
        sourceBusy={sourceImportBusy}
        enhancedParse={enhancedDocumentParse}
        pendingFacts={pendingKnowledge}
        confirmedFacts={confirmedKnowledge}
        onChange={(editor: LibraryEditor) => setLibraryEditor(editor)}
        onEnhancedParseChange={setEnhancedDocumentParse}
        onImportFiles={importLibraryFiles}
        onCreateText={createPastedSource}
        onLoadSource={(sourceId) => fetchJson<LibrarySourceDetail>(`/library/sources/${sourceId}`)}
        onUpdateSource={updateLibrarySource}
        onDownloadSource={downloadLibrarySource}
        onDeleteSource={deleteLibrarySource}
        onReviewFact={async (factId, action) => {
          await fetchJson(`/library/facts/${factId}/review`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action })
          });
          await refreshLibrary();
        }}
        onSave={async () => {
          return saveLibraryMetadata();
        }}
      />
    </Suspense>
  );

  return (
    <ExtensionPreviewProvider key={JSON.stringify([apiBase, user.id ?? user.email])} apiBase={apiBase} accessToken={accessToken}>
    <LocalCitationProvider apiBase={apiBase} accessToken={accessToken}>
    <main className={`app-shell has-chat-dock shell-light${activeView === "chat" ? " chat-focused" : ""}${activeView === "dashboard" ? " developer-home-shell" : ""}`}>
      <AppSidebar
        collapsed={sidebarCollapsed}
        activeView={activeView}
        onToggle={toggleSidebar}
        onGoHome={() => navigateRoute({ section: "dashboard" })}
        onPrefetchPage={(page) => void pagePrefetcher.prefetch(page)}
        settingsPage={appRoute.section === "settings" ? appRoute.page : undefined}
        libraryOpen={workspaceLibraryOpen}
        onSelectNav={selectProductNav}
        identity={identityMenu}
        shortcuts={databaseReady && <WorkspaceShortcuts key={creationScope} fetchJson={fetchJson}
          projectsOpen={shortcutState?.projects ?? true}
          recordsOpen={shortcutState?.records ?? true}
          onOpenChange={(group, open) => setShortcutStates(previous => ({
            ...previous, [creationScope]: { ...previous[creationScope], [group]: open },
          }))}
          projectsActive={activeView === "projects"}
          projectsRevision={projectsRevision}
          onViewProjects={() => selectProductNav("projects")}
          onViewRecords={() => selectProductNav("history")}
          onProject={projectId => navigateRoute({ section: "projects", projectId })} onRecord={openCreationRecord} />}
        weixinBot={weixinBot}
        weixinActive={weixinActive}
        onOpenWeixin={openWeixinConversation}
      />

      <section className={`content${activeView === "chat" ? " chat-content is-chat-focus" : ""}${activeView === "dashboard" ? " home-content" : ""}${appRoute.section === "settings" && appRoute.page === "library" ? " library-content" : ""}${appRoute.section === "images" || appRoute.section === "works" ? " image-studio-host" : ""}${topbarTitle ? "" : " is-titleless"}`}>
        {activeView !== "chat" && <AppTopBar section={topbarSection} title={topbarTitle}>
          {workspaceActions}
        </AppTopBar>}

        {activeView === "dashboard" ? (
          <Suspense fallback={<PageLoading label="正在加载首页…" />}>
            <HomePage
              key={creationScope}
              fetchJson={fetchJson}
              accountName={user.display_name?.trim() || (user.qq_only ? "QQ 用户" : userEmail.split("@")[0])}
              accountKey={userEmail}
              creationEntry={<CreationEntry
                mode={homeCreation.form.mode}
                drafts={homeCreation.form.drafts}
                files={homeCreation.homeFiles}
                onFiles={homeCreation.setHomeFiles}
                onMode={mode => homeCreation.updateForm(form => ({ ...form, mode }))}
                onDraft={(mode, text) => homeCreation.updateForm(form => ({ ...form, drafts: { ...form.drafts, [mode]: text } }))}
                onOpen={homeCreation.openCreationWorkspace}
                onOpenVideo={() => navigateRoute({ section: "video" })}
                onOpenDocuments={() => { setInitialDocumentId(null); setDocumentsOpen(true); }}
                onOpenSkills={() => navigateRoute({ section: "skills" })}
                onOpenImageSettings={() => navigateRoute({ section: "settings", page: "model", purpose: "image" })}
                imageSettings={homeCreation.form.imageSettings}
                onImageSettings={imageSettings => homeCreation.updateForm(form => ({ ...form, imageSettings }))}
                fetchJson={fetchJson}
                voiceInput={voiceInput}
                ready={databaseReady}
                busy={homeCreation.form.mode === "chat" && (conversationBusy || chatBusy)}
              />}
              onAnalyze={homeCreation.analyzeHomeItem}
              onLibraryChanged={refreshLibrary}
              weixinLive={weixinBot ? { connected: weixinBot.connected, unread_count: weixinBot.unread_count } : null}
            />
          </Suspense>
        ) : null}

        {appRoute.section === "history" ? (databaseReady
          ? <CreationRecords key={creationScope} fetchJson={fetchJson} onOpen={openCreationRecord} onCreate={() => navigateRoute({ section: "dashboard" })} />
          : <PageLoading label="正在连接创作记录…" />) : null}

        {appRoute.section === "projects" ? (databaseReady
          ? <ProjectsPage key={creationScope} id={appRoute.projectId} fetchJson={fetchJson}
            modelOptions={activeModelProfiles.filter(profile => profile.supported_purposes?.includes("chat")).map(profile => ({
              id: profile.id, label: `${profile.model_name} · ${modelCatalog.catalog.connections.find(connection => connection.id === profile.connection_id)?.name ?? "模型连接"}`,
            }))}
            modelLoading={modelCatalog.loading || (!modelCatalog.loaded && !modelCatalog.error)} modelError={modelCatalog.error}
            onRetryModels={() => { void modelCatalog.reload(); }} conversationBusy={conversationBusy || chatBusy}
            onProjectsChanged={() => setProjectsRevision(revision => revision + 1)}
            onSelect={projectId => navigateRoute({ section: "projects", projectId })} onOpen={openProjectItem}
            onOpenConversation={(create, signal) => homeCreation.openHomeConversation(create, "", "已新建项目对话", { ownerSignal: signal })} />
          : <PageLoading label="正在连接项目…" />) : null}

        {appRoute.section === "skills" ? (databaseReady ? (
          <Suspense fallback={<PageLoading label="正在加载技能中心…" />}>
            <SkillsCenterPage key={creationScope} apiBase={apiBase} accessToken={accessToken} fetchJson={fetchJson}
              capabilities={capabilities} conversationBusy={conversationBusy || chatBusy}
              onOpenExtensions={() => navigateRoute({ section: "settings", page: "extensions" })}
              onOpenAgentSettings={() => navigateRoute({ section: "settings", page: "agent" })}
              onOpenModelSettings={purpose => navigateRoute(purpose === "image" ? { section: "settings", page: "model", purpose } : { section: "settings", page: "model" })}
              onOpenImage={() => homeCreation.openCreationWorkspace("images", "")}
              onOpenSkill={skillId => homeCreation.openNewChatDraft("", "已选择技能，填写任务后发送", skillId)} />
          </Suspense>
        ) : <PageLoading label="正在连接技能中心…" />) : null}

        {visitedImageWorkspace || appRoute.section === "images" ? <div hidden={appRoute.section !== "images"}>
          <ImageWorkspacePage
            key={`${apiBase}:${userEmail}`}
            apiBase={apiBase}
            accessToken={accessToken}
            fetchJson={fetchJson}
            ready={databaseReady}
            active={appRoute.section === "images"}
            initialTaskId={appRoute.section === "images" ? appRoute.taskId : undefined}
            onCloseInitialTask={() => navigateRoute({ section: "images" }, true)}
            accountKey={userEmail}
            creationDraft={homeCreation.imageDraft}
            onCreationDraftConsumed={homeCreation.consumeImageDraft}
            onOpenWorks={() => navigateRoute({ section: "works" })}
            refreshConversations={refreshConversations}
            onLibraryChanged={refreshLibrary}
            onOpenConversation={openImageConversation}
            onOpenSettings={() => navigateRoute({ section: "settings", page: "model", purpose: "image" })}
          />
        </div> : null}
        {appRoute.section === "video" ? <VideoPage
          onOpenChat={() => navigateRoute({ section: "chat", conversationId: currentConversationId ?? undefined })}
          onOpenLibrary={() => selectProductNav("library")}
          onOpenSettings={() => navigateRoute({ section: "settings", page: "model" })}
        /> : null}
        {appRoute.section === "works" ? <WorksPage
          key={`${apiBase}:${userEmail}`}
          apiBase={apiBase}
          accessToken={accessToken}
          fetchJson={fetchJson}
          ready={databaseReady}
          linkedWork={appRoute.work}
          onCloseLinkedWork={() => navigateRoute({ section: "works" }, true)}
          onOpenImages={() => navigateRoute({ section: "images" })}
        /> : null}

        {appRoute.section === "settings" ? (
          <Suspense fallback={<PageLoading label="正在加载设置…" />}>
            <SettingsWorkspace
              page={appRoute.page}
              onBack={() => navigateRoute({ section: "settings", page: "overview" })}
            >
              {appRoute.page === "overview" ? (
                <SettingsOverview
                  library={libraryEditor}
                  libraryReady={libraryReady}
                  sourceTitle={librarySources.find(source => !source.trashed_at)?.title}
                  fileCount={sourceCount}
                  accountEmail={user.qq_only ? "QQ 登录" : user.email}
                  accountName={user.display_name}
                  modelName={savedAgentSettings.model_name}
                  apiKeyConfigured={savedAgentSettings.api_key_configured}
                  onOpen={(page) => navigateRoute({ section: "settings", page })}
                />
              ) : null}
              {appRoute.page === "appearance" ? <AppearanceSettingsPage /> : null}
              {appRoute.page === "extensions" ? <ExtensionsPage /> : null}
              {appRoute.page === "channels" ? <WeixinSettingsPage key={`${apiBase}:${user.id}`} apiBase={apiBase} accessToken={accessToken} channel={weixinChannel} /> : null}
              {appRoute.page === "account" ? (
                <AccountSettingsPage
                  apiBase={apiBase}
                  accessToken={accessToken}
                  account={user}
                  avatarUrl={avatarUrl}
                  onAccountChange={(next) => {
                    updateSession(accessToken, next);
                    if (next.has_avatar) setAvatarEpoch((value) => value + 1);
                  }}
                  onPasswordChanged={updateSession}
                />
              ) : null}
              {appRoute.page === "memory" ? <MemorySettingsPage fetchJson={fetchJson} /> : null}
              {appRoute.page === "library" ? libraryModule : null}
              {appRoute.page === "model" ? (
                <ModelSettingsRoute preferences={agentPreferences} fetchJson={fetchJson} userEmail={userEmail} purpose={appRoute.purpose} errorMessage={errorMessage} />
              ) : null}
              {appRoute.page === "agent" ? <>
                {modelSettingsReady ? <AgentKernelSettings
                  choices={kernels.catalog?.choices ?? []}
                  defaultKernel={savedAgentSettings.default_kernel}
                  busy={agentSettingsBusy || modelSettingsEditing || Boolean(modelSaveUnknown) || kernels.busy}
                  onChange={kernel => { void changeDefaultKernel(kernel); }}
                /> : modelSettingsLoadError ? <section className="settings-card" role="alert">
                  <h3>无法读取智能体配置</h3><p>读取成功前不会修改默认内核。</p>
                  <button type="button" onClick={retryAgentSettings}>重新读取</button>
                </section> : <PageLoading label="正在读取智能体配置…" />}
                <Suspense fallback={<PageLoading label="正在加载 Agent 运行记录…" />}>
                  {databaseReady ? (
                    <AgentOperationsDashboard
                      key={JSON.stringify([apiBase, user.id ?? user.email])}
                      fetchJson={fetchJson}
                      onOpenConversation={openAgentRunConversation}
                      theme={resolvedTheme}
                    />
                  ) : <PageLoading label="正在连接本地数据…" />}
                </Suspense>
              </> : null}
            </SettingsWorkspace>
          </Suspense>
        ) : null}

      </section>

      {firstRun.shouldShow && activeView === "dashboard" ? (
        <FirstRunGuide
          onDismiss={firstRun.complete}
          onOpenModelSettings={() => {
            firstRun.complete();
            navigateRoute({ section: "settings", page: "model" });
          }}
          onOpenLibrary={() => {
            firstRun.complete();
            navigateRoute({ section: "chat", page: "library" });
          }}
        />
      ) : null}

      <AssistantSurface page={activeView === "chat"} open={assistantOpen} busy={chatBusy} onClose={() => setAssistantOpen(false)} onExpand={() => { setAssistantOpen(false); navigateRoute({ section: "chat", conversationId: currentConversationId ?? undefined }); }}>

        <AIWorkspaceModules active={activeView === "chat"} libraryOpen={workspaceLibraryOpen}
          library={libraryModule}>
        <Suspense fallback={<PageLoading label="正在加载对话…" />}>
          <ChatWorkspace
            documentReviewService={documentReviewService}
            documentService={documentService}
            onEditDocument={messageId => { void editChatDocument(messageId); }}
            onContinueDocument={continueDocument}
            onDocumentArchived={() => { void refreshLibrary(); }}
            density={activeView === "chat" ? "page" : "dock"}
            workspaceActions={activeView === "chat" ? workspaceActions : null}
            focused={activeView === "chat" && !workspaceLibraryOpen}
            conversationTitle={currentConversation?.title}
            currentModelName={conversationModels.currentModelName}
            defaultModelName={conversationModels.defaultModelName}
            modelProfiles={activeModelProfiles.map(profile => ({ id: profile.id, model_name: profile.model_name, connection_id: profile.connection_id, capabilities: profile.capabilities, connection_name: modelCatalog.catalog.connections.find(connection => connection.id === profile.connection_id)?.name || "模型连接" }))}
            serviceModels={conversationModels.serviceModels}
            additionalServiceModels={conversationModels.additionalServiceModels}
            onDiscoverServiceModels={conversationModels.discoverServiceModels}
            onServiceModelChange={conversationModels.selectServiceModel}
            selectedModelProfileId={conversationModels.selectedModelProfileId}
            modelSettings={conversationModels.composerModelSettings}
            modelSelectionBusy={conversationModels.modelSelectionBusy}
            modelSelectionFeedback={conversationModels.modelSelectionFeedback}
            onDismissModelSelectionFeedback={conversationModels.dismissModelSelectionFeedback}
            modelProfileUnavailable={conversationModels.modelProfileUnavailable}
            modelConfigured={capabilities ? capabilities.configured !== false : undefined}
            onModelProfileChange={conversationModels.selectConversationModel}
            messages={visibleChatMessages}
            selectedSkillId={selectedSkillId}
            onSelectSkill={(id) => setChatSkillSelection({ scope: skillSelectionScope, id })}
            hiddenMessageCount={hiddenMessageCount}
            chatBusy={chatBusy}
            modelUnavailable={modelUnavailable}
            sendError={sendError}
            onOpenModelSettings={() => navigateRoute({ section: "settings", page: "model" })}
            currentConversationId={currentConversationId}
            webSearchEnabled={webSearchEnabled}
            webSearchAvailable={webSearchAvailable}
            onWebSearchChange={conversationWebSearch.setEnabled}
            libraryAttachments={libraryAttachments}
            onLibraryAttachmentsConsumed={() => setLibraryAttachments(null)}
            composerDraft={homeCreation.conversationDraft}
            draftFiles={homeCreation.conversationDraftFiles}
            onDraftFilesChange={homeCreation.setConversationDraftFiles}
            composerDrafts={composerDrafts}
            onComposerDraftConsumed={homeCreation.consumeConversationDraft}
            conversations={conversations}
            conversationBusy={conversationBusy}
            waitingForUser={waitingForUser}
            latestAgent={latestAgent}
            taskCancelBusy={taskCancelBusy}
            retryDraft={retryChatDraft}
            chatEndRef={chatEndRef}
            chatInputRef={chatInputRef}
            sessionContext={{
              sourceLabel: hasLibrarySources ? (librarySources.find((source) => source.enabled && !source.trashed_at && source.parse_status === "ready")?.title || "已保存资料") : null,
              analysisLabel: null,
            }}
            onLoadMore={() => setVisibleMessageCount((count) => count + 12)}
            onSelectConversation={selectConversation}
            onCreateConversation={() => void createNewConversation()}
            onEnsurePresentationConversation={ensurePresentationConversation}
            onRenameConversation={(conversation) => setConversationDialog({ kind: "rename", conversation })}
            onArchiveConversation={(conversation) => void archiveConversation(conversation)}
            onRemoveConversation={(conversation) => setConversationDialog({ kind: "delete", conversation })}
            attachmentBusy={chatAttachmentBusy}
            attachmentConfig={attachmentConfig}
            onUploadAttachment={uploadChatAttachment}
            voiceInput={voiceInput}
            onEditGeneratedImage={imageEdits.editImage}
            onLoadAttachment={loadChatAttachment}
            onLoadAttachmentThumbnail={async (attachment, signal) => {
              const response = await fetchWithTimeout(`${apiBase}/${attachment.origin === "generated" ? "chat-assets" : "attachments"}/${encodeURIComponent(attachment.id)}/thumbnail`, { signal, headers: { Authorization: `Bearer ${accessToken}` } });
              if (!response.ok) throw new Error("缩略图读取失败");
              return response.blob();
            }}
            resultFolders={libraryFolders}
            onLoadResults={(messageId, signal) => fetchJson<ArtifactManifest>(`/chat/messages/${messageId}/artifacts`, { signal })}
            onSaveResult={async (messageId, request, signal) => {
              const result = await fetchJson<{ source: LibrarySourceDetail; reused: boolean }>(`/chat/messages/${messageId}/save-to-library`, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
              void refreshLibrary();
              return result;
            }}
            onOpenSavedResult={sourceId => { setOpenLibraryResultId(sourceId); navigateRoute({ section: "chat", page: "library" }); }}
            onRemoveAttachment={removeChatAttachment}
            onAttachmentInvalid={setErrorMessage}
            onSuggestedAction={handleSuggestedAction}
            onCancelTask={() => void cancelCurrentTask()}
            onSend={sendChatMessage}
            onRetry={retryChatMessage}
            onStop={stopChatGeneration}
            onEdit={editChatMessage}
            onRegenerate={regenerateChatMessage}
            onDeleteTurn={deleteChatTurn}
            onExportConversation={() => downloadConversationMarkdown(currentConversation?.title || "对话", chatMessages)}
            onSearchConversations={searchConversations}
            pinnedConversationIds={pinnedConversationIds}
            onTogglePinConversation={togglePinnedConversation}
            conversationFolders={conversationFolders}
            conversationFolderAssignments={conversationFolderAssignments}
            onCreateConversationFolder={createConversationFolder}
            onRenameConversationFolder={renameConversationFolder}
            onRemoveConversationFolder={removeConversationFolder}
            onAssignConversationFolder={assignConversationFolder}
            onPersistComposerDrafts={persistComposerDrafts}
            replacementUndo={replacementUndo}
            onUndoReplacement={undoReplacement}
            onOpenLibrary={() => navigateRoute({ section: "chat", page: "library" })}
          />
        </Suspense>
        </AIWorkspaceModules>
      </AssistantSurface>

      {errorMessage ? (
        <div className="feedback-banner error-banner global-error-toast"><TriangleAlert size={16} /><span>{errorMessage}</span><button onClick={() => setErrorMessage("")} aria-label="关闭错误提示"><X size={15} /></button></div>
      ) : null}
      {noticeMessage ? (
        <div className="feedback-banner notice-banner global-notice-toast" role="status" aria-live="polite"><CheckCircle2 size={16} /><span>{noticeMessage}</span></div>
      ) : null}
      {databaseReady && taskCenter?.scope === creationScope && <TaskCenter key={creationScope} view={taskCenter.view} fetchJson={fetchJson}
        onClose={() => setTaskCenter(null)} onChange={view => setTaskCenter({ scope: creationScope, view })} onOpenSource={openTaskSource} />}
      {databaseReady && searchScope === creationScope && <GlobalSearch key={creationScope} fetchJson={fetchJson}
        onClose={() => setSearchScope(null)} onOpen={openSearchHit} />}
      {documentsOpen ? <DocumentLibraryDialog key={user.id ?? user.email} initialDocumentId={initialDocumentId} service={documentService} folders={libraryFolders} onClose={() => { setDocumentsOpen(false); setInitialDocumentId(null); }} onContinue={continueDocument} onArchived={() => { void refreshLibrary(); }} /> : null}
      {conversationDialog ? (
        <ConversationDialog
          dialog={conversationDialog}
          busy={conversationBusy}
          onClose={() => setConversationDialog(null)}
          onRename={(conversation, title) => void renameConversation(conversation, title)}
          onDelete={(conversation) => void removeConversation(conversation)}
        />
      ) : null}
    </main>
    </LocalCitationProvider>
    </ExtensionPreviewProvider>
  );
}
