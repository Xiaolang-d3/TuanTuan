import { readStorageItem } from "../../storage";
import { useCallback, useEffect, useState } from "react";
import { Bookmark, ChevronRight, Github, Layers, LayoutList, List, RefreshCw, SlidersHorizontal, Sparkles, Star, TriangleAlert, Wrench, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { FetchJson, HomeArticle, HomeReadableItem } from "./types";
import { useHomeFeed } from "./useHomeFeed";
import { ArticleCard, ReleaseRow, RepositoryRow, articleReadable, repositoryReadable, releaseReadable, formatPublished } from "./HomeFeedCards";
import { HomeBookmarksDialog, HomeInterestDialog, HomeLibraryDialog, HomeMoreMenu, type HomeMenuTarget } from "./HomeFeedOverlays";
import { HomeDigestCard } from "./HomeDigestCard";
import { HomeCurationCard } from "./HomeCurationCard";
import { HomeModelBenchmarks } from "./HomeModelBenchmarks";

type HomePageProps = {
  fetchJson: FetchJson;
  accountName: string;
  accountKey: string;
  onAnalyze: (item: HomeReadableItem) => Promise<void>;
  onLibraryChanged: () => Promise<void>;
};

function greetingPrefix(date: Date) { return date.getHours() < 12 ? "早上好" : date.getHours() < 18 ? "下午好" : "晚上好"; }
function readDisplayPreference(key: string, fallback: string) { try { return readStorageItem(key) || fallback; } catch { return fallback; } }
function saveDisplayPreference(key: string, value: string) { try { window.localStorage.setItem(key, value); } catch { /* Display remains usable when storage is unavailable. */ } }
const NEWS_FILTERS = [["all", "全部"], ["release", "新模型"], ["evaluation", "能力评测"], ["pricing", "价格与成本"]];
const REPO_FILTERS = [["all", "全部"], ["agent", "Agent"], ["mcp", "MCP"], ["rag", "RAG"], ["eval", "评测"], ["tools", "工具"]];
const PRACTICE_FILTERS = [["all", "全部"], ["tool", "工具调用"], ["memory", "上下文与记忆"], ["rag", "RAG"], ["eval", "评测"], ["obs", "可观测性"], ["deploy", "部署"], ["cost", "延迟与成本"]];
const RELEASE_FILTERS = [["all", "全部"], ["breaking", "破坏性变更"], ["migrate", "需迁移 / 有弃用"], ["review", "查看更新说明"]];

function Chips({ options, value, onChange, label, className = "" }: { options: string[][]; value: string; onChange: (value: string) => void; label: string; className?: string }) {
  return <div className={`home-chips ${className}`} role="group" aria-label={label}>{options.map(([key, title]) => <button className={`home-chip${key === value ? " on" : ""}`} type="button" key={key} aria-pressed={key === value} onClick={() => onChange(key)}>{title}</button>)}</div>;
}
function ModuleTitle({ id, title, icon: Icon, count }: { id: string; title: string; icon: LucideIcon; count?: string }) {
  return <h2 className="home-module-title" id={id}><span className="home-module-icon"><Icon size={15} /></span>{title}{count && <span className="home-count">{count}</span>}</h2>;
}
function ModuleEmpty({ title, text, onReset, onSettings, onRefresh }: { title: string; text: string; onReset?: () => void; onSettings?: () => void; onRefresh?: () => void }) {
  return <div className="home-empty"><span className="home-empty-icon"><LayoutList size={24} /></span><h3>{title}</h3><p>{text}</p><div className="home-empty-actions">{onReset && <button className="home-btn" type="button" onClick={onReset}>清除筛选</button>}{onSettings && <button className="home-btn home-btn-primary" type="button" onClick={onSettings}>兴趣设置</button>}{onRefresh && <button className="home-btn" type="button" onClick={onRefresh}>重新刷新</button>}</div></div>;
}
function ModuleSkeleton({ variant = "cards" }: { variant?: "cards" | "rows" }) {
  return <div className={`home-skeleton-list home-skeleton-list--${variant}`} role="status" aria-label="资讯加载中">{Array.from({ length: variant === "rows" ? 5 : 3 }, (_, index) => <div className="home-skeleton-card" key={index}><div className="home-skeleton home-skeleton-tag" /><div className="home-skeleton home-skeleton-title" /><div className="home-skeleton home-skeleton-line" /><div className="home-skeleton home-skeleton-line short" /></div>)}</div>;
}

export function HomePage({ fetchJson, accountName, accountKey, onAnalyze, onLibraryChanged }: HomePageProps) {
  const { feed, loading, error, refreshing, notice, setNotice, refresh, savePreferences, setItemState, generateDigest, regenerateCuration } = useHomeFeed(fetchJson);
  const [now, setNow] = useState(() => new Date());
  const [mode, setMode] = useState<"info" | "compact">(() => readDisplayPreference(`tuantuan-home-mode:${accountKey}`, "info") === "compact" ? "compact" : "info");
  const [newsFilter, setNewsFilter] = useState("all");
  const [newsPublisher, setNewsPublisher] = useState("all");
  const [repoFilter, setRepoFilter] = useState("all");
  const [practiceFilter, setPracticeFilter] = useState("all");
  const [releaseFilter, setReleaseFilter] = useState("all");
  const [period, setPeriod] = useState<"day" | "week">("day");
  const [expandedNews, setExpandedNews] = useState(false);
  const [expandedRepos, setExpandedRepos] = useState(false);
  const [expandedPractices, setExpandedPractices] = useState(false);
  const [menu, setMenu] = useState<HomeMenuTarget | null>(null);
  const [interestOpen, setInterestOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [libraryItem, setLibraryItem] = useState<HomeReadableItem | null>(null);
  const [busyItems, setBusyItems] = useState<Set<string>>(() => new Set());
  const [undoItem, setUndoItem] = useState<string | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    const updateTime = () => setNow(new Date());
    const timer = window.setInterval(updateTime, 1000);
    window.addEventListener("focus", updateTime);
    document.addEventListener("visibilitychange", updateTime);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", updateTime); document.removeEventListener("visibilitychange", updateTime); };
  }, []);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => { setNotice(null); setUndoItem(null); }, 7000); return () => window.clearTimeout(timer); }, [notice, setNotice]);

  function normalizedTag(value: string) { return ({ "评测": "eval", "开发工具": "tools" }[value] || value).toLowerCase(); }
  function matchesPreferences(tags: string[]) { return !feed?.preferences.topics.length || tags.some((tag) => feed.preferences.topics.some((topic) => normalizedTag(topic) === normalizedTag(tag))); }
  const bookmarks = (feed?.bookmarks || []).filter((bookmark) => feed?.item_states[bookmark.item.id]?.bookmarked !== false).map((bookmark) => bookmark.kind === "github" ? repositoryReadable(bookmark.item) : bookmark.kind === "stack" ? releaseReadable(bookmark.item) : articleReadable(bookmark.item));
  const modelNews = feed?.model_news ?? feed?.news ?? [];
  const newsPublishers = Array.from(new Set([
    ...(feed?.sources || []).filter(source => source.kind === "news").map(source => source.publisher).filter((publisher): publisher is string => Boolean(publisher)),
    ...modelNews.map(item => item.source)
  ]));
  const news = modelNews.filter((item) => matchesPreferences(item.tags) && !feed?.item_states[item.id]?.hidden && (newsFilter === "all" || item.category === newsFilter) && (newsPublisher === "all" || item.source === newsPublisher));
  const practices = (feed?.practices || []).filter((item) => matchesPreferences(item.tags) && !feed?.item_states[item.id]?.hidden && (practiceFilter === "all" || item.category === practiceFilter));
  const repositories = (feed?.repositories[period] || []).filter((item) => matchesPreferences(item.tags) && !feed?.item_states[item.id]?.hidden && (repoFilter === "all" || item.tags.some((tag) => normalizedTag(tag) === repoFilter)));
  const updates = (feed?.updates || []).filter((item) => !feed?.item_states[item.id]?.hidden && (releaseFilter === "all" || item.compatibility === releaseFilter));
  const newCount = modelNews.filter((item) => matchesPreferences(item.tags) && !feed?.item_states[item.id]?.hidden && item.published_at && now.getTime() - new Date(item.published_at).getTime() >= 0 && now.getTime() - new Date(item.published_at).getTime() < 86_400_000).length;
  const failedSources = (feed?.sources || []).filter((source) => source.status === "error");
  const newsLimit = mode === "compact" ? 12 : 8;
  const previewNews = news;
  const visibleNews = expandedNews ? news : previewNews.slice(0, newsLimit);
  const visiblePractices = expandedPractices ? practices : practices.slice(0, 6);
  const visibleRepos = expandedRepos ? repositories : repositories.slice(0, 7);

  async function changeState(id: string, patch: { bookmarked?: boolean; hidden?: boolean }) {
    if (busyItems.has(id)) return;
    setBusyItems((current) => new Set(current).add(id));
    try { await setItemState(id, patch); if (patch.hidden === true) setUndoItem(id); if (patch.hidden === false || patch.bookmarked !== undefined) setUndoItem(null); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : "操作失败，请重试"); }
    finally { setBusyItems((current) => { const next = new Set(current); next.delete(id); return next; }); }
  }
  function cardActions(id: string) {
    return { bookmarked: Boolean(feed?.item_states[id]?.bookmarked), busy: busyItems.has(id), onBookmark: () => { void changeState(id, { bookmarked: !feed?.item_states[id]?.bookmarked }); }, onMore: (item: HomeReadableItem, anchor: HTMLButtonElement) => setMenu({ item, anchor }), openItemId: menu?.item.id || null };
  }
  function renderArticles(items: HomeArticle[], practice = false) {
    return items.map((article, index) => <ArticleCard key={`${article.id}:${article.image_url || ""}`} article={article} variant={practice ? "art" : index === 0 ? "feat" : "sm"} now={now} {...cardActions(article.id)} />);
  }
  function moduleLoading(kind: string, itemCount: number) { return (!feed && loading) || (itemCount === 0 && Boolean(feed?.sources.some((source) => source.kind === kind && source.status === "loading"))); }
  const syncDate = feed?.last_synced_at ? new Date(feed.last_synced_at) : null;
  const syncTime = syncDate && Number.isFinite(syncDate.getTime()) ? syncDate.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : "尚未同步";

  return <section className="home-page" aria-label="开发者首页" data-mode={mode}>
    <header className="home-head"><div className="home-hello"><div className="home-eyebrow"><span>{now.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}</span><span>·</span><time className="home-time" aria-label="当前时间" dateTime={now.toISOString()}>{now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</time></div><h1 className="home-welcome">{greetingPrefix(now)}，{accountName.trim() || "欢迎回来"}</h1><p className="home-digest">{loading && !feed ? "正在获取模型评测与动态…" : <>过去 24 小时有 <b>{newCount}</b> 条模型动态 · 关注能力评测、新模型和使用成本。</>}</p></div><div className="home-head-tools"><div className="home-segment" role="group" aria-label="显示模式"><button className={mode === "compact" ? "on" : ""} type="button" aria-pressed={mode === "compact"} onClick={() => { setMode("compact"); saveDisplayPreference(`tuantuan-home-mode:${accountKey}`, "compact"); }}><List size={14} />简洁</button><button className={mode === "info" ? "on" : ""} type="button" aria-pressed={mode === "info"} onClick={() => { setMode("info"); saveDisplayPreference(`tuantuan-home-mode:${accountKey}`, "info"); }}><LayoutList size={14} />信息</button></div><span className="home-vsep" /><span className="home-sync"><span className={`home-sync-dot${failedSources.length || !feed?.last_synced_at ? " stale" : ""}`} />最近同步 <b>{syncTime}</b></span><button className={`home-icon-btn${refreshing ? " home-spin" : ""}`} type="button" disabled={refreshing} onClick={() => { void refresh(); }} aria-label="刷新资讯" title="刷新资讯"><RefreshCw size={16} /></button><button className="home-icon-btn" type="button" aria-label="查看收藏" title="查看收藏" onClick={() => setBookmarksOpen(true)}><Bookmark size={16} /></button><button className="home-link-btn" type="button" onClick={() => setInterestOpen(true)}><SlidersHorizontal size={14} />兴趣设置</button></div></header>
    {(error || failedSources.length > 0) && <div className="home-banner" role="alert"><TriangleAlert size={16} /><span>{error || `${failedSources.map((source) => source.label).join("、")}暂时更新失败`}{feed && " · 已保留现有内容"}</span><button type="button" onClick={() => { void refresh(); }} disabled={refreshing}>重试</button></div>}
    {refreshing && <p className="home-refresh-status" role="status">正在同步公开资讯，已有内容可继续阅读。</p>}
    <HomeModelBenchmarks data={feed?.model_benchmarks} />
    <div className="home-model-news">
      <section className="home-module" aria-labelledby="home-news-title"><div className="home-module-head"><ModuleTitle id="home-news-title" title="模型动态" icon={Sparkles} count={newCount ? `${newCount} 条新` : undefined} /><label className="home-source-filter"><span>来源</span><select aria-label="资讯来源" value={newsPublisher} onChange={event => { setNewsPublisher(event.target.value); setExpandedNews(false); }}><option value="all">全部来源</option>{newsPublishers.map(publisher => <option key={publisher} value={publisher}>{publisher}</option>)}</select></label><Chips options={NEWS_FILTERS} value={newsFilter} onChange={(value) => { setNewsFilter(value); setExpandedNews(false); }} label="动态分类" /></div>{moduleLoading("news", feed?.news.length || 0) ? <ModuleSkeleton /> : visibleNews.length ? <div className="home-feed">{renderArticles(visibleNews)}</div> : <ModuleEmpty title={newsFilter === "all" ? "暂时没有动态" : "没有符合筛选条件的动态"} text={newsFilter === "all" ? newsPublisher === "all" ? "只展示模型发布、能力评测和价格变化，不混入公司新闻。" : "该来源暂无符合当前兴趣的动态，可切换来源或调整兴趣设置。" : "换个分类，或清除筛选查看全部内容。"} onReset={newsFilter !== "all" ? () => setNewsFilter("all") : undefined} onRefresh={newsFilter === "all" ? () => { void refresh(); } : undefined} />}<div className="home-module-foot"><span>全市场公开资讯 · 按原始发布时间排序</span>{(news.length > newsLimit || expandedNews) && <button className="home-more-link" type="button" aria-expanded={expandedNews} onClick={() => setExpandedNews(!expandedNews)}>{expandedNews ? "收起动态" : "查看全部动态"}<ChevronRight size={14} /></button>}</div></section>
    </div>
    <HomeCurationCard curation={feed?.curation} loading={loading} now={now} onRegenerate={() => { void regenerateCuration().catch((cause) => setNotice(cause instanceof Error ? cause.message : "资讯筛选失败，请重试")); }} onOpenInterest={() => setInterestOpen(true)} />
    <HomeDigestCard digest={feed?.digest} loading={loading} now={now} onRegenerate={() => { void generateDigest().catch((cause) => setNotice(cause instanceof Error ? cause.message : "日报生成失败，请重试")); }} onOpenInterest={() => setInterestOpen(true)} />
    <div className="home-module-stack">
      <section className="home-module" aria-labelledby="home-github-title"><div className="home-module-head"><ModuleTitle id="home-github-title" title="GitHub 热榜" icon={Star} /><div className="home-segment" role="group" aria-label="榜单周期">{(["day", "week"] as const).map((value) => <button key={value} type="button" className={period === value ? "on" : ""} aria-pressed={period === value} onClick={() => { setPeriod(value); setExpandedRepos(false); }}>{value === "day" ? "日榜" : "周榜"}</button>)}</div></div><Chips options={REPO_FILTERS} value={repoFilter} onChange={(value) => { setRepoFilter(value); setExpandedRepos(false); }} label="项目分类" className="home-repo-chips" />{moduleLoading("github", (feed?.repositories[period] || []).length) ? <ModuleSkeleton variant="rows" /> : visibleRepos.length ? <div className="home-repositories">{visibleRepos.map((repository) => <RepositoryRow key={repository.id} repository={repository} period={period} {...cardActions(repository.id)} />)}</div> : <ModuleEmpty title={repoFilter === "all" ? "榜单暂未获取" : "没有符合筛选条件的项目"} text={repoFilter === "all" ? "GitHub Trending 同步成功后显示真实榜单。" : "榜单保留原始排名，可清除筛选查看更多项目。"} onReset={repoFilter !== "all" ? () => setRepoFilter("all") : undefined} onRefresh={repoFilter === "all" ? () => { void refresh(); } : undefined} />}<div className="home-module-foot"><span>GitHub Trending · 保留原榜单排名</span>{(repositories.length > 7 || expandedRepos) ? <button className="home-more-link" type="button" aria-expanded={expandedRepos} onClick={() => setExpandedRepos(!expandedRepos)}>{expandedRepos ? "收起榜单" : "完整榜单"}<ChevronRight size={14} /></button> : <a className="home-more-link" href={`https://github.com/trending?since=${period === "day" ? "daily" : "weekly"}`} target="_blank" rel="noreferrer">原始榜单<ChevronRight size={14} /></a>}</div></section>
    </div>
    <div className="home-module-stack"><section className="home-module" aria-labelledby="home-stack-title"><div className="home-module-head"><ModuleTitle id="home-stack-title" title="我的技术栈更新" icon={Layers} count={feed?.preferences.repositories.length ? `已关注 ${feed.preferences.repositories.length} 个` : undefined} /><Chips options={RELEASE_FILTERS} value={releaseFilter} onChange={setReleaseFilter} label="更新类型" /><button className="home-more-link" type="button" onClick={() => setInterestOpen(true)}>管理关注<ChevronRight size={14} /></button></div>{moduleLoading("stack", feed?.updates.length || 0) ? <ModuleSkeleton variant="rows" /> : !feed?.preferences.repositories.length ? <ModuleEmpty title="还没有关注技术栈" text="添加正在使用的公开 GitHub 仓库，集中阅读版本更新与兼容性说明。" onSettings={() => setInterestOpen(true)} /> : updates.length ? <div className="home-stack-updates">{updates.map((release) => <ReleaseRow key={release.id} release={release} now={now} {...cardActions(release.id)} />)}</div> : <ModuleEmpty title={releaseFilter === "all" ? "暂时没有版本更新" : "没有符合筛选条件的更新"} text={releaseFilter === "all" ? "同步后会展示你关注仓库的公开发布说明。" : "清除筛选查看全部版本说明。"} onReset={releaseFilter !== "all" ? () => setReleaseFilter("all") : undefined} />}</section><section className="home-module" aria-labelledby="home-practice-title"><div className="home-module-head"><ModuleTitle id="home-practice-title" title="工程实践精选" icon={Wrench} /><Chips options={PRACTICE_FILTERS} value={practiceFilter} onChange={(value) => { setPracticeFilter(value); setExpandedPractices(false); }} label="实践分类" /></div>{moduleLoading("practice", feed?.practices.length || 0) ? <ModuleSkeleton /> : visiblePractices.length ? <div className="home-practice-grid">{renderArticles(visiblePractices, true)}</div> : <ModuleEmpty title={practiceFilter === "all" ? "暂时没有工程实践" : "没有符合筛选条件的实践"} text={practiceFilter === "all" ? "同步后会展示适合 AI 应用与 Agent 开发的官方实践文章。" : "换个分类，或清除筛选查看全部内容。"} onReset={practiceFilter !== "all" ? () => setPracticeFilter("all") : undefined} />}{(practices.length > 6 || expandedPractices) && <div className="home-module-foot"><span>实践文章保留原始来源与日期</span><button className="home-more-link" type="button" aria-expanded={expandedPractices} onClick={() => setExpandedPractices(!expandedPractices)}>{expandedPractices ? "收起实践" : "查看全部实践"}<ChevronRight size={14} /></button></div>}</section></div>
    <footer className="home-footnote"><span><Github size={14} />公开信息源 · 标题、摘要与原文链接均可核对</span><span>{feed?.last_synced_at ? `同步于 ${formatPublished(feed.last_synced_at, now)}` : "同步完成后显示更新时间"}</span></footer>
    {menu && <HomeMoreMenu target={menu} bookmarked={Boolean(feed?.item_states[menu.item.id]?.bookmarked)} onClose={closeMenu} onBookmark={() => { void changeState(menu.item.id, { bookmarked: !feed?.item_states[menu.item.id]?.bookmarked }); }} onSave={() => { setBookmarksOpen(false); setLibraryItem(menu.item); }} onAnalyze={() => { void onAnalyze(menu.item).catch((cause) => setNotice(cause instanceof Error ? cause.message : "生成分析草稿失败，请重试")); }} onHide={() => { void changeState(menu.item.id, { hidden: true }); }} onCopy={() => { if (!navigator.clipboard?.writeText) { setNotice("当前环境无法复制，请直接打开原文链接"); return; } void navigator.clipboard.writeText(menu.item.url).then(() => setNotice("已复制原文链接")).catch(() => setNotice("复制失败，请直接打开原文链接")); }} />}
    {bookmarksOpen && <HomeBookmarksDialog items={bookmarks} busyItems={busyItems} onBookmark={(id) => { void changeState(id, { bookmarked: false }); }} onMore={(item, anchor) => setMenu({ item, anchor })} openItemId={menu?.item.id || null} onClose={() => { closeMenu(); setBookmarksOpen(false); }} />}
    {interestOpen && <HomeInterestDialog fetchJson={fetchJson} preferences={feed?.preferences || { topics: ["AI", "Agent", "MCP", "RAG", "评测", "开发工具"], repositories: [], digest_profile_id: "" }} savePreferences={savePreferences} onClose={() => setInterestOpen(false)} />}
    {libraryItem && <HomeLibraryDialog item={libraryItem} fetchJson={fetchJson} onLibraryChanged={onLibraryChanged} onClose={() => setLibraryItem(null)} onSaved={(message) => setNotice(message)} />}
    {notice && <div className="home-toast" role="status"><span>{notice}</span>{undoItem && <button type="button" onClick={() => { void changeState(undoItem, { hidden: false }); }}>撤销</button>}<button type="button" aria-label="关闭提示" onClick={() => { setNotice(null); setUndoItem(null); }}><X size={14} /></button></div>}
  </section>;
}
