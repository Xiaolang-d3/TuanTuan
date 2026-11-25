import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "./test-fixtures";

const evidenceDir = resolve(import.meta.dirname, "../../output/playwright/monochrome");
test.beforeEach(async () => { await mkdir(evidenceDir, { recursive: true }); });

async function mockWorkspace(page: Page, theme: "light" | "dark", signedIn = true) {
  await page.addInitScript(({ theme, signedIn }) => {
    if (!localStorage.getItem("tuantuan-theme")) localStorage.setItem("tuantuan-theme", theme);
    if (signedIn) sessionStorage.setItem("tuantuan-auth-token", "monochrome-test");
    localStorage.setItem("tuantuan-first-run:theme@local.test", "done");
  }, { theme, signedIn });
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\//, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/" || /^\/(?:src\/|node_modules\/|@|assets\/)/.test(pathname) || /\.[a-z0-9]+$/i.test(pathname)) return route.continue();
    const path = pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { enabled: true, setup_required: false, registration_open: true } });
    if (path === "/auth/login") return route.fulfill({ json: { access_token: "monochrome-test", user: { id: 1, email: "theme@local.test", display_name: "主题预览" } } });
    if (path === "/auth/me") return route.fulfill({ json: { user: { id: 1, email: "theme@local.test", display_name: "主题预览" } } });
    if (path === "/system/database-status") return route.fulfill({ json: { status: "ready", schema_version: 25, required_schema_version: 25 } });
    if (path === "/home/feed") return route.fulfill({ json: {
      news: [], repositories: { day: [], week: [] }, updates: [], practices: [], sources: [],
      preferences: { topics: ["AI"], repositories: [] }, item_states: {}, bookmarks: [], refreshing: false, last_synced_at: null
    } });
    if (path === "/home/workspace") return route.fulfill({ json: {
      generated_at: "2026-10-08T02:00:00Z",
      conversations: { items: [], error: null }, jobs: { running: [], pending_confirmations: [] },
      weixin: { connected: false, unread_count: 0 }, changelog: { items: [], error: null },
      skills: { items: [], error: null }, library_recent: { items: [], error: null }
    } });
    if (path === "/conversations") return route.fulfill({ json: [{ id: 1, title: "主题预览", status: "active", message_count: 0, updated_at: "2026-11-10T00:00:00Z" }] });
    if (path === "/chat/messages") return route.fulfill({ json: [] });
    if (path === "/library") return route.fulfill({ json: { profile: { name: "主题预览", privacy_mode: "redacted" }, facts: [], sources: [] } });
    if (path === "/agent/capabilities") return route.fulfill({ json: { configured: true, active_model_provider: "openai_compatible", active_model_name: "mock-model", tools: [], model_providers: [], platforms: [] } });
    if (path === "/presentations") return route.fulfill({ json: { jobs: [], next_cursor: null } });
    if (path === "/document-reviews") return route.fulfill({ json: { jobs: [] } });
    if (path === "/agent/runs/current") return route.fulfill({ json: { run: null } });
    return route.fulfill({ json: {} });
  });
}

test("registration email suggestions support keyboard selection and native Tab at 320px", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await mockWorkspace(page, "dark", false);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  await page.getByRole("button", { name: "没有账号？创建账号", exact: true }).click();
  const email = page.getByRole("combobox", { name: "邮箱" });
  const suggestions = page.getByRole("listbox", { name: "常见邮箱建议" });
  await email.fill("reader@");
  await expect(suggestions).toBeInViewport({ ratio: 1 });
  await email.press("Home");
  await email.press("End");
  await email.press("ArrowDown");
  await email.press("ArrowDown");
  const choice = suggestions.getByRole("option", { name: "reader@163.com" });
  await expect(email).toHaveAttribute("aria-activedescendant", (await choice.getAttribute("id"))!);
  await email.press("Enter");
  await expect(email).toHaveValue("reader@163.com");
  await expect(email).toBeFocused();
  await expect(email).toHaveAttribute("aria-invalid", "false");
  await expect(suggestions).toBeHidden();

  await email.fill("reader@q");
  await expect(suggestions).toBeVisible();
  await email.press("Tab");
  await expect(page.getByLabel("密码", { exact: true })).toBeFocused();
  await expect(suggestions).toBeHidden();
  await expect(email).toHaveValue("reader@q");
  await email.fill("reader@company.test");
  await email.press("Escape");
  await expect(email).toHaveValue("reader@company.test");
  expect(errors).toEqual([]);
});

