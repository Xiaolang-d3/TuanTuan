import { useEffect, useRef, useState, type RefObject } from "react";
import type { createApiClient } from "../../api/client";
import type { ChatMessage } from "./types";
import type { EditGeneratedImage, ImageEditRequest, ImageEditResult } from "./ImageEditor";

type Options = {
  fetchJson: ReturnType<typeof createApiClient>;
  currentConversationId: number | null;
  currentConversationIdRef: RefObject<number | null>;
  refreshChat: (conversationId: number) => Promise<unknown>;
  refreshConversations: () => Promise<unknown>;
  accountKey: string;
};
type Job = { id: string; conversationId: number; messages: ChatMessage[] };

function editLabel(request: ImageEditRequest) {
  const labels = { edit: "修改图片", erase: "擦除选中区域", background: "移除图片背景", resize: "调整图片尺寸" };
  return labels[request.mode] + (request.prompt.trim() ? `：${request.prompt.trim()}` : "")
    + request.comments.map((comment, index) => `\n位置 ${index + 1}：${comment.text}`).join("");
}

export function useImageEdits({ fetchJson, currentConversationId, currentConversationIdRef, refreshChat, refreshConversations, accountKey }: Options) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const nextId = useRef(-Date.now() * 1000);
  const account = useRef(accountKey);
  const inFlight = useRef(new Map<string, Promise<ImageEditResult>>());
  account.current = accountKey;
  useEffect(() => { setJobs([]); inFlight.current.clear(); }, [accountKey]);

  const editImage: EditGeneratedImage = (asset, request) => {
    const existing = inFlight.current.get(request.operation_id);
    if (existing) return existing;
    const conversationId = currentConversationIdRef.current;
    if (!conversationId) return Promise.reject(new Error("请先打开图片所在的对话"));
    const id = request.operation_id;
    const userId = nextId.current--, assistantId = nextId.current--;
    const created_at = new Date().toISOString();
    const user: ChatMessage = { id: userId, role: "user", content: editLabel(request), created_at };
    const assistant: ChatMessage = { id: assistantId, role: "assistant", content: "", created_at,
      payload: { image_edit_pending: true, agent: { provider: "images", platform: "local", rounds: 1, status: "done", started_at: created_at,
        events: [{ round: 1, tool_call_id: id, tool_name: "image_generation", status: "running", message: "正在编辑图片" }] } } };
    setJobs(items => [...items, { id, conversationId, messages: [user, assistant] }]);
    const isCurrent = () => account.current === accountKey;
    const updateAssistant = (message: ChatMessage) => {
      if (isCurrent()) setJobs(items => items.map(job => job.id === id ? { ...job, messages: [user, message] } : job));
    };
    const running = (async () => {
      try {
        const result = await fetchJson<ImageEditResult>(`/chat-assets/${encodeURIComponent(asset.id)}/edits`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
        }, 330_000);
        if (!isCurrent()) return result;
        if (!result.assets.length) throw new Error("编辑服务未返回图片，请刷新对话检查结果");
        // Keep a visible result even if the subsequent history refresh fails.
        updateAssistant({ id: result.message_id, role: "assistant", content: "", created_at,
          payload: { agent: { provider: "images", platform: "local", rounds: 1, status: "done", events: [], assets: result.assets, image_generation_prompt: editLabel(request) } } });
        try {
          if (currentConversationIdRef.current === result.conversation_id) await refreshChat(result.conversation_id);
          if (isCurrent()) setJobs(items => items.filter(job => job.id !== id));
        } catch { /* The generated result remains visible until history can be loaded. */ }
        if (isCurrent()) void refreshConversations().catch(() => {});
        return result;
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : "图片编辑失败，请检查服务配置";
        updateAssistant({ ...assistant, content: `图片编辑未完成：${message}`, payload: { agent: {
          provider: "images", platform: "local", rounds: 1, status: "failed", events: [],
          error: { code: "image_edit_failed", message, retryable: false },
        } } });
        throw reason;
      } finally { if (isCurrent()) inFlight.current.delete(id); }
    })();
    inFlight.current.set(id, running);
    return running;
  };
  return { editImage, messages: jobs.filter(job => job.conversationId === currentConversationId).flatMap(job => job.messages) };
}
