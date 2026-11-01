import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test("conversation messages use the available width without crowding mobile or source panels", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("tuantuan-auth-token", "chat-spacing-e2e-token"));
  const source = { title: "示例参考资料", url: "https://example.com/reference", domain: "example.com" };
  const responses: Record<string, unknown> = {
    "/auth/me": { user: { id: 1, email: "reader@local.test", display_name: "测试读者", has_avatar: false } },
    "/system/database-status": { status: "ready", schema_version: 31, required_schema_version: 31 },
    "/conversations": [{ id: 1, title: "资料整理", status: "active", summary: "", message_count: 2, task_status: "active", updated_at: "2026-10-17T00:00:00Z" }],
    "/chat/messages": [
      { id: 1, role: "user", content: "帮我梳理资料，先总结重点，再指出还缺什么。", created_at: "2026-10-17T00:00:00Z" },
      { id: 2, role: "assistant", created_at: "2026-10-17T00:00:00Z",
        content: `## 资料重点\n\n${"这是一份用于验证对话排版的示例回答，包含资料要点、依据和需要继续确认的问题。".repeat(6)}\n\n## 还需补充\n\n- 项目背景与目标\n- 关键决策和验证结果\n\n[参考资料](${source.url})`,
        payload: { agent: { provider: "mock", platform: "local", status: "done", rounds: 1, events: [
          { round: 1, tool_call_id: "search-1", tool_name: "search_public_web", status: "done", message: "已检索", data: { sources: [source] } }
        ] } }
      }
    ],
    "/agent/runs/current": { run: null },
    "/agent/capabilities": { configured: true, active_model_name: "example-model", tools: [], web_research: { enabled: true, provider: "mock" } },
    "/attachments/config": { storage: "local", vision_enabled: false, checks: [] }
  };
  await page.route("http://127.0.0.1:4173/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/" || path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) return route.continue();
    return path in responses ? route.fulfill({ json: responses[path] })
      : route.fulfill({ status: 404, json: { detail: `Unhandled spacing test route: ${path}` } });
  });
  await page.setViewportSize({ width: 1135, height: 770 });
  await page.goto("/#/chat/1");
  await expect(page.getByRole("heading", { name: "资料重点", exact: true })).toBeVisible();
  const assertSpacing = async (width: number, maxGutter: number) => {
    const thread = (await page.getByRole("log").boundingBox())!;
    const content = (await page.locator(".message.assistant").boundingBox())!;
    expect(content.x - thread.x).toBeGreaterThanOrEqual(12);
    expect(content.x - thread.x).toBeLessThanOrEqual(maxGutter);
    expect(thread.x + thread.width - content.x - content.width).toBeLessThanOrEqual(maxGutter + 16);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  };
  for (const width of [1135, 1440, 768, 390]) {
    await page.setViewportSize({ width, height: 770 });
    await expect.poll(() => page.getByRole("log").evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await assertSpacing(width, width === 1440 ? 160 : 32);
    if (width === 1135) {
      const output = resolve("..", "..", "output", "chat-message-spacing");
      await mkdir(output, { recursive: true });
      await page.screenshot({ path: resolve(output, "conversation-1135.png"), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1135, height: 770 });
  await page.getByRole("button", { name: "查看全部 1 个来源", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "来源详情" })).toBeVisible();
  await assertSpacing(1135, 32);
});
