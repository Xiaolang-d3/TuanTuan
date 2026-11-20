import { createApiClient, fetchWithTimeout } from "../../api/client";
import { createActivityService, type BackgroundJob, type FileArtifact } from "./activity-service";

// Full integrity checks on a cold disk can exceed the ordinary API timeout.
export const PRESENTATION_SETUP_TIMEOUT_MS = 120_000;

export type PresentationJob = Pick<BackgroundJob, "id" | "status" | "revision" | "cancel_requested" | "error" | "prompt"> & {
  stage: string; confirmation_required: boolean; generation_available: boolean;
  topic?: string; page_count?: number; conversation_id?: number | null; model_name?: string;
  kind?: string; title?: string; source_count?: number; preview_available?: boolean;
  error_code?: string; error_stage?: string; created_at?: string;
  retryable?: boolean; retry_requires_confirmation?: boolean;
  delivery_artifacts?: Array<Pick<FileArtifact, "id" | "version" | "filename">>;
  progress?: {
    activity: string | null; started_at: string | null;
    pages_completed: number; pages_total: number | null; outcome_uncertain: boolean;
  };
};
export type PresentationCapabilities = {
  available: boolean; code: string; reason: string;
  limits: { min_pages: number; max_pages: number; language: string; canvas: string };
  model_name?: string;
};
export type QuickPresentationCapabilities = { composer: boolean; available: boolean; code: string; reason: string };

export function currentPresentationArtifacts(job: PresentationJob, artifacts: FileArtifact[]) {
  if (job.delivery_artifacts) return artifacts.filter(artifact => job.delivery_artifacts!.some(item => item.id === artifact.id && item.version === artifact.version));
  const latest = new Map<string, FileArtifact>();
  for (const artifact of artifacts) if (!latest.has(artifact.filename) || latest.get(artifact.filename)!.version < artifact.version) latest.set(artifact.filename, artifact);
  return [...latest.values()];
}

export function createPresentationService(apiBase: string, accessToken: string) {
  const request = createApiClient(apiBase, accessToken);
  const activity = createActivityService(apiBase, accessToken);
  const path = (id: string) => `/presentations/${encodeURIComponent(id)}`;
  return {
    activity,
    capabilities: (signal?: AbortSignal, conversationId?: number) => request<PresentationCapabilities>(`/presentations/capabilities${conversationId ? `?conversation_id=${conversationId}` : ""}`, { signal, cache: "no-store" }, PRESENTATION_SETUP_TIMEOUT_MS),
    quickCapabilities: (conversationId: number, signal?: AbortSignal) => request<QuickPresentationCapabilities>(`/presentations/quick/capabilities?conversation_id=${conversationId}`, { signal, cache: "no-store" }),
    createQuick: (topic: string, attachmentIds: string[], conversationId: number, key: string) => request<PresentationJob>("/presentations/quick", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, attachment_ids: attachmentIds, conversation_id: conversationId, idempotency_key: key })
    }),
    list: (conversationId: number, signal?: AbortSignal, before?: string) => request<{ jobs: PresentationJob[]; next_cursor: string | null }>(`/presentations?conversation_id=${conversationId}${before ? `&before=${encodeURIComponent(before)}` : ""}`, { signal, cache: "no-store" }),
    create: (topic: string, pages: number, key: string, conversationId?: number) => request<PresentationJob>("/presentations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, options: { page_count: pages }, idempotency_key: key, conversation_id: conversationId })
    }, PRESENTATION_SETUP_TIMEOUT_MS),
    get: (id: string, signal?: AbortSignal) => request<PresentationJob>(path(id), { signal, cache: "no-store" }),
    cancel: (id: string) => request<PresentationJob>(`${path(id)}/cancel`, { method: "POST" }),
    resume: (id: string) => request<PresentationJob>(`${path(id)}/resume`, { method: "POST" }),
    retry: (id: string, body: { expected_revision: number; request_id: string; topic?: string; page_count?: number; acknowledge_uncertain?: boolean }) => request<PresentationJob>(`${path(id)}/retry`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }, PRESENTATION_SETUP_TIMEOUT_MS),
    async confirmation(id: string) {
      const native = (window as Window & { __TAURI__?: { core?: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> } } }).__TAURI__?.core?.invoke;
      if (native) {
        await native("desktop_open_presentation_confirmation", { jobId: id, authorization: `Bearer ${accessToken}` });
        return "";
      }
      if (new URL(apiBase, window.location.href).origin !== window.location.origin) {
        // Open before the first await to preserve the button's user activation.
        const popup = window.open("about:blank", "_blank");
        if (!popup) throw new Error("请允许弹出窗口后重新打开确认页。");
        popup.opener = null;
        popup.document.title = "正在打开确认页";
        popup.document.body.textContent = "正在准备确认页…";
        try {
          const session = await request<{ ticket: string }>(`${path(id)}/confirmation-session`, { method: "POST" });
          const form = popup.document.createElement("form");
          form.method = "POST";
          form.action = `${apiBase}${path(id)}/confirmation-open`;
          const ticket = popup.document.createElement("input");
          ticket.type = "hidden"; ticket.name = "ticket"; ticket.value = session.ticket;
          form.append(ticket); popup.document.body.replaceChildren(form); form.submit();
          return "";
        } catch (error) { popup.close(); throw error; }
      }
      const session = await request<{ ticket: string }>(`${path(id)}/confirmation-session`, { method: "POST" });
      const bootstrap = await fetchWithTimeout(`${apiBase}${path(id)}/confirmation-bootstrap`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: session.ticket, surface_origin: window.location.origin })
      });
      if (!bootstrap.ok) throw new Error("确认页已过期，请刷新任务后重新打开。");
      return `${apiBase}${path(id)}/confirmation/`;
    },
    async preview(artifact: FileArtifact, signal?: AbortSignal) {
      const response = await fetchWithTimeout(`${apiBase}/artifacts/${encodeURIComponent(artifact.id)}/versions/${artifact.version}/file`, {
        headers: { Authorization: `Bearer ${accessToken}` }, signal, cache: "no-store"
      });
      if (!response.ok) throw new Error("页面预览读取失败，请重试。");
      return URL.createObjectURL(await response.blob());
    }
  };
}
export type PresentationService = ReturnType<typeof createPresentationService>;
