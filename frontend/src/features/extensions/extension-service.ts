import { createApiClient } from "../../api/client";
import type { ExtensionKind, ExtensionSummary, McpDraft, OnlineSkill, SkillPreview } from "./types";
import { createActivityService } from "./activity-service";
import { createPresentationService, PRESENTATION_SETUP_TIMEOUT_MS } from "./presentation-service";

type ServerExtension = ExtensionSummary & { content?: string; unavailable_reason?: string };
export type ExtensionExecution = { available: boolean; reason: string; adapter?: "quick-ppt" | "ppt-master"; code?: string };
export type ExtensionCatalog = { extensions: ServerExtension[]; connections: McpDraft[]; execution: ExtensionExecution };
const normalize = (item: ServerExtension): ExtensionSummary => ({ ...item, instructions: item.content, unavailableReason: item.unavailable_reason });

export function createExtensionService(apiBase: string, accessToken: string) {
  const request = createApiClient(apiBase, accessToken);
  return {
    activity: createActivityService(apiBase, accessToken),
    presentations: createPresentationService(apiBase, accessToken),
    searchSkills(query: string, signal?: AbortSignal) { return request<{ skills: OnlineSkill[] }>(`/extensions/skills/search?q=${encodeURIComponent(query)}`, { signal }); },
    previewSkills(source: string, ref?: string, name?: string, signal?: AbortSignal) {
      return request<SkillPreview>("/extensions/skills/preview", { method: "POST", signal, body: JSON.stringify({ source, ref, name }), headers: { "Content-Type": "application/json" } });
    },
    async installSkill(preview_id: string, path: string) {
      return normalize(await request<ServerExtension>("/extensions/skills/install", { method: "POST", body: JSON.stringify({ preview_id, path }), headers: { "Content-Type": "application/json" } }));
    },
    async list(signal?: AbortSignal): Promise<ExtensionCatalog> {
      const result = await request<ExtensionCatalog>("/extensions", { signal, cache: "no-store" }, PRESENTATION_SETUP_TIMEOUT_MS);
      return { ...result, extensions: result.extensions.map(normalize) };
    },
    async detail(id: string) { return normalize(await request<ServerExtension>(`/extensions/${encodeURIComponent(id)}`)); },
    async importContent(kind: ExtensionKind, content: string) { return normalize(await request<ServerExtension>(`/extensions/${kind === "skill" ? "skills" : "plugins"}`, { method: "POST", body: JSON.stringify({ content }), headers: { "Content-Type": "application/json" } })); },
    async importFile(file: File) { const form = new FormData(); form.append("file", file); return normalize(await request<ServerExtension>("/extensions/import", { method: "POST", body: form })); },
    setEnabled(id: string, enabled: boolean) { return request(`/extensions/${encodeURIComponent(id)}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled }), headers: { "Content-Type": "application/json" } }); },
    remove(id: string) { return request(`/extensions/${encodeURIComponent(id)}`, { method: "DELETE" }); },
    addConnection(draft: McpDraft) { return request("/extensions/mcp", { method: "POST", body: JSON.stringify({ name: draft.name, transport: draft.transport, endpoint: draft.endpoint }), headers: { "Content-Type": "application/json" } }); },
    removeConnection(id: string) { return request(`/extensions/mcp/${encodeURIComponent(id)}`, { method: "DELETE" }); }
  };
}
