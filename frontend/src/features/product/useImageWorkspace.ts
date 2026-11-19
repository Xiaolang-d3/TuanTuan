import { useEffect, useRef, useState } from "react";
import type { createApiClient } from "../../api/client";
import type { Conversation } from "../../types";
import { useChatRun } from "../chat/useChatRun";
import type { ChatAttachment } from "../chat/types";

const IMAGE_REQUEST_PREFIX = "请生成一张图片：\n\n";
const UNCERTAIN_IMAGE_ERRORS = new Set([
  "request_timeout", "service_unavailable", "provider_error", "account_pool_exhausted", "rate_limited",
  "invalid_provider_response", "invalid_image_output", "image_storage_failed", "image_generation_not_executed", "image_generation_uncertain"
]);

type Options = {
  apiBase: string;
  accessToken: string;
  fetchJson: ReturnType<typeof createApiClient>;
  ready: boolean;
  refreshConversations: () => Promise<unknown>;
  onLibraryChanged: () => Promise<void>;
};

/** Keep image runs in their own ordinary conversation so results remain available in chat. */
export function useImageWorkspace({ apiBase, accessToken, fetchJson, ready, refreshConversations, onLibraryChanged }: Options) {
  const [conversationId, setConversationId] = useState<number | null>(null);
  const conversationRef = useRef<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [setupError, setSetupError] = useState("");
  const activeRef = useRef(true);
  const createController = useRef<AbortController | null>(null);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      createController.current?.abort();
    };
  }, []);

  const run = useChatRun({
    apiBase, accessToken, fetchJson,
    currentConversationId: conversationId,
    currentConversationIdRef: conversationRef,
    // Image requests choose the configured image model, not a chat's explicit model or skill.
    modelProfileId: null,
    selectedSkillId: null,
    preserveSendErrorOnConversationChange: true,
    setErrorMessage: setSetupError,
    setNoticeMessage: () => {},
    refreshConversations,
    onLibraryChanged
  });

  async function generate(prompt: string) {
    const description = prompt.trim();
    if (!ready || !description || submittingRef.current || run.chatBusy) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSetupError("");
    run.setSendError(null);
    // A fresh conversation avoids resuming or disturbing a task the user may
    // have started after opening an earlier image in chat.
    conversationRef.current = null;
    setConversationId(null);
    run.setChatMessages([]);
    try {
      const controller = new AbortController();
      createController.current = controller;
      const created = await fetchJson<Conversation>("/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "图片创作", kernel: "tuantuan" }),
        signal: controller.signal
      });
      if (!activeRef.current || controller.signal.aborted) return;
      createController.current = null;
      const id = created.id;
      conversationRef.current = id;
      setConversationId(id);
      // A separate heading makes short descriptions unambiguous to the image
      // router; an empty history prevents the previous conversation leaking in.
      await run.sendChatMessage(`${IMAGE_REQUEST_PREFIX}${description}`, [], [], false, undefined, undefined, id, undefined, undefined, null, undefined, []);
    } catch (reason) {
      if (activeRef.current) setSetupError(reason instanceof Error ? reason.message : "创建图片任务失败，请重试");
    } finally {
      if (activeRef.current) {
        createController.current = null;
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  }

  const busy = submitting || run.chatBusy;
  const assistantIndex = run.chatMessages.map(message => message.role).lastIndexOf("assistant");
  const assistant = assistantIndex < 0 ? undefined : run.chatMessages[assistantIndex];
  const agent = assistant?.payload?.agent;
  const generatedImages = agent?.assets?.filter(asset => asset.kind === "image") ?? [];
  const lastUser = assistantIndex < 0 ? undefined : run.chatMessages.slice(0, assistantIndex).reverse().find(message => message.role === "user");
  const resultPrompt = lastUser?.content.startsWith(IMAGE_REQUEST_PREFIX)
    ? lastUser.content.slice(IMAGE_REQUEST_PREFIX.length)
    : lastUser?.content;
  let runError = !busy && assistant && !generatedImages.length
    ? agent?.error?.message || (agent?.status === "cancelled" ? "生成已停止" : assistant.content || "本次没有返回图片，请检查图片模型配置。")
    : "";
  if (runError && agent?.error && UNCERTAIN_IMAGE_ERRORS.has(agent.error.code)) {
    runError = `${runError.replace(/[，,]\s*请稍后重试[。.]?$/, "")}。本次未自动重试；请先在所属对话或服务记录中确认结果，再决定是否生成新图片。`;
  }
  // A broken stream can leave a paid upstream request in an unknown state.
  const error = setupError || (run.sendError ? `${run.sendError}。请先在对话中确认结果，再决定是否重新生成。` : "") || runError || null;

  async function loadImage(asset: ChatAttachment, signal?: AbortSignal) {
    return (await run.loadChatAttachment(asset, signal)).file;
  }

  return {
    busy, error,
    images: busy || error ? [] : generatedImages,
    resultPrompt,
    conversationId,
    generate,
    loadImage
  };
}
