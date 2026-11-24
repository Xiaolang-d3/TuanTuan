import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./test-fixtures";
import { icpNumber, icpUrl, mockHostedSite } from "./hosted-site";
import { tokenStorageKey } from "../src/features/auth/session";

const fallbackIcpLink = `body > a[href="${icpUrl}"]`;

test("the sign-in page links to the product page across viewport sizes", async ({ page }) => {
  await page.route("**/auth/config", (route) => route.fulfill({ json: { enabled: true, setup_required: false, registration_open: true } }));
  const evidenceDir = resolve(import.meta.dirname, "../../output/playwright");
  await mkdir(evidenceDir, { recursive: true });
  await page.goto("/");

  for (const viewport of [{ width: 1280, height: 900 }, { width: 768, height: 900 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    const signIn = page.getByRole("form", { name: "欢迎登录" });
    await expect(signIn).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("heading", { name: "团团", exact: true })).toBeVisible();
    await expect(page.locator('.auth-header img[src="/tuantuan-favicon.png"]')).toBeVisible();
    await expect(signIn.locator('img[src="/tuantuan-favicon.png"]')).toHaveCount(0);
    await expect(page.locator(".auth-hero").getByRole("heading", { level: 2 })).toBeInViewport();
    await expect(page.getByRole("heading", { name: /理解你的想法/ })).toHaveCount(0);
    const card = (await signIn.boundingBox())!;
    const aboutLink = page.getByRole("link", { name: "关于 团团" });
    const aboutBounds = await aboutLink.boundingBox();
    expect(aboutBounds).not.toBeNull();
    expect(aboutBounds!.y + aboutBounds!.height).toBeLessThanOrEqual(card.y);
    await aboutLink.click();
    await expect(page).toHaveURL(/#\/about$/);
    await expect(page.getByRole("heading", { name: /理解你的想法/ })).toBeVisible();
    await expect(page.locator(".product-intro-brand img")).toHaveJSProperty("naturalWidth", 940);
    await expect(page.getByLabel("邮箱", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    expect(await page.locator(".product-intro-page").evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: resolve(evidenceDir, `product-intro-${viewport.width}.png`), animations: "disabled" });
    await page.goBack();
    await expect(signIn).toBeVisible();
  }

  await page.route(/\/auth\/(?:config|login|register|me|logout)(?:[/?]|$)/, (route) => route.abort());
  await page.goto("/#/about");
  await page.reload();
  await expect(page.getByRole("heading", { name: /理解你的想法/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "返回登录" })).toBeVisible();
});

test("the public site shows one centered and usable ICP link on both public pages", async ({ page, baseURL }) => {
  await mockHostedSite(page, baseURL);
  const footer = page.getByRole("contentinfo", { name: "网站页脚" });
  async function checkRegistration(viewportWidth: number) {
    const link = footer.getByRole("link", { name: icpNumber });
    await expect(link).toHaveAttribute("href", icpUrl);
    await expect(page.getByRole("link", { name: icpNumber, exact: true })).toHaveCount(1);
    await expect(page.locator(fallbackIcpLink)).toBeHidden();
    await link.scrollIntoViewIfNeeded();
    await expect(link).toBeInViewport();
    const bounds = (await link.boundingBox())!;
    expect(bounds.x + bounds.width / 2).toBeCloseTo(viewportWidth / 2, 0);
    return bounds;
  }

  for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 667 }]) {
    await page.setViewportSize(viewport);
    await page.goto("https://xiaocheng.online/");
    const loginHeading = page.getByRole("heading", { name: "欢迎登录" });
    await expect(loginHeading).toBeVisible();

    const registration = await checkRegistration(viewport.width);
    const privacy = footer.getByRole("link", { name: "隐私说明" });
    const feedback = footer.getByRole("link", { name: "帮助与反馈" });
    const privacyBounds = (await privacy.boundingBox())!;
    const feedbackBounds = (await feedback.boundingBox())!;
    expect(privacyBounds.y).toBeCloseTo(feedbackBounds.y, 0);
    expect(registration.y).toBeGreaterThanOrEqual(privacyBounds.y + privacyBounds.height);

    await privacy.click();
    const privacySection = page.getByRole("region", { name: "你的资料，始终由你掌握。" });
    await expect(privacySection).toBeFocused();
    const privacyHeading = privacySection.getByRole("heading", { level: 2 });
    await expect(privacyHeading).toBeInViewport({ ratio: 1 });
    const headerBounds = (await page.locator(".product-intro-header").boundingBox())!;
    expect((await privacyHeading.boundingBox())!.y).toBeGreaterThanOrEqual(headerBounds.y + headerBounds.height);
    await checkRegistration(viewport.width);

    await page.goto("https://xiaocheng.online/#/about");
    const introHeading = page.getByRole("heading", { name: /理解你的想法/ });
    await expect(introHeading).toBeFocused();
    await expect(introHeading).toBeInViewport({ ratio: 1 });
    await footer.getByRole("link", { name: "返回登录" }).click();
    await expect(loginHeading).toBeVisible();
  }
});

test("the injected ICP link is hidden in the signed-in workspace", async ({ page, baseURL }) => {
  await page.addInitScript(key => sessionStorage.setItem(key, "icp-e2e-token"), tokenStorageKey);
  await mockHostedSite(page, baseURL, {
    "/auth/me": { user: { id: 1, email: "workspace@example.test", display_name: "测试用户", has_avatar: false } },
    "/system/database-status": { status: "ready", schema_version: 44, required_schema_version: 44 },
    "/conversations": [{ id: 5, title: "备案回归测试", updated_at: "2026-11-21T00:00:00Z" }],
    "/chat/messages": [],
    "/agent/runs/current": { run: null },
  });

  await page.goto("https://xiaocheng.online/#/chat/5");
  await expect(page.locator(".app-shell.chat-focused")).toBeVisible();
  await expect(page.locator(fallbackIcpLink)).toHaveCount(1);
  await expect(page.locator(fallbackIcpLink)).toBeHidden();
  await expect(page.getByRole("link", { name: icpNumber, exact: true })).toHaveCount(0);
});
