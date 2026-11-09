import { createApiClient, fetchWithTimeout } from "../../api/client";

export type BackgroundJob = {
  id: string;
  kind: string;
  request: Record<string, unknown>;
  status: "queued" | "running" | "waiting_user" | "succeeded" | "failed" | "cancelled" | "interrupted";
  revision: number;
  stage_id?: string | null;
  prompt?: string;
  answer_schema?: { type?: string; properties?: Record<string, { type?: string; [key: string]: unknown }>; required?: string[]; [key: string]: unknown };
  checkpoint?: Record<string, unknown>;
  cancel_requested: boolean;
  error?: string;
};
export type FileArtifact = { id: string; version: number; filename: string; size: number; media_type: string };
export type JobEvent = { cursor: number; type: string; data: Record<string, unknown> };
export type ExecutionStatus = { available: boolean; code: string; reason: string };
export interface ActivityService {
  environment(signal?: AbortSignal): Promise<ExecutionStatus>;
  list(signal?: AbortSignal): Promise<{ jobs: BackgroundJob[] }>;
  get(id: string, signal?: AbortSignal): Promise<BackgroundJob>;
  events(id: string, signal?: AbortSignal): Promise<{ events: JobEvent[] }>;
  artifacts(id: string, signal?: AbortSignal): Promise<{ artifacts: FileArtifact[] }>;
  confirm(id: string, stageId: string, revision: number, answer: Record<string, unknown>): Promise<BackgroundJob>;
  cancel(id: string): Promise<BackgroundJob>;
  resume(id: string): Promise<BackgroundJob>;
  download(artifact: FileArtifact): Promise<void>;
}

export function createActivityService(apiBase: string, accessToken: string): ActivityService {
  const request = createApiClient(apiBase, accessToken);
  const path = (id: string) => `/jobs/${encodeURIComponent(id)}`;
  return {
    environment: signal => request("/execution/status", { signal }),
    list: signal => request("/jobs", { signal }),
    get: (id, signal) => request(path(id), { signal }),
    events: (id, signal) => request(`${path(id)}/events`, { signal }),
    artifacts: (id, signal) => request(`${path(id)}/artifacts`, { signal }),
    confirm: (id, stageId, revision, answer) => request(`${path(id)}/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage_id: stageId, revision, answer }) }),
    cancel: id => request(`${path(id)}/cancel`, { method: "POST" }),
    resume: id => request(`${path(id)}/resume`, { method: "POST" }),
    async download(artifact) {
      const response = await fetchWithTimeout(`${apiBase}/artifacts/${encodeURIComponent(artifact.id)}/versions/${artifact.version}/file`, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
      if (!response.ok) throw new Error("文件下载失败，请刷新成果列表后重试");
      const url = URL.createObjectURL(await response.blob());
      try {
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = artifact.filename;
        document.body.appendChild(anchor); anchor.click(); anchor.remove();
      } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
  };
}
