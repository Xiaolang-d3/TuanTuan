import type { ViewKey } from "./types";

export type SettingsPage = "overview" | "account" | "library" | "model" | "agent" | "appearance" | "channels" | "extensions" | "memory";

export type AppRoute =
  | { section: "dashboard" }
  | { section: "chat"; conversationId?: number; page?: "library" }
  | { section: "history" }
  | { section: "projects"; projectId?: string }
  | { section: "images"; taskId?: string }
  | { section: "video" }
  | { section: "works" }
  | { section: "settings"; page: "model"; purpose?: "image" }
  | { section: "settings"; page: Exclude<SettingsPage, "model"> };

export function routeForSection(section: ViewKey): AppRoute {
  if (section === "settings") return { section, page: "overview" };
  if (section === "chat") return { section };
  if (section === "images" || section === "history" || section === "projects") return { section };
  if (section === "video") return { section };
  if (section === "works") return { section };
  return { section: "dashboard" };
}

export function parseAppHash(hash: string): AppRoute | null {
  const value = hash.replace(/^#/, "");
  const [rawPath, query] = value.split("?", 2);
  const path = rawPath.replace(/^\//, "").replace(/\/$/, "");
  if (path === "home" || path === "dashboard") return { section: "dashboard" };
  if (path === "library" || path === "chat/library") return { section: "chat", page: "library" };
  if (path === "settings/library") return { section: "settings", page: "library" };
  if (path === "chat") return { section: "chat" };
  if (path === "history") return { section: "history" };
  if (path === "projects") {
    const projectId = new URLSearchParams(query).get("id");
    return projectId ? { section: "projects", projectId } : { section: "projects" };
  }
  if (path === "images") {
    const taskId = new URLSearchParams(query).get("task");
    return taskId ? { section: "images", taskId } : { section: "images" };
  }
  if (path === "video") return { section: "video" };
  if (path === "works") return { section: "works" };
  const chatRoute = path.match(/^chat\/(\d+)$/);
  if (chatRoute) return { section: "chat", conversationId: Number(chatRoute[1]) };
  if (path === "settings" || path === "settings/overview") {
    return { section: "settings", page: "overview" };
  }
  if (path === "settings/model" || path === "settings/models") {
    if (new URLSearchParams(query).get("purpose") === "image") return { section: "settings", page: "model", purpose: "image" };
    return { section: "settings", page: "model" };
  }
  if (path === "settings/appearance") return { section: "settings", page: "appearance" };
  if (path === "settings/agent") return { section: "settings", page: "agent" };
  if (path === "settings/account") return { section: "settings", page: "account" };
  if (path === "settings/channels") return { section: "settings", page: "channels" };
  if (path === "settings/extensions") return { section: "settings", page: "extensions" };
  if (path === "settings/memory") return { section: "settings", page: "memory" };
  return null;
}

export function initialAppRoute(hash: string): AppRoute {
  return parseAppHash(hash) ?? { section: "dashboard" };
}

export function appRouteHash(route: AppRoute): string {
  if (route.section === "dashboard") return "#/home";
  if (route.section === "chat") return route.page === "library" ? "#/chat/library" : route.conversationId ? `#/chat/${route.conversationId}` : "#/chat";
  if (route.section === "history") return "#/history";
  if (route.section === "projects") return route.projectId ? `#/projects?${new URLSearchParams({ id: route.projectId })}` : "#/projects";
  if (route.section === "images") return route.taskId ? `#/images?${new URLSearchParams({ task: route.taskId })}` : "#/images";
  if (route.section === "video") return "#/video";
  if (route.section === "works") return "#/works";
  if (route.page === "overview") return "#/settings";
  if (route.page === "model" && route.purpose === "image") return "#/settings/model?purpose=image";
  return `#/settings/${route.page}`;
}
