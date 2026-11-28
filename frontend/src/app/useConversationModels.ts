import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { createApiClient } from "../api/client";
import type { ModelParameterUpdate } from "../features/chat/ComposerModelParameters";
import { useComposerModelDiscovery } from "../features/chat/useComposerModelDiscovery";
import type { useModelCatalog } from "../features/settings/useModelCatalog";
import type { AgentCapabilities, Conversation } from "../types";
import { composerCatalogsWithSavedModels } from "./composer-catalogs";
import { composerDefaultModelProfile, composerModelSources, isComposerModelConnectionAvailable } from "./model-sources";

type Options = {
  fetchJson: ReturnType<typeof createApiClient>;
  scope: unknown;
  conversation: Conversation | null;
  currentConversationId: number | null;
  currentConversationIdRef: RefObject<number | null>;
  modelCatalog: ReturnType<typeof useModelCatalog>;
  capabilities: AgentCapabilities | null;
  savedModelName: string;
  chatBusy: boolean;
  draftSelection?: { profileId: string | null; onChange: (profileId: string | null) => void };
  invalidateConversationReads: () => void;
  setConversations: Dispatch<SetStateAction<Conversation[]>>;
  setModelUnavailable: (message: string | null) => void;
  setNoticeMessage: (message: string) => void;
};

/**
 * 为当前会话提供模型目录、选择状态及模型参数保存操作。
 * @param options 当前账号范围、会话状态、模型目录及更新回调。
 * @returns 聊天输入区可用的模型及管理操作。
 */
