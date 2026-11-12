export type FetchJson = <T>(path: string, options?: RequestInit) => Promise<T>;

export type HomePreferences = {
  topics: string[];
  repositories: string[];
  digest_profile_id: string;
  curation_enabled?: boolean;
};

export type HomeArticle = {
  id: string;
  title: string;
  summary: string;
  url: string;
  source: string;
  published_at: string | null;
  category: string;
  tags: string[];
  image_url: string | null;
};

export type HomeRepository = {
  id: string;
  owner: string;
  name: string;
  description: string;
  url: string;
  language: string | null;
  stars: number | null;
  period_stars: number | null;
  forks: number | null;
  rank: number;
  tags: string[];
};

export type HomeRelease = {
  id: string;
  repo: string;
  name: string;
  version: string;
  previous_version: string | null;
  published_at: string | null;
  changes: string[];
  compatibility: "breaking" | "migrate" | "review";
  url: string;
};

export type HomeReadableItem = {
  id: string;
  kind: "article" | "repository" | "release";
  title: string;
  summary: string;
  url: string;
  source: string;
  published_at: string | null;
};

export type SourceStatus = {
  publisher?: string | null;
  id: string;
  label: string;
  kind: "news" | "github" | "stack" | "practice" | "benchmark";
  status: "ready" | "empty" | "error" | "loading";
  url: string;
  last_success_at: string | null;
  error: string | null;
};

export type HomeItemState = {
  bookmarked: boolean;
  hidden: boolean;
};

export type HomeBookmark =
  | { kind: "news" | "practice"; item: HomeArticle }
  | { kind: "github"; item: HomeRepository }
  | { kind: "stack"; item: HomeRelease };

export type HomeDigestPoint = {
  text: string;
  url: string | null;
};

export type HomeDigestSection = {
  key: string;
  label: string;
  points: HomeDigestPoint[];
};

export type HomeDigestStatus = "unconfigured" | "empty" | "generating" | "ready" | "stale" | "error";

export type HomeDigest = {
  status: HomeDigestStatus;
  profile_id: string;
  model_name: string;
  generated_at: string | null;
  date: string | null;
  error: string;
  overview: string;
  sections: HomeDigestSection[];
};

export type HomeCurationItem = {
  id: string;
  title: string;
  summary: string;
  why_it_matters: string;
  url: string;
  source: string;
  published_at: string;
  event_date: string;
  confidence: "high" | "medium";
  evidence: string;
};

export type HomeCuration = {
  status: "disabled" | "unconfigured" | "generating" | "ready" | "empty" | "stale" | "error";
  date: string | null;
  generated_at: string | null;
  model_name: string;
  error: string;
  warnings: string[];
  items: HomeCurationItem[];
  window_hours?: number;
  requested_window_hours?: number;
  empty_reason?: string;
  diagnostics?: { raw_candidates: number; recent_candidates: number; verified_candidates: number; proposed_items: number; selected_items: number } | null;
};

export type HomeFeedResponse = {
  news: HomeArticle[];
  model_news?: HomeArticle[];
  model_benchmarks?: HomeModelBenchmarks;
  repositories: { day: HomeRepository[]; week: HomeRepository[] };
  updates: HomeRelease[];
  practices: HomeArticle[];
  sources: SourceStatus[];
  preferences: HomePreferences;
  item_states: Record<string, HomeItemState>;
  bookmarks?: HomeBookmark[];
  digest: HomeDigest;
  curation?: HomeCuration;
  refreshing: boolean;
  last_synced_at: string | null;
};

export type HomeModelBenchmark = {
  id: string;
  name: string;
  url: string;
  creator_id: string;
  creator: string;
  intelligence: number | null;
  coding: number | null;
  agentic: number | null;
  input_price: number | null;
  output_price: number | null;
  task_cost: number | null;
  tokens_per_second: number | null;
  first_token_seconds: number | null;
};

export type HomeModelBenchmarks = {
  media?: HomeMediaBoard[];
  models: HomeModelBenchmark[];
  status: SourceStatus["status"] | "unconfigured";
  error: string | null;
  collected_at: string | null;
  source_url: string;
  docs_url: string;
};

export type HomeMediaModel = {
  id: string;
  name: string;
  url: string;
  creator_id: string;
  creator: string;
  elo: number | null;
  ci_95: number | null;
  bba_score: number | null;
  fdb_score: number | null;
  tau_voice_score: number | null;
  wer: number | null;
};

export type HomeMediaBoard = {
  id: string;
  category: "image" | "video" | "speech";
  label: string;
  metric: "elo" | "bba_score" | "wer";
  source_url: string;
  models: HomeMediaModel[];
  status: SourceStatus["status"];
  error: string | null;
  collected_at: string | null;
};

export type HomeWorkspaceConversation = {
  id: number;
  title: string;
  last_message_at: string | null;
  task_status: string;
};

export type HomeJobBrief = {
  id: string;
  kind: string;
  display_title: string;
  status: string;
  created_at: string | null;
};

export type HomeChangelogItem = {
  category: string;
  text: string;
  version: string;
};

export type HomeSkillItem = {
  name: string;
  summary: string;
  source: string;
};

export type HomeLibraryRecentItem = {
  id: number;
  title: string;
  kind: string;
  created_at: string | null;
};

export type HomeWorkspaceWeixin = {
  connected: boolean;
  unread_count: number;
};

export type HomeWorkspaceBlock<T> = {
  items: T[];
  error: string | null;
};

export type HomeWorkspaceResponse = {
  generated_at: string | null;
  conversations: HomeWorkspaceBlock<HomeWorkspaceConversation>;
  jobs: { running: HomeJobBrief[]; pending_confirmations: HomeJobBrief[] };
  weixin: HomeWorkspaceWeixin;
  changelog: HomeWorkspaceBlock<HomeChangelogItem>;
  skills: HomeWorkspaceBlock<HomeSkillItem>;
  library_recent: HomeWorkspaceBlock<HomeLibraryRecentItem>;
};
