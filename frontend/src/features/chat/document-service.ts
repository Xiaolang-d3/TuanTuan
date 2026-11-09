import { createApiClient, fetchWithTimeout } from "../../api/client";
import type { ChatAttachment } from "./types";
import type { LibrarySourceDetail } from "../../types";
import { createDocumentExportService, type DocumentExportService } from "./document-export-service";

export type DocumentResource = { id: string; uri: string; filename: string; mime_type: string; sha256: string; size_bytes: number };
export type SavedDocument = { document_id: string; version: number; latest_version: number; parent_document_version: number | null;
  conversation_id: number; message_id: number; title: string; markdown: string; evidence: unknown[];
  citations: { citation_id: string; status: string }[]; resources: DocumentResource[]; incomplete: boolean; created_at: string };
export type DocumentSummary = Pick<SavedDocument, "document_id" | "latest_version" | "conversation_id" | "message_id" | "title" | "created_at">;
export type DocumentVersionSummary = Pick<SavedDocument, "version" | "parent_document_version" | "created_at">;
export interface DocumentService {
  exports?: DocumentExportService;
  create(input: { conversation_id: number; message_id: number; snapshot: string; idempotency_key: string }, signal?: AbortSignal): Promise<SavedDocument>;
  list(signal?: AbortSignal): Promise<{ documents: DocumentSummary[] }>;
  latest(id: string, signal?: AbortSignal): Promise<SavedDocument>;
  get(id: string, version: number, signal?: AbortSignal): Promise<SavedDocument>;
  versions(id: string, signal?: AbortSignal): Promise<{ versions: DocumentVersionSummary[] }>;
  save(id: string, input: { base_version: number; markdown: string; idempotency_key: string }, signal?: AbortSignal): Promise<SavedDocument>;
  archive(id: string, version: number, input: { filename: string; folder_id: number | null; enabled: boolean; idempotency_key: string }, signal?: AbortSignal): Promise<{ source: LibrarySourceDetail; reused: boolean }>;
  resource(id: string, resourceId: string, signal?: AbortSignal): Promise<Blob>;
  attach(id: string, version: number, conversationId: number, key: string, signal?: AbortSignal): Promise<ChatAttachment>;
  delete(id: string, signal?: AbortSignal): Promise<{ deleted: boolean }>;
}
export function createDocumentService(apiBase: string, accessToken: string): DocumentService {
  const request = createApiClient(apiBase, accessToken);
  const path = (id: string) => `/documents/${encodeURIComponent(id)}`;
  const post = <T,>(url: string, body: unknown, signal?: AbortSignal) => request<T>(url, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return {
    exports: createDocumentExportService(apiBase, accessToken),
    create: ({ conversation_id, ...body }, signal) => post(`/conversations/${conversation_id}/documents`, body, signal),
    list: signal => request("/documents", { signal, cache: "no-store" }),
    latest: (id, signal) => request(path(id), { signal, cache: "no-store" }),
    get: (id, version, signal) => request(`${path(id)}/versions/${version}`, { signal, cache: "no-store" }),
    versions: (id, signal) => request(`${path(id)}/versions`, { signal, cache: "no-store" }),
    save: (id, input, signal) => post(`${path(id)}/versions`, input, signal),
    archive: (id, version, input, signal) => post(`${path(id)}/versions/${version}/archive`, input, signal),
    attach: (id, version, conversationId, key, signal) => post(`${path(id)}/versions/${version}/attachments`, { conversation_id: conversationId, idempotency_key: key }, signal),
    delete: (id, signal) => request(path(id), { method: "DELETE", signal }),
    async resource(id, resourceId, signal) {
      const response = await fetchWithTimeout(`${apiBase}${path(id)}/resources/${encodeURIComponent(resourceId)}/file`, { signal, cache: "no-store", headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) throw new Error("文档图片无法读取，请核对该保存版本的资源");
      return response.blob();
    },
  };
}
