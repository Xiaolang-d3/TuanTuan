import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./test-fixtures";
import { defaultAgentSettings } from "../src/constants";

test("mocked production workbench is usable on desktop and narrow screens", async ({ page }) => {
  await page.route(/https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, route => route.fulfill({ contentType: "text/css", body: "" }));
  await page.addInitScript(() => {
    localStorage.setItem("tuantuan-auth-token", "ppt-production-e2e-token");
    localStorage.setItem("tuantuan-theme", "light");
  });
  const job = { id: "a".repeat(32), kind: "ppt.generate", status: "waiting_user", revision: 1, stage: "stage1_recommended", prompt: "请审核需求后提交", confirmation_required: true, generation_available: true, cancel_requested: false };
  const readiness = { available: false, code: "runtime_missing", reason: "PPT 本机运行包尚未准备好", limits: { min_pages: 1, max_pages: 20, language: "zh-CN", canvas: "ppt169" } };
  const responses: Record<string, unknown> = {
    "/auth/me": { user: { id: 1, email: "ppt@local.test", display_name: "测试用户", has_avatar: false } },
    "/system/database-status": { status: "ready", schema_version: 35, required_schema_version: 35 },
    "/library": { profile: { name: "", privacy_mode: "redacted" }, facts: [], sources: [], folders: [], collections: [] },
    "/agent/settings": defaultAgentSettings,
    "/agent/capabilities": { configured: true, active_model_provider: "openai_compatible", active_model_name: "mock-model", active_platform: "local", model_providers: ["openai_compatible"], platforms: ["local"], tools: [] },
    "/agent/model-connections": { connections: [], profiles: [], default_profile_id: null },
    "/attachments/config": { storage: "local", vision_enabled: false, checks: [] },
    "/conversations": [{ id: 1, title: "PPT 工作台", status: "active", summary: "", message_count: 0, task_status: "active", updated_at: "2026-11-02T08:00:00Z", last_message_at: "2026-11-02T08:00:00Z" }],
    "/chat/messages": [], "/agent/runs/current": { run: null },
    "/extensions": { extensions: [{ id: "ppt-master", kind: "skill", name: "PPT Master", description: "", source: "builtin", enabled: true, permissions: [], user_invocable: false }], connections: [], execution: { available: true, reason: "" } },
    "/jobs": { jobs: [job] },
    "/presentations/capabilities": readiness,
    [`/jobs/${job.id}/artifacts`]: { artifacts: [{ id: "deck", filename: "result.pptx", version: 1, size: 4, media_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }] }
  };
  await page.route("http://127.0.0.1:4173/**", route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/presentations" && route.request().method() === "POST") return route.fulfill({ status: 201, json: job });
    if (path === `/presentations/${job.id}`) return route.fulfill({ json: job });
    if (path === "/artifacts/deck/versions/1/file") return route.fulfill({ body: Buffer.from("mock"), contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
    if (path === "/jobs") return route.fulfill({ json: { jobs: [job] } });
    if (path === "/" || path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) return route.continue();
    return path in responses ? route.fulfill({ json: responses[path] }) : route.fulfill({ status: 404, json: { detail: `Unhandled PPT fixture: ${path}` } });
  });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto("/#/settings/extensions", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "体验流程" }).click();
  const dialog = page.getByRole("dialog", { name: "PPT 制作" });
  await dialog.getByLabel("演示主题与要求").fill("向团队介绍 AI 工作伙伴，说明三个使用场景与下一步计划。");
  await expect(dialog.getByText("PPT 本机运行包尚未准备好")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "开始制作" })).toBeDisabled();
  const output = resolve("..", "output", "presentation-production");
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: resolve(output, "setup-required.png"), fullPage: true });
  Object.assign(readiness, { available: true, code: "ready", reason: "AI PPT 制作已就绪" });
  await dialog.getByRole("button", { name: "重新检查" }).click();
  await expect(dialog.getByRole("button", { name: "开始制作" })).toBeEnabled();
  await page.screenshot({ path: resolve(output, "ready.png"), fullPage: true });
  await dialog.getByRole("button", { name: "开始制作" }).click();
  await expect(dialog.getByRole("button", { name: "打开需求确认页" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "下载 PPTX" })).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: resolve(output, "desktop.png"), fullPage: true });
  await expect(page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(1440);
  await dialog.getByRole("button", { name: "关闭窗口" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "体验流程" }).click();
  await dialog.getByLabel("继续已有任务").selectOption(job.id);
  await expect(dialog.getByRole("button", { name: "打开需求确认页" })).toBeInViewport();
  await expect(page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(390);
  await page.screenshot({ path: resolve(output, "narrow.png"), fullPage: true });
  Object.assign(job, { status: "succeeded", revision: 2, stage: "delivery_ready", confirmation_required: false });
  await dialog.getByRole("button", { name: "刷新状态" }).click();
  await expect(dialog.getByRole("button", { name: "下载 PPTX" })).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载 PPTX" }).click();
  expect((await downloaded).suggestedFilename()).toBe("result.pptx");
  await expect.poll(() => pageErrors).toEqual([]);
});
