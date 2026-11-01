import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"] as const) {
  test(`image messages keep their lower-left actions reachable in ${theme}`, async ({ page }) => {
    // Synthetic thumbnail and mocked APIs keep this regression independent of private files and models.
    const image = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 720; canvas.height = 480;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#e6edf7"; context.fillRect(0, 0, 720, 480);
      context.fillStyle = "#637fa7"; context.fillRect(180, 80, 360, 320);
      context.fillStyle = "#f6f8fc"; context.fillRect(220, 120, 280, 240);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    const bytes = Buffer.from(image, "base64");
    const attachment = { id: "a".repeat(32), kind: "image", original_filename: "用于检查图片消息排版和长文件名显示的示意图.png", parse_status: "parsed", content_type: "image/png", vision_status: "consented" };
    const responses: Record<string, unknown> = {
      "/auth/me": { user: { id: 1, email: "reader@local.test", display_name: "测试读者", has_avatar: false } },
      "/system/database-status": { status: "ready", schema_version: 31, required_schema_version: 31 },
      "/conversations": [{ id: 1, title: "图片消息排版", status: "active", summary: "", message_count: 4, task_status: "active", updated_at: "2026-10-27T00:00:00Z" }],
      "/chat/messages": [
        { id: 1, role: "user", content: "这是什么图片？", created_at: "2026-10-27T00:00:00Z", payload: { attachments: [attachment] } },
        { id: 2, role: "assistant", content: "这是一张用于检查显示效果的示意图。", created_at: "2026-10-27T00:00:01Z" },
        { id: 3, role: "user", content: "", created_at: "2026-10-27T00:00:02Z", payload: { attachments: [{ ...attachment, id: "b".repeat(32), original_filename: "纯图片.png" }] } },
        { id: 4, role: "user", content: "这是一条普通文字消息。", created_at: "2026-10-27T00:00:03Z" }
      ],
      "/agent/runs/current": { run: null },
      "/agent/capabilities": { configured: true, active_model_name: "mock-model", tools: [], web_research: { enabled: false, provider: "none" } },
      "/attachments/config": { storage: "local", vision_enabled: true, checks: [] }
    };
    const writes: string[] = [];
    await page.addInitScript(value => {
      localStorage.setItem("tuantuan-auth-token", "image-message-test-token");
      localStorage.setItem("tuantuan-theme", value);
    }, theme);
    await page.route("http://127.0.0.1:4173/**", route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== "GET") writes.push(path);
      if (path.startsWith("/attachments/") && /\/(thumbnail|file)$/.test(path)) return route.fulfill({ contentType: "image/png", body: bytes });
      if (path === "/" || path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) return route.continue();
      return path in responses ? route.fulfill({ json: responses[path] }) : route.fulfill({ status: 404, json: { detail: "Unhandled image-message test route" } });
    });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto("/#/chat/1");
    const messages = page.locator(".message.user");
    const mixed = messages.nth(0);
    await expect(mixed.locator("img")).toBeVisible();
    await expect(messages.nth(1).locator(".message-dialog")).toHaveCount(0);
    await expect(mixed.locator(".chat-history-attachment-name")).toHaveAttribute("title", attachment.original_filename);
    const output = resolve("..", "output", "playwright", "user-message-attachments");
    await mkdir(output, { recursive: true });

    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      for (const message of await messages.all()) {
        await message.scrollIntoViewIfNeeded();
        await page.getByRole("textbox", { name: "输入消息", exact: true }).focus();
        await page.mouse.move(4, 70);
        const content = message.locator(".message-content");
        const actions = message.locator(".user-message-actions");
        const latest = await message.evaluate(el => el.classList.contains("is-latest"));
        await expect(actions).toHaveCSS("opacity", latest ? "1" : "0");
        await expect(actions).toHaveCSS("pointer-events", latest ? "auto" : "none");
        await expect(actions).toHaveCSS("position", "static");
        const contentBox = (await content.boundingBox())!;
        const actionBox = (await actions.boundingBox())!;
        expect(Math.abs(actionBox.x - contentBox.x)).toBeLessThan(2);
        expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(contentBox.y + contentBox.height + 1);
        const body = message.locator(".message-attachments, .message-dialog").last();
        const bodyBox = (await body.boundingBox())!;
        expect(actionBox.y).toBeGreaterThanOrEqual(bodyBox.y + bodyBox.height);

        // Walk the actual cursor down from the message into the toolbar, across the old hover gap.
        const edit = message.getByRole("button", { name: "编辑消息", exact: true });
        const editBox = (await edit.boundingBox())!;
        await page.mouse.move(bodyBox.x + bodyBox.width / 2, bodyBox.y + bodyBox.height / 2);
        await page.mouse.move(editBox.x + editBox.width / 2, editBox.y + editBox.height / 2, { steps: 24 });
        await expect(actions).toHaveCSS("opacity", "1");
        expect(await edit.evaluate(element => {
          const box = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        })).toBe(true);
      }
      await mixed.scrollIntoViewIfNeeded();
      await mixed.hover();
      await mixed.getByRole("button", { name: "编辑消息", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "编辑消息", exact: true })).toHaveValue("这是什么图片？");
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await expect(mixed.locator("img")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await expect.poll(() => page.getByRole("log").evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      await page.getByRole("log").evaluate(el => el.scrollTo({ top: 0 }));
      await page.getByRole("textbox", { name: "输入消息", exact: true }).focus();
      await page.mouse.move(4, 70);
      await page.screenshot({ path: resolve(output, `${theme}-${width}.png`), fullPage: true });
    }
    await mixed.getByRole("button", { name: "编辑消息", exact: true }).focus();
    await expect(mixed.locator(".user-message-actions")).toHaveCSS("opacity", "1");
    await page.getByRole("textbox", { name: "输入消息", exact: true }).focus();
    await mixed.dispatchEvent("pointerdown", { pointerType: "touch" });
    await expect(mixed).toBeFocused();
    await expect(mixed.locator(".user-message-actions")).toHaveCSS("opacity", "1");
    await mixed.getByRole("button", { name: `预览 ${attachment.original_filename}`, exact: true }).click();
    await expect(page.getByRole("dialog", { name: `${attachment.original_filename} 预览`, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "关闭附件预览", exact: true }).click();
    (responses["/chat/messages"] as unknown[]).push({ id: 5, role: "assistant", content: "这是最新一条回答。", created_at: "2026-10-27T00:00:04Z" });
    await page.reload();
    await page.mouse.move(4, 70);
    await expect(page.locator(".message.assistant").last().locator(".message-actions")).toHaveCSS("opacity", "1");
    await expect(page.locator(".message.user").last().locator(".message-actions")).toHaveCSS("opacity", "0");
    expect(writes).toEqual([]);
  });
}
