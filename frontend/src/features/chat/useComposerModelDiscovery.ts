import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type createApiClient } from "../../api/client";
import type { ModelCatalogEntry, ModelConnection } from "../../types";
import type { ServiceModelCatalog } from "./types";

const CATALOG_TTL_MS = 5 * 60_000;
const RETRY_COOLDOWN_MS = 30_000;
const monotonicNow = () => performance.now();
type DiscoveryState = { models: string[]; entries: ModelCatalogEntry[]; busy: boolean; error: string; suggestedProtocol?: "responses"; source?: "cache" | "live"; discoveredAt?: string };
type CachedCatalog = { connection_id: string; connection_revision: number; models: string[]; entries?: ModelCatalogEntry[]; discovered_at: string | null; cache_age_seconds?: number | null };

function catalogModels(values: unknown): string[] {
  return Array.from(new Set((Array.isArray(values) ? values : []).filter((name): name is string => typeof name === "string").map(name => name.trim()).filter(name => name && name.length <= 120)));
}

function catalogEntries(values: ModelCatalogEntry[] | undefined, models: string[]): ModelCatalogEntry[] {
  return (Array.isArray(values) ? values : []).filter(value => value && models.includes(value.id)).map(value => ({
    id: value.id, display_name: typeof value.display_name === "string" ? value.display_name : undefined,
    owned_by: typeof value.owned_by === "string" ? value.owned_by : undefined,
    input_types: Array.isArray(value.input_types) ? value.input_types.filter(kind => ["text", "image", "audio", "video"].includes(kind)) : undefined,
    output_types: Array.isArray(value.output_types) ? value.output_types.filter(kind => ["chat", "image", "video"].includes(kind)) : [],
    output_types_source: ["provider", "configured", "inferred", "unknown"].includes(value.output_types_source) ? value.output_types_source : "unknown",
    context_window: typeof value.context_window === "number" ? value.context_window : undefined,
    max_output_tokens: typeof value.max_output_tokens === "number" ? value.max_output_tokens : undefined
  }));
}

