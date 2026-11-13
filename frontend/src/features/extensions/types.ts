/** UI contracts for the first extension workflow. No backend endpoint is assumed here. */
export type ExtensionKind = "skill" | "plugin";
export type ExtensionSummary = {
  id: string;
  kind: ExtensionKind;
  name: string;
  description: string;
  version?: string;
  source: "example" | "import" | "user" | "github" | "builtin";
  origin?: { repository: string; commit: string; path: string; skill_id: string };
  enabled: boolean;
  permissions: string[];
  instructions?: string;
  revision?: string;
  status?: string;
  unavailableReason?: string;
  user_invocable?: boolean;
};

export type OnlineSkill = { name: string; source: string; installs: number; installed: boolean };
export type SkillPreview = {
  preview_id: string;
  repository: string;
  commit: string;
  expires_at: number;
  skipped: number;
  skills: { path: string; name: string; description: string; content: string; files: string[] }[];
};

export type McpDraft = {
  id: string;
  name: string;
  transport: "http" | "stdio";
  endpoint: string;
  status: "draft";
};

export type PresentationBrief = { topic: string; audience: string; pages: number; style: "清新" | "商务" };
export type PresentationStage = "brief" | "outline" | "running" | "completed" | "cancelled" | "failed";
export type SlidePreview = { title: string; subtitle: string; points: string[] };

/** Preview is isolated from future authenticated execution / artifact download adapters. */
export interface ExtensionPreviewStore {
  list(): ExtensionSummary[];
  add(extension: ExtensionSummary): void;
  toggle(id: string): void;
  remove(id: string): void;
}
