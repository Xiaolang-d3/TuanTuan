import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./test-fixtures";
import { defaultAgentSettings } from "../src/constants";

test("chat shows truthful request waiting and preserves pages after a connection failure", async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const output = resolve("..", "output", "ppt-flow-research", "screenshots");
  await mkdir(output, { recursive: true });
  await page.addInitScript(() => {
    sessionStorage.setItem("tuantuan-auth-token", "offline-ppt-progress-fixture");
    if (!localStorage.getItem("tuantuan-theme")) localStorage.setItem("tuantuan-theme", "light");
  });
  const job = { id: "c".repeat(32), topic: "季度产品复盘：进展、问题与下一步计划", page_count: 8, conversation_id: 1, model_name: "会话文本模型", status: "running", stage: "page_3_ready", revision: 1, confirmation_required: false, generation_available: true, cancel_requested: false,
    progress: { activity: "正在生成第 4 页" as string | null, started_at: new Date(Date.now() - 65_000).toISOString() as string | null, pages_completed: 3, pages_total: null, outcome_uncertain: false } };
  const responses: Record<string, unknown> = {
    "/auth/me": { user: { id: 1, email: "ppt@local.test", display_name: "测试用户", has_avatar: false } },
    "/system/database-status": { status: "ready", schema_version: 35, required_schema_version: 35 },
    "/library": { profile: { name: "", privacy_mode: "redacted" }, facts: [], sources: [], folders: [], collections: [] },
    "/agent/settings": defaultAgentSettings,
    "/agent/capabilities": { configured: true, active_model_provider: "openai_compatible", active_model_name: "fixture-text", active_platform: "local", model_providers: ["openai_compatible"], platforms: ["local"], tools: [] },
    "/agent/model-connections": { connections: [], profiles: [], default_profile_id: null },
    "/attachments/config": { storage: "local", vision_enabled: false, checks: [] },
    "/conversations": [{ id: 1, title: "季度复盘", status: "active", summary: "", message_count: 0, task_status: "active", updated_at: "2026-11-05T00:00:00Z" }],
    "/chat/messages": [], "/agent/runs/current": { run: null },
    "/extensions": { extensions: [], connections: [], execution: { available: true, reason: "" } },
    "/presentations/capabilities": { available: true, reason: "AI PPT 制作已就绪", model_name: "会话文本模型", limits: { min_pages: 1, max_pages: 20, language: "zh-CN", canvas: "ppt169" } }
  };
  const mutations: string[] = [], pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  // All API requests are intercepted; no real backend or model can be reached.
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/" || url.pathname.startsWith("/assets/") || /\.(?:png|svg|ico|woff2?)$/.test(url.pathname)) return route.continue();
    const path = url.pathname.replace(/^\/api/, "");
    if (route.request().method() !== "GET") mutations.push(path);
    if (path === "/presentations") return route.fulfill({ json: { jobs: [job], next_cursor: null } });
    if (path === `/presentations/${job.id}`) return route.fulfill({ json: job });
    return route.fulfill({ status: path in responses ? 200 : 404, json: responses[path] ?? { detail: `Unhandled offline fixture ${path}` } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/#/chat/1", { waitUntil: "domcontentloaded" });
  const card = page.getByRole("article", { name: /PPT：季度产品复盘/ });
  await expect(card.getByText("正在生成第 4 页")).toBeVisible();
  await expect(card.getByText(/本次请求已等待 1 分/)).toBeVisible();
  await expect(card.getByText(/已完成 3 页/)).toBeVisible();
  await expect(card.getByText(/总页数待确认/)).toBeVisible();
  await expect(card.getByRole("progressbar")).toHaveCount(0);
  await card.screenshot({ path: resolve(output, "progress-desktop.png") });
  Object.assign(job, { status: "failed", revision: 2, error_code: "service_unavailable", error: "模型服务暂时不可用。" });
  Object.assign(job.progress, { activity: null, started_at: null, outcome_uncertain: true });
  await card.getByRole("button", { name: "刷新状态" }).click();
  await expect(card.getByText(/当次模型调用连接失败/)).toBeVisible();
  await expect(card.getByText(/结果待核对.*不会自动重复请求/)).toBeVisible();
  await expect(card.getByText(/已完成 3 页/)).toBeVisible();
  await expect(card.getByText(/本次请求已等待/)).toHaveCount(0);
  await card.screenshot({ path: resolve(output, "failed-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await card.scrollIntoViewIfNeeded();
  await expect(page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(390);
  await card.evaluate(element => { for (let parent = element.parentElement; parent; parent = parent.parentElement) parent.scrollTop = 0; });
  await page.screenshot({ path: resolve(output, "failed-narrow.png"), fullPage: true });
  await page.evaluate(() => { localStorage.setItem("tuantuan-theme", "dark"); });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(card.getByText(/已完成 3 页/)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await card.evaluate(element => { for (let parent = element.parentElement; parent; parent = parent.parentElement) parent.scrollTop = 0; });
  await page.screenshot({ path: resolve(output, "failed-narrow-dark.png"), fullPage: true });
  await card.getByRole("button", { name: "编辑要求后重做" }).click();
  const form = page.getByRole("form", { name: "PPT 制作要求" });
  await expect(form.getByLabel("演示主题与要求")).toHaveValue(job.topic);
  await expect(form.getByLabel("建议页数")).toHaveValue("8");
  expect(mutations).toEqual([]);
  expect(pageErrors).toEqual([]);
});
