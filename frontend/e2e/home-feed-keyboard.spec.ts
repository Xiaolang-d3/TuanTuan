import { expect, seedFirstRunDone, test } from "./test-fixtures";

const article = {
  id: "demo-feed-article",
  title: "演示动态：模型新增上下文缓存",
  summary: "演示摘要：新版接口支持复用已处理的上下文。",
  url: "https://example.test/model-release",
  source: "演示发布源",
  published_at: "2026-10-08T01:00:00Z",
  category: "release",
  tags: ["AI"],
  image_url: null
};
const email = "home-feed-demo@example.test";

for (const theme of ["light", "dark"] as const) {
  test(`home Feed moves keyboard focus between menu and save dialog in ${theme}`, async ({ page, baseURL }, testInfo) => {
    const writes: string[] = [];
    const feed = {
      news: [article], repositories: { day: [], week: [] }, updates: [], practices: [], sources: [],
      item_states: { [article.id]: { bookmarked: true, hidden: false } }, bookmarks: [{ kind: "news", item: article }],
      preferences: { topics: ["AI"], repositories: [], digest_profile_id: "", curation_enabled: false },
      digest: { status: "unconfigured", profile_id: "", model_name: "", date: null, generated_at: null, error: "", overview: "", sections: [] },
      curation: { status: "disabled", date: null, generated_at: null, model_name: "", error: "", warnings: [], items: [] },
      refreshing: false, last_synced_at: "2026-10-08T02:00:00Z"
    };
    await seedFirstRunDone(page, email);
    await page.addInitScript(value => {
      sessionStorage.setItem("tuantuan-auth-token", "home-feed-demo-session");
      localStorage.setItem("tuantuan-theme", value);
    }, theme);
    await page.route(`${baseURL}/**`, route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/" || path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) return route.continue();
      if (request.method() !== "GET") writes.push(path);
      if (path === "/auth/me") return route.fulfill({ json: { user: { id: 1, email, display_name: "演示用户", has_avatar: false } } });
      if (path === "/system/database-status") return route.fulfill({ json: { status: "ready", schema_version: 31, required_schema_version: 31 } });
      if (path === "/home/feed") return route.fulfill({ json: feed });
      if (path === "/home/workspace") return route.fulfill({ json: {
        generated_at: feed.last_synced_at, conversations: { items: [], error: null }, jobs: { running: [], pending_confirmations: [] },
        weixin: { connected: false, unread_count: 0 }, changelog: { items: [], error: null }, skills: { items: [], error: null }, library_recent: { items: [], error: null }
      } });
      return route.fulfill({ status: 404, json: { detail: "Unhandled home Feed test route" } });
    });

    await page.goto("/#/home");
    const more = page.getByRole("button", { name: `更多：${article.title}` });
    const menu = page.getByRole("menu", { name: `更多操作：${article.title}` });
    const first = menu.getByRole("menuitem", { name: "取消收藏" });
    const save = menu.getByRole("menuitem", { name: "存入文件库" });
    const dialog = page.getByRole("dialog", { name: "存入文件库" });
    const close = dialog.getByRole("button", { name: "关闭", exact: true });
    const confirm = dialog.getByRole("button", { name: "确认存入" });
    const favoritesTrigger = page.getByRole("button", { name: "查看收藏" });
    const favorites = page.getByRole("dialog", { name: "我的收藏" });

    await expect(more).toBeVisible();
    await more.focus();
    await page.keyboard.press("ArrowDown");
    await expect(first).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(save).toBeFocused();
    await menu.screenshot({ path: testInfo.outputPath(`home-feed-menu-${theme}.png`), animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(menu).not.toBeVisible();
    await expect(more).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await expect(first).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(save).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).not.toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "标题" })).toHaveValue(article.title);
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await dialog.screenshot({ path: testInfo.outputPath(`home-feed-save-${theme}.png`), animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(more).toBeFocused();

    await favoritesTrigger.press("Enter");
    const favoriteMore = favorites.getByRole("button", { name: `更多：${article.title}` });
    await favoriteMore.press("ArrowDown");
    await expect(first).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).not.toBeVisible();
    await expect(favoriteMore).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(first).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(save).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(favorites).not.toBeVisible();
    await expect(close).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(favoritesTrigger).toBeFocused();
    expect(writes).toEqual([]);
  });
}
