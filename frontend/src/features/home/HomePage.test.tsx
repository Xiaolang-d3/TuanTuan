import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomePage } from "./HomePage";
import { formatPublished } from "./HomeFeedCards";
import { homeInboxItems } from "./home-metrics";
import type { FetchJson, HomeArticle, HomeDigest, HomeFeedResponse, HomeRepository } from "./types";

const fixtureArticle = (index: number, overrides: Partial<HomeArticle> = {}): HomeArticle => ({ id: `article-${index}`, title: `测试 Agent 更新 ${index}`, summary: `测试摘要 ${index}，只用于确定性 UI 测试。`, url: `https://example.test/news/${index}`, source: "测试官方源", published_at: "2026-10-08T01:00:00Z", category: index % 2 ? "agent" : "mcp", tags: [index % 2 ? "Agent" : "MCP"], image_url: null, ...overrides });
const fixtureRepository = (index: number, overrides: Partial<HomeRepository> = {}): HomeRepository => ({ id: `repository-${index}`, owner: `owner${index}`, name: `repo${index}`, description: `测试项目用途 ${index}`, url: `https://github.com/owner${index}/repo${index}`, language: "TypeScript", stars: 100 + index, period_stars: 10 + index, forks: null, rank: index * 2, tags: [index % 2 ? "Agent" : "评测"], ...overrides });
const fixtureDigest = (overrides: Partial<HomeDigest> = {}): HomeDigest => ({ status: "ready", profile_id: "p1", model_name: "digest-model", generated_at: "2026-10-08T02:00:00Z", date: "2026-10-08", error: "", overview: "今日总览内容。", sections: [{ key: "news", label: "AI / Agent 动态", points: [{ text: "要点一", url: "https://example.test/news/1" }, { text: "要点二", url: null }] }], ...overrides });
function fixtureFeed(): HomeFeedResponse {
  return {
    news: Array.from({ length: 9 }, (_, index) => fixtureArticle(index + 1)),
    repositories: { day: Array.from({ length: 9 }, (_, index) => fixtureRepository(index + 1)), week: [fixtureRepository(1, { id: "weekly-1", name: "weekly-repo", rank: 4, period_stars: 80 })] },
    updates: [{ id: "release-1", repo: "owner/framework", name: "测试框架", version: "v2.0.0", previous_version: "v1.0.0", published_at: "2026-10-07T01:00:00Z", changes: ["测试发布说明"], compatibility: "review", url: "https://github.com/owner/framework/releases/tag/v2.0.0" }],
    practices: [fixtureArticle(20, { title: "测试工程实践", category: "rag", tags: ["RAG"], published_at: null })],
    sources: [{ id: "github", label: "GitHub Trending", kind: "github", status: "ready", url: "https://github.com/trending", last_success_at: "2026-10-08T02:00:00Z", error: null }],
    preferences: { topics: ["AI", "Agent", "MCP", "RAG", "评测", "开发工具"], repositories: ["owner/framework"], digest_profile_id: "" },
    item_states: {}, bookmarks: [], digest: fixtureDigest({ status: "unconfigured", profile_id: "", model_name: "", generated_at: null, date: null, overview: "", sections: [] }), refreshing: false, last_synced_at: "2026-10-08T02:00:00Z"
  };
}
function setup(initial = fixtureFeed()) {
  let snapshot = initial;
  const request = vi.fn(async (path: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (path === "/home/preferences") snapshot.preferences = body;
    if (path === "/agent/model-connections") return { connections: [{ id: "c1", enabled: true }], profiles: [{ id: "p1", model_name: "digest-model", connection_id: "c1", enabled: true }], default_profile_id: "p1" };
    if (path === "/home/feed/digest") { snapshot.digest = fixtureDigest({ status: "generating", overview: "", sections: [] }); return structuredClone(snapshot); }
    if (path.startsWith("/home/feed/items/")) {
      const id = decodeURIComponent(path.split("/").at(-2)!);
      snapshot.item_states[id] = { ...(snapshot.item_states[id] || { bookmarked: false, hidden: false }), ...body };
      if (body.bookmarked === true) {
        const article = snapshot.news.find((item) => item.id === id);
        if (article) snapshot.bookmarks = [...(snapshot.bookmarks || []), { kind: "news", item: article }];
      }
      if (body.bookmarked === false) snapshot.bookmarks = snapshot.bookmarks?.filter((bookmark) => bookmark.item.id !== id);
    }
    if (path === "/library/sources") return { source: { id: 80 } };
    return structuredClone(snapshot);
  });
  const onAnalyze = vi.fn(async () => {});
  const onLibraryChanged = vi.fn(async () => {});
  const props = { fetchJson: request as FetchJson, accountName: "测试开发者", accountKey: "qa-account", onAnalyze, onLibraryChanged };
  return { ...props, request, getSnapshot: () => snapshot, updateSnapshot: (value: HomeFeedResponse) => { snapshot = value; }, render: () => render(<HomePage {...props} />) };
}
async function load() { await screen.findByRole("link", { name: "测试 Agent 更新 1" }); }

