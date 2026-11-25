import { creationKinds, type CreationKind, type FetchCreationJson } from "./creationRecordsApi";

export type ProjectKind = CreationKind | "library";
export type Project = { id: string; name: string; description: string; created_at: string; updated_at: string };
export type ProjectItem = { kind: ProjectKind; source_id: string; title: string; conversation_id: number | null };
export type ProjectDetail = Project & { items: ProjectItem[] };
export type ProjectInput = { name: string; description: string };
export const projectKinds: Record<ProjectKind, string> = { ...creationKinds, library: "知识库资料" };

export function createProjectsApi(fetchJson: FetchCreationJson) {
  const path = (id: string) => `/projects/${encodeURIComponent(id)}`;
  const body = (method: "POST" | "PATCH", payload: unknown): RequestInit => ({
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  return {
    list: (signal: AbortSignal) => fetchJson<{ items: Project[] }>("/projects", { signal }),
    detail: (id: string, signal: AbortSignal) => fetchJson<ProjectDetail>(path(id), { signal }),
    create: (input: ProjectInput) => fetchJson<Project>("/projects", body("POST", input)),
    update: (id: string, input: ProjectInput) => fetchJson<Project>(path(id), body("PATCH", input)),
    remove: (id: string) => fetchJson<void>(path(id), { method: "DELETE" }),
    addItem: (id: string, item: ProjectItem) => fetchJson<ProjectItem>(`${path(id)}/items`, body("POST", { kind: item.kind, source_id: item.source_id })),
    removeItem: (id: string, item: ProjectItem) => fetchJson<void>(`${path(id)}/items/${item.kind}/${encodeURIComponent(item.source_id)}`, { method: "DELETE" }),
  };
}
