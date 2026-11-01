import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"] as const) {
  test(`message tables stay readable and keyboard-scrollable in ${theme}`, async ({ page }) => {
    await page.addInitScript(value => {
      localStorage.setItem("tuantuan-auth-token", "table-e2e-token");
      localStorage.setItem("tuantuan-theme", value);
    }, theme);
    const content = [
      "下面按方向整理资料中的重点：", "",
      "| 方向 | 核心内容 | 阶段 | 数量 | 参考 |",
      "| :--- | :--- | :---: | ---: | :--- |",
      "| 资料整理 | 提取关键结论，保留原文依据与待确认问题。 | 已完成 | 12 | [示例资料](https://example.com/reference) |",
      "| 联网研究 | 对比公开来源，核对时间、适用范围与信息差异。 | 进行中 | 8 | 公开来源 |",
      "| 内容起草 | 结合资料形成初稿，按反馈继续修改。 | 待确认 | 3 | 阅读笔记 |",
      `| 检索标识 | \`${"reference_identifier_".repeat(4)}\` | 已保存 | 1 | 内部索引 |`
    ].join("\n");
    const responses: Record<string, unknown> = {
      "/auth/me": { user: { id: 1, email: "table@local.test", display_name: "测试读者", has_avatar: false } },
      "/system/database-status": { status: "ready", schema_version: 31, required_schema_version: 31 },
      "/conversations": [{ id: 1, title: "资料重点", status: "active", summary: "", message_count: 1, task_status: "active", updated_at: "2026-10-17T00:00:00Z" }],
      "/chat/messages": [{ id: 1, role: "assistant", content, created_at: "2026-10-17T00:00:00Z" }],
      "/agent/runs/current": { run: null },
      "/agent/capabilities": { configured: true, active_model_name: "example-model", tools: [] },
      "/attachments/config": { storage: "local", vision_enabled: false, checks: [] }
    };
    await page.route("http://127.0.0.1:4173/**", route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/" || path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) return route.continue();
      return path in responses ? route.fulfill({ json: responses[path] })
        : route.fulfill({ status: 404, json: { detail: `Unhandled table test route: ${path}` } });
    });
    await page.goto("/#/chat/1");
    const table = page.getByRole("table");
    const scroll = page.getByRole("region", { name: "表格，支持横向滚动", exact: true });
    await expect(table.getByRole("columnheader")).toHaveCount(5);
    await expect(table.getByRole("columnheader", { name: "数量", exact: true })).toHaveCSS("text-align", "right");
    for (const width of [1135, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await scroll.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect((await scroll.boundingBox())!.width).toBeLessThan(width);
      if (width < 600) {
        expect(await scroll.evaluate(el => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0);
        await scroll.press("ArrowRight");
        await expect.poll(() => scroll.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
      }
      const output = resolve("..", "..", "output", "chat-tables");
      await mkdir(output, { recursive: true });
      await scroll.screenshot({ path: resolve(output, `table-${width}-${theme}.png`) });
    }
    await expect(table.getByRole("link", { name: "来源：示例资料", exact: true })).toHaveAttribute("href", "https://example.com/reference");
  });
}
