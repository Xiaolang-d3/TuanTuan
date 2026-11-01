import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// Deliberately drawn test fixtures, not model-generated images. No paid service is used.
async function fixturePng(page: Page, color: string, screenshot = false) {
  const data = await page.evaluate(({ color, screenshot }) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200; canvas.height = screenshot ? 900 : 400;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = screenshot ? "#f5f5f7" : "#f1edff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color;
    if (screenshot) {
      ctx.fillRect(0, 0, 1200, 64);
      ctx.fillStyle = "#e5e5ed";
      ctx.fillRect(60, 100, 1080, 330);
      for (let i = 0; i < 3; i++) ctx.fillRect(60 + i * 370, 470, 340, 300);
      ctx.fillStyle = "#333";
      ctx.font = "24px sans-serif";
      ctx.fillText("Local page fixture — not sent to a model", 60, 840);
    } else {
      ctx.beginPath(); ctx.arc(880, 200, 136, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.fillRect(780, 118, 180, 160);
      ctx.fillStyle = color; ctx.fillRect(805, 148, 130, 12);
      ctx.fillStyle = "#ddd8f1"; ctx.fillRect(805, 180, 100, 8);
      ctx.fillRect(805, 204, 116, 8);
      ctx.fillStyle = "#555"; ctx.font = "16px sans-serif";
      ctx.fillText("TEST FIXTURE · no model call", 32, 370);
    }
    return canvas.toDataURL("image/png").split(",")[1];
  }, { color, screenshot });
  return Buffer.from(data, "base64");
}

async function mockBannerProduct(page: Page) {
  const png = await fixturePng(page, "#8062c5");
  const alternative = await fixturePng(page, "#4b8278");
  const timestamp = "2026-10-17T08:00:00Z";
  const asset = { id: "a".repeat(32), origin: "generated", kind: "image", original_filename: "banner-a.png", content_type: "image/png", width: 1200, height: 400, model_name: "gpt-image-2", parse_status: "parsed" };
  const messages: object[] = [];
  const writes: string[] = [];
  const responses: Record<string, unknown> = {
    "/auth/me": { user: { id: 1, email: "designer@local.test", display_name: "测试设计师", has_avatar: false } },
    "/system/database-status": { status: "ready", schema_version: 31, required_schema_version: 31 },
    "/conversations": [{ id: 1, title: "会员活动配图", status: "active", summary: "", message_count: 0, task_status: "active", updated_at: timestamp }],
    "/agent/runs/current": { run: null },
    "/agent/capabilities": { configured: true, active_model_name: "gpt-image-2", tools: [], web_research: { enabled: false, provider: "none" } },
    "/attachments/config": { storage: "local", vision_enabled: false, checks: [] }
  };
  await page.addInitScript(() => localStorage.setItem("tuantuan-auth-token", "banner-e2e-token"));
  await page.route("http://127.0.0.1:4173/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") writes.push(path);
    if (path.startsWith("/chat-assets/")) return route.fulfill({ contentType: "image/png", body: path.includes("b".repeat(32)) ? alternative : png });
    if (path === "/chat/messages") return route.fulfill({ json: messages });
    if (path === "/ag-ui") {
      const body = request.postDataJSON();
      const content = body.messages.at(-1).content;
      const userMessage = { id: messages.length + 1, role: "user", content, created_at: timestamp };
      const generated = { ...asset, id: (messages.length ? "b" : "a").repeat(32), original_filename: messages.length ? "banner-b.png" : "banner-a.png" };
      const assistantMessage = { id: messages.length + 2, role: "assistant", content: "", created_at: timestamp,
        payload: { agent: { provider: "e2e-fixture", platform: "local", status: "done", rounds: 1, events: [], assets: [generated] } } };
      messages.push(userMessage, assistantMessage);
      const events = [
        { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
        { type: "STATE_SNAPSHOT", snapshot: { tuantuan: { status: "done", userMessage, assistantMessage } } },
        { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId }
      ];
      return route.fulfill({ contentType: "text/event-stream", body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") });
    }
    if (path === "/" || path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) return route.continue();
    return path in responses ? route.fulfill({ json: responses[path] })
      : route.fulfill({ status: 404, json: { detail: `Unhandled Banner test route: ${path}` } });
  });
  return { writes, png };
}

test("a natural image request sends directly through chat and survives refresh", async ({ page }) => {
  const { writes } = await mockBannerProduct(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/#/chat/1");
  await expect(page.getByRole("button", { name: "Banner 设计台", exact: true })).toHaveCount(0);
  const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
  const prompt = "生成一张会员活动 Banner，右侧紫色礼盒，左侧留白，无文字";
  await composer.fill(prompt);
  expect(writes.filter(path => path === "/ag-ui")).toHaveLength(0);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("figure", { name: "模型生成图片" })).toHaveCount(1);
  await expect(page.getByText(prompt, { exact: true })).toBeVisible();
  expect(writes.filter(path => path === "/ag-ui")).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole("figure", { name: "模型生成图片" }).locator("img")).toBeVisible();
  expect(writes.filter(path => path === "/ag-ui")).toHaveLength(1);
});

test("image preview preserves the conversation draft and downloads original bytes", async ({ page }) => {
  const { writes, png } = await mockBannerProduct(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/chat/1");
  const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
  await composer.fill("生成一张小猫玩小鱼玩具图");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const image = page.getByRole("figure", { name: "模型生成图片" });
  await expect(image).toBeVisible();
  await composer.fill("还没发送的另一个想法");
  await image.getByRole("button", { name: "预览 banner-a.png", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "banner-a.png 预览", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭附件预览", exact: true }).click();
  await expect(composer).toHaveValue("还没发送的另一个想法");
  const downloading = page.waitForEvent("download");
  await image.getByRole("button", { name: "下载原图", exact: true }).click();
  const stream = await (await downloading).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).equals(png)).toBe(true);
  expect(writes.filter(path => path === "/ag-ui")).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("new image requests keep earlier results and need no separate workspace", async ({ page }) => {
  const { writes } = await mockBannerProduct(page);
  await page.goto("/#/chat/1");
  const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
  for (const prompt of ["生成一张会员活动 Banner，紫色礼盒，左侧留白", "生成一张会员活动 Banner，绿色礼盒，另一种构图"]) {
    await composer.fill(prompt);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(composer).toHaveValue("");
  }
  await expect(page.getByRole("figure", { name: "模型生成图片" })).toHaveCount(2);
  expect(writes.filter(path => path === "/ag-ui")).toHaveLength(2);
  await expect(page.getByRole("region", { name: "Banner 设计台" })).toHaveCount(0);
  const output = resolve("..", "..", "output", "image-conversation-qa");
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: resolve(output, "direct-image-chat.png"), animations: "disabled" });
});