beforeEach(() => { window.localStorage.clear(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 9, 8, 11, 59, 59)); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("home-metrics", () => {
  it("keeps source evidence for library review", () => {
    expect(homeInboxItems([{ id: 1, statement: "每天记录问题", evidence: [{ excerpt: "原始阅读笔记", source_title: "笔记" }] }])).toEqual([expect.objectContaining({ id: 1, title: "每天记录问题", source: "原始阅读笔记", sourceLabel: "笔记" })]);
  });
});

describe("developer HomePage", () => {
  it("uses model selection news and its three filters instead of raw company announcements", async () => {
    const initial = fixtureFeed();
    initial.model_news = [fixtureArticle(1, { category: "release" }), fixtureArticle(2, { category: "pricing" })];
    initial.news.push(fixtureArticle(90, { title: "公司融资新闻" }));
    setup(initial).render();
    await load();
    expect(screen.queryByRole("link", { name: "公司融资新闻" })).not.toBeInTheDocument();
    const categories = screen.getByRole("group", { name: "动态分类" });
    fireEvent.click(within(categories).getByRole("button", { name: "价格与成本" }));
    expect(screen.getByRole("link", { name: "测试 Agent 更新 2" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "测试 Agent 更新 1" })).not.toBeInTheDocument();
    fireEvent.click(within(categories).getByRole("button", { name: "新模型" }));
    expect(screen.getByRole("link", { name: "测试 Agent 更新 1" })).toBeVisible();
  });
  it("keeps chronological order without a vendor quota and can filter every source", async () => {
    const initial = fixtureFeed();
    const publishers = ["OpenAI", "Claude", "Gemini", "DeepSeek", "千问", "混元", "新模型实验室"];
    initial.news = [
      ...Array.from({ length: 8 }, (_, index) => fixtureArticle(index + 1, { source: "OpenAI", tags: ["AI"] })),
      ...publishers.slice(1).map((source, index) => fixtureArticle(index + 30, { source, title: `${source} 官方更新`, tags: ["AI"], published_at: "2026-09-01T00:00:00Z" }))
    ];
    initial.sources = publishers.map((publisher, index) => ({ id: `source-${index}`, publisher, label: `${publisher} 官方动态`, kind: "news", status: "ready", url: "https://example.test/news", last_success_at: initial.last_synced_at, error: null }));
    setup(initial).render();
    await load();
    const selector = screen.getByRole("combobox", { name: "资讯来源" });
    expect(within(selector).getAllByRole("option")).toHaveLength(publishers.length + 1);
    expect(screen.queryByRole("link", { name: "混元 官方更新" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看全部动态" }));
    for (const publisher of publishers.slice(1)) expect(screen.getByRole("link", { name: `${publisher} 官方更新` })).toBeVisible();
    fireEvent.change(selector, { target: { value: "DeepSeek" } });
    expect(screen.getByRole("link", { name: "DeepSeek 官方更新" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "测试 Agent 更新 1" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "千问 官方更新" })).not.toBeInTheDocument();
    fireEvent.change(selector, { target: { value: "all" } });
    fireEvent.click(screen.getByRole("button", { name: "查看全部动态" }));
    expect(screen.getByRole("link", { name: "混元 官方更新" })).toBeVisible();
  });

  it("loads real feed data into four modules and keeps the local clock synchronized", async () => {
    const page = setup(); page.render(); await load();
    expect(page.request).toHaveBeenCalledWith("/home/feed", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("早上好，测试开发者");
    for (const title of ["模型动态", "GitHub 热榜", "我的技术栈更新", "工程实践精选"]) expect(screen.getByRole("heading", { name: new RegExp(title.replace("/", "\\/")) })).toBeInTheDocument();
    expect(screen.getByLabelText("当前时间")).toHaveTextContent("11:59");
    vi.setSystemTime(new Date(2026, 9, 8, 18, 5));
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(screen.getByLabelText("当前时间")).toHaveTextContent("18:05");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("晚上好");
    expect(screen.queryByText("组件状态")).not.toBeInTheDocument();
    expect(screen.queryByText("即将上线")).not.toBeInTheDocument();
  });

  it("switches to compact mode without removing information and persists display choices per account", async () => {
    const page = setup(); const view = page.render(); await load();
    fireEvent.click(screen.getByRole("button", { name: "简洁" }));
    expect(screen.getByLabelText("开发者首页")).toHaveAttribute("data-mode", "compact");
    expect(screen.getByRole("link", { name: "测试 Agent 更新 9" })).toBeInTheDocument();
    expect(window.localStorage.getItem("tuantuan-home-mode:qa-account")).toBe("compact");
    expect(screen.queryByRole("button", { name: /切换.*主题/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("开发者首页")).not.toHaveAttribute("data-theme");
    view.unmount();
    render(<HomePage {...page} accountKey="another-account" />); await load();
    expect(screen.getByLabelText("开发者首页")).toHaveAttribute("data-mode", "info");
    expect(screen.getByLabelText("开发者首页")).not.toHaveAttribute("data-theme");
  });

  it("filters news, resets an empty selection, and expands then collapses the real list", async () => {
    setup().render(); await load();
    expect(screen.queryByRole("link", { name: "测试 Agent 更新 9" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看全部动态" }));
    expect(screen.getByRole("link", { name: "测试 Agent 更新 9" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起动态" }));
    fireEvent.click(within(screen.getByRole("group", { name: "动态分类" })).getByRole("button", { name: "价格与成本" }));
    expect(screen.getByText("没有符合筛选条件的动态")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByRole("link", { name: "测试 Agent 更新 1" })).toBeInTheDocument();
  });

  it("keeps original GitHub rankings after filtering and switches between actual period snapshots", async () => {
    setup().render(); await load();
    fireEvent.click(within(screen.getByRole("group", { name: "项目分类" })).getByRole("button", { name: "评测" }));
    const repo = screen.getByRole("link", { name: "owner2/repo2" }).closest("article")!;
    expect(within(repo).getByText("4")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "owner1/repo1" })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "项目分类" })).getByRole("button", { name: "全部" }));
    fireEvent.click(screen.getByRole("button", { name: "周榜" }));
    expect(screen.getByRole("link", { name: "owner1/weekly-repo" })).toBeInTheDocument();
    expect(screen.getByText("+80 本周")).toBeInTheDocument();
  });

  it("persists bookmarks and opens snapshots after the original item leaves the latest feed", async () => {
    const initial = fixtureFeed();
    initial.bookmarks = [{ kind: "news", item: fixtureArticle(80, { title: "移出动态的历史收藏" }) }];
    initial.item_states["article-80"] = { bookmarked: true, hidden: false };
    const page = setup(initial); page.render(); await load();
    fireEvent.click(screen.getByRole("button", { name: "收藏：测试 Agent 更新 1" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "取消收藏：测试 Agent 更新 1" })).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(screen.getByRole("button", { name: "查看收藏" }));
    const dialog = screen.getByRole("dialog", { name: "我的收藏" });
    expect(within(dialog).getByRole("link", { name: "移出动态的历史收藏" })).toHaveAttribute("href", "https://example.test/news/80");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消收藏：移出动态的历史收藏" }));
    await waitFor(() => expect(within(dialog).queryByRole("link", { name: "移出动态的历史收藏" })).not.toBeInTheDocument());
  });

  it("supports menu keyboard navigation, Escape, focus return, hide and undo", async () => {
    const page = setup(); page.render(); await load();
    const opener = screen.getByRole("button", { name: "更多：测试 Agent 更新 1" });
    fireEvent.click(opener);
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "收藏" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(within(menu).getByRole("menuitem", { name: "存入文件库" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(); expect(opener).toHaveFocus();
    fireEvent.click(opener); fireEvent.click(screen.getByRole("menuitem", { name: "隐藏此条" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "测试 Agent 更新 1" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await load();
    expect(page.request).toHaveBeenCalledWith("/home/feed/items/article-1/state", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ hidden: false }) }));
  });

  it("opens an editable save preview and creates a redacted library source only after confirmation", async () => {
    const page = setup(); page.render(); await load();
    fireEvent.click(screen.getByRole("button", { name: "更多：测试 Agent 更新 1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "存入文件库" }));
    expect(page.request.mock.calls.some(([path]) => path === "/library/sources")).toBe(false);
    const dialog = screen.getByRole("dialog", { name: "存入文件库" });
    fireEvent.change(within(dialog).getByLabelText("标题"), { target: { value: "编辑后的资讯标题" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认存入" }));
    await waitFor(() => expect(page.onLibraryChanged).toHaveBeenCalledTimes(1));
    const saved = page.request.mock.calls.find(([path]) => path === "/library/sources")!;
    expect(JSON.parse(String(saved[1]?.body))).toEqual(expect.objectContaining({ title: "编辑后的资讯标题", privacy_mode: "redacted", content: expect.stringContaining("https://example.test/news/1") }));
    expect(page.onAnalyze).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "存入文件库" })).not.toBeInTheDocument();
  });

  it("keeps the library preview open with an error when saving fails", async () => {
    const page = setup(); const fetchJson: FetchJson = async (path, options) => { if (path === "/library/sources") throw new Error("保存连接失败"); return page.fetchJson(path, options); };
    render(<HomePage {...page} fetchJson={fetchJson} />); await load();
    fireEvent.click(screen.getByRole("button", { name: "更多：测试 Agent 更新 1" })); fireEvent.click(screen.getByRole("menuitem", { name: "存入文件库" }));
    fireEvent.click(screen.getByRole("button", { name: "确认存入" }));
    await screen.findByText("保存连接失败");
    expect(screen.getByRole("dialog", { name: "存入文件库" })).toBeInTheDocument();
    expect(page.onLibraryChanged).not.toHaveBeenCalled();
    expect(screen.queryByText("已存入文件库")).not.toBeInTheDocument();
  });

  it("creates an analysis draft only through the explicit AI action", async () => {
    const page = setup(); page.render(); await load();
    fireEvent.click(screen.getByRole("button", { name: "更多：测试 Agent 更新 1" })); fireEvent.click(screen.getByRole("menuitem", { name: "交给 AI 分析" }));
    await waitFor(() => expect(page.onAnalyze).toHaveBeenCalledWith(expect.objectContaining({ kind: "article", id: "article-1", title: "测试 Agent 更新 1", url: "https://example.test/news/1" })));
    expect(page.request.mock.calls.some(([path]) => path === "/library/sources")).toBe(false);
  });

  it("validates and saves interests, filters matching topics, and cancels without mutation", async () => {
    const page = setup(); page.render(); await load();
    fireEvent.click(screen.getAllByRole("button", { name: "兴趣设置" })[0]);
    const dialog = screen.getByRole("dialog", { name: "兴趣设置" });
    await within(dialog).findByRole("option", { name: "digest-model" });
    fireEvent.change(within(dialog).getByLabelText("日报模型", { exact: false }), { target: { value: "p1" } });
    fireEvent.change(within(dialog).getByLabelText("公开仓库", { exact: false }), { target: { value: "invalid" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存设置" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("仓库格式");
    fireEvent.change(within(dialog).getByLabelText("公开仓库", { exact: false }), { target: { value: "https://github.com/owner/tool\nowner/tool" } });
    for (const topic of ["AI", "MCP", "RAG", "评测", "开发工具"]) fireEvent.click(within(dialog).getByRole("button", { name: topic }));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(page.getSnapshot().preferences).toEqual({ topics: ["Agent"], repositories: ["owner/tool"], digest_profile_id: "p1" });
    expect(screen.queryByRole("link", { name: "测试 Agent 更新 2" })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "兴趣设置" })[0]);
    const requests = page.request.mock.calls.length;
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
    expect(page.request).toHaveBeenCalledTimes(requests);
  });

  it("renders the generated digest with original links, collapses points, and regenerates on demand", async () => {
    const initial = fixtureFeed();
    initial.preferences.digest_profile_id = "p1";
    initial.digest = fixtureDigest();
    const page = setup(initial); page.render(); await load();
    const digestRegion = screen.getByRole("region", { name: /今日 AI 日报/ });
    expect(within(digestRegion).getByText("今日总览内容。")).toBeInTheDocument();
    expect(within(digestRegion).getByRole("link", { name: "要点一" })).toHaveAttribute("href", "https://example.test/news/1");
    expect(within(digestRegion).getByText("要点二")).toBeInTheDocument();
    expect(within(digestRegion).getByText("由 digest-model 生成")).toBeInTheDocument();
    fireEvent.click(within(digestRegion).getByRole("button", { name: "收起要点" }));
    expect(within(digestRegion).queryByRole("link", { name: "要点一" })).not.toBeInTheDocument();
    fireEvent.click(within(digestRegion).getByRole("button", { name: "重新生成" }));
    await waitFor(() => expect(page.request).toHaveBeenCalledWith("/home/feed/digest", expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(screen.getByRole("button", { name: /生成中/ })).toBeDisabled());
  });

  it("marks updated sources as stale and guides unconfigured accounts to interest settings", async () => {
    const page = setup(); page.render(); await load();
    const digestRegion = screen.getByRole("region", { name: /今日 AI 日报/ });
    expect(within(digestRegion).getByText("还没有启用 AI 日报")).toBeInTheDocument();
    fireEvent.click(within(digestRegion).getByRole("button", { name: "兴趣设置" }));
    expect(screen.getByRole("dialog", { name: "兴趣设置" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));

    const stale = fixtureFeed();
    stale.preferences.digest_profile_id = "p1";
    stale.digest = fixtureDigest({ status: "stale" });
    cleanup();
    setup(stale).render(); await load();
    const staleRegion = screen.getByRole("region", { name: /今日 AI 日报/ });
    expect(within(staleRegion).getByText("公开来源有更新，可重新生成日报。")).toBeInTheDocument();
    expect(within(staleRegion).getByRole("link", { name: "要点一" })).toBeInTheDocument();
  });

  it("preserves stale content on source failure, shows unknown dates honestly, and collapses broken images", async () => {
    const initial = fixtureFeed(); initial.news[0] = fixtureArticle(1, { image_url: "https://example.test/cover.png", published_at: "invalid" }); initial.sources[0].status = "error";
    setup(initial).render(); await load();
    expect(screen.getByRole("alert")).toHaveTextContent("GitHub Trending暂时更新失败 · 已保留现有内容");
    const article = screen.getByRole("link", { name: "测试 Agent 更新 1" }).closest("article")!;
    expect(within(article).getByText("时间未提供")).toBeInTheDocument();
    const image = article.querySelector("img")!; expect(image).toHaveAttribute("alt", "");
    fireEvent.error(image); expect(article.querySelector("img")).toBeNull(); expect(article).toHaveClass("home-no-img");
    expect(formatPublished(null)).toBe("时间未提供");
  });

  it("hides practice covers including cached images while retaining news covers and article actions", async () => {
    const initial = fixtureFeed();
    initial.news[0].image_url = "https://example.test/news-cover.png";
    initial.practices = [
      fixtureArticle(20, { title: "带插画的工程实践", category: "rag", image_url: "https://example.test/decorative.svg" }),
      fixtureArticle(21, { title: "带照片的工程实践", category: "rag", summary: "", image_url: "https://example.test/photo.png" })
    ];
    const page = setup(initial); page.render(); await load();
    const practice = screen.getByRole("region", { name: "工程实践精选" });
    const illustration = within(practice).getByRole("link", { name: "带插画的工程实践" }).closest("article")!;
    expect(practice.querySelector("img")).toBeNull();
    expect(practice.querySelector(".home-card-media")).toBeNull();
    expect(within(practice).getByRole("link", { name: "带插画的工程实践" })).toHaveAttribute("href", initial.practices[0].url);
    expect(within(practice).getByText(initial.practices[0].summary)).toBeInTheDocument();
    expect(within(practice).getByRole("link", { name: "带照片的工程实践" })).toBeInTheDocument();
    expect(within(practice).getByRole("link", { name: "打开原文：带插画的工程实践" })).toBeInTheDocument();
    fireEvent.click(within(practice).getByRole("button", { name: "收藏：带插画的工程实践" }));
    await waitFor(() => expect(page.request).toHaveBeenCalledWith("/home/feed/items/article-20/state", expect.objectContaining({ method: "PATCH" })));
    expect(screen.getByRole("link", { name: "测试 Agent 更新 1" }).closest("article")!.querySelector("img")).toHaveAttribute("src", initial.news[0].image_url);
    expect(illustration.querySelector(".home-card-media")).toBeNull();
    expect(within(illustration).getByRole("link", { name: "带插画的工程实践" })).toBeInTheDocument();
  });

  it("does not present review-only releases as safe upgrades and guides unsubscribed accounts", async () => {
    const initial = fixtureFeed(); initial.preferences.repositories = [];
    setup(initial).render(); await load();
    expect(screen.getByText("还没有关注技术栈")).toBeInTheDocument();
    expect(screen.queryByText("可直接升级")).not.toBeInTheDocument();
  });
});
