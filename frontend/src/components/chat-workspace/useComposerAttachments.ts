import { useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent } from "react";
import { chatAttachmentKind, MAX_CHAT_ATTACHMENTS } from "../../features/chat/attachment-formats";
import type { ChatAttachment, ChatWorkspaceProps } from "../../features/chat/types";

type ComposerAttachmentOptions = Pick<ChatWorkspaceProps,
  "attachmentBusy" | "chatBusy" | "currentConversationId" | "draftFiles" | "onAttachmentInvalid" | "onDraftFilesChange"
> & {
  pendingAttachments: ChatAttachment[];
  onUpload: (file?: File) => Promise<boolean>;
};

/** 校验输入区选择、拖放或粘贴的附件，并复用当前会话的上传入口。 */
export function useComposerAttachments(props: ComposerAttachmentOptions, quickMode: boolean, quickBusy: boolean) {
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [isDraggingAttachment, setIsDraggingAttachment] = useState(false);
  const draftFiles = props.draftFiles ?? [];
  const hasDraftFiles = draftFiles.length > 0;

  async function acceptAttachment(file: File): Promise<"added" | "invalid" | "failed"> {
    const kind = chatAttachmentKind(file.name);
    if (quickMode && kind !== "document") {
      props.onAttachmentInvalid("PPT 制作支持 Word（DOCX）、文字版 PDF、TXT 或 Markdown。");
      return "invalid";
    }
    if (!kind) {
      props.onAttachmentInvalid("仅支持图片（PNG、JPG、WEBP）或文档（PDF、DOCX、TXT、MD）。");
      return "invalid";
    }
    try {
      return await props.onUpload(file) ? "added" : "failed";
    } catch {
      return "failed";
    }
  }

  async function uploadDraftFile(index: number) {
    const file = draftFiles[index];
    const conversationId = props.currentConversationId;
    if (!file || !conversationId || props.attachmentBusy || props.chatBusy || quickBusy) return;
    if (await acceptAttachment(file) === "added") {
      props.onDraftFilesChange?.(conversationId, draftFiles.filter((_, itemIndex) => itemIndex !== index));
    }
  }

  async function selectAttachments(files: File[]) {
    if (!files.length || props.attachmentBusy) return;
    const room = MAX_CHAT_ATTACHMENTS - props.pendingAttachments.length - draftFiles.length;
    if (room <= 0) {
      props.onAttachmentInvalid("一次最多附加 8 个文件。");
      return;
    }
    const batch = files.slice(0, room);
    if (files.length > room) props.onAttachmentInvalid("一次最多附加 8 个文件，多出的没有添加。");
    for (const file of batch) {
      if (await acceptAttachment(file) === "failed") break;
    }
  }

  function handleAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    void selectAttachments(Array.from(event.target.files ?? []));
    event.currentTarget.value = "";
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (!props.attachmentBusy) setIsDraggingAttachment(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.currentTarget === event.target) setIsDraggingAttachment(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDraggingAttachment(false);
    void selectAttachments(Array.from(event.dataTransfer.files ?? []));
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const clipboardFiles = Array.from(event.clipboardData.files);
    if (!clipboardFiles.length || props.attachmentBusy) return;
    const supported = clipboardFiles.flatMap((clipboardFile, index) => {
      const filename = clipboardFile.name.toLowerCase();
      const accepted = clipboardFile.type.startsWith("image/") || /\.(png|jpe?g|webp|pdf|docx|txt|md)$/.test(filename);
      if (!accepted) return [];
      if (clipboardFile.name) return [clipboardFile];
      const extension = clipboardFile.type.split("/")[1] || "png";
      const suffix = clipboardFiles.length > 1 ? `-${index + 1}` : "";
      return [new File([clipboardFile], `粘贴的图片${suffix}.${extension}`, { type: clipboardFile.type })];
    });
    if (!supported.length) return;
    event.preventDefault();
    void selectAttachments(supported);
  }

  return {
    attachmentInputRef, isDraggingAttachment, draftFiles, hasDraftFiles, uploadDraftFile,
    handleAttachmentChange, handleDragOver, handleDragLeave, handleDrop, handleComposerPaste,
  };
}
