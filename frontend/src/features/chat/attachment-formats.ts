export const MAX_CHAT_ATTACHMENTS = 8;
export const CHAT_ATTACHMENT_ACCEPT = ".png,.jpg,.jpeg,.webp,.pdf,.docx,.txt,.md,image/png,image/jpeg,image/webp,application/pdf";
export const DOCUMENT_ATTACHMENT_ACCEPT = ".pdf,.docx,.txt,.md,application/pdf";

export function chatAttachmentKind(filename: string): "image" | "document" | null {
  if (/\.(png|jpe?g|webp)$/i.test(filename)) return "image";
  if (/\.(pdf|docx|txt|md)$/i.test(filename)) return "document";
  return null;
}
