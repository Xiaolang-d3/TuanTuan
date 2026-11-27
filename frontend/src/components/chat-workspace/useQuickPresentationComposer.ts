import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client";
import type { ChatAttachment, ChatWorkspaceProps } from "../../features/chat/types";
import { useExtensionPreview } from "../../features/extensions/ExtensionPreviewContext";
import type { PresentationJob, QuickPresentationCapabilities } from "../../features/extensions/presentation-service";
import type { useConversationComposer } from "./useConversationComposer";

type QuickPresentationOptions = Pick<ChatWorkspaceProps,
  "attachmentBusy" | "chatInputRef" | "currentConversationId" | "draftFiles" | "modelProfileUnavailable"
  | "modelSelectionBusy" | "modelSettings" | "onSelectSkill" | "selectedModelProfileId" | "selectedSkillId"
> & {
  pendingAttachments: ChatAttachment[];
  onClearSubmittedAttachments: (conversationId: number, ids: string[]) => void;
};

type ComposerDraft = Pick<ReturnType<typeof useConversationComposer>, "composerText" | "getText" | "setText" | "clearDraft">;

/** 按会话和模型检查快捷 PPT 能力，并管理提交、重试和复用。 */
export function useQuickPresentationComposer(props: QuickPresentationOptions, draft: ComposerDraft) {
  const { presentationService } = useExtensionPreview();
  const conversationId = props.currentConversationId;
  const pptSelected = props.selectedSkillId === "ppt-master";
  const modelScope = `${props.selectedModelProfileId ?? "default"}:${props.modelSettings?.profile.revision ?? 0}`;
  const [quickCheck, setQuickCheck] = useState<{ conversationId: number; modelScope: string; status: QuickPresentationCapabilities }>();
  const [quickCheckAttempt, setQuickCheckAttempt] = useState(0);
  const [quickPending, setQuickPending] = useState<Set<number>>(() => new Set());
  const [quickError, setQuickError] = useState<{ conversationId: number; message: string }>();
  const [submittedJob, setSubmittedJob] = useState<PresentationJob>();
  const quickKeys = useRef(new Map<number, { fingerprint: string; key: string }>());
  const quickSubmitting = useRef(new Set<number>());
  const currentQuickScope = useRef({ conversationId, presentationService });
  currentQuickScope.current = { conversationId, presentationService };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const quickStatus = quickCheck?.conversationId === conversationId && quickCheck.modelScope === modelScope ? quickCheck.status : undefined;
  const quickMode = pptSelected && quickStatus?.composer !== false;
  const quickBusy = conversationId !== null && quickPending.has(conversationId);
  const validPptAttachments = props.pendingAttachments.every(item => item.kind === "document" && /\.(docx|pdf|txt|md)$/i.test(item.original_filename));
  const pptProblem = !validPptAttachments ? "请移除图片或不支持的附件。PPT 可使用 Word、文字版 PDF、TXT 或 Markdown。"
    : [...draft.composerText.trim()].length > 16_000 ? "主题或粘贴内容最多 16,000 字，请精简后发送。" : "";
  const quickDisabled = !quickStatus?.available || quickBusy || Boolean(pptProblem) || !!props.draftFiles?.length || props.attachmentBusy || props.modelSelectionBusy || props.modelProfileUnavailable || (!draft.composerText.trim() && !props.pendingAttachments.length);
  useEffect(() => {
    if (!pptSelected || !conversationId || !presentationService) return;
    const controller = new AbortController();
    setQuickCheck(undefined);
    void presentationService.quickCapabilities(conversationId, controller.signal).then(status => {
      if (!controller.signal.aborted) setQuickCheck({ conversationId, modelScope, status });
    }).catch(error => {
      if (controller.signal.aborted) return;
      const missingRoute = error instanceof ApiError && error.status === 404 && error.message === "Not Found";
      const status = { composer: !missingRoute, available: false, code: missingRoute ? "legacy" : "check_failed", reason: missingRoute ? "" : "暂时无法检查 PPT 制作服务，请重新检查。" };
      setQuickCheck({ conversationId, modelScope, status });
    });
    return () => controller.abort();
  }, [conversationId, modelScope, pptSelected, presentationService, quickCheckAttempt]);

  async function submitQuickPpt() {
    if (!conversationId || !presentationService || quickDisabled || quickSubmitting.current.has(conversationId)) return;
    const submittedText = draft.getText();
    const topic = submittedText.trim();
    const ids = props.pendingAttachments.map(item => item.id);
    const fingerprint = JSON.stringify([topic, ids]);
    const previous = quickKeys.current.get(conversationId);
    const key = previous?.fingerprint === fingerprint ? previous.key : crypto.randomUUID();
    quickKeys.current.set(conversationId, { fingerprint, key });
    quickSubmitting.current.add(conversationId);
    setQuickPending(new Set(quickSubmitting.current));
    setQuickError(undefined);
    const isCurrent = () => mounted.current && currentQuickScope.current.presentationService === presentationService && currentQuickScope.current.conversationId === conversationId;
    try {
      const job = await presentationService.createQuick(topic, ids, conversationId, key);
      quickKeys.current.delete(conversationId);
      if (!isCurrent()) return;
      setSubmittedJob(job);
      if (draft.getText() === submittedText) draft.clearDraft(conversationId);
      props.onClearSubmittedAttachments(conversationId, ids);
    } catch (error) {
      if (isCurrent()) setQuickError({ conversationId, message: error instanceof Error ? error.message : "暂时无法提交 PPT，请重试。" });
    } finally {
      quickSubmitting.current.delete(conversationId);
      if (mounted.current) setQuickPending(new Set(quickSubmitting.current));
    }
  }

  function reuseQuickPpt(job: PresentationJob) {
    props.onSelectSkill?.("ppt-master");
    const current = draft.getText();
    const topic = job.topic ?? "";
    if (!current.trim()) draft.setText(topic);
    props.chatInputRef.current?.focus();
  }

  function retryQuickCheck() {
    setQuickCheckAttempt(value => value + 1);
  }

  return {
    presentationService, pptSelected, modelScope, submittedJob, reuseQuickPpt,
    quickMode, quickStatus, quickBusy, quickDisabled, quickError, pptProblem, submitQuickPpt, retryQuickCheck,
  };
}