/** Service catalogs are scoped to saved connection revisions and never contain credentials. */
export function useComposerModelDiscovery({ fetchJson, scope, connection, connections, restoreCached = false }: {
  fetchJson: ReturnType<typeof createApiClient>; scope: unknown; connection?: ModelConnection; connections?: ModelConnection[]; restoreCached?: boolean;
}) {
  const targets = connections ?? (connection ? [connection] : []);
  const signature = JSON.stringify(targets.map(item => [item.id, item.revision, item.enabled, item.name]));
  const owner = useMemo(() => ({ active: true, controllers: new Map<string, AbortController>(), cacheControllers: new Map<string, AbortController>(), cachePromises: new Map<string, Promise<void>>(), attempts: {} as Record<string, { at: number; ok: boolean }>, connections: targets.filter(item => item.enabled) }), [fetchJson, scope, signature, restoreCached]);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const [snapshot, setSnapshot] = useState<{ owner: typeof owner; catalogs: Record<string, DiscoveryState> } | null>(null);

  useEffect(() => {
    owner.active = true;
    if (restoreCached) {
      for (const item of owner.connections) {
        const controller = new AbortController();
        owner.cacheControllers.set(item.id, controller);
        const current = () => owner.active && ownerRef.current === owner && owner.cacheControllers.get(item.id) === controller && !controller.signal.aborted;
        const pending = (async () => {
          try {
            const result = await fetchJson<CachedCatalog>(`/agent/model-connections/${encodeURIComponent(item.id)}/catalog`, { signal: controller.signal }, 2_000);
            if (!current() || result.connection_id !== item.id || result.connection_revision !== item.revision) return;
            const models = catalogModels(result.models);
            if (!models.length) return;
            const ageMs = typeof result.cache_age_seconds === "number" && Number.isFinite(result.cache_age_seconds) && result.cache_age_seconds >= 0 ? result.cache_age_seconds * 1000 : Infinity;
            if (ageMs < CATALOG_TTL_MS && !owner.attempts[item.id]) owner.attempts[item.id] = { at: monotonicNow() - ageMs, ok: true };
            setSnapshot(previous => {
              const catalogs = previous?.owner === owner ? previous.catalogs : {};
              if (catalogs[item.id]?.source === "live") return previous;
              return { owner, catalogs: { ...catalogs, [item.id]: { ...catalogs[item.id], models, entries: catalogEntries(result.entries, models), busy: catalogs[item.id]?.busy ?? false, error: catalogs[item.id]?.error ?? "", source: "cache", discoveredAt: typeof result.discovered_at === "string" && Number.isFinite(Date.parse(result.discovered_at)) ? result.discovered_at : undefined } } };
            });
          } catch {
            // Cache restoration is optional; an old backend or a failed read must not block discovery.
          } finally {
            if (owner.cacheControllers.get(item.id) === controller) owner.cacheControllers.delete(item.id);
          }
        })();
        owner.cachePromises.set(item.id, pending);
      }
    }
    return () => {
      owner.active = false;
      for (const controller of owner.controllers.values()) controller.abort();
      for (const controller of owner.cacheControllers.values()) controller.abort();
    };
  }, [owner, fetchJson, restoreCached]);

  const discover = useCallback(async (refresh = false, connectionId?: string) => {
    if (!owner.active || ownerRef.current !== owner) return;
    await Promise.all(owner.connections.filter(item => !connectionId || item.id === connectionId).map(async item => {
      // A cache hit can satisfy the freshness check; a manual refresh must never wait for it.
      const cacheRead = owner.cachePromises.get(item.id);
      if (!refresh && cacheRead) await cacheRead;
      if (!owner.active || ownerRef.current !== owner) return;
      if (!refresh && owner.controllers.has(item.id)) return;
      const attempt = owner.attempts[item.id];
      if (!refresh && attempt && monotonicNow() - attempt.at < (attempt.ok ? CATALOG_TTL_MS : RETRY_COOLDOWN_MS)) return;
      owner.controllers.get(item.id)?.abort();
      const controller = new AbortController();
      owner.controllers.set(item.id, controller);
      const current = () => owner.active && ownerRef.current === owner && owner.controllers.get(item.id) === controller && !controller.signal.aborted;
      setSnapshot(previous => {
        const catalogs = previous?.owner === owner ? previous.catalogs : {};
        return { owner, catalogs: { ...catalogs, [item.id]: { ...catalogs[item.id], models: catalogs[item.id]?.models ?? [], entries: catalogs[item.id]?.entries ?? [], busy: true, error: "" } } };
      });
      try {
        const result = await fetchJson<{ models: string[]; entries?: ModelCatalogEntry[] }>(`/agent/model-connections/${encodeURIComponent(item.id)}/discover`, { method: "POST", signal: controller.signal });
        if (!result || !Array.isArray(result.models)) throw new Error("服务返回的模型目录格式无效，请重试。");
        const models = catalogModels(result.models);
        if (current()) {
          const now = Date.now();
          owner.attempts[item.id] = { at: monotonicNow(), ok: true };
          setSnapshot(previous => ({ owner, catalogs: { ...(previous?.owner === owner ? previous.catalogs : {}), [item.id]: { models, entries: catalogEntries(result.entries, models), busy: false, error: "", source: "live", discoveredAt: new Date(now).toISOString() } } }));
        }
      } catch (reason) {
        if (current()) {
          owner.attempts[item.id] = { at: monotonicNow(), ok: false };
          setSnapshot(previous => {
            const catalogs = previous?.owner === owner ? previous.catalogs : {};
            return { owner, catalogs: { ...catalogs, [item.id]: {
              ...catalogs[item.id], models: catalogs[item.id]?.models ?? [], entries: catalogs[item.id]?.entries ?? [], busy: false,
              error: reason instanceof Error ? reason.message : "读取服务模型失败",
              suggestedProtocol: reason instanceof ApiError && reason.details?.suggested_protocol === "responses" ? "responses" : undefined
            } } };
          });
        }
      } finally { if (owner.controllers.get(item.id) === controller) owner.controllers.delete(item.id); }
    }));
  }, [owner, fetchJson]);

  const state = snapshot?.owner === owner ? snapshot : null;
  const primary = state?.catalogs[connection?.id ?? owner.connections[0]?.id];
  const catalogs: ServiceModelCatalog[] = owner.connections.map(item => ({
    connection_id: item.id, connection_name: item.name || "模型连接", revision: item.revision, model_protocol: item.model_protocol,
    models: state?.catalogs[item.id]?.models ?? [], entries: state?.catalogs[item.id]?.entries ?? [], busy: state?.catalogs[item.id]?.busy ?? false, error: state?.catalogs[item.id]?.error ?? "",
    source: state?.catalogs[item.id]?.source, discoveredAt: state?.catalogs[item.id]?.discoveredAt
  }));
  return { models: primary?.models ?? [], entries: primary?.entries ?? [], busy: primary?.busy ?? false, error: primary?.error ?? "", suggestedProtocol: primary?.suggestedProtocol, catalogs, discover };
}
