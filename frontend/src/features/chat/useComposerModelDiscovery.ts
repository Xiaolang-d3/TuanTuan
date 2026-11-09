import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type createApiClient } from "../../api/client";
import type { ModelCatalogEntry, ModelConnection } from "../../types";
import type { ServiceModelCatalog } from "./types";

const CATALOG_TTL_MS = 5 * 60_000;
const RETRY_COOLDOWN_MS = 30_000;

type DiscoveryState = { models: string[]; entries: ModelCatalogEntry[]; busy: boolean; error: string; suggestedProtocol?: "responses" };

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
export function useComposerModelDiscovery({ fetchJson, scope, connection, connections }: {
  fetchJson: ReturnType<typeof createApiClient>; scope: unknown; connection?: ModelConnection; connections?: ModelConnection[];
}) {
  const targets = connections ?? (connection ? [connection] : []);
  const signature = JSON.stringify(targets.map(item => [item.id, item.revision, item.enabled, item.name]));
  const owner = useMemo(() => ({ active: true, request: 0, controller: null as AbortController | null, attempts: {} as Record<string, { at: number; ok: boolean }>, connections: targets.filter(item => item.enabled) }), [fetchJson, scope, signature]);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const [snapshot, setSnapshot] = useState<{ owner: typeof owner; catalogs: Record<string, DiscoveryState> } | null>(null);

  useEffect(() => {
    owner.active = true;
    return () => { owner.active = false; owner.controller?.abort(); };
  }, [owner]);

  const discover = useCallback(async (refresh = false) => {
    if (!owner.connections.length || !owner.active || ownerRef.current !== owner) return;
    if (!refresh && owner.controller) return;
    const now = Date.now();
    const due = owner.connections.filter(item => {
      const attempt = owner.attempts[item.id];
      return refresh || !attempt || now - attempt.at >= (attempt.ok ? CATALOG_TTL_MS : RETRY_COOLDOWN_MS);
    });
    if (!due.length) return;
    owner.controller?.abort();
    const controller = new AbortController();
    owner.controller = controller;
    const request = ++owner.request;
    const current = () => owner.active && ownerRef.current === owner && owner.request === request && !controller.signal.aborted;
    setSnapshot(previous => ({ owner, catalogs: { ...(previous?.owner === owner ? previous.catalogs : {}), ...Object.fromEntries(due.map(item => [item.id, {
      models: previous?.owner === owner ? previous.catalogs[item.id]?.models ?? [] : [], entries: previous?.owner === owner ? previous.catalogs[item.id]?.entries ?? [] : [], busy: true, error: ""
    }])) } }));
    try {
      await Promise.all(due.map(async item => {
        try {
          const result = await fetchJson<{ models: string[]; entries?: ModelCatalogEntry[] }>(`/agent/model-connections/${encodeURIComponent(item.id)}/discover`, { method: "POST", signal: controller.signal });
          const models = Array.from(new Set(result.models.filter((name): name is string => typeof name === "string").map(name => name.trim()).filter(name => name && name.length <= 120)));
          if (current()) {
            owner.attempts[item.id] = { at: Date.now(), ok: true };
            setSnapshot(previous => ({ owner, catalogs: { ...previous?.catalogs, [item.id]: { models, entries: catalogEntries(result.entries, models), busy: false, error: "" } } }));
          }
        } catch (reason) {
          if (current()) {
            owner.attempts[item.id] = { at: Date.now(), ok: false };
            setSnapshot(previous => ({ owner, catalogs: { ...previous?.catalogs, [item.id]: {
              models: previous?.owner === owner ? previous.catalogs[item.id]?.models ?? [] : [], entries: previous?.owner === owner ? previous.catalogs[item.id]?.entries ?? [] : [], busy: false,
              error: reason instanceof Error ? reason.message : "读取服务模型失败",
              suggestedProtocol: reason instanceof ApiError && reason.details?.suggested_protocol === "responses" ? "responses" : undefined
            } } }));
          }
        }
      }));
    } finally { if (owner.controller === controller) owner.controller = null; }
  }, [owner, fetchJson]);

  const state = snapshot?.owner === owner ? snapshot : null;
  const primary = state?.catalogs[connection?.id ?? owner.connections[0]?.id];
  const catalogs: ServiceModelCatalog[] = owner.connections.map(item => ({
    connection_id: item.id, connection_name: item.name || "模型连接", revision: item.revision, model_protocol: item.model_protocol,
    models: state?.catalogs[item.id]?.models ?? [], entries: state?.catalogs[item.id]?.entries ?? [], busy: state?.catalogs[item.id]?.busy ?? false, error: state?.catalogs[item.id]?.error ?? ""
  }));
  return { models: primary?.models ?? [], entries: primary?.entries ?? [], busy: primary?.busy ?? false, error: primary?.error ?? "", suggestedProtocol: primary?.suggestedProtocol, catalogs, discover };
}
