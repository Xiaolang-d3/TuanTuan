import type { AppRoute } from "./routing";

export type RouteDataKey =
  | "attachmentConfig"
  | "agentOperations"
  | "agentSettings"
  | "library"
  | "capabilities"
  | "conversations"
  | "modelMonitor"
  | "modelCapabilities";

export function requiredDataForRoute(route: AppRoute): RouteDataKey[] {
  switch (route.section) {
    case "chat":
      if (route.page === "library") return ["library"];
      return ["conversations", "capabilities", "attachmentConfig"];
    case "dashboard":
    case "history":
    case "projects":
    case "images":
    case "video":
    case "works":
      return [];
    case "settings":
      if (route.page === "extensions") return [];
      if (route.page === "channels") return [];
      if (route.page === "memory") return [];
      if (route.page === "library") return ["library"];
      if (route.page === "appearance") return [];
      if (route.page === "agent") return ["agentOperations", "conversations", "capabilities", "attachmentConfig"];
      if (route.page === "model") return ["agentSettings", "modelMonitor", "modelCapabilities", "conversations", "capabilities", "attachmentConfig"];
      if (route.page === "overview") return ["library", "agentSettings", "conversations", "capabilities", "attachmentConfig"];
      return ["library", "conversations", "capabilities", "attachmentConfig"];
  }
}

type RouteDataLoader = () => Promise<unknown>;

/**
 * Coalesce route requests and retain a brief in-memory snapshot. Navigation
 * should feel instant when a person moves between workspaces they just
 * visited, while mutations can still refresh their own data directly.
 */
export function createRouteDataCache<Key>(maxAgeMs: number, now = () => Date.now()) {
  const inFlight = new Map<Key, Promise<unknown>>();
  const completedAt = new Map<Key, number>();

  function load(key: Key, loader: RouteDataLoader): Promise<unknown> {
    const pending = inFlight.get(key);
    if (pending) return pending;

    const loadedAt = completedAt.get(key);
    if (loadedAt !== undefined && now() - loadedAt < maxAgeMs) {
      return Promise.resolve();
    }

    const request = loader();
    inFlight.set(key, request);
    void request.then(
      () => {
        if (inFlight.get(key) === request) completedAt.set(key, now());
      },
      () => {
        if (inFlight.get(key) === request) completedAt.delete(key);
      }
    ).finally(() => {
      if (inFlight.get(key) === request) inFlight.delete(key);
    });
    return request;
  }

  function invalidate(...keys: Key[]) {
    for (const key of keys) {
      completedAt.delete(key);
      inFlight.delete(key);
    }
  }

  return { load, invalidate };
}
