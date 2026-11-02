import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { defaultAgentSettings } from "../src/constants";

for (const theme of ["light", "dark"] as const) {
  test(`settings entries remain aligned and reachable across breakpoints in ${theme}`, async ({ page }) => {
    await page.addInitScript(value => {
      localStorage.setItem("tuantuan-auth-token", "settings-e2e-token");
      localStorage.setItem("tuantuan-theme", value);
    }, theme);
    const responses: Record<string, unknown> = {
      "/auth/me": { user: { id: 1, email: "settings.reader.with.a.long.address@local.test", display_name: "", has_avatar: false } },
      "/system/database-status": { status: "ready", schema_version: 31, required_schema_version: 31 },
      "/library": { profile: { name: "", privacy_mode: "redacted" }, facts: [], sources: [], folders: [], collections: [] },
      "/agent/settings": { ...defaultAgentSettings, model_name: "example-model-with-a-long-name", api_key_configured: true },
      "/agent/capabilities": { configured: true, active_model_name: "example-model-with-a-long-name", tools: [] },
      "/agent/model-connections": { connections: [], profiles: [], default_profile_id: null },
      "/attachments/config": { storage: "local", vision_enabled: false, checks: [] },
      "/conversations": [],
      "/chat/messages": [],
      "/agent/runs/current": { run: null }
    };
    await page.route("http://127.0.0.1:4173/**", route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/" || path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) return route.continue();
      return path in responses
        ? route.fulfill({ json: responses[path] })
        : route.fulfill({ status: 404, json: { detail: `Unhandled settings test route: ${path}` } });
    });
    await page.goto("/#/settings");
    const entries = page.locator(".settings-entry-card");
    await expect(entries).toHaveCount(4);
    for (const width of [996, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const panel = page.locator(".settings-overview-grid");
      await expect.poll(() => panel.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      if (width <= 820) {
        // The shared shell animates its sidebar margin when the breakpoint changes.
        await expect.poll(async () => (await panel.boundingBox())!.x).toBeLessThanOrEqual(24);
        const box = (await panel.boundingBox())!;
        // Classic scrollbars on CI runners reserve a gutter that documentElement.clientWidth
        // still counts; body.clientWidth is the width the layout actually gets.
        const contentWidth = await page.evaluate(() => document.body.clientWidth);
        expect(contentWidth - box.x - box.width).toBeLessThanOrEqual(24);
      }
      for (const entry of await entries.all()) await expect(entry).toBeInViewport();
      await expect(page.getByRole("link", { name: "了解 团团", exact: true })).toBeInViewport();
      if (width === 996 || width === 390) {
        const output = resolve("..", "..", "output", "settings-overview");
        await mkdir(output, { recursive: true });
        await page.screenshot({ path: resolve(output, `settings-${width}-${theme}.png`), fullPage: true });
      }
    }
    await page.getByRole("button", { name: /外观 全局主题/ }).click();
    await expect(page).toHaveURL(/#\/settings\/appearance$/);
    await page.getByRole("navigation", { name: "设置路径" }).getByRole("button", { name: "设置", exact: true }).click();
    await expect(entries).toHaveCount(4);
  });
}
