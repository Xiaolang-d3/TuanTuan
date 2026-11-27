import { useCallback, useEffect, useRef, useState } from "react";
import type { createApiClient } from "../../api/client";
import { useAsyncPolling } from "../../hooks/useAsyncPolling";
import type { AgentOperationsSnapshot, AgentRunStatus } from "../../types";

export type OperationsDays = 7 | 30 | 90;
export const OPERATIONS_PAGE_SIZE = 20;

type Query = { days: OperationsDays; status: AgentRunStatus | null; date: string | null; page: number };
type Result = { key: string; days: OperationsDays; snapshot: AgentOperationsSnapshot };

export function useAgentOperations(fetchJson: ReturnType<typeof createApiClient>, query: Query) {
  const { days, status, date, page } = query;
  const params = new URLSearchParams({ days: String(days), limit: String(OPERATIONS_PAGE_SIZE) });
  if (status) params.set("run_status", status);
  if (date) params.set("run_date", date);
  if (page > 0) params.set("offset", String(page * OPERATIONS_PAGE_SIZE));
  const key = params.toString();
  const requestRef = useRef<AbortController | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setErrorKey(null);
    try {
      const snapshot = await fetchJson<AgentOperationsSnapshot>(`/agent/operations?${key}`, { signal: controller.signal });
      if (!controller.signal.aborted) setResult({ key, days, snapshot });
    } catch {
      if (!controller.signal.aborted) setErrorKey(key);
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, [days, fetchJson, key]);

  useEffect(() => {
    void refresh();
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [refresh]);

  useAsyncPolling({ enabled: true, intervalMs: 15_000, poll: refresh });

  return {
    overview: result?.days === days ? result.snapshot : null,
    records: result?.key === key ? result.snapshot : null,
    failed: errorKey === key,
    refresh
  };
}
