import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./test-fixtures";
import { defaultAgentSettings } from "../src/constants";

for (const theme of ["light", "dark"] as const) {
  test(`compact skill picker remains usable across breakpoints in ${theme}`, async ({ page }) => {
    await page.addInitScript(value => {
      sessionStorage.setItem("tuantuan-auth-token", "skill-picker-e2e-token");
      localStorage.setItem("tuantuan-theme", value);
    }, theme);
    const skill = { id: "weekly", kind: "skill", name: "周报助手", description: "归纳每周工作并整理行动项", source: "user", enabled: true, permissions: [], user_invocable: true };
    const conversation = { id: 1, title: "技能测试", status: "active", summary: "", message_count: 0, task_status: "active", updated_at: "2026-11-02T08:00:00Z", last_message_at: "2026-11-02T08:00:00Z" };
    const conversations = [conversation];
    const responses: Record<string, unknown> = {
      "/auth/me": { user: { id: 1, email: "skills@local.test", display_name: "测试用户", has_avatar: false } },
      "/system/database-status": { status: "ready", schema_version: 35, required_schema_version: 35 },
      "/library": { profile: { name: "", privacy_mode: "redacted" }, facts: [], sources: [], folders: [], collections: [] },
      "/agent/settings": defaultAgentSettings,
      "/agent/capabilities": { configured: true, active_model_provider: "openai_compatible", active_model_name: "mock-model", active_platform: "local", model_providers: ["openai_compatible"], platforms: ["local"], tools: [] },
      "/agent/model-connections": { connections: [], profiles: [], default_profile_id: null },
      "/attachments/config": { storage: "local", vision_enabled: false, checks: [] },
      "/conversations": conversations,
      "/chat/messages": [],
      "/agent/runs/current": { run: null },
      "/presentations": { jobs: [], next_cursor: null },
      "/document-reviews": { jobs: [] },
      "/extensions": { extensions: [skill, { ...skill, id: "long", name: "用于检验窄屏换行的超长技能昵称LongSkillNameWithoutSpaces" }], connections: [], execution: { available: false, reason: "执行环境未配置" } }
    };
    await page.route("http://127.0.0.1:4173/**", route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/" || path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) return route.continue();
      if (path === "/conversations" && route.request().method() === "POST") {
        const created = { ...conversation, id: conversations.length + 1, title: "新对话" };
        conversations.push(created);
        return route.fulfill({ json: created });
      }
      return path in responses
        ? route.fulfill({ json: responses[path] })
        : route.fulfill({ status: 404, json: { detail: `Unhandled skill picker fixture: ${path}` } });
    });
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto("/#/chat/1");
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(pageErrors).toEqual([]);
    const trigger = page.getByRole("button", { name: "技能", exact: true });
    const picker = page.getByRole("dialog", { name: "可用技能" });
    const output = resolve("..", "output", "skill-picker");
    await mkdir(output, { recursive: true });
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await trigger.click();
      const option = picker.getByRole("button", { name: "周报助手", exact: true });
      await expect(option).toHaveText("周报助手");
      await expect(option).toHaveAttribute("title", skill.description);
      await expect(picker.getByRole("heading")).toHaveCount(0);
      await expect(picker).toBeInViewport();
      expect(await picker.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      const box = (await picker.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: resolve(output, `skills-${width}-${theme}.png`) });
      await option.click();
      await expect(picker).toBeHidden();
      await expect(trigger).toBeFocused();
      await trigger.click();
      await expect(option).toHaveAttribute("aria-pressed", "true");
      await expect(picker.getByRole("button", { name: "普通对话", exact: true })).toHaveCount(0);
      await option.click();
      await trigger.click();
      await expect(option).toHaveAttribute("aria-pressed", "false");
      await page.keyboard.press("Escape");
      await expect(picker).toBeHidden();
      await expect(trigger).toBeFocused();
    }
    await trigger.click();
    await page.getByRole("button", { name: "新建对话", exact: true }).click();
    await expect(picker).toBeHidden();
    await page.goto("/#/chat/1");
    await trigger.click();
    await picker.getByRole("link", { name: "管理技能" }).press("Enter");
    await expect(page).toHaveURL(/#\/settings\/extensions$/);
    await expect(picker).toBeHidden();
    expect(pageErrors).toEqual([]);
  });
}
