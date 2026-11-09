import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { createExtensionPreview, parsePlugin, parseSkill } from "./preview-service";
import { createExtensionService } from "./extension-service";
import type { ExtensionKind, ExtensionSummary, McpDraft } from "./types";

function useExtensionState(apiBase?: string, accessToken?: string) {
  const service = useMemo(() => apiBase && accessToken ? createExtensionService(apiBase, accessToken) : null, [apiBase, accessToken]);
  const [store] = useState(createExtensionPreview);
  const [items, setItems] = useState<ExtensionSummary[]>(() => service ? [] : store.list());
  const [connections, setConnections] = useState<McpDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [executionReason, setExecutionReason] = useState("");
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!service) return;
    setLoading(true);
    try {
      const catalog = await service.list(signal);
      if (signal?.aborted) return;
      setItems(catalog.extensions); setConnections(catalog.connections); setExecutionReason(catalog.execution.reason); setError("");
    } catch (caught) {
      if (!signal?.aborted) setError(caught instanceof Error ? caught.message : "扩展目录读取失败");
      throw caught;
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [service]);
  async function mutate<T>(operation: () => Promise<T>) {
    setBusy(true); setError("");
    try { const result = await operation(); await refresh(); return result; }
    catch (caught) { setError(caught instanceof Error ? caught.message : "扩展操作失败"); throw caught; }
    finally { setBusy(false); }
  }
  return {
    items, connections, loading, busy, error, executionReason, isPreview: !service,
    activityService: service?.activity,
    presentationService: service?.presentations,
    discoveryService: service,
    refresh,
    async importContent(kind: ExtensionKind, content: string) {
      if (service) return mutate(() => service.importContent(kind, content));
      const item = kind === "skill" ? parseSkill(content) : parsePlugin(content);
      store.add(item); setItems(store.list()); return item;
    },
    async importFile(file: File) {
      if (!service) throw new Error("ZIP 安装需要连接后端");
      return mutate(() => service.importFile(file));
    },
    async loadDetail(id: string) {
      if (!service) return;
      try { const item = await service.detail(id); setItems((current) => current.map((entry) => entry.id === id ? item : entry)); }
      catch (caught) { setError(caught instanceof Error ? caught.message : "详情读取失败"); }
    },
    async toggle(id: string) {
      if (service) { await mutate(() => service.setEnabled(id, !items.find((item) => item.id === id)?.enabled)); return; }
      store.toggle(id); setItems(store.list());
    },
    async remove(id: string) {
      if (service) { await mutate(() => service.remove(id)); return; }
      store.remove(id); setItems(store.list());
    },
    async addConnection(draft: McpDraft) {
      if (service) { await mutate(() => service.addConnection(draft)); return; }
      if (connections.some((item) => item.name === draft.name)) throw new Error("同名 MCP 配置已存在。");
      setConnections((current) => [...current, draft]);
    },
    async removeConnection(id: string) {
      if (service) { await mutate(() => service.removeConnection(id)); return; }
      setConnections((current) => current.filter((item) => item.id !== id));
    }
  };
}
const PreviewContext = createContext<ReturnType<typeof useExtensionState> | null>(null);
export function ExtensionPreviewProvider({ children, apiBase, accessToken }: { children: ReactNode; apiBase?: string; accessToken?: string }) {
  const value = useExtensionState(apiBase, accessToken);
  return <PreviewContext.Provider value={value}>{children}</PreviewContext.Provider>;
}
export function useExtensionPreview() {
  const shared = useContext(PreviewContext);
  const isolated = useExtensionState();
  return shared ?? isolated;
}
