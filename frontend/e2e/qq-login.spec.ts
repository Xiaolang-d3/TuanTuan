import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, seedFirstRunDone, type Page } from "./test-fixtures";
import { defaultAgentSettings } from "../src/constants";
import { tokenStorageKey } from "../src/features/auth/session";

const localAccount = {
  id: 1, email: "owner@example.test", display_name: "测试用户",
  has_avatar: false, qq_enabled: true, qq_bound: false
};
const qqAccount = {
  ...localAccount, id: 2, email: "fixture@qq.tuantuan.invalid",
  display_name: "QQ 用户", qq_bound: true, qq_only: true
};
const authorizationUrl = "https://graph.qq.com/oauth2.0/authorize?response_type=code&client_id=12345&state=fixture";
const output = resolve("..", "output", "playwright", "qq");

async function mockWorkspace(page: Page, user: typeof localAccount) {
  const responses: Record<string, unknown> = {
    "/auth/me": { user },
    "/system/database-status": { status: "ready", schema_version: 44, required_schema_version: 44 },
    "/library": { profile: { name: "", privacy_mode: "redacted" }, facts: [], sources: [], folders: [], collections: [] },
    "/agent/settings": { ...defaultAgentSettings, model_name: "example-model", api_key_configured: true },
    "/agent/capabilities": { configured: true, active_model_name: "example-model", tools: [] },
    "/agent/model-connections": { connections: [], profiles: [], default_profile_id: null },
    "/attachments/config": { storage: "local", vision_enabled: false, checks: [] },
    "/conversations": [],
    "/chat/messages": [],
    "/agent/runs/current": { run: null },
    "/channels/weixin": { connected: false, enabled: false, error: "" }
  };
  await seedFirstRunDone(page, user.email);
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (!["localhost", "127.0.0.1"].includes(url.hostname)
      || path === "/" || path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) return route.fallback();
    return path in responses
      ? route.fulfill({ json: responses[path] })
      : route.fulfill({ status: 404, json: { detail: `Unhandled QQ test route: ${path}` } });
  });
}

async function mockAuthorization(page: Page, path: string, token?: string) {
  await page.route(`**${path}`, route => {
    const request = route.request();
    expect(request.method()).toBe("POST");
    expect(request.headers().origin).toBe(new URL(request.url()).origin);
    expect(request.headers().authorization).toBe(token ? `Bearer ${token}` : undefined);
    return route.fulfill({ json: { authorization_url: authorizationUrl } });
  });
  await page.route("https://graph.qq.com/**", route => route.fulfill({
    contentType: "text/html", body: "<title>QQ 授权测试</title>"
  }));
}

test.beforeEach(async ({ page }) => {
  await mkdir(output, { recursive: true });
  await page.addInitScript(() => localStorage.setItem("tuantuan-theme", "light"));
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("email and QQ entry points remain reachable on desktop and mobile", async ({ page }) => {
  await page.route("**/auth/config", route => route.fulfill({
    json: { enabled: true, setup_required: false, registration_open: true, qq_enabled: true }
  }));
  await mockAuthorization(page, "/auth/qq/start");
  await page.goto("/");
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "使用 QQ 登录" })).toBeVisible();
    await expect(page.getByLabel("邮箱", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: resolve(output, `login-${width}.png`), fullPage: true });
  }
  await page.getByRole("button", { name: /没有账号/ }).click();
  await expect(page.getByRole("button", { name: "使用 QQ 注册" })).toBeVisible();
  await page.getByRole("button", { name: "使用 QQ 注册" }).click();
  await expect(page).toHaveURL(authorizationUrl);
});

test("a QQ registration callback opens its account without exposing the internal identifier", async ({ page }) => {
  await mockWorkspace(page, qqAccount);
  const token = "qq-session-fixture";
  let exchanges = 0;
  await page.route("**/auth/qq/finish", route => {
    exchanges += 1;
    return route.fulfill({ json: { access_token: token, user: qqAccount } });
  });
  await page.goto("/?qq_auth=login#/settings/account");
  await expect(page.getByText("已绑定 QQ", { exact: true })).toBeVisible();
  await expect(page.getByText(qqAccount.email, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "修改密码" })).toHaveCount(0);
  await expect(page).not.toHaveURL(/qq_auth=/);
  expect(await page.evaluate(key => sessionStorage.getItem(key), tokenStorageKey)).toBe(token);
  expect(exchanges).toBe(1);
  await page.screenshot({ path: resolve(output, "qq-account.png"), fullPage: true });
});

test("an existing account binds QQ and retains its email session", async ({ page }) => {
  const token = "existing-session-fixture";
  await page.addInitScript(({ key, value }) => sessionStorage.setItem(key, value), { key: tokenStorageKey, value: token });
  await mockWorkspace(page, localAccount);
  await mockAuthorization(page, "/auth/qq/bind/start", token);
  await page.goto("/#/settings/account");
  await page.getByRole("button", { name: "绑定 QQ", exact: true }).click();
  await expect(page).toHaveURL(authorizationUrl);
  await page.route("**/auth/qq/finish", route => {
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    return route.fulfill({ json: { user: { ...localAccount, qq_bound: true } } });
  });
  await page.goto("/?qq_auth=bind#/settings/account");
  await expect(page.getByText("已绑定 QQ", { exact: true })).toBeVisible();
  await expect(page.getByText(localAccount.email, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "修改密码" })).toBeVisible();
  await expect(page).not.toHaveURL(/qq_auth=/);
  expect(await page.evaluate(key => sessionStorage.getItem(key), tokenStorageKey)).toBe(token);
  await page.screenshot({ path: resolve(output, "bound-account.png"), fullPage: true });
});
