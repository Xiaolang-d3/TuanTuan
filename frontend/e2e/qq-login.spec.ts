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

test("the QQ login entry is visible while QQ authorization is unavailable", async ({ page }) => {
  await page.route("**/auth/config", route => route.fulfill({
    json: { enabled: true, setup_required: false, registration_open: true, qq_enabled: false }
  }));
  await page.goto("/");
  const button = page.getByRole("button", { name: "使用 QQ 登录" });
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();
  await expect(button.locator("img")).toHaveCSS("width", "24px");
  await expect(button.locator("img")).toHaveCSS("height", "24px");
  await expect(button).toHaveAccessibleDescription("");
  await expect(page.getByText(/QQ 登录暂未开通/)).toHaveCount(0);
  await expect(page.getByText("使用 QQ 登录", { exact: true })).toHaveCount(0);
  const emailField = page.getByLabel("邮箱", { exact: true });
  await expect(emailField).toHaveAttribute("placeholder", "请输入邮箱");
  await expect(emailField).not.toBeFocused();
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute("placeholder", "请输入密码");
  for (const theme of ["light", "dark", "blue"]) {
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const contrast = await page.evaluate(() => {
      function luminance(color: string) {
        const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
        return channels.map(value => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      }

      function ratio(first: string, second: string) {
        const lightness = [luminance(first), luminance(second)];
        return (Math.max(...lightness) + 0.05) / (Math.min(...lightness) + 0.05);
      }

      const panel = getComputedStyle(document.querySelector(".auth-card")!);
      const primary = getComputedStyle(document.querySelector(".auth-submit")!);
      const qq = getComputedStyle(document.querySelector(".auth-qq-button")!);
      const divider = getComputedStyle(document.querySelector(".auth-qq-divider")!);
      const heading = getComputedStyle(document.querySelector(".auth-form-title")!);
      const modeSwitch = getComputedStyle(document.querySelector(".auth-mode-switch button")!);
      const emailPlaceholder = getComputedStyle(document.querySelector("#auth-email")!, "::placeholder");
      const password = document.querySelector("#auth-password")!;
      const field = getComputedStyle(password);
      const placeholder = getComputedStyle(password, "::placeholder");
      // Check foreground contrast against both ends of the card gradient.
      const panelColors = panel.backgroundImage.match(/rgb\([^)]+\)/g) ?? [];
      return {
        primaryGradient: primary.backgroundImage,
        primaryText: primary.color,
        qqFill: qq.backgroundColor,
        qqShadow: qq.boxShadow,
        qqBorderStyle: qq.borderTopStyle,
        divider: panelColors.map(color => ratio(divider.color, color)),
        heading: panelColors.map(color => ratio(heading.color, color)),
        modeSwitch: panelColors.map(color => ratio(modeSwitch.color, color)),
        sharedPromptColor: modeSwitch.color === placeholder.color && emailPlaceholder.color === placeholder.color,
        placeholder: ratio(placeholder.color, field.backgroundColor),
        fieldText: ratio(field.color, field.backgroundColor),
        fieldFill: field.backgroundColor,
        panelFill: panel.backgroundColor,
        fieldBorderStyle: field.borderTopStyle
      };
    });
    expect(contrast.primaryGradient).toBe("linear-gradient(90deg, rgb(50, 179, 255), rgb(84, 124, 255))");
    expect(contrast.primaryText).toBe("rgb(255, 255, 255)");
    for (const [label, stops] of Object.entries({ divider: contrast.divider, heading: contrast.heading, modeSwitch: contrast.modeSwitch })) {
      expect(stops, `${theme} ${label} gradient stops`).toHaveLength(2);
      expect(Math.min(...stops), `${theme} ${label}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast.qqFill).toBe("rgba(0, 0, 0, 0)");
    expect(contrast.qqShadow).toBe("none");
    expect(contrast.qqBorderStyle).toBe("none");
    expect(contrast.placeholder, theme + " placeholder").toBeGreaterThanOrEqual(4.5);
    expect(contrast.sharedPromptColor, theme + " sign-up and field hints share the same color").toBe(true);
    expect(contrast.fieldText, theme + " field text").toBeGreaterThanOrEqual(4.5);
    expect(contrast.fieldFill).not.toBe(contrast.panelFill);
    expect(contrast.fieldBorderStyle).toBe("none");
    for (const { width, height } of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
      await page.setViewportSize({ width, height });
      await expect(button).toBeInViewport({ ratio: 1 });
      const entry = await button.boundingBox();
      const primary = await page.getByRole("button", { name: "登录", exact: true }).boundingBox();
      const email = await page.getByLabel("邮箱", { exact: true }).boundingBox();
      const password = await page.getByLabel("密码", { exact: true }).boundingBox();
      const card = await page.locator(".auth-card").boundingBox();
      const otherOptions = await page.getByText("其他登录方式", { exact: true }).boundingBox();
      const modeSwitch = await page.getByRole("button", { name: "没有账号？创建账号" }).boundingBox();
      expect(card).not.toBeNull();
      if (width <= 860) expect(card!.x + card!.width / 2).toBeCloseTo(width / 2, 0);
      expect(primary).not.toBeNull();
      expect(email).toMatchObject({ x: primary?.x, width: primary?.width, height: primary?.height });
      expect(password).toMatchObject({ x: primary?.x, width: primary?.width, height: primary?.height });
      expect(primary!.width).toBeLessThan(card!.width);
      expect(entry?.width).toBeGreaterThanOrEqual(44);
      expect(entry?.width).toBe(entry?.height);
      expect(otherOptions!.y - (primary!.y + primary!.height)).toBeGreaterThanOrEqual(24);
      expect(otherOptions!.y - (modeSwitch!.y + modeSwitch!.height)).toBeGreaterThanOrEqual(24);
      await page.screenshot({ path: resolve(output, `login-redesign-${theme}-${width}.png`), fullPage: true });
    }
    await page.getByRole("button", { name: /点击切换到/ }).click();
  }
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
  const qqRegistration = page.getByRole("button", { name: "使用 QQ 注册" });
  await qqRegistration.hover();
  await expect(qqRegistration).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(qqRegistration).toHaveCSS("box-shadow", "none");
  await qqRegistration.click();
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
