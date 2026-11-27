import { fetchWithTimeout, type createApiClient } from "../../api/client";

export type FinalWork = {
  id: string;
  kind: "document" | "presentation";
  filename: string;
  created_at: string;
  media_type: string;
  size: number;
};

export function createFinalWorksApi(apiBase: string, accessToken: string, request: ReturnType<typeof createApiClient>) {
  return {
    list: (signal?: AbortSignal) => request<{ items: FinalWork[] }>("/works/final", { signal, cache: "no-store" }),
    archiveDocument: (id: string, version: number, signal?: AbortSignal) => request<FinalWork>(`/works/final/documents/${encodeURIComponent(id)}/versions/${version}`, { method: "POST", signal }),
    archivePresentation: (id: string, version: number, signal?: AbortSignal) => request<FinalWork>(`/works/final/artifacts/${encodeURIComponent(id)}/versions/${version}`, { method: "POST", signal }),
    async file(id: string, signal?: AbortSignal) {
      const response = await fetchWithTimeout(`${apiBase}/works/final/${encodeURIComponent(id)}/file`, {
        signal, cache: "no-store", headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) throw new Error("无法下载定稿，请刷新作品列表后重试。");
      return response.blob();
    },
  };
}
