import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./test-fixtures";
import { defaultAgentSettings } from "../src/constants";

test("finished deck supports lazy thumbnails, cover entry and remembered navigation", async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const output = resolve("..", "output", "ppt-preview-navigation");
  await mkdir(output, { recursive: true });
  await page.addInitScript(() => {
    sessionStorage.setItem("tuantuan-auth-token", "offline-preview-fixture");
    if (!localStorage.getItem("tuantuan-theme")) localStorage.setItem("tuantuan-theme", "light");
  });
  const topic = "AI 智能体架构分享\n面向研发团队，介绍规划、工具调用与记忆。\n用架构示意解释工作循环，最后给出实践建议。";
  const job = { id: "d".repeat(32), topic, page_count: 20, conversation_id: 1, model_name: "会话文本模型", status: "succeeded", stage: "delivery_ready", revision: 5, confirmation_required: false, generation_available: true, cancel_requested: false };
  const artifacts = [{ id: "deck", filename: "result.pptx", version: 1, size: 10, media_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }, ...Array.from({ length: 20 }, (_, index) => ({ id: `page-${index + 1}`, filename: `P${String(index + 1).padStart(2, "0")}.png`, version: 1, size: 10, media_type: "image/png" }))];
  const responses: Record<string, unknown> = {
    "/auth/me": { user: { id: 1, email: "ppt@local.test", display_name: "测试用户", has_avatar: false } },
    "/system/database-status": { status: "ready", schema_version: 36, required_schema_version: 36 },
    "/library": { profile: { name: "", privacy_mode: "redacted" }, facts: [], sources: [], folders: [], collections: [] },
    "/agent/settings": defaultAgentSettings,
    "/agent/capabilities": { configured: true, active_model_provider: "openai_compatible", active_model_name: "fixture-text", active_platform: "local", model_providers: ["openai_compatible"], platforms: ["local"], tools: [] },
    "/agent/model-connections": { connections: [], profiles: [], default_profile_id: null },
    "/attachments/config": { storage: "local", vision_enabled: false, checks: [] },
    "/channels/weixin": { connected: false, enabled: false, error: "", unread_count: 0, latest_sequence: 0, readable_sequence: 0, read_sequence: 0, binding_id: "" },
    "/conversations": [{ id: 1, title: "智能体架构分享", status: "active", summary: "", message_count: 0, task_status: "active", updated_at: "2026-11-05T00:00:00Z" }],
    "/chat/messages": [], "/agent/runs/current": { run: null },
    "/document-reviews": { jobs: [] },
    "/extensions": { extensions: [], connections: [], execution: { available: true, reason: "" } },
    "/presentations": { jobs: [job], next_cursor: null },
    [`/presentations/${job.id}`]: job,
    [`/jobs/${job.id}/artifacts`]: { artifacts }
  };
  const reads = new Set<number>(), mutations: string[] = [], errors: string[] = [], unexpected: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/" || url.pathname.startsWith("/assets/") || /^\/tuantuan-.*\.(png|svg|ico)$/.test(url.pathname)) return route.continue();
    const path = url.pathname.replace(/^\/api/, "");
    if (request.method() !== "GET") mutations.push(path);
    if (path === "/channels/weixin/events") return route.fulfill({ contentType: "text/event-stream", body: ": offline fixture\n\n" });
    const file = /^\/artifacts\/page-(\d+)\/versions\/1\/file$/.exec(path);
    if (file) {
      const number = Number(file[1]); reads.add(number);
      // Deliberately labelled synthetic slide, never a claim of model generation.
      return route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#f5f7fb"/><text x="80" y="125" font-size="48" fill="#183352" font-family="Microsoft YaHei,sans-serif">AI 智能体架构 · 第 ${number} 页</text><text x="80" y="185" font-size="24" fill="#566a80">浏览器测试示意 · 非 AI 生成成果</text><path d="M340 380H530M750 380H940" stroke="#377ac9" stroke-width="5"/><g fill="#e4edfa" stroke="#8dafd9"><rect x="90" y="285" width="250" height="190" rx="16"/><rect x="530" y="285" width="220" height="190" rx="16"/><rect x="940" y="285" width="250" height="190" rx="16"/></g><g font-family="Microsoft YaHei,sans-serif" font-size="32" fill="#183352"><text x="170" y="390">规划</text><text x="610" y="390">执行</text><text x="1020" y="390">反馈</text></g></svg>` });
    }
    if (path === "/artifacts/deck/versions/1/file") return route.fulfill({ body: "offline-pptx-download-fixture" });
    if (!(path in responses)) unexpected.push(path);
    return route.fulfill({ status: path in responses ? 200 : 404, json: responses[path] ?? { detail: "Unexpected offline fixture request" } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/#/chat/1", { waitUntil: "domcontentloaded" });
  const card = page.getByRole("article", { name: "PPT：AI 智能体架构分享" });
  await expect(card.getByRole("heading")).toHaveText("AI 智能体架构分享");
  await card.getByText("查看制作要求").click();
  await expect(card.locator(".ppt-original-brief p")).toHaveText(topic);
  await card.getByRole("button", { name: "打开第 1 页预览" }).click();
  const dialog = page.getByRole("dialog", { name: "PPT 逐页预览" });
  await expect(dialog.getByAltText("第 1 页预览")).toBeVisible();
  expect(reads.has(20)).toBe(false);
  expect(reads.size).toBeLessThan(20);
  await dialog.getByRole("button", { name: "预览第 3 页", exact: true }).click();
  await expect(dialog.getByAltText("第 3 页预览")).toBeVisible();
  await page.screenshot({ path: resolve(output, "preview-desktop.png") });
  await dialog.getByRole("button", { name: "关闭窗口" }).click();
  await card.getByRole("button", { name: "查看逐页预览" }).click();
  await expect(dialog.getByAltText("第 3 页预览")).toBeVisible();
  await page.keyboard.press("End");
  await expect(dialog.getByAltText("第 20 页预览")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "预览第 20 页", exact: true })).toBeInViewport();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole("button", { name: "预览第 20 页", exact: true })).toBeInViewport();
  await expect(page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(390);
  await expect(dialog.getByRole("button", { name: "下载 PPTX" })).toBeInViewport();
  await page.screenshot({ path: resolve(output, "preview-narrow.png") });
  const downloaded = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载 PPTX" }).click();
  expect((await downloaded).suggestedFilename()).toBe("result.pptx");
  await dialog.getByRole("button", { name: "关闭窗口" }).click();
  await page.evaluate(() => { localStorage.setItem("tuantuan-theme", "dark"); });
  await page.reload({ waitUntil: "domcontentloaded" });
  await card.getByRole("button", { name: "打开第 1 页预览" }).click();
  await expect(dialog.getByAltText("第 1 页预览")).toBeVisible();
  await page.screenshot({ path: resolve(output, "preview-narrow-dark.png") });
  expect(mutations).toEqual([]); expect(errors).toEqual([]); expect(unexpected).toEqual([]);
});
