import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSubscriber } from "@ag-ui/client";
import type { createApiClient } from "../../api/client";
import type { ChatMessage } from "./types";
import { useChatRun } from "./useChatRun";

const client = vi.hoisted(() => ({ runAgent: vi.fn(), abortRun: vi.fn() }));
vi.mock("@ag-ui/client", () => ({
  HttpAgent: class {
    runAgent = client.runAgent;
    abortRun = client.abortRun;
  }
}));

function setup() {
  let finish!: () => void;
  client.runAgent.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const currentConversationIdRef = { current: 1 as number | null };
  const setErrorMessage = vi.fn();
  const setNoticeMessage = vi.fn();
  const fetchJson = vi.fn();
  const hook = renderHook(() => useChatRun({
    apiBase: "/test-api", accessToken: "test-only-session",
    fetchJson: fetchJson as ReturnType<typeof createApiClient>,
    currentConversationId: 1, currentConversationIdRef,
    setErrorMessage, setNoticeMessage,
    refreshConversations: vi.fn().mockResolvedValue([]),
    onLibraryChanged: vi.fn().mockResolvedValue(undefined)
  }));
  return { ...hook, currentConversationIdRef, setErrorMessage, setNoticeMessage, fetchJson, finish: () => finish() };
}

function emit(name: keyof AgentSubscriber, value: Record<string, unknown>) {
  const subscriber = client.runAgent.mock.calls.at(-1)![1] as AgentSubscriber;
  const callback = subscriber[name] as (value: Record<string, unknown>) => void;
  callback(value);
}

const userMessage: ChatMessage = { id: 11, role: "user", content: "测试问题", created_at: "2026-10-10T00:00:00Z" };
const assistantMessage: ChatMessage = { id: 12, role: "assistant", content: "测试回答", created_at: "2026-10-10T00:00:01Z" };
const snapshot = { tuantuan: { status: "done", userMessage, assistantMessage } };

beforeEach(() => { client.runAgent.mockReset(); client.abortRun.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("attachment original loading", () => {
  it("authenticates original-file reads, forwards cancellation and loads historical Word text", async () => {
    const { result, fetchJson } = setup();
    const file = new Blob(["word bytes"]);
    const fetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => file });
    vi.stubGlobal("fetch", fetch);
    fetchJson.mockResolvedValue({ parsed_text: "Word 历史正文" });
    const controller = new AbortController();
    const data = await result.current.loadChatAttachment({ id: "word-id", kind: "document", original_filename: "报告.docx", parse_status: "parsed" }, controller.signal);
    expect(data).toEqual({ file, parsedText: "Word 历史正文" });
    expect(fetchJson).toHaveBeenCalledWith("/attachments/word-id", { signal: controller.signal });
    expect(fetch).toHaveBeenCalledWith("/test-api/attachments/word-id/file", expect.objectContaining({ headers: { Authorization: "Bearer test-only-session" } }));
    expect((fetch.mock.calls[0][1].signal as AbortSignal).aborted).toBe(false);
  });

  it("reports deleted files without modifying the conversation or attachments", async () => {
    const { result, fetchJson } = setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(result.current.loadChatAttachment({ id: "missing", kind: "document", original_filename: "notes.txt", parse_status: "parsed" })).rejects.toThrow("附件原文件不存在");
    expect(fetchJson).not.toHaveBeenCalled();
    expect(result.current.chatMessages).toEqual([]);
  });
});

