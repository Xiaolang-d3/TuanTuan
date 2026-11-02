import { readStorageItem } from "../storage";
import { useModelCatalog } from "../features/settings/useModelCatalog";
import { useComposerModelDiscovery } from "../features/chat/useComposerModelDiscovery";
import { useModelDiscovery } from "../features/settings/useModelDiscovery";
import { useTheme } from "../features/appearance/ThemeProvider";
import { AppearanceSettingsPage } from "../features/settings/AppearanceSettingsPage";
import { PageLoading } from "../components/PageLoading";
import { downloadConversationMarkdown } from "../features/chat/conversationActions";
import { readConversationFolders, readIdList, readStringMap, writeConversationFolders, writeIdList, writeStringMap, type ConversationFolder } from "../features/chat/localChatPreferences";
import { useChatRun } from "../features/chat/useChatRun";
import { useConversations } from "../features/chat/useConversations";
import { useLibrary } from "../features/library/useLibrary";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createApiClient, fetchWithTimeout } from "../api/client";
import { createVoiceInputService } from "../features/chat/voiceInput";
import type { AuthUser } from "../components/AuthGate";
import { AssistantSurface } from "../components/AssistantSurface";
import { AIWorkspaceModules } from "../features/chat/AIWorkspaceModules";
import { AppSidebar, type ProductNavKey } from "../components/AppSidebar";
import { AppIdentityMenu } from "../components/AppIdentityMenu";
import { AppTopBar } from "../components/AppTopBar";
import { ConversationDialog } from "../components/ConversationDialog";
import type { AttachmentConfig, ChatAttachment, ChatComposerDraft } from "../features/chat/types";
import type { ModelParameterUpdate } from "../features/chat/ComposerModelParameters";
import type { ArtifactManifest } from "../features/chat/result-types";
import type { HomeReadableItem } from "../features/home/types";
import { createHomeAnalysisConversation, homeAnalysisDraft } from "../features/home/analysis-draft";
import { defaultAgentSettings, pageMeta, topbarSectionForPage } from "../constants";
import { createPagePrefetcher } from "../page-prefetch";
import { createRouteDataCache, requiredDataForRoute, type RouteDataKey } from "../route-data";
import { useAsyncPolling } from "../hooks/useAsyncPolling";
import { appRouteHash, initialAppRoute, parseAppHash, routeForSection, type AppRoute } from "../routing";
import { isProductIntroHash } from "./public-routing";
import type { AgentCapabilities, AgentOperationsSnapshot, AgentSettings, Conversation, LibraryEditor, LibrarySourceDetail, ModelCapabilityReport, ModelServiceCheck, ModelServiceMonitor, ViewKey } from "../types";
import { CheckCircle2, TriangleAlert, X } from "lucide-react";
import "../styles/foundations.css";
import "../AppStyles";

type ModelSaveReceipt = { committed: boolean; saved_revision: number | null; settings: AgentSettings };
function matchesModelConfiguration(result: { connection_id?: string; config_revision?: number }, saved: AgentSettings) {
  return (result.connection_id === undefined || saved.connection_id === undefined || result.connection_id === saved.connection_id)
    && (result.config_revision === undefined || saved.config_revision === undefined || result.config_revision === saved.config_revision);
}

type ModelRequestKind = "read" | "monitor" | "capabilities" | "check" | "save" | "serviceCapabilities";
type ModelSettingsScope = {
  client: ReturnType<typeof createApiClient>;
  account: string;
  active: boolean;
  epoch: number;
  requests: Record<ModelRequestKind, number>;
  controllers: Set<AbortController>;
};

function modelKeyOptional(settings: AgentSettings) {
  return settings.model_protocol === "ollama" || (settings.model_protocol === "auto" && /ollama|:11434(?:\/|$)/i.test(settings.model_base_url));
}

function normalizedModelAddress(value: string) {
  return value.trim().replace(/\/+$/, "");
}

const loadChatWorkspace = () => import("../components/ChatWorkspace");

const loadHomePage = () => import("../features/home/HomePage");

const loadSettingsWorkspace = () => import("../features/settings/SettingsWorkspace");

const loadLibraryPage = () => import("../features/library/LibraryPage");

const loadAccountSettingsPage = () => import("../features/settings/AccountSettingsPage");

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

const LibraryPage = lazy(() => loadLibraryPage().then((module) => ({
  default: module.LibraryPage
})));

const AccountSettingsPage = lazy(() => loadAccountSettingsPage().then((module) => ({
  default: module.AccountSettingsPage
})));

const ModelConnectionManager = lazy(() => import("../features/settings/ModelConnectionManager").then((module) => ({ default: module.ModelConnectionManager })));
const ModelRoutingPanel = lazy(() => import("../features/settings/ModelRoutingPanel").then((module) => ({ default: module.ModelRoutingPanel })));
const ModelFallbackSettings = lazy(() => import("../features/settings/ModelFallbackSettings").then((module) => ({ default: module.ModelFallbackSettings })));
const ModelUsageRules = lazy(() => import("../features/settings/ModelUsageRules").then((module) => ({ default: module.ModelUsageRules })));

const ModelSettingsPage = lazy(() => import("../features/settings/ModelSettingsPage").then((module) => ({
  default: module.ModelSettingsPage
})));

