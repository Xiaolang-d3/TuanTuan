import { useRef, useState, type CSSProperties } from "react";
import { Bookmark, Copy, ExternalLink, EyeOff, FolderPlus, GitFork, Github, MoreHorizontal, Newspaper, Package, Sparkles, Star, TrendingUp, TriangleAlert } from "lucide-react";
import { DropdownMenu, DropdownMenuContent } from "../../components/ui/DropdownMenu";
import type { HomeArticle, HomeReadableItem, HomeRelease, HomeRepository } from "./types";

export const TOPIC_LABELS: Record<string, string> = {
  release: "新模型", evaluation: "能力评测", pricing: "价格与成本",
  model: "模型与 API", agent: "Agent 框架", mcp: "MCP", tools: "开发工具",
  tool: "工具调用", memory: "上下文与记忆", rag: "RAG", eval: "评测",
  obs: "可观测性", deploy: "部署", cost: "延迟与成本"
};
const TOPIC_HUES: Record<string, number> = { model: 215, agent: 262, mcp: 172, tools: 32, tool: 238, memory: 195, rag: 145, eval: 330, obs: 18, deploy: 280, cost: 95 };

export function validWebUrl(url: string) {
  try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol); } catch { return false; }
}

export function formatPublished(value: string | null, now = new Date()) {
  if (!value) return "时间未提供";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "时间未提供";
  const diff = now.getTime() - parsed.getTime();
  if (diff >= 0 && diff < 60_000) return "刚刚";
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff >= 0 && diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return parsed.toLocaleDateString("zh-CN", { ...(parsed.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}), month: "numeric", day: "numeric" });
}

export function articleReadable(item: HomeArticle): HomeReadableItem {
  return { kind: "article", id: item.id, title: item.title, summary: item.summary, url: item.url, source: item.source, published_at: item.published_at };
}
export function repositoryReadable(item: HomeRepository): HomeReadableItem {
  return { kind: "repository", id: item.id, title: `${item.owner}/${item.name}`, summary: item.description, url: item.url, source: "GitHub Trending", published_at: null };
}
export function releaseReadable(item: HomeRelease): HomeReadableItem {
  return { kind: "release", id: item.id, title: `${item.name} ${item.version}`, summary: item.changes.join("\n"), url: item.url, source: item.repo, published_at: item.published_at };
}

export type FeedMenuAction = "bookmark" | "save" | "analyze" | "copy" | "hide";
export type OnFeedMenuAction = (action: FeedMenuAction, item: HomeReadableItem, trigger: HTMLButtonElement) => void;

type ActionsProps = {
  item: HomeReadableItem;
  bookmarked: boolean;
  busy: boolean;
  onBookmark: () => void;
  onMenuAction: OnFeedMenuAction;
};

export function FeedActions({ item, bookmarked, busy, onBookmark, onMenuAction }: ActionsProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const openingSaveDialog = useRef(false);
  const actions = [
    { id: "bookmark", label: bookmarked ? "取消收藏" : "收藏", icon: Bookmark },
    { id: "save", label: "存入文件库", icon: FolderPlus },
    { id: "analyze", label: "交给 AI 分析", icon: Sparkles },
    { id: "copy", label: "复制链接", icon: Copy },
    { id: "hide", label: "隐藏此条", icon: EyeOff }
  ] as const;

  return <div className="home-actions">
    {validWebUrl(item.url) && <a className="home-act home-primary" href={item.url} target="_blank" rel="noreferrer" title="打开原文" aria-label={`打开原文：${item.title}`}><ExternalLink size={14} /><span className="home-action-label">打开原文</span></a>}
    <button className={`home-act home-bookmark${bookmarked ? " on" : ""}`} type="button" disabled={busy} aria-pressed={bookmarked} aria-label={`${bookmarked ? "取消收藏" : "收藏"}：${item.title}`} title={bookmarked ? "取消收藏" : "收藏"} onClick={onBookmark}><Bookmark size={14} /><span className="home-action-label">{bookmarked ? "已收藏" : "收藏"}</span></button>
    <DropdownMenu.Root modal={false} onOpenChange={(open) => { if (open) openingSaveDialog.current = false; }}>
      <DropdownMenu.Trigger ref={trigger} className="home-act" aria-label={`更多：${item.title}`} title="更多"><MoreHorizontal size={16} aria-hidden="true" /></DropdownMenu.Trigger>
      <DropdownMenuContent className="home-menu" aria-label={`更多操作：${item.title}`} align="end" sideOffset={6} finalFocus={() => !openingSaveDialog.current}>
        {actions.map(({ id, label, icon: Icon }) => <DropdownMenu.Item
          key={id}
          render={<button type="button" />}
          nativeButton
          onClick={() => {
            if (trigger.current) {
              openingSaveDialog.current = id === "save";
              onMenuAction(id, item, trigger.current);
            }
          }}
        ><Icon size={16} aria-hidden="true" />{label}</DropdownMenu.Item>)}
      </DropdownMenuContent>
    </DropdownMenu.Root>
  </div>;
}