export function useConversationModels({ fetchJson, scope, conversation, currentConversationId, currentConversationIdRef, modelCatalog, capabilities, savedModelName, chatBusy, draftSelection, invalidateConversationReads, setConversations, setModelUnavailable, setNoticeMessage }: Options) {
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const draftMode = draftSelection !== undefined;
  const draftModeRef = useRef(draftMode);
  draftModeRef.current = draftMode;
  const [modelSelectionBusy, setModelSelectionBusy] = useState(false);
  const [modelSelectionFeedback, setModelSelectionFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const modelSelectionRequestRef = useRef<{ id: number; controller: AbortController | null }>({ id: 0, controller: null });
  const activeModelProfiles = modelCatalog.catalog.profiles.filter(profile => profile.enabled && modelCatalog.catalog.connections.some(connection => connection.id === profile.connection_id && isComposerModelConnectionAvailable(connection)));
  const selectedModelProfileId = draftSelection ? draftSelection.profileId : conversation?.model_profile_id;
  const selectedModelProfile = modelCatalog.catalog.profiles.find(profile => profile.id === selectedModelProfileId);
  const defaultModelProfile = composerDefaultModelProfile(modelCatalog.catalog);
  const currentPickerProfile = selectedModelProfile || defaultModelProfile;
  const currentProfileConnection = modelCatalog.catalog.connections.find(connection => connection.id === currentPickerProfile?.connection_id);
  const currentSubscriptionProfile = currentProfileConnection?.auth_kind === "chatgpt_subscription" ? currentPickerProfile : undefined;
  const subscriptionModelReady = currentSubscriptionProfile ? activeModelProfiles.some(profile => profile.id === currentSubscriptionProfile.id) : undefined;
  const currentModelName = currentPickerProfile?.model_name || capabilities?.active_model_name || savedModelName;
  const modelProfileUnavailable = subscriptionModelReady === false || Boolean(selectedModelProfile && !activeModelProfiles.some(profile => profile.id === selectedModelProfile.id))
    || Boolean(draftSelection?.profileId && modelCatalog.loaded && !selectedModelProfile);

  const { connections: composerServiceConnections, connection: composerConnection } = composerModelSources(modelCatalog.catalog, selectedModelProfile?.id);
  const composerDiscovery = useComposerModelDiscovery({ fetchJson, scope, connection: composerConnection, connections: composerServiceConnections, restoreCached: true });
  const composerServiceCatalogs = composerCatalogsWithSavedModels(composerDiscovery.catalogs, modelCatalog.catalog.profiles, currentPickerProfile?.id);

  useEffect(() => {
    modelSelectionRequestRef.current.id += 1;
    modelSelectionRequestRef.current.controller?.abort();
    setModelSelectionBusy(false);
    setModelSelectionFeedback(null);
    return () => { modelSelectionRequestRef.current.id += 1; modelSelectionRequestRef.current.controller?.abort(); };
  }, [currentConversationId, scope, draftMode]);

  async function selectConversationModel(profileId: string | null, serviceModel?: { connectionId: string; modelName: string; revision: number }) {
    const conversationId = currentConversationId;
    if ((!conversationId && !draftSelection) || chatBusy || modelSelectionBusy) return;
    if (modelCatalog.busy || (profileId && !activeModelProfiles.some(profile => profile.id === profileId))) return;
    modelSelectionRequestRef.current.controller?.abort();
    const requestId = ++modelSelectionRequestRef.current.id;
    const controller = new AbortController();
    modelSelectionRequestRef.current.controller = controller;
    const current = () => !controller.signal.aborted && modelSelectionRequestRef.current.id === requestId
      && scopeRef.current === scope && draftModeRef.current === draftMode
      && (draftMode || currentConversationIdRef.current === conversationId);
    setModelSelectionBusy(true);
    setModelSelectionFeedback(null);
    const targetName = serviceModel?.modelName || activeModelProfiles.find(profile => profile.id === profileId)?.model_name || defaultModelProfile?.model_name || "默认模型";
    try {
      if (serviceModel) {
        profileId = await modelCatalog.ensureProfile(serviceModel.connectionId, serviceModel.modelName, serviceModel.revision);
        if (!current()) return;
        if (!profileId) throw new Error("模型未确认保存，继续使用原模型；请重新打开列表或检查模型设置。");
      }
      if (draftSelection) {
        if (current()) draftSelection.onChange(profileId);
        return;
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

  async function saveComposerModelParameters(profileId: string, revision: number, update: ModelParameterUpdate) {
    if (chatBusy || modelSelectionBusy || modelCatalog.busy) return false;
    const saved = await modelCatalog.mutate(`/agent/model-profiles/${encodeURIComponent(profileId)}`, "PATCH", { ...update, expected_revision: revision });
    if (saved) setNoticeMessage("思考设置已保存，使用此模型的所有对话从后续请求生效。");
    return saved;
  }

  async function selectServiceModel(modelName: string, connectionId?: string) {
    const connection = composerServiceConnections.find(item => item.id === (connectionId ?? composerConnection?.id));
    if (connection) {
      await selectConversationModel(null, { connectionId: connection.id, modelName, revision: connection.revision });
    } else {
      setModelSelectionFeedback({ kind: "error", text: "模型连接不可用，请刷新列表后重试。" });
    }
  }

  return {
    activeModelProfiles,
    currentModelName,
    defaultModelName: defaultModelProfile?.model_name || capabilities?.active_model_name,
    serviceModels: composerServiceCatalogs.find(service => service.connection_id === composerConnection?.id),
    additionalServiceModels: composerServiceCatalogs.filter(service => service.connection_id !== composerConnection?.id),
    discoverServiceModels: composerDiscovery.discover,
    selectServiceModel,
    selectedModelProfileId: currentPickerProfile?.id ?? null,
    composerModelSettings: currentPickerProfile && !modelProfileUnavailable ? {
      profile: currentPickerProfile,
      protocol: composerConnection?.detected_protocol || composerConnection?.model_protocol,
      fetchJson,
      onSave: saveComposerModelParameters,
      error: modelCatalog.error
    } : undefined,
    modelSelectionBusy: modelSelectionBusy || modelCatalog.busy,
    modelSelectionFeedback,
    dismissModelSelectionFeedback: () => setModelSelectionFeedback(null),
    modelProfileUnavailable,
    selectConversationModel
  };
}