describe("useChatRun stream reconciliation", () => {
  it("keeps all search options and the run ID after a failed stream, including a server-bound provider", async () => {
    const { result, fetchJson } = setup();
    client.runAgent.mockImplementationOnce(async () => {
      emit("onCustomEvent", { event: { name: "tuantuan.user_message", value: { ...userMessage, payload: { web_search_options: { version: 1, enabled: true, topic: "finance", source_preference: "technical", provider: "tavily" } } } } });
      throw new Error("连接中断");
    });
    await act(() => result.current.sendChatMessage(userMessage.content, ["doc-1"], [], true, "finance", "technical"));
    const original = client.runAgent.mock.calls[0][0];
    expect(original.forwardedProps).toMatchObject({ webSearch: true, webSearchTopic: "finance", webSearchSourcePreference: "technical" });
    expect(original.forwardedProps).not.toHaveProperty("webSearchMode");
    const draft = result.current.retryChatDraft!;
    expect(draft).toMatchObject({ attachmentIds: ["doc-1"], webSearch: true, webSearchTopic: "finance", webSearchSourcePreference: "technical", webSearchProvider: "tavily", runId: original.runId });
    fetchJson.mockResolvedValue({ web_research: { enabled: true, provider: "tavily", supported_topics: ["auto", "general", "news", "finance"], supports_technical_preference: true } });
    client.runAgent.mockImplementationOnce(async () => emit("onStateSnapshotEvent", { event: { snapshot } }));
    await act(() => result.current.sendChatMessage(draft.content, draft.attachmentIds, draft.visionAttachmentIds, draft.webSearch, draft.webSearchTopic, draft.webSearchSourcePreference, undefined, draft.runId, draft.rewindMessageId, draft.modelProfileId, draft.webSearchProvider));
    expect(client.runAgent.mock.calls[1][0]).toMatchObject({ runId: original.runId, forwardedProps: { webSearchTopic: "finance", webSearchSourcePreference: "technical", webSearchProvider: "tavily" } });
    expect(fetchJson).not.toHaveBeenCalled(); // Same-run replay may return stored results without using the current service.
  });

  it("omits search overrides so the server can inherit a waiting task or recognize a new topic", async () => {
    const { result } = setup();
    const pendingUser: ChatMessage = { ...userMessage, payload: { web_search_options: { version: 1, enabled: true, topic: "news", source_preference: "technical", provider: "tavily" } } };
    const pendingAssistant: ChatMessage = { ...assistantMessage, payload: { agent: { provider: "test", platform: "local", rounds: 1, status: "waiting_user", events: [] } } };
    act(() => result.current.setChatMessages([pendingUser, pendingAssistant]));
    client.runAgent.mockImplementationOnce(async () => emit("onStateSnapshotEvent", { event: { snapshot } }));
    await act(() => result.current.sendChatMessage("继续查最新发布"));
    expect(client.runAgent.mock.calls[0][0].forwardedProps).not.toHaveProperty("webSearch");
    expect(client.runAgent.mock.calls[0][0].forwardedProps).not.toHaveProperty("webSearchTopic");
  });

  it("honors an explicit search disable and auto choice in a new clarification run", async () => {
    const { result } = setup();
    const pendingUser: ChatMessage = { ...userMessage, payload: { web_search_options: { version: 1, enabled: true, topic: "news", source_preference: "technical", provider: "tavily" } } };
    const pendingAssistant: ChatMessage = { ...assistantMessage, payload: { agent: { provider: "test", platform: "local", rounds: 1, status: "waiting_user", events: [] } } };
    act(() => result.current.setChatMessages([pendingUser, pendingAssistant]));
    client.runAgent.mockImplementationOnce(async () => emit("onStateSnapshotEvent", { event: { snapshot } }));
    await act(() => result.current.sendChatMessage("只整理已有资料", [], [], false, "auto", "none"));
    expect(client.runAgent.mock.calls[0][0].forwardedProps).toMatchObject({ webSearch: false, webSearchTopic: "auto", webSearchSourcePreference: "none" });
    expect(client.runAgent.mock.calls[0][0].runId).toBeTruthy();
  });

  it("checks the saved provider before deleting messages for regeneration", async () => {
    const { result, fetchJson } = setup();
    const original: ChatMessage = { ...userMessage, payload: { web_search_options: { version: 1, enabled: true, topic: "news", source_preference: "none", provider: "tavily" } } };
    act(() => result.current.setChatMessages([original, assistantMessage]));
    fetchJson.mockResolvedValue({ web_research: { enabled: true, provider: "agent_search", supported_topics: ["auto", "general", "news"], supports_technical_preference: false } });
    await act(() => result.current.regenerateChatMessage(original.id));
    expect(result.current.chatMessages).toEqual([original, assistantMessage]);
    expect(fetchJson).toHaveBeenCalledOnce();
    expect(fetchJson).toHaveBeenCalledWith("/agent/capabilities");
    expect(client.runAgent).not.toHaveBeenCalled();
    expect(result.current.sendError).toContain("历史消息已保留");
    expect(result.current.chatBusy).toBe(false);
    expect(result.current.replacementUndo).toBeNull();
  });

  it("restores rewound text after a replacement and drops that undo when a new message is sent", async () => {
    const { result, fetchJson } = setup();
    const removed = [userMessage, assistantMessage];
    act(() => result.current.setChatMessages(removed));
    fetchJson.mockImplementation(async (path: string) => {
      if (String(path).includes("/tail?")) return { messages: removed, previous_title: "原标题" };
      if (String(path).startsWith("/chat/messages?")) return [];
      return { run: null };
    });
    client.runAgent.mockImplementationOnce(async () => emit("onStateSnapshotEvent", { event: { snapshot } }));
    await act(() => result.current.editChatMessage(userMessage.id, "新的问题"));
    expect(result.current.replacementUndo?.messages.map((message) => message.id)).toEqual([11, 12]);
    fetchJson.mockImplementation(async (path: string) => {
      if (path === "/chat/messages/restore") return { restored: 2 };
      if (String(path).startsWith("/chat/messages?")) return removed;
      return { run: null };
    });
    await act(() => result.current.undoReplacement());
    const restore = fetchJson.mock.calls.find(([path]) => path === "/chat/messages/restore");
    expect(JSON.parse(String(restore?.[1]?.body)).messages.map((message: ChatMessage) => message.content)).toEqual(["测试问题", "测试回答"]);
    expect(JSON.parse(String(restore?.[1]?.body)).previous_title).toBe("原标题");
    fetchJson.mockResolvedValue({ run: null });
    client.runAgent.mockImplementationOnce(async () => emit("onStateSnapshotEvent", { event: { snapshot } }));
    await act(() => result.current.sendChatMessage("另一句"));
    expect(result.current.replacementUndo).toBeNull();
  });

  it("validates capability support before editing a historical search turn", async () => {
    const { result, fetchJson } = setup();
    const original: ChatMessage = { ...userMessage, payload: { web_search_options: { version: 1, enabled: true, topic: "news", source_preference: "technical", provider: "agent_search" } } };
    act(() => result.current.setChatMessages([original, assistantMessage]));
    fetchJson.mockResolvedValue({ web_research: { enabled: true, provider: "agent_search", supported_topics: ["auto", "general", "news"], supports_technical_preference: false } });
    await act(() => result.current.editChatMessage(original.id, "新的问题"));
    expect(result.current.chatMessages).toEqual([original, assistantMessage]);
    expect(fetchJson).toHaveBeenCalledOnce();
    expect(client.runAgent).not.toHaveBeenCalled();
    expect(result.current.sendError).toContain("不支持优先技术资料");
    expect(result.current.chatBusy).toBe(false);
  });

  it("preserves the historical search options for edit and sends provider only as an expected binding", async () => {
    const { result, fetchJson } = setup();
    const original: ChatMessage = { ...userMessage, payload: { attachments: [{ id: "old-doc", kind: "document", original_filename: "old.pdf", parse_status: "parsed" }], web_search_options: { version: 1, enabled: true, topic: "finance", source_preference: "technical", provider: "tavily" } } };
    act(() => result.current.setChatMessages([original, assistantMessage]));
    fetchJson.mockImplementation(async (path: string) => path === "/agent/capabilities" ? { web_research: { enabled: true, provider: "tavily", supported_topics: ["auto", "general", "news", "finance"], supports_technical_preference: true } } : path.startsWith("/chat/messages?") ? [] : { run: null });
    client.runAgent.mockImplementationOnce(async () => emit("onStateSnapshotEvent", { event: { snapshot } }));
    await act(() => result.current.editChatMessage(original.id, "新的金融问题"));
    expect(fetchJson.mock.calls[0][0]).toBe("/agent/capabilities");
    expect(fetchJson.mock.calls[1]).toEqual([`/chat/messages/${original.id}/tail?conversation_id=1`, { method: "DELETE" }]);
    expect(client.runAgent.mock.calls[0][0].forwardedProps).toMatchObject({ attachmentIds: [], webSearch: true, webSearchTopic: "finance", webSearchSourcePreference: "technical", webSearchProvider: "tavily" });
  });

  it("locks duplicate regeneration clicks while the provider preflight is pending", async () => {
    const { result, fetchJson } = setup();
    const original: ChatMessage = { ...userMessage, payload: { web_search_options: { version: 1, enabled: true, topic: "news", source_preference: "none", provider: "tavily" } } };
    act(() => result.current.setChatMessages([original, assistantMessage]));
    let confirm!: (value: unknown) => void;
    const pendingCapabilities = new Promise((resolve) => { confirm = resolve; });
    fetchJson.mockImplementation(async (path: string) => path === "/agent/capabilities" ? pendingCapabilities : path.startsWith("/chat/messages?") ? [] : { run: null });
    client.runAgent.mockImplementationOnce(async () => emit("onStateSnapshotEvent", { event: { snapshot } }));
    let first!: Promise<void>;
    act(() => { first = result.current.regenerateChatMessage(original.id); });
    await act(() => result.current.regenerateChatMessage(original.id));
    expect(fetchJson).toHaveBeenCalledOnce();
    await act(async () => { confirm({ web_research: { enabled: true, provider: "tavily", supported_topics: ["auto", "general", "news", "finance"], supports_technical_preference: true } }); await first; });
    expect(fetchJson.mock.calls.filter(([path]) => String(path).includes("/tail?"))).toHaveLength(1);
    expect(client.runAgent).toHaveBeenCalledOnce();
  });

  it("creates one assistant placeholder immediately and uses server timing before any token", async () => {
    const { result, finish } = setup();
    let pending!: Promise<void | false>;
    act(() => { pending = result.current.sendChatMessage(userMessage.content); });
    await waitFor(() => expect(client.runAgent).toHaveBeenCalledOnce());
    expect(result.current.chatMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
    const placeholder = result.current.chatMessages[1];
    expect(placeholder.content).toBe("");
    expect(placeholder.payload?.agent?.started_at).toBeUndefined();
    expect(placeholder.payload?.agent?.duration_ms).toBeUndefined();
    const runId = client.runAgent.mock.calls[0][0].runId as string;
    const startedAt = "2026-10-11T00:00:00.125+00:00";
    const timedAnswer: ChatMessage = { ...assistantMessage, payload: { agent: {
      provider: "test", platform: "local", rounds: 1, status: "done", events: [],
      started_at: startedAt, completed_at: "2026-10-11T00:06:29.125+00:00", duration_ms: 389000,
    } } };
    act(() => {
      emit("onCustomEvent", { event: { name: "tuantuan.user_message", value: userMessage } });
      emit("onCustomEvent", { event: { name: "tuantuan.run_timing", value: { run_id: runId, started_at: startedAt } } });
      emit("onCustomEvent", { event: { name: "tuantuan.user_message", value: userMessage } });
    });
    expect(result.current.chatMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(result.current.chatMessages[1].id).toBe(placeholder.id);
    expect(result.current.chatMessages[1].payload?.agent?.started_at).toBe(startedAt);
    act(() => {
      emit("onStateSnapshotEvent", { event: { snapshot: { tuantuan: { status: "done", userMessage, assistantMessage: timedAnswer } } } });
      emit("onCustomEvent", { event: { name: "tuantuan.run_timing", value: { run_id: runId, started_at: "2026-10-11T01:00:00Z" } } });
    });
    expect(result.current.chatMessages).toEqual([userMessage, timedAnswer]);
    expect(result.current.chatMessages[1].payload?.agent?.duration_ms).toBe(389000);
    await act(async () => { finish(); await pending; });
  });

  it("ignores malformed or unrelated timing metadata without inventing a duration", async () => {
    const { result, finish } = setup();
    let pending!: Promise<void | false>;
    act(() => { pending = result.current.sendChatMessage(userMessage.content); });
    await waitFor(() => expect(client.runAgent).toHaveBeenCalledOnce());
    const runId = client.runAgent.mock.calls[0][0].runId as string;
    act(() => {
      emit("onCustomEvent", { event: { name: "tuantuan.run_timing", value: { run_id: "other-run", started_at: "2026-10-11T00:00:00Z" } } });
      emit("onCustomEvent", { event: { name: "tuantuan.run_timing", value: { run_id: runId, started_at: "invalid" } } });
    });
    expect(result.current.chatMessages[1].payload?.agent?.started_at).toBeUndefined();
    expect(result.current.chatMessages[1].payload?.agent?.duration_ms).toBeUndefined();
    await act(async () => { emit("onStateSnapshotEvent", { event: { snapshot } }); finish(); await pending; });
  });

  it("keeps the first appearance order when later completion events update earlier activities", async () => {
    const { result, finish } = setup();
    let pending!: Promise<void | false>;
    act(() => { pending = result.current.sendChatMessage(userMessage.content); });
    await waitFor(() => expect(client.runAgent).toHaveBeenCalledOnce());
    act(() => {
      for (const event of [
        { tool_call_id: "first", tool_name: "read_library", status: "running", message: "读取资料" },
        { tool_call_id: "second", tool_name: "search_public_web", status: "running", message: "搜索网页" },
        { tool_call_id: "first", tool_name: "read_library", status: "done", message: "资料已读取" },
      ]) emit("onCustomEvent", { event: { name: "tuantuan.agent_event", value: { ...event, round: 1 } } });
    });
    const events = result.current.chatMessages[1].payload?.agent?.events;
    expect(events?.map((event) => event.tool_call_id)).toEqual(["first", "second"]);
    expect(events?.[0]).toMatchObject({ status: "done", message: "资料已读取" });
    await act(async () => { emit("onStateSnapshotEvent", { event: { snapshot } }); finish(); await pending; });
  });

  it("merges standard reasoning and the matching Tuantuan event into one activity", async () => {
    const { result, finish } = setup();
    let pending!: Promise<void | false>;
    act(() => { pending = result.current.sendChatMessage(userMessage.content); });
    await waitFor(() => expect(client.runAgent).toHaveBeenCalledOnce());
    act(() => {
      emit("onReasoningMessageStartEvent", { event: { messageId: "reasoning:think-1" } });
      emit("onReasoningMessageContentEvent", { event: { messageId: "reasoning:think-1", delta: "检查资料" }, reasoningMessageBuffer: "" });
      emit("onReasoningMessageEndEvent", { event: { messageId: "reasoning:think-1" }, reasoningMessageBuffer: "检查资料" });
      emit("onCustomEvent", { event: { name: "tuantuan.agent_event", value: {
        round: 1, tool_call_id: "think-1", tool_name: "agent_thinking", status: "done", message: "检查资料", data: { route: "library_qa" }
      } } });
    });
    const events = result.current.chatMessages.find((message) => message.role === "assistant")?.payload?.agent?.events;
    expect(events).toEqual([expect.objectContaining({ tool_call_id: "think-1", message: "检查资料", round: 1, data: { route: "library_qa" } })]);
    await act(async () => { emit("onStateSnapshotEvent", { event: { snapshot } }); finish(); await pending; });
  });

  it("keeps one final answer when snapshots repeat and late stream events arrive", async () => {
    const { result, finish } = setup();
    let pending!: Promise<void | false>;
    act(() => { pending = result.current.sendChatMessage(userMessage.content); });
    await waitFor(() => expect(client.runAgent).toHaveBeenCalledOnce());
    act(() => {
      emit("onCustomEvent", { event: { name: "tuantuan.user_message", value: userMessage } });
      emit("onTextMessageStartEvent", { event: { messageId: "answer-1" } });
      emit("onTextMessageContentEvent", { event: { messageId: "answer-1", delta: assistantMessage.content } });
      emit("onStateSnapshotEvent", { event: { snapshot } });
      emit("onStateSnapshotEvent", { event: { snapshot } });
      emit("onTextMessageContentEvent", { event: { messageId: "answer-1", delta: assistantMessage.content } });
      emit("onReasoningMessageStartEvent", { event: { messageId: "reasoning:late" } });
      emit("onCustomEvent", { event: { name: "tuantuan.user_message", value: userMessage } });
    });
    expect(result.current.chatMessages).toEqual([userMessage, assistantMessage]);
    await act(async () => { finish(); await pending; });
  });

  it("ignores events from a conversation that the user has left", async () => {
    const { result, currentConversationIdRef, finish } = setup();
    let pending!: Promise<void | false>;
    act(() => { pending = result.current.sendChatMessage(userMessage.content); });
    await waitFor(() => expect(client.runAgent).toHaveBeenCalledOnce());
    act(() => { currentConversationIdRef.current = 2; result.current.setChatMessages([]); });
    act(() => {
      emit("onTextMessageContentEvent", { event: { messageId: "answer-1", delta: assistantMessage.content } });
      emit("onReasoningMessageStartEvent", { event: { messageId: "reasoning:stale" } });
      emit("onStateSnapshotEvent", { event: { snapshot } });
    });
    expect(result.current.chatMessages).toEqual([]);
    await act(async () => { finish(); await pending; });
  });

  it("reports a failed send through the retained-draft prompt without a duplicate global error", async () => {
    const { result, setErrorMessage } = setup();
    client.runAgent.mockRejectedValueOnce(new Error("HTTP 500: Internal Server Error"));
    await act(() => result.current.sendChatMessage(userMessage.content));
    expect(result.current.sendError).toBe("HTTP 500: Internal Server Error");
    expect(result.current.modelUnavailable).toBeNull();
    expect(result.current.retryChatDraft?.content).toBe(userMessage.content);
    expect(setErrorMessage.mock.calls.filter(([message]) => message)).toEqual([]);
  });

  it("preserves an unpersisted RunError and same-run replay without a model outage warning", async () => {
    const { result } = setup();
    client.runAgent.mockImplementationOnce(async () => emit("onRunErrorEvent", { event: { message: "请求被拒绝" } }));
    await act(() => result.current.sendChatMessage(userMessage.content));
    expect(result.current.sendError).toBe("请求被拒绝");
    expect(result.current.modelUnavailable).toBeNull();
    expect(result.current.retryChatDraft?.runId).toBe(client.runAgent.mock.calls[0][0].runId);
    expect(result.current.retryChatDraft?.content).toBe(userMessage.content);
  });

  it("accepts a persisted terminal answer after an earlier RunError without keeping a stale warning", async () => {
    const { result } = setup();
    client.runAgent.mockImplementationOnce(async () => {
      emit("onRunErrorEvent", { event: { message: "短暂错误" } });
      emit("onStateSnapshotEvent", { event: { snapshot } });
    });
    await act(() => result.current.sendChatMessage(userMessage.content));
    expect(result.current.chatMessages).toEqual([userMessage, assistantMessage]);
    expect(result.current.sendError).toBeNull();
    expect(result.current.retryChatDraft).toBeNull();
  });

  it("keeps cancellation in the persisted answer without a duplicate global notice", async () => {
    const { result, setNoticeMessage } = setup();
    const cancelledMessage: ChatMessage = { ...assistantMessage, payload: { agent: {
      provider: "test", platform: "local", rounds: 1, status: "cancelled", events: [],
      started_at: "2026-10-11T00:00:00.000+00:00", duration_ms: 1500,
    } } };
    client.runAgent.mockImplementationOnce(async () => {
      emit("onStateSnapshotEvent", { event: { snapshot: { tuantuan: {
        status: "cancelled", userMessage, assistantMessage: cancelledMessage,
      } } } });
    });
    await act(() => result.current.sendChatMessage(userMessage.content));
    expect(result.current.chatMessages).toEqual([userMessage, cancelledMessage]);
    expect(result.current.chatMessages[1].payload?.agent?.status).toBe("cancelled");
    expect(setNoticeMessage.mock.calls.filter(([message]) => message)).toEqual([]);
  });

  it.each(["model_service_error", "image_generation_not_executed", "image_generation_unsupported"])("keeps a persisted failed turn without a duplicate composer error (%s)", async (code) => {
    const { result, setErrorMessage } = setup();
    const failedMessage: ChatMessage = { ...assistantMessage, payload: { agent: {
      provider: "test", platform: "local", rounds: 1, status: "failed", events: [],
      error: { code, message: "服务暂时不可用", retryable: true }
    } } };
    client.runAgent.mockImplementationOnce(async () => {
      emit("onStateSnapshotEvent", { event: { snapshot: { tuantuan: { status: "failed", userMessage, assistantMessage: failedMessage } } } });
      emit("onRunErrorEvent", { event: { message: "服务暂时不可用" } });
      throw new Error("服务暂时不可用");
    });
    await act(() => result.current.sendChatMessage(userMessage.content));
    expect(result.current.chatMessages).toEqual([userMessage, failedMessage]);
    expect(result.current.retryChatDraft).toBeNull();
    expect(result.current.modelUnavailable).toBeNull();
    expect(result.current.sendError).toBeNull();
    expect(setErrorMessage.mock.calls.filter(([message]) => message)).toEqual([]);
  });
});

it("uses server-resolved automatic search options when a new turn needs retry", async () => {
  const { result } = setup();
  client.runAgent.mockImplementationOnce(async () => {
    const forwarded = client.runAgent.mock.calls[0][0].forwardedProps;
    expect(forwarded).not.toHaveProperty("webSearch");
    emit("onCustomEvent", { event: { name: "tuantuan.user_message", value: { ...userMessage, payload: { web_search_options: { version: 1, enabled: true, topic: "auto", source_preference: "none", provider: "tavily" } } } } });
    throw new Error("stream failed");
  });
  await act(() => result.current.sendChatMessage("查一下最新消息"));
  expect(result.current.retryChatDraft).toMatchObject({ webSearch: true, webSearchTopic: "auto", webSearchSourcePreference: "none", webSearchProvider: "tavily" });
});
