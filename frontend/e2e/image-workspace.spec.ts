import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./test-fixtures";

const origin = process.env.IMAGE_WORKSPACE_E2E_ORIGIN || "http://127.0.0.1:4173";
const asset = { id: "fixture-image", origin: "generated", kind: "image", original_filename: "生成图片-1.png", parse_status: "parsed", width: 1, height: 1 };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aS0AAAAASUVORK5CYII=", "base64");

test("image workspace generates in a saved conversation and preserves its draft across navigation", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolveRequest => { release = resolveRequest; });
  let created = false;
  let generationCalls = 0;
  let authorizedImageRead = false;
  const savedMessages: Array<Record<string, unknown>> = [];
  const conversation = { id: 42, title: "图片创作", status: "active", kernel: "tuantuan", message_count: 2, updated_at: "2026-11-18T00:00:00Z" };
  await page.addInitScript(() => {
    sessionStorage.setItem("tuantuan-auth-token", "e2e-token");
    localStorage.setItem("tuantuan-first-run:e2e@local.test", "done");
  });
  await page.route(`${origin}/**`, async route => {
    const request = route.request();
    if (!["fetch", "xhr"].includes(request.resourceType())) return route.continue();
    const path = new URL(request.url()).pathname.replace(/^\/api(?=\/)/, "");
    if (path === "/auth/me") return route.fulfill({ json: { user: { id: 1, email: "e2e@local.test", display_name: "测试用户", has_avatar: false } } });
    if (path === "/system/database-status") return route.fulfill({ json: { status: "ready" } });
    if (path === "/agent/kernels") return route.fulfill({ json: { default_kernel: "tuantuan", choices: [] } });
    if (path === "/channels/weixin") return route.fulfill({ json: { connected: false, enabled: false, error: "" } });
    if (path === "/conversations" && request.method() === "POST") {
      expect(request.postDataJSON()).toEqual({ title: "图片创作", kernel: "tuantuan" });
      created = true;
      return route.fulfill({ json: conversation });
    }
    if (path === "/conversations") return route.fulfill({ json: created ? [conversation] : [] });
    if (path === "/chat/messages") return route.fulfill({ json: savedMessages });
    if (path === "/agent/runs/current") return route.fulfill({ json: { run: null } });
    if (path === "/agent/capabilities") return route.fulfill({ json: { configured: true, tools: [] } });
    if (path === "/attachments/config") return route.fulfill({ json: { storage: "local", vision_enabled: false, checks: [] } });
    if (path === "/ag-ui") {
      generationCalls += 1;
      const body = request.postDataJSON();
      const content = body.messages[body.messages.length - 1].content;
      expect(content).toBe("请生成一张图片：\n\n一只猫");
      expect(body.forwardedProps).toMatchObject({ conversationId: 42, modelProfileId: null, skillId: null, webSearch: false });
      await pending;
      const userMessage = { id: 11, role: "user", content, created_at: "2026-11-18T00:00:00Z" };
      const assistantMessage = { id: 12, role: "assistant", content: "", created_at: "2026-11-18T00:00:01Z", payload: { agent: { provider: "fixture", platform: "local", rounds: 1, status: "done", events: [], assets: [asset] } } };
      savedMessages.push(userMessage, assistantMessage);
      const events = [
        { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
        { type: "STATE_SNAPSHOT", snapshot: { tuantuan: { status: "done", userMessage, assistantMessage } } },
        { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId }
      ];
      return route.fulfill({ contentType: "text/event-stream", body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") });
    }
    if (path === "/chat-assets/fixture-image/file" || path === "/chat-assets/fixture-image/thumbnail") {
      authorizedImageRead = request.headers().authorization === "Bearer e2e-token";
      return route.fulfill({ contentType: "image/png", body: png });
    }
    return route.fulfill({ status: 404, json: { detail: `Unhandled fixture route: ${path}` } });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/#/images`);
  await expect(page.getByRole("heading", { name: "让想法成为画面" })).toBeVisible();
  const prompt = page.getByRole("textbox", { name: "画面描述" });
  await prompt.fill("一只猫");
  await expect(page.getByRole("button", { name: "生成图片", exact: true })).toBeEnabled();
  const output = resolve("..", "tmp", "image-workspace");
  await mkdir(output, { recursive: true });
  await page.getByRole("heading", { name: "让想法成为画面" }).click();
  await page.screenshot({ path: resolve(output, "desktop.png"), animations: "disabled" });
  await page.getByRole("button", { name: /当前浅色，点击切换到深色/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: resolve(output, "dark.png"), animations: "disabled" });
  await page.getByRole("button", { name: /当前深色，点击切换到主题色蓝/ }).click();
  await page.getByRole("button", { name: /当前主题色蓝，点击切换到浅色/ }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(prompt).toBeVisible();
  await page.screenshot({ path: resolve(output, "mobile.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole("button", { name: "生成图片", exact: true }).click();
  await expect(page.getByRole("button", { name: "正在生成…" })).toBeDisabled();
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "视频" }).click();
  await nav.getByRole("button", { name: "对话" }).click();
  await expect(page).toHaveURL(/#\/chat\/42$/);
  await nav.getByRole("button", { name: "图片" }).click();
  await expect(prompt).toHaveValue("一只猫");
  await expect(page.getByText("正在生成图片，请稍候…")).toBeVisible();
  release();
  await expect(page.getByRole("img", { name: "生成图片-1.png" })).toBeVisible();
  expect(authorizedImageRead).toBe(true);
  expect(generationCalls).toBe(1);
  await page.getByRole("button", { name: "查看原图 生成图片-1.png" }).first().click();
  await expect(page.getByRole("dialog", { name: "生成图片-1.png 原图预览" })).toBeVisible();
  await page.getByRole("button", { name: "关闭原图预览" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载原图 生成图片-1.png" }).click();
  expect((await download).suggestedFilename()).toBe("生成图片-1.png");
  await page.getByRole("button", { name: "查看所属对话" }).click();
  await expect(page).toHaveURL(/#\/chat\/42$/);
  await expect(page.locator(".chat-thread")).toContainText("一只猫");
});
