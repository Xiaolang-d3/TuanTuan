import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { AgentSubscriber } from "@ag-ui/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createApiClient } from "../../api/client";
import type { ChatAttachment, ChatMessage } from "../chat/types";
import { useImageWorkspace } from "./useImageWorkspace";

const client = vi.hoisted(() => ({ runAgent: vi.fn(), abortRun: vi.fn(), construct: vi.fn() }));
vi.mock("@ag-ui/client", () => ({
  HttpAgent: class {
    constructor(options: unknown) { client.construct(options); }
    runAgent = client.runAgent;
    abortRun = client.abortRun;
  }
}));

const asset: ChatAttachment = { id: "image-1", origin: "generated", kind: "image", original_filename: "图片.png", parse_status: "parsed" };
const userMessage: ChatMessage = { id: 11, role: "user", content: "请生成一张图片：\n\n一只猫", created_at: "2026-11-18T00:00:00Z" };
const assistantMessage: ChatMessage = { id: 12, role: "assistant", content: "", created_at: "2026-11-18T00:00:01Z", payload: { agent: { provider: "images", platform: "local", rounds: 1, status: "done", events: [], assets: [asset] } } };

function setup(fetchJson = vi.fn().mockResolvedValue({ id: 42 }), ready = true) {
  const refreshConversations = vi.fn().mockResolvedValue([]);
  const hook = renderHook(() => useImageWorkspace({
    apiBase: "/api", accessToken: "test-only-session", fetchJson: fetchJson as ReturnType<typeof createApiClient>,
    ready, refreshConversations, onLibraryChanged: vi.fn().mockResolvedValue(undefined)
  }));
  return { ...hook, fetchJson, refreshConversations };
}

function finishWith(assistant = assistantMessage) {
  client.runAgent.mockImplementation(async (_request, subscriber: AgentSubscriber) => {
    subscriber.onStateSnapshotEvent?.({ event: { snapshot: { tuantuan: { status: assistant.payload?.agent?.status, userMessage, assistantMessage: assistant } } } } as never);
  });
}

beforeEach(() => { client.runAgent.mockReset(); client.abortRun.mockReset(); client.construct.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("image workspace generation", () => {
  it("creates a builtin-kernel conversation and routes even a short prompt through the image model", async () => {
    finishWith();
    const { result, fetchJson, refreshConversations } = setup();
    await act(() => result.current.generate("  一只猫  "));
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(fetchJson).toHaveBeenCalledWith("/conversations", expect.objectContaining({
      method: "POST", body: JSON.stringify({ title: "图片创作", kernel: "tuantuan" })
    }));
    expect(client.construct).toHaveBeenCalledWith(expect.objectContaining({
      url: "/api/ag-ui", threadId: "42",
      initialMessages: [expect.objectContaining({ role: "user", content: "请生成一张图片：\n\n一只猫" })]
    }));
    expect(client.runAgent.mock.calls[0][0].forwardedProps).toMatchObject({ conversationId: 42, modelProfileId: null, skillId: null, webSearch: false });
    expect(result.current).toMatchObject({ busy: false, error: null, conversationId: 42, images: [asset], resultPrompt: "一只猫" });
    await waitFor(() => expect(refreshConversations).toHaveBeenCalled());
  });

  it("does not create duplicate conversations or requests while a submission is pending", async () => {
    let complete!: (value: { id: number }) => void;
    const fetchJson = vi.fn().mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    finishWith();
    const { result } = setup(fetchJson);
    let first!: Promise<void>;
    act(() => { first = result.current.generate("一只猫"); void result.current.generate("一只狗"); });
    expect(result.current.busy).toBe(true);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    await act(async () => { complete({ id: 42 }); await first; });
    expect(client.runAgent).toHaveBeenCalledTimes(1);
  });

  it("shows a persisted generation error and allows the conversation to be inspected", async () => {
    finishWith({ ...assistantMessage, content: "未配置图片模型", payload: { agent: { provider: "images", platform: "local", rounds: 1, status: "failed", events: [], error: { code: "image_model_required", message: "未配置图片模型", retryable: false } } } });
    const { result } = setup();
    await act(() => result.current.generate("一只猫"));
    expect(result.current.error).toBe("未配置图片模型");
    expect(result.current.images).toEqual([]);
    expect(result.current.conversationId).toBe(42);
  });

  it("uses a fresh conversation for each request and does not carry an earlier task into it", async () => {
    finishWith();
    const fetchJson = vi.fn().mockResolvedValueOnce({ id: 42 }).mockResolvedValueOnce({ id: 43 });
    const { result } = setup(fetchJson);
    await act(() => result.current.generate("一只猫"));
    client.runAgent.mockRejectedValueOnce(new Error("连接中断"));
    await act(() => result.current.generate("一只狗"));
    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(client.runAgent).toHaveBeenCalledTimes(2);
    expect(client.construct.mock.calls[1][0]).toMatchObject({
      threadId: "43", initialMessages: [expect.objectContaining({ role: "user", content: "请生成一张图片：\n\n一只狗" })]
    });
    expect(result.current.conversationId).toBe(43);
    expect(result.current.images).toEqual([]);
    expect(result.current.error).toContain("请先在对话中确认结果");
  });

  it("tells the user to verify an uncertain timeout before starting a new paid request", async () => {
    finishWith({ ...assistantMessage, content: "模型服务响应超时，请稍后重试", payload: { agent: { provider: "images", platform: "local", rounds: 1, status: "failed", events: [], error: { code: "request_timeout", message: "模型服务响应超时，请稍后重试", retryable: false } } } });
    const { result } = setup();
    await act(() => result.current.generate("一只猫"));
    expect(result.current.error).toContain("请先在所属对话或服务记录中确认结果");
    expect(result.current.error).not.toContain("请稍后重试");
    expect(result.current.conversationId).toBe(42);
    expect(client.runAgent).toHaveBeenCalledTimes(1);
  });

  it("does not start when not ready or after unmounting during conversation creation", async () => {
    const notReady = setup(undefined, false);
    await act(() => notReady.result.current.generate("一只猫"));
    expect(notReady.fetchJson).not.toHaveBeenCalled();
    notReady.unmount();

    let complete!: (value: { id: number }) => void;
    const fetchJson = vi.fn().mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const pending = setup(fetchJson);
    let submission!: Promise<void>;
    act(() => { submission = pending.result.current.generate("一只猫"); });
    const signal = fetchJson.mock.calls[0][1].signal as AbortSignal;
    pending.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { complete({ id: 42 }); await submission; });
    expect(client.runAgent).not.toHaveBeenCalled();
  });
});
