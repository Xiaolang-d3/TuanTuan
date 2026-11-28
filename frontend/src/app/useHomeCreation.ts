import { useEffect, useMemo, useRef, useState } from "react";
import type { createApiClient } from "../api/client";
import type { ChatComposerDraft } from "../features/chat/types";
import { MAX_CREATION_DRAFT_LENGTH } from "../features/home/CreationEntry";
import type { HomeReadableItem } from "../features/home/types";
import { createHomeAnalysisConversation, homeAnalysisDraft } from "../features/home/analysis-draft";
import { readStorageItem, writeStorageItem } from "../storage";
import type { Conversation } from "../types";
import type { useAppRoute } from "./useAppRoute";
import type { useWorkspaceConversations } from "./useWorkspaceConversations";

type CreationForm = {
  scope: string;
  draft: string;
  webSearch: boolean;
  modelProfileId: string | null;
};

function restoreHomeConversations(scope: string): number[] {
  try {
    const ids: unknown = JSON.parse(readStorageItem(`tuantuan-home-conversations:${scope}`, "sessionStorage") ?? "[]");
    return Array.isArray(ids) ? ids.filter((id): id is number => Number.isSafeInteger(id) && id > 0).slice(-100) : [];
  } catch { return []; }
}

type ConversationHandoff = {
  skillId?: string;
  ownerSignal?: AbortSignal;
  files?: File[];
  autoSend?: boolean;
  webSearch?: boolean;
  fromHome?: boolean;
  modelProfileId?: string | null;
  onOpened?: () => void;
};

function restoreCreationForm(scope: string): CreationForm {
  const form: CreationForm = { scope, draft: "", webSearch: false, modelProfileId: null };
  try {
    const saved = JSON.parse(readStorageItem(`tuantuan-home-draft:${scope}`, "sessionStorage") ?? "null");
    // 兼容旧版按“对话/图片”分开保存的草稿：取上次所在模式的内容。
    const legacy = saved?.drafts?.[saved?.mode === "chat" ? "chat" : "images"] || saved?.drafts?.chat || saved?.drafts?.images;
    const draft = typeof saved?.draft === "string" ? saved.draft : legacy;
    if (typeof draft === "string") form.draft = draft.slice(0, MAX_CREATION_DRAFT_LENGTH);
    form.webSearch = saved?.webSearch === true;
    if (typeof saved?.modelProfileId === "string" && saved.modelProfileId.length <= 120) form.modelProfileId = saved.modelProfileId || null;
  } catch { /* Invalid saved drafts are ignored. */ }
  return form;
}

type Options = Pick<ReturnType<typeof useWorkspaceConversations>,
  "currentConversationId" | "conversationBusy" | "setConversationBusy" | "invalidateConversationReads" | "setConversations" | "selectConversation">
  & Pick<ReturnType<typeof useAppRoute>, "navigateRoute">
  & {
    fetchJson: ReturnType<typeof createApiClient>;
    userEmail: string;
    creationScope: string;
    databaseReady: boolean;
    chatBusy: boolean;
    webSearchAvailable: boolean;
    selectNewConversationWebSearch: (conversationId: number, enabled: boolean) => void;
    clearChatMessages: () => void;
    selectNewConversationSkill: (conversationId: number, skillId: string) => void;
    setErrorMessage: (message: string) => void;
    setNoticeMessage: (message: string) => void;
  };

/**
 * 管理账号级创作草稿、附件交接以及首页、项目或技能发起的会话。
 * @param options 页面就绪状态、当前会话和创建后的交接回调。
 * @returns 创作表单、待交接草稿及其页面操作。
 */
