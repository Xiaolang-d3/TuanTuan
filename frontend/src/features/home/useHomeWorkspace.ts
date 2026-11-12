import { useCallback, useEffect, useRef, useState } from "react";
import type { FetchJson, HomeWorkspaceResponse } from "./types";

const POLL_INTERVAL_MS = 30_000;

type WorkspaceSession = {
  active: boolean;
  queue: Promise<void>;
  timer: number | null;
  controller: AbortController | null;
  refreshTask: Promise<void> | null;
  request: () => Promise<void>;
};

function errorMessage(reason: unknown) {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason;
  return "工作区信息请求失败，请重试";
}

export function useHomeWorkspace(fetchJson: FetchJson) {
  const [workspace, setWorkspace] = useState<HomeWorkspaceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<WorkspaceSession | null>(null);

  useEffect(() => {
    const session: WorkspaceSession = {
      active: true,
      queue: Promise.resolve(),
      timer: null,
      controller: null,
      refreshTask: null,
      request: async () => undefined
    };
    sessionRef.current = session;
    setWorkspace(null);
    setLoading(true);
    setError(null);

    const clearPoll = () => {
      if (session.timer !== null) window.clearTimeout(session.timer);
      session.timer = null;
    };

    const schedulePoll = (snapshot: HomeWorkspaceResponse) => {
      if (!session.active || session.timer !== null) return;
      // Keep a light heartbeat only while tasks are running; finished tasks need no polling.
      if (snapshot.jobs.running.length === 0) return;
      session.timer = window.setTimeout(() => {
        session.timer = null;
        void session.request();
      }, POLL_INTERVAL_MS);
    };

    session.request = () => {
      const task = session.queue.then(async () => {
        if (!session.active) return;
        clearPoll();
        const controller = new AbortController();
        session.controller = controller;
        setError(null);
        try {
          const snapshot = await fetchJson<HomeWorkspaceResponse>("/home/workspace", { signal: controller.signal });
          if (!session.active) return;
          setWorkspace(snapshot);
          setLoading(false);
          schedulePoll(snapshot);
        } catch (reason) {
          if (!session.active) return;
          // Keep the previous workspace visible; the next focus or manual refresh retries.
          setLoading(false);
          setError(errorMessage(reason));
        } finally {
          session.controller = null;
        }
      });
      session.queue = task.catch(() => undefined);
      return task;
    };

    const handleFocus = () => {
      if (!session.active) return;
      void session.request();
    };
    window.addEventListener("focus", handleFocus);

    void session.request();
    return () => {
      session.active = false;
      clearPoll();
      session.controller?.abort();
      window.removeEventListener("focus", handleFocus);
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [fetchJson]);

  const refresh = useCallback((): Promise<void> => {
    const session = sessionRef.current;
    if (!session?.active) return Promise.resolve();
    if (session.refreshTask) return session.refreshTask;
    const task = session.request();
    session.refreshTask = task;
    void task.finally(() => {
      if (session.refreshTask === task) session.refreshTask = null;
    });
    return task;
  }, []);

  return { workspace, loading, error, refresh };
}
