import type { Conversation } from "../../types";
import { creationKinds, type CreationKind, type FetchCreationJson } from "./creationRecordsApi";

export type ProjectKind = CreationKind | "library" | "image_work" | "final_work";
export type ProjectStatus = "active" | "archived";
export type Project = { id: string; name: string; description: string; status: ProjectStatus; created_at: string; updated_at: string; default_model_profile_id: string | null };
export type ProjectModelOption = { id: string; label: string };
export type ProjectItem = { kind: ProjectKind; source_id: string; title: string; conversation_id: number | null };
export type ProjectDetail = Project & { items: ProjectItem[] };
export type ProjectInput = { name: string; description: string };
export const projectKinds: Record<ProjectKind, string> = { ...creationKinds, library: "知识库资料", image_work: "图片作品", final_work: "文档 / PPT 定稿" };

export function createProjectsApi(fetchJson: FetchCreationJson) {
  const path = (id: string) => `/projects/${encodeURIComponent(id)}`;
  const body = (method: "POST" | "PATCH", payload: unknown): RequestInit => ({
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  return {
    list: (signal: AbortSignal) => fetchJson<{ items: Project[] }>("/projects", { signal }),
    detail: (id: string, signal: AbortSignal) => fetchJson<ProjectDetail>(path(id), { signal }),
    create: (input: ProjectInput, signal: AbortSignal) => fetchJson<Project>("/projects", { ...body("POST", input), signal }),
    update: (id: string, input: Partial<ProjectInput & Pick<Project, "status" | "default_model_profile_id">>, signal: AbortSignal) => fetchJson<Project>(path(id), { ...body("PATCH", input), signal }),
    createConversation: (id: string, sourceIds: number[], signal: AbortSignal) => fetchJson<Conversation>(`${path(id)}/conversations`, { ...body("POST", { source_ids: sourceIds }), signal }),
    remove: (id: string, signal: AbortSignal) => fetchJson<void>(path(id), { method: "DELETE", signal }),
    addItem: (id: string, item: ProjectItem, signal: AbortSignal) => fetchJson<ProjectItem>(`${path(id)}/items`, { ...body("POST", { kind: item.kind, source_id: item.source_id }), signal }),
    removeItem: (id: string, item: ProjectItem, signal: AbortSignal) => fetchJson<void>(`${path(id)}/items/${item.kind}/${encodeURIComponent(item.source_id)}`, { method: "DELETE", signal }),
  };
}
