export type BlockLocator = {
  kind: "pdf_page" | "docx_paragraph" | "docx_table" | "text_range";
  page?: number; paragraph?: number; table?: number;
  start?: number; end?: number; text_start?: number; text_end?: number; precise?: boolean;
};
export type LocalEvidence = {
  citation_id: string; source_revision: string; block_id: string; title: string;
  locator: BlockLocator; excerpt: string; excerpt_hash: string; usage?: "automatic" | "explicit";
} & ({ source_kind: "library"; source_id: number; attachment_id?: never }
  | { source_kind: "attachment"; attachment_id: string; conversation_id: number; source_id?: never });
export type LocalSourceOriginal = {
  available: boolean; reason?: string; filename?: string; mime_type?: string;
  source_kind?: "library" | "attachment"; source_id?: number; attachment_id?: string;
};
export type LocalSourcePreview = {
  title: string; locator: BlockLocator; text: string; model_text: string; is_current: boolean; original: LocalSourceOriginal;
};
export function locatorLabel(locator: BlockLocator): string {
  if (locator.kind === "pdf_page" && locator.page) return `第 ${locator.page} 页`;
  if (locator.kind === "docx_paragraph" && locator.paragraph) return `第 ${locator.paragraph} 段`;
  if (locator.kind === "docx_table" && locator.table) return `表格 ${locator.table}`;
  return locator.precise === false ? "提取文字" : "文字片段";
}
export function isLocalEvidence(value: unknown): value is LocalEvidence {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<LocalEvidence>;
  return typeof item.citation_id === "string" && /^e_[0-9a-f]{32}$/.test(item.citation_id)
    && typeof item.source_revision === "string" && /^[0-9a-f]{64}$/.test(item.source_revision)
    && typeof item.block_id === "string" && /^[0-9a-f]{32}$/.test(item.block_id)
    && typeof item.title === "string" && typeof item.excerpt === "string" && !!item.locator
    && (item.source_kind === "library" ? typeof item.source_id === "number" && !item.attachment_id
      : item.source_kind === "attachment" && typeof item.attachment_id === "string" && typeof item.conversation_id === "number" && !item.source_id);
}
