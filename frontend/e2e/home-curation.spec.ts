import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"] as const) {
  test(`daily curation opt-in, polling, evidence and rescreen failure in ${theme}`, async ({ page }) => {
    // Deterministic UI fixtures, not a live news feed or a paid model call.
    const today = new Date().toLocaleDateString("en-CA");
    const published = new Date().toISOString();
    const blank = { date: null, generated_at: null, model_name: "", error: "", warnings: [], items: [] };
    const pick = { id: "fixture-news", title: "确定性验收资讯：SDK 新增恢复接口", summary: "测试夹具：官方发布说明介绍检查点接口。", why_it_matters: "评估长任务 Agent 的恢复方案。", url: "https://example.test/official-release", source: "example.test", published_at: published, event_date: today, confidence: "high", evidence: "Test fixture evidence: checkpoint support was added." };
    const feed = {
      news: [], repositories: { day: [], week: [] }, updates: [], practices: [], sources: [], item_states: {}, bookmarks: [],
      preferences: { topics: ["AI", "Agent"], repositories: [], digest_profile_id: "", curation_enabled: false },
      digest: { status: "unconfigured", profile_id: "", model_name: "", generated_at: null, date: null, error: "", overview: "", sections: [] },
      curation: { ...blank, status: "disabled" }, refreshing: false, last_synced_at: null,
    };
    const writes: string[] = [];
    const errors: string[] = [];
    let pending = 0;
    let failRescreen = false;
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(value => { localStorage.setItem("tuantuan-auth-token", "curation-ui-fixture"); localStorage.setItem("tuantuan-theme", value); }, theme);
    await page.route("http://127.0.0.1:4173/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/" || path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) return route.continue();
      if (request.method() !== "GET") writes.push(path);
      if (path === "/auth/me") return route.fulfill({ json: { user: { id: 1, email: "curation@local.test", display_name: "验收用户", has_avatar: false } } });
      if (path === "/system/database-status") return route.fulfill({ json: { status: "ready", schema_version: 31, required_schema_version: 31 } });
      if (path === "/agent/model-connections") return route.fulfill({ json: { connections: [{ id: "connection", enabled: true }], profiles: [{ id: "editor", model_name: "fixture-editor", connection_id: "connection", enabled: true }] } });
      if (path === "/home/preferences") {
        Object.assign(feed.preferences, request.postDataJSON());
        Object.assign(feed.curation, { status: "generating" });
        pending = 1;
        return route.fulfill({ json: feed });
      }
      if (path === "/home/feed/curation") {
        Object.assign(feed.curation, { status: "error", error: failRescreen ? "资讯搜索失败，请稍后重新筛选" : "测试失败" });
        return route.fulfill({ json: feed });
      }
      if (path === "/home/feed") {
        if (pending > 0 && --pending === 0) Object.assign(feed.curation, { status: "ready", date: today, generated_at: published, model_name: "fixture-editor", items: [pick] });
        return route.fulfill({ json: feed });
      }
      return route.fulfill({ status: 404, json: { detail: "Unhandled curation UI test route" } });
    });
    await page.goto("/#/home");
    const card = page.getByRole("region", { name: /今日值得看/ });
    await expect(card.getByText("还没有启用每日资讯精选")).toBeVisible();
    expect(writes).toEqual([]);
    await card.getByRole("button", { name: "兴趣设置" }).click();
    const settings = page.getByRole("dialog", { name: "兴趣设置" });
    const optIn = settings.getByRole("checkbox", { name: "启用每日资讯精选" });
    await expect(optIn).not.toBeChecked();
    expect(writes).toEqual([]);
    await settings.getByRole("combobox").selectOption("editor");
    await optIn.check();
    await settings.getByRole("button", { name: "保存设置" }).click();
    await expect(settings).not.toBeVisible();
    await expect(card.getByRole("status")).toContainText("正在搜索、去重并筛选");
    await expect(card.getByRole("link", { name: pick.title })).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText(pick.why_it_matters)).toBeVisible();
    await card.getByText("可信度与依据").click();
    await expect(card.getByText(pick.evidence)).toBeVisible();
    expect(writes).toEqual(["/home/preferences"]);
    const output = resolve("..", "..", "output", "home-curation");
    await mkdir(output, { recursive: true });
    for (const width of [1280, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(() => card.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      await card.screenshot({ path: resolve(output, `curation-${theme}-${width}.png`), animations: "disabled" });
    }
    failRescreen = true;
    await card.getByRole("button", { name: "重新筛选" }).click();
    await expect(card.getByRole("alert")).toContainText("资讯搜索失败");
    await expect(card.getByRole("link", { name: pick.title })).toBeVisible();
    await expect(card.getByText("今天暂无值得推荐的资讯")).not.toBeVisible();
    expect(writes).toEqual(["/home/preferences", "/home/feed/curation"]);
    expect(errors).toEqual([]);
  });
}
