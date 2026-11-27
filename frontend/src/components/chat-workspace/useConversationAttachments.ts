import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatAttachment, ChatWorkspaceProps } from "../../features/chat/types";

type AttachmentOptions = Pick<ChatWorkspaceProps,
  "currentConversationId" | "libraryAttachments" | "onLibraryAttachmentsConsumed"
  | "onUploadAttachment" | "onRemoveAttachment"
>;

/** 管理当前对话的待发附件、视觉附件标记和本地预览 URL。 */
export function useConversationAttachments(props: AttachmentOptions) {
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [uploadingPreview, setUploadingPreview] = useState<{ filename: string; url: string } | null>(null);
  const previewUrlsRef = useRef<Record<string, string>>({});
  const [localFiles, setLocalFiles] = useState<Record<string, File>>({});
  const currentConversationRef = useRef(props.currentConversationId);
  currentConversationRef.current = props.currentConversationId;
  const [visionAttachmentIds, setVisionAttachmentIds] = useState<string[]>([]);

  const clearSubmittedAttachments = useCallback((conversationId: number, ids: string[]) => {
    if (currentConversationRef.current !== conversationId) return;
    const submitted = new Set(ids);
    for (const id of ids) {
      const url = previewUrlsRef.current[id];
      if (url) URL.revokeObjectURL(url);
      delete previewUrlsRef.current[id];
    }
    setPreviewUrls({ ...previewUrlsRef.current });
    setPendingAttachments(current => current.filter(item => !submitted.has(item.id)));
    setLocalFiles(current => Object.fromEntries(Object.entries(current).filter(([id]) => !submitted.has(id))));
    setVisionAttachmentIds(current => current.filter(id => !submitted.has(id)));
  }, []);

  const clearSentAttachments = useCallback(() => {
    setPendingAttachments([]);
    setLocalFiles({});
    Object.values(previewUrlsRef.current).forEach(url => URL.revokeObjectURL(url));
    previewUrlsRef.current = {};
    setPreviewUrls({});
    setVisionAttachmentIds([]);
  }, []);

  useEffect(() => {
    Object.values(previewUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current = {};
    setPendingAttachments([]);
    setPreviewUrls({});
    setLocalFiles({});
    setUploadingPreview(null);
    setVisionAttachmentIds([]);
  }, [props.currentConversationId]);

  useEffect(() => {
    const imported = props.libraryAttachments;
    if (!imported || imported.conversationId !== props.currentConversationId) return;
    setPendingAttachments(current => [...current, ...imported.attachments.filter(item => !current.some(existing => existing.id === item.id))]);
    props.onLibraryAttachmentsConsumed?.();
  }, [props.currentConversationId, props.libraryAttachments, props.onLibraryAttachmentsConsumed]);

  useEffect(() => () => {
    Object.values(previewUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const uploadAttachment = useCallback(async (file?: File) => {
    if (!file || currentConversationRef.current !== props.currentConversationId) return false;
    const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
    if (previewUrl) setUploadingPreview({ filename: file.name || "粘贴的图片", url: previewUrl });
    try {
      const attachment = await props.onUploadAttachment(file);
      if (currentConversationRef.current !== props.currentConversationId) {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        void props.onRemoveAttachment(attachment.id).catch(() => undefined);
        return false;
      }
      if (previewUrl) {
        previewUrlsRef.current[attachment.id] = previewUrl;
        setPreviewUrls({ ...previewUrlsRef.current });
      }
      setPendingAttachments((current) => [...current, attachment]);
      setLocalFiles(current => ({ ...current, [attachment.id]: file }));
      if (attachment.kind === "image") {
        setVisionAttachmentIds((current) => [...current, attachment.id]);
      }
      setUploadingPreview(null);
      return true;
    } catch (error) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setUploadingPreview(null);
      throw error;
    }
  }, [props]);

  const removePendingAttachment = useCallback(async (attachmentId: string) => {
    await props.onRemoveAttachment(attachmentId);
    const previewUrl = previewUrlsRef.current[attachmentId];
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      delete previewUrlsRef.current[attachmentId];
      setPreviewUrls({ ...previewUrlsRef.current });
    }
    setPendingAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
    setLocalFiles(current => { const next = { ...current }; delete next[attachmentId]; return next; });
    setVisionAttachmentIds((current) => current.filter((id) => id !== attachmentId));
  }, [props]);

  return {
    pendingAttachments, previewUrls, uploadingPreview, localFiles, visionAttachmentIds,
    uploadAttachment, removePendingAttachment, clearSubmittedAttachments, clearSentAttachments,
  };
}