export function ArticleCard({ article, variant, now, ...actions }: { article: HomeArticle; variant: "feat" | "sm" | "art"; now: Date } & Omit<ActionsProps, "item">) {
  const [imageFailed, setImageFailed] = useState(false);
  const hasImage = variant !== "art" && Boolean(article.image_url && validWebUrl(article.image_url) && !imageFailed);
  return <article className={`home-card home-card--${variant}${hasImage ? "" : " home-no-img"}`} style={{ "--home-hue": TOPIC_HUES[article.category] ?? 230 } as CSSProperties}>
    {hasImage && <div className="home-card-media"><img src={article.image_url!} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} /></div>}
    <div className="home-card-tag"><span className="home-tag">{TOPIC_LABELS[article.category] || article.tags[0] || "技术动态"}</span>{variant === "feat" && <span className="home-featured-flag"><Star size={14} />最新焦点</span>}</div>
    <h3 className="home-card-title">{validWebUrl(article.url) ? <a href={article.url} target="_blank" rel="noreferrer" title={article.title}>{article.title}</a> : article.title}</h3>
    {article.summary && <p className="home-card-summary">{article.summary}</p>}
    <div className="home-card-foot"><div className="home-meta"><Newspaper className="home-source-icon" size={14} aria-hidden="true" /><span className="home-source" title={article.source}>{article.source}</span><span>·</span><time dateTime={article.published_at || undefined}>{formatPublished(article.published_at, now)}</time></div><FeedActions item={articleReadable(article)} {...actions} /></div>
  </article>;
}

function compactNumber(value: number) {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2).replace(/\.0+$/, "")}k`;
  return value.toLocaleString("zh-CN");
}

export function RepositoryRow({ repository, period, ...actions }: { repository: HomeRepository; period: "day" | "week" } & Omit<ActionsProps, "item">) {
  return <article className="home-repo">
    <div className={`home-rank${repository.rank <= 3 ? " top" : ""}`}>{repository.rank}</div>
    <div className="home-repo-logo" aria-hidden="true"><Github size={20} /></div>
    <a className="home-repo-name" href={repository.url} target="_blank" rel="noreferrer" title={`${repository.owner}/${repository.name}`}><span className="home-repo-owner">{repository.owner}</span><span className="home-repo-slash">/</span><b>{repository.name}</b></a>
    <FeedActions item={repositoryReadable(repository)} {...actions} />
    <p className="home-repo-description" title={repository.description}>{repository.description}</p>
    <div className="home-repo-meta">{repository.language && <span><i className="home-language-dot" />{repository.language}</span>}{repository.stars !== null && <span title="累计 Stars"><Star size={13} />{compactNumber(repository.stars)}</span>}{repository.period_stars !== null && <span className="home-delta"><TrendingUp size={13} />+{repository.period_stars.toLocaleString("zh-CN")} {period === "day" ? "今日" : "本周"}</span>}{repository.forks !== null && <span className="home-fork"><GitFork size={13} />{compactNumber(repository.forks)}</span>}</div>
  </article>;
}

export function ReleaseRow({ release, now, ...actions }: { release: HomeRelease; now: Date } & Omit<ActionsProps, "item">) {
  const compatibility = release.compatibility === "breaking" ? "破坏性变更" : release.compatibility === "migrate" ? "需迁移 / 有弃用" : "查看更新说明";
  return <article className="home-stack-row">
    <div className="home-stack-tool"><div className="home-repo-logo" aria-hidden="true"><Package size={20} /></div><div><div className="home-stack-name">{release.name}</div><div className="home-version">{release.previous_version && <><span>{release.previous_version}</span><span>→</span></>}<b>{release.version}</b></div></div></div>
    <ul className="home-stack-changes">{release.changes.slice(0, 3).map((change, index) => <li key={index}>{change}</li>)}</ul>
    <div className="home-stack-compat"><span className={`home-badge home-badge--${release.compatibility}`}><TriangleAlert size={14} />{compatibility}</span><p>{release.compatibility === "review" ? "请阅读发布说明后评估升级" : "升级前请确认兼容性与迁移要求"}</p></div>
    <div className="home-stack-side"><time dateTime={release.published_at || undefined}>{formatPublished(release.published_at, now)}{formatPublished(release.published_at, now) !== "时间未提供" ? "发布" : ""}</time><FeedActions item={releaseReadable(release)} {...actions} /></div>
  </article>;
}
