export type CreationKind = "chat" | "image" | "document" | "presentation";
export type CreationRecord = {
  kind: CreationKind;
  id: string;
  title: string;
  updated_at: string;
  conversation_id: number | null;
  status: string | null;
};
export type FetchCreationJson = <T>(path: string, init?: RequestInit) => Promise<T>;
export type CreationPage = { items: CreationRecord[]; has_more: boolean };

export const creationKinds: Record<CreationKind, string> = {
  chat: "对话", image: "图片", document: "文档", presentation: "PPT",
};

export function readCreationRecords(fetchJson: FetchCreationJson, options: {
  kind?: CreationKind; limit: number; offset?: number; signal: AbortSignal;
}) {
  const query = new URLSearchParams({ limit: String(options.limit) });
  if (options.offset) query.set("offset", String(options.offset));
  if (options.kind) query.set("kind", options.kind);
  return fetchJson<CreationPage>(`/creation-records?${query}`, { signal: options.signal });
}
