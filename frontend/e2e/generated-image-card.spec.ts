import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"] as const) {
  test(`generated image preview is edge-to-edge with separate actions in ${theme}`, async ({ page }) => {
    // Deterministic UI fixture, not a paid model response or the user's private image.
    const image = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1200; canvas.height = 960;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#e8edf4"; context.fillRect(0, 0, 1200, 960);
      context.fillStyle = "#526987"; context.fillRect(640, 100, 360, 440);
      context.fillStyle = "#fff"; context.fillRect(680, 140, 280, 360);
      context.fillStyle = "#b3c2d5"; context.fillRect(720, 190, 200, 100);
      context.fillRect(720, 330, 160, 16); context.fillRect(720, 370, 200, 16);
      context.fillStyle = "#526987"; context.font = "28px sans-serif";
      context.fillText("UI TEST FIXTURE", 70, 300);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    const bytes = Buffer.from(image, "base64");
    const asset = { id: "d".repeat(32), origin: "generated", kind: "image", original_filename: "生成图片-1.png", parse_status: "parsed", content_type: "image/png", width: 1200, height: 960 };
    const writes: string[] = [];
    const responses: Record<string, unknown> = {
      "/auth/me": { user: { id: 1, email: "reader@local.test", display_name: "测试用户", has_avatar: false } },
      "/system/database-status": { status: "ready", schema_version: 31, required_schema_version: 31 },
      "/conversations": [{ id: 9, title: "图片卡片验收", status: "active", summary: "", message_count: 2, task_status: "active", updated_at: "2026-10-17T00:00:00Z" }],
      "/chat/messages": [
        { id: 91, role: "user", content: "帮我生成一张图片。", created_at: "2026-10-17T00:00:00Z" },
        { id: 92, role: "assistant", content: "", created_at: "2026-10-17T00:00:00Z", payload: { agent: { provider: "ui-fixture", platform: "local", status: "done", rounds: 1, events: [], assets: [asset], image_generation_prompt: "生成一张干净的产品展示图片。" } } }
      ],
      "/agent/runs/current": { run: null },
      "/agent/capabilities": { configured: true, active_model_name: "gpt-image-2", tools: [], web_research: { enabled: false, provider: "none" } },
      "/attachments/config": { storage: "local", vision_enabled: false, checks: [] }
    };
    await page.addInitScript(theme => { localStorage.setItem("tuantuan-auth-token", "image-card-e2e-token"); localStorage.setItem("tuantuan-theme", theme); }, theme);
    await page.route("http://127.0.0.1:4173/**", route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== "GET") writes.push(path);
      if (path.startsWith("/chat-assets/")) return route.fulfill({ contentType: "image/png", body: bytes });
      if (path === "/" || path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) return route.continue();
      return path in responses ? route.fulfill({ json: responses[path] }) : route.fulfill({ status: 404, json: { detail: "Unhandled image-card test route" } });
    });
    await page.goto("/#/chat/9");
    const card = page.getByRole("figure", { name: "模型生成图片" });
    const preview = card.getByRole("button", { name: "预览 生成图片-1.png", exact: true });
    await expect(preview.locator("img")).toBeVisible();
    await expect(card.locator("..")).toHaveClass("message-image-output");
    await expect(card.locator("..")).toHaveCSS("padding", "0px");
    await expect(card.locator("..")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(card).toHaveCSS("margin", "0px");
    await expect(card.locator(".chat-history-attachment")).toHaveCount(0);
    await expect(preview).toHaveCSS("padding", "0px");
    await expect(preview).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(preview).toHaveCSS("border-width", "0px");
    const frame = (await preview.boundingBox())!;
    const bitmap = (await preview.locator("img").boundingBox())!;
    expect(Math.abs(frame.width - bitmap.width)).toBeLessThan(1);
    expect(Math.abs(frame.height - bitmap.height)).toBeLessThan(1);
    await card.getByText("生成提示词", { exact: true }).click();
    await expect(card.getByText("生成一张干净的产品展示图片。", { exact: true })).toBeVisible();
    await expect(preview.locator("span")).toBeHidden();
    await page.keyboard.press("Tab");
    await preview.focus();
    await expect(preview).toBeFocused();
    await expect(preview).toHaveCSS("outline-style", "solid");
    await expect(preview).toHaveCSS("outline-width", "2px");
    await expect(preview).toHaveCSS("outline-offset", "-2px");
    await expect(preview).toHaveCSS("box-shadow", "none");
    await expect(preview).toHaveCSS("border-color", "rgba(0, 0, 0, 0)");
    await expect(card.locator("figcaption").getByRole("button", { name: "保存 生成图片-1.png 到文件库", exact: true })).toBeVisible();
    const output = resolve("..", "..", "output", "generated-image-card");
    await mkdir(output, { recursive: true });
    for (const width of [1135, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => card.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await expect(preview.locator("img")).toHaveCSS("object-fit", "contain");
      await card.screenshot({ path: resolve(output, `card-${theme}-${width}.png`), animations: "disabled" });
    }
    await preview.click();
    await expect(page.getByRole("dialog", { name: "生成图片-1.png 预览", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "关闭附件预览", exact: true }).click();
    const downloading = page.waitForEvent("download");
    await card.getByRole("button", { name: "下载原图", exact: true }).click();
    const stream = await (await downloading).createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    expect(writes).toEqual([]);
  });
}
