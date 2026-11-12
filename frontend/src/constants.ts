import type { AgentSettings, LibraryEditor, ViewKey } from "./types";
import type { SettingsPage } from "./routing";

export const defaultAgentSettings: AgentSettings = {
  display_name: "团团",
  persona_role: "主动、清晰、基于用户资料协助分析、研究和内容创作的 AI 伙伴",
  response_style: "concise",
  custom_instructions: "",
  library_memory_enabled: true,
  conversation_memory_enabled: true,
  knowledge_memory_enabled: true,
  user_memory_enabled: true,
  summary_enabled: true,
  context_message_limit: 12,
  model_name: "",
  model_base_url: "",
  model_protocol: "auto",
  api_key: "",
  api_key_configured: false
};

export const pageMeta: Record<ViewKey, { title: string; description: string }> = {
  dashboard: { title: "首页", description: "查看最近资料、文档和对话" },
  chat: { title: "AI 工作区", description: "基于你的资料进行问答、搜索、分析和内容生成" },
  settings: { title: "设置", description: "维护账号、模型连接和偏好" }
};

const sectionTitles: Record<ViewKey, string> = {
  dashboard: pageMeta.dashboard.title,
  chat: "AI 工作区",
  settings: "设置"
};

export function topbarSectionForPage(section: ViewKey, title: string): string | undefined {
  if (section === "chat" || section === "settings") return undefined;
  return sectionTitles[section] === title ? undefined : sectionTitles[section];
}

export type SidebarHighlight = "dashboard" | "library" | "chat" | "settings" | null;

export function sidebarHighlightForView(
  view: ViewKey,
  extras: { settingsPage?: SettingsPage; libraryOpen?: boolean } = {}
): SidebarHighlight {
  if (view === "dashboard") return "dashboard";
  if (view === "chat") return extras.libraryOpen ? "library" : "chat";
  if (view === "settings" && extras.settingsPage) return "settings";
  if (view === "settings") return "settings";
  return null;
}

export const emptyLibraryEditor: LibraryEditor = { name: "", privacyMode: "redacted" };
