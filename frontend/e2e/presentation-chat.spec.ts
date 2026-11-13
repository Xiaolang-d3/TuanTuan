import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./test-fixtures";
import { defaultAgentSettings } from "../src/constants";

test("chat PPT keeps its task, confirms both decisions, previews and downloads", async ({ page }) => {
  test.setTimeout(60_000);
  // Keep this offline fixture deterministic; external font stalls must not
  // consume the budget for two confirmations and several page reloads.
  await page.route(/https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, route => route.fulfill({ contentType: "text/css", body: "" }));
  await page.addInitScript(() => {
    sessionStorage.setItem("tuantuan-auth-token", "ppt-chat-fixture-token");
    localStorage.setItem("tuantuan-theme", "light");
  });
  const jobs: Array<Record<string, any>> = [];
  const retries: Array<Record<string, any>> = [];
  let productionReads = 0;
  let failList = false;
  const output = resolve("..", "output", "presentation-chat-ux");
  await mkdir(output, { recursive: true });
  const preview = await readFile(resolve("..", "output", "ppt-generation-selector-20261104", "P01.png")).catch(() => Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgZkAAAAASUVORK5CYII=", "base64"));
  const deck = await readFile(resolve("..", "output", "ppt-generation-selector-20261104", "result.pptx")).catch(() => Buffer.from("mock-pptx-download"));
  const artifacts = [{ id: "deck", filename: "result.pptx", version: 1, size: deck.length, media_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }, ...[1, 2].map(index => ({ id: `page-${index}`, filename: `P0${index}.png`, version: 1, size: preview.length, media_type: "image/png" }))];
  const conversation = (id: number) => ({ id, title: id === 1 ? "季度复盘" : "另一个会话", status: "active", summary: "", message_count: 0, task_status: "active", updated_at: "2026-11-04T08:00:00Z" });
  const responses: Record<string, unknown> = {
    "/auth/me": { user: { id: 1, email: "ppt-chat@local.test", display_name: "测试用户", has_avatar: false } },
    "/system/database-status": { status: "ready", schema_version: 35, required_schema_version: 35 },
    "/library": { profile: { name: "", privacy_mode: "redacted" }, facts: [], sources: [], folders: [], collections: [] },
    "/agent/settings": defaultAgentSettings,
    "/agent/capabilities": { configured: true, active_model_provider: "openai_compatible", active_model_name: "fixture-text", active_platform: "local", model_providers: ["openai_compatible"], platforms: ["local"], tools: [] },
    "/agent/model-connections": { connections: [], profiles: [], default_profile_id: null },
    "/agent/models/capabilities": { model_name: "fixture-text", provider: "openai_compatible", provider_label: "测试文本模型", protocol: "openai", protocol_label: "OpenAI 兼容", vision: { status: "unknown", source: "client", detail: "测试数据" }, streaming: { status: "supported", source: "client", detail: "测试数据" }, tools: { status: "supported", source: "client", detail: "测试数据" }, probed: false, probe_error: null },
    "/agent/model-monitor": { status: "unknown", status_message: "暂无调用记录", model_name: "fixture-text", base_url: "", protocol: "openai", api_key_configured: true, window_hours: 24, summary: { total_requests: 0, successful_requests: 0, failed_requests: 0, success_rate: null, average_latency_ms: null, p95_latency_ms: null, timeout_count: 0, consecutive_failures: 0 }, error_breakdown: [], last_event_at: null, last_success_at: null, last_check_at: null, recent_events: [] },
    "/attachments/config": { storage: "local", vision_enabled: false, checks: [] },
    "/conversations": [conversation(1), conversation(2)], "/chat/messages": [], "/agent/runs/current": { run: null },
    "/document-reviews": { jobs: [] },
    "/extensions": { extensions: [{ id: "ppt-master", kind: "skill", name: "PPT Master", enabled: true, user_invocable: true, permissions: [], source: "builtin" }], connections: [], execution: { available: true, reason: "AI PPT 制作已就绪" } },
    "/presentations/capabilities": { available: true, reason: "AI PPT 制作已就绪", model_name: "会话文本模型", limits: { min_pages: 1, max_pages: 20, language: "zh-CN", canvas: "ppt169" } }
  };
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("http://127.0.0.1:4173/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = route.request().method();
    if (/^\/presentations\/[ab]{32}\/retry$/.test(path) && method === "POST") {
      const body = route.request().postDataJSON();
      expect(body.expected_revision).toBe(jobs[0].revision);
      expect(body.request_id).toBeTruthy();
      retries.push(body);
      Object.assign(jobs[0], { status: "queued", revision: jobs[0].revision + 1, stage: "final_confirmed", confirmation_required: false, error: "", error_code: "", retryable: false, ...(body.topic ? { topic: body.topic, page_count: body.page_count } : {}) });
      return route.fulfill({ json: jobs[0] });
    }
    if (path === "/presentations" && method === "POST") {
      const body = route.request().postDataJSON();
      expect(body.conversation_id).toBe(1);
      const job = { id: jobs.length ? "b".repeat(32) : "a".repeat(32), topic: body.topic, page_count: body.options.page_count, conversation_id: body.conversation_id, model_name: "会话文本模型", status: "waiting_user", stage: "stage1_recommended", revision: 1, confirmation_required: true, generation_available: true, cancel_requested: false, created_at: `2026-11-04 08:00:0${jobs.length}` };
      jobs.push(job); return route.fulfill({ json: job });
    }
    if (path === "/presentations") {
      if (failList) return route.fulfill({ status: 503, json: { detail: "fixture temporarily offline" } });
      if (jobs[0]?.stage === "page_1_ready" && ++productionReads > 1) Object.assign(jobs[0], { status: "succeeded", stage: "delivery_ready", revision: 5 });
      return route.fulfill({ json: { jobs: jobs.filter(job => job.conversation_id === Number(url.searchParams.get("conversation_id"))), next_cursor: null } });
    }
    if (/\/confirmation-session$/.test(path)) return route.fulfill({ json: { ticket: "one-use-fixture" } });
    if (/\/confirmation-bootstrap$/.test(path)) return route.fulfill({ json: { csrf: "fixture" } });
    if (/\/confirmation\/$/.test(path)) return route.fulfill({ contentType: "text/html", body: `<html lang="zh"><body><h1>审核方案</h1><button onclick="fetch('/api/ppt-fixture-confirm',{method:'POST'})">提交确认</button></body></html>` });
    if (path === "/ppt-fixture-confirm") {
      Object.assign(jobs[0], jobs[0].stage === "stage1_recommended" ? { stage: "stage2_recommended", revision: 2 } : { stage: "page_1_ready", status: "running", confirmation_required: false, revision: 3 });
      return route.fulfill({ json: { ok: true } });
    }
    if (/^\/presentations\/[ab]{32}$/.test(path)) return route.fulfill({ json: jobs.find(job => path.endsWith(job.id)) });
    if (/\/artifacts$/.test(path)) return route.fulfill({ json: { artifacts } });
    if (/\/artifacts\/deck\//.test(path)) return route.fulfill({ contentType: artifacts[0].media_type, body: deck });
    if (/\/artifacts\/page-/.test(path)) return route.fulfill({ contentType: "image/png", body: preview });
    if (path === "/" || path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) return route.continue();
    return route.fulfill({ status: path in responses ? 200 : 404, json: responses[path] ?? { detail: `Unhandled PPT chat fixture: ${path}` } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/#/chat/1", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "技能", exact: true }).click();
  await page.getByRole("button", { name: "PPT Master", exact: true }).click();
  const form = page.getByRole("form", { name: "PPT 制作要求" });
  await form.getByRole("button", { name: "知识分享", exact: true }).click();
  await expect(form.getByLabel("演示主题与要求")).toHaveValue(/【请填写分享主题】/);
  await expect(form.getByRole("button", { name: "开始制作" })).toBeDisabled();
  await expect(form.getByRole("alert")).toContainText("主题");
  expect(jobs).toHaveLength(0);
  await form.screenshot({ path: resolve(output, "topic-required-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(form.getByRole("alert")).toBeVisible();
  await form.screenshot({ path: resolve(output, "topic-required-narrow.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await form.getByLabel("演示主题与要求").fill("季度产品复盘：进展、问题与下一步计划");
  await form.getByLabel("建议页数").fill("21");
  await expect(form.getByRole("button", { name: "开始制作" })).toBeDisabled();
  await expect(form.getByText("请输入 1–20 之间的整数页数")).toBeVisible();
  await form.getByLabel("建议页数").fill("2");
  await page.evaluate(() => { window.location.hash = "#/chat/2"; });
  await expect(form).toHaveCount(0);
  await page.evaluate(() => { window.location.hash = "#/chat/1"; });
  await expect(form.getByLabel("演示主题与要求")).toHaveValue("季度产品复盘：进展、问题与下一步计划");
  await form.getByRole("button", { name: "模型设置", exact: true }).click();
  await expect(page).toHaveURL(/settings\/model/);
  await page.evaluate(() => { window.location.hash = "#/chat/1"; });
  await expect(form.getByLabel("建议页数")).toHaveValue("2");
  await expect(page.getByText(/Unhandled PPT chat fixture/)).toHaveCount(0);
  await form.screenshot({ path: resolve(output, "brief-desktop.png") });
  await form.getByRole("button", { name: "开始制作" }).click();
  const card = page.getByRole("article", { name: /PPT：季度产品复盘/ }).first();
  await expect(card.getByRole("button", { name: "确认需求" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({ path: resolve(output, "chat-waiting-desktop.png"), fullPage: true });
  await card.screenshot({ path: resolve(output, "chat-card.png") });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(card.getByRole("button", { name: "确认需求" })).toBeVisible();
  await card.getByRole("button", { name: "确认需求" }).click();
  await page.frameLocator('iframe[title="PPT 需求确认"]').getByRole("button", { name: "提交确认" }).click();
  await expect(card.getByRole("button", { name: "确认设计" })).toBeVisible();
  await card.getByRole("button", { name: "确认设计" }).click();
  await page.frameLocator('iframe[title="PPT 设计确认"]').getByRole("button", { name: "提交确认" }).click();
  await expect(card.getByText("已编排 1 页", { exact: false })).toBeVisible();
  await expect(card.getByRole("button", { name: "下载 PPTX" })).toBeVisible();
  await card.getByRole("button", { name: "查看逐页预览" }).click();
  const dialog = page.getByRole("dialog", { name: "PPT 逐页预览" });
  await expect(dialog.getByAltText("第 1 页预览")).toBeVisible();
  await dialog.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(dialog.getByAltText("第 2 页预览")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(dialog.getByAltText("第 1 页预览")).toBeVisible();
  await dialog.getByLabel("选择幻灯片").selectOption("1");
  await expect(dialog.getByAltText("第 2 页预览")).toBeVisible();
  const previewDownload = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载 PPTX" }).click();
  expect((await previewDownload).suggestedFilename()).toBe("result.pptx");
  await dialog.getByRole("button", { name: "关闭窗口" }).click();
  const download = page.waitForEvent("download");
  await card.getByRole("button", { name: "下载 PPTX" }).click();
  expect((await download).suggestedFilename()).toBe("result.pptx");
  await page.setViewportSize({ width: 390, height: 844 });
  await card.evaluate(element => element.scrollIntoView({ block: "start" }));
  await expect(card.getByRole("button", { name: "下载 PPTX" })).toBeInViewport();
  await expect(page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(390);
  await page.screenshot({ path: resolve(output, "chat-result-narrow.png"), fullPage: true });
  await card.getByRole("button", { name: "查看逐页预览" }).click();
  await expect(dialog.getByRole("button", { name: "下载 PPTX" })).toBeInViewport();
  await page.screenshot({ path: resolve(output, "preview-narrow.png"), fullPage: true });
  await dialog.getByRole("button", { name: "关闭窗口" }).click();
  Object.assign(jobs[0], { status: "failed", revision: 6, stage: "final_confirmed", retryable: true, retry_requires_confirmation: false, error_code: "presentation_plan_invalid", error: "模型没有返回完整的设计规格和页面方案，已停止制作。请明确演示主题与核心内容，再编辑要求后重做。" });
  await card.getByRole("button", { name: "刷新状态" }).click();
  await expect(card.getByRole("alert")).toContainText("请明确演示主题");
  await card.screenshot({ path: resolve(output, "actionable-plan-failure.png") });
  await card.screenshot({ path: resolve(output, "retry-original-task.png") });
  await card.getByRole("button", { name: "重试制作", exact: true }).click();
  await expect.poll(() => retries.length).toBe(1);
  expect(jobs).toHaveLength(1);
  await expect(page.getByRole("article", { name: /PPT：季度产品复盘/ })).toHaveCount(1);
  Object.assign(jobs[0], { status: "failed", revision: 8, retryable: true, retry_requires_confirmation: true, error_code: "request_timeout", error: "上次模型调用结果待核对。" });
  await card.getByRole("button", { name: "刷新状态" }).click();
  await card.getByRole("button", { name: "重试制作", exact: true }).click();
  await expect(card.getByRole("button", { name: "确认重试", exact: true })).toBeVisible();
  expect(retries).toHaveLength(1);
  await card.getByRole("button", { name: "确认重试", exact: true }).click();
  await expect.poll(() => retries.length).toBe(2);
  expect(retries[1].acknowledge_uncertain).toBe(true);
  expect(jobs).toHaveLength(1);
  Object.assign(jobs[0], { status: "failed", revision: 10, retryable: true, retry_requires_confirmation: false, error_code: "authentication_failed", error: "模型服务认证失败，请检查模型设置。" });
  await card.getByRole("button", { name: "刷新状态" }).click();
  await expect(card.getByRole("button", { name: "检查模型设置" })).toBeVisible();
  await card.getByRole("button", { name: "编辑要求后重做" }).click();
  await expect(form.getByLabel("演示主题与要求")).toHaveValue(jobs[0].topic);
  await expect(form.getByLabel("建议页数")).toHaveValue("2");
  await form.getByLabel("演示主题与要求").fill("季度产品复盘：补充实际进展和新的下一步计划");
  await expect(form.getByRole("button", { name: "保存并重试" })).toBeEnabled();
  await form.screenshot({ path: resolve(output, "edited-retry-original-task.png") });
  await form.getByRole("button", { name: "保存并重试" }).click();
  await expect.poll(() => retries.length).toBe(3);
  expect(jobs).toHaveLength(1);
  expect(jobs[0].topic).toContain("补充实际进展");
  await expect(page.getByRole("article", { name: /PPT：季度产品复盘/ })).toHaveCount(1);
  Object.assign(jobs[0], { status: "failed", revision: 12, retryable: true, error_code: "authentication_failed", error: "模型服务认证失败，请检查模型设置。" });
  await card.getByRole("button", { name: "刷新状态" }).click();
  await page.goto("/#/chat/2", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("article", { name: /PPT：季度产品复盘/ })).toHaveCount(0);
  failList = true;
  await page.goto("/#/chat/1", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "重新读取任务" })).toBeVisible();
  failList = false;
  await page.getByRole("button", { name: "重新读取任务" }).click();
  await expect(card.getByRole("button", { name: "检查模型设置" })).toBeVisible();
  await expect.poll(() => errors).toEqual([]);
});
