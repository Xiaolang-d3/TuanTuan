import { createApiClient, fetchWithTimeout } from "../../api/client";
export type ExportFormat = "docx" | "pdf";
export type DocumentExport = { format: ExportFormat; job: { id: string; status: string; error?: string }; artifact: { id: string; version: number; filename: string } | null };
export type ExportCapabilities = { formats: Record<ExportFormat, { available: boolean; reason: string }> };
export interface DocumentExportService {
  capabilities(signal?: AbortSignal): Promise<ExportCapabilities>;
  list(id: string, version: number, signal?: AbortSignal): Promise<{ exports: DocumentExport[] }>;
  start(id: string, version: number, format: ExportFormat, signal?: AbortSignal): Promise<DocumentExport>;
  cancel(jobId: string, signal?: AbortSignal): Promise<unknown>;
  resume(jobId: string, signal?: AbortSignal): Promise<unknown>;
  file(id: string, version: number, signal?: AbortSignal): Promise<Blob>;
}
export function createDocumentExportService(base: string, token: string): DocumentExportService {
  const request = createApiClient(base, token);
  const path = (id: string, version: number) => `/documents/${encodeURIComponent(id)}/versions/${version}/exports`;
  return {
    capabilities: signal => request("/document-export-capabilities", { signal, cache: "no-store" }),
    list: (id, version, signal) => request(path(id, version), { signal, cache: "no-store" }),
    start: (id, version, format, signal) => request(path(id, version), { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format }) }),
    cancel: (id, signal) => request(`/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", signal }),
    resume: (id, signal) => request(`/jobs/${encodeURIComponent(id)}/resume`, { method: "POST", signal }),
    async file(id, version, signal) {
      const response = await fetchWithTimeout(`${base}/artifacts/${encodeURIComponent(id)}/versions/${version}/file`, { signal, cache: "no-store", headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error("文件无法下载，请重新导出此保存版本");
      return response.blob();
    },
  };
}
