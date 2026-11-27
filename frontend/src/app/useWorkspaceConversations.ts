import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readConversationFolders, readIdList, readStringMap, writeConversationFolders, writeIdList, writeStringMap, type ConversationFolder } from "../features/chat/localChatPreferences";
import { useConversations } from "../features/chat/useConversations";
import type { Conversation } from "../types";
import type { useAppRoute } from "./useAppRoute";

type Options = Parameters<typeof useConversations>[0]
  & Pick<ReturnType<typeof useAppRoute>, "appRoute" | "navigateRoute">
  & { userEmail: string };

function preferenceKey(base: string, email: string) {
  return `${base}:${email}`;
}

/**
 * 将会话列表及本地偏好连接到应用的会话路由。
 * @param options 会话 API、账号、路由和反馈回调。
 * @returns 会话状态、页面选择操作和账号级的本地偏好。
 */
export function useWorkspaceConversations({ appRoute, navigateRoute, userEmail, ...options }: Options) {
  const conversationState = useConversations(options);
  const { currentConversationId, setCurrentConversationId, conversations, createNewConversation, refreshConversations } = conversationState;
  const currentConversationIdRef = useRef<number | null>(null);
  const currentConversation = conversations.find((item) => item.id === currentConversationId) ?? null;

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

  function selectConversation(conversationId: number) {
    setCurrentConversationId(conversationId);
    navigateRoute({ section: "chat", conversationId });
  }

  async function loadInitialConversations() {
    const next = await refreshConversations();
    setCurrentConversationId((current) => current ?? next.find((item) => item.status === "active")?.id ?? next[0]?.id ?? null);
  }

  async function ensurePresentationConversation() {
    if (currentConversationIdRef.current) return currentConversationIdRef.current;
    const created = await createNewConversation({ onlyIfUnchanged: true });
    if (!created) throw new Error("会话创建失败，请重试。");
    return created.id;
  }

  async function openAgentRunConversation(conversationId: number, signal: AbortSignal) {
    const origin = window.location.hash;
    const latest = await refreshConversations(signal);
    if (signal.aborted || window.location.hash !== origin || !latest.some((item) => item.id === conversationId)) return false;
    selectConversation(conversationId);
    return true;
  }

  return {
    ...conversationState, currentConversationIdRef, currentConversation, selectConversation, loadInitialConversations,
    ensurePresentationConversation, openAgentRunConversation, composerDrafts, persistComposerDrafts, pinnedConversationIds,
    togglePinnedConversation, conversationFolders, conversationFolderAssignments, createConversationFolder, renameConversationFolder,
    removeConversationFolder, assignConversationFolder
  };
}
