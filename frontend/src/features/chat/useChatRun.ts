import { useEffect, useRef, useState } from "react";
import type { AgentSubscriber, HttpAgent as HttpAgentType } from "@ag-ui/client";
import { createApiClient, fetchWithTimeout } from "../../api/client";
import { createClientId } from "../../api/clientId";
import { interruptedRunRetryDraft, type DurableAgentRunSummary } from "../../durable-agent-run";
import type { AgentRunResult, ChatAttachment, ChatMessage, ChatRetryDraft, WebSearchSourcePreference, WebSearchTopic } from "../../features/chat/types";
import { webSearchOptionsFromMessage, webSearchConfigurationIssue } from "./webSearchOptions";
import type { AgentCapabilities } from "../../types";
import type { RefObject } from "react";

type Options = { apiBase: string; accessToken: string; fetchJson: ReturnType<typeof createApiClient>; currentConversationId: number | null; currentConversationIdRef: RefObject<number | null>; modelProfileId?: string | null; setErrorMessage: (message: string) => void; setNoticeMessage: (message: string) => void; refreshConversations: () => Promise<unknown>; onLibraryChanged: () => Promise<void> };

export function useChatRun({ apiBase, accessToken, fetchJson, currentConversationId, currentConversationIdRef, modelProfileId, setErrorMessage, setNoticeMessage, refreshConversations, onLibraryChanged }: Options) {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  const [chatBusy, setChatBusy] = useState(false);

  const [modelUnavailable, setModelUnavailable] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const [retryChatDraft, setRetryChatDraft] = useState<ChatRetryDraft | null>(null);
  const [replacementUndo, setReplacementUndo] = useState<{ conversationId: number; messages: ChatMessage[]; previousTitle?: string } | null>(null);

  const chatAgentRef = useRef<HttpAgentType | null>(null);

  const [taskCancelBusy, setTaskCancelBusy] = useState(false);

  const [chatAttachmentBusy, setChatAttachmentBusy] = useState(false);
  const sendingRef = useRef(false);
  useEffect(() => { setSendError(null); setReplacementUndo(null); }, [currentConversationId]);

  async function refreshChat(conversationId = currentConversationId) {
    if (!conversationId) return;
    const [messages, durableRunResponse] = await Promise.all([
      fetchJson<ChatMessage[]>(`/chat/messages?conversation_id=${conversationId}`),
      fetchJson<{ run: DurableAgentRunSummary | null }>(`/agent/runs/current?conversation_id=${conversationId}`)
    ]);
    setChatMessages(messages);
    const interruptedDraft = interruptedRunRetryDraft(durableRunResponse.run, messages);
    if (interruptedDraft) {
      setRetryChatDraft(interruptedDraft);
    } else {
      setRetryChatDraft((current) => current?.reason === "interrupted" ? null : current);
    }
    return messages;
  }

  async function uploadChatAttachment(file: File): Promise<ChatAttachment> {
    if (!currentConversationId) throw new Error("请先选择一个对话");
    const filename = file.name.toLowerCase();
    const kind = /\.(png|jpe?g|webp)$/.test(filename) ? "image" : /\.(pdf|docx|txt|md)$/.test(filename) ? "document" : null;
    if (!kind) throw new Error("仅支持图片（PNG、JPG、WEBP）或文档（PDF、DOCX、TXT、MD）");
    setChatAttachmentBusy(true);
    setErrorMessage("");
    let uploadedAttachmentId = "";
    try {
      const uploadForm = new FormData();
      uploadForm.append("conversation_id", String(currentConversationId));
      uploadForm.append("kind", kind);
      uploadForm.append("file", file);
      const attachment = await fetchJson<ChatAttachment>("/attachments", { method: "POST", body: uploadForm });
      uploadedAttachmentId = attachment.id;
      const parseForm = new FormData();
      parseForm.append("mode", "fast");
      const parsed = await fetchJson<ChatAttachment>(`/attachments/${attachment.id}/parse`, { method: "POST", body: parseForm });
      setNoticeMessage(kind === "document" ? "文档已添加" : "图片已添加");
      return parsed;
    } catch (error) {
      if (uploadedAttachmentId) {
        void fetchJson(`/attachments/${uploadedAttachmentId}`, { method: "DELETE" }).catch(() => undefined);
      }
      const message = error instanceof Error ? error.message : "附件上传或解析失败";
      setErrorMessage(message);
      throw new Error(message);
    } finally {
      setChatAttachmentBusy(false);
    }
  }

  async function removeChatAttachment(attachmentId: string) {
    await fetchJson(`/attachments/${attachmentId}`, { method: "DELETE" });
    setNoticeMessage("附件已移除");
  }

  async function loadChatAttachment(attachment: ChatAttachment, signal?: AbortSignal): Promise<{ file: Blob; parsedText?: string }> {
    let parsedText = attachment.parsed_text;
    if (/\.docx$/i.test(attachment.original_filename) && parsedText === undefined) {
      const details = await fetchJson<ChatAttachment>(`/attachments/${encodeURIComponent(attachment.id)}`, { signal });
      parsedText = details.parsed_text;
    }
    const response = await fetchWithTimeout(`${apiBase}/${attachment.origin === "generated" ? "chat-assets" : "attachments"}/${encodeURIComponent(attachment.id)}/file`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal
    });
    if (!response.ok) throw new Error(response.status === 404 ? "附件原文件不存在，可能已被移除" : "附件读取失败，请重试");
    return { file: await response.blob(), parsedText };
  }

  async function sendChatMessage(...args: Parameters<typeof executeChatMessage>) {
    if (sendingRef.current || chatBusy) return false;
    sendingRef.current = true;
    setChatBusy(true);
    try { return await executeChatMessage(...args); }
    finally {
      sendingRef.current = false;
      setChatBusy(false);
    }
  }

  async function executeChatMessage(
    contentOverride: string,
    attachmentIds: string[] = [],
    visionAttachmentIds: string[] = [],
    webSearchOverride?: boolean,
    webSearchTopicOverride?: WebSearchTopic,
    webSearchSourcePreferenceOverride?: WebSearchSourcePreference,
    conversationIdOverride?: number,
    runIdOverride?: string,
    rewindMessageId?: number,
    modelProfileIdOverride?: string | null,
    expectedWebSearchProvider?: string,
  ) {
    const content = contentOverride.trim();
    const targetConversationId = conversationIdOverride ?? currentConversationId;
    const selectedModelProfileId = modelProfileIdOverride === undefined ? modelProfileId ?? null : modelProfileIdOverride;
    if (!content || chatBusy || !targetConversationId) return;
    // Omitted fields let the server resolve automatic search and pending-task
    // inheritance. Explicit fields are kept for retries and legacy callers.
    let webSearch = webSearchOverride;
    let webSearchTopic = webSearchTopicOverride;
    let webSearchSourcePreference = webSearchSourcePreferenceOverride;
    setModelUnavailable(null);
    setSendError(null);
    let boundSearchProvider = expectedWebSearchProvider;
    if (webSearch && expectedWebSearchProvider && !runIdOverride) {
      try {
        const capabilities = await fetchJson<AgentCapabilities>("/agent/capabilities");
        const search = capabilities.web_research;
        if (!search || search.provider !== expectedWebSearchProvider) throw new Error("搜索服务与原任务不同。历史消息已保留，请按当前服务重新发送新消息。");
        const issue = webSearchConfigurationIssue({ version: 1, enabled: true, topic: webSearchTopic ?? "auto", source_preference: webSearchSourcePreference ?? "none" }, search);
        if (issue) throw new Error(issue);
      } catch (error) {
        setSendError(error instanceof Error ? error.message : "无法核对原任务的搜索服务");
        setRetryChatDraft({ content, modelProfileId: selectedModelProfileId, attachmentIds, visionAttachmentIds, webSearch, webSearchTopic, webSearchSourcePreference,
          webSearchProvider: expectedWebSearchProvider, ...(runIdOverride ? { runId: runIdOverride } : {}), ...(rewindMessageId !== undefined ? { rewindMessageId } : {}), reason: "send_failed" });
        return false;
      }
    }
    // Validate the saved search binding before editing/retrying removes history.
    if (rewindMessageId !== undefined) await rewindChatToUserMessage(rewindMessageId);
    else setReplacementUndo(null);
    const { HttpAgent } = await import("@ag-ui/client");
    const conversationId = targetConversationId;
    const executionRunId = runIdOverride ?? createClientId();
    chatAgentRef.current?.abortRun();
    const optimisticId = -Date.now();
    const optimisticAssistantId = optimisticId - 1;
    const optimisticMessage: ChatMessage = {
      id: optimisticId,
      role: "user",
      content,
      created_at: new Date().toISOString(),
      payload: { web_search: webSearch, web_search_topic: webSearchTopic, web_search_source_preference: webSearchSourcePreference }
    };
    setChatBusy(true);
    setRetryChatDraft(null);
    setErrorMessage("");
    setNoticeMessage("");
    const optimisticAssistant: ChatMessage = {
      id: optimisticAssistantId,
      role: "assistant",
      content: "",
      created_at: optimisticMessage.created_at,
      payload: {
        agent: { provider: "openai", platform: "manual", rounds: 0, status: "done", events: [] }
      }
    };
    setChatMessages((current) => [...current, optimisticMessage, optimisticAssistant]);
    let terminalReceived = false;
    let streamError: string | null = null;
    const isCurrentRun = () => chatAgentRef.current === agent && currentConversationIdRef.current === conversationId;
    const acceptsStreamEvents = () => !terminalReceived && isCurrentRun();

    const ensureStreamingAssistant = () => {
      if (!acceptsStreamEvents()) return;
      setChatMessages((current) => current.some((message) => message.id === optimisticAssistantId)
        ? current
        : [...current, {
          id: optimisticAssistantId,
          role: "assistant",
          content: "",
          created_at: new Date().toISOString(),
          payload: {
            agent: {
              provider: "openai",
              platform: "manual",
              rounds: 0,
              status: "done",
              events: []
            }
          }
        }]);
    };

    const updateAgentEvent = (agentEvent: AgentRunResult["events"][number]) => {
      if (!acceptsStreamEvents()) return;
      ensureStreamingAssistant();
      setChatMessages((current) => current.map((message) => {
        if (message.id !== optimisticAssistantId) return message;
        const agent = message.payload?.agent ?? {
          provider: "openai",
          platform: "manual",
          rounds: 0,
          status: "done" as const,
          events: []
        };
        const existing = agent.events.find((item) => item.tool_call_id === agentEvent.tool_call_id);
        const incomingGeneric = !agentEvent.message.trim()
          || /^(?:正在执行(?:\s+\S+)?)$/i.test(agentEvent.message.trim());
        const keepExistingMessage = Boolean(
          existing?.message
          && incomingGeneric
          && existing.message.trim() !== agentEvent.message.trim()
        );
        const merged = {
          ...existing,
          ...agentEvent,
          message: keepExistingMessage ? existing!.message : agentEvent.message,
          data: { ...existing?.data, ...agentEvent.data }
        };
        const events = existing
          ? agent.events.map((item) => item.tool_call_id === agentEvent.tool_call_id ? merged : item)
          : [...agent.events, merged];
        return { ...message, payload: { ...message.payload, agent: { ...agent, events } } };
      }));
    };

    const handleTerminal = (snapshot: {
      tuantuan: {
        status: "done" | "failed" | "cancelled" | "waiting_user";
        userMessage: ChatMessage;
        assistantMessage: ChatMessage;
      };
    }) => {
      if (terminalReceived) return;
      terminalReceived = true;
      if (!isCurrentRun()) return;
      const { userMessage, assistantMessage } = snapshot.tuantuan;
      if (currentConversationIdRef.current === conversationId) {
        setChatMessages((current) => [
          ...current.filter((message) => ![
            optimisticId,
            optimisticAssistantId,
            userMessage.id,
            assistantMessage.id
          ].includes(message.id)),
          userMessage,
          assistantMessage
        ]);
      }
      if (assistantMessage.payload?.agent?.events.some((event) =>
        event.tool_name === "propose_library_knowledge" && event.status === "done"
      )) {
        void onLibraryChanged().catch((error: unknown) => {
          setErrorMessage(error instanceof Error ? error.message : "资料库刷新失败");
        });
      }
      // A persisted terminal answer owns its error and retry action. A failed
      // image/search operation does not mean the chat model is unavailable.
      setModelUnavailable(null);
      setSendError(null);
      setRetryChatDraft(null);
    };

    const agent = new HttpAgent({
      url: `${apiBase}/ag-ui`,
      fetch: (url, requestInit) => fetchWithTimeout(url, requestInit, 600_000),
      headers: { Authorization: `Bearer ${accessToken}` },
      agentId: "tuantuan",
      threadId: String(conversationId),
      initialMessages: [
        ...chatMessages.map((message) => ({
          id: String(message.id),
          role: message.role,
          content: message.content
        })),
        { id: String(optimisticId), role: "user" as const, content }
      ],
      initialState: { conversationId }
    });
    chatAgentRef.current = agent;

    const subscriber: AgentSubscriber = {
      onCustomEvent: ({ event }) => {
        if (!acceptsStreamEvents()) return;
        if (event.name === "tuantuan.user_message") {
          const userMessage = event.value as ChatMessage;
          if (userMessage.payload?.web_search_options) {
            const resolved = webSearchOptionsFromMessage(userMessage);
            webSearch = resolved.enabled;
            webSearchTopic = resolved.topic;
            webSearchSourcePreference = resolved.source_preference;
          }
          if (userMessage.payload?.web_search_options?.provider) boundSearchProvider = userMessage.payload.web_search_options.provider;
          if (currentConversationIdRef.current === conversationId) {
            setChatMessages((current) => {
              let replaced = false;
              const messages = current.flatMap((message) => {
                if (![optimisticId, userMessage.id].includes(message.id)) return [message];
                if (replaced) return [];
                replaced = true;
                return [userMessage];
              });
              if (!replaced) {
                const assistantIndex = messages.findIndex((message) => message.id === optimisticAssistantId);
                messages.splice(assistantIndex < 0 ? messages.length : assistantIndex, 0, userMessage);
              }
              return messages;
            });
          }
        }
        if (event.name === "tuantuan.agent_event" && event.value && typeof event.value === "object") {
          updateAgentEvent(event.value as AgentRunResult["events"][number]);
        }
        if (event.name === "tuantuan.run_timing" && event.value && typeof event.value === "object") {
          const timing = event.value as { run_id?: string; started_at?: string };
          if (timing.run_id !== executionRunId || typeof timing.started_at !== "string"
            || !Number.isFinite(Date.parse(timing.started_at))) return;
          ensureStreamingAssistant();
          setChatMessages((current) => current.map((message) => {
            if (message.id !== optimisticAssistantId || !message.payload?.agent) return message;
            return { ...message, payload: { ...message.payload, agent: { ...message.payload.agent, started_at: timing.started_at } } };
          }));
        }
      },
      onTextMessageStartEvent: () => {
        if (!acceptsStreamEvents()) return;
        ensureStreamingAssistant();
        setChatMessages((current) => current.map((message) =>
          message.id === optimisticAssistantId ? { ...message, content: "" } : message
        ));
      },
      onTextMessageContentEvent: ({ event }) => {
        if (!acceptsStreamEvents()) return;
        ensureStreamingAssistant();
        setChatMessages((current) => current.map((message) =>
          message.id === optimisticAssistantId
            ? { ...message, content: message.content + event.delta }
            : message
        ));
      },
      onReasoningMessageStartEvent: ({ event }) => {
        updateAgentEvent({
          round: 0,
          tool_call_id: event.messageId.replace(/^reasoning:/, ""),
          tool_name: "agent_thinking",
          status: "running",
          message: ""
        });
      },
      onReasoningMessageContentEvent: ({ event, reasoningMessageBuffer }) => {
        updateAgentEvent({
          round: 0,
          tool_call_id: event.messageId.replace(/^reasoning:/, ""),
          tool_name: "agent_thinking",
          status: "running",
          message: reasoningMessageBuffer + event.delta
        });
      },
      onReasoningMessageEndEvent: ({ event, reasoningMessageBuffer }) => {
        updateAgentEvent({
          round: 0,
          tool_call_id: event.messageId.replace(/^reasoning:/, ""),
          tool_name: "agent_thinking",
          status: "done",
          message: reasoningMessageBuffer
        });
      },
      onToolCallStartEvent: ({ event }) => {
        updateAgentEvent({
          round: 0,
          tool_call_id: event.toolCallId,
          tool_name: event.toolCallName,
          status: "running",
          message: `正在执行 ${event.toolCallName}`
        });
      },
      onToolCallResultEvent: ({ event }) => {
        try {
          updateAgentEvent(JSON.parse(event.content) as AgentRunResult["events"][number]);
        } catch {
          updateAgentEvent({
            round: 0,
            tool_call_id: event.toolCallId,
            tool_name: "agent_tool",
            status: "done",
            message: event.content
          });
        }
      },
      onStateSnapshotEvent: ({ event }) => {
        handleTerminal(event.snapshot as Parameters<typeof handleTerminal>[0]);
      },
      onRunErrorEvent: ({ event }) => {
        if (acceptsStreamEvents()) streamError = event.message || "流式执行失败";
      }
    };

    try {
      await agent.runAgent(
        {
          runId: executionRunId,
          tools: [],
          context: [],
          forwardedProps: { conversationId, modelProfileId: selectedModelProfileId, client: "tuantuan-web", attachmentIds, visionAttachmentIds,
            ...(webSearch === undefined ? {} : { webSearch }),
            ...(webSearchTopic === undefined ? {} : { webSearchTopic }),
            ...(webSearchSourcePreference === undefined ? {} : { webSearchSourcePreference }),
            ...(expectedWebSearchProvider ? { webSearchProvider: expectedWebSearchProvider } : {}) }
        },
        subscriber
      );
      if (!terminalReceived) throw new Error(streamError || "AG-UI 消息流意外中断，请重试");

      void Promise.all([refreshConversations()]).catch((error: unknown) => {
        setErrorMessage(error instanceof Error ? error.message : "后台数据刷新失败");
      });
    } catch (error) {
      if (!isCurrentRun() || terminalReceived) return;
      if (currentConversationIdRef.current === conversationId) {
        setChatMessages((current) => current.filter((message) => ![optimisticId, optimisticAssistantId].includes(message.id)));
      }
      if (error instanceof DOMException && error.name === "AbortError") return;
      const message = streamError || (error instanceof Error ? error.message : "消息发送失败");
      setSendError(message);
      setRetryChatDraft({
        content,
        modelProfileId: selectedModelProfileId,
        attachmentIds,
        visionAttachmentIds,
        webSearch,
        webSearchTopic,
        webSearchSourcePreference,
        ...(boundSearchProvider ? { webSearchProvider: boundSearchProvider } : {}),
        runId: executionRunId,
        reason: "send_failed"
      });
    } finally {
      if (chatAgentRef.current === agent) {
        chatAgentRef.current = null;
        setChatBusy(false);
      }
    }
  }

  async function stopChatGeneration() {
    if (!currentConversationId || !chatBusy || taskCancelBusy) return;
    setTaskCancelBusy(true);
    setErrorMessage("");
    try {
      const result = await fetchJson<{ cancelled: boolean }>(
        `/agent/tasks/current/cancel?conversation_id=${currentConversationId}`,
        { method: "POST" }
      );
      if (!result.cancelled) setNoticeMessage("没有可停止的任务");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "停止生成失败");
    } finally {
      setTaskCancelBusy(false);
    }
  }

  async function rewindChatToUserMessage(userMessageId: number) {
    if (!currentConversationId) throw new Error("请先选择一个对话");
    const response = await fetchJson<{ messages?: ChatMessage[]; previous_title?: string | null }>(
      `/chat/messages/${userMessageId}/tail?conversation_id=${currentConversationId}`,
      { method: "DELETE" }
    );
    const messages = Array.isArray(response?.messages) ? response.messages.filter((message) => message.id > 0) : [];
    if (messages.length) {
      setReplacementUndo({
        conversationId: currentConversationId,
        messages,
        ...(typeof response.previous_title === "string" ? { previousTitle: response.previous_title } : {})
      });
    }
    await Promise.all([
      refreshChat(currentConversationId),
      refreshConversations(),
    ]);
  }

  async function undoReplacement() {
    const snapshot = replacementUndo;
    if (!snapshot || snapshot.conversationId !== currentConversationId || chatBusy) return;
    setErrorMessage("");
    try {
      await fetchJson("/chat/messages/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: snapshot.conversationId,
          previous_title: snapshot.previousTitle ?? null,
          messages: snapshot.messages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            payload: message.payload ?? {},
            created_at: message.created_at
          }))
        })
      });
      setReplacementUndo(null);
      await Promise.all([refreshChat(snapshot.conversationId), refreshConversations()]);
      setNoticeMessage("已撤销替换。生成的图片无法恢复。");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "撤销失败");
    }
  }

  async function deleteChatTurn(userMessageId: number) {
    if (!currentConversationId) throw new Error("请先选择一个对话");
    setErrorMessage("");
    try {
      await fetchJson(`/chat/messages/${userMessageId}/turn?conversation_id=${currentConversationId}`, { method: "DELETE" });
      setReplacementUndo(null);
      await Promise.all([refreshChat(currentConversationId), refreshConversations()]);
      setNoticeMessage("已删除这轮问答");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "删除这轮问答失败");
    }
  }

  async function editChatMessage(userMessageId: number, content: string) {
    const sourceMessage = chatMessages.find((message) => message.id === userMessageId && message.role === "user");
    if (!sourceMessage) throw new Error("找不到要编辑的用户消息");
    const search = webSearchOptionsFromMessage(sourceMessage);
    await sendChatMessage(content, [], [], search.enabled, search.topic, search.source_preference, undefined, undefined, userMessageId, undefined, search.provider);
  }

  async function regenerateChatMessage(userMessageId: number) {
    const sourceMessage = chatMessages.find(
      (message) => message.id === userMessageId && message.role === "user"
    );
    if (!sourceMessage) throw new Error("找不到要重新生成的用户消息");
    const search = webSearchOptionsFromMessage(sourceMessage);
    await sendChatMessage(sourceMessage.content, [], [], search.enabled, search.topic, search.source_preference, undefined, undefined, userMessageId, undefined, search.provider);
  }

  async function cancelCurrentTask() {
    setTaskCancelBusy(true);
    setErrorMessage("");
    try {
      await fetchJson(`/agent/tasks/current/cancel?conversation_id=${currentConversationId}`, { method: "POST" });
      await Promise.all([refreshChat(), refreshConversations()]);
      setNoticeMessage("任务已结束");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "结束当前任务失败");
    } finally {
      setTaskCancelBusy(false);
    }
  }
  useEffect(() => () => chatAgentRef.current?.abortRun(), []);
  return { chatMessages, setChatMessages, chatBusy, setChatBusy, modelUnavailable, setModelUnavailable, sendError, retryChatDraft, setRetryChatDraft, replacementUndo, chatAgentRef, taskCancelBusy, setTaskCancelBusy, chatAttachmentBusy, setChatAttachmentBusy, refreshChat, uploadChatAttachment, loadChatAttachment, removeChatAttachment, sendChatMessage, stopChatGeneration, rewindChatToUserMessage, editChatMessage, regenerateChatMessage, undoReplacement, deleteChatTurn, cancelCurrentTask };
}
