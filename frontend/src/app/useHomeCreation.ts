import { useEffect, useMemo, useRef, useState } from "react";
import type { createApiClient } from "../api/client";
import type { ChatComposerDraft } from "../features/chat/types";
import { MAX_CREATION_DRAFT_LENGTH, type CreationDrafts, type CreationMode } from "../features/home/CreationEntry";
import type { HomeReadableItem } from "../features/home/types";
import { createHomeAnalysisConversation, homeAnalysisDraft } from "../features/home/analysis-draft";
import type { ImageCreationDraft, ImageDraftSettings } from "../features/product/ImageWorkspacePage";
import { readStorageItem, writeStorageItem } from "../storage";
import type { Conversation } from "../types";
import type { useAppRoute } from "./useAppRoute";
import type { useWorkspaceConversations } from "./useWorkspaceConversations";

type CreationForm = {
  scope: string;
  mode: CreationMode;
  drafts: CreationDrafts;
  imageSettings: ImageDraftSettings;
};

function restoreCreationForm(scope: string): CreationForm {
  const form: CreationForm = { scope, mode: "images", drafts: { chat: "", images: "" }, imageSettings: {} };
  try {
    const saved = JSON.parse(readStorageItem(`tuantuan-home-draft:${scope}`, "sessionStorage") ?? "null");
    if (saved?.mode === "chat") form.mode = "chat";
    for (const mode of ["chat", "images"] as const) {
      const draft = saved?.drafts?.[mode];
      if (typeof draft === "string") form.drafts[mode] = draft.slice(0, MAX_CREATION_DRAFT_LENGTH);
    }
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
  setErrorMessage, setNoticeMessage, navigateRoute, currentConversationId, conversationBusy, setConversationBusy,
  invalidateConversationReads, setConversations, selectConversation
}: Options) {
  const [creationForm, setCreationForm] = useState(() => restoreCreationForm(creationScope));
  const activeCreationForm = useMemo(() => creationForm.scope === creationScope ? creationForm : restoreCreationForm(creationScope), [creationForm, creationScope]);
  const { mode: savedCreationMode, drafts: savedCreationDrafts } = activeCreationForm;
  useEffect(() => {
    writeStorageItem(`tuantuan-home-draft:${creationScope}`, JSON.stringify({ mode: savedCreationMode, drafts: savedCreationDrafts }), "sessionStorage");
  }, [creationScope, savedCreationMode, savedCreationDrafts]);
  const [imageCreationDraft, setImageCreationDraft] = useState<(ImageCreationDraft & { scope: string }) | null>(null);
  const [homeComposerDraft, setHomeComposerDraft] = useState<(ChatComposerDraft & { scope: string }) | null>(null);
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

  async function openHomeConversation(create: (signal: AbortSignal) => Promise<Conversation>, content: string, notice: string, { skillId, ownerSignal, files }: { skillId?: string; ownerSignal?: AbortSignal; files?: File[] } = {}) {
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
      } : null);
      if (files?.length) {
        setConversationDraftFiles(created.id, files);
        setHomeFiles(previous => previous?.scope === creationScope && previous.files === files ? null : previous);
      }
      if (skillId) selectNewConversationSkill(created.id, skillId);
      selectConversation(created.id);
      setNoticeMessage(notice);
    } finally {
      ownerSignal?.removeEventListener("abort", cancel);
      release();
    }
  }

  async function analyzeHomeItem(item: HomeReadableItem) {
    await openHomeConversation(signal => createHomeAnalysisConversation(fetchJson, item, signal), homeAnalysisDraft(item), "资讯分析草稿已准备，编辑后发送");
  }

  function openNewChatDraft(content: string, notice: string, skillId?: string, files?: File[]) {
    return openHomeConversation(signal => fetchJson<Conversation>("/conversations", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "新对话" }), signal,
    }), content, notice, { skillId, files });
  }

  function openCreationWorkspace(mode: CreationMode, content: string, settings?: ImageDraftSettings) {
    if (!databaseReady) return;
    if (mode === "images") {
      const explicitSettings = settings && (settings.profileId !== undefined || settings.size !== undefined) ? settings : undefined;
      if (content.trim() || explicitSettings) {
        setImageCreationDraft({ scope: creationScope, id: crypto.randomUUID(), content, settings: explicitSettings });
      }
      navigateRoute({ section: "images" });
      return;
    }
    void openNewChatDraft(content, content.trim() || activeHomeFiles.length ? "对话草稿已准备，编辑后发送" : "已新建对话", undefined, activeHomeFiles).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) setErrorMessage(error instanceof Error ? error.message : "打开对话工作区失败");
    });
  }

  return {
    form: activeCreationForm,
    homeFiles: activeHomeFiles,
    setHomeFiles: (files: File[]) => setHomeFiles({ scope: creationScope, files }),
    updateForm: updateCreationForm,
    imageDraft: imageCreationDraft?.scope === creationScope ? imageCreationDraft : undefined,
    consumeImageDraft: (id: string) => setImageCreationDraft(current => current?.id === id ? null : current),
    conversationDraft: homeComposerDraft?.scope === creationScope ? homeComposerDraft : null,
    consumeConversationDraft: () => setHomeComposerDraft(current => current === homeComposerDraft ? null : current),
    conversationDraftFiles: activeConversationFiles,
    setConversationDraftFiles,
    analyzeHomeItem, openHomeConversation, openNewChatDraft, openCreationWorkspace
  };
}