export function useHomeCreation({
  fetchJson, userEmail, creationScope, databaseReady, chatBusy, clearChatMessages, selectNewConversationSkill,
  webSearchAvailable, selectNewConversationWebSearch,
  setErrorMessage, setNoticeMessage, currentConversationId, conversationBusy, setConversationBusy,
  invalidateConversationReads, setConversations, selectConversation
}: Options) {
  const [creationForm, setCreationForm] = useState(() => restoreCreationForm(creationScope));
  const [homeConversations, setHomeConversations] = useState(() => ({ scope: creationScope, ids: restoreHomeConversations(creationScope) }));
  const homeConversationIds = useMemo(() => homeConversations.scope === creationScope ? homeConversations.ids : restoreHomeConversations(creationScope), [homeConversations, creationScope]);
  useEffect(() => {
    writeStorageItem(`tuantuan-home-conversations:${creationScope}`, JSON.stringify(homeConversationIds), "sessionStorage");
  }, [creationScope, homeConversationIds]);
  const activeCreationForm = useMemo(() => creationForm.scope === creationScope ? creationForm : restoreCreationForm(creationScope), [creationForm, creationScope]);
  const savedCreationDraft = activeCreationForm.draft;
  const savedWebSearch = activeCreationForm.webSearch;
  const savedModelProfileId = activeCreationForm.modelProfileId;
  useEffect(() => {
    writeStorageItem(`tuantuan-home-draft:${creationScope}`, JSON.stringify({ draft: savedCreationDraft, webSearch: savedWebSearch, modelProfileId: savedModelProfileId }), "sessionStorage");
  }, [creationScope, savedCreationDraft, savedWebSearch, savedModelProfileId]);
  const [homeComposerDraft, setHomeComposerDraft] = useState<(ChatComposerDraft & { scope: string; autoSend?: boolean; webSearch?: boolean }) | null>(null);
  const [homeFiles, setHomeFiles] = useState<{ scope: string; files: File[] } | null>(null);
  const [conversationFiles, setConversationFiles] = useState<{ scope: string; drafts: Map<number, File[]> } | null>(null);
  const activeHomeFiles = homeFiles?.scope === creationScope ? homeFiles.files : [];
  const activeConversationFiles = conversationFiles?.scope === creationScope ? conversationFiles.drafts.get(currentConversationId ?? 0) : undefined;
  useEffect(() => {
    setHomeFiles(previous => previous?.scope === creationScope ? previous : null);
    setConversationFiles(previous => previous?.scope === creationScope ? previous : null);
  }, [creationScope]);

  function updateCreationForm(update: (form: CreationForm) => CreationForm) {
    setCreationForm(previous => update(previous.scope === creationScope ? previous : activeCreationForm));
  }

  function clearCreationDraft(sent: string) {
    updateCreationForm(form => form.draft === sent ? { ...form, draft: "" } : form);
  }

  function setConversationDraftFiles(conversationId: number, files: File[]) {
    setConversationFiles(previous => {
      const drafts = new Map(previous?.scope === creationScope ? previous.drafts : undefined);
      if (files.length) drafts.set(conversationId, files);
      else drafts.delete(conversationId);
      return { scope: creationScope, drafts };
    });
  }
  const openingConversationRef = useRef(false);
  const openingControllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    openingControllerRef.current?.abort();
    openingControllerRef.current = null;
    openingConversationRef.current = false;
    setConversationBusy(false);
  }, [fetchJson, userEmail, setConversationBusy]);

  async function openHomeConversation(create: (signal: AbortSignal) => Promise<Conversation>, content: string, notice: string, { skillId, ownerSignal, files, autoSend, webSearch, fromHome, onOpened }: ConversationHandoff = {}) {
    if (ownerSignal?.aborted) return;
    if (openingConversationRef.current || conversationBusy || chatBusy) {
      throw new Error("请等待当前对话操作完成后再打开新的工作区");
    }
    openingConversationRef.current = true;
    const controller = new AbortController();
    const routeAtClick = window.location.hash;
    openingControllerRef.current = controller;
    const release = () => {
      if (openingControllerRef.current !== controller) return;
      openingControllerRef.current = null;
      openingConversationRef.current = false;
      setConversationBusy(false);
    };
    const cancel = () => { controller.abort(); release(); };
    ownerSignal?.addEventListener("abort", cancel, { once: true });
    setConversationBusy(true);
    try {
      const created = await create(controller.signal);
      if (controller.signal.aborted || openingControllerRef.current !== controller) return;
      invalidateConversationReads();
      setConversations(current => [created, ...current.filter(conversation => conversation.id !== created.id)]);
      if (window.location.hash !== routeAtClick) return;
      clearChatMessages();
      setHomeComposerDraft(content.trim() ? {
        scope: creationScope,
        id: `home-${created.id}`,
        conversationId: created.id,
        content,
        // 工作台直接发送：会话打开后由 App 在消息加载完成时发出，而不是填入输入框。
        autoSend: Boolean(autoSend && !files?.length),
        webSearch,
      } : null);
      if (files?.length) {
        setConversationDraftFiles(created.id, files);
        setHomeFiles(previous => previous?.scope === creationScope && previous.files === files ? null : previous);
      }
      if (skillId) selectNewConversationSkill(created.id, skillId);
      if (webSearch !== undefined) selectNewConversationWebSearch(created.id, webSearch);
      if (fromHome) setHomeConversations(previous => ({ scope: creationScope,
        ids: [...(previous.scope === creationScope ? previous.ids : homeConversationIds).filter(id => id !== created.id), created.id].slice(-100),
      }));
      selectConversation(created.id);
      setNoticeMessage(notice);
      onOpened?.();
    } finally {
      ownerSignal?.removeEventListener("abort", cancel);
      release();
    }
  }

  async function analyzeHomeItem(item: HomeReadableItem) {
    await openHomeConversation(signal => createHomeAnalysisConversation(fetchJson, item, signal), homeAnalysisDraft(item), "资讯分析草稿已准备，编辑后发送");
  }

  function openNewChatDraft(content: string, notice: string, skillId?: string, files?: File[], handoff?: Pick<ConversationHandoff, "autoSend" | "webSearch" | "fromHome" | "modelProfileId" | "onOpened">) {
    return openHomeConversation(signal => fetchJson<Conversation>("/conversations", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "新对话",
        ...(handoff?.modelProfileId !== undefined ? { model_profile_id: handoff.modelProfileId } : {}),
      }), signal,
    }), content, notice, { skillId, files, ...handoff });
  }

  /**
   * 工作台发送：对话与生图共用同一入口，统一进入新对话，由团团判断是否生成图片。
   * @param content 输入框内容。
   */
  function openCreationWorkspace(content: string) {
    if (!databaseReady) return;
    // 有附件时仍需在对话中上传后再发送；纯文字直接发送，避免二次确认。
    const sendNow = Boolean(content.trim()) && !activeHomeFiles.length;
    const notice = sendNow ? "" : activeHomeFiles.length ? "对话草稿已准备，编辑后发送" : "已新建对话";
    void openNewChatDraft(content, notice, undefined, activeHomeFiles, {
      autoSend: sendNow,
      fromHome: true,
      modelProfileId: activeCreationForm.modelProfileId ?? undefined,
      webSearch: webSearchAvailable && activeCreationForm.webSearch,
      onOpened: () => { if (sendNow) clearCreationDraft(content); },
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) setErrorMessage(error instanceof Error ? error.message : "打开对话工作区失败");
    });
  }

  return {
    form: activeCreationForm,
    creationComposer: currentConversationId !== null && homeConversationIds.includes(currentConversationId),
    homeFiles: activeHomeFiles,
    setHomeFiles: (files: File[]) => setHomeFiles({ scope: creationScope, files }),
    updateForm: updateCreationForm,
    conversationDraft: homeComposerDraft?.scope === creationScope && !homeComposerDraft.autoSend ? homeComposerDraft : null,
    autoSendDraft: homeComposerDraft?.scope === creationScope && homeComposerDraft.autoSend ? homeComposerDraft : null,
    /** 认领待自动发送的草稿：sent 为 false 时退回为普通草稿，交给输入框编辑。 */
    claimAutoSendDraft: (id: string, sent: boolean) => setHomeComposerDraft(current => current?.id !== id ? current : sent ? null : { ...current, autoSend: false }),
    consumeConversationDraft: () => setHomeComposerDraft(current => current === homeComposerDraft ? null : current),
    conversationDraftFiles: activeConversationFiles,
    setConversationDraftFiles,
    analyzeHomeItem, openHomeConversation, openNewChatDraft, openCreationWorkspace
  };
}