const pagePrefetcher = createPagePrefetcher({
  chat: loadChatWorkspace,
  library: () => Promise.all([loadSettingsWorkspace(), loadLibraryPage()]),
  account: () => Promise.all([loadSettingsWorkspace(), loadAccountSettingsPage()]),
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
  const fetchJson = useMemo(() => createApiClient(apiBase, accessToken), [apiBase, accessToken]);
  const voiceInput = useMemo(() => createVoiceInputService(fetchJson), [fetchJson]);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarEpoch, setAvatarEpoch] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readPreference("tuantuan-sidebar", userEmail) === "collapsed");
  const [appRoute, setAppRoute] = useState<AppRoute>(() => initialAppRoute(window.location.hash));
  const activeView: ViewKey = appRoute.section;
  const workspaceLibraryOpen = appRoute.section === "chat" && appRoute.page === "library";
  const currentConversationIdRef = useRef<number | null>(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(12);
  const [errorMessage, setErrorMessage] = useState("");
  const [noticeMessage, setNoticeMessage] = useState("");
  const { invalidateConversationReads, conversations, setConversations, currentConversationId, setCurrentConversationId, conversationBusy, setConversationBusy, conversationDialog, setConversationDialog, refreshConversations, searchConversations, createNewConversation, archiveConversation, renameConversation, removeConversation } = useConversations({ fetchJson, setActiveView, setErrorMessage, setNoticeMessage });
  const { libraryEditor, librarySources, libraryFolders, libraryCollections, createLibraryCollection, renameLibraryCollection, deleteLibraryCollection, updateLibraryCollectionSources, organizeLibrarySource, createLibraryFolder, loadLibraryOriginal, searchLibrarySources, confirmedKnowledge, confirmedKnowledgeCount, sourceCount, pendingKnowledge, libraryLoaded, libraryBusy, sourceImportBusy, enhancedDocumentParse, setLibraryEditor, setEnhancedDocumentParse, refreshLibrary, saveLibraryMetadata, importLibraryFiles, createPastedSource, updateLibrarySource, downloadLibrarySource, deleteLibrarySource } = useLibrary({ fetchJson, apiBase, accessToken, setErrorMessage, setNoticeMessage });
  const [openLibraryResultId, setOpenLibraryResultId] = useState<number | null>(null);
  const [libraryAttachments, setLibraryAttachments] = useState<{ conversationId: number; attachments: ChatAttachment[] } | null>(null);
  const [homeComposerDraft, setHomeComposerDraft] = useState<ChatComposerDraft | null>(null);
  const composerDrafts = useMemo(() => readStringMap(preferenceKey("tuantuan-composer-drafts", userEmail)), [userEmail]);
  const persistComposerDrafts = useCallback(() => {
    writeStringMap(preferenceKey("tuantuan-composer-drafts", userEmail), composerDrafts);
  }, [composerDrafts, userEmail]);
  const [pinnedConversationIds, setPinnedConversationIds] = useState<number[]>(() => readIdList(preferenceKey("tuantuan-pinned-conversations", userEmail)));
  useEffect(() => {
    setPinnedConversationIds(readIdList(preferenceKey("tuantuan-pinned-conversations", userEmail)));
  }, [userEmail]);
  function togglePinnedConversation(conversation: Conversation) {
    setPinnedConversationIds((current) => {
      const next = current.includes(conversation.id) ? current.filter((id) => id !== conversation.id) : [...current, conversation.id];
      writeIdList(preferenceKey("tuantuan-pinned-conversations", userEmail), next);
      return next;
    });
  }
  const storedFolders = useMemo(() => readConversationFolders(preferenceKey("tuantuan-conversation-folders", userEmail)), [userEmail]);
  const [conversationFolders, setConversationFolders] = useState<ConversationFolder[]>(storedFolders.folders);
  const [conversationFolderAssignments, setConversationFolderAssignments] = useState<Record<number, string>>(storedFolders.assignments);
  useEffect(() => {
    const next = readConversationFolders(preferenceKey("tuantuan-conversation-folders", userEmail));
    setConversationFolders(next.folders);
    setConversationFolderAssignments(next.assignments);
  }, [userEmail]);
  function storeFolders(folders: ConversationFolder[], assignments: Record<number, string>) {
    writeConversationFolders(preferenceKey("tuantuan-conversation-folders", userEmail), folders, assignments);
  }
  function createConversationFolder(name: string) {
    const trimmed = name.trim().slice(0, 40);
    if (!trimmed) return;
    const next = [...conversationFolders, { id: crypto.randomUUID().replace(/-/g, "").slice(0, 16), name: trimmed }].slice(0, 30);
    setConversationFolders(next);
    storeFolders(next, conversationFolderAssignments);
  }
  function renameConversationFolder(folderId: string, name: string) {
    const trimmed = name.trim().slice(0, 40);
    if (!trimmed) return;
    const next = conversationFolders.map((folder) => folder.id === folderId ? { ...folder, name: trimmed } : folder);
    setConversationFolders(next);
    storeFolders(next, conversationFolderAssignments);
  }
  function removeConversationFolder(folderId: string) {
    const next = conversationFolders.filter((folder) => folder.id !== folderId);
    const assignments = Object.fromEntries(Object.entries(conversationFolderAssignments).filter(([, value]) => value !== folderId));
    setConversationFolders(next);
    setConversationFolderAssignments(assignments);
    storeFolders(next, assignments);
  }
  function assignConversationFolder(conversation: Conversation, folderId: string | null) {
    const assignments = { ...conversationFolderAssignments };
    if (folderId) assignments[conversation.id] = folderId;
    else delete assignments[conversation.id];
    setConversationFolderAssignments(assignments);
    storeFolders(conversationFolders, assignments);
  }
  const { migrateHomeTheme } = useTheme();
  useEffect(() => { migrateHomeTheme(userEmail); }, [migrateHomeTheme, userEmail]);
  const homeAnalysisBusyRef = useRef(false);
  const homeAnalysisControllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    homeAnalysisControllerRef.current?.abort();
    homeAnalysisControllerRef.current = null;
    homeAnalysisBusyRef.current = false;
    setConversationBusy(false);
  }, [fetchJson, userEmail, setConversationBusy]);
  const { chatMessages, setChatMessages, chatBusy, setChatBusy, modelUnavailable, setModelUnavailable, sendError, retryChatDraft, setRetryChatDraft, replacementUndo, chatAgentRef, taskCancelBusy, setTaskCancelBusy, chatAttachmentBusy, setChatAttachmentBusy, refreshChat, uploadChatAttachment, loadChatAttachment, removeChatAttachment, sendChatMessage, stopChatGeneration, rewindChatToUserMessage, editChatMessage, regenerateChatMessage, undoReplacement, deleteChatTurn, cancelCurrentTask } = useChatRun({ apiBase, accessToken, fetchJson, currentConversationId, currentConversationIdRef, modelProfileId: conversations.find(item => item.id === currentConversationId)?.model_profile_id ?? null, setErrorMessage, setNoticeMessage, refreshConversations, onLibraryChanged: refreshLibrary });
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);
  const [attachmentConfig, setAttachmentConfig] = useState<AttachmentConfig | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(defaultAgentSettings);
  const [savedAgentSettings, setSavedAgentSettings] = useState<AgentSettings>(defaultAgentSettings);
  const savedAgentSettingsRef = useRef<AgentSettings>(defaultAgentSettings);
  const [modelSettingsLoaded, setModelSettingsLoaded] = useState(false);
  const [modelSettingsLoadError, setModelSettingsLoadError] = useState("");
  const [modelSelectionBusy, setModelSelectionBusy] = useState(false);
  const [modelSelectionFeedback, setModelSelectionFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const modelSelectionRequestRef = useRef<{ id: number; controller: AbortController | null }>({ id: 0, controller: null });
  const [modelSaveUnknown, setModelSaveUnknown] = useState<string | null>(null);
  const modelSettingsScopeRef = useRef<ModelSettingsScope | null>(null);
  const modelSettingsStateScopeRef = useRef<ModelSettingsScope | null>(null);
  if (!modelSettingsScopeRef.current || modelSettingsScopeRef.current.client !== fetchJson || modelSettingsScopeRef.current.account !== userEmail) {
    const previous = modelSettingsScopeRef.current;
    if (previous) {
      previous.active = false;
      for (const controller of previous.controllers) controller.abort();
    }
    modelSettingsScopeRef.current = {
      client: fetchJson, account: userEmail, active: true, epoch: 0,
      requests: { read: 0, monitor: 0, capabilities: 0, check: 0, save: 0, serviceCapabilities: 0 },
      controllers: new Set()
    };
  }
  const modelSettingsScope = modelSettingsScopeRef.current;
  const modelSettingsReady = modelSettingsLoaded && modelSettingsStateScopeRef.current === modelSettingsScope;
  const [agentSettingsBusy, setAgentSettingsBusy] = useState(false);
  const [modelSettingsEditing, setModelSettingsEditing] = useState(false);
  const modelSettingsEditingRef = useRef(false);
  const [modelMonitor, setModelMonitor] = useState<ModelServiceMonitor | null>(null);
  const [modelMonitorBusy, setModelMonitorBusy] = useState(false);
  const [agentOperations, setAgentOperations] = useState<AgentOperationsSnapshot | null>(null);
  const [agentOperationsDays, setAgentOperationsDays] = useState<7 | 30 | 90>(7);
  const [agentOperationsBusy, setAgentOperationsBusy] = useState(false);
  const { availableModels, discoveryBusy: modelDiscoveryBusy, discoveryError: modelDiscoveryError, discoverModels, invalidateDiscovery } = useModelDiscovery({
    fetchJson,
    onModelSuggested: (modelName) => {
      if (modelSettingsScopeRef.current !== modelSettingsScope || !modelSettingsScope.active) return;
      updateModelSettingsEditing(true);
      setAgentSettings((current) => current.model_name.trim() ? current : { ...current, model_name: modelName });
    },
    onNotice: setNoticeMessage
  });
  const [modelCapabilities, setModelCapabilities] = useState<ModelCapabilityReport | null>(null);
  const [modelCapabilitiesBusy, setModelCapabilitiesBusy] = useState(false);
  const [databaseReady, setDatabaseReady] = useState(false);
  const databaseInitializationRef = useRef<Promise<void> | null>(null);
  const routeDataCacheRef = useRef(createRouteDataCache<RouteDataKey>(30_000));
  const modelCatalog = useModelCatalog({
    fetchJson, scope: modelSettingsScope,
    enabled: databaseReady && ((appRoute.section === "chat" && !workspaceLibraryOpen) || (appRoute.section === "settings" && appRoute.page === "model")),
    refreshKey: savedAgentSettings.config_revision
  });
  const currentConversation = conversations.find((item) => item.id === currentConversationId) ?? null;
  const activeModelProfiles = modelCatalog.catalog.profiles.filter(profile => profile.enabled && modelCatalog.catalog.connections.some(connection => connection.id === profile.connection_id && connection.enabled));
  const selectedModelProfile = modelCatalog.catalog.profiles.find(profile => profile.id === currentConversation?.model_profile_id);
  const defaultModelProfile = modelCatalog.catalog.profiles.find(profile => profile.id === (modelCatalog.catalog.effective_execution_profile_id || modelCatalog.catalog.default_profile_id));
  const currentModelName = selectedModelProfile?.model_name || defaultModelProfile?.model_name || capabilities?.active_model_name || (modelSettingsReady ? savedAgentSettings.model_name : "尚未配置");
  const modelProfileUnavailable = Boolean(currentConversation?.model_profile_id && selectedModelProfile && !activeModelProfiles.some(profile => profile.id === currentConversation.model_profile_id));
  const composerServiceConnections = modelCatalog.catalog.service_connection_id ? modelCatalog.catalog.connections.filter(connection => connection.id === modelCatalog.catalog.service_connection_id) : modelCatalog.catalog.connections;
  const composerConnection = composerServiceConnections.find(connection => connection.id === (modelCatalog.catalog.service_connection_id || (selectedModelProfile || defaultModelProfile)?.connection_id) && connection.enabled);
  const composerDiscovery = useComposerModelDiscovery({ fetchJson, scope: modelSettingsScope, connection: composerConnection, connections: composerServiceConnections });
  const composerServiceCatalogs = composerDiscovery.catalogs.map(service => ({ ...service, models: service.models.filter(name => !modelCatalog.catalog.profiles.some(profile => profile.connection_id === service.connection_id && profile.model_name === name && !profile.enabled) || activeModelProfiles.some(profile => profile.connection_id === service.connection_id && profile.model_name === name)) }));
  const defaultModelHasDraft = Boolean(agentSettings.api_key.trim()) || agentSettings.model_name !== savedAgentSettings.model_name
    || agentSettings.model_base_url !== savedAgentSettings.model_base_url || agentSettings.model_protocol !== savedAgentSettings.model_protocol;

  useEffect(() => {
    modelSelectionRequestRef.current.id += 1;
    modelSelectionRequestRef.current.controller?.abort();
    setModelSelectionBusy(false);
    setModelSelectionFeedback(null);
    return () => { modelSelectionRequestRef.current.id += 1; modelSelectionRequestRef.current.controller?.abort(); };
  }, [currentConversationId, fetchJson, userEmail]);

  useEffect(() => {
    modelSettingsStateScopeRef.current = null;
    modelSettingsEditingRef.current = false;
    setModelSettingsLoaded(false);
    setModelSettingsLoadError("");
    setModelSaveUnknown(null);
    setAgentSettings({ ...defaultAgentSettings });
    savedAgentSettingsRef.current = { ...defaultAgentSettings };
    setSavedAgentSettings({ ...defaultAgentSettings });
    setAgentSettingsBusy(false);
    setModelSettingsEditing(false);
    setCapabilities(null);
    setModelMonitor(null);
    setModelMonitorBusy(false);
    setModelCapabilities(null);
    setModelCapabilitiesBusy(false);
    invalidateDiscovery();
    routeDataCacheRef.current = createRouteDataCache<RouteDataKey>(30_000);
    return () => {
      for (const controller of modelSettingsScope.controllers) controller.abort();
      modelSettingsScope.controllers.clear();
    };
  }, [modelSettingsScope]);

  function beginModelRequest(kind: ModelRequestKind) {
    const epoch = modelSettingsScope.epoch;
    const requestId = ++modelSettingsScope.requests[kind];
    const controller = new AbortController();
    modelSettingsScope.controllers.add(controller);
    return {
      signal: controller.signal,
      current: () => modelSettingsScope.active && modelSettingsScopeRef.current === modelSettingsScope
        && modelSettingsScope.epoch === epoch && modelSettingsScope.requests[kind] === requestId && !controller.signal.aborted,
      finish: () => modelSettingsScope.controllers.delete(controller)
    };
  }

  function invalidateModelRequests() {
    modelSettingsScope.epoch += 1;
    for (const controller of modelSettingsScope.controllers) controller.abort();
    modelSettingsScope.controllers.clear();
    setModelMonitorBusy(false);
    setModelCapabilitiesBusy(false);
  }

  function canDiscoverModels(settings: AgentSettings) {
    if (modelKeyOptional(settings)) return true;
    if (settings.api_key.trim()) return true;
    return settings.api_key_configured && normalizedModelAddress(settings.model_base_url) === normalizedModelAddress(savedAgentSettings.model_base_url);
  }

  function discoverCurrentModels(force = false) {
    if (!modelSettingsReady || agentSettingsBusy || modelSaveUnknown) return;
    if (!canDiscoverModels(agentSettings)) {
      if (force) setErrorMessage("服务地址已更改，请先填写该服务的 API Key；模型名称也可手动填写。");
      return;
    }
    void discoverModels(agentSettings, { force, silent: !force });
  }

  function navigateRoute(route: AppRoute, replace = false) {
    const nextHash = appRouteHash(route);
    const nextRoute = parseAppHash(nextHash) ?? route;
    setAppRoute(nextRoute);
    if (replace) {
      window.history.replaceState(null, "", nextHash);
    } else if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    }
  }

  function setActiveView(view: ViewKey) {
    navigateRoute(routeForSection(view));
  }

  useEffect(() => {
    const canonicalHash = appRouteHash(initialAppRoute(window.location.hash));
    if (window.location.hash !== canonicalHash) {
      window.history.replaceState(null, "", canonicalHash);
    }
    function syncRoute() {
      if (isProductIntroHash(window.location.hash)) return;
      const next = initialAppRoute(window.location.hash);
      const canonicalHash = appRouteHash(next);
      if (window.location.hash !== canonicalHash) {
        window.history.replaceState(null, "", canonicalHash);
      }
      setAppRoute(next);
    }
    window.addEventListener("hashchange", syncRoute);
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);

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
    if (appRoute.section !== "chat" || appRoute.page === "library" || !currentConversationId || !conversations.length) return;
    const requestedConversationId = appRoute.conversationId;
    if (requestedConversationId && conversations.some((item) => item.id === requestedConversationId)) {
      if (requestedConversationId !== currentConversationId) setCurrentConversationId(requestedConversationId);
      return;
    }
    if (requestedConversationId !== currentConversationId) {
      navigateRoute({ section: "chat", conversationId: currentConversationId }, true);
    }
  }, [appRoute, conversations, currentConversationId]);

  useEffect(() => {
    currentConversationIdRef.current = currentConversationId;
  }, [currentConversationId]);

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
  const hiddenMessageCount = Math.max(0, chatMessages.length - visibleMessageCount);
  const visibleChatMessages = chatMessages.slice(-visibleMessageCount);
  const latestAgent = [...chatMessages]
    .reverse()
    .find((message) => message.role === "assistant" && message.payload?.agent)?.payload?.agent;
  const waitingForUser = latestAgent?.status === "waiting_user";

  async function refreshCapabilities() {
    const request = beginModelRequest("serviceCapabilities");
    try {
      const next = await fetchJson<AgentCapabilities>("/agent/capabilities", { signal: request.signal });
      if (request.current()) setCapabilities(next);
      return next;
    } catch (error) {
      if (request.current()) {
        setCapabilities(null);
        setErrorMessage(error instanceof Error ? `无法读取服务能力：${error.message}` : "无法读取服务能力");
      }
      return null;
    } finally { request.finish(); }
  }

  async function refreshAttachmentConfig() {
    const next = await fetchJson<AttachmentConfig>("/attachments/config");
    setAttachmentConfig(next);
  }

  function updateModelSettingsEditing(next: boolean) {
    modelSettingsEditingRef.current = next;
    setModelSettingsEditing(next);
  }

  function applySavedModelSettings(next: AgentSettings, preserveDraft = false) {
    const clean = { ...next, api_key: "" };
    savedAgentSettingsRef.current = clean;
    setSavedAgentSettings(clean);
    modelSettingsStateScopeRef.current = modelSettingsScope;
    setModelSettingsLoaded(true);
    setModelSettingsLoadError("");
    if (preserveDraft || modelSettingsEditingRef.current) return clean;
    setAgentSettings(clean);
    const keyOptional = modelKeyOptional(next);
    updateModelSettingsEditing(!next.api_key_configured && !keyOptional);
    if ((next.api_key_configured || keyOptional) && next.credential_status !== "saved_unverified") void discoverModels(clean, { silent: true });
    return clean;
  }

  async function refreshAgentSettings(options: { preserveDraft?: boolean } = {}) {
    const request = beginModelRequest("read");
    try {
      const next = await fetchJson<AgentSettings>("/agent/settings", { signal: request.signal });
      if (request.current()) applySavedModelSettings(next, options.preserveDraft);
      return next;
    } catch (error) {
      if (!request.current()) return null;
      setModelSettingsLoadError(error instanceof Error ? error.message : "读取模型配置失败");
      throw error;
    } finally { request.finish(); }
  }

  async function refreshModelMonitor() {
    const request = beginModelRequest("monitor");
    try {
      const next = await fetchJson<ModelServiceMonitor>("/agent/model-monitor?hours=24", { signal: request.signal });
      if (request.current() && matchesModelConfiguration(next, savedAgentSettingsRef.current)) setModelMonitor(next);
      return next;
    } catch (error) {
      if (request.current()) throw error;
      return null;
    } finally { request.finish(); }
  }

  async function refreshModelCapabilities(probe = false) {
    const request = beginModelRequest("capabilities");
    setModelCapabilitiesBusy(true);
    try {
      const next = probe
        ? await fetchJson<ModelCapabilityReport>("/agent/models/capabilities", {
          method: "POST", signal: request.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model_name: savedAgentSettings.model_name, model_base_url: savedAgentSettings.model_base_url,
            model_protocol: savedAgentSettings.model_protocol, api_key: "", probe: true
          })
        })
        : await fetchJson<ModelCapabilityReport>("/agent/models/capabilities", { signal: request.signal });
      if (!request.current() || !matchesModelConfiguration(next, savedAgentSettingsRef.current)) return null;
      setModelCapabilities(next);
      if (probe && next.probe_error) setErrorMessage(next.probe_error);
      else if (probe) setNoticeMessage(next.vision.source === "probe" ? "已完成能力检测" : "已读取模型能力");
      return next;
    } catch (error) {
      if (request.current()) setErrorMessage(error instanceof Error ? `模型能力检测失败：${error.message}` : "模型能力检测失败");
      return null;
    } finally {
      if (request.current()) setModelCapabilitiesBusy(false);
      request.finish();
    }
  }

  async function refreshAgentOperations(days = agentOperationsDays, showLoading = true) {
    if (showLoading) setAgentOperationsBusy(true);
    try {
      const next = await fetchJson<AgentOperationsSnapshot>(`/agent/operations?days=${days}&limit=20`);
      setAgentOperations(next);
      return next;
    } finally {
      if (showLoading) setAgentOperationsBusy(false);
    }
  }

  function changeAgentOperationsWindow(days: 7 | 30 | 90) {
    setAgentOperationsDays(days);
    void refreshAgentOperations(days).catch((error: unknown) => {
      setErrorMessage(error instanceof Error ? error.message : "读取 Agent 运行记录失败");
    });
  }

  async function checkModelService(afterSave = false) {
    const request = beginModelRequest("check");
    // An older polling response must not overwrite the active check result.
    modelSettingsScope.requests.monitor += 1;
    setModelMonitorBusy(true);
    if (!afterSave) setErrorMessage("");
    try {
      const next = await fetchJson<ModelServiceCheck>("/agent/model-monitor/check", { method: "POST", signal: request.signal });
      if (!request.current() || !matchesModelConfiguration(next, savedAgentSettingsRef.current)) return;
      modelSettingsScope.requests.monitor += 1;
      setModelMonitor(next);
      if (next.available) {
        setModelUnavailable(null);
        setNoticeMessage(afterSave ? "设置已保存，连接检测成功" : "连接检测成功");
      } else setErrorMessage(`${afterSave ? "配置已保存，但连接检测失败：" : ""}${next.check_error_message || "模型连接检测失败"}`);
    } catch (error) {
      if (request.current()) setErrorMessage(`${afterSave ? "配置已保存，但连接检测失败：" : ""}${error instanceof Error ? error.message : "模型服务检测失败"}`);
    } finally {
      if (request.current()) setModelMonitorBusy(false);
      request.finish();
    }
  }

  function changeModelSettings(next: AgentSettings) {
    if (!modelSettingsReady || agentSettingsBusy || modelSaveUnknown) return;
    if (normalizedModelAddress(next.model_base_url) !== normalizedModelAddress(agentSettings.model_base_url)) next = { ...next, api_key: "" };
    const connectionChanged = next.model_base_url !== agentSettings.model_base_url
      || next.api_key !== agentSettings.api_key || next.model_protocol !== agentSettings.model_protocol;
    if (connectionChanged) invalidateDiscovery();
    else if (next.model_name !== agentSettings.model_name) invalidateDiscovery({ keepModels: true });
    updateModelSettingsEditing(true);
    setAgentSettings(next);
  }

  function beginModelSettingsEdit() {
    if (modelSettingsReady && !agentSettingsBusy && !modelSaveUnknown) updateModelSettingsEditing(true);
  }

  function cancelModelSettingsEdit() {
    setAgentSettings({ ...savedAgentSettings, api_key: "" });
    setModelSaveUnknown(null);
    updateModelSettingsEditing(false);
    invalidateDiscovery();
    if ((savedAgentSettings.api_key_configured || modelKeyOptional(savedAgentSettings)) && savedAgentSettings.credential_status !== "saved_unverified") {
      void discoverModels(savedAgentSettings, { silent: true });
    }
  }

  function completeModelSave(saved: AgentSettings) {
    invalidateModelRequests();
    const clean = { ...saved, api_key: "" };
    setAgentSettings(clean);
    savedAgentSettingsRef.current = clean;
    setSavedAgentSettings(clean);
    modelSettingsStateScopeRef.current = modelSettingsScope;
    setModelSettingsLoaded(true);
    setModelSaveUnknown(null);
    updateModelSettingsEditing(false);
    setAgentSettingsBusy(false);
    setModelMonitor(null);
    setModelCapabilities(null);
    invalidateDiscovery();
    routeDataCacheRef.current.invalidate("agentSettings", "modelMonitor", "modelCapabilities", "capabilities");
    setNoticeMessage("设置已保存，正在检测连接");
    void checkModelService(true);
    void refreshCapabilities();
    void refreshModelCapabilities();
    if (clean.api_key_configured || modelKeyOptional(clean)) {
      void discoverModels(clean, { silent: true, force: true });
    }
  }

  async function reconcileModelSave(requestId: string, request: ReturnType<typeof beginModelRequest>) {
    const current = await fetchJson<AgentSettings>("/agent/settings", { signal: request.signal });
    if (!request.current()) return;
    if (current.last_save_request_id === requestId) {
      completeModelSave(current);
      return;
    }
    const receipt = await fetchJson<ModelSaveReceipt>(`/agent/settings/requests/${encodeURIComponent(requestId)}`, { signal: request.signal });
    if (!request.current()) return;
    if (receipt.committed) {
      const superseded = receipt.saved_revision !== null && (receipt.settings.config_revision ?? 0) > receipt.saved_revision;
      completeModelSave(receipt.settings);
      if (superseded) setErrorMessage("此前保存已提交，当前配置已由后续更新覆盖。当前显示服务端最新配置。");
    } else {
      applySavedModelSettings(receipt.settings, true);
      setErrorMessage("暂无法确认上次保存结果，请稍后重新确认；也可读取最新配置后继续编辑。");
    }
  }

  async function confirmModelSave(requestId = modelSaveUnknown) {
    if (!requestId || agentSettingsBusy) return;
    const request = beginModelRequest("save");
    setAgentSettingsBusy(true);
    try { await reconcileModelSave(requestId, request); }
    catch {
      if (request.current()) setErrorMessage("暂无法确认上次保存结果，请检查连接后重新确认。");
    } finally {
      if (request.current()) setAgentSettingsBusy(false);
      request.finish();
    }
  }

  async function resumeModelEditing() {
    if (!modelSaveUnknown || agentSettingsBusy) return;
    const request = beginModelRequest("save");
    setAgentSettingsBusy(true);
    try {
      const latest = await fetchJson<AgentSettings>("/agent/settings", { signal: request.signal });
      if (!request.current()) return;
      applySavedModelSettings(latest, true);
      setModelSaveUnknown(null);
      updateModelSettingsEditing(true);
      invalidateDiscovery();
      setErrorMessage("");
      setNoticeMessage("已读取最新配置，可以继续编辑；再次保存会检查版本冲突，上次提交仍可能稍后完成。");
    } catch {
      if (request.current()) setErrorMessage("读取最新配置失败，暂时保留待确认状态。");
    } finally {
      if (request.current()) setAgentSettingsBusy(false);
      request.finish();
    }
  }

  async function saveAgentPreferences() {
    if (!modelSettingsReady || agentSettingsBusy || modelSaveUnknown || !agentSettings.model_name.trim()) return;
    if (!canDiscoverModels(agentSettings) && normalizedModelAddress(agentSettings.model_base_url) !== normalizedModelAddress(savedAgentSettings.model_base_url)) {
      setErrorMessage("服务地址已更改，请填写该服务的 API Key 后再保存。");
      return;
    }
    if (agentSettings.api_key.trim() && savedAgentSettings.secret_storage_writable === false) {
      setErrorMessage(savedAgentSettings.secret_storage === "environment"
        ? "当前部署使用只读环境密钥，请由服务部署配置更新凭证。"
        : "本机密钥存储暂不可写，请修复系统钥匙串后再保存密钥。");
      return;
    }
    invalidateModelRequests();
    invalidateDiscovery();
    const request = beginModelRequest("save");
    const requestId = crypto.randomUUID();
    setAgentSettingsBusy(true);
    setErrorMessage("");
    try {
      const saved = await fetchJson<AgentSettings>("/agent/settings", {
        method: "PUT", signal: request.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...savedAgentSettings, model_name: agentSettings.model_name, model_base_url: agentSettings.model_base_url,
          model_protocol: agentSettings.model_protocol, api_key: agentSettings.api_key,
          expected_revision: savedAgentSettings.config_revision, request_id: requestId
        })
      });
      if (request.current()) completeModelSave(saved);
    } catch (error) {
      if (!request.current()) return;
      const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : null;
      if (status === 409) {
        setErrorMessage("配置已在其他页面更新。已读取最新版本，当前修改保留，请检查后重新保存。");
        await refreshAgentSettings({ preserveDraft: true }).catch(() => undefined);
      } else if (status === null || status >= 500 || status === 408) {
        setModelSaveUnknown(requestId);
        setErrorMessage("保存结果暂未确认，正在读取服务端状态；不会自动重复提交。");
        try { await reconcileModelSave(requestId, request); }
        catch { /* Keep the request receipt pending until the user can reconnect. */ }
      } else setErrorMessage(error instanceof Error ? error.message : "保存模型设置失败");
    } finally {
      if (request.current()) setAgentSettingsBusy(false);
      request.finish();
    }
  }

  async function selectConversationModel(profileId: string | null, serviceModel?: { connectionId: string; modelName: string; revision: number }) {
    const conversationId = currentConversationId;
    if (!conversationId || chatBusy || modelSelectionBusy) return;
    if (modelCatalog.busy || (profileId && !activeModelProfiles.some(profile => profile.id === profileId))) return;
    modelSelectionRequestRef.current.controller?.abort();
    const requestId = ++modelSelectionRequestRef.current.id;
    const controller = new AbortController();
    modelSelectionRequestRef.current.controller = controller;
    const current = () => !controller.signal.aborted && modelSelectionRequestRef.current.id === requestId
      && modelSettingsScopeRef.current === modelSettingsScope && currentConversationIdRef.current === conversationId;
    setModelSelectionBusy(true);
    setModelSelectionFeedback(null);
    const targetName = serviceModel?.modelName || activeModelProfiles.find(profile => profile.id === profileId)?.model_name || defaultModelProfile?.model_name || "默认模型";
    try {
      if (serviceModel) {
        profileId = await modelCatalog.ensureProfile(serviceModel.connectionId, serviceModel.modelName, serviceModel.revision);
        if (!current()) return;
        if (!profileId) throw new Error("模型未确认保存，继续使用原模型；请重新打开列表或检查模型设置。");
      }
      const updated = await fetchJson<Conversation>(`/conversations/${conversationId}`, {
        method: "PATCH", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model_profile_id: profileId })
      });
      if (!current()) return;
      invalidateConversationReads?.();
      setConversations(items => items.map(item => item.id === conversationId ? { ...item, ...updated, model_profile_id: profileId } : item));
      setModelUnavailable(null);
      setModelSelectionFeedback({ kind: "success", text: `已切换至 ${targetName}。新任务生效，待确认任务仍使用原模型。` });
    } catch (reason) {
      if (current()) setModelSelectionFeedback({ kind: "error", text: `未能确认切换至 ${targetName}。${reason instanceof Error ? reason.message : "请重试或刷新会话。"}` });
    } finally { if (current()) setModelSelectionBusy(false); }
  }

  async function refreshDefaultModelSelection() {
    invalidateModelRequests();
    invalidateDiscovery();
    updateModelSettingsEditing(false);
    setModelSettingsLoaded(false);
    setModelMonitor(null);
    setModelCapabilities(null);
    routeDataCacheRef.current.invalidate("agentSettings", "modelMonitor", "modelCapabilities", "capabilities");
    try { await refreshAgentSettings(); }
    catch { setErrorMessage("默认模型已更新，但读取最新配置失败，请重新读取配置。"); return; }
    void refreshModelMonitor().catch(() => undefined);
    void refreshModelCapabilities();
    void refreshCapabilities();
  }

  async function saveComposerModelParameters(profileId: string, revision: number, update: ModelParameterUpdate) {
    if (chatBusy || modelSelectionBusy || modelCatalog.busy) return false;
    const saved = await modelCatalog.mutate(`/agent/model-profiles/${encodeURIComponent(profileId)}`, "PATCH", { ...update, expected_revision: revision });
    if (saved) setNoticeMessage("思考设置已保存，使用此模型的所有对话从后续请求生效。");
    return saved;
  }

  async function resetCurrentContext() {
    if (!currentConversationId || !window.confirm("从当前位置开始新的上下文吗？\n\n历史消息仍然可见，但 Agent 后续不会再读取此前对话。资料库内容会保留。")) return;
    setAgentSettingsBusy(true);
    setErrorMessage("");
    try {
      await fetchJson(`/conversations/${currentConversationId}/context/reset`, { method: "POST" });
      await refreshConversations();
      setNoticeMessage("已重置上下文");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "重置上下文失败");
    } finally {
      setAgentSettingsBusy(false);
    }
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
      agentOperations: () => refreshAgentOperations(7, false),
      agentSettings: refreshAgentSettings,
      library: refreshLibrary,
      capabilities: refreshCapabilities,
      conversations: async () => {
        const next = await refreshConversations();
        setCurrentConversationId((current) => current ?? next.find((item) => item.status === "active")?.id ?? next[0]?.id ?? null);
      },
      modelMonitor: refreshModelMonitor,
      modelCapabilities: () => refreshModelCapabilities(false),
    };
    void Promise.all(requiredDataForRoute(appRoute).map((key) => (
      routeDataCacheRef.current.load(key, loaders[key])
    ))).catch((error: unknown) => {
      setErrorMessage(error instanceof Error ? error.message : "读取页面数据失败");
    });
  }, [appRoute, databaseReady, fetchJson, userEmail]);

  useAsyncPolling({
    enabled: databaseReady && appRoute.section === "settings" && ["model", "agent"].includes(appRoute.page),
    intervalMs: 15_000,
    poll: () => appRoute.section === "settings" && appRoute.page === "model"
      ? refreshModelMonitor()
      : refreshAgentOperations(agentOperationsDays, false),
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
      appearance: { title: "外观", description: "统一设置所有模块的主题" },
      account: { title: "账号与安全", description: "管理跟随登录账号的昵称、头像和密码" },
      library: { title: "文件库管理", description: "整理文件、阅读原件，选取资料用于对话" },
      model: { title: "模型设置", description: "填写服务地址、API Key，选择使用的模型" },
      agent: { title: "Agent 执行记录", description: "查看 Agent 已完成的任务、工具使用和异常原因" }
    }[appRoute.page]
    : pageMeta[appRoute.section];

  const documentPageTitle = workspaceLibraryOpen ? "文件库｜AI 工作区" : appRoute.section === "chat"
    ? currentConversation?.title || "新对话"
    : routePageMeta.title;
  const topbarTitle = appTopBarShowsTitle(appRoute) ? documentPageTitle : undefined;
  const topbarSection = topbarTitle ? topbarSectionForPage(appRoute.section, topbarTitle) : undefined;

  useEffect(() => {
    document.title = `${documentPageTitle}｜团团`;
  }, [documentPageTitle]);

  const identityMenu = (
    <AppIdentityMenu
      userEmail={userEmail}
      accountName={user.display_name}
      avatarUrl={avatarUrl}
      activeView={activeView}
      settingsPage={appRoute.section === "settings" ? appRoute.page : undefined}
      onOpenAccount={() => navigateRoute({ section: "settings", page: "account" })}
      onOpenSettings={() => navigateRoute({ section: "settings", page: "overview" })}
      onLogout={onLogout}
      onPrefetchPage={(page) => void pagePrefetcher.prefetch(page)}
    />
  );

  function selectProductNav(key: ProductNavKey) {
    if (key === "dashboard") navigateRoute({ section: "dashboard" });
    else if (key === "chat") navigateRoute({ section: "chat", conversationId: currentConversationId ?? undefined });
    else if (key === "library") navigateRoute({ section: "chat", page: "library" });
  }

  async function useLibraryForChat(sourceIds: number[]) {
    const result = await fetchJson<{ conversation: Conversation; attachments: ChatAttachment[] }>("/library/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source_ids: sourceIds }) });
    await refreshConversations();
    setLibraryAttachments({ conversationId: result.conversation.id, attachments: result.attachments });
    setCurrentConversationId(result.conversation.id);
    navigateRoute({ section: "chat", conversationId: result.conversation.id });
    setNoticeMessage(`${result.attachments.length} 个文件已加入新对话，输入问题后发送`);
  }

  async function analyzeHomeItem(item: HomeReadableItem) {
    if (homeAnalysisBusyRef.current || conversationBusy || chatBusy) {
      throw new Error("请等待当前对话操作完成后再创建资讯分析");
    }
    homeAnalysisBusyRef.current = true;
    const controller = new AbortController();
    homeAnalysisControllerRef.current = controller;
    setConversationBusy(true);
    try {
      const created = await createHomeAnalysisConversation(fetchJson, item, controller.signal);
      if (controller.signal.aborted || homeAnalysisControllerRef.current !== controller) return;
      setConversations(current => [created, ...current.filter(conversation => conversation.id !== created.id)]);
      setChatMessages([]);
      setHomeComposerDraft({
        id: `home-${created.id}`,
        conversationId: created.id,
        content: homeAnalysisDraft(item)
      });
      setCurrentConversationId(created.id);
      navigateRoute({ section: "chat", conversationId: created.id });
      setNoticeMessage("资讯分析草稿已准备，编辑后发送");
    } finally {
      if (homeAnalysisControllerRef.current === controller) {
        homeAnalysisControllerRef.current = null;
        homeAnalysisBusyRef.current = false;
        setConversationBusy(false);
      }
    }
  }

  const libraryModule = (
    <Suspense fallback={<PageLoading label="正在加载文件库…" />}>
      <LibraryPage
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
      />

      <section className={`content${activeView === "chat" ? " chat-content is-chat-focus" : ""}${activeView === "dashboard" ? " home-content" : ""}${appRoute.section === "settings" && appRoute.page === "library" ? " library-content" : ""}${topbarTitle ? "" : " is-titleless"}`}>
        {activeView !== "dashboard" ? <AppTopBar
          section={topbarSection}
          title={topbarTitle}
        /> : null}

        {activeView === "dashboard" ? (
          <Suspense fallback={<PageLoading label="正在加载首页…" />}>
            <HomePage
              key={userEmail}
              fetchJson={fetchJson}
              accountName={user.display_name?.trim() || userEmail.split("@")[0]}
              accountKey={userEmail}
              onAnalyze={analyzeHomeItem}
              onLibraryChanged={refreshLibrary}
            />
          </Suspense>
        ) : null}

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
                  accountEmail={user.email}
                  accountName={user.display_name}
                  modelName={savedAgentSettings.model_name}
                  apiKeyConfigured={savedAgentSettings.api_key_configured}
                  onOpen={(page) => navigateRoute({ section: "settings", page })}
                />
              ) : null}
              {appRoute.page === "appearance" ? <AppearanceSettingsPage /> : null}
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
              {appRoute.page === "library" ? libraryModule : null}
              {appRoute.page === "model" ? (
                modelSettingsReady ? (
                  <ModelSettingsPage
                    fetchJson={fetchJson}
                    error={errorMessage}
                    purposeManager={modelCatalog.catalog.purpose_defaults ? <ModelUsageRules catalog={modelCatalog.catalog} busy={modelCatalog.busy || agentSettingsBusy} loading={modelCatalog.loading} onMutate={modelCatalog.mutate} onApplied={refreshDefaultModelSelection} /> : modelCatalog.loading ? <p role="status">正在读取使用规则…</p> : undefined}
                    routingManager={<><ModelFallbackSettings fetchJson={fetchJson} catalog={modelCatalog.catalog} busy={modelCatalog.busy || agentSettingsBusy} /><ModelRoutingPanel key={userEmail} fetchJson={fetchJson} catalog={modelCatalog.catalog}
                      disabled={agentSettingsBusy || modelCatalog.busy || Boolean(modelSaveUnknown)}
                      onApplied={async () => { await modelCatalog.reload(); await refreshDefaultModelSelection(); }} /></>}
                    connectionManager={<ModelConnectionManager
                      singleService
                      fetchJson={fetchJson} catalog={modelCatalog.catalog} loading={modelCatalog.loading}
                      busy={modelCatalog.busy || agentSettingsBusy} error={modelCatalog.error}
                      secretWritable={savedAgentSettings.secret_storage_writable}
                      defaultLocked={defaultModelHasDraft || Boolean(modelSaveUnknown)}
                      onReload={modelCatalog.reload} onMutate={modelCatalog.mutate} onEnsureProfile={modelCatalog.ensureProfile}
                      onDefaultChanged={refreshDefaultModelSelection}
                    />}
                    settings={agentSettings}
                    savedSettings={savedAgentSettings}
                    editing={modelSettingsEditing}
                    busy={agentSettingsBusy || modelCatalog.busy}
                    saveUnknown={Boolean(modelSaveUnknown)}
                    onConfirmSave={() => void confirmModelSave()}
                    onResumeEditing={() => void resumeModelEditing()}
                    monitor={modelMonitor}
                    monitorBusy={modelMonitorBusy}
                    availableModels={availableModels}
                    discoveryBusy={modelDiscoveryBusy}
                    discoveryError={modelDiscoveryError}
                    capabilities={modelCapabilities}
                    capabilitiesBusy={modelCapabilitiesBusy}
                    onSettingsChange={changeModelSettings}
                    onDiscoverModels={discoverCurrentModels}
                    onCheckService={() => void checkModelService()}
                    onProbeCapabilities={() => void refreshModelCapabilities(true)}
                    onBeginEdit={beginModelSettingsEdit}
                    onCancelEdit={cancelModelSettingsEdit}
                    onSave={() => void saveAgentPreferences()}
                  />
                ) : modelSettingsLoadError ? (
                  <section className="settings-card model-settings-card" role="alert">
                    <h3>无法读取模型配置</h3><p>请检查本地服务后重试。读取成功前不会提交默认配置。</p>
                    <button type="button" onClick={() => {
                      setModelSettingsLoadError("");
                      routeDataCacheRef.current.invalidate("agentSettings");
                      void refreshAgentSettings().catch(() => undefined);
                    }}>重新读取</button>
                  </section>
                ) : <PageLoading label="正在读取模型配置…" />
              ) : null}
              {appRoute.page === "agent" ? (
                <Suspense fallback={<PageLoading label="正在加载 Agent 运行记录…" />}>
                  <AgentOperationsDashboard
                    snapshot={agentOperations}
                    days={agentOperationsDays}
                    loading={agentOperationsBusy}
                    onDaysChange={changeAgentOperationsWindow}
                  />
                </Suspense>
              ) : null}
            </SettingsWorkspace>
          </Suspense>
        ) : null}

      </section>

      <AssistantSurface page={activeView === "chat"} open={assistantOpen} busy={chatBusy} onClose={() => setAssistantOpen(false)} onExpand={() => { setAssistantOpen(false); navigateRoute({ section: "chat", conversationId: currentConversationId ?? undefined }); }}>

        <AIWorkspaceModules active={activeView === "chat"} libraryOpen={workspaceLibraryOpen}
          library={libraryModule}>
        <Suspense fallback={<PageLoading label="正在加载对话…" />}>
          <ChatWorkspace
            density={activeView === "chat" ? "page" : "dock"}
            focused={activeView === "chat" && !workspaceLibraryOpen}
            conversationTitle={currentConversation?.title}
            currentModelName={currentModelName}
            defaultModelName={defaultModelProfile?.model_name || capabilities?.active_model_name}
            modelProfiles={activeModelProfiles.map(profile => ({ id: profile.id, model_name: profile.model_name, connection_id: profile.connection_id, capabilities: profile.capabilities, connection_name: modelCatalog.catalog.connections.find(connection => connection.id === profile.connection_id)?.name || "模型连接" }))}
            serviceModels={composerServiceCatalogs.find(service => service.connection_id === composerConnection?.id)}
            additionalServiceModels={composerServiceCatalogs.filter(service => service.connection_id !== composerConnection?.id)}
            onDiscoverServiceModels={composerDiscovery.discover}
            onServiceModelChange={async (modelName, connectionId) => { const connection = modelCatalog.catalog.connections.find(item => item.id === (connectionId ?? composerConnection?.id) && item.enabled); if (connection) await selectConversationModel(null, { connectionId: connection.id, modelName, revision: connection.revision }); else setModelSelectionFeedback({ kind: "error", text: "模型连接不可用，请刷新列表后重试。" }); }}
            selectedModelProfileId={(selectedModelProfile || defaultModelProfile)?.id ?? null}
            modelSettings={(selectedModelProfile || defaultModelProfile) ? {
              profile: (selectedModelProfile || defaultModelProfile)!,
              protocol: composerConnection?.detected_protocol || composerConnection?.model_protocol,
              fetchJson, onSave: saveComposerModelParameters, error: modelCatalog.error
            } : undefined}
            modelSelectionBusy={modelSelectionBusy || modelCatalog.busy}
            modelSelectionFeedback={modelSelectionFeedback}
            onDismissModelSelectionFeedback={() => setModelSelectionFeedback(null)}
            modelProfileUnavailable={modelProfileUnavailable}
            modelConfigured={capabilities ? capabilities.configured !== false : undefined}
            onModelProfileChange={selectConversationModel}
            messages={visibleChatMessages}
            hiddenMessageCount={hiddenMessageCount}
            chatBusy={chatBusy}
            modelUnavailable={modelUnavailable}
            sendError={sendError}
            onOpenModelSettings={() => navigateRoute({ section: "settings", page: "model" })}
            currentConversationId={currentConversationId}
            libraryAttachments={libraryAttachments}
            onLibraryAttachmentsConsumed={() => setLibraryAttachments(null)}
            composerDraft={homeComposerDraft}
            composerDrafts={composerDrafts}
            onComposerDraftConsumed={() => setHomeComposerDraft(null)}
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
            onSelectConversation={(conversationId) => {
              setCurrentConversationId(conversationId);
              navigateRoute({ section: "chat", conversationId });
            }}
            onCreateConversation={() => void createNewConversation()}
            onRenameConversation={(conversation) => setConversationDialog({ kind: "rename", conversation })}
            onArchiveConversation={(conversation) => void archiveConversation(conversation)}
            onRemoveConversation={(conversation) => setConversationDialog({ kind: "delete", conversation })}
            attachmentBusy={chatAttachmentBusy}
            attachmentConfig={attachmentConfig}
            onUploadAttachment={uploadChatAttachment}
            voiceInput={voiceInput}
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
            onRetry={(draft) => sendChatMessage(
              draft.content,
              draft.attachmentIds,
              draft.visionAttachmentIds,
              draft.webSearch,
              draft.webSearchTopic,
              draft.webSearchSourcePreference,
              undefined,
              draft.runId,
              draft.rewindMessageId,
              draft.modelProfileId,
              draft.webSearchProvider
            )}
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
  );
}