for (const theme of ["light", "dark"] as const) {
  test(`${theme} validation keeps filled fields readable`, async ({ page }) => {
    await mockWorkspace(page, theme, false);
    await page.goto("/");
    await page.getByRole("button", { name: "没有账号？创建账号", exact: true }).click();
    const email = page.getByLabel("邮箱", { exact: true });
    await email.fill("not-an-email");
    await expect(page.getByRole("listbox", { name: "常见邮箱建议" })).toBeVisible();
    await page.locator('button[type="submit"]').filter({ hasText: /^创建账号$/ }).click();
    await expect(email).toHaveAttribute("aria-invalid", "true");
    const contrast = await email.evaluate(element => {
      const style = getComputedStyle(element);
      const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
        const channel = value / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      const levels = [style.color, style.backgroundColor].map(luminance);
      return (Math.max(...levels) + .05) / (Math.min(...levels) + .05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
  });

  test(`${theme} sign-in theme stays consistent through login, settings and logout`, async ({ page }) => {
    await mockWorkspace(page, theme, false);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/");
    await expect(page.getByLabel("邮箱", { exact: true })).toBeVisible();
    const next = theme === "dark" ? "blue" : "dark";
    const nextLabel = next === "dark" ? /深色/ : /主题色蓝/;
    const toggle = page.getByRole("button", { name: /点击切换到/ });
    await expect(toggle).toBeInViewport();
    const brand = (await page.locator(".auth-wordmark").boundingBox())!;
    const navigation = (await page.getByRole("navigation", { name: "公共导航" }).boundingBox())!;
    expect(navigation.x).toBeGreaterThan(brand.x + brand.width);
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("data-theme", next);
    await page.screenshot({ path: resolve(evidenceDir, `${next}-login-toggle-mobile.png`) });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", next);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole("form", { name: "欢迎登录" })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: resolve(evidenceDir, `${next}-login-toggle.png`) });
    await page.getByLabel("邮箱", { exact: true }).fill("theme@local.test");
    await page.getByLabel("密码", { exact: true }).fill("test-login-value");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.locator(".app-shell")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", next);
    const sidebarToggle = page.locator(".sidebar-theme-toggle");
    await sidebarToggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme === "dark" ? "light" : "blue");
    await sidebarToggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.goto("/#/settings/appearance");
    await expect(page.getByRole("radio", { name: theme === "dark" ? /深色/ : /浅色/ })).toBeChecked();
    await page.getByRole("radio", { name: nextLabel }).check();
    await page.getByRole("button", { name: "账号菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: "退出登录" }).click();
    await expect(page.getByLabel("邮箱", { exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", next);
    await page.reload();
    await expect(page.getByLabel("邮箱", { exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", next);
  });

  test(`${theme} uses neutral surfaces across settings, home, chat and files`, async ({ page }) => {
    await mockWorkspace(page, theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const route of ["settings/appearance", "home", "chat/1", "library"]) {
      await page.goto(`/#/${route}`);
      await expect(page.locator(".app-shell")).toBeVisible();
      const view = route === "home" ? ".home-page" : route === "library" ? ".file-library" : route.startsWith("chat") ? ".chat-workspace" : ".appearance-settings";
      await expect(page.locator(view)).toBeVisible();
      const colors = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const sample = (selector: string) => {
          const element = document.querySelector(selector);
          if (!element) return [];
          const style = getComputedStyle(element);
          return [style.backgroundColor, style.color, style.borderColor];
        };
        const probe = document.createElement("button");
        probe.className = "ui-button ui-button-primary";
        document.body.append(probe);
        const primary = [getComputedStyle(probe).backgroundColor, getComputedStyle(probe).color];
        probe.remove();
        const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
          const channel = value / 255;
          return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
        }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
        const levels = primary.map(luminance);
        return {
          brand: root.getPropertyValue("--color-brand").trim(),
          image: getComputedStyle(document.body).backgroundImage,
          values: [...sample("body"), ...sample(".sidebar"), ...sample(".content"), ...sample(".home-page"), ...sample(".file-library"), ...primary],
          primary, contrast: (Math.max(...levels) + .05) / (Math.min(...levels) + .05)
        };
      });
      expect(colors.brand).toBe(theme === "dark" ? "#ededed" : "#262626");
      expect(colors.image).toBe("none");
      expect(colors.primary[0]).toBe(theme === "dark" ? "rgb(237, 237, 237)" : "rgb(38, 38, 38)");
      for (const color of colors.values) {
        const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
        expect(Math.max(...rgb) - Math.min(...rgb), `${route}: ${color}`).toBeLessThanOrEqual(1);
      }
      expect(colors.contrast).toBeGreaterThanOrEqual(4.5);
      await page.screenshot({ path: resolve(evidenceDir, `${theme}-${route.replaceAll("/", "-")}.png`) });
    }
    await page.goto("/#/settings/appearance");
    await page.getByRole("radio", { name: theme === "dark" ? /浅色/ : /深色/ }).check();
    const changed = theme === "dark" ? "light" : "dark";
    await expect(page.locator("html")).toHaveAttribute("data-theme", changed);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", changed);
  });

}
