import { ApiError, createApiClient, fetchWithTimeout } from "../../api/client";
import type { ImageEditRequest, ImageEditResult } from "../chat/ImageEditor";
import type { ChatAttachment } from "../chat/types";

export type StudioImageOperation = { sizes: string[] };
export type StudioImageCapabilities = { generate: StudioImageOperation; edit: StudioImageOperation | null };
export type StudioModel = { id: string; name: string; sizes: string[]; capabilities?: StudioImageCapabilities };
export type StudioOptions = { default_profile_id: string | null; models: StudioModel[]; can_edit?: boolean };
export type StudioStatus = "running" | "done" | "failed" | "uncertain";
export type StudioTask = {
  id: string; prompt: string; size: string; profile_id: string | null; model_name: string;
  status: StudioStatus; created_at: string; conversation_id: number | null; assets: ChatAttachment[];
  error?: string | null; source_asset_id?: string | null;
};
export type StudioWork = { id: string; asset: ChatAttachment; created_at: string };
export type StudioRequest = { request_id: string; prompt: string; profile_id: string | null; size: string };
export type StudioHistoryQuery = { offset?: number; limit?: number; q?: string; status?: StudioStatus; signal?: AbortSignal };

const GENERATION_TIMEOUT = 330_000;
const jsonBody = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export function createImageStudioApi(apiBase: string, accessToken: string, fetchJson: ReturnType<typeof createApiClient>) {
  const assetPath = (id: string) => `/chat-assets/${encodeURIComponent(id)}`;
  async function blob(path: string, signal?: AbortSignal): Promise<Blob> {
    // Use the shared desktop/web transport; image URLs alone must never grant access.
    const response = await fetchWithTimeout(`${apiBase}${path}`, { signal, headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
    if (!response.ok) throw new ApiError(response.status === 404 ? "找不到这张图片" : `无法读取图片（${response.status}）`, response.status);
    return response.blob();
  }
  return {
    async options(signal?: AbortSignal) {
      const options = await fetchJson<StudioOptions>("/image-studio/options", { signal });
      return {
        ...options,
        models: options.models.map(model => ({ ...model, sizes: model.capabilities?.generate.sizes ?? model.sizes })),
      };
    },
    history({ offset, limit, q, status, signal }: StudioHistoryQuery = {}) {
      const params = new URLSearchParams();
      if (offset != null) params.set("offset", String(offset));
      if (limit != null) params.set("limit", String(limit));
      if (q?.trim()) params.set("q", q.trim());
      if (status) params.set("status", status);
      return fetchJson<{ items: StudioTask[]; has_more: boolean }>(`/image-studio/history${params.size ? `?${params}` : ""}`, { signal });
    },
    task: (id: string, signal?: AbortSignal) => fetchJson<StudioTask>(`/image-studio/tasks/${encodeURIComponent(id)}`, { signal }),
    generate: (body: StudioRequest) => fetchJson<{ id: string }>("/image-studio/generate", jsonBody(body), GENERATION_TIMEOUT),
    works: (signal?: AbortSignal) => fetchJson<{ items: StudioWork[] }>("/image-studio/works", { signal }),
    archive: (assetId: string) => fetchJson<StudioWork>(`/image-studio/works/${encodeURIComponent(assetId)}`, { method: "POST" }),
    assetFile: (id: string, signal?: AbortSignal) => blob(`${assetPath(id)}/file`, signal),
    thumbnail: (id: string, signal?: AbortSignal) => blob(`${assetPath(id)}/thumbnail`, signal),
    workFile: (id: string, signal?: AbortSignal) => blob(`/image-studio/works/${encodeURIComponent(id)}/file`, signal),
    workThumbnail: (id: string, signal?: AbortSignal) => blob(`/image-studio/works/${encodeURIComponent(id)}/thumbnail`, signal),
    edit: (id: string, request: ImageEditRequest) => fetchJson<ImageEditResult>(`${assetPath(id)}/edits`, jsonBody(request), GENERATION_TIMEOUT),
  };
}
export type ImageStudioApi = ReturnType<typeof createImageStudioApi>;
